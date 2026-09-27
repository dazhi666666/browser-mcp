param([int]$TargetPid)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W3{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h, int n);}'
$p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output "no window"; exit 1 }
[W3]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[W3]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output "focused"
