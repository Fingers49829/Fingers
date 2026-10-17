# Converts PNG images to JPEG beside them (same name, .jpg) and deletes the PNG. Any transparency is
# flattened onto white. Used by build-site.mjs for store images that come as PNG.
#   powershell -File tools\png-to-jpeg.ps1 -ListFile list.txt   (one .png path per line)
param([Parameter(Mandatory)][string]$ListFile)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$quality = New-Object System.Drawing.Imaging.EncoderParameters 1
# 90 keeps the small type on sheet-music pages crisp.
$quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 90L

$before = 0; $after = 0; $count = 0
foreach ($path in Get-Content $ListFile | Where-Object { $_ }) {
  if (-not (Test-Path $path)) { continue }
  $out = [IO.Path]::ChangeExtension($path, '.jpg')
  $bytes = [IO.File]::ReadAllBytes($path)
  $ms = New-Object IO.MemoryStream (, $bytes)
  $img = [System.Drawing.Image]::FromStream($ms)
  $b = New-Object System.Drawing.Bitmap $img.Width, $img.Height
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
  $g.Dispose(); $img.Dispose(); $ms.Dispose()
  $b.Save($out, $jpeg, $quality)
  $b.Dispose()
  $before += $bytes.Length; $after += (Get-Item $out).Length; $count++
  Remove-Item $path
}
"Converted $count PNG(s) to JPEG: {0:N0} KB -> {1:N0} KB" -f ($before / 1KB), ($after / 1KB)
