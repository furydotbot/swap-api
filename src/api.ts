import express from 'express';
import cors from 'cors';
import { getTradeForMint, connection } from './index';
import { getTransactionBuilderRegistry } from './builders/TransactionBuilderRegistry';
import { SwapParams } from './TransactionBuilder';
import { Transaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// GET /api/quote/:mint - Get trade quote
app.get('/api/quote/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    
    const trade = await getTradeForMint(mint);
    
    if (!trade) {
      return res.status(404).json({
        success: false,
        error: 'Trade not found',
        mint
      });
    }
    
    // Return trade quote with required fields
    res.json({
      success: true,
      quote: {
        mint: trade.mint,
        pool: trade.pool,
        avgPrice: trade.avgPrice,
        programId: trade.programId,
        slot: trade.slot
      }
    });
  } catch (error) {
    console.error('Error fetching trade quote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trade quote',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/swap/:mint - Execute swap transaction
app.post('/api/swap/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    const { signer, encoding, type, amountIn, amountOut, slippage, quote } = req.body;
    
    // Validate required parameters
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
    
    // Validate swap type
    if (!type || (type !== 'buy' && type !== 'sell')) {
      return res.status(400).json({
        success: false,
        error: 'type parameter is required and must be "buy" or "sell"'
      });
    }
    
    // Validate amount parameters
    if (!amountIn && !amountOut) {
      return res.status(400).json({
        success: false,
        error: 'Either amountIn or amountOut parameter is required'
      });
    }
    
    // Use provided quote or fetch trade data
    let trade;
    if (quote) {
      // Validate quote structure
      if (!quote.mint || !quote.pool || !quote.avgPrice || !quote.programId || !quote.slot) {
        return res.status(400).json({
          success: false,
          error: 'Invalid quote format. Required fields: mint, pool, avgPrice, programId, slot'
        });
      }
      
      // Verify quote mint matches request mint
      if (quote.mint !== mint) {
        return res.status(400).json({
          success: false,
          error: 'Quote mint does not match request mint'
        });
      }
      
      trade = quote;
    } else {
      // Fallback to fetching trade data (legacy behavior)
      trade = await getTradeForMint(mint);
      
      if (!trade) {
        return res.status(404).json({
          success: false,
          error: 'Trade not found',
          mint
        });
      }
    }
    
    // Parse and validate slippage (basis points)
    let slippageBps = 50; // Default 0.5% (50 bps)
    if (slippage) {
      const parsedSlippage = parseInt(slippage);
      if (isNaN(parsedSlippage) || parsedSlippage < 0 || parsedSlippage > 10000) {
        return res.status(400).json({
          success: false,
          error: 'slippage must be a number between 0 and 10000 (basis points)'
        });
      }
      slippageBps = parsedSlippage;
    }
    
    // Parse amount
    const amount = amountIn ? parseFloat(amountIn) : parseFloat(amountOut);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be a positive number'
      });
    }
    
    // Calculate amounts based on trade data
    let inputAmount, outputAmount;
    if (type === 'buy') {
      // Buy: amountIn is SOL, calculate token output
      if (amountIn) {
        inputAmount = amount; // SOL amount
        outputAmount = amount / trade.avgPrice; // Calculate tokens received
      } else if (amountOut) {
        outputAmount = amount; // Token amount desired
        inputAmount = amount * trade.avgPrice; // Calculate SOL needed
      }
    } else if (type === 'sell') {
      // Sell: amountIn is tokens, calculate SOL output
      if (amountIn) {
        inputAmount = amount; // Token amount
        outputAmount = amount * trade.avgPrice; // Calculate SOL received
      } else if (amountOut) {
        outputAmount = amount; // SOL amount desired
        inputAmount = amount / trade.avgPrice; // Calculate tokens needed
      }
    }
    
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
      type: type,
      inputAmount: inputAmount || undefined,
      outputAmount: outputAmount || undefined,
      slippageBps,
      trade
    };
    
    // Generate protocol-specific transaction
    const swapResult = await builder.buildSwapTransaction(swapParams);
    
    // Create Solana transaction from instructions or raw transaction
    let transaction: Transaction;
    
    if (swapResult.transaction) {
      // Use the raw transaction directly
      transaction = swapResult.transaction;
    } else if (swapResult.instructions) {
      // Convert SwapInstructions to TransactionInstructions (legacy path)
      transaction = new Transaction();
      for (const swapInstruction of swapResult.instructions) {
        const instruction = {
          programId: new PublicKey(swapInstruction.programId),
          keys: swapInstruction.accounts.map((account: { pubkey: string; isSigner: boolean; isWritable: boolean }) => ({
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
    } else {
      throw new Error('No transaction or instructions found in swap result');
    }
    
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


// Start server
// Function to start the API server
export function startApiServer(): void {
  app.listen(PORT, () => {
    console.log(`🚀 Trade API Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 All trades: http://localhost:${PORT}/api/trades`);
    console.log(`📊 Trade stats by programId: http://localhost:${PORT}/api/trades/stats`);
  });
}

export default app;