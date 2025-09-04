import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
import { 
  Connection, 
  PublicKey, 
  TransactionInstruction,
  ComputeBudgetProgram
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { PumpAmmSdk } from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';

export class PumpSwapTransactionBuilder extends BaseTransactionBuilder {
  programId = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  private connection: Connection;
  private pumpAmmSdk: PumpAmmSdk | null = null;
  private readonly WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
  
  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }
  
  async buildSwapTransaction(params: SwapParams): Promise<SwapTransaction> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const transactionId = `tx_${timestamp}_${random}`;
    const instructions = await this.createPumpSwapInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createPumpSwapInstructions(params: SwapParams): Promise<SwapInstruction[]> {
    try {
      const mint = new PublicKey(params.mint);
      const user = new PublicKey(params.signer);
      
      // Use pool address from trade data
      const pool = new PublicKey(params.trade.pool);
      
      // Initialize PumpAmmSdk if not already done
      if (!this.pumpAmmSdk) {
        this.pumpAmmSdk = new PumpAmmSdk(this.connection);
      }
      
      let instructions: TransactionInstruction[] = [];
      
      // Add compute budget instructions for better performance
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
      );
      
      // Get user's token account
      const userTokenAccount = await getAssociatedTokenAddress(mint, user, false, TOKEN_PROGRAM_ID);
      
      // Check if token account exists and create if needed
      const tokenAccountInfo = await this.connection.getAccountInfo(userTokenAccount);
      if (!tokenAccountInfo) {
        const createTokenAccountInstruction = createAssociatedTokenAccountIdempotentInstruction(
          user,
          userTokenAccount,
          user,
          mint,
          TOKEN_PROGRAM_ID
        );
        instructions.push(createTokenAccountInstruction);
      }
      
      // Create swap state for the transaction
      const swapState = await this.pumpAmmSdk.swapSolanaState(pool, user);
      
      // Create swap instructions based on type
      let swapInstructions: TransactionInstruction[];
      const slippage = this.calculateSlippage(params.slippageBps || 100); // Default 1% slippage
      
      if (params.type === 'buy') {
        // Buying tokens with SOL (using quote input)
        const solAmountBN = new BN(params.inputAmount || 0);
        
        swapInstructions = await this.pumpAmmSdk.buyQuoteInput(
          swapState,
          solAmountBN,
          slippage
        );
      } else {
        // Selling tokens for SOL (using base input)
        const tokenAmountBN = new BN(params.inputAmount || 0);
        
        swapInstructions = await this.pumpAmmSdk.sellBaseInput(
          swapState,
          tokenAmountBN,
          slippage
        );
      }
      
      // Add swap instructions
      instructions.push(...swapInstructions);
      
      // Convert TransactionInstructions to SwapInstructions
      return instructions.map(ix => this.convertToSwapInstruction(ix));
      
    } catch (error) {
      console.error('Error creating PumpSwap instructions:', error);
      throw new Error(`Failed to create PumpSwap transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
      data: Buffer.from(instruction.data).toString('base64')
    };
  }
  
  private calculateSlippage(slippageBps: number): number {
    // Convert basis points to percentage for PumpAmmSdk
    // 100 bps = 1% slippage = 99% minimum output
    return (10000 - slippageBps) / 100;
  }
  
  // Helper method to find pool address (for reference, but we use params.trade.pool)
  public async findPoolAddress(tokenMint: string): Promise<PublicKey> {
    try {
      const mint = new PublicKey(tokenMint);
      
      const filters = [
        { memcmp: { offset: 43, bytes: mint.toBase58() } },
        { memcmp: { offset: 75, bytes: this.WSOL_MINT.toBase58() } }
      ];
      
      const accounts = await this.connection.getProgramAccounts(new PublicKey(this.programId), {
        commitment: "confirmed",
        filters
      });
      
      if (accounts.length === 0) {
        throw new Error("Pool not found");
      }
      
      return accounts[0].pubkey;
    } catch (error) {
      console.error('Error finding pool address:', error);
      throw error;
    }
  }
  
  // Helper method to get pool reserves
  public async getPoolReserves(poolAddress: string, tokenMint: string): Promise<{tokenReserve: string, solReserve: string}> {
    try {
      const pool = new PublicKey(poolAddress);
      const mint = new PublicKey(tokenMint);
      
      // Get token accounts for the pool
      const tokenAccount = await getAssociatedTokenAddress(mint, pool, true);
      const wsolAccount = await getAssociatedTokenAddress(this.WSOL_MINT, pool, true);
      
      // Get balances
      const [tokenBalance, wsolBalance] = await Promise.all([
        this.connection.getTokenAccountBalance(tokenAccount, "confirmed"),
        this.connection.getTokenAccountBalance(wsolAccount, "confirmed")
      ]);
      
      return {
        tokenReserve: tokenBalance.value.amount,
        solReserve: wsolBalance.value.amount
      };
    } catch (error) {
      console.error('Error getting pool reserves:', error);
      throw error;
    }
  }
  
  // Helper method to calculate expected output (simplified constant product formula)
  public calculateExpectedOutput(
    inputAmount: string,
    inputReserve: string,
    outputReserve: string
  ): string {
    try {
      const amountIn = BigInt(inputAmount);
      const reserveIn = BigInt(inputReserve);
      const reserveOut = BigInt(outputReserve);
      
      if (reserveIn === BigInt(0) || reserveOut === BigInt(0) || amountIn === BigInt(0)) {
        return "0";
      }
      
      // Constant product formula: x * y = k
      // amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
      const product = reserveIn * reserveOut;
      const newReserveIn = reserveIn + amountIn;
      const newReserveOut = product / newReserveIn;
      const amountOut = reserveOut - newReserveOut;
      
      return amountOut.toString();
    } catch (error) {
      console.error('Error calculating expected output:', error);
      return "0";
    }
  }
  
  // PumpSwap specific helper methods
  public static isPumpSwapProgram(programId: string): boolean {
    return programId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  }
  
  public getPumpSwapPoolId(tokenMint: string): string {
    // Since we use params.trade.pool, this is mainly for reference
    return `pool_${tokenMint.substring(0, 8)}`;
  }
}