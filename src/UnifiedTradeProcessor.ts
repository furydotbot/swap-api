import { DexParser } from 'solana-dex-parser';
import { RawTransactionData, Trade } from './types';
import { getTransactionBuilderRegistry } from './builders/TransactionBuilderRegistry';
import { Connection } from '@solana/web3.js';

export interface ProcessedTradeResult {
  validTrades: Trade[];
  invalidTrades: any[];
  processingStats: {
    totalTrades: number;
    validTrades: number;
    invalidTrades: number;
    memeEventsFound: number;
  };
}

export class UnifiedTradeProcessor {
  private dexParser: DexParser;
  private builderRegistry: any;
  private connection: Connection;
  private SOL_MINT = 'So11111111111111111111111111111111111111112';

  constructor(connection: Connection) {
    this.dexParser = new DexParser();
    this.connection = connection;
    this.builderRegistry = getTransactionBuilderRegistry(connection);
  }

  private getParseConfig() {
    return {
      tryUnknowDEX: true,
      aggregateTrades: true,
      throwError: false
    };
  }

  /**
   * Detect transaction version based on the message structure
   * Legacy transactions have a different message structure than versioned transactions
   */
  private detectTransactionVersion(transaction: any): string {
    try {
      // Check if this is a versioned transaction by examining the message structure
      // Versioned transactions have a 'version' field or different message structure
      if (transaction.version !== undefined) {
        return transaction.version === 0 ? '0' : 'legacy';
      }
      
      // Check message structure - versioned transactions have different properties
      if (transaction.message) {
        // V0 transactions have 'compiledInstructions' instead of 'instructions'
        // and may have 'addressTableLookups'
        if (transaction.message.compiledInstructions || transaction.message.addressTableLookups) {
          return '0';
        }
        
        // Legacy transactions have 'instructions' directly in the message
        if (transaction.message.instructions) {
          return 'legacy';
        }
      }
      
      // Default to legacy if we can't determine the version
      return 'legacy';
    } catch (error) {
      // If there's any error detecting version, default to legacy
      return 'legacy';
    }
  }

