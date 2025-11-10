import dotenv from 'dotenv';
import { TransactionStreamer } from './TransactionStreamer';
import { TradeMemoryManager, TradeMemoryConfig } from './MemoryManager';
import { RawTransactionData, Trade } from './types';
import { TerminalMonitor } from './monitor';
import { startApiServer } from './api';
import { getTransactionBuilderRegistry } from './builders/TransactionBuilderRegistry';
import { UnifiedTradeProcessor } from './UnifiedTradeProcessor';
import { Connection } from '@solana/web3.js';
import { SolanaTrade } from './builders/solana-trade/src';
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

// Function to get trade by mint with real-time pricing
export async function getTradeForMint(mint: string): Promise<Trade | undefined> {
  const storedTrade = tradeMemoryManager.getTrade(mint);
  
  if (storedTrade) {
    // Get real-time price using SolanaTrade
    try {
      const solanaTrade = new SolanaTrade(process.env.RPC_URL);
      
      // Use the program ID from stored trade to determine the correct market
      const market = builderRegistry.getMarketForProgramId(storedTrade.programId);
      
      if (market) {
        const priceData = await solanaTrade.price({
          market,
          mint,
          unit: 'SOL'
        });
        
        if (priceData.price > 0) {
          // Return trade with real-time price only if successful
          return {
            mint: storedTrade.mint,
            pool: storedTrade.pool,
            avgPrice: priceData.price,
            programId: storedTrade.programId,
            slot: storedTrade.slot
          };
        } else {
          // Price is 0 or invalid, fall back to Jupiter
          console.warn(`Real-time price is 0 or invalid for mint ${mint}, falling back to Jupiter`);
        }
      } else {
        console.warn(`No market mapping found for program ID: ${storedTrade.programId}, falling back to Jupiter`);
      }
    } catch (error) {
      console.error(`Failed to fetch real-time price for mint ${mint}:`, error);
      console.log(`Falling back to Jupiter API for mint ${mint}`);
    }
  }
  
  // If no local trade found OR real-time pricing failed, try Jupiter API as fallback
  try {
    const jupiterTrade = await fetchTradeFromJupiter(mint);
    if (jupiterTrade) {
      // Store the trade in memory for future use
      tradeMemoryManager.addTrade(jupiterTrade);
      return jupiterTrade;
    }
  } catch (error) {
    console.error(`Failed to fetch trade from Jupiter for mint ${mint}:`, error);
  }
  
  // If Jupiter also fails and we have a stored trade, return it with original price as last resort
  if (storedTrade) {
    console.log(`Returning stored trade with original price for mint ${mint} as last resort`);
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
// Helper function to fetch buy trade data from Jupiter API (SOL -> Token only)
async function fetchTradeFromJupiter(mint: string): Promise<Trade | undefined> {
  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const amount = 1000000; // 1 SOL (9 decimals = 1e9, so 1e6 = 0.001 SOL)
    const slippage = 1;
    
    // Only fetch buy direction: SOL -> Token
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amount}&slippage=${slippage}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      return undefined;
    }
    
    const data = await response.json();
    
    if (!data || !data.inAmount || !data.outAmount || !data.routePlan || data.routePlan.length === 0) {
      return undefined;
    }
    
    // Skip multi-hop swaps
    if (data.routePlan.length > 1) {
      console.log(`Skipping multi-hop swap with ${data.routePlan.length} route plan items for mint ${mint}`);
      return undefined;
    }
    
    const route = data.routePlan[0];
    const swapInfo = route.swapInfo;
    
    // Calculate price (SOL per token) for buy direction
    const solAmount = parseFloat(data.inAmount) / 1e9; // Convert lamports to SOL
    const tokenAmount = parseFloat(data.outAmount); // Keep in native token units
    const avgPrice = solAmount / tokenAmount; // SOL per token (accounting for token decimals)
    
    // Extract program ID from the route
    let programId = 'unknown';
    if (swapInfo.label) {
      // Map Jupiter labels to program IDs
      const labelToProgramId: Record<string, string> = {
        "GoonFi": "goonERTdGsjnkZqWuVjs73BZ3Pb9qoCUdBUL17BnS5j",
        "Bonkswap": "BSwp6bEBihVLdqJRKGgzjcGLHkcTuzmSo1TQkHepzH8p",
        "StepN": "Dooar9JkhdZ7J3LHN3A7YCuoGRUggXhQaG4kijfLGU2j",
        "Stabble Stable Swap": "swapNyd8XiQwJ6ianp9snpu4brUqFxadzvHebnAXjJZ",
        "Sanctum": "stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq",
        "Whirlpool": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        "Meteora DAMM v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
        "Solayer": "endoLNCKTqDn8gSVnN2hDdpgACUPWHZTwoYnnMybpAT",
        "OpenBook V2": "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",
        "Cropper": "H8W3ctz92svYg6mkn1UtGfu2aQr2fnUFHM1RhScEtQDt",
        "Phoenix": "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
        "SolFi": "SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe",
        "Pump.fun Amm": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
        "Helium Network": "treaf4wWBBty3fHdyBpo35Mz84M8k3heKXmjmi9vFt5",
        "Raydium CP": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
        "Perps": "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu",
        "Raydium": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        "Byreal": "REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2",
        "Invariant": "HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt",
        "DexLab": "DSwpgjMvXhtGn6BsbqmacdBZyfLj6jSWf3HJpdJtmg6N",
        "Perena": "NUMERUNsFCP3kuNmWZuXtm1AaQCPj9uw6Guv2Ekoi5P",
        "Crema": "CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR",
        "Penguin": "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP",
        "Token Swap": "SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8",
        "Saber": "SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ",
        "Woofi": "WooFif76YGRNjk1pA8wCsN67aQsD9f9iLsz4NcJ1AVb",
        "Meteora DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
        "SolFi V2": "SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF",
        "Mercurial": "MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky",
        "Gavel": "srAMMzfVHVAtgSJc8iH6CfKzuWuUTzLHVCE81QU1rgi",
        "Obric V2": "obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y",
        "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        "ZeroFi": "ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY",
        "FluxBeam": "FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X",
        "Raydium CLMM": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        "Boop.fun": "boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4",
        "Orca V2": "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
        "Orca V1": "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",
        "Meteora": "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
        "Aquifer": "AQU1FRd7papthgdrwPTTq5JacJh8YtwEXaBfKU3bTz45",
        "1DEX": "DEXYosS6oEGvk8uCDayvwEZz4qEyDJRf9nFgYCaqPMTm",
        "Saber (Decimals)": "DecZY86MU5Gj7kppfUCEmd4LbXXuyZH1yHaP2NTqdiZB",
        "Moonit": "MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG",
        "Saros": "SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr",
        "Raydium Launchlab": "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
        "Dynamic Bonding Curve": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
        "Sanctum Infinity": "5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx",
        "TesseraV": "TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH",
        "HumidiFi": "9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp",
        "Stabble Weighted Swap": "swapFpHZwjELNnjvThjajtiVmkz3yPQEHjLtka2fwHW",
        "Aldrin": "AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6",
        "PancakeSwap": "HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq",
        "Guacswap": "Gswppe6ERWKpUTXvRPfXdzHhiCyJvLadVvXGfdpBqcE1",
        "Lifinity V2": "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c",
        "Virtuals": "5U3EU2ubXtK84QcRjWVmYt9RaDyA8gKxdUrPFXmZyaki",
        "GooseFX GAMMA": "GAMMA7meSFWaBXF25oSUgmGRwaW6sCMFLmBNiMSdbHVT",
        "Heaven": "HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o",
        "Aldrin V2": "CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4"
      };
      
      const mappedProgramId = labelToProgramId[swapInfo.label];
      
      // Only use the program ID if it's supported by our transaction builders
      if (mappedProgramId && builderRegistry.hasBuilder(mappedProgramId)) {
        programId = mappedProgramId;
      }
    }
    
    const trade: Trade = {
      mint: mint,
      pool: swapInfo.ammKey,
      avgPrice: avgPrice,
      programId: programId,
      slot: data.contextSlot?.toString() || Date.now().toString()
    };
    
    return trade;
    
  } catch (error) {
    console.error('Error in fetchBuyTradeFromJupiter:', error);
    return undefined;
  }
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