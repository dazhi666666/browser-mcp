param([int]$TargetPid)
$p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output "no window"; exit 1 }
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);}'
[M]::ShowWindow($p.MainWindowHandle, 6) | Out-Null
Start-Sleep -Milliseconds 500
Write-Output ("minimized=" + [M]::IsIconic($p.MainWindowHandle))