  /**
   * Process a transaction and return unified trades from both trades and meme events
   * Each trade is validated individually, not as a batch
   */
  async processTransaction(rawTransaction: RawTransactionData, shouldLog: boolean = false): Promise<ProcessedTradeResult> {
    try {
      // Detect transaction version based on the message header
      // In versioned transactions, the first bit of the message header is set
      const version = this.detectTransactionVersion(rawTransaction.transaction);
      
      // Parse all data from the transaction (trades, liquidity, transfers, memeEvents)
      // DexParser expects the full transaction response object (with meta, slot, etc.)
      const fullTransactionObject = {
        transaction: rawTransaction.transaction,
        meta: rawTransaction.meta,
        slot: rawTransaction.slot,
        blockTime: rawTransaction.blockTime,
        version: version
      };
      let parseResult;
      try {
        // Temporarily suppress console.error during DexParser execution
        const originalConsoleError = console.error;
        console.error = () => {}; // Suppress all console.error calls
        
        try {
          parseResult = this.dexParser.parseAll(fullTransactionObject as any, this.getParseConfig());
        } finally {
          // Restore original console.error
          console.error = originalConsoleError;
        }
      } catch (parseError) {
          // Silently handle DexParser errors and continue processing
        // Return empty result but continue processing
        return {
          validTrades: [],
          invalidTrades: [],
          processingStats: {
            totalTrades: 0,
            validTrades: 0,
            invalidTrades: 0,
            memeEventsFound: 0
          }
        };
      }
      const trades = parseResult.trades || [];
      const memeEvents = parseResult.memeEvents || [];

      if (shouldLog) {
        console.log(`Found ${trades.length} trades and ${memeEvents.length} meme events`);
        if (memeEvents.length > 0) {
          console.log('🎯 memeEventsFound:', JSON.stringify(memeEvents, (key, value) => 
            typeof value === 'bigint' ? value.toString() : value, 2));
        }
      }

      const validTrades: Trade[] = [];
      const invalidTrades: any[] = [];

      if (trades.length > 0) {
        // Filter out trades where BOTH tokens are SOL (invalid trades)
        // Keep trades where one token is SOL and the other is a different mint (valid swaps)
        const filteredTrades = trades.filter((trade: any) => {
          const inputMint = trade.inputToken?.mint;
          const outputMint = trade.outputToken?.mint;
          // Only exclude if both are SOL or both are undefined/null
          return !(inputMint === this.SOL_MINT && outputMint === this.SOL_MINT);
        });
        
        if (shouldLog) {
          console.log(`🔍 Filtered ${trades.length - filteredTrades.length} trades (SOL-SOL pairs), keeping ${filteredTrades.length} trades`);
        }

        // Collect all available amounts and mints from all trades for fallback
        const allTradeData = filteredTrades.map((trade: any) => ({
          trade,
          inputAmountRaw: parseFloat(trade.inputToken?.amountRaw || '0'),
          outputAmountRaw: parseFloat(trade.outputToken?.amountRaw || '0'),
          inputMint: trade.inputToken?.mint,
          outputMint: trade.outputToken?.mint
        }));

        // Find trades with valid amounts to use as fallback
        const tradesWithAmounts = allTradeData.filter(data => 
          data.inputAmountRaw > 0 && data.outputAmountRaw > 0
        );

        // Process each trade individually
        for (let i = 0; i < filteredTrades.length; i++) {
          const trade = filteredTrades[i];
          const processedTrade = await this.processIndividualTrade(
            trade, 
            allTradeData, 
            tradesWithAmounts, 
            memeEvents, 
            rawTransaction,
            shouldLog
          );

          if (processedTrade.isValid && processedTrade.trade) {
            validTrades.push(processedTrade.trade);
            if (shouldLog) {
              console.log(`✅ Trade ${i + 1} is valid and will be saved:`, {
                mint: processedTrade.trade.mint,
                pool: processedTrade.trade.pool,
                avgPrice: processedTrade.trade.avgPrice,
                programId: processedTrade.trade.programId
              });
            }
          } else {
            invalidTrades.push({
              trade,
              reason: processedTrade.reason
            });
            if (shouldLog) {
              console.log(`❌ Trade ${i + 1} is invalid: ${processedTrade.reason}`);
            }
          }
        }
      }

      return {
        validTrades,
        invalidTrades,
        processingStats: {
          totalTrades: trades.length,
          validTrades: validTrades.length,
          invalidTrades: invalidTrades.length,
          memeEventsFound: memeEvents.length
        }
      };

    } catch (error) {
      console.error('Error processing transaction:', error);
      return {
        validTrades: [],
        invalidTrades: [],
        processingStats: {
          totalTrades: 0,
          validTrades: 0,
          invalidTrades: 0,
          memeEventsFound: 0
        }
      };
    }
  }

  /**
   * Process an individual trade and validate it
   */
  private async processIndividualTrade(
    trade: any,
    allTradeData: any[],
    tradesWithAmounts: any[],
    memeEvents: any[],
    rawTransaction: RawTransactionData,
    shouldLog: boolean
  ): Promise<{ isValid: boolean; trade?: Trade; reason?: string }> {
    try {
      let inputAmountRaw = parseFloat(trade.inputToken?.amountRaw || '0');
      let outputAmountRaw = parseFloat(trade.outputToken?.amountRaw || '0');
      
      // If this trade is missing amounts, try to use amounts from other trades in the same transaction
      if ((inputAmountRaw === 0 || outputAmountRaw === 0) && tradesWithAmounts.length > 0) {
        const fallbackTrade = tradesWithAmounts.find(data => 
          data.inputMint === trade.inputToken?.mint || 
          data.outputMint === trade.outputToken?.mint ||
          data.inputMint === trade.outputToken?.mint ||
          data.outputMint === trade.inputToken?.mint
        ) || tradesWithAmounts[0];
        
        if (fallbackTrade) {
          inputAmountRaw = inputAmountRaw || fallbackTrade.inputAmountRaw;
          outputAmountRaw = outputAmountRaw || fallbackTrade.outputAmountRaw;
        }
      }
      
      // Calculate avgPrice
      let avgPrice = 0;
      if (trade.type === 'BUY') {
        avgPrice = inputAmountRaw > 0 && outputAmountRaw > 0 ? inputAmountRaw / outputAmountRaw : 0;
      } else if (trade.type === 'SELL') {
        avgPrice = inputAmountRaw > 0 && outputAmountRaw > 0 ? outputAmountRaw / inputAmountRaw : 0;
      }
      
      // Fallback: Calculate avgPrice using pre/post balance changes if still 0
      if (avgPrice === 0 && rawTransaction.transaction) {
        avgPrice = this.calculateAvgPriceFromBalanceChanges(trade, rawTransaction, shouldLog);
      }
      
      // Extract pool information
      const poolId = this.extractPoolId(trade, memeEvents, shouldLog);
      
      // Extract mint
      let mint = trade.outputToken?.mint || trade.inputToken?.mint;
      if (!mint && allTradeData.length > 0) {
        const tradeWithMint = allTradeData.find(data => data.inputMint || data.outputMint);
        if (tradeWithMint) {
          mint = tradeWithMint.outputMint || tradeWithMint.inputMint;
        }
      }
      
      // Validate pool ID before creating trade
      if (!poolId || poolId === 'unknown') {
        return {
          isValid: false,
          reason: 'Pool ID is null or unknown'
        };
      }

      const processedTrade: Trade = {
        mint: mint || null,
        pool: poolId as string, // Type assertion since we validated it's not null
        avgPrice: avgPrice,
        programId: trade.programId || null,
        slot: trade.slot || rawTransaction.slot.toString()
      };
      
      // Validate the trade
      const validation = this.validateTrade(processedTrade);
      
      return {
        isValid: validation.isValid,
        trade: validation.isValid ? processedTrade : undefined,
        reason: validation.reason
      };
      
    } catch (error: any) {
      return {
        isValid: false,
        reason: `Processing error: ${error?.message || 'Unknown error'}`
      };
    }
  }

