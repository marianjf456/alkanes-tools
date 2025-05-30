export class DeployDto {
    signedCommitPsbtBase64: string;

    mnemonic: string;

    contractName: string; // To identify Wasm file & potentially for metadata

    symbol: string; // For protostone metadata

    totalSupply: number; // For protostone metadata

    decimals?: number; // Optional, for protostone metadata
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
    contractName: string;

    symbol: string;

    totalSupply: number;
}
