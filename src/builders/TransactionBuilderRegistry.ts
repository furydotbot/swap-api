import { SolanaTrade } from './solana-trade/src';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { ITransactionBuilder, SwapParams, SwapTransaction } from '../TransactionBuilder';
import { PROGRAM_IDS } from './solana-trade/src/helpers/program-ids';
import { markets } from './solana-trade/src/helpers/constants';

export class TransactionBuilderRegistry {
  private static instance: TransactionBuilderRegistry;
  private trader: SolanaTrade;
  private connection: Connection;
  
  // Supported markets mapping - built using solana-trade utility
  private supportedMarkets = {
    [PROGRAM_IDS.PUMP_FUN_PROGRAM_ID]: markets.PUMP_FUN,
    [PROGRAM_IDS.PUMP_SWAP_PROGRAM_ID]: markets.PUMP_SWAP,
    [PROGRAM_IDS.RAYDIUM_PROGRAM_ID]: markets.RAYDIUM_AMM,
    [PROGRAM_IDS.RAYDIUM_CLMM_PROGRAM_ID]: markets.RAYDIUM_CLMM,
    [PROGRAM_IDS.RAYDIUM_CPMM_PROGRAM_ID]: markets.RAYDIUM_CPMM,
    [PROGRAM_IDS.RAYDIUM_LAUNCHPAD_PROGRAM_ID]: markets.RAYDIUM_LAUNCHPAD,
    [PROGRAM_IDS.METEORA_DLMM_PROGRAM_ID]: markets.METEORA_DLMM,
    [PROGRAM_IDS.METEORA_DAMM_V2_PROGRAM_ID]: markets.METEORA_DAMM_V2,
    [PROGRAM_IDS.METEORA_DBC_PROGRAM_ID]: markets.METEORA_DBC,
    [PROGRAM_IDS.ORCA_WHIRLPOOL_PROGRAM_ID]: markets.ORCA_WHIRLPOOL,
    [PROGRAM_IDS.HEAVEN_PROGRAM_ID]: markets.HEAVEN,
    [PROGRAM_IDS.BOOP_FUN_PROGRAM_ID]: markets.BOOP_FUN,
  };
  
  private constructor(connection: Connection, rpcUrl?: string) {
    this.connection = connection;
    // Initialize SolanaTrade with custom RPC if provided
    this.trader = new SolanaTrade(rpcUrl || connection.rpcEndpoint);
  }
  
  public static getInstance(connection?: Connection, rpcUrl?: string): TransactionBuilderRegistry {
    if (!TransactionBuilderRegistry.instance) {
      if (!connection) {
        throw new Error('Connection is required for first initialization');
      }
      TransactionBuilderRegistry.instance = new TransactionBuilderRegistry(connection, rpcUrl);
    }
    return TransactionBuilderRegistry.instance;
  }
  
  public async createBuyTransaction(params: {
    programId: string;
    wallet: Keypair;
    mint: string;
    amount: number;
    slippage: number;
  }) {
    const market = this.getMarketForProgramId(params.programId);
    if (!market) {
      throw new Error(`Unsupported program ID: ${params.programId}`);
    }
    
    // Get transaction object without sending (returns Transaction object)
    const transaction = await this.trader.buy({
      market: market as any,
      wallet: params.wallet,
      mint: params.mint,
      amount: params.amount,
      slippage: params.slippage,
      send: false // Returns Transaction object instead of sending
    });
    
    return transaction;
  }
  
  public async createSellTransaction(params: {
    programId: string;
    wallet: Keypair;
    mint: string;
    amount: number;
    slippage: number;
  }) {
    const market = this.getMarketForProgramId(params.programId);
    if (!market) {
      throw new Error(`Unsupported program ID: ${params.programId}`);
    }
    
    // Get transaction object without sending (returns Transaction object)
    const transaction = await this.trader.sell({
      market: market as any,
      wallet: params.wallet,
      mint: params.mint,
      amount: params.amount,
      slippage: params.slippage,
      send: false // Returns Transaction object instead of sending
    });
    
    return transaction;
  }
  