  /**
   * Calculate avgPrice using balance changes as fallback
   */
  private calculateAvgPriceFromBalanceChanges(trade: any, rawTransaction: RawTransactionData, shouldLog: boolean): number {
    try {
      const targetMint = trade.outputToken?.mint || trade.inputToken?.mint;
      
      if (!targetMint || targetMint === this.SOL_MINT) {
        return 0;
      }
      
      const txMeta = (rawTransaction.transaction as any).meta;
      const preBalances = txMeta?.preBalances || [];
      const postBalances = txMeta?.postBalances || [];
      const preTokenBalances = txMeta?.preTokenBalances || [];
      const postTokenBalances = txMeta?.postTokenBalances || [];
      
      // Find SOL balance changes
      let solChange = 0;
      for (let i = 0; i < preBalances.length && i < postBalances.length; i++) {
        const change = postBalances[i] - preBalances[i];
        if (Math.abs(change) > 1000000) { // Significant SOL change (> 0.001 SOL)
          solChange = Math.abs(change);
          break;
        }
      }
      
      // Find token balance changes for target mint
      let tokenChange = 0;
      const findTokenBalance = (balances: any[], mint: string) => {
        return balances.find(balance => 
          balance.mint === mint || 
          (balance.uiTokenAmount && balance.uiTokenAmount.mint === mint)
        );
      };
      
      const preTokenBalance = findTokenBalance(preTokenBalances, targetMint);
      const postTokenBalance = findTokenBalance(postTokenBalances, targetMint);
      
      if (preTokenBalance && postTokenBalance) {
        const preAmount = parseFloat(preTokenBalance.uiTokenAmount?.amount || '0');
        const postAmount = parseFloat(postTokenBalance.uiTokenAmount?.amount || '0');
        tokenChange = Math.abs(postAmount - preAmount);
      }
      
      // Calculate price from balance changes
      if (solChange > 0 && tokenChange > 0) {
        const avgPrice = solChange / tokenChange;
        if (shouldLog) {
          console.log(`Balance fallback: SOL change ${solChange}, Token change ${tokenChange}, Price ${avgPrice}`);
        }
        return avgPrice;
      }
      
      return 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Extract pool ID from trade or corresponding meme events
   */
  private extractPoolId(trade: any, memeEvents: any[], shouldLog: boolean = false): string | null {
    if (shouldLog) {
      console.log('🔍 extractPoolId - trade:', {
        signature: trade.signature,
        idx: trade.idx,
        user: trade.user,
        pool: trade.pool,
        Pool: trade.Pool,
        poolId: trade.poolId,
        inputToken: trade.inputToken?.mint,
        outputToken: trade.outputToken?.mint
      });
      console.log('🔍 extractPoolId - memeEvents count:', memeEvents.length);
    }
    
    // Try different pool extraction methods
    if (trade.pool && Array.isArray(trade.pool) && trade.pool.length > 0) {
      if (shouldLog) console.log('✅ Found pool from trade.pool:', trade.pool[0]);
      return trade.pool[0];
    } else if (trade.Pool && Array.isArray(trade.Pool) && trade.Pool.length > 0) {
      if (shouldLog) console.log('✅ Found pool from trade.Pool:', trade.Pool[0]);
      return trade.Pool[0];
    } else if (trade.poolId) {
      if (shouldLog) console.log('✅ Found pool from trade.poolId:', trade.poolId);
      return trade.poolId;
    }
    
    if (shouldLog) console.log('❌ No pool found in trade, checking meme events...');
    
    // Check if there's a corresponding meme event with bondingCurve
    if (memeEvents.length > 0) {
      // First try exact match by signature and idx
      let correspondingMemeEvent = memeEvents.find(event => 
        event.signature === trade.signature && 
        event.idx === trade.idx &&
        event.bondingCurve
      );
      
      if (shouldLog && correspondingMemeEvent) {
        console.log('✅ Found meme event by signature+idx match:', correspondingMemeEvent.bondingCurve);
      }
      
      // If no exact match, try to find by matching tokens and user
      if (!correspondingMemeEvent) {
        correspondingMemeEvent = memeEvents.find(event => 
          event.user === trade.user &&
          ((event.baseMint === trade.outputToken?.mint && event.quoteMint === trade.inputToken?.mint) ||
           (event.baseMint === trade.inputToken?.mint && event.quoteMint === trade.outputToken?.mint)) &&
          event.bondingCurve
        );
        
        if (shouldLog && correspondingMemeEvent) {
          console.log('✅ Found meme event by user+token match:', correspondingMemeEvent.bondingCurve);
        }
      }
      
      // If still no match, use any meme event with same user
      if (!correspondingMemeEvent) {
        correspondingMemeEvent = memeEvents.find(event => 
          event.user === trade.user &&
          event.bondingCurve
        );
        
        if (shouldLog && correspondingMemeEvent) {
          console.log('✅ Found meme event by user match:', correspondingMemeEvent.bondingCurve);
        }
      }
      
      if (correspondingMemeEvent) {
        return correspondingMemeEvent.bondingCurve;
      }
      
      if (shouldLog) {
        console.log('❌ No matching meme event found');
        memeEvents.forEach((event, i) => {
          console.log(`   MemeEvent ${i}:`, {
            signature: event.signature,
            idx: event.idx,
            user: event.user,
            bondingCurve: event.bondingCurve,
            baseMint: event.baseMint,
            quoteMint: event.quoteMint
          });
        });
      }
    }
    
    return null;
  }

  /**
   * Validate a processed trade
   */
  private validateTrade(trade: Trade): { isValid: boolean; reason?: string } {
    // Get allowed program IDs from builder registry (dynamic whitelist)
    const allowedProgramIds = this.builderRegistry.getSupportedProgramIds();
    
    // Check essential fields
    if (!trade.mint) {
      return { isValid: false, reason: 'Missing mint' };
    }
    
    if (!trade.pool) {
      return { isValid: false, reason: 'Missing pool' };
    }
    
    if (trade.avgPrice <= 0) {
      return { isValid: false, reason: 'Invalid avgPrice (≤ 0)' };
    }
    
    if (!trade.programId) {
      return { isValid: false, reason: 'Missing programId' };
    }
    
    if (!trade.slot) {
      return { isValid: false, reason: 'Missing slot' };
    }
    
    // Check for 'unknown' values
    if (trade.mint === 'unknown') {
      return { isValid: false, reason: 'Mint is unknown' };
    }
    
    if (trade.pool === 'unknown') {
      return { isValid: false, reason: 'Pool is unknown' };
    }
    
    if (trade.programId === 'unknown') {
      return { isValid: false, reason: 'ProgramId is unknown' };
    }
    
    // Check if program ID is whitelisted
    if (!allowedProgramIds.includes(trade.programId)) {
      return { isValid: false, reason: `ProgramId ${trade.programId} not whitelisted` };
    }
    
    return { isValid: true };
  }
}