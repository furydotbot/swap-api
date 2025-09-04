import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../../TransactionBuilder';
import { 
  Connection, 
  PublicKey, 
  TransactionInstruction
} from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  ApiV3PoolInfoStandardItemCpmm,
  CpmmKeys,
  CpmmParsedRpcData,
  CurveCalculator,
  FeeOn,
  Raydium,
  USDCMint,
  TxVersion
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';

export class CPMMTransactionBuilder extends BaseTransactionBuilder {
  public readonly programId = 'CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW'; // Raydium CPMM
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
    const instructions = await this.createCPMMInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }
  
  private async createCPMMInstructions(params: SwapParams): Promise<SwapInstruction[]> {
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

      let poolInfo: ApiV3PoolInfoStandardItemCpmm;
      let poolKeys: CpmmKeys | undefined;
      let rpcData: CpmmParsedRpcData;

      if (this.raydium.cluster === 'mainnet') {
        // Get pool info from API for mainnet
        const data = await this.raydium.api.fetchPoolById({ ids: poolId });
        poolInfo = data[0] as ApiV3PoolInfoStandardItemCpmm;
        
        if (!this.isValidCpmm(poolInfo.programId)) {
          throw new Error('target pool is not CPMM pool');
        }
        
        // Get RPC data for calculations
        rpcData = await this.raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);
      } else {
        // Get pool info from RPC for devnet
        const data = await this.raydium.cpmm.getPoolInfoFromRpc(poolId);
        poolInfo = data.poolInfo;
        poolKeys = data.poolKeys;
        rpcData = data.rpcData;
      }

      // Determine input and output mints based on trade type
      const inputMint = params.type === 'buy' ? NATIVE_MINT.toBase58() : params.mint;
      const outputMint = params.type === 'buy' ? params.mint : NATIVE_MINT.toBase58();

      // Validate input mint matches pool
      if (inputMint !== poolInfo.mintA.address && inputMint !== poolInfo.mintB.address) {
        throw new Error('input mint does not match pool');
      }

      // Determine swap direction
      const baseIn = inputMint === poolInfo.mintA.address;
      let swapResult;
      let inputAmount: BN;
      let isFixedOut = false;

      if ((params as any).fixedSide === 'out') {
        // Fixed output amount (swapBaseOut)
        const outputAmount = new BN(params.outputAmount || 0);
        const maxAvailable = rpcData[baseIn ? 'quoteReserve' : 'baseReserve'];
        
        // Ensure output amount doesn't exceed available reserves
        const safeOutputAmount = outputAmount.gt(maxAvailable) 
          ? maxAvailable.sub(new BN(1))
          : outputAmount;
        
        swapResult = CurveCalculator.swapBaseOutput(
          safeOutputAmount,
          baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
          baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
          rpcData.configInfo!.tradeFeeRate,
          rpcData.configInfo!.creatorFeeRate,
          rpcData.configInfo!.protocolFeeRate,
          rpcData.configInfo!.fundFeeRate,
          rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
        );
        
        inputAmount = new BN(0); // Will be ignored when fixedOut is true
        isFixedOut = true;
      } else {
        // Fixed input amount (regular swap)
        inputAmount = new BN(params.inputAmount || 0);
        
        swapResult = CurveCalculator.swapBaseInput(
          inputAmount,
          baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
          baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
          rpcData.configInfo!.tradeFeeRate,
          rpcData.configInfo!.creatorFeeRate,
          rpcData.configInfo!.protocolFeeRate,
          rpcData.configInfo!.fundFeeRate,
          rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
        );
      }

      // Create swap transaction using Raydium SDK
      const swapTxBuilder = await this.raydium.cpmm.swap({
        poolInfo,
        poolKeys,
        inputAmount,
        fixedOut: isFixedOut,
        swapResult,
        slippage: (params.slippageBps || 100) / 10000,
        baseIn,
        txVersion: TxVersion.V0,
        
        // Priority fee configuration
        computeBudgetConfig: (params as any).priorityFee ? {
          units: 600000,
          microLamports: (params as any).priorityFee,
        } : undefined,
      });

      // Extract instructions from the transaction builder
      const transaction = await swapTxBuilder.transaction;
      
      // Handle different transaction types
      let instructions: TransactionInstruction[];
      if ('instructions' in transaction && Array.isArray(transaction.instructions)) {
        instructions = transaction.instructions;
      } else {
        throw new Error('Unsupported transaction type: VersionedTransaction not supported');
      }

      // Convert TransactionInstructions to SwapInstructions
      return instructions.map((ix: TransactionInstruction) => this.convertToSwapInstruction(ix));
      
    } catch (error) {
      console.error('Error creating CPMM instructions:', error);
      throw new Error(`Failed to create CPMM transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  
  private isValidCpmm(programId: string): boolean {
    // Check if the program ID is a valid CPMM program
    const validCpmmPrograms = [
      'CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW', // Raydium CPMM
    ];
    return validCpmmPrograms.includes(programId);
  }
  
  // CPMM specific helper methods
  public static isCPMMProgram(programId: string): boolean {
    const validCpmmPrograms = [
      'CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW', // Raydium CPMM
    ];
    return validCpmmPrograms.includes(programId);
  }
  
  // Helper method to compute CPMM swap preview without creating transaction
  public async computeSwapPreview(params: SwapParams): Promise<{
    inputAmount: string;
    outputAmount: string;
    tradeFee: string;
    creatorFee: string;
    protocolFee: string;
    fundFee: string;
    sourceAmountSwapped?: string;
    destinationAmountSwapped?: string;
    priceImpact: string;
    feeStructure: {
      tradeFeeRate: string;
      creatorFeeRate: string;
      protocolFeeRate: string;
      fundFeeRate: string;
      feeOn: string;
    };
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
    let poolInfo: ApiV3PoolInfoStandardItemCpmm;
    let rpcData: CpmmParsedRpcData;

    if (this.raydium.cluster === 'mainnet') {
      const data = await this.raydium.api.fetchPoolById({ ids: poolId });
      poolInfo = data[0] as ApiV3PoolInfoStandardItemCpmm;
      rpcData = await this.raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);
    } else {
      const data = await this.raydium.cpmm.getPoolInfoFromRpc(poolId);
      poolInfo = data.poolInfo;
      rpcData = data.rpcData;
    }

    const inputMint = params.type === 'buy' ? NATIVE_MINT.toBase58() : params.mint;
    const baseIn = inputMint === poolInfo.mintA.address;
    
    let swapResult;

    if ((params as any).fixedSide === 'out') {
      // Fixed output computation
      const outputAmount = new BN(params.outputAmount || 0);
      const maxAvailable = rpcData[baseIn ? 'quoteReserve' : 'baseReserve'];
      const safeOutputAmount = outputAmount.gt(maxAvailable) 
        ? maxAvailable.sub(new BN(1))
        : outputAmount;
      
      swapResult = CurveCalculator.swapBaseOutput(
        safeOutputAmount,
        baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
        baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
        rpcData.configInfo!.tradeFeeRate,
        rpcData.configInfo!.creatorFeeRate,
        rpcData.configInfo!.protocolFeeRate,
        rpcData.configInfo!.fundFeeRate,
        rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
      );

      return {
        inputAmount: swapResult.inputAmount.toString(),
        outputAmount: swapResult.outputAmount.toString(),
        sourceAmountSwapped: swapResult.inputAmount.toString(),
        destinationAmountSwapped: swapResult.outputAmount.toString(),
        tradeFee: swapResult.tradeFee.toString(),
        creatorFee: swapResult.creatorFee?.toString() || '0',
        protocolFee: swapResult.protocolFee?.toString() || '0',
        fundFee: swapResult.fundFee?.toString() || '0',
        priceImpact: this.calculatePriceImpact(swapResult, rpcData, baseIn).toFixed(4),
        feeStructure: {
          tradeFeeRate: rpcData.configInfo!.tradeFeeRate.toString(),
          creatorFeeRate: rpcData.configInfo!.creatorFeeRate.toString(),
          protocolFeeRate: rpcData.configInfo!.protocolFeeRate.toString(),
          fundFeeRate: rpcData.configInfo!.fundFeeRate.toString(),
          feeOn: rpcData.feeOn.toString(),
        },
      };
    } else {
      // Fixed input computation
      const inputAmount = new BN(params.inputAmount || 0);
      
      swapResult = CurveCalculator.swapBaseInput(
        inputAmount,
        baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
        baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
        rpcData.configInfo!.tradeFeeRate,
        rpcData.configInfo!.creatorFeeRate,
        rpcData.configInfo!.protocolFeeRate,
        rpcData.configInfo!.fundFeeRate,
        rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
      );

      return {
        inputAmount: swapResult.inputAmount.toString(),
        outputAmount: swapResult.outputAmount.toString(),
        tradeFee: swapResult.tradeFee.toString(),
        creatorFee: swapResult.creatorFee?.toString() || '0',
        protocolFee: swapResult.protocolFee?.toString() || '0',
        fundFee: swapResult.fundFee?.toString() || '0',
        priceImpact: this.calculatePriceImpact(swapResult, rpcData, baseIn).toFixed(4),
        feeStructure: {
          tradeFeeRate: rpcData.configInfo!.tradeFeeRate.toString(),
          creatorFeeRate: rpcData.configInfo!.creatorFeeRate.toString(),
          protocolFeeRate: rpcData.configInfo!.protocolFeeRate.toString(),
          fundFeeRate: rpcData.configInfo!.fundFeeRate.toString(),
          feeOn: rpcData.feeOn.toString(),
        },
      };
    }
  }

  private calculatePriceImpact(swapResult: any, rpcData: CpmmParsedRpcData, baseIn: boolean): number {
    // Calculate price impact based on reserves and swap amounts
    const inputReserve = baseIn ? rpcData.baseReserve : rpcData.quoteReserve;
    const outputReserve = baseIn ? rpcData.quoteReserve : rpcData.baseReserve;
    
    // Current price (before swap)
    const currentPrice = outputReserve.toNumber() / inputReserve.toNumber();
    
    // Effective price from swap
    const inputAmount = swapResult.inputAmount;
    const outputAmount = swapResult.outputAmount;
    const effectivePrice = outputAmount.toNumber() / inputAmount.toNumber();
    
    // Price impact percentage
    return Math.abs((effectivePrice - currentPrice) / currentPrice) * 100;
  }

  // Helper method to get pool configuration
  public async getPoolConfig(poolId: string): Promise<{
    tradeFeeRate: string;
    creatorFeeRate: string;
    protocolFeeRate: string;
    fundFeeRate: string;
    feeOn: string;
    baseReserve: string;
    quoteReserve: string;
    lpSupply: string;
  }> {
    if (!this.raydium) {
      throw new Error('Raydium SDK not initialized');
    }

    let poolInfo: ApiV3PoolInfoStandardItemCpmm;
    let rpcData: CpmmParsedRpcData;

    if (this.raydium.cluster === 'mainnet') {
      const data = await this.raydium.api.fetchPoolById({ ids: poolId });
      poolInfo = data[0] as ApiV3PoolInfoStandardItemCpmm;
      rpcData = await this.raydium.cpmm.getRpcPoolInfo(poolInfo.id, true);
    } else {
      const data = await this.raydium.cpmm.getPoolInfoFromRpc(poolId);
      poolInfo = data.poolInfo;
      rpcData = data.rpcData;
    }

    return {
      tradeFeeRate: rpcData.configInfo!.tradeFeeRate.toString(),
      creatorFeeRate: rpcData.configInfo!.creatorFeeRate.toString(),
      protocolFeeRate: rpcData.configInfo!.protocolFeeRate.toString(),
      fundFeeRate: rpcData.configInfo!.fundFeeRate.toString(),
      feeOn: rpcData.feeOn.toString(),
      baseReserve: rpcData.baseReserve.toString(),
      quoteReserve: rpcData.quoteReserve.toString(),
      lpSupply: ((rpcData as any).lpSupply || (rpcData as any).totalSupply || '0').toString(),
    };
  }
}