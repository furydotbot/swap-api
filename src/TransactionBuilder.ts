export interface SwapInstruction {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
}

export interface SwapTransaction {
  transactionId: string;
  status: 'pending' | 'confirmed' | 'failed';
  instructions: SwapInstruction[];
}

export interface SwapParams {
  mint: string;
  signer: string;
  type: 'buy' | 'sell';
  inputAmount?: number;
  outputAmount?: number;
  slippageBps: number;
  trade: {
    mint: string;
    pool: string;
    avgPrice: number;
    programId: string;
    slot: string;
  };
}

// Base Transaction Builder Interface
export interface ITransactionBuilder {
  programId: string;
  buildSwapTransaction(params: SwapParams): SwapTransaction | Promise<SwapTransaction>;
}

// Abstract base class for transaction builders
export abstract class BaseTransactionBuilder implements ITransactionBuilder {
  abstract programId: string;
  
  abstract buildSwapTransaction(params: SwapParams): SwapTransaction | Promise<SwapTransaction>;
}