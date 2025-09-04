import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { CpAmm, SwapParams as DAMMSwapParams, GetQuoteParams, PoolState, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';

export class DAMMV2TransactionBuilder extends BaseTransactionBuilder {
  static readonly PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
  programId: string = DAMMV2TransactionBuilder.PROGRAM_ID.toString();
  private cpAmm: CpAmm;
  private connection: Connection;
  
  constructor(connection: Connection) {
    super();
    this.connection = connection;
    this.cpAmm = new CpAmm(connection);
  }
  
  async buildSwapTransaction(params: SwapParams): Promise<SwapTransaction> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const transactionId = `tx_${timestamp}_${random}`;
    const instructions = await this.createDAMMV2Instructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createDAMMV2Instructions(params: SwapParams): Promise<SwapInstruction[]> {
    try {
      const mint = new PublicKey(params.mint);
      const user = new PublicKey(params.signer);
      const poolAddress = new PublicKey(params.trade.pool);
      
      // Get pool information
      const poolState = await this.cpAmm.fetchPoolState(poolAddress);
      if (!poolState) {
        throw new Error(`Pool not found for address: ${params.trade.pool}`);
      }
      
      // Determine token A and token B
      const tokenAMint = poolState.tokenAMint;
      const tokenBMint = poolState.tokenBMint;
      
      // Check which token we're swapping
      const isTokenA = mint.equals(tokenAMint);
      const inputMint = isTokenA ? tokenAMint : tokenBMint;
      const outputMint = isTokenA ? tokenBMint : tokenAMint;
      
      let inputAmount: BN;
      let minimumOutputAmount: BN;
      
      if (params.inputAmount) {
        // For exact input swaps
        inputAmount = new BN(params.inputAmount);
        // Calculate minimum output with slippage
        const quoteParams: GetQuoteParams = {
          inAmount: inputAmount,
          inputTokenMint: inputMint,
          slippage: (params.slippageBps || 100) / 10000, // Convert BPS to decimal
          poolState,
          currentTime: Math.floor(Date.now() / 1000),
          currentSlot: await this.connection.getSlot(),
          tokenADecimal: 9,
          tokenBDecimal: 9
        };
        const quote = this.cpAmm.getQuote(quoteParams);
        minimumOutputAmount = quote.minSwapOutAmount;
      } else if (params.outputAmount) {
        throw new Error('Exact output swaps not yet implemented for DAMM V2');
      } else {
        throw new Error('Either inputAmount or outputAmount must be specified');
      }
      
      // Create swap instruction using the SDK
      const swapParams: DAMMSwapParams = {
        payer: user,
        pool: poolAddress,
        inputTokenMint: inputMint,
        outputTokenMint: outputMint,
        amountIn: inputAmount,
        minimumAmountOut: minimumOutputAmount,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAProgram: getTokenProgram(poolState.tokenAFlag),
        tokenBProgram: getTokenProgram(poolState.tokenBFlag),
        referralTokenAccount: null
      };
      
      const swapTx = await this.cpAmm.swap(swapParams);
      
      const instructions: SwapInstruction[] = [];
      
      // Convert transaction instructions to SwapInstructions
      for (const ix of swapTx.instructions) {
        instructions.push(this.convertToSwapInstruction(ix));
      }
      
      return instructions;
    } catch (error) {
      console.error('Error creating DAMM V2 instructions:', error);
      throw error;
    }
  }
  
  private convertToSwapInstruction(instruction: TransactionInstruction): SwapInstruction {
    return {
      programId: instruction.programId.toString(),
      accounts: instruction.keys.map(key => ({
        pubkey: key.pubkey.toString(),
        isSigner: key.isSigner,
        isWritable: key.isWritable
      })),
      data: instruction.data.toString('base64')
    };
  }
  
  // Helper methods for pool information and quotes
  public async getPoolInfo(poolAddress: string) {
    try {
      const poolPubkey = new PublicKey(poolAddress);
      return await this.cpAmm.fetchPoolState(poolPubkey);
    } catch (error) {
      console.error('Error fetching pool info:', error);
      return null;
    }
  }
  
  public async calculateSwapQuote(
    poolAddress: string,
    inputMint: string,
    inputAmount: string,
    slippageBps: number = 100
  ) {
    try {
      const poolPubkey = new PublicKey(poolAddress);
      const inputMintPubkey = new PublicKey(inputMint);
      const poolState = await this.cpAmm.fetchPoolState(poolPubkey);
      
      const quoteParams: GetQuoteParams = {
        inAmount: new BN(inputAmount),
        inputTokenMint: inputMintPubkey,
        slippage: slippageBps / 10000, // Convert BPS to decimal
        poolState,
        currentTime: Math.floor(Date.now() / 1000),
        currentSlot: await this.connection.getSlot(),
        tokenADecimal: 9,
        tokenBDecimal: 9
      };
      
      return this.cpAmm.getQuote(quoteParams);
    } catch (error) {
      console.error('Error calculating swap quote:', error);
      return null;
    }
  }
  
  public async getAllPools() {
    try {
      return await this.cpAmm.getAllPools();
    } catch (error) {
      console.error('Error fetching all pools:', error);
      return [];
    }
  }
  
  // Static method to check if a program ID is DAMM V2
  public static isDAMMV2Program(programId: string): boolean {
    return programId === DAMMV2TransactionBuilder.PROGRAM_ID.toString();
  }
  
  public async getPoolAddress(tokenAMint: string, tokenBMint: string): Promise<PublicKey | null> {
    try {
      const pools = await this.getAllPools();
      const tokenA = new PublicKey(tokenAMint);
      const tokenB = new PublicKey(tokenBMint);
      
      for (const pool of pools) {
        if (
          (pool.account.tokenAMint.equals(tokenA) && pool.account.tokenBMint.equals(tokenB)) ||
          (pool.account.tokenAMint.equals(tokenB) && pool.account.tokenBMint.equals(tokenA))
        ) {
          return pool.publicKey;
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error finding pool address:', error);
      return null;
    }
  }
}