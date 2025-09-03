// JavaScript script to fetch swap transaction, sign and send using Solana RPC

const { Connection, Transaction, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const fs = require('fs');

// Configuration
const API_URL = 'http://localhost:3001/api/swap/85y3AuomcSaUv8tBkxDeoB2GV7HhJrkvxr37PDu8pump';
const RPC_URL = 'https://solana-rpc.publicnode.com';

// You need to provide your private key here (base58 encoded)
// WARNING: Never commit private keys to version control!
const PRIVATE_KEY = '';

async function fetchAndExecuteSwap() {
    try {
        console.log('🚀 Starting swap transaction process...');
        
        // Initialize Solana connection
        const connection = new Connection(RPC_URL, 'confirmed');
        
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
        
        // Prepare swap request body
        const swapRequest = {
            amountIn: 100000,
            type: 'buy',
            slippage: 9900,
            signer: keypair.publicKey.toString(),
            encoding: 'base64' // Request base64 encoded transaction
        };
        
        console.log('📡 Fetching swap transaction from API...');
        
        // Fetch swap transaction from API
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(swapRequest)
        });
        
        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }
        
        const apiResponse = await response.json();
        console.log(apiResponse)
        if (!apiResponse.success) {
            throw new Error(`API error: ${apiResponse.error || 'Unknown error'}`);
        }
        
        console.log('✅ Swap transaction received from API');
        
        // Save API response to result.json
        fs.writeFileSync('result.json', JSON.stringify(apiResponse, null, 2));
        console.log('💾 API response saved to result.json');
        
        // Deserialize the transaction
        const transactionBuffer = Buffer.from(apiResponse.tx, 'base64');
        const transaction = Transaction.from(transactionBuffer);
        
        console.log('🔐 Signing transaction...');
        
        // Sign the transaction
        transaction.sign(keypair);
        
        console.log('📤 Sending transaction to Solana network...');
        
        // Send and confirm transaction
        let signature;
        try {
            signature = await sendAndConfirmTransaction(
                connection,
                transaction,
                [keypair],
                {
                    skipPreflight: true,
                    commitment: 'processed'
                }
            );
        } catch (error) {
            // Check if the error message contains a transaction signature
            const errorMessage = error.message || '';
            const signatureMatch = errorMessage.match(/"result":"([A-Za-z0-9]{87,88})"/); 
            
            if (signatureMatch) {
                signature = signatureMatch[1];
                console.log('✅ Transaction submitted successfully!');
            } else {
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
            swapDetails: swapRequest,
            explorerUrl: `https://solscan.io/tx/${signature}`
        };
        
        fs.writeFileSync('transaction_result.json', JSON.stringify(result, null, 2));
        console.log('💾 Transaction result saved to transaction_result.json');
        
    } catch (error) {
        console.error('❌ Error occurred:', error.message);
        
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