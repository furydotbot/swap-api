import { Trade } from './types';

export interface TradeMemoryConfig {
  maxMemoryMB: number; // Maximum RAM usage in megabytes
  cleanupThreshold?: number; // Cleanup when memory usage reaches this percentage (default: 0.9)
}

export interface StoredTrade extends Trade {
  timestamp: number; // When this trade was stored
  accessTime: number; // Last time this trade was accessed (for LRU)
}

export interface MemoryStats {
  currentMemoryUsage: number; // Current memory usage in bytes
  maxMemoryLimit: number; // Maximum memory limit in bytes
  totalTrades: number; // Total number of stored trades
  memoryUsagePercentage: number; // Current usage as percentage of limit
  oldestTradeAge: number; // Age of oldest trade in milliseconds
  newestTradeAge: number; // Age of newest trade in milliseconds
}

export class TradeMemoryManager {
  private trades: Map<string, StoredTrade> = new Map();
  private accessOrder: string[] = []; // For LRU tracking
  private config: Required<TradeMemoryConfig>;
  private estimatedBytesPerTrade: number = 400; // Estimated memory per trade object
  
  constructor(config: TradeMemoryConfig) {
    this.config = {
      maxMemoryMB: config.maxMemoryMB,
      cleanupThreshold: config.cleanupThreshold ?? 0.9
    };
    
    console.log(`TradeMemoryManager initialized with ${config.maxMemoryMB}MB limit`);
  }

  /**
   * Add or update a trade for a specific mint
   */
  addTrade(trade: Trade): void {
    const now = Date.now();
    const mint = trade.mint;
    
    // Create stored trade with timestamps
    const storedTrade: StoredTrade = {
      ...trade,
      timestamp: now,
      accessTime: now
    };
    
    // If mint already exists, remove from access order
    if (this.trades.has(mint)) {
      this.removeFromAccessOrder(mint);
    }
    
    // Add/update trade
    this.trades.set(mint, storedTrade);
    this.accessOrder.push(mint);
    
    // Check if cleanup is needed
    if (this.shouldCleanup()) {
      this.performCleanup();
    }
  }

  /**
   * Get trade for a specific mint
   */
  getTrade(mint: string): StoredTrade | undefined {
    const trade = this.trades.get(mint);
    
    if (trade) {
      // Update access time for LRU
      trade.accessTime = Date.now();
      
      // Move to end of access order (most recently used)
      this.removeFromAccessOrder(mint);
      this.accessOrder.push(mint);
    }
    
    return trade;
  }

  /**
   * Get all trades (returns a copy to prevent external modification)
   */
  getAllTrades(): Map<string, StoredTrade> {
    // Update access times for all trades
    const now = Date.now();
    const allTrades = new Map<string, StoredTrade>();
    
    for (const [mint, trade] of this.trades) {
      allTrades.set(mint, {
        ...trade,
        accessTime: now
      });
    }
    
    return allTrades;
  }

  /**
   * Remove a specific trade by mint
   */
  removeTrade(mint: string): boolean {
    if (this.trades.has(mint)) {
      this.trades.delete(mint);
      this.removeFromAccessOrder(mint);
      return true;
    }
    return false;
  }

  /**
   * Get current memory statistics
   */
  getMemoryStats(): MemoryStats {
    const currentMemoryUsage = this.getCurrentMemoryUsage();
    const maxMemoryLimit = this.config.maxMemoryMB * 1024 * 1024; // Convert MB to bytes
    const totalTrades = this.trades.size;
    const memoryUsagePercentage = (currentMemoryUsage / maxMemoryLimit) * 100;
    
    // Calculate trade ages
    const now = Date.now();
    let oldestTradeAge = 0;
    let newestTradeAge = 0;
    
    if (totalTrades > 0) {
      const timestamps = Array.from(this.trades.values()).map(t => t.timestamp);
      const oldestTimestamp = Math.min(...timestamps);
      const newestTimestamp = Math.max(...timestamps);
      
      oldestTradeAge = now - oldestTimestamp;
      newestTradeAge = now - newestTimestamp;
    }
    
    return {
      currentMemoryUsage,
      maxMemoryLimit,
      totalTrades,
      memoryUsagePercentage,
      oldestTradeAge,
      newestTradeAge
    };
  }

