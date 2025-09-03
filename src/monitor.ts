import blessed from 'blessed';
import { TransactionStreamer } from './TransactionStreamer';
import { TradeMemoryManager } from './MemoryManager';

interface MonitorData {
  startTime: number;
  streamer: TransactionStreamer;
  tradeMemoryManager: TradeMemoryManager;
  memoryConfig: any;
  accountsToWatch: string[];
}

export class TerminalMonitor {
  private screen: any;
  private headerBox: any;
  private statsBox: any;
  private memoryBox: any;
  private processBox: any;

  private statusBar: any;
  
  private data: MonitorData;
  private updateInterval: NodeJS.Timeout | null = null;
  
  constructor(data: MonitorData) {
    this.data = data;
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Fury Swap API'
    });
    
    this.createUI();
    this.setupEventHandlers();
  }
  
  private createUI() {
    // Header box
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 4,
      content: '',
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'cyan',
        border: {
          fg: 'cyan'
        }
      }
    });
    
    // Main stats grid (2x2)
    this.statsBox = blessed.box({
      top: 4,
      left: 0,
      width: '50%',
      height: 8,
      content: '',
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        border: {
          fg: 'yellow'
        }
      },
      label: ' System Overview '
    });
    
    this.memoryBox = blessed.box({
      top: 4,
      left: 0,
      width: '50%',
      height: 8,
      content: '',
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        border: {
          fg: 'magenta'
        }
      },
      label: ' Memory Usage '
    });
    
    this.processBox = blessed.box({
      top: 4,
      left: '50%',
      width: '50%',
      height: 8,
      content: '',
      tags: true,
      border: {
        type: 'line'
      },
      style: {
        fg: 'white',
        border: {
          fg: 'blue'
        }
      },
      label: ' Process Memory '
    });
    
    // Status bar
    this.statusBar = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: '',
      tags: true,
      style: {
        fg: 'white',
        bg: 'blue'
      }
    });
    
    // Add all elements to screen
    this.screen.append(this.headerBox);
    this.screen.append(this.statsBox);
    this.screen.append(this.memoryBox);
    this.screen.append(this.processBox);

    this.screen.append(this.statusBar);
  }
  
  private setupEventHandlers() {
    // Quit on Escape, q, or Control-C
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.stop();
      process.exit(0);
    });
    
    // Refresh on F5
    this.screen.key(['f5'], () => {
      this.updateDisplay();
    });

  }
  
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }
  
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  private createProgressBar(percentage: number, width: number = 20): string {
    const filled = Math.round(width * percentage / 100);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `[${bar}] ${percentage.toFixed(1)}%`;
  }
  
  private updateDisplay() {
    const streamerStats = this.data.streamer.getStats();
    const memoryStats = this.data.tradeMemoryManager.getMemoryStats();
    
    
    // Memory usage percentage
    const memoryUsagePercent = (memoryStats.currentMemoryUsage / (this.data.memoryConfig.maxMemoryMB * 1024 * 1024)) * 100;
    
    // Process memory
    const processMemory = process.memoryUsage();
    
    // Update header
    this.headerBox.setContent(
      `{center}{bold}Fury Swap API - LIVE STATS{/bold}{/center}\n` +
      `{center}${new Date().toLocaleString()}{/center}\n`
    );
    
    // Update memory usage
    this.memoryBox.setContent(
      `{bold}Trade Storage:{/bold}\n` +
      `${this.formatBytes(memoryStats.currentMemoryUsage)} / ${this.data.memoryConfig.maxMemoryMB}MB\n` +
      `${this.createProgressBar(memoryUsagePercent)}\n` +
      `{bold}Stored Trades:{/bold} {cyan-fg}${memoryStats.totalTrades.toLocaleString()}{/cyan-fg}\n` +
      `{bold}Usage:{/bold} {yellow-fg}${memoryUsagePercent.toFixed(1)}%{/yellow-fg}`
    );
    
    // Update process memory
    this.processBox.setContent(
      `{bold}RSS:{/bold} ${this.formatBytes(processMemory.rss)}\n` +
      `{bold}Heap Used:{/bold} ${this.formatBytes(processMemory.heapUsed)}\n` +
      `{bold}Heap Total:{/bold} ${this.formatBytes(processMemory.heapTotal)}\n` +
      `{bold}External:{/bold} ${this.formatBytes(processMemory.external)}\n` +
      `{bold}Array Buffers:{/bold} ${this.formatBytes(processMemory.arrayBuffers || 0)}`
    );
    
    // Update status bar
    const memoryWarning = memoryUsagePercent > 80 ? ' {red-fg}⚠️ HIGH MEMORY{/red-fg}' : '';
    const errorWarning = streamerStats.errors > 10 ? ` {red-fg}⚠️ ${streamerStats.errors} ERRORS{/red-fg}` : '';
    
    this.statusBar.setContent(
      `{center}{bold}Memory Efficiency:{/bold} ${this.createProgressBar(100 - memoryUsagePercent, 30)}{/center}\n` +
      `{center}{bold}Stored Trades:{/bold} {cyan-fg}${memoryStats.totalTrades.toLocaleString()}{/cyan-fg} | Memory: ${memoryUsagePercent.toFixed(1)}%${memoryWarning}${errorWarning}{/center}` 
    );
    
    this.screen.render();
  }
  

  
  public start() {
    // Initial render
    this.updateDisplay();
    this.screen.render();
    
    // Update every second
    this.updateInterval = setInterval(() => {
      this.updateDisplay();
    }, 1000);
    
  }
  
  public stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.screen.destroy();
  }
  
  public updateData(data: Partial<MonitorData>) {
    Object.assign(this.data, data);
  }
}