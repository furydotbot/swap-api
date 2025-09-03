# How to Create a Transaction Builder

This guide explains how to create a new transaction builder for the swap API system. Transaction builders are responsible for creating swap transactions for different DEX protocols on Solana.

## Overview

The swap API uses a builder pattern to handle different DEX protocols. Each protocol has its own builder that implements the `ITransactionBuilder` interface and extends the `BaseTransactionBuilder` abstract class.

## Architecture

### Core Interfaces

- **`ITransactionBuilder`**: Base interface that all builders must implement
- **`BaseTransactionBuilder`**: Abstract base class providing common functionality
- **`TransactionBuilderRegistry`**: Registry that manages and provides access to all builders

### Key Types

```typescript
// Input parameters for swap transactions
interface SwapParams {
  mint: string;           // Token mint address
  signer: string;         // User's wallet address
  type: 'buy' | 'sell';   // Transaction type
  inputAmount?: number;   // Input amount in lamports/tokens
  outputAmount?: number;  // Expected output amount
  slippageBps: number;    // Slippage tolerance in basis points
  trade: {
    mint: string;         // Token mint (same as above)
    pool: string;         // Pool address
    avgPrice: number;     // Average price
    programId: string;    // DEX program ID
    slot: string;         // Slot information
  };
}

// Output transaction structure
interface SwapTransaction {
  transactionId: string;
  status: 'pending' | 'confirmed' | 'failed';
  instructions: SwapInstruction[];
}

// Individual instruction format
interface SwapInstruction {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string; // Base64 encoded instruction data
}
```

## Step-by-Step Guide

### 1. Create Your Builder Class

Create a new file in the `src/builders/` directory:

```typescript
// src/builders/YourProtocolTransactionBuilder.ts
import { BaseTransactionBuilder, SwapParams, SwapTransaction, SwapInstruction } from '../TransactionBuilder';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
// Import your protocol's SDK

export class YourProtocolTransactionBuilder extends BaseTransactionBuilder {
  // Define your protocol's program ID
  programId = 'YourProgramIdHere';
  private connection: Connection;
  
  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }

  async buildSwapTransaction(params: SwapParams): Promise<SwapTransaction> {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const transactionId = `tx_${timestamp}_${random}`;
    const instructions = await this.createSwapInstructions(params);
    
    return {
      transactionId,
      status: 'pending',
      instructions
    };
  }

  private async createSwapInstructions(params: SwapParams): Promise<SwapInstruction[]> {
    // Implement your protocol-specific logic here
    // Return array of SwapInstruction objects
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
}
```

### 2. Implement Core Logic

The `createSwapInstructions` method should:

1. **Parse input parameters**:
   ```typescript
   const mint = new PublicKey(params.mint);
   const user = new PublicKey(params.signer);
   const pool = new PublicKey(params.trade.pool);
   ```

2. **Handle token accounts**:
   ```typescript
   // Get or create associated token accounts
   const userTokenAccount = await getAssociatedTokenAddress(mint, user);
   
   // Check if account exists and create if needed
   const tokenAccountInfo = await this.connection.getAccountInfo(userTokenAccount);
   if (!tokenAccountInfo) {
     const createInstruction = createAssociatedTokenAccountInstruction(
       user, userTokenAccount, user, mint
     );
     instructions.push(createInstruction);
   }
   ```

3. **Create protocol-specific swap instructions**:
   ```typescript
   // Use your protocol's SDK to create swap instructions
   const swapInstruction = await yourProtocolSdk.createSwapInstruction({
     pool,
     user,
     inputAmount: params.inputAmount,
     outputAmount: params.outputAmount,
     slippage: params.slippageBps
   });
   
   instructions.push(swapInstruction);
   ```

4. **Convert and return instructions**:
   ```typescript
   return instructions.map(ix => this.convertToSwapInstruction(ix));
   ```

### 3. Register Your Builder

Add your builder to the registry in `src/builders/TransactionBuilderRegistry.ts`:

```typescript
// Import your builder
import { YourProtocolTransactionBuilder } from './YourProtocolTransactionBuilder';

// In the registerBuilders() method:
private registerBuilders(): void {
  // ... existing builders ...
  
  // Register your builder
  const yourProtocolBuilder = new YourProtocolTransactionBuilder(this.connection);
  this.builders.set(yourProtocolBuilder.programId, yourProtocolBuilder);
}

// Update getBuilderInfo() method to include your protocol:
case 'YourProgramIdHere':
  name = 'YourProtocolName';
  break;
```

