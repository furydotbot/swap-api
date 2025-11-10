# PowerShell script to fetch swap API response and save to result.json

try {
    Write-Host "Making API request to swap endpoint..."
    
    $response = Invoke-WebRequest -Uri "http://localhost:5551/api/swap/4YznpSqtrT7msybUvLgwPTVyrwx48rrfQv87n9AFpump" -Method POST -Body '{"amountIn":1,"type":"buy","slippage":150,"signer":"85LeSmM6mkGq93V26ky18crjPvGE4zdpEziFLoJVewaU"}' -ContentType "application/json"
    
    $jsonResponse = $response | ConvertFrom-Json
    
    Write-Host "API request successful. Saving response to result.json..."
    
    $jsonResponse | ConvertTo-Json -Depth 10 | Out-File -FilePath "result.json" -Encoding UTF8
    
    Write-Host "Response saved to result.json successfully!"
    Write-Host "Status Code: $($response.StatusCode)"
    
} catch {
    Write-Error "Error occurred: $($_.Exception.Message)"
    exit 1
}