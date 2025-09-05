const { Connection } = require('@solana/web3.js');
const { UnifiedTradeProcessor } = require('./dist/UnifiedTradeProcessor');
const { TradeMemoryManager } = require('./dist/MemoryManager');

console.log('🚀 Starting debug script...');
console.log('Modules loaded successfully');

// Transaction signature to debug
const TRANSACTION_SIGNATURE = '6eQnBjkkQA9nTrEDysntduczNnZxvdTqTqYaueSbWby7x1NwG9Ja4vF4a6wPDgg2aNHrA1tTjHTA12vkk6ea9cd';

async function debugTransaction() {
  try {
    console.log('🔍 Debugging transaction:', TRANSACTION_SIGNATURE);
    
    // Initialize connection and memory manager
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    const processor = new UnifiedTradeProcessor(connection);
    const memoryManager = new TradeMemoryManager({ maxMemoryMB: 100 });
    
    // Fetch transaction
    console.log('📡 Fetching transaction data...');
    const transaction = await connection.getTransaction(TRANSACTION_SIGNATURE, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    
    if (!transaction) {
      console.log('❌ Transaction not found');
      return;
    }
    
    console.log('✅ Transaction fetched successfully');
    console.log('Transaction details:');
    console.log('- Slot:', transaction.slot);
    console.log('- Block Time:', transaction.blockTime);
    console.log('- Meta:', transaction.meta ? 'Present' : 'Missing');
    console.log('- Transaction structure:', Object.keys(transaction.transaction));
    console.log('- Message structure:', transaction.transaction.message ? Object.keys(transaction.transaction.message) : 'No message');
    
    if (transaction.transaction.message && transaction.transaction.message.instructions) {
      console.log('- Instructions count:', transaction.transaction.message.instructions.length);
    } else if (transaction.transaction.message && transaction.transaction.message.compiledInstructions) {
      console.log('- Compiled Instructions count:', transaction.transaction.message.compiledInstructions.length);
    } else {
      console.log('- Instructions: Not found in expected format');
    }
    
    // Create raw transaction data structure
    const rawTransaction = {
      signature: TRANSACTION_SIGNATURE,
      transaction: transaction.transaction,
      meta: transaction.meta,
      slot: transaction.slot,
      blockTime: transaction.blockTime
    };
    
    console.log('\n🔄 Processing with UnifiedTradeProcessor...');
    
    // Process with detailed logging
    const result = await processor.processTransaction(rawTransaction, true);
    
    console.log('\n📊 Processing Results:');
    console.log('- Valid trades:', result.validTrades.length);
    console.log('- Invalid trades:', result.invalidTrades.length);
    console.log('- Total trades found:', result.processingStats.totalTrades);
    console.log('- Meme events found:', result.processingStats.memeEventsFound);
    
    if (result.invalidTrades.length > 0) {
      console.log('\n❌ Invalid trades reasons:');
      result.invalidTrades.forEach((invalid, i) => {
        console.log(`  ${i + 1}. ${invalid.reason}`);
      });
    }
    
    if (result.validTrades.length > 0) {
      console.log('\n✅ Valid trades:');
      result.validTrades.forEach((trade, i) => {
        console.log(`  ${i + 1}. Mint: ${trade.mint}, Pool: ${trade.pool}, Price: ${trade.avgPrice}, Program: ${trade.programId}`);
        
        // Store the trade in memory manager
        memoryManager.addTrade(trade);
        console.log(`    ✅ Trade stored in memory manager`);
      });
      
      // Show memory stats after storing
      const memoryStats = memoryManager.getMemoryStats();
      console.log('\n📊 Memory Manager Stats:');
      console.log(`- Total trades stored: ${memoryStats.totalTrades}`);
      console.log(`- Memory usage: ${(memoryStats.currentMemoryUsage / 1024).toFixed(2)} KB`);
      
      // Verify we can retrieve the stored trade
      const storedTrade = memoryManager.getTrade(result.validTrades[0].mint);
      if (storedTrade) {
        console.log('\n🔍 Retrieved stored trade:');
        console.log(`- Mint: ${storedTrade.mint}`);
        console.log(`- Pool: ${storedTrade.pool}`);
        console.log(`- Price: ${storedTrade.avgPrice}`);
        console.log(`- Stored at: ${new Date(storedTrade.timestamp).toISOString()}`);
      }
    }
    
    if (result.processingStats.totalTrades === 0) {
      console.log('\n🤔 No trades detected by DexParser. Possible reasons:');
      console.log('- Transaction may not contain supported DEX operations');
      console.log('- Transaction may be a different type (transfer, stake, etc.)');
      console.log('- DexParser may not support this specific program/protocol');
    }
    
  } catch (error) {
    console.error('💥 Error debugging transaction:', error);
  }
}

// Run the debug
debugTransaction();