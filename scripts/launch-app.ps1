param([switch]$Minimized)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$exe = "D:\Browser MCP\browser-mcp\node_modules\electron\dist\electron.exe"
$app = "D:\Browser MCP\browser-mcp"
if ($Minimized) {
  Start-Process -FilePath $exe -ArgumentList "`"$app`"" -WindowStyle Minimized
} else {
  Start-Process -FilePath $exe -ArgumentList "`"$app`""
}
