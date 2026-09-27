param(
  [string]$Url = "http://127.0.0.1:34843/health",
  [string]$Method = "GET",
  [string]$Token = "",
  [string]$Body = ""
)
$headers = @{}
if ($Token) { $headers["Authorization"] = "Bearer $Token" }
try {
  if ($Method -eq "GET") {
    $r = Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing -TimeoutSec 10
  } else {
    $r = Invoke-WebRequest -Uri $Url -Method $Method -Headers $headers -ContentType "application/json" -Body $Body -UseBasicParsing -TimeoutSec 15
  }
  Write-Output $r.Content
} catch {
  Write-Output ("ERR: " + $_.Exception.Message)
}
