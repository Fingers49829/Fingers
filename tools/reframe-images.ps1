# Trims the thin store frame off product images (Folkcraft green, DulcimerDownloads red, or the Fingers Of
# Steel blue that earlier builds painted in). The site's CSS draws its own thin blue frame around every book
# image, so a frame inside the image would make it look doubled. Images without a frame are left alone.
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

# A ring is 'blue' when nearly all of it is the site's blue, otherwise whatever FrameKind finds.
function RingKind($ring) {
  $isBlue = ($ring.Px | Where-Object { [Math]::Abs($_.R - $blue.R) -le 30 -and [Math]::Abs($_.G - $blue.G) -le 30 -and [Math]::Abs($_.B - $blue.B) -le 30 }).Count
  if ($isBlue -ge 0.8 * $ring.Px.Count) { return 'blue' }
  return FrameKind $ring
}

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

  $kind = RingKind (Ring $b 0)
  if (-not $kind) { $b.Dispose(); $skipped++; continue }

  # Frame depth: inner rings of the same kind (stopping at 8px so a cover's own edge color is never swallowed).
  # Blue frames painted by earlier builds can be one pixel deeper on the right and bottom.
  $depth = 1
  while ($depth -lt 8 -and (RingKind (Ring $b $depth)) -eq $kind) { $depth++ }
  $far = if ($kind -eq 'blue') { $depth + 1 } else { $depth }

  # Cut the frame off.
  $w = $b.Width; $h = $b.Height
  $rect = New-Object System.Drawing.Rectangle $depth, $depth, ($w - $depth - $far), ($h - $depth - $far)
  $cropped = $b.Clone($rect, $b.PixelFormat)
  $b.Dispose(); $b = $cropped
  if ($path -match '\.png$') { $b.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) } else { $b.Save($path, $jpeg, $quality) }
  $b.Dispose(); $changed++
}
"Trimmed the frame off $changed image(s); left $skipped unchanged"
