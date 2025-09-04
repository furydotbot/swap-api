import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
import { 
  Connection, 
  PublicKey, 
  TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT
} from '@solana/spl-token';
import {
  ApiV3PoolInfoStandardItem,
  AmmV4Keys,
  AmmRpcData,
  Raydium,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';

export class AMMTransactionBuilder extends BaseTransactionBuilder {
  public readonly programId = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'; // Raydium AMM V4
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
    const instructions = await this.createAMMInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createAMMInstructions(params: SwapParams): Promise<SwapInstruction[]> {
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

      let poolInfo: ApiV3PoolInfoStandardItem;
      let poolKeys: AmmV4Keys;
      let rpcData: AmmRpcData;

      if (this.raydium.cluster === 'mainnet') {
        // Get pool info from API for mainnet
        const data = await this.raydium.api.fetchPoolById({ ids: poolId });
        poolInfo = data[0] as ApiV3PoolInfoStandardItem;
        
        if (!this.isValidAmm(poolInfo.programId)) {
          throw new Error('target pool is not AMM pool');
        }
        
        poolKeys = await this.raydium.liquidity.getAmmPoolKeys(poolId);
        rpcData = await this.raydium.liquidity.getRpcPoolInfo(poolId);
      } else {
        // Get pool info from RPC for devnet
        const data = await this.raydium.liquidity.getPoolInfoFromRpc({ poolId });
        poolInfo = data.poolInfo;
        poolKeys = data.poolKeys;
        rpcData = data.poolRpcData;
      }

      const [baseReserve, quoteReserve, status] = [
        rpcData.baseReserve, 
        rpcData.quoteReserve, 
        rpcData.status.toNumber()
      ];

      // Determine input and output mints based on trade type
      const inputMint = params.type === 'buy' ? NATIVE_MINT.toBase58() : params.mint;
      const outputMint = params.type === 'buy' ? params.mint : NATIVE_MINT.toBase58();

      // Validate input mint matches pool
      if (poolInfo.mintA.address !== inputMint && poolInfo.mintB.address !== inputMint) {
        throw new Error('input mint does not match pool');
      }

      const baseIn = inputMint === poolInfo.mintA.address;
      const [mintIn, mintOut] = baseIn ? [poolInfo.mintA, poolInfo.mintB] : [poolInfo.mintB, poolInfo.mintA];

      // Compute swap amounts
      let computeResult;
      let swapAmount: BN;
      let minAmountOut: BN;
      const slippage = (params.slippageBps || 100) / 10000; // Convert basis points to decimal

      if (params.inputAmount) {
        // Fixed input amount
        computeResult = this.raydium.liquidity.computeAmountOut({
          poolInfo: {
            ...poolInfo,
            baseReserve,
            quoteReserve,
            status,
            version: 4,
          },
          amountIn: new BN(params.inputAmount),
          mintIn: mintIn.address,
          mintOut: mintOut.address,
          slippage,
        });
        
        swapAmount = new BN(params.inputAmount);
        minAmountOut = computeResult.minAmountOut;
      } else if (params.outputAmount) {
        // Fixed output amount
        computeResult = this.raydium.liquidity.computeAmountIn({
          poolInfo: {
            ...poolInfo,
            baseReserve,
            quoteReserve,
            status,
            version: 4,
          },
          amountOut: new BN(params.outputAmount),
          mintIn: mintIn.address,
          mintOut: mintOut.address,
          slippage,
        });
        
        swapAmount = computeResult.maxAmountIn;
        minAmountOut = new BN(params.outputAmount);
      } else {
        throw new Error('Either inputAmount or outputAmount must be specified');
      }

      // Create swap transaction using Raydium SDK
      const fixedSide = params.inputAmount ? 'in' : 'out';
      const swapResult = await this.raydium.liquidity.swap({
        poolInfo,
        poolKeys,
        amountIn: swapAmount,
        amountOut: minAmountOut,
        fixedSide,
        inputMint: mintIn.address,
        txVersion: 'LEGACY' as any, // Use legacy transaction format
        
        // Token account configuration
        config: {
          inputUseSolBalance: mintIn.address === NATIVE_MINT.toBase58(),
          outputUseSolBalance: mintOut.address === NATIVE_MINT.toBase58(),
          associatedOnly: true,
        },

        // Priority fee configuration
        computeBudgetConfig: (params as any).priorityFee ? {
          units: 600000,
          microLamports: (params as any).priorityFee,
        } : undefined,
      });

      // Extract instructions from the swap result
      let instructions: TransactionInstruction[];
      
      if (swapResult && typeof swapResult === 'object') {
        // Try different possible structures
        if ('instructions' in swapResult) {
          instructions = swapResult.instructions as TransactionInstruction[];
        } else if ('transaction' in swapResult && swapResult.transaction) {
          const transaction = swapResult.transaction;
          // Handle both Transaction and VersionedTransaction
          if ('instructions' in transaction) {
            instructions = (transaction as any).instructions as TransactionInstruction[];
          } else if ('message' in transaction && 'compiledInstructions' in transaction.message) {
            // VersionedTransaction - need to convert compiled instructions
            throw new Error('VersionedTransaction not yet supported - please use legacy transaction format');
          } else {
            throw new Error('Unable to extract instructions from transaction');
          }
        } else if (Array.isArray(swapResult)) {
          instructions = swapResult as TransactionInstruction[];
        } else {
          throw new Error('Unable to extract instructions from swap result');
        }
      } else {
        throw new Error('Invalid swap result structure');
      }

      // Convert TransactionInstructions to SwapInstructions
      return instructions.map((ix: any) => this.convertToSwapInstruction(ix));
      
    } catch (error) {
      console.error('Error creating AMM instructions:', error);
      throw new Error(`Failed to create AMM transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  
  private isValidAmm(programId: string): boolean {
    // Check if the program ID is a valid AMM program
    // This should match the logic from the utils file in the examples
    const validAmmPrograms = [
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
      '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Raydium AMM V5
    ];
    return validAmmPrograms.includes(programId);
  }
  
  // AMM specific helper methods
  public static isAMMProgram(programId: string): boolean {
    const validAmmPrograms = [
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
      '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Raydium AMM V5
    ];
    return validAmmPrograms.includes(programId);
  }
  
  // Helper method to compute swap preview without creating transaction
  public async computeSwapPreview(params: SwapParams): Promise<{
    amountIn: string;
    amountOut: string;
    minAmountOut: string;
    maxAmountIn?: string;
    priceImpact: string;
    fee: string;
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
    let poolInfo: ApiV3PoolInfoStandardItem;
    let rpcData: AmmRpcData;

    if (this.raydium.cluster === 'mainnet') {
      const data = await this.raydium.api.fetchPoolById({ ids: poolId });
      poolInfo = data[0] as ApiV3PoolInfoStandardItem;
      rpcData = await this.raydium.liquidity.getRpcPoolInfo(poolId);
    } else {
      const data = await this.raydium.liquidity.getPoolInfoFromRpc({ poolId });
      poolInfo = data.poolInfo;
      rpcData = data.poolRpcData;
    }

    const [baseReserve, quoteReserve, status] = [
      rpcData.baseReserve, 
      rpcData.quoteReserve, 
      rpcData.status.toNumber()
    ];

    const inputMint = params.type === 'buy' ? NATIVE_MINT.toBase58() : params.mint;
    const baseIn = inputMint === poolInfo.mintA.address;
    const [mintIn, mintOut] = baseIn ? [poolInfo.mintA, poolInfo.mintB] : [poolInfo.mintB, poolInfo.mintA];
    const slippage = (params.slippageBps || 100) / 10000; // Convert basis points to decimal

    let result;
    if (params.inputAmount) {
      result = this.raydium.liquidity.computeAmountOut({
        poolInfo: {
          ...poolInfo,
          baseReserve,
          quoteReserve,
          status,
          version: 4,
        },
        amountIn: new BN(params.inputAmount),
        mintIn: mintIn.address,
        mintOut: mintOut.address,
        slippage,
      });
    } else if (params.outputAmount) {
      result = this.raydium.liquidity.computeAmountIn({
        poolInfo: {
          ...poolInfo,
          baseReserve,
          quoteReserve,
          status,
          version: 4,
        },
        amountOut: new BN(params.outputAmount),
        mintIn: mintIn.address,
        mintOut: mintOut.address,
        slippage,
      });
    } else {
      throw new Error('Either inputAmount or outputAmount must be specified');
    }

    // Handle different result types from computeAmountOut vs computeAmountIn
    const isAmountOutResult = 'amountOut' in result;
    
    return {
      amountIn: isAmountOutResult 
        ? (result as any).amountIn?.toString() || params.inputAmount?.toString() || '0'
        : (result as any).maxAmountIn?.toString() || '0',
      amountOut: isAmountOutResult 
        ? (result as any).amountOut?.toString() || '0'
        : params.outputAmount?.toString() || '0',
      minAmountOut: isAmountOutResult 
        ? (result as any).minAmountOut?.toString() || '0'
        : params.outputAmount?.toString() || '0',
      maxAmountIn: !isAmountOutResult 
        ? (result as any).maxAmountIn?.toString()
        : undefined,
      priceImpact: result.priceImpact?.toFixed(4) || '0',
      fee: (result as any).fee?.toString() || '0',
    };
  }
}