  // Legacy compatibility method for existing API
  public getBuilder(programId: string): ITransactionBuilder | null {
    if (!this.hasBuilder(programId)) {
      return null;
    }
    
    // Return a wrapper that implements the ITransactionBuilder interface
    return {
      programId,
      buildSwapTransaction: async (params: SwapParams): Promise<SwapTransaction> => {
        const market = this.getMarketForProgramId(programId);
        if (!market) {
          throw new Error(`Unsupported program ID: ${programId}`);
        }
        
        // Create a mock keypair object with the signer's public key for transaction building
        // Note: This creates a keypair-like structure but we only use the public key for building
        const signerPublicKey = new PublicKey(params.signer);
        const mockKeypair = {
          publicKey: signerPublicKey,
          secretKey: new Uint8Array(64) // Empty secret key since we're not signing here
        } as Keypair;
        
        try {
          const transaction = await this.trader[params.type === 'buy' ? 'buy' : 'sell']({
            market: market as any,
            wallet: mockKeypair,
            mint: params.mint,
            amount: params.inputAmount || params.outputAmount || 0,
            slippage: params.slippageBps / 100,
            poolAddress: params.trade.pool, // Add pool address from trade data
            send: false
          });
          
          // Check if result is a Transaction object (when send: false) or string (when send: true)
          if (typeof transaction === 'string') {
            throw new Error('Unexpected string result from solana-trade. Expected Transaction object.');
          }
                    
          // Return the transaction directly - let the API layer handle the conversion
          return {
            transactionId: `temp_${Date.now()}`,
            status: 'pending' as const,
            transaction: transaction // Return the raw transaction object
          };
        } catch (error) {
          console.error('Error in buildSwapTransaction:', error);
          console.error('Error type:', typeof error);
          console.error('Error constructor:', (error as any)?.constructor?.name);
          console.error('Error message:', (error as any)?.message);
          console.error('Error stack:', (error as any)?.stack);
          throw new Error(`Failed to build transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    };
  }
  
  public getMarketForProgramId(programId: string): string | null {
    return this.supportedMarkets[programId as keyof typeof this.supportedMarkets] || null;
  }
  
  public hasBuilder(programId: string): boolean {
    return programId in this.supportedMarkets;
  }
  
  public getSupportedProgramIds(): string[] {
    return Object.keys(this.supportedMarkets);
  }
  
  public getBuilderInfo(): Array<{ programId: string; name: string; market: string }> {
    const info: Array<{ programId: string; name: string; market: string }> = [];
    
    for (const [programId, market] of Object.entries(this.supportedMarkets)) {
      let name = 'Unknown';
      
      // Determine builder name based on programId using constants
      switch (programId) {
        case PROGRAM_IDS.PUMP_FUN_PROGRAM_ID:
          name = 'PUMP_FUN';
          break;
        case PROGRAM_IDS.PUMP_SWAP_PROGRAM_ID:
          name = 'PUMP_SWAP';
          break;
        case PROGRAM_IDS.RAYDIUM_PROGRAM_ID:
          name = 'RAYDIUM_AMM';
          break;
        case PROGRAM_IDS.RAYDIUM_CLMM_PROGRAM_ID:
          name = 'RAYDIUM_CLMM';
          break;
        case PROGRAM_IDS.RAYDIUM_CPMM_PROGRAM_ID:
          name = 'RAYDIUM_CPMM';
          break;
        case PROGRAM_IDS.RAYDIUM_LAUNCHPAD_PROGRAM_ID:
          name = 'RAYDIUM_LAUNCHPAD';
          break;
        case PROGRAM_IDS.METEORA_DLMM_PROGRAM_ID:
          name = 'METEORA_DLMM';
          break;
        case PROGRAM_IDS.METEORA_DAMM_V2_PROGRAM_ID:
          name = 'METEORA_DAMM_V2';
          break;
        case PROGRAM_IDS.METEORA_DBC_PROGRAM_ID:
          name = 'METEORA_DBC';
          break;
        case PROGRAM_IDS.ORCA_WHIRLPOOL_PROGRAM_ID:
          name = 'ORCA_WHIRLPOOL';
          break;
        case PROGRAM_IDS.HEAVEN_PROGRAM_ID:
          name = 'HEAVEN';
          break;
        case PROGRAM_IDS.BOOP_FUN_PROGRAM_ID:
          name = 'BOOP_FUN';
          break;
        default:
          name = `Builder_${programId.substring(0, 8)}`;
      }
      
      info.push({ programId, name, market });
    }
    
    return info;
  }
}

export function getTransactionBuilderRegistry(connection?: Connection, rpcUrl?: string): TransactionBuilderRegistry {
  return TransactionBuilderRegistry.getInstance(connection, rpcUrl);
}