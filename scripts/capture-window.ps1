param([int]$TargetPid, [string]$Out = "D:\Browser MCP\browser-mcp\_ui.png")
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W2{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h, out RECT r);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}}'
$p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output "no window"; exit 1 }
$r = New-Object W2+RECT
[W2]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
# PW_RENDERFULLCONTENT=2：即使窗口被遮挡也能拿到完整内容
[W2]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null
$g.ReleaseHdc($dc)
$bmp.Save($Out)
Write-Output "saved ${w}x${h} -> $Out"
