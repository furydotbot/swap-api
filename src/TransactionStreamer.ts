import { default as Client } from '@triton-one/yellowstone-grpc';
import * as bs58 from 'bs58';
import WebSocket from 'ws';
import {
  StreamerConfig,
  StreamerStats,
  RawTransactionData,
  RawTransactionListener,
  SubscriptionRequest,
  PingRequest,
  GrpcMessage,
  HeliusTransactionSubscribeFilter,
  HeliusTransactionSubscribeOptions,
  HeliusWebSocketMessage,
  HeliusTransactionNotification,
  StreamingProvider
} from './types';

// Handle both bs58 v4 and v6 API differences
const base58Encode = (bs58 as any).default?.encode || bs58;

export class TransactionStreamer {
  private provider: StreamingProvider;
  private accountToWatch: string | string[];
  private commitment: 'processed' | 'confirmed' | 'finalized';
  
  // gRPC client properties
  private grpcEndpoint: string;
  private grpcToken: string;
  private grpcClient: any = null;
  private grpcStream: any = null;
  
  // Helius WebSocket properties
  private heliusApiKey: string;
  private heliusEndpoint: string;
  private heliusWs: WebSocket | null = null;
  private subscriptionId: number | null = null;
  
  // Common properties
  private connected: boolean = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastMessageTime: number = Date.now();
  private pingId: number = 1;
  private connectionId: string = '';
  private isReconnecting: boolean = false;
  
  // Event listeners for raw transaction data
  private rawTransactionListeners: Set<RawTransactionListener> = new Set();
  
  // Stats tracking
  public stats: StreamerStats = {
    transactionsReceived: 0,
    errors: 0,
    startTime: Date.now()
  };

  constructor(config: StreamerConfig) {
    this.provider = config.provider;
    this.accountToWatch = config.accountToWatch;
    this.commitment = config.commitment || 'processed';
    
    // gRPC connection settings
    this.grpcEndpoint = config.grpcEndpoint || "";
    this.grpcToken = config.grpcToken || "";
    
    // Helius WebSocket settings
    this.heliusApiKey = config.heliusApiKey || "";
    this.heliusEndpoint = config.heliusEndpoint || "wss://atlas-mainnet.helius-rpc.com";
    
    // Validate configuration based on provider
    this.validateConfig();
  }
  
  private validateConfig(): void {
    if (this.provider === 'grpc') {
      if (!this.grpcEndpoint || !this.grpcToken) {
        throw new Error('gRPC provider requires grpcEndpoint and grpcToken');
      }
    } else if (this.provider === 'helius') {
      if (!this.heliusApiKey) {
        throw new Error('Helius provider requires heliusApiKey');
      }
    } else {
      throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  async connect(): Promise<void> {
    if (this.provider === 'grpc') {
      return this.connectToGrpc();
    } else if (this.provider === 'helius') {
      return this.connectToHelius();
    }
    throw new Error(`Unsupported provider: ${this.provider}`);
  }

  private async connectToGrpc(): Promise<void> {
    try {
      // Prevent multiple simultaneous connection attempts
      if (this.connected || this.isReconnecting) {
        console.log('Already connected or reconnecting to gRPC');
        return;
      }
      
      this.isReconnecting = true;
      
      // Ensure clean state before connecting
      await this.cleanupConnection();
      
      // Generate unique connection ID
      this.connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      // Create new gRPC client
      this.grpcClient = new Client(this.grpcEndpoint, this.grpcToken, undefined);
      
      // Test connection with timeout
      const connectionTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout after 30 seconds')), 30000);
      });
      
      const versionPromise = this.grpcClient.getVersion();
      
      try {
        const version = await Promise.race([versionPromise, connectionTimeout]);
      } catch (error) {
        console.error('Failed to connect to gRPC:', error);
        throw error;
      }
      
      // Subscribe to transactions
      await this.subscribeToTransactions();
      
      this.connected = true;
      this.isReconnecting = false;
      
    } catch (error) {
      console.error('Failed to create gRPC connection:', error);
      this.stats.errors++;
      this.isReconnecting = false;
      throw error;
    }
  }

