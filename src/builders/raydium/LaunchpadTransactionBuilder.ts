import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
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
  TOKEN_PROGRAM_ID,
  NATIVE_MINT
} from '@solana/spl-token';
import {
  getPdaLaunchpadPoolId,
  getPdaLaunchpadAuth,
  getPdaPlatformVault,
  getPdaCreatorVault,
  LAUNCHPAD_PROGRAM,
  Raydium
} from '@raydium-io/raydium-sdk-v2';
import { 
  buyExactInInstruction,
  sellExactInInstruction 
} from '@raydium-io/raydium-sdk-v2/lib/raydium/launchpad/instrument';
import BN from 'bn.js';

export class LaunchpadTransactionBuilder extends BaseTransactionBuilder {
  programId = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
  private connection: Connection;
  private raydium: Raydium | null = null;
  
  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }
  
  async buildSwapTransaction(params: SwapParams): Promise<SwapTransaction> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const transactionId = `tx_${timestamp}_${random}`;
    const instructions = await this.createLaunchpadInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createLaunchpadInstructions(params: SwapParams): Promise<SwapInstruction[]> {
    try {
      const mint = new PublicKey(params.mint);
      const user = new PublicKey(params.signer);
      const mintB = NATIVE_MINT;
      const programId = LAUNCHPAD_PROGRAM;
      
      // Use poolId from trade data
      const poolId = new PublicKey(params.trade.pool);
      
      // Initialize Raydium SDK if not already done
      if (!this.raydium) {
        this.raydium = await Raydium.load({
          connection: this.connection,
          cluster: 'mainnet',
          owner: user,
          disableFeatureCheck: true,
          disableLoadToken: true,
          blockhashCommitment: 'processed',
        });
      }
      
      // Get pool information using the poolId from trade data
      const poolInfo = await this.raydium.launchpad.getRpcPoolInfo({ poolId });
      
      // Get auth program ID
      const authProgramId = getPdaLaunchpadAuth(programId).publicKey;
      
      // Get user token accounts
      const userTokenAccountA = await getAssociatedTokenAddress(mint, user, false, TOKEN_PROGRAM_ID);
      
      // Create WSOL account with seed
      const seed = "W" + user.toBase58().slice(0, 15);
      const userTokenAccountB = await PublicKey.createWithSeed(user, seed, TOKEN_PROGRAM_ID);
      
      let instructions: TransactionInstruction[] = [];
      
      // Check if token account A exists and create if needed
      const tokenAccountAInfo = await this.connection.getAccountInfo(userTokenAccountA);
      if (!tokenAccountAInfo) {
        const createTokenAccountAInstruction = createAssociatedTokenAccountInstruction(
          user,
          userTokenAccountA,
          user,
          mint,
          TOKEN_PROGRAM_ID
        );
        instructions.push(createTokenAccountAInstruction);
      }
      
      // Check if WSOL account exists and create if needed
      const wsolAccountInfo = await this.connection.getAccountInfo(userTokenAccountB);
      if (!wsolAccountInfo) {
        const space = 165;
        const lamports = await this.connection.getMinimumBalanceForRentExemption(space);
        
        // Create account with seed instruction
        const createAccountInstruction = SystemProgram.createAccountWithSeed({
          fromPubkey: user,
          basePubkey: user,
          seed: seed,
          newAccountPubkey: userTokenAccountB,
          lamports: lamports + (params.type === 'buy' ? Number(params.inputAmount) : 0),
          space: space,
          programId: TOKEN_PROGRAM_ID,
        });
        instructions.push(createAccountInstruction);
        
        // Initialize token account instruction
        const initAccountInstruction = new TransactionInstruction({
          keys: [
            { pubkey: userTokenAccountB, isSigner: false, isWritable: true },
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
          toPubkey: userTokenAccountB,
          lamports: Number(params.inputAmount),
        });
        instructions.push(transferInstruction);
        
        // Sync native instruction
        const syncNativeInstruction = new TransactionInstruction({
          keys: [{ pubkey: userTokenAccountB, isSigner: false, isWritable: true }],
          programId: TOKEN_PROGRAM_ID,
          data: Buffer.from([17]), // SyncNative instruction
        });
        instructions.push(syncNativeInstruction);
      }
      
      // Create the main swap instruction
      let swapInstruction: TransactionInstruction;
      
      if (params.type === 'buy') {
        const maxInAmountBN = new BN(params.inputAmount || 0);
        const minOutAmountBN = new BN(params.outputAmount || 0);
        
        swapInstruction = buyExactInInstruction(
          programId,
          user,
          authProgramId,
          poolInfo.configId,
          poolInfo.platformId,
          poolId,
          userTokenAccountA,
          userTokenAccountB,
          poolInfo.vaultA,
          poolInfo.vaultB,
          mint,
          mintB,
          TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          getPdaPlatformVault(programId, poolInfo.platformId, mintB).publicKey,
          getPdaCreatorVault(programId, poolInfo.creator, mintB).publicKey,
          maxInAmountBN,
          minOutAmountBN,
          new BN(0) // No fee sharing
        );
      } else {
        const sellAmountBN = new BN(params.inputAmount || 0);
        const minOutAmountBN = new BN(params.outputAmount || 0);
        
        swapInstruction = sellExactInInstruction(
          programId,
          user,
          authProgramId,
          poolInfo.configId,
          poolInfo.platformId,
          poolId,
          userTokenAccountA,
          userTokenAccountB,
          poolInfo.vaultA,
          poolInfo.vaultB,
          mint,
          mintB,
          TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          getPdaPlatformVault(programId, poolInfo.platformId, mintB).publicKey,
          getPdaCreatorVault(programId, poolInfo.creator, mintB).publicKey,
          sellAmountBN,
          minOutAmountBN,
          new BN(0) // No fee sharing
        );
      }
      
      instructions.push(swapInstruction);
      
      // Close WSOL account to recover remaining SOL
      const closeAccountInstruction = new TransactionInstruction({
        keys: [
          { pubkey: userTokenAccountB, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: false, isWritable: true },
          { pubkey: user, isSigner: true, isWritable: false },
        ],
        programId: TOKEN_PROGRAM_ID,
        data: Buffer.from([9]), // CloseAccount instruction
      });
      instructions.push(closeAccountInstruction);
      
      // Convert TransactionInstructions to SwapInstructions
      return instructions.map(ix => this.convertToSwapInstruction(ix));
      
    } catch (error) {
      console.error('Error creating Launchpad instructions:', error);
      throw new Error(`Failed to create Launchpad transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  
  // Launchpad specific helper methods
  public static isLaunchpadProgram(programId: string): boolean {
    return programId === 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
  }
  
  public getLaunchpadPoolId(mint: string): PublicKey {
    const mintPubkey = new PublicKey(mint);
    return getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintPubkey, NATIVE_MINT).publicKey;
  }
}