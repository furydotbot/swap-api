// Core Solana transaction interfaces
export interface TransactionHeader {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
}

export interface TransactionInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

export interface TransactionMessage {
  header: TransactionHeader;
  accountKeys: string[];
  recentBlockhash: string;
  instructions: TransactionInstruction[];
}

export interface Transaction {
  signatures: string[];
  message: TransactionMessage;
}

export interface TransactionMeta {
  err: any;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  innerInstructions: any[];
  logMessages: string[];
  preTokenBalances: any[];
  postTokenBalances: any[];
  rewards: any[];
}

export interface RawTransactionData {
  signature: string;
  slot: number;
  transaction: Transaction;
  meta: TransactionMeta;
  blockTime: number;
  timestamp: string;
  connectionId?: string;
}

// Streamer configuration and stats
export interface StreamerConfig {
  grpcEndpoint?: string;
  grpcToken?: string;
  accountToWatch: string | string[];
}

export interface StreamerStats {
  transactionsReceived: number;
  errors: number;
  startTime: number;
}

export type RawTransactionListener = (transaction: RawTransactionData) => void;

// Trade interface for parsed DEX data
export interface Trade {
  mint: string;
  pool: string;
  avgPrice: number;
  programId: string;
  slot: string;
}

// gRPC protocol types
export interface AccountWatch {
  vote: boolean;
  failed: boolean;
  accountExclude: string[];
  accountRequired: string[];
  accountInclude: string[];
}

export interface SubscriptionRequest {
  accounts: Record<string, any>;
  slots: Record<string, any>;
  transactions: {
    accountWatch: AccountWatch;
  };
  transactionsStatus: Record<string, any>;
  entry: Record<string, any>;
  blocks: Record<string, any>;
  blocksMeta: Record<string, any>;
  commitment: string;
  accountsDataSlice: any[];
}

export interface PingRequest {
  ping: { id: number };
  accounts: Record<string, any>;
  accountsDataSlice: any[];
  transactions: Record<string, any>;
  transactionsStatus: Record<string, any>;
  blocks: Record<string, any>;
  blocksMeta: Record<string, any>;
  entry: Record<string, any>;
  slots: Record<string, any>;
}

export interface GrpcMessage {
  pong?: any;
  transaction?: {
    slot: number;
    transaction: {
      signature: Uint8Array;
      transaction: Transaction;
      meta: TransactionMeta;
      blockTime: number;
    };
  };
}