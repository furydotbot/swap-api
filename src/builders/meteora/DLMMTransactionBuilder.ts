import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { LBCLMM, SwapParams as DLMMSwapParams } from '@meteora-ag/dlmm-sdk';
import BN from 'bn.js';

export class DLMMTransactionBuilder extends BaseTransactionBuilder {
  static readonly PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  programId: string = DLMMTransactionBuilder.PROGRAM_ID.toString();
  private connection: Connection;
  
  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }
  
  async buildSwapTransaction(params: SwapParams): Promise<SwapTransaction> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const transactionId = `tx_${timestamp}_${random}`;
    const instructions = await this.createDLMMInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createDLMMInstructions(params: SwapParams): Promise<SwapInstruction[]> {
    try {
      const mint = new PublicKey(params.mint);
      const user = new PublicKey(params.signer);
      const lbPairAddress = new PublicKey(params.trade.pool);
      
      // Create LBCLMM instance
      const lbclmm = await LBCLMM.createMultiple(this.connection, [lbPairAddress]);
      if (!lbclmm || lbclmm.length === 0) {
        throw new Error(`LB Pair not found for address: ${params.trade.pool}`);
      }
      
      const lbPair = lbclmm[0];
      
      // Determine input and output tokens
      const tokenXMint = lbPair.tokenX.publicKey;
      const tokenYMint = lbPair.tokenY.publicKey;
      
      // Check which token we're swapping
      const isTokenX = mint.equals(tokenXMint);
      const inToken = isTokenX ? tokenXMint : tokenYMint;
      const outToken = isTokenX ? tokenYMint : tokenXMint;
      
      // Calculate input amount
      const inputAmount = params.inputAmount ? new BN(params.inputAmount) : new BN(0);
      
      // Get bin arrays for the swap
      const binArrays = await lbPair.getBinArrays();
      const binArraysPubkey = binArrays.map(ba => ba.publicKey);
      
      // Calculate quote to get minimum output amount
      const swapForY = isTokenX; // Swap X to Y if input is token X
      const allowedSlippage = new BN(params.slippageBps); // slippage in BPS
      
      const quote = lbPair.swapQuote(
        inputAmount,
        swapForY,
        allowedSlippage,
        binArrays
      );
      
      // Prepare swap parameters
      const swapParams: DLMMSwapParams = {
        inToken,
        outToken,
        inAmount: inputAmount,
        minOutAmount: quote.minOutAmount,
        lbPair: lbPairAddress,
        user,
        binArraysPubkey
      };
      
      // Execute swap to get transaction
      const swapTx = await lbPair.swap(swapParams);
      
      // Convert transaction instructions to SwapInstruction format
      const swapInstructions: SwapInstruction[] = swapTx.instructions.map((ix: TransactionInstruction) => ({
        programId: ix.programId.toString(),
        accounts: ix.keys.map(key => ({
          pubkey: key.pubkey.toString(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: ix.data.toString('base64')
      }));
      
      return swapInstructions;
      
    } catch (error) {
      console.error('Error creating DLMM swap instructions:', error);
      throw error;
    }
  }
  
  // Helper method to get pool information
  async getPoolInfo(poolAddress: string): Promise<any> {
    try {
      const lbPairPubkey = new PublicKey(poolAddress);
      const lbclmm = await LBCLMM.createMultiple(this.connection, [lbPairPubkey]);
      
      if (!lbclmm || lbclmm.length === 0) {
        throw new Error(`LB Pair not found for address: ${poolAddress}`);
      }
      
      const lbPair = lbclmm[0];
      
      return {
        address: poolAddress,
        tokenX: {
          mint: lbPair.tokenX.publicKey.toString(),
          decimals: lbPair.tokenX.decimal
        },
        tokenY: {
          mint: lbPair.tokenY.publicKey.toString(),
          decimals: lbPair.tokenY.decimal
        },
        activeBin: await lbPair.getActiveBin(),
        feeInfo: lbPair.getFeeInfo()
      };
    } catch (error) {
      console.error('Error fetching DLMM pool info:', error);
      throw error;
    }
  }
  
  // Helper method to calculate swap quote
  async calculateSwapQuote(
    poolAddress: string,
    inputMint: string,
    inputAmount: number,
    slippageBps: number
  ): Promise<any> {
    try {
      const lbPairPubkey = new PublicKey(poolAddress);
      const inputMintPubkey = new PublicKey(inputMint);
      
      const lbclmm = await LBCLMM.createMultiple(this.connection, [lbPairPubkey]);
      if (!lbclmm || lbclmm.length === 0) {
        throw new Error(`LB Pair not found for address: ${poolAddress}`);
      }
      
      const lbPair = lbclmm[0];
      
      // Determine swap direction
      const isTokenX = inputMintPubkey.equals(lbPair.tokenX.publicKey);
      const swapForY = isTokenX;
      
      // Get bin arrays
      const binArrays = await lbPair.getBinArrays();
      
      // Calculate quote
      const quote = lbPair.swapQuote(
        new BN(inputAmount),
        swapForY,
        new BN(slippageBps),
        binArrays
      );
      
      return {
        inputAmount: inputAmount,
        outputAmount: quote.outAmount.toString(),
        minOutputAmount: quote.minOutAmount.toString(),
        fee: quote.fee.toString(),
        protocolFee: quote.protocolFee.toString(),
        priceImpact: quote.priceImpact.toString()
      };
    } catch (error) {
      console.error('Error calculating DLMM swap quote:', error);
      throw error;
    }
  }
  
  // Helper method to get all LB pairs
  static async getAllPools(connection: Connection): Promise<any[]> {
    try {
      const lbPairs = await LBCLMM.getLbPairs(connection);
      return lbPairs.map(pair => ({
        address: pair.publicKey.toString(),
        tokenX: pair.account.tokenXMint.toString(),
        tokenY: pair.account.tokenYMint.toString(),
        binStep: pair.account.binStep,
        activeId: pair.account.activeId
      }));
    } catch (error) {
      console.error('Error fetching all DLMM pools:', error);
      throw error;
    }
  }
  
  // Static method to check if a program ID is DLMM
  static isDLMMProgram(programId: string): boolean {
    return programId === DLMMTransactionBuilder.PROGRAM_ID.toString();
  }
  
  // Helper method to find pool address by token mints
  static async getPoolAddress(
    connection: Connection,
    tokenAMint: string,
    tokenBMint: string
  ): Promise<string | null> {
    try {
      const pools = await DLMMTransactionBuilder.getAllPools(connection);
      
      const pool = pools.find(p => 
        (p.tokenX === tokenAMint && p.tokenY === tokenBMint) ||
        (p.tokenX === tokenBMint && p.tokenY === tokenAMint)
      );
      
      return pool ? pool.address : null;
    } catch (error) {
      console.error('Error finding DLMM pool address:', error);
      return null;
    }
  }
}