import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../TransactionBuilder';
import { 
  Connection, 
  PublicKey, 
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT
} from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  deriveDbcTokenVaultAddress
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';

export class DBCTransactionBuilder extends BaseTransactionBuilder {
  programId = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
  private connection: Connection;
  private client: any = null;
  
  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }
  
  async buildSwapTransaction(params: SwapParams): Promise<SwapTransaction> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const transactionId = `tx_${timestamp}_${random}`;
    const instructions = await this.createDBCInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createDBCInstructions(params: SwapParams): Promise<SwapInstruction[]> {
    try {
      const mint = new PublicKey(params.mint);
      const user = new PublicKey(params.signer);
      
      // Use pool address from trade data
      const poolId = new PublicKey(params.trade.pool);
      
      // Initialize DBC client if not already done
      if (!this.client) {
        this.client = DynamicBondingCurveClient.create(this.connection);
      }
      
      // Get pool information using the poolId from trade data
      const poolAccount = await this.client.state.getPool(poolId);
      if (!poolAccount) {
        throw new Error('Pool not found');
      }
      
      const pool = poolAccount.account;
      const bondingCurve = poolAccount.publicKey;
      
      // Get pool config
      //const poolConfig = await this.client.state.getPoolConfig(pool.config);
      
      // Get vault addresses
      //const tokenVault = deriveDbcTokenVaultAddress(bondingCurve, mint);
      //const solVault = deriveDbcTokenVaultAddress(bondingCurve, NATIVE_MINT);
      
      // Get user token accounts
      const userTokenAccount = await getAssociatedTokenAddress(mint, user, false, TOKEN_PROGRAM_ID);
      
      // Create WSOL account with seed
      const seed = "W" + user.toBase58().slice(0, 15);
      const userSolAccount = await PublicKey.createWithSeed(user, seed, TOKEN_PROGRAM_ID);
      
      let instructions: TransactionInstruction[] = [];
      
      // Check if token account exists and create if needed
      const tokenAccountInfo = await this.connection.getAccountInfo(userTokenAccount);
      if (!tokenAccountInfo) {
        const createTokenAccountInstruction = createAssociatedTokenAccountInstruction(
          user,
          userTokenAccount,
          user,
          mint,
          TOKEN_PROGRAM_ID
        );
        instructions.push(createTokenAccountInstruction);
      }
      
      // Check if WSOL account exists and create if needed
      const wsolAccountInfo = await this.connection.getAccountInfo(userSolAccount);
      if (!wsolAccountInfo) {
        const space = 165;
        const lamports = await this.connection.getMinimumBalanceForRentExemption(space);
        
        // Create account with seed instruction
        const createAccountInstruction = SystemProgram.createAccountWithSeed({
          fromPubkey: user,
          basePubkey: user,
          seed: seed,
          newAccountPubkey: userSolAccount,
          lamports: lamports + (params.type === 'buy' ? Number(params.inputAmount) : 0),
          space: space,
          programId: TOKEN_PROGRAM_ID,
        });
        instructions.push(createAccountInstruction);
        
        // Initialize token account instruction
        const initAccountInstruction = new TransactionInstruction({
          keys: [
            { pubkey: userSolAccount, isSigner: false, isWritable: true },
            { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
            { pubkey: user, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          programId: TOKEN_PROGRAM_ID,
          data: Buffer.from([1]), // Initialize account instruction
        });
        instructions.push(initAccountInstruction);
      } else if (params.type === 'buy') {
        // Transfer SOL to existing WSOL account
        const transferInstruction = SystemProgram.transfer({
          fromPubkey: user,
          toPubkey: userSolAccount,
          lamports: Number(params.inputAmount),
        });
        instructions.push(transferInstruction);
        
        // Sync native instruction
        instructions.push(createSyncNativeInstruction(userSolAccount));
      }
      
      // Create the main swap instruction using DBC SDK
      const swapBaseForQuote = params.type === 'sell'; // sell tokens for SOL = swapBaseForQuote true
      const amountIn = this.toBN(params.inputAmount || 0);
      const minimumAmountOut = this.toBN(params.outputAmount || 0);
      
      // Apply slippage to minimum amount out
      const slippageMultiplier = (10000 - (params.slippageBps || 100)) / 10000;
      const minAmountOutWithSlippage = minimumAmountOut.muln(slippageMultiplier);
      
      const swapTransaction = await this.client.pool.swap({
        pool: poolId,
        amountIn: amountIn,
        minimumAmountOut: minAmountOutWithSlippage,
        swapBaseForQuote: swapBaseForQuote,
        owner: user,
        payer: user,
        referralTokenAccount: null
      });
      
      // Add swap instructions to our transaction
      instructions.push(...swapTransaction.instructions);
      
      // Close WSOL account to recover remaining SOL
      const closeAccountInstruction = createCloseAccountInstruction(
        userSolAccount,
        user,
        user
      );
      instructions.push(closeAccountInstruction);
      
      // Convert TransactionInstructions to SwapInstructions
      return instructions.map(ix => this.convertToSwapInstruction(ix));
      
    } catch (error) {
      console.error('Error creating DBC instructions:', error);
      throw new Error(`Failed to create DBC transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  
  private toBN(value: number | string | BN | bigint): BN {
    if (BN.isBN(value)) return value;
    if (typeof value === 'bigint') {
      return new BN(value.toString());
    } else if (typeof value === 'string' && value.startsWith('0x')) {
      return new BN(value.slice(2), 16);
    } else if (typeof value === 'string') {
      return new BN(value);
    } else {
      return new BN(value);
    }
  }
  
  // Helper method to get bonding curve info
  public async getBondingCurveInfo(tokenMint: string) {
    try {
      if (!this.client) {
        this.client = DynamicBondingCurveClient.create(this.connection);
      }
      
      const mint = new PublicKey(tokenMint);
      
      // Get pool by base mint (token mint)
      const poolAccount = await this.client.state.getPoolByBaseMint(mint);
      if (!poolAccount) {
        throw new Error('Pool not found for token mint');
      }
      
      const pool = poolAccount.account;
      const bondingCurve = poolAccount.publicKey;
      
      // Get pool config
      const poolConfig = await this.client.state.getPoolConfig(pool.config);
      
      // Get vault addresses
      const tokenVault = deriveDbcTokenVaultAddress(bondingCurve, mint);
      const solVault = deriveDbcTokenVaultAddress(bondingCurve, NATIVE_MINT);
      
      return {
        bondingCurve,
        pool,
        poolConfig,
        tokenVault,
        solVault,
        tokenMint: mint
      };
    } catch (error) {
      console.error('Error getting bonding curve info:', error);
      throw error;
    }
  }
  
  // Helper method to calculate swap output using swapQuote
  public async calculateSwapOutput(
    tokenMint: string,
    inputAmount: number,
    isTokenToSol: boolean = false
  ): Promise<string> {
    try {
      // For now, return a simple calculation or "0" until SDK types are properly resolved
      // This method can be implemented once the SDK type issues are resolved
      console.warn('calculateSwapOutput not fully implemented due to SDK type constraints');
      return "0";
    } catch (error) {
      console.error('Error calculating swap output:', error);
      return "0";
    }
  }
  
  // DBC specific helper methods
  public static isDBCProgram(programId: string): boolean {
    return programId === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
  }
  
  public getDBCPoolId(mint: string): PublicKey {
    return new PublicKey(mint); 
  }
}