import dotenv from 'dotenv';
import { TransactionStreamer } from './TransactionStreamer';
import { TradeMemoryManager, TradeMemoryConfig } from './MemoryManager';
import { RawTransactionData, Trade } from './types';
import { TerminalMonitor } from './monitor';
import { startApiServer } from './api';
import { getTransactionBuilderRegistry } from './builders/TransactionBuilderRegistry';
import { UnifiedTradeProcessor } from './UnifiedTradeProcessor';
import { Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

// Initialize connection for getting program IDs
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com');
const builderRegistry = getTransactionBuilderRegistry(connection);

// Get all supported program IDs from registered builders
const ACCOUNTS_TO_WATCH = builderRegistry.getSupportedProgramIds();

// Configuration for the streamer
const config = {
  provider: (process.env.STREAMING_PROVIDER as 'grpc' | 'helius') || 'grpc',
  grpcEndpoint: process.env.GRPC_ENDPOINT || "", // gRPC endpoint
  grpcToken: process.env.GRPC_TOKEN || "", // gRPC x-token
  heliusApiKey: process.env.HELIUS_API_KEY,
  heliusEndpoint: process.env.HELIUS_ENDPOINT,
  commitment: process.env.COMMITMENT as 'processed' | 'confirmed' | 'finalized',
  accountToWatch: ACCOUNTS_TO_WATCH,
};

// Memory management configuration
const memoryConfig: TradeMemoryConfig = {
  maxMemoryMB: parseInt(process.env.MAX_MEMORY_MB || '1000'), // Maximum RAM usage in MB
  cleanupThreshold: parseFloat(process.env.CLEANUP_THRESHOLD || '0.85') // Start cleanup when threshold reached
};

// Initialize components
const streamer = new TransactionStreamer(config);
const tradeMemoryManager = new TradeMemoryManager(memoryConfig);
const unifiedTradeProcessor = new UnifiedTradeProcessor(connection);

// Stats tracking
let startTime = Date.now();

// Terminal monitor
let monitor: TerminalMonitor | null = null;

// Add listener for raw transactions with comprehensive parsing
streamer.addRawTransactionListener(async (rawTransaction: RawTransactionData) => {
  try {
    // Debug wallet address to filter transactions
    const DEBUG_WALLET = '67mhTQJ6UN4psPtZ12TrFfWWYQepHvnVEtGBVevWVRfU';
    
    // Check if transaction involves the debug wallet
    const accountKeys = rawTransaction.transaction?.message?.accountKeys || [];
    const isDebugWalletTransaction = accountKeys.some((key: any) => 
      typeof key === 'string' ? key === DEBUG_WALLET : key.pubkey === DEBUG_WALLET
    );
    
    
    // Only log transactions involving the debug wallet
    const shouldLog = isDebugWalletTransaction;
    
    if (shouldLog) {
      console.log(`\n🔍 Processing transaction from debug wallet: ${rawTransaction.signature}`);
      console.log(`Account keys:`, accountKeys);
    }
    
    // Process transaction using unified trade processor
    const result = await unifiedTradeProcessor.processTransaction(rawTransaction, shouldLog);
    
    if (result.validTrades.length === 0) {
      if (shouldLog && result.processingStats.totalTrades > 0) {
        console.log(`No valid trades found in transaction ${rawTransaction.signature}`);
        console.log('Processing stats:', result.processingStats);
        result.invalidTrades.forEach((invalid, i) => {
          console.log(`  Invalid trade ${i + 1}: ${invalid.reason}`);
        });
      }
      return;
    }
    
    // Store valid trades in memory manager
    result.validTrades.forEach(trade => {
      tradeMemoryManager.addTrade(trade);
      
      // Log trade if should log (for debugging)
      if (shouldLog) {
        console.log('New trade stored:', {
          mint: trade.mint,
          pool: trade.pool,
          avgPrice: trade.avgPrice,
          programId: trade.programId,
          slot: trade.slot
        });
      }
    });
    
    if (shouldLog) {
      console.log(`✅ Saved ${result.validTrades.length} valid trades from transaction ${rawTransaction.signature}`);
      console.log('Processing stats:', result.processingStats);
    }
    
    // Update monitor data
    if (monitor) {
      monitor.updateData({
        startTime,
        streamer,
        tradeMemoryManager,
        memoryConfig,
        accountsToWatch: ACCOUNTS_TO_WATCH
      });
    }
    
  } catch (error) {
    if (monitor) {
      console.log(`⚠️ Error parsing transaction: ${error}`);
      console.log(`Transaction signature: ${rawTransaction.signature}`);
    } else {
      console.error('⚠️ Error parsing transaction:', error);
      console.error('Transaction signature:', rawTransaction.signature);
    }
  }
});

// Function to get trade by mint
export function getTradeForMint(mint: string): Trade | undefined {
  const storedTrade = tradeMemoryManager.getTrade(mint);
  if (storedTrade) {
    // Return only the Trade properties, excluding timestamp and accessTime
    return {
      mint: storedTrade.mint,
      pool: storedTrade.pool,
      avgPrice: storedTrade.avgPrice,
      programId: storedTrade.programId,
      slot: storedTrade.slot
    };
  }
  return undefined;
}

// Function to get all trades
export function getAllTrades(): Map<string, Trade> {
  const allStoredTrades = tradeMemoryManager.getAllTrades();
  const result = new Map<string, Trade>();
  
  for (const [mint, storedTrade] of allStoredTrades) {
    result.set(mint, {
      mint: storedTrade.mint,
      pool: storedTrade.pool,
      avgPrice: storedTrade.avgPrice,
      programId: storedTrade.programId,
      slot: storedTrade.slot
    });
  }
  
  return result;
}

// Function to get memory statistics
export function getMemoryStats() {
  return tradeMemoryManager.getMemoryStats();
}

// Function to get trade statistics by programId
export function getTradeStatsByProgramId(): Record<string, { count: number; avgPrice: number; totalVolume: number; mints: string[] }> {
  const allTrades = getAllTrades();
  const statsByProgramId: Record<string, { count: number; totalPrice: number; avgPrice: number; totalVolume: number; mints: string[] }> = {};
  
  for (const [mint, trade] of allTrades) {
    const programId = trade.programId;
    
    if (!statsByProgramId[programId]) {
      statsByProgramId[programId] = {
        count: 0,
        totalPrice: 0,
        avgPrice: 0,
        totalVolume: 0,
        mints: []
      };
    }
    
    statsByProgramId[programId].count++;
    statsByProgramId[programId].totalPrice += trade.avgPrice;
    statsByProgramId[programId].totalVolume += trade.avgPrice; // Using avgPrice as volume proxy
    statsByProgramId[programId].mints.push(mint);
  }
  
  // Calculate average prices
  for (const programId in statsByProgramId) {
    const stats = statsByProgramId[programId];
    stats.avgPrice = stats.count > 0 ? stats.totalPrice / stats.count : 0;
    // Remove totalPrice from the final result
    delete (stats as any).totalPrice;
  }
  
  return statsByProgramId;
}

// Function to force cleanup
export function forceCleanup(targetPercentage: number = 0.7): number {
  return tradeMemoryManager.forceCleanup(targetPercentage);
}

// Start streaming
async function startStreaming(enableMonitor: boolean = true) {
  try {
    console.log('🚀 Starting Fury Swap API...');
    console.log('📡 Monitoring accounts:');
    ACCOUNTS_TO_WATCH.forEach((account, index) => {
      console.log(`   ${index + 1}. ${account}`);
    });
    
    console.log(`\n💾 Memory Management: ${memoryConfig.maxMemoryMB}MB limit, cleanup at ${(memoryConfig.cleanupThreshold! * 100).toFixed(0)}%`);
    
    // Start API server
    console.log('\n🌐 Starting API server...');
    startApiServer();
    
    console.log(`\n🔌 Connecting to ${config.provider.toUpperCase()}...`);
    
    await streamer.connect();
    console.log('✅ Transaction streaming started successfully!');
    
    if (enableMonitor) {
      console.log('\n🖥️  Starting terminal monitor...');
      
      // Initialize terminal monitor
      monitor = new TerminalMonitor({
        startTime,
        streamer,
        tradeMemoryManager,
        memoryConfig,
        accountsToWatch: ACCOUNTS_TO_WATCH
      });
        
      // Start the terminal monitor
      monitor.start();
    } else {
      console.log('\n📊 Terminal monitor disabled (--monitor false)');
      console.log('🔄 Application running in headless mode...');
    }
    
  } catch (error) {
    console.error('❌ Failed to start transaction streaming:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  if (monitor) {
    console.log('🛑 Shutting down gracefully...');
    
    // Log final stats
    const finalStats = tradeMemoryManager.getMemoryStats();
    console.log(`📊 Final Stats: ${finalStats.totalTrades} trades stored, ${(finalStats.currentMemoryUsage / 1024 / 1024).toFixed(2)}MB used`);
    
    // Stop monitor first
    monitor.stop();
  }
  
  await streamer.disconnect();
  tradeMemoryManager.clearAll();
  
  console.log('✅ Disconnected successfully');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (monitor) {
    console.log('🛑 Received SIGTERM, shutting down...');
    monitor.stop();
  }
  
  await streamer.disconnect();
  tradeMemoryManager.clearAll();
  console.log('✅ Disconnected successfully');
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const errorMsg = `Unhandled Rejection: ${reason}`;
  if (monitor) {
    console.log(`⚠️ ${errorMsg}`);
  } else {
    console.error(errorMsg);
  }
  // Don't exit the process, just log the error
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  const errorMsg = `Uncaught Exception: ${error.message}`;
  if (monitor) {
    console.log(`❌ ${errorMsg}`);
    monitor.stop();
  } else {
    console.error(errorMsg);
  }
  
  // Exit gracefully
  streamer.disconnect().then(() => {
    tradeMemoryManager.clearAll();
    process.exit(1);
  });
});

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options: { snapshot?: string; monitor?: boolean } = { monitor: true }; // Default to true
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && i + 1 < args.length) {
      options.snapshot = args[i + 1];
      i++; // Skip the next argument as it's the value
    } else if (args[i] === '--monitor' && i + 1 < args.length) {
      options.monitor = args[i + 1].toLowerCase() !== 'false';
      i++; // Skip the next argument as it's the value
    }
  }
  
  return options;
}

