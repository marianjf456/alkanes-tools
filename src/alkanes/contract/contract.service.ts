import {
  Injectable,
  InternalServerErrorException,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PreDeployDto, DeployDto, ExecuteDto } from './contract.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as bitcoin from '@btc-vision/bitcoin';
import ecc from '@bitcoinerlab/secp256k1';
import { encodeRunestoneProtostone, ProtoStone, encipher } from 'alkanes'

bitcoin.initEccLib(ecc);

import {
  generateMnemonic,
  mnemonicToAccount,
  Provider,
  alkanes,
  AlkanesPayload,
  Signer,
  tweakSigner,
  getWalletPrivateKeys,
  calculateTaprootTxSize,
  utxo as utxoUtils,
} from '@oyl/sdk';

@Injectable()
export class ContractService {
  private readonly logger = new Logger(ContractService.name);

  // --- Helper: Estimate Reveal Fee (Simplified, adapted from old index.ts) ---
  private getProvider(network: string): Provider {
    const mainnet = new Provider({
      url: 'https://mainnet.sandshrew.io',
      version: 'v2',
      projectId: process.env.SANDSHREW_PROJECT_ID!,
      network: bitcoin.networks.bitcoin,
      networkType: 'mainnet',
    });
    const signet = new Provider({
      url: 'https://signet.sandshrew.io',
      projectId: 'lasereyes',
      version: 'v2',
      network: bitcoin.networks.testnet,
      networkType: 'testnet',
    });
    return network === 'mainnet' ? mainnet : signet;
  }

  private getSigner(mnemonic: string, network: bitcoin.Network): Signer {
    const privateKeys = getWalletPrivateKeys({
      mnemonic,
      opts: {
        network,
      },
    })

    return new Signer(network, {
      taprootPrivateKey: privateKeys.taproot.privateKey,
      segwitPrivateKey: privateKeys.nativeSegwit.privateKey,
      nestedSegwitPrivateKey: privateKeys.nestedSegwit.privateKey,
      legacyPrivateKey: privateKeys.legacy.privateKey,
    });
  }

  async preDeployContract(preDeployDto: PreDeployDto): Promise<any> {
    this.logger.log(
      `Starting preDeployContract for ${preDeployDto.name}`,
    );

    try {
      const wasmBaseDir = path.join(process.cwd(), 'wasm');
      const wasmFileName = 'alkanes_bonding_curve_token.wasm';
      const wasmFilePath = path.join(wasmBaseDir, wasmFileName);

      this.logger.log(`Reading Wasm file from: ${wasmFilePath}`);
      let contractWasm: Buffer;
      try {
        contractWasm = await fs.readFile(wasmFilePath);
      } catch (err) {
        this.logger.error(
          `Failed to read Wasm file at ${wasmFilePath}`,
          err,
        );
        throw new InternalServerErrorException(
          `Wasm file not found or unreadable: ${wasmFileName}`,
        );
      }

      const payload: AlkanesPayload = {
        body: contractWasm,
        cursed: false,
        tags: {
          contentType: '',
        },
      };

      const provider = this.getProvider('signet');
      const network = provider.network;
      const mnemonic = generateMnemonic();
      const account = mnemonicToAccount({ mnemonic, opts: { network } });
      const signer = this.getSigner(mnemonic, network);

      // Detailed logging to diagnose the issue
      this.logger.debug(`Signer created: ${!!signer}`);
      this.logger.debug(`Taproot key pair exists: ${!!signer.taprootKeyPair}`);
      if (signer.taprootKeyPair) {
        this.logger.debug(`Taproot public key: ${signer.taprootKeyPair.publicKey?.toString('hex') || 'undefined'}`);
        this.logger.debug(`Taproot private key exists: ${!!signer.taprootKeyPair.privateKey}`);
      }

      if (!signer.taprootKeyPair) {
        throw new InternalServerErrorException('Taproot key pair is undefined. Check wallet initialization.');
      }

      const tweakedTaprootKeyPair: bitcoin.Signer = tweakSigner(
        signer.taprootKeyPair,
        {
          network: provider.network,
        }
      );

      if (!tweakedTaprootKeyPair || !tweakedTaprootKeyPair.publicKey) {
        throw new InternalServerErrorException('Failed to create tweaked taproot key pair');
      }

      const tweakedPublicKey = tweakedTaprootKeyPair.publicKey.toString('hex');
      const gatheredUtxos = {
        utxos: preDeployDto.utxos,
        totalAmount: preDeployDto.utxos.reduce((acc, utxo) => acc + utxo.satoshis, 0),
      };
      const feeRate = preDeployDto.fee_rate;
      const nameBytes = Buffer.from(preDeployDto.name, 'utf8');
      const symbolBytes = Buffer.from(preDeployDto.symbol, 'utf8');
      const protostone = encodeRunestoneProtostone({
        protostones: [
          ProtoStone.message({
            protocolTag: 1n,
            edicts: [],
            pointer: 0,
            refundPointer: 0,
            calldata: encipher([
              0n,  // opcode  
              ...Array.from(nameBytes).map(b => BigInt(Number(b))),
              ...Array.from(symbolBytes).map(b => BigInt(Number(b))),
              typeof preDeployDto.supply === 'number' ? BigInt(preDeployDto.supply) : preDeployDto.supply,  // total_supply  
            ]),
          }),
        ],
      }).encodedRunestone;

      const { fee: commitFee } = await alkanes.contract.actualDeployCommitFee({
        payload,
        gatheredUtxos,
        tweakedPublicKey,
        account,
        provider,
        feeRate,
      })

      const { psbt: finalCommitPsbt, script } = await alkanes.createDeployCommitPsbt({
        payload,
        gatheredUtxos,
        tweakedPublicKey,
        account,
        provider,
        feeRate,
        fee: commitFee,
      })
      const { psbt: finalRevealPsbt } = await this.createDeployRevealPsbt({
        protostone,
        receiverAddress: account.taproot.address,
        script,
        feeRate,
        tweakedPublicKey,
        provider,
        fee: 0,
        commitTx: {
          txId: preDeployDto.utxos[0].txId,
          vOut: 0,
          value: preDeployDto.utxos[0].satoshis,
          script: preDeployDto.utxos[0].scriptPk,
        },
      })
      const { fee: revealFee } = await this.getEstimatedFee({
        feeRate,
        psbt: finalRevealPsbt,
        provider,
      })


      this.logger.log(
        `Pre-deployment successful for ${preDeployDto.name}`,
      );
      return {
        mnemonic: mnemonic,
        // signer: signer,
        account: account,
        estimatedCommitFee: commitFee,
        estimatedRevealFee: revealFee,
        totalEstimatedFee: commitFee + revealFee,
        recipientAddress: '',
      };
    } catch (error) {
      this.logger.error(
        `Error in preDeployContract : ${error}`
      );
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Failed to pre-deploy contract: ${error}`,
      );
    }
  }

  async deployContract(deployDto: DeployDto): Promise<any> {
    this.logger.log(`Starting deployContract for ${deployDto.name}`);
    try {
      const wasmBaseDir = path.join(process.cwd(), 'wasm');
      const wasmFileName = 'alkanes_bonding_curve_token.wasm';
      const wasmFilePath = path.join(wasmBaseDir, wasmFileName);

      this.logger.log(`Reading Wasm file from: ${wasmFilePath}`);
      let contractWasm: Buffer;
      try {
        contractWasm = await fs.readFile(wasmFilePath);
      } catch (err) {
        this.logger.error(
          `Failed to read Wasm file at ${wasmFilePath}`,
          err,
        );
        throw new InternalServerErrorException(
          `Wasm file not found or unreadable: ${wasmFileName}`,
        );
      }

      const payload: AlkanesPayload = {
        body: contractWasm,
        cursed: false,
        tags: {
          contentType: '',
        },
      };

      const provider = this.getProvider('signet');
      const network = provider.network;
      const mnemonic = deployDto.mnemonic;
      const account = mnemonicToAccount({ mnemonic, opts: { network } });
      const signer = this.getSigner(mnemonic, network);
      const tweakedTaprootKeyPair: bitcoin.Signer = tweakSigner(
        signer.taprootKeyPair,
        {
          network: provider.network,
        }
      )

      const tweakedPublicKey = tweakedTaprootKeyPair.publicKey.toString('hex');
      const { spendableUtxos, spendableTotalBalance } = await utxoUtils.addressUtxos({ address: account.nativeSegwit.address, provider });
      const feeRate = deployDto.fee_rate;
      const nameBytes = Buffer.from(deployDto.name, 'utf8');
      const symbolBytes = Buffer.from(deployDto.symbol, 'utf8');
      const protostone = encodeRunestoneProtostone({
        protostones: [
          ProtoStone.message({
            protocolTag: 1n,
            edicts: [],
            pointer: 0,
            refundPointer: 0,
            calldata: encipher([
              0n,  // opcode  
              ...Array.from(nameBytes).map(b => BigInt(Number(b))),
              ...Array.from(symbolBytes).map(b => BigInt(Number(b))),
              typeof deployDto.supply === 'number' ? BigInt(deployDto.supply) : deployDto.supply,  // total_supply  
            ]),
          }),
        ],
      }).encodedRunestone;

      const gatheredUtxos = {
        utxos: spendableUtxos,
        totalAmount: spendableTotalBalance
      };
      const { fee: commitFee } = await alkanes.contract.actualDeployCommitFee({
        payload,
        gatheredUtxos,
        tweakedPublicKey,
        account,
        provider,
        feeRate,
      })

      const { psbt: finalCommitPsbtBase64, script } = await alkanes.createDeployCommitPsbt({
        payload,
        gatheredUtxos,
        tweakedPublicKey,
        account,
        provider,
        feeRate,
        fee: commitFee,
      })

      const { signedPsbt: signedCommitPsbtBase64 } = await signer.signAllInputs({
        rawPsbt: finalCommitPsbtBase64,
        finalize: true,
      })
      const finalCommitPsbt = bitcoin.Psbt.fromBase64(signedCommitPsbtBase64, { network: provider.network });
      const commitTx = finalCommitPsbt.extractTransaction();
      const { psbt: revealPsbtBase64 } = await this.createDeployRevealPsbt({
        protostone,
        receiverAddress: account.taproot.address,
        script,
        feeRate,
        tweakedPublicKey,
        provider,
        commitTx: {
          txId: commitTx.getId(),
          vOut: 0,
          value: commitTx.outs[0].value,
          script: commitTx.outs[0].script.toString('hex'),
        },
        fee: 0,
      })
      const { fee: estimatedFee } = await this.getEstimatedFee({
        feeRate,
        psbt: revealPsbtBase64,
        provider,
      })
      const { psbt: finalRevealPsbtBase64 } = await this.createDeployRevealPsbt({
        protostone,
        receiverAddress: account.taproot.address,
        script,
        feeRate,
        tweakedPublicKey,
        provider,
        commitTx: {
          txId: commitTx.getId(),
          vOut: 0,
          value: commitTx.outs[0].value,
          script: commitTx.outs[0].script.toString('hex'),
        },
        fee: estimatedFee,
      })
      let finalRevealPsbt = bitcoin.Psbt.fromBase64(finalRevealPsbtBase64, {
        network: provider.network,
      })

      finalRevealPsbt.signInput(0, tweakedTaprootKeyPair)
      finalRevealPsbt.finalizeInput(0)

      const revealTx = finalRevealPsbt.extractTransaction();

      this.logger.log(
        `Deployment successful for ${deployDto.name}.`,
      );
      return {
        success: true,
        // commitPsbtHex: finalCommitPsbt.toHex(),
        // revealPsbtHex: finalRevealPsbt.toHex(),
        commitTxHex: commitTx.toHex(),
        revealTxHex: revealTx.toHex(),
        contractId: '',
        alkaneId: '', // Standard Alkane ID format
      };
    } catch (error) {
      this.logger.error(
        `Error in deployContract: ${error}`,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      // Check for specific SDK error types if available and rethrow as HttpException
      let errorMessage = `Failed to deploy contract: ${error}`;
      throw new InternalServerErrorException(errorMessage);
    }
  }

  async executeContractMethod(executeDto: ExecuteDto): Promise<any> {
    this.logger.log(
      `Starting executeContractMethod for contract ${executeDto.contractId}, method ${executeDto.methodName}`,
    );
    try {
      this.logger.log(
        `Execution successful for contract ${executeDto.contractId}, method ${executeDto.methodName}.`,
      );
      return {
        success: true,
        executionTxId: '',
      };
    } catch (error) {
      this.logger.error(
        `Error in executeContractMethod for ${executeDto.contractId}: ${error}`,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      let errorMessage = `Failed to execute contract method: ${error}`;
      throw new InternalServerErrorException(errorMessage);
    }
  }

  async createDeployRevealPsbt({
    protostone,
    receiverAddress,
    script,
    feeRate,
    tweakedPublicKey,
    provider,
    fee = 0,
    commitTx,
  }: {
    protostone: Buffer
    receiverAddress: string
    script: Buffer
    feeRate: number
    tweakedPublicKey: string
    provider: Provider
    fee?: number
    commitTx: {
      txId: string
      vOut: number
      value: number
      script: string
    }
  }) {
    try {
      if (!feeRate) {
        feeRate = (await provider.esplora.getFeeEstimates())['1']
      }

      const psbt: bitcoin.Psbt = new bitcoin.Psbt({ network: provider.network })
      const taprootInputCount = 1;
      const nonTaprootInputCount = 0;
      const outputCount = 2;
      const minFee = calculateTaprootTxSize(
        taprootInputCount,
        nonTaprootInputCount,
        outputCount,
      )

      const revealTxBaseFee = minFee * feeRate < 250 ? 250 : minFee * feeRate
      const revealTxChange = fee === 0 ? 0 : Number(revealTxBaseFee) - fee

      if (!commitTx.value) {
        throw new InternalServerErrorException(new Error('Error getting vin #0 value'))
      }

      const p2pk_redeem = { output: script }

      const { output, witness } = bitcoin.payments.p2tr({
        internalPubkey: bitcoin.toXOnly(Buffer.from(tweakedPublicKey, 'hex')),
        scriptTree: p2pk_redeem,
        redeem: p2pk_redeem,
        network: provider.network,
      })

      psbt.addInput({
        hash: commitTx.txId,
        index: 0,
        witnessUtxo: {
          value: commitTx.value,
          script: output,
        },
        tapLeafScript: [
          {
            leafVersion: bitcoin.LEAF_VERSION_TAPSCRIPT,
            script: p2pk_redeem.output,
            controlBlock: witness![witness!.length - 1],
          },
        ],
      })

      psbt.addOutput({
        value: 546,
        address: receiverAddress,
      })

      psbt.addOutput({
        value: 0,
        script: protostone,
      })

      if (revealTxChange > 546) {
        psbt.addOutput({
          value: revealTxChange,
          address: receiverAddress,
        })
      }

      return {
        psbt: psbt.toBase64(),
        fee: revealTxChange,
      }
    } catch (error) {
      throw new InternalServerErrorException(error)
    }
  }

  async getEstimatedFee({
    feeRate,
    psbt,
    provider,
  }: {
    feeRate: number
    psbt: string
    provider: Provider
  }) {
    const getTaprootWitnessSize = (input: any) => {
      // Base taproot witness size (signature)
      let witnessSize = 16.25; // 65 bytes / 4 (witness discount)

      // If there's a reveal script
      if (input.tapLeafScript && input.tapLeafScript.length > 0) {
        const leafScript = input.tapLeafScript[0];
        // Add control block size (33 bytes + path length) / 4
        witnessSize += (33 + (leafScript.controlBlock.length - 33)) / 4;
        // Add script size / 4
        witnessSize += leafScript.script.length / 4;
        // Add any witness stack items / 4
        if (input.witnessStack) {
          witnessSize += input.witnessStack.reduce((sum, item) => sum + item.length, 0) / 4;
        }
      }

      return witnessSize;
    };
    const SIZES = {
      p2tr: {
        input: {
          unsigned: 41,
          witness: 16.25,  // Fallback
          getWitnessSize: getTaprootWitnessSize
        },
        output: 43,
      },
      p2wpkh: {
        input: {
          unsigned: 41,
          witness: 26.5,
          getWitnessSize: (input) => 26.5  // Fixed witness size
        },
        output: 31,
      },
      p2sh: {
        input: {
          unsigned: 63,
          witness: 27.75,
          getWitnessSize: (input) => 27.75  // Fixed witness size
        },
        output: 32,
      },
      p2pkh: {
        input: {
          unsigned: 148,
          witness: 0,
          getWitnessSize: (input) => 0  // No witness data
        },
        output: 34,
      },
      // OP_RETURN
      nulldata: {
        output: 9, // Base size
      }
    };
    const detectInputType = (input: any) => {
      if (input.tapInternalKey || input.tapKeySig || input.tapLeafScript) {
        return "p2tr";
      }

      if (input.witnessUtxo?.script) {
        const scriptLen = input.witnessUtxo.script.length;
        if (scriptLen === 34) return "p2tr";
        if (scriptLen === 22) return "p2wpkh";
        if (scriptLen === 23) return "p2sh";
        if (scriptLen === 25) return "p2pkh";
      }

      if (input.redeemScript) return "p2sh";
      if (input.witnessScript) return "p2wpkh";

      return "p2tr";
    };

    const psbtObj = bitcoin.Psbt.fromBase64(psbt, { network: provider.network });

    // Base overhead
    const BASE_OVERHEAD = 8; // Version (4) + Locktime (4)
    const SEGWIT_OVERHEAD = 1;

    // VarInt sizes depend on number of inputs/outputs
    const getVarIntSize = (n) => {
      if (n < 0xfd) return 1;
      if (n < 0xffff) return 3;
      if (n < 0xffffffff) return 5;
      return 9;
    };

    // Calculate input sizes
    const inputSizes = psbtObj.data.inputs.map((input) => {
      const type = detectInputType(input);
      const size = SIZES[type].input.unsigned + SIZES[type].input.getWitnessSize(input);
      return size;
    });

    // Calculate output sizes
    const outputSizes = psbtObj.txOutputs.map((output) => {
      // Check if OP_RETURN output
      if (output.script[0] === 0x6a) {
        return output.script.length + SIZES.nulldata.output;
      }

      const scriptType =
        output.script.length === 34
          ? "p2tr"
          : output.script.length === 22
            ? "p2wpkh"
            : output.script.length === 23
              ? "p2sh"
              : "p2pkh";

      return SIZES[scriptType].output;
    });

    const totalInputSize = inputSizes.reduce((sum, size) => sum + size, 0);
    const totalOutputSize = outputSizes.reduce((sum, size) => sum + size, 0);

    const inputVarIntSize = getVarIntSize(inputSizes.length);
    const outputVarIntSize = getVarIntSize(outputSizes.length);

    const vsize = Math.round(
      BASE_OVERHEAD +
      SEGWIT_OVERHEAD +
      inputVarIntSize +
      outputVarIntSize +
      totalInputSize +
      totalOutputSize
    );

    const fee = Math.ceil(vsize * feeRate);

    return {
      fee,
      vsize,
    };
  };
}
