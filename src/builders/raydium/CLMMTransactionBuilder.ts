import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
import { 
  Connection, 
  PublicKey, 
  TransactionInstruction
} from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  ApiV3PoolInfoConcentratedItem,
  ClmmKeys,
  ComputeClmmPoolInfo,
  PoolUtils,
  ReturnTypeFetchMultiplePoolTickArrays,
  Raydium,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';

export class CLMMTransactionBuilder extends BaseTransactionBuilder {
  public readonly programId = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'; // Raydium CLMM
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
    const instructions = await this.createCLMMInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createCLMMInstructions(params: SwapParams): Promise<SwapInstruction[]> {
    try {
      const user = new PublicKey(params.signer);
      const poolId = params.trade.pool;
      
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

      let poolInfo: ApiV3PoolInfoConcentratedItem;
      let poolKeys: ClmmKeys | undefined;
      let clmmPoolInfo: ComputeClmmPoolInfo;
      let tickCache: ReturnTypeFetchMultiplePoolTickArrays;

      if (this.raydium.cluster === 'mainnet') {
        // Get pool info from API for mainnet
        const data = await this.raydium.api.fetchPoolById({ ids: poolId });
        poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
        
        if (!this.isValidClmm(poolInfo.programId)) {
          throw new Error('target pool is not CLMM pool');
        }
        
        // Fetch CLMM compute info and tick arrays
        clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({
          connection: this.raydium.connection,
          poolInfo,
        });
        
        tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
          connection: this.raydium.connection,
          poolKeys: [clmmPoolInfo],
        });
      } else {
        // Get pool info from RPC for devnet
        const data = await this.raydium.clmm.getPoolInfoFromRpc(poolId);
        poolInfo = data.poolInfo;
        poolKeys = data.poolKeys;
        clmmPoolInfo = data.computePoolInfo;
        tickCache = data.tickData;
      }

      // Determine input and output mints based on trade type
      const inputMint = params.type === 'buy' ? NATIVE_MINT.toBase58() : params.mint;
      const outputMint = params.type === 'buy' ? params.mint : NATIVE_MINT.toBase58();

      // Validate input mint matches pool
      if (inputMint !== poolInfo.mintA.address && inputMint !== poolInfo.mintB.address) {
        throw new Error('input mint does not match pool');
      }

      const epochInfo = await this.raydium.fetchEpochInfo();
      let swapResult;

      // Determine fixed side based on which amount is provided
      const isFixedOutput = params.outputAmount && !params.inputAmount;

      if (isFixedOutput) {
        // Fixed output amount (swapBaseOut)
        const amountOut = new BN(params.outputAmount || 0);
        const outputMintKey = new PublicKey(outputMint);
        
        const { remainingAccounts, ...computeResult } = await PoolUtils.computeAmountIn({
          poolInfo: clmmPoolInfo,
          tickArrayCache: tickCache[poolId],
          amountOut,
          baseMint: outputMintKey,
          slippage: (params.slippageBps || 100) / 10000, // Convert BPS to decimal
          epochInfo,
        });

        swapResult = await this.raydium.clmm.swapBaseOut({
          poolInfo,
          poolKeys,
          outputMint: outputMintKey,
          amountInMax: computeResult.maxAmountIn.amount,
          amountOut: computeResult.realAmountOut.amount,
          observationId: clmmPoolInfo.observationId,
          ownerInfo: {
            useSOLBalance: outputMint === NATIVE_MINT.toBase58() || inputMint === NATIVE_MINT.toBase58(),
          },
          remainingAccounts,
          txVersion: 'LEGACY' as any,
          
          // Priority fee configuration
          computeBudgetConfig: (params as any).priorityFee ? {
            units: 600000,
            microLamports: (params as any).priorityFee,
          } : undefined,
        });
      } else {
        // Fixed input amount (regular swap)
        const baseIn = inputMint === poolInfo.mintA.address;
        const amountIn = new BN(params.inputAmount || 0);
        
        const { minAmountOut, remainingAccounts } = await PoolUtils.computeAmountOutFormat({
          poolInfo: clmmPoolInfo,
          tickArrayCache: tickCache[poolId],
          amountIn,
          tokenOut: poolInfo[baseIn ? 'mintB' : 'mintA'],
          slippage: (params.slippageBps || 100) / 10000, // Convert BPS to decimal
          epochInfo,
        });

        swapResult = await this.raydium.clmm.swap({
          poolInfo,
          poolKeys,
          inputMint: poolInfo[baseIn ? 'mintA' : 'mintB'].address,
          amountIn,
          amountOutMin: minAmountOut.amount.raw,
          observationId: clmmPoolInfo.observationId,
          ownerInfo: {
            useSOLBalance: outputMint === NATIVE_MINT.toBase58() || inputMint === NATIVE_MINT.toBase58(),
          },
          remainingAccounts,
          txVersion: 'LEGACY' as any,
          
          // Priority fee configuration
          computeBudgetConfig: (params as any).priorityFee ? {
            units: 600000,
            microLamports: (params as any).priorityFee,
          } : undefined,
        });
      }

      // Extract instructions from the swap result
      let instructions: TransactionInstruction[];
      
      if (swapResult && typeof swapResult === 'object') {
        if ('instructions' in swapResult && Array.isArray(swapResult.instructions)) {
          instructions = swapResult.instructions;
        } else if ('transaction' in swapResult && swapResult.transaction) {
          const transaction = swapResult.transaction;
          if ('instructions' in transaction) {
            instructions = (transaction as any).instructions;
          } else {
            throw new Error('Unsupported transaction type: VersionedTransaction not supported');
          }
        } else if (Array.isArray(swapResult)) {
          instructions = swapResult;
        } else {
          throw new Error('Unable to extract instructions from swap result');
        }
      } else {
        throw new Error('Invalid swap result format');
      }