// Load snapshot from file or URL
async function loadSnapshot(snapshotPath: string): Promise<void> {
  try {
    console.log(`📥 Loading snapshot from: ${snapshotPath}`);
    
    let tradesData: any;
    
    if (snapshotPath.startsWith('http://') || snapshotPath.startsWith('https://')) {
      // Load from URL
      console.log('🌐 Fetching trades from URL...');
      const response = await fetch(snapshotPath);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      tradesData = await response.json();
    } else {
      // Load from file
      console.log('📁 Loading trades from file...');
      const absolutePath = path.resolve(snapshotPath);
      
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`File not found: ${absolutePath}`);
      }
      
      const fileContent = fs.readFileSync(absolutePath, 'utf8');
      tradesData = JSON.parse(fileContent);
    }
    
    // Load trades into memory
     if (tradesData && typeof tradesData === 'object') {
       let loadedCount = 0;
       
       // Handle different response formats
       if (Array.isArray(tradesData)) {
         // Array format
          for (const trade of tradesData) {
            if (trade.mint) {
              tradeMemoryManager.addTrade(trade);
              loadedCount++;
            }
          }
       } else if (tradesData.data && typeof tradesData.data === 'object') {
         // API response format with data property
          for (const [mint, trade] of Object.entries(tradesData.data)) {
            tradeMemoryManager.addTrade(trade as Trade);
            loadedCount++;
          }
       } else if (tradesData.trades && typeof tradesData.trades === 'object') {
         // Object format with trades property
          for (const [mint, trade] of Object.entries(tradesData.trades)) {
            tradeMemoryManager.addTrade(trade as Trade);
            loadedCount++;
          }
       } else {
         // Direct object format (mint -> trade mapping)
          for (const [mint, trade] of Object.entries(tradesData)) {
            if (typeof trade === 'object' && trade !== null && (trade as any).mint) {
              tradeMemoryManager.addTrade(trade as Trade);
              loadedCount++;
            }
          }
       }
      
      console.log(`✅ Successfully loaded ${loadedCount} trades from snapshot`);
      
      // Show memory stats after loading
      const stats = tradeMemoryManager.getMemoryStats();
      console.log(`💾 Memory usage: ${(stats.currentMemoryUsage / 1024 / 1024).toFixed(2)}MB / ${stats.maxMemoryLimit / 1024 / 1024}MB (${stats.memoryUsagePercentage.toFixed(1)}%)`);
    } else {
      console.log('⚠️ No valid trade data found in snapshot');
    }
    
  } catch (error) {
    console.error(`❌ Failed to load snapshot: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

// Main startup function
async function main() {
  const options = parseArgs();
  
  // Load snapshot if provided
  if (options.snapshot) {
    await loadSnapshot(options.snapshot);
  }
  
  // Start streaming
  await startStreaming(options.monitor);
}

// Start the application
main().catch((error) => {
  console.error('❌ Failed to start application:', error);
  process.exit(1);
});

// Export for potential use as a module
export { 
  streamer, 
  tradeMemoryManager, 
  ACCOUNTS_TO_WATCH,
  connection,
};