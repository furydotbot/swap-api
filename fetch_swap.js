// JavaScript script to fetch swap transaction, sign and send using Solana RPC

const { Connection, Transaction, VersionedTransaction, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const fs = require('fs');

// Configuration
const API_URL = 'http://localhost:3001/api/swap/5kqG17PTYTVJzYEWg6keZiiU7LdWKzSZbyHuUcpcpump';
const QUOTE_URL = 'http://localhost:3001/api/quote/5kqG17PTYTVJzYEWg6keZiiU7LdWKzSZbyHuUcpcpump';
const RPC_URL = 'https://solana-rpc.publicnode.com';

// You need to provide your private key here (base58 encoded)
// WARNING: Never commit private keys to version control!
const PRIVATE_KEY = '';

async function fetchAndExecuteSwap() {
    try {
        console.log('🚀 Starting swap transaction process...');
        
        // Initialize Solana connection
        const connection = new Connection(RPC_URL, 'processed');
        
        // Create keypair from private key
        let keypair;
        try {
            const privateKeyBytes = bs58.decode(PRIVATE_KEY);
            keypair = Keypair.fromSecretKey(privateKeyBytes);
            console.log(`📝 Using wallet: ${keypair.publicKey.toString()}`);
        } catch (error) {
            console.error('Private key decode error:', error.message);
            throw new Error('Invalid private key format. Please provide a valid base58 encoded private key.');
        }
        
        // Prepare direct swap request (no quote needed)
        const swapRequest = {
            signer: keypair.publicKey.toString(),
            type: 'sell',           // 'buy' or 'sell'
            amountIn: 2000,        // SOL amount for buy, token amount for sell
            slippage: 9900,        // 99% slippage in basis points
        };
        
        console.log('📡 Fetching trade quote from API...');
        
        // First, fetch the trade quote
        const quoteResponse = await fetch(QUOTE_URL, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!quoteResponse.ok) {
            throw new Error(`Quote API request failed with status: ${quoteResponse.status}`);
        }
        
        const quoteApiResponse = await quoteResponse.json();
        
        if (!quoteApiResponse.success) {
            throw new Error(`Quote API error: ${quoteApiResponse.error || 'Unknown error'}`);
        }
        
        console.log('✅ Trade quote received from API');
        console.log('📊 Quote details:', quoteApiResponse.quote);
        
        // Add quote to swap request
        swapRequest.quote = quoteApiResponse.quote;
        
        console.log('📡 Fetching swap transaction from API using quote...');
        console.log('💰 Swap details:', {
            type: swapRequest.type,
            amountIn: swapRequest.amountIn,
            slippage: `${swapRequest.slippage / 100}%`,
            quote: swapRequest.quote
        });
        
        // Fetch swap transaction from API using quote
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(swapRequest)
        });
        
        const apiResponse = await response.json();
        console.log(apiResponse);
        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }
        
        
        if (!apiResponse.success) {
            throw new Error(`API error: ${apiResponse.error || 'Unknown error'}`);
        }
        
        console.log('✅ Swap transaction received from API');
        
        // Save API response to result.json
        fs.writeFileSync('result.json', JSON.stringify(apiResponse, null, 2));
        console.log('💾 API response saved to result.json');
        
        // Deserialize the transaction - handle both legacy and versioned transactions
        const transactionBuffer = Buffer.from(apiResponse.tx, 'base64');
        let transaction;
        let isVersioned = false;
        
        try {
            // First try to deserialize as a versioned transaction
            transaction = VersionedTransaction.deserialize(transactionBuffer);
            isVersioned = true;
            console.log('🔧 Detected versioned transaction');
        } catch (versionedError) {
            try {
                // Fall back to legacy transaction format
                transaction = Transaction.from(transactionBuffer);
                isVersioned = false;
                console.log('🔧 Detected legacy transaction');
            } catch (legacyError) {
                throw new Error(`Transaction deserialization failed. Versioned error: ${versionedError.message}, Legacy error: ${legacyError.message}`);
            }
        }
        
        console.log('🔐 Signing transaction...');
        
        // Sign the transaction based on its type
        if (isVersioned) {
            transaction.sign([keypair]);
        } else {
            transaction.sign(keypair);
        }
        
        console.log('📤 Sending transaction to Solana network...');
        
        // Send and confirm transaction
        let signature;
        try {
            if (isVersioned) {
                // For versioned transactions, use connection.sendTransaction
                signature = await connection.sendTransaction(transaction, {
                    skipPreflight: true,
                    maxRetries: 3
                });
                
                // Wait for confirmation
                const confirmation = await connection.confirmTransaction(
                    signature,
                    'processed'
                );
                
                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
                }
            } else {
                // For legacy transactions, use sendAndConfirmTransaction
                signature = await sendAndConfirmTransaction(
                    connection,
                    transaction,
                    [keypair],
                    {
                        skipPreflight: true,
                        commitment: 'processed'
                    }
                );
            }
        } catch (error) {
            // Check if the error contains a successful transaction signature
            const errorMessage = error.message || '';
            
            // Check for signature in error message (old format)
            const signatureMatch = errorMessage.match(/"result":"([A-Za-z0-9]{87,88})"/); 
            console.log(errorMessage)
            // Check if error object contains result with signature (new format)
            let signatureFromResult = null;
            if (error.value && error.value.result && typeof error.value.result === 'string') {
                // Validate it looks like a Solana signature (base58, ~88 chars)
                if (/^[A-Za-z0-9]{87,88}$/.test(error.value.result)) {
                    signatureFromResult = error.value.result;
                }
            }
            
            if (signatureMatch) {
                signature = signatureMatch[1];
                console.log('✅ Transaction submitted successfully (extracted from error message)!');
            } else if (signatureFromResult) {
                signature = signatureFromResult;
                console.log('✅ Transaction submitted successfully (extracted from error result)!');
            } else {
                console.error('Transaction error details:', error);
                console.error('Error value:', error.value);
                throw error;
            }
        }
        
        console.log('🎉 Transaction successful!');
        console.log(`📋 Transaction signature: ${signature}`);
        console.log(`🔗 View on Solscan: https://solscan.io/tx/${signature}`);
        
        // Save transaction result
        const result = {
            success: true,
            signature: signature,
            timestamp: new Date().toISOString(),
            transactionType: isVersioned ? 'versioned' : 'legacy',
            swapDetails: swapRequest,
            explorerUrl: `https://solscan.io/tx/${signature}`
        };
        
        fs.writeFileSync('transaction_result.json', JSON.stringify(result, null, 2));
        console.log('💾 Transaction result saved to transaction_result.json');
        
    } catch (error) {
        console.error('❌ Error occurred:', error.message);
        console.error('Stack trace:', error.stack);
        
        // Save error result
        const errorResult = {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync('transaction_result.json', JSON.stringify(errorResult, null, 2));
        
        process.exit(1);
    }
}

// Check if private key is provided
if (PRIVATE_KEY === 'YOUR_PRIVATE_KEY_HERE') {
    console.error('❌ Please set your private key in the PRIVATE_KEY environment variable or update the script.');
    console.log('💡 Example: PRIVATE_KEY=your_base58_private_key node fetch_swap.js');
    process.exit(1);
}

// Execute the swap
fetchAndExecuteSwap();