      // Convert TransactionInstructions to SwapInstructions
      return instructions.map(ix => this.convertToSwapInstruction(ix));
      
    } catch (error) {
      console.error('Error creating CLMM instructions:', error);
      throw new Error(`Failed to create CLMM transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  
  private isValidClmm(programId: string): boolean {
    // Check if the program ID is a valid CLMM program
    const validClmmPrograms = [
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    ];
    return validClmmPrograms.includes(programId);
  }
  
  // CLMM specific helper methods
  public static isCLMMProgram(programId: string): boolean {
    const validClmmPrograms = [
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    ];
    return validClmmPrograms.includes(programId);
  }
  
  // Helper method to compute CLMM swap preview without creating transaction
  public async computeSwapPreview(params: SwapParams): Promise<{
    amountIn: string;
    amountOut: string;
    minAmountOut?: string;
    maxAmountIn?: string;
    realAmountOut?: string;
    priceImpact: string;
    fee: string;
    currentPrice: string;
  }> {
    const user = new PublicKey(params.signer);
    
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

    const poolId = params.trade.pool;
    let poolInfo: ApiV3PoolInfoConcentratedItem;
    let clmmPoolInfo: ComputeClmmPoolInfo;
    let tickCache: ReturnTypeFetchMultiplePoolTickArrays;

    if (this.raydium.cluster === 'mainnet') {
      const data = await this.raydium.api.fetchPoolById({ ids: poolId });
      poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
      
      clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({
        connection: this.raydium.connection,
        poolInfo,
      });
      
      tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
        connection: this.raydium.connection,
        poolKeys: [clmmPoolInfo],
      });
    } else {
      const data = await this.raydium.clmm.getPoolInfoFromRpc(poolId);
      poolInfo = data.poolInfo;
      clmmPoolInfo = data.computePoolInfo;
      tickCache = data.tickData;
    }

    const inputMint = params.type === 'buy' ? NATIVE_MINT.toBase58() : params.mint;
    const outputMint = params.type === 'buy' ? params.mint : NATIVE_MINT.toBase58();
    const epochInfo = await this.raydium.fetchEpochInfo();

    let result: any;

    // Determine fixed side based on which amount is provided
    const isFixedOutput = params.outputAmount && !params.inputAmount;
    
    if (isFixedOutput) {
      // Fixed output computation
      const amountOut = new BN(params.outputAmount || 0);
      const outputMintKey = new PublicKey(outputMint);
      
      result = await PoolUtils.computeAmountIn({
        poolInfo: clmmPoolInfo,
        tickArrayCache: tickCache[poolId],
        amountOut,
        baseMint: outputMintKey,
        slippage: (params.slippageBps || 100) / 10000, // Convert BPS to decimal
        epochInfo,
      });
      
      return {
        amountIn: result.amountIn?.amount?.toString() || '0',
        amountOut: result.realAmountOut?.amount?.toString() || params.outputAmount?.toString() || '0',
        maxAmountIn: result.maxAmountIn?.amount?.toString(),
        realAmountOut: result.realAmountOut?.amount?.toString(),
        priceImpact: '0', // CLMM doesn't directly return price impact in computeAmountIn
        fee: result.fee?.amount?.toString() || '0',
        currentPrice: clmmPoolInfo.currentPrice?.toString() || '0',
      };
    } else {
      // Fixed input computation
      const baseIn = inputMint === poolInfo.mintA.address;
      const amountIn = new BN(params.inputAmount || 0);
      
      result = await PoolUtils.computeAmountOutFormat({
        poolInfo: clmmPoolInfo,
        tickArrayCache: tickCache[poolId],
        amountIn,
        tokenOut: poolInfo[baseIn ? 'mintB' : 'mintA'],
        slippage: (params.slippageBps || 100) / 10000, // Convert BPS to decimal
        epochInfo,
      });

      return {
        amountIn: params.inputAmount?.toString() || '0',
        amountOut: result.amountOut?.amount?.toString() || '0',
        minAmountOut: result.minAmountOut?.amount?.raw?.toString(),
        priceImpact: result.priceImpact?.toFixed(4) || '0',
        fee: result.fee?.amount?.toString() || '0',
        currentPrice: clmmPoolInfo.currentPrice?.toString() || '0',
      };
    }
  }

  // Helper method to get pool tick arrays info
  public async getPoolTickInfo(poolId: string): Promise<{
    tickSpacing: number;
    tickArrayBitmap: string[];
    currentTick: number;
    sqrtPriceX64: string;
  }> {
    if (!this.raydium) {
      throw new Error('Raydium SDK not initialized');
    }

    let poolInfo: ApiV3PoolInfoConcentratedItem;
    let clmmPoolInfo: ComputeClmmPoolInfo;

    if (this.raydium.cluster === 'mainnet') {
      const data = await this.raydium.api.fetchPoolById({ ids: poolId });
      poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
      
      clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({
        connection: this.raydium.connection,
        poolInfo,
      });
    } else {
      const data = await this.raydium.clmm.getPoolInfoFromRpc(poolId);
      clmmPoolInfo = data.computePoolInfo;
    }

    return {
      tickSpacing: (clmmPoolInfo as any).config?.tickSpacing || (clmmPoolInfo as any).tickSpacing || 1,
      tickArrayBitmap: [], // Would need additional logic to fetch bitmap
      currentTick: clmmPoolInfo.tickCurrent,
      sqrtPriceX64: clmmPoolInfo.sqrtPriceX64.toString(),
    };
  }
}