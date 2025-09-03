# Swap Transaction Script

This JavaScript script replaces the PowerShell script functionality and provides a complete solution to:
1. Fetch a prepared swap transaction from the API
2. Sign the transaction with your private key
3. Send the transaction to the Solana network
4. Confirm the transaction and provide the signature

## Prerequisites

1. Make sure the API server is running:
   ```bash
   npm run start
   ```

2. Set up your private key as an environment variable (recommended for security):
   ```bash
   # Windows PowerShell
   $env:PRIVATE_KEY="your_base58_private_key_here"
   
   # Windows Command Prompt
   set PRIVATE_KEY=your_base58_private_key_here
   
   # Linux/Mac
   export PRIVATE_KEY="your_base58_private_key_here"
   ```

## Usage

### Method 1: Using Environment Variable (Recommended)
```bash
# Set your private key
$env:PRIVATE_KEY="your_base58_private_key_here"

# Run the script
node fetch_swap.js
```

### Method 2: Edit the Script Directly
1. Open `fetch_swap.js`
2. Replace `YOUR_PRIVATE_KEY_HERE` with your actual base58 encoded private key
3. Run the script:
   ```bash
   node fetch_swap.js
   ```

## Configuration

You can modify the following parameters in the script:

- **API_URL**: The swap endpoint URL (default: localhost:3001)
- **RPC_URL**: Solana RPC endpoint (default: mainnet-beta)
- **Swap Parameters**:
  - `amountIn`: Amount to swap (in SOL for buy, in tokens for sell)
  - `type`: 'buy' or 'sell'
  - `slippage`: Slippage tolerance in basis points (150 = 1.5%)
  - `encoding`: 'base64' or 'base58' for transaction encoding

## Output Files

- **result.json**: Contains the API response with the prepared transaction
- **transaction_result.json**: Contains the final transaction result with signature and explorer link

## Security Notes

⚠️ **IMPORTANT**: Never commit your private key to version control!

- Use environment variables for private keys
- Consider using a dedicated wallet for testing
- Always verify transaction details before signing

## Example Output

```
🚀 Starting swap transaction process...
📝 Using wallet: 85LeSmM6mkGq93V26ky18crjPvGE4zdpEziFLoJVewaU
📡 Fetching swap transaction from API...
✅ Swap transaction received from API
💾 API response saved to result.json
🔐 Signing transaction...
📤 Sending transaction to Solana network...
🎉 Transaction successful!
📋 Transaction signature: 5J7...abc
🔗 View on Solscan: https://solscan.io/tx/5J7...abc
💾 Transaction result saved to transaction_result.json
```

## Troubleshooting

1. **API Connection Issues**: Make sure the API server is running on port 3001
2. **Invalid Private Key**: Ensure your private key is in base58 format
3. **Insufficient Balance**: Make sure your wallet has enough SOL for the transaction and fees
4. **Network Issues**: Check your internet connection and RPC endpoint

## API Response Format

The API now returns transactions in this format:
```json
{
  "success": true,
  "tx": "base64_or_base58_encoded_transaction"
}
```

This prepared transaction is ready to be signed and sent to the network.
