import express from 'express';
import cors from 'cors';
import { getAllTrades, getTradeForMint, getMemoryStats, connection } from './index';
import { Trade } from './types';
import { getTransactionBuilderRegistry } from './builders/TransactionBuilderRegistry';
import { SwapParams } from './TransactionBuilder';
import { Transaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to convert Map to Object for JSON serialization
function mapToObject<T>(map: Map<string, T>): Record<string, T> {
  const obj: Record<string, T> = {};
  for (const [key, value] of map) {
    obj[key] = value;
  }
  return obj;
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Get all current trades
app.get('/api/trades', (req, res) => {
  try {
    const trades = getAllTrades();
    const tradesObject = mapToObject(trades);
    
    res.json({
      success: true,
      data: tradesObject,
      count: trades.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching trades:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trades',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get quote for a mint address with trading parameters
app.get('/api/quote/:mint', (req, res) => {
  try {
    const { mint } = req.params;
    const { amountIn, amountOut, type, slippage } = req.query;
    
    // Validate required parameters
    if (!amountIn && !amountOut) {
      return res.status(400).json({
        success: false,
        error: 'Either amountIn or amountOut parameter is required'
      });
    }
    
    if (!type || (type !== 'buy' && type !== 'sell')) {
      return res.status(400).json({
        success: false,
        error: 'type parameter is required and must be "buy" or "sell"'
      });
    }
    
    // Parse and validate slippage (basis points)
    let slippageBps = 50; // Default 0.5% (50 bps)
    if (slippage) {
      const parsedSlippage = parseInt(slippage as string);
      if (isNaN(parsedSlippage) || parsedSlippage < 0 || parsedSlippage > 10000) {
        return res.status(400).json({
          success: false,
          error: 'slippage must be a number between 0 and 10000 (basis points)'
        });
      }
      slippageBps = parsedSlippage;
    }
    
    // Parse amount
    const amount = amountIn ? parseFloat(amountIn as string) : parseFloat(amountOut as string);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be a positive number'
      });
    }
    
    const trade = getTradeForMint(mint);
    
    if (!trade) {
      return res.status(404).json({
        success: false,
        error: 'Trade not found',
        mint
      });
    }
    
    // Calculate quote based on parameters
     let inputAmount = null;
     let outputAmount = null;
     let calculatedOutputAmount = null;
     let calculatedInputAmount = null;
     
     if (type === 'buy') {
       // Buy: amountIn is SOL, calculate token output
       if (amountIn) {
         inputAmount = amount; // SOL amount
         calculatedOutputAmount = amount / trade.avgPrice; // Calculate tokens received
         outputAmount = calculatedOutputAmount;
       } else if (amountOut) {
         outputAmount = amount; // Token amount desired
         calculatedInputAmount = amount * trade.avgPrice; // Calculate SOL needed
         inputAmount = calculatedInputAmount;
       }
     } else if (type === 'sell') {
       // Sell: amountIn is tokens, calculate SOL output
       if (amountIn) {
         inputAmount = amount; // Token amount
         calculatedOutputAmount = amount * trade.avgPrice; // Calculate SOL received
         outputAmount = calculatedOutputAmount;
       } else if (amountOut) {
         outputAmount = amount; // SOL amount desired
         calculatedInputAmount = amount / trade.avgPrice; // Calculate tokens needed
         inputAmount = calculatedInputAmount;
       }
     }
     
     const quote = {
       type,
       inputAmount,
       outputAmount,
       slippageBps,
       slippagePercent: slippageBps / 100,
       quote: trade,
       minimumReceived: outputAmount ? outputAmount * (1 - slippageBps / 10000) : null,
       maximumSent: inputAmount ? inputAmount * (1 + slippageBps / 10000) : null,
     };
    
    res.json({
      success: true,
      data: quote,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating quote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate quote',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/swap/:mint - Execute swap transaction
app.post('/api/swap/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    const { amountIn, amountOut, type, slippage, signer, encoding } = req.body;
    
    // Validate required parameters
    if (!amountIn && !amountOut) {
      return res.status(400).json({
        success: false,
        error: 'Either amountIn or amountOut parameter is required'
      });
    }
    
    if (!type || (type !== 'buy' && type !== 'sell')) {
      return res.status(400).json({
        success: false,
        error: 'type parameter is required and must be "buy" or "sell"'
      });
    }
    
    if (!signer) {
      return res.status(400).json({
        success: false,
        error: 'signer parameter is required'
      });
    }
    
    // Validate signer format (basic validation for public key)
    if (typeof signer !== 'string' || signer.length < 32) {
      return res.status(400).json({
        success: false,
        error: 'signer must be a valid public key string'
      });
    }
    
    // Validate encoding parameter
    if (encoding && encoding !== 'base64' && encoding !== 'base58') {
      return res.status(400).json({
        success: false,
        error: 'encoding parameter must be either "base64" or "base58"'
      });
    }
    
    // Parse and validate slippage
    let slippageBps = 100; // Default 1%
    if (slippage !== undefined) {
      const parsedSlippage = parseFloat(slippage as string);
      if (isNaN(parsedSlippage) || parsedSlippage < 0 || parsedSlippage > 10000) {
        return res.status(400).json({
          success: false,
          error: 'slippage must be a number between 0 and 10000 (basis points)'
        });
      }
      slippageBps = parsedSlippage;
    }
    
    // Parse amount
    const amount = amountIn ? parseFloat(amountIn as string) : parseFloat(amountOut as string);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be a positive number'
      });
    }
    
    const trade = getTradeForMint(mint);
    
    if (!trade) {
      return res.status(404).json({
        success: false,
        error: 'Trade not found',
        mint
      });
    }
    
    // Calculate swap amounts (same logic as quote)
    let inputAmount = null;
    let outputAmount = null;
    let calculatedOutputAmount = null;
    let calculatedInputAmount = null;
    
    if (type === 'buy') {
      // Buy: amountIn is SOL, calculate token output
      if (amountIn) {
        inputAmount = amount; // SOL amount
        calculatedOutputAmount = amount / trade.avgPrice; // Calculate tokens received
        outputAmount = calculatedOutputAmount;
      } else if (amountOut) {
        outputAmount = amount; // Token amount desired
        calculatedInputAmount = amount * trade.avgPrice; // Calculate SOL needed
        inputAmount = calculatedInputAmount;
      }
    } else if (type === 'sell') {
      // Sell: amountIn is tokens, calculate SOL output
      if (amountIn) {
        inputAmount = amount; // Token amount
        calculatedOutputAmount = amount * trade.avgPrice; // Calculate SOL received
        outputAmount = calculatedOutputAmount;
      } else if (amountOut) {
        outputAmount = amount; // SOL amount desired
        calculatedInputAmount = amount / trade.avgPrice; // Calculate tokens needed
        inputAmount = calculatedInputAmount;
      }
    }
    
    // Use the shared connection from index.ts
    
    // Get the appropriate transaction builder for this protocol
    const transactionBuilderRegistry = getTransactionBuilderRegistry(connection);
    const builder = transactionBuilderRegistry.getBuilder(trade.programId);
    if (!builder) {
      return res.status(400).json({
        success: false,
        error: `Unsupported protocol. ProgramId ${trade.programId} not supported.`,
        supportedProtocols: transactionBuilderRegistry.getBuilderInfo()
      });
    }
    
    // Prepare swap parameters for the builder
    const swapParams: SwapParams = {
      mint,
      signer,
      type,
      inputAmount: inputAmount || undefined,
      outputAmount: outputAmount || undefined,
      slippageBps,
      trade
    };
    
    // Generate protocol-specific transaction
    const swapResult = await builder.buildSwapTransaction(swapParams);
    
    // Create Solana transaction from instructions
    const transaction = new Transaction();
    
    // Convert SwapInstructions to TransactionInstructions
    for (const swapInstruction of swapResult.instructions) {
      const instruction = {
        programId: new PublicKey(swapInstruction.programId),
        keys: swapInstruction.accounts.map(account => ({
          pubkey: new PublicKey(account.pubkey),
          isSigner: account.isSigner,
          isWritable: account.isWritable
        })),
        data: Buffer.from(swapInstruction.data, 'base64')
      };
      transaction.add(instruction);
    }
    
    // Set fee payer
    transaction.feePayer = new PublicKey(signer);
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    
    // Serialize transaction based on encoding preference
    const serializedTransaction = transaction.serialize({ requireAllSignatures: false });
    const encodingFormat = encoding || 'base64'; // Default to base64
    
    let encodedTransaction: string;
    if (encodingFormat === 'base58') {
      encodedTransaction = bs58.encode(serializedTransaction);
    } else {
      encodedTransaction = serializedTransaction.toString('base64');
    }
    
    res.json({
      success: true,
      tx: encodedTransaction
    });
  } catch (error) {
    console.error('Error creating swap transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create swap transaction',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = getMemoryStats();
    
    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Start server
// Function to start the API server
export function startApiServer(): void {
  app.listen(PORT, () => {
    console.log(`🚀 Trade API Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 All trades: http://localhost:${PORT}/api/trades`);
  });
}

export default app;