# Recolors the thin store frame around product images (Folkcraft green, DulcimerDownloads red) to the
# Fingers Of Steel blue. Images without one of those frames, or already blue, are left alone.
#   powershell -File tools\reframe-images.ps1                     every image in images\books
#   powershell -File tools\reframe-images.ps1 -ListFile list.txt  just the images listed (one path per line)
param([string[]]$Paths, [string]$ListFile)

Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
if ($ListFile) { $Paths = Get-Content $ListFile | Where-Object { $_ } }
elseif (-not $Paths) { $Paths = Get-ChildItem (Join-Path $root 'images\books') -File | Where-Object Extension -in '.jpg', '.jpeg', '.png' | ForEach-Object FullName }

$blue = [System.Drawing.Color]::FromArgb(0x1f, 0x4e, 0x79)

# A store frame is green (Folkcraft) or dark red (DulcimerDownloads) nearly all the way around. The frame is
# thin and blends with the art next to it (bright magenta, orange, white pages...), so each edge pixel is
# compared with the pixel 5px further in: it counts as frame if it's green/red itself, or clearly greener/redder
# than the art beside it. Images without a frame (edge matches the inside) and already-blue frames don't qualify.
function FrameKind($ring) {
  $n = $ring.Px.Count
  $green = 0; $red = 0
  for ($i = 0; $i -lt $n; $i++) {
    $p = $ring.Px[$i]; $q = $ring.In[$i]
    $pg = $p.G - [Math]::Max($p.R, $p.B); $qg = $q.G - [Math]::Max($q.R, $q.B)
    $pr = $p.R - [Math]::Max($p.G, $p.B); $qr = $q.R - [Math]::Max($q.G, $q.B)
    if ($pg -ge 6 -or ($pg - $qg -ge 25 -and $pg -gt -90)) { $green++ }
    if (($pr -ge 25 -and $p.R -lt 170) -or ($pr - $qr -ge 25 -and $p.R -lt 170)) { $red++ }
  }
  if ($green -ge 0.8 * $n) { return 'green' }
  if ($red -ge 0.8 * $n) { return 'red' }
  return $null
}
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$quality = New-Object System.Drawing.Imaging.EncoderParameters 1
$quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 92L

# Average color and spread of one ring of pixels, $d pixels in from the edge (sampled).
# One ring of pixels $d in from the edge (sampled), each paired with the pixel 5px further in.
function Ring($b, $d) {
  $w = $b.Width; $h = $b.Height; $e = $d + 5
  $px = New-Object System.Collections.Generic.List[object]; $in = New-Object System.Collections.Generic.List[object]
  for ($x = $e; $x -lt $w - $e; $x += 4) {
    $px.Add($b.GetPixel($x, $d)); $in.Add($b.GetPixel($x, $e))
    $px.Add($b.GetPixel($x, $h - 1 - $d)); $in.Add($b.GetPixel($x, $h - 1 - $e))
  }
  for ($y = $e; $y -lt $h - $e; $y += 4) {
    $px.Add($b.GetPixel($d, $y)); $in.Add($b.GetPixel($e, $y))
    $px.Add($b.GetPixel($w - 1 - $d, $y)); $in.Add($b.GetPixel($w - 1 - $e, $y))
  }
  @{ Px = $px; In = $in }
}

$changed = 0; $skipped = 0
foreach ($path in $Paths) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $ms = New-Object IO.MemoryStream (, $bytes)
  $img = [System.Drawing.Image]::FromStream($ms)
  $b = New-Object System.Drawing.Bitmap $img
  $img.Dispose(); $ms.Dispose()

  $outer = Ring $b 0
  $alreadyBlue = ($outer.Px | Where-Object { [Math]::Abs($_.R - $blue.R) -le 30 -and [Math]::Abs($_.G - $blue.G) -le 30 -and [Math]::Abs($_.B - $blue.B) -le 30 }).Count
  $kind = if ($alreadyBlue -ge 0.8 * $outer.Px.Count) { $null } else { FrameKind $outer }
  if (-not $kind) { $b.Dispose(); $skipped++; continue }

  # Frame depth: inner rings of the same kind (stopping at 8px so a cover's own edge color is never swallowed).
  $depth = 1
  while ($depth -lt 8 -and (FrameKind (Ring $b $depth)) -eq $kind) { $depth++ }

  # JPEG stores color in 2x2 pixel blocks, so a 1px colored line turns muddy. Make each side at least 2px and
  # end on a block boundary so the frame stays a clean blue.
  $w = $b.Width; $h = $b.Height
  $top = [Math]::Max(2, $depth); if ($top % 2) { $top++ }
  $left = $top
  $bottom = [Math]::Max(2, $depth); if (($h - $bottom) % 2) { $bottom++ }
  $right = [Math]::Max(2, $depth); if (($w - $right) % 2) { $right++ }
  $g = [System.Drawing.Graphics]::FromImage($b)
  $pen = New-Object System.Drawing.SolidBrush $blue
  $g.FillRectangle($pen, 0, 0, $w, $top); $g.FillRectangle($pen, 0, $h - $bottom, $w, $bottom)
  $g.FillRectangle($pen, 0, 0, $left, $h); $g.FillRectangle($pen, $w - $right, 0, $right, $h)
  $g.Dispose(); $pen.Dispose()
  if ($path -match '\.png$') { $b.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } else { $b.Save($path, $jpeg, $quality) }
  $b.Dispose(); $changed++
}
"Reframed $changed image(s); left $skipped unchanged"