### 4. Add Helper Methods (Optional)

Add protocol-specific helper methods:

```typescript
// Static method to check if a program ID belongs to your protocol
public static isYourProtocolProgram(programId: string): boolean {
  return programId === 'YourProgramIdHere';
}

// Helper methods for your protocol
public getPoolAddress(mint: string): string {
  // Implementation specific to your protocol
}

public calculateSlippage(amount: number, slippageBps: number): number {
  return amount * (10000 - slippageBps) / 10000;
}
```

## Best Practices

### Error Handling

```typescript
private async createSwapInstructions(params: SwapParams): Promise<SwapInstruction[]> {
  try {
    // Your implementation
  } catch (error) {
    console.error(`Error creating ${this.constructor.name} instructions:`, error);
    throw new Error(`Failed to create swap instructions: ${error.message}`);
  }
}
```

### Input Validation

```typescript
private validateParams(params: SwapParams): void {
  if (!params.mint || !PublicKey.isOnCurve(params.mint)) {
    throw new Error('Invalid mint address');
  }
  if (!params.signer || !PublicKey.isOnCurve(params.signer)) {
    throw new Error('Invalid signer address');
  }
  if (params.slippageBps < 0 || params.slippageBps > 10000) {
    throw new Error('Invalid slippage value');
  }
}
```

### Performance Optimization

```typescript
// Cache SDK instances
private protocolSdk: YourProtocolSdk | null = null;

private async getProtocolSdk(): Promise<YourProtocolSdk> {
  if (!this.protocolSdk) {
    this.protocolSdk = new YourProtocolSdk(this.connection);
  }
  return this.protocolSdk;
}
```

## Testing Your Builder

1. **Unit Tests**: Create tests for your builder's methods
2. **Integration Tests**: Test with actual Solana devnet
3. **Manual Testing**: Use the API endpoints to test your builder

```typescript
// Example test
const builder = new YourProtocolTransactionBuilder(connection);
const params: SwapParams = {
  mint: 'TokenMintAddress',
  signer: 'UserWalletAddress',
  type: 'buy',
  inputAmount: 1000000, // 1 SOL in lamports
  slippageBps: 100, // 1% slippage
  trade: {
    mint: 'TokenMintAddress',
    pool: 'PoolAddress',
    avgPrice: 0.001,
    programId: 'YourProgramIdHere',
    slot: '12345'
  }
};

const transaction = await builder.buildSwapTransaction(params);
console.log('Transaction created:', transaction);
```

## Examples

Refer to existing builders for implementation examples:

- **PumpFunTransactionBuilder**: Simple bonding curve implementation
- **DBCTransactionBuilder**: Dynamic bonding curve with complex account management
- **LaunchpadTransactionBuilder**: Raydium launchpad integration
- **PumpSwapTransactionBuilder**: AMM-style swaps

## Common Patterns

### Account Creation
Most builders need to handle associated token account creation:

```typescript
const userTokenAccount = await getAssociatedTokenAddress(mint, user);
const accountInfo = await this.connection.getAccountInfo(userTokenAccount);
if (!accountInfo) {
  instructions.push(createAssociatedTokenAccountInstruction(
    user, userTokenAccount, user, mint
  ));
}
```

### WSOL Handling
For SOL-based swaps, you'll often need to wrap/unwrap SOL:

```typescript
// Create WSOL account
const wsolAccount = await getAssociatedTokenAddress(NATIVE_MINT, user);
// Add wrap/unwrap instructions as needed
```

### Slippage Calculation
```typescript
const minAmountOut = expectedAmount * (10000 - slippageBps) / 10000;
```

## Troubleshooting

- **Account not found**: Ensure all required accounts are created
- **Insufficient funds**: Validate input amounts and account balances
- **Invalid instruction data**: Check SDK usage and parameter formatting
- **Program errors**: Verify program IDs and account permissions

## Contributing

When contributing a new builder:

1. Follow the existing code style and patterns
2. Add comprehensive error handling
3. Include helper methods for common operations
4. Update the registry to include your builder
5. Add tests for your implementation
6. Document any protocol-specific requirements

Your builder will automatically be available through the API once registered in the `TransactionBuilderRegistry`.