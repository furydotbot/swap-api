import { default as Client } from '@triton-one/yellowstone-grpc';
import * as bs58 from 'bs58';
import {
  StreamerConfig,
  StreamerStats,
  RawTransactionData,
  RawTransactionListener,
  SubscriptionRequest,
  PingRequest,
  GrpcMessage
} from './types';

// Handle both bs58 v4 and v6 API differences
const base58Encode = (bs58 as any).default?.encode || bs58;

export class TransactionStreamer {
  private grpcEndpoint: string;
  private grpcToken: string;
  private accountToWatch: string | string[];
  
  // gRPC client properties
  private grpcClient: any = null;
  private grpcStream: any = null;
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
    // gRPC connection settings
    this.grpcEndpoint = config.grpcEndpoint || "";
    this.grpcToken = config.grpcToken || "";
    
    // Account(s) to watch - can be single string or array
    this.accountToWatch = config.accountToWatch;
  }

  async connectToGrpc(): Promise<void> {
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
      console.log(`Creating new gRPC connection: ${this.connectionId}`);
      
      // Create new gRPC client
      this.grpcClient = new Client(this.grpcEndpoint, this.grpcToken, undefined);
      
      // Test connection with timeout
      const connectionTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout after 30 seconds')), 30000);
      });
      
      const versionPromise = this.grpcClient.getVersion();
      
      try {
        const version = await Promise.race([versionPromise, connectionTimeout]);
        console.log('gRPC connection established, version:', version);
      } catch (error) {
        console.error('Failed to connect to gRPC:', error);
        throw error;
      }
      
      // Subscribe to transactions
      await this.subscribeToTransactions();
      
      this.connected = true;
      this.isReconnecting = false;
      console.log(`Successfully connected to gRPC and subscribed to transactions: ${this.connectionId}`);
      
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
        commitment: 'confirmed',      // Transaction commitment level
        accountsDataSlice: [],
      };
      
      // Send subscription request
      this.grpcStream.write(request);
      console.log('Subscription request sent successfully');
      
      // Start ping to keep connection alive
      this.startPing();
      
    } catch (error) {
      console.error('Error creating subscription:', error);
      this.stats.errors++;
      throw error;
    }
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
    console.log(`Scheduling reconnection due to: ${reason}`);
    
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
    
    console.log('Attempting to reconnect...');
    try {
      // Ensure complete cleanup before reconnecting
      await this.cleanupConnection();
      await this.connectToGrpc();
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
    if (oldConnectionId) {
      console.log(`Cleaning up existing connection: ${oldConnectionId}`);
    } else {
      console.log('Cleaning up existing connection...');
    }
    
    this.connected = false;
    this.connectionId = '';
    this.stopPing();
    
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
    
    if (oldConnectionId) {
      console.log(`Connection ${oldConnectionId} cleaned up successfully`);
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
}