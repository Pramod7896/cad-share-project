param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][ValidateSet("svg","png")][string]$Format
)

$ErrorActionPreference = "Stop"

if ($Format -ne "svg") {
  throw "render-cad.ps1 currently supports only Format=svg (DXF->SVG). Requested: $Format"
}

function Resolve-Dxf2Svg {
  $node = Get-Command "node" -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  return $null
}

$dxf2svg = Resolve-Dxf2Svg
if (-not $dxf2svg) {
  throw "node not found in PATH."
}

$inputPath = (Resolve-Path $In).Path
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Out)) | Out-Null

# Use a local Node script (dxf-parser based) so we don't depend on broken third-party CLIs.
$backendRoot = Resolve-Path (Join-Path $PSScriptRoot "..") | Select-Object -ExpandProperty Path
$script = Join-Path $backendRoot "scripts\\dxf-render-svg.js"
if (-not (Test-Path $script)) {
  throw "Missing script: $script"
}

& $dxf2svg $script $inputPath $Out | Out-Null

if (-not (Test-Path $Out)) {
  throw "DXF->SVG did not produce output: $Out"
}

exit 0