  private async subscribeToTransactions(): Promise<void> {
    try {
      // Create subscription stream
      this.grpcStream = await this.grpcClient.subscribe();
      
      // Set up event handlers
      this.setupGrpcEventHandlers();
      
      // Prepare accounts array
      const accounts = Array.isArray(this.accountToWatch) 
        ? this.accountToWatch 
        : [this.accountToWatch];
      
      // Create subscription request
      const request: SubscriptionRequest = {
        accounts: {},
        slots: {},
        transactions: {
          accountWatch: {
            vote: false,              // Exclude vote transactions
            failed: false,            // Exclude failed transactions
            accountExclude: [],       // Accounts to exclude
            accountRequired: [],      // All accounts must be present
            accountInclude: accounts  // Accounts to include
          }
        },
        transactionsStatus: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        commitment: 'processed',      // Transaction commitment level
        accountsDataSlice: [],
      };
      
      // Send subscription request
      this.grpcStream.write(request);
      
      // Start ping to keep connection alive
      this.startPing();
      
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }

  private async connectToHelius(): Promise<void> {
    try {
      // Prevent multiple simultaneous connection attempts
      if (this.connected || this.isReconnecting) {
        return;
      }
      
      this.isReconnecting = true;
      
      // Ensure clean state before connecting
      await this.cleanupConnection();
      
      // Generate unique connection ID
      this.connectionId = `helius_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Create WebSocket URL with API key
      const wsUrl = `${this.heliusEndpoint}?api-key=${this.heliusApiKey}`;
      this.heliusWs = new WebSocket(wsUrl);
      
      // Set up WebSocket event handlers
      this.setupHeliusEventHandlers();
      
      // Wait for connection to open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Helius WebSocket connection timeout after 30 seconds'));
        }, 30000);
        
        this.heliusWs!.on('open', () => {
          clearTimeout(timeout);
          resolve();
        });
        
        this.heliusWs!.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      // Subscribe to transactions
      await this.subscribeToHeliusTransactions();
      
      this.connected = true;
      this.isReconnecting = false;
      
    } catch (error) {
      console.error('Failed to create Helius WebSocket connection:', error);
      this.stats.errors++;
      this.isReconnecting = false;
      throw error;
    }
  }

  private async subscribeToHeliusTransactions(): Promise<void> {
    try {
      // Prepare accounts array
      const accounts = Array.isArray(this.accountToWatch) 
        ? this.accountToWatch 
        : [this.accountToWatch];
      
      // Create subscription filter
      const filter: HeliusTransactionSubscribeFilter = {
        failed: false,
        accountInclude: accounts
      };
      
      // Create subscription options
      const options: HeliusTransactionSubscribeOptions = {
        commitment: this.commitment,
        encoding: 'jsonParsed',
        transactionDetails: 'full',
        showRewards: false,
        maxSupportedTransactionVersion: 0  // Support both legacy and versioned (v0) transactions
      };
      
      // Create subscription request
      const request: HeliusWebSocketMessage = {
        jsonrpc: '2.0',
        id: this.pingId++,
        method: 'transactionSubscribe',
        params: [filter, options]
      };
      
      // Send subscription request
      this.heliusWs!.send(JSON.stringify(request));
      
      // Start ping to keep connection alive
      this.startHeliusPing();
      
    } catch (error) {
      console.error('Error creating Helius subscription:', error);
      this.stats.errors++;
      throw error;
    }
  }

  private setupHeliusEventHandlers(): void {
    if (!this.heliusWs) {
      console.error('No Helius WebSocket instance to set up handlers for');
      return;
    }
    
    // Handle incoming messages
    this.heliusWs.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString('utf8'));
        this.handleHeliusMessage(message);
      } catch (error) {
        console.error('Error parsing Helius WebSocket message:', error);
        this.stats.errors++;
      }
    });
    
    // Handle WebSocket errors
    this.heliusWs.on('error', (error: Error) => {
      console.error('Helius WebSocket error:', error);
      this.stats.errors++;
      this.scheduleReconnection('error');
    });
    
    // Handle WebSocket close
    this.heliusWs.on('close', () => {
      this.scheduleReconnection('close');
    });
  }

  private async handleHeliusMessage(message: any): Promise<void> {
    try {
      // Ignore messages from stale connections
      if (!this.connected || !this.connectionId) {
        return;
      }
      
      // Update last message time for health monitoring
      this.lastMessageTime = Date.now();
      
      // Handle subscription confirmation
      if (message.result && typeof message.result === 'number') {
        this.subscriptionId = message.result;
        return;
      }
      
      // Handle transaction notifications
      if (message.method === 'transactionNotification' && message.params) {
        const notification = message as HeliusTransactionNotification;
        const result = notification.params.result;
        
        try {
          // Increment transaction count
          this.stats.transactionsReceived++;
          
          // Create raw transaction data
          const rawTransactionData: RawTransactionData = {
            signature: result.signature,
            slot: result.slot,
            transaction: result.transaction.transaction,
            meta: result.transaction.meta,
            blockTime: Date.now() / 1000, // Helius doesn't always provide blockTime
            timestamp: new Date().toISOString(),
            connectionId: this.connectionId
          };
          
          // Notify all raw transaction listeners
          this.notifyRawTransactionListeners(rawTransactionData);
          
        } catch (error) {
          console.error(`Error processing Helius transaction ${result.signature}:`, error);
          this.stats.errors++;
        }
      }
    } catch (error) {
      console.error('Error handling Helius WebSocket message:', error);
      this.stats.errors++;
    }
  }

  private startHeliusPing(): void {
    this.stopPing();
    
    // Send ping every 30 seconds as recommended by Helius
    this.pingInterval = setInterval(() => {
      if (!this.heliusWs || this.heliusWs.readyState !== WebSocket.OPEN) {
        return;
      }
      
      try {
        this.heliusWs.ping();
      } catch (error) {
        console.error('Error sending ping to Helius WebSocket:', error);
        this.stats.errors++;
        
        if (this.connected) {
          this.connected = false;
          this.handleReconnection();
        }
      }
    }, 30000); // Ping every 30 seconds
  }

  private setupGrpcEventHandlers(): void {
    if (!this.grpcStream) {
      console.error('No gRPC stream instance to set up handlers for');
      return;
    }
    
    // Remove any existing listeners to prevent memory leaks
    this.grpcStream.removeAllListeners();
    
    // Handle incoming data
    this.grpcStream.on('data', (data: GrpcMessage) => {
      try {
        this.handleGrpcMessage(data);
      } catch (error) {
        console.error('Error in gRPC message handler:', error);
        this.stats.errors++;
      }
    });
    
    // Handle stream errors
    this.grpcStream.on('error', (error: Error) => {
      console.error('gRPC stream error:', error);
      this.stats.errors++;
      this.scheduleReconnection('error');
    });
    
    // Handle stream end
    this.grpcStream.on('end', () => {
      console.log('gRPC stream ended');
      this.scheduleReconnection('end');
    });
    
    // Handle stream close
    this.grpcStream.on('close', () => {
      console.log('gRPC stream closed');
      this.scheduleReconnection('close');
    });
  }

  private async handleGrpcMessage(data: GrpcMessage): Promise<void> {
    try {
      // Ignore messages from stale connections
      if (!this.connected || !this.connectionId) {
        console.warn('Ignoring message from stale connection');
        return;
      }
      
      // Update last message time for health monitoring
      this.lastMessageTime = Date.now();
      
      // Handle pong responses (keep-alive)
      if (data.pong) {
        return;
      }
      
      // Check if this is a transaction notification
      if (data.transaction && data.transaction.transaction) {
        const tx = data.transaction;
        let signature = 'unknown';
        
        try {
          // Convert signature to base58 string (Solana standard format)
          signature = base58Encode(tx.transaction.signature);
          
          // Increment transaction count
          this.stats.transactionsReceived++;
          
          // Create raw transaction data (without parsing)
          const rawTransactionData: RawTransactionData = {
            signature: signature,
            slot: tx.slot,
            transaction: tx.transaction.transaction,
            meta: tx.transaction.meta,
            blockTime: tx.transaction.blockTime,
            timestamp: new Date().toISOString(),
            connectionId: this.connectionId
          };
          
          // Notify all raw transaction listeners
          this.notifyRawTransactionListeners(rawTransactionData);
          
        } catch (error) {
          console.error(`Error processing transaction ${signature}:`, error);
          this.stats.errors++;
        }
      }
    } catch (error) {
      console.error('Error handling gRPC message:', error);
      this.stats.errors++;
    }
  }

  // Add a listener for raw transaction data
  addRawTransactionListener(listener: RawTransactionListener): () => void {
    if (typeof listener === 'function') {
      this.rawTransactionListeners.add(listener);
      return () => this.rawTransactionListeners.delete(listener);
    }
    return () => {};
  }

  // Notify all listeners about raw transaction data
  private notifyRawTransactionListeners(rawTransaction: RawTransactionData): void {
    this.rawTransactionListeners.forEach(listener => {
      try {
        listener(rawTransaction);
      } catch (error) {
        console.error('Error in raw transaction listener:', error);
        this.stats.errors++;
      }
    });
  }

  private startPing(): void {
    if (this.provider === 'grpc') {
      this.startGrpcPing();
    } else if (this.provider === 'helius') {
      this.startHeliusPing();
    }
  }

  private startGrpcPing(): void {
    this.stopPing();
    
    // Send ping every 10 seconds as recommended
    this.pingInterval = setInterval(async () => {
      if (!this.grpcStream || !this.connected) {
        console.error('gRPC stream not available or not connected during ping');
        return;
      }
      
      try {
        const pingRequest: PingRequest = {
          ping: { id: this.pingId++ },
          accounts: {},
          accountsDataSlice: [],
          transactions: {},
          transactionsStatus: {},
          blocks: {},
          blocksMeta: {},
          entry: {},
          slots: {},
        };
        
        this.grpcStream.write(pingRequest);
        
      } catch (error) {
        console.error('Error sending ping to gRPC:', error);
        this.stats.errors++;
        
        if (this.connected) {
          this.connected = false;
          this.handleReconnection();
        }
      }
    }, 10000); // Ping every 10 seconds
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnection(reason: string): void {    
    // Prevent multiple reconnection attempts
    if (!this.connected) {
      return; // Already disconnected and reconnection scheduled
    }
    
    this.connected = false;
    
    // Attempt reconnection after 5 seconds
    setTimeout(() => {
      this.handleReconnection();
    }, 5000);
  }

  private async handleReconnection(): Promise<void> {
    if (this.connected) {
      return; // Already connected
    }
  
    try {
      // Ensure complete cleanup before reconnecting
      await this.cleanupConnection();
      await this.connect();
    } catch (error) {
      console.error('Reconnection failed:', error);
      // Schedule another reconnection attempt
      setTimeout(() => {
        this.handleReconnection();
      }, 10000); // Wait 10 seconds before next attempt
    }
  }

  private async cleanupConnection(): Promise<void> {
    const oldConnectionId = this.connectionId;
    
    this.connected = false;
    this.connectionId = '';
    this.subscriptionId = null;
    this.stopPing();
    
    // Cleanup gRPC connections
    if (this.grpcStream) {
      try {
        this.grpcStream.removeAllListeners();
        this.grpcStream.end();
      } catch (error) {
        console.warn('Error cleaning up gRPC stream:', error);
      }
      this.grpcStream = null;
    }
    
    if (this.grpcClient) {
      try {
        // Close the client if it has a close method
        if (typeof this.grpcClient.close === 'function') {
          this.grpcClient.close();
        }
      } catch (error) {
        console.warn('Error closing gRPC client:', error);
      }
      this.grpcClient = null;
    }
    
    // Cleanup Helius WebSocket connections
    if (this.heliusWs) {
      try {
        this.heliusWs.removeAllListeners();
        if (this.heliusWs.readyState === WebSocket.OPEN) {
          this.heliusWs.close();
        }
      } catch (error) {
        console.warn('Error cleaning up Helius WebSocket:', error);
      }
      this.heliusWs = null;
    }
    
  }

  // Graceful shutdown
  async disconnect(): Promise<void> {
    console.log('Disconnecting from gRPC...');
    await this.cleanupConnection();
    console.log('Disconnected from gRPC');
  }

  // Get current statistics
  getStats(): StreamerStats {
    return { ...this.stats };
  }

  // Check if connected
  isConnected(): boolean {
    return this.connected;
  }

  // Get current provider
  getProvider(): StreamingProvider {
    return this.provider;
  }

  // Get subscription ID (for Helius)
  getSubscriptionId(): number | null {
    return this.subscriptionId;
  }
}