  /**
   * Force cleanup of old trades
   */
  forceCleanup(targetPercentage: number = 0.7): number {
    const initialCount = this.trades.size;
    const targetMemory = this.config.maxMemoryMB * 1024 * 1024 * targetPercentage;
    
    let removedCount = 0;
    
    // Remove trades starting from least recently used
    while (this.getCurrentMemoryUsage() > targetMemory && this.accessOrder.length > 0) {
      const oldestMint = this.accessOrder.shift()!;
      if (this.trades.has(oldestMint)) {
        this.trades.delete(oldestMint);
        removedCount++;
      }
    }
    
    console.log(`Forced cleanup: removed ${removedCount}/${initialCount} trades`);
    return removedCount;
  }

  /**
   * Clear all trades
   */
  clearAll(): void {
    const count = this.trades.size;
    this.trades.clear();
    this.accessOrder.length = 0;
    console.log(`Cleared all ${count} trades from memory`);
  }

  /**
   * Get trades sorted by various criteria
   */
  getTradesSorted(sortBy: 'timestamp' | 'accessTime' | 'avgPrice' | 'slot', order: 'asc' | 'desc' = 'desc'): StoredTrade[] {
    const trades = Array.from(this.trades.values());
    
    trades.sort((a, b) => {
      let aVal: number, bVal: number;
      
      switch (sortBy) {
        case 'timestamp':
          aVal = a.timestamp;
          bVal = b.timestamp;
          break;
        case 'accessTime':
          aVal = a.accessTime;
          bVal = b.accessTime;
          break;
        case 'avgPrice':
          aVal = a.avgPrice;
          bVal = b.avgPrice;
          break;
        case 'slot':
          aVal = parseInt(a.slot);
          bVal = parseInt(b.slot);
          break;
      }
      
      return order === 'asc' ? aVal - bVal : bVal - aVal;
    });
    
    return trades;
  }

  // Private methods

  private getCurrentMemoryUsage(): number {
    // Estimate memory usage: number of trades * estimated bytes per trade
    // Plus Map overhead (roughly 24 bytes per entry)
    const tradeMemory = this.trades.size * this.estimatedBytesPerTrade;
    const mapOverhead = this.trades.size * 24;
    const accessOrderOverhead = this.accessOrder.length * 50; // String references
    
    return tradeMemory + mapOverhead + accessOrderOverhead;
  }

  private shouldCleanup(): boolean {
    const currentUsage = this.getCurrentMemoryUsage();
    const maxUsage = this.config.maxMemoryMB * 1024 * 1024;
    const thresholdUsage = maxUsage * this.config.cleanupThreshold;
    
    return currentUsage > thresholdUsage;
  }

  private performCleanup(): void {
    const initialCount = this.trades.size;
    const targetMemory = this.config.maxMemoryMB * 1024 * 1024 * 0.7; // Target 70% usage after cleanup
    
    let removedCount = 0;
    
    // Remove oldest trades (LRU eviction)
    while (this.getCurrentMemoryUsage() > targetMemory && this.accessOrder.length > 0) {
      const oldestMint = this.accessOrder.shift()!;
      if (this.trades.has(oldestMint)) {
        this.trades.delete(oldestMint);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      console.log(`Auto cleanup: removed ${removedCount}/${initialCount} trades (${((removedCount/initialCount)*100).toFixed(1)}%)`);
    }
  }

  private removeFromAccessOrder(mint: string): void {
    const index = this.accessOrder.indexOf(mint);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }
}