import { FormattedUtxo } from '@oyl/sdk';

export class DeployDto {
    name: string;
    symbol: string;
    supply: number;
    utxos: FormattedUtxo[];
    fee_rate: number;
}

export class ExecuteDto {
    contractId: string; // Format "txid:vout"

    methodName: string;

    args: any[]; // Array of arguments for the contract method

    mnemonic: string; // Mnemonic for the account executing the call

    feeAddress?: string; // Optional address for frontend fees

    frontendFee?: number; // Optional frontend fee amount
}

export class PreDeployDto {
    name: string;
    symbol: string;
    supply: number;
    utxos: FormattedUtxo[];
    fee_rate: number;
}
