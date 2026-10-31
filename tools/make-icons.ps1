# Draws the app icons (PNG) with Windows' built-in System.Drawing. Re-run after changing the design.
# Run:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing

$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'icons'
New-Item -ItemType Directory -Force $out | Out-Null

function Draw-Icon([int]$size, [string]$name, [double]$inset) {
  $bmp = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::FromArgb(11, 11, 12))

  # Red bar along the bottom, a "progress" stripe
  $red = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(229, 32, 46))
  $pad = $size * $inset
  $barH = $size * 0.07
  $g.FillRectangle($red, [single]$pad, [single]($size - $pad - $barH), [single]($size - 2 * $pad), [single]$barH)

  # Big "75"
  $font = [System.Drawing.Font]::new('Arial Black', [single]($size * (0.5 - $inset * 0.6)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = [System.Drawing.StringFormat]::new()
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = [System.Drawing.RectangleF]::new(0, [single](-$size * 0.04), $size, $size)
  $g.DrawString('75', $font, $red, $rect, $fmt)

  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Draw-Icon 180 'apple-touch-icon.png' 0.12
Draw-Icon 192 'icon-192.png' 0.12
Draw-Icon 512 'icon-512.png' 0.12
Draw-Icon 512 'icon-maskable-512.png' 0.2   # extra margin so Android's mask doesn't crop it
Write-Host "Icons written to $out"
