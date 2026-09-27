param([int]$TargetPid = 26008)
$p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "process not found"; exit 1 }
Write-Output ("proc: " + $p.ProcessName + " title=" + $p.MainWindowTitle + " handle=" + $p.MainWindowHandle)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);[DllImport("user32.dll")]public static extern bool IsZoomed(IntPtr h);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h, out RECT r);public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}}'
if ($p.MainWindowHandle -ne 0) {
  Write-Output ("minimized=" + [W]::IsIconic($p.MainWindowHandle) + " maximized=" + [W]::IsZoomed($p.MainWindowHandle) + " visible=" + [W]::IsWindowVisible($p.MainWindowHandle))
  $r = New-Object W+RECT
  [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  Write-Output ("rect=" + $r.Left + "," + $r.Top + "-" + $r.Right + "," + $r.Bottom)
}
