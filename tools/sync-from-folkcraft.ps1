# Rebuilds index.html from the Fingers Of Steel page on Folkcraft.com.
# Run from the repo root:  powershell -File tools\sync-from-folkcraft.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$source = 'https://folkcraft.com/pages/fingers-of-steel'

$html = (Invoke-WebRequest $source -UseBasicParsing).Content

# The page content lives in the main section's <div class="rte">; walk nested divs to find its end.
$sectionAt = $html.IndexOf('__main" class="shopify-section')
$start = $html.IndexOf('<div class="rte">', $sectionAt)
if ($sectionAt -lt 0 -or $start -lt 0) { throw "Couldn't find the page content on $source" }
$depth = 0
$m = ([regex]'<(/?)div\b').Match($html, $start)
while ($m.Success) {
  if ($m.Groups[1].Value -eq '/') { $depth-- } else { $depth++ }
  if ($depth -eq 0) { $end = $html.IndexOf('>', $m.Index) + 1; break }
  $m = $m.NextMatch()
}
$body = $html.Substring($start, $end - $start)

# Book links are relative to Folkcraft.com; make them absolute so they work from this site.
$body = $body -replace 'href="/', 'href="https://folkcraft.com/'
# Use the repo's own copy of the logo instead of Folkcraft's.
$body = $body -replace 'src="[^"]*FingersOfSteel_K_WhiteBorder[^"]*"', 'src="images/fingers-of-steel-logo.png"'

$template = [IO.File]::ReadAllText("$root\tools\page-template.html")
$page = $template.Replace('<!--FOS-BODY-->', $body)
[IO.File]::WriteAllText("$root\index.html", $page, (New-Object Text.UTF8Encoding $false))

$books = ([regex]::Matches($body, 'class="fos-card"')).Count
"Wrote index.html ($books book cards) from $source"
