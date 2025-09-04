import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
import { PumpSdk, bondingCurvePda } from '@pump-fun/pump-sdk';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';

export class PumpFunTransactionBuilder extends BaseTransactionBuilder {
  programId = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  private pumpSdk: PumpSdk;
  private connection: Connection;
  
  constructor(connection: Connection) {
    super();
    this.connection = connection;
    this.pumpSdk = new PumpSdk(connection);
  }
  
  async buildSwapTransaction(params: SwapParams): Promise<SwapTransaction> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const transactionId = `tx_${timestamp}_${random}`;
    const instructions = await this.createPumpFunInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createPumpFunInstructions(params: SwapParams): Promise<SwapInstruction[]> {
    try {
      const mint = new PublicKey(params.mint);
      const user = new PublicKey(params.signer);
      
      // Fetch required data
      const global = await this.pumpSdk.fetchGlobal();
      const bondingCurvePubkey = bondingCurvePda(mint);
      const bondingCurveAccountInfo = await this.connection.getAccountInfo(
        bondingCurvePubkey
      );
      
      const associatedUser = getAssociatedTokenAddressSync(mint, user, true);
      const associatedUserAccountInfo = await this.connection.getAccountInfo(
        associatedUser
      );
       
      if (!bondingCurveAccountInfo) {
        throw new Error(`Bonding curve not found for mint: ${params.mint}`);
      }
       
      const bondingCurve = this.pumpSdk.decodeBondingCurve(bondingCurveAccountInfo);
      
      let instructions: TransactionInstruction[];
      const slippagePercent = params.slippageBps ? params.slippageBps / 10000 : 0.01;
      
      if (params.type === 'buy') {
          // Use inputAmount from API calculation (already in SOL)
          const solAmount = new BN(params.inputAmount || 0);
          // Use outputAmount from API calculation (already in tokens)
          const tokenAmount = new BN(params.outputAmount || 0);
          
          // Add slippage to SOL amount for buy (allow spending more SOL)
          const solAmountWithSlippage = solAmount.add(
            solAmount.mul(new BN(Math.floor(slippagePercent * 1000))).div(new BN(1000))
          );
        
        instructions = [];
        
        // Add account extension instruction if bonding curve account is too small
        const BONDING_CURVE_NEW_SIZE = 41; // From pump-sdk constants
        if (bondingCurveAccountInfo.data.length < BONDING_CURVE_NEW_SIZE) {
          const extendInstruction = await this.pumpSdk.extendAccountInstruction({
            account: bondingCurvePubkey,
            user
          });
          instructions.push(extendInstruction);
        }
        
        // Add associated token account creation if needed
        if (!associatedUserAccountInfo) {
          const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
          const associatedUser = getAssociatedTokenAddressSync(mint, user, true);
          const createAtaInstruction = createAssociatedTokenAccountIdempotentInstruction(
            user,
            associatedUser,
            user,
            mint
          );
          instructions.push(createAtaInstruction);
        }
        
        const buyInstruction = await this.pumpSdk.getBuyInstructionRaw({
          user,
          mint,
          creator: bondingCurve.creator,
          amount: tokenAmount,
          solAmount: solAmountWithSlippage,
          feeRecipient: global.feeRecipient
        });
        
        instructions.push(buyInstruction);
      } else {
        // Use inputAmount from API calculation (already in tokens)
        const tokenAmount = new BN(params.inputAmount || 0);
        // Use outputAmount from API calculation (already in SOL)
        const solAmount = new BN(params.outputAmount || 0);
        
        // Subtract slippage from SOL amount for sell (accept receiving less SOL)
        const solAmountWithSlippage = solAmount.sub(
          solAmount.mul(new BN(Math.floor(slippagePercent * 1000))).div(new BN(1000))
        );
        
        instructions = [];
        
        // Add account extension instruction if bonding curve account is too small
        const BONDING_CURVE_NEW_SIZE = 41; // From pump-sdk constants
        if (bondingCurveAccountInfo.data.length < BONDING_CURVE_NEW_SIZE) {
          const extendInstruction = await this.pumpSdk.extendAccountInstruction({
            account: bondingCurvePubkey,
            user
          });
          instructions.push(extendInstruction);
        }
      
        const sellInstruction = await this.pumpSdk.getSellInstructionRaw({
          user,
          mint,
          creator: bondingCurve.creator,
          amount: tokenAmount,
          solAmount: solAmountWithSlippage,
          feeRecipient: global.feeRecipient
        });
        
        instructions.push(sellInstruction);
      }
      
      // Convert TransactionInstructions to SwapInstructions
      return instructions.map(ix => this.convertToSwapInstruction(ix));
      
    } catch (error) {
       console.error('Error creating PumpFun instructions:', error);
       throw new Error(`Failed to create PumpFun transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  
  // Helper method to get bonding curve PDA
  public bondingCurvePda(mint: PublicKey): PublicKey {
    return bondingCurvePda(mint);
  }
    

  
  // PumpFun specific helper methods
  public static isPumpFunProgram(programId: string): boolean {
    return programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  }
  
  
  public getPumpFunPoolAddress(mint: string): string {
    return `pool_${mint.substring(0, 8)}`;
  }
}