param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

function Resolve-ExePath($candidate) {
  if (-not $candidate) { return $null }
  if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  return $null
}

function Find-OdaFileConverter {
  if ($env:ODA_FILE_CONVERTER) {
    $p = Resolve-ExePath $env:ODA_FILE_CONVERTER
    if ($p) { return $p }
  }

  $candidates = @(
    "C:\\Program Files\\ODA\\ODAFileConverter\\ODAFileConverter.exe",
    "C:\\Program Files (x86)\\ODA\\ODAFileConverter\\ODAFileConverter.exe"
  )

  foreach ($c in $candidates) {
    $p = Resolve-ExePath $c
    if ($p) { return $p }
  }

  # Common newer installs use a versioned folder, e.g.:
  #   C:\Program Files\ODA\ODAFileConverter 27.1.0\ODAFileConverter.exe
  $odaRoots = @(
    "C:\\Program Files\\ODA",
    "C:\\Program Files (x86)\\ODA"
  )

  foreach ($root in $odaRoots) {
    if (-not (Test-Path $root)) { continue }
    $dirs = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "ODAFileConverter*" } |
      Sort-Object -Property Name -Descending

    foreach ($d in $dirs) {
      $exe = Join-Path $d.FullName "ODAFileConverter.exe"
      $p = Resolve-ExePath $exe
      if ($p) { return $p }
    }
  }

  return $null
}

function Ensure-EmptyDir($dir) {
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

function Convert-With-Oda($odaExe, $inputFile, $outputFile) {
  $workRoot = Join-Path $env:TEMP ("cadshare_dwg2dxf_" + [guid]::NewGuid().ToString("N"))
  $inDir = Join-Path $workRoot "in"
  $outDir = Join-Path $workRoot "out"

  try {
    Ensure-EmptyDir $inDir
    Ensure-EmptyDir $outDir

    $srcName = [IO.Path]::GetFileName($inputFile)
    Copy-Item -Force -Path $inputFile -Destination (Join-Path $inDir $srcName)

    # ODAFileConverter syntax:
    #   ODAFileConverter.exe <InputFolder> <OutputFolder> <OutputVersion> <OutputType> <Recurse> <Audit> [<Filter>]
    # We'll output DXF (ASCII) and keep same base name.
    $outputVersion = "ACAD2018"
    $outputType = "DXF"
    $recurse = "0"
    $audit = "1"

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $odaExe
    $psi.Arguments = "`"$inDir`" `"$outDir`" $outputVersion $outputType $recurse $audit"
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()

    if ($p.ExitCode -ne 0) {
      throw "ODAFileConverter failed (exit $($p.ExitCode)).`n$stderr`n$stdout"
    }

    $expected = Join-Path $outDir ([IO.Path]::GetFileNameWithoutExtension($srcName) + ".dxf")
    if (-not (Test-Path $expected)) {
      $found = Get-ChildItem -Path $outDir -Recurse -Filter *.dxf -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $found) {
        throw "ODAFileConverter succeeded but no .dxf was produced.`n$stderr`n$stdout"
      }
      $expected = $found.FullName
    }

    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($outputFile)) | Out-Null
    Copy-Item -Force -Path $expected -Destination $outputFile
  } finally {
    if (Test-Path $workRoot) { Remove-Item -Recurse -Force $workRoot }
  }
}

function Convert-With-LibreDwg($inputFile, $outputFile) {
  $exe = (Get-Command "dwg2dxf" -ErrorAction SilentlyContinue)
  if (-not $exe) { throw "dwg2dxf not found in PATH." }

  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($outputFile)) | Out-Null
  & $exe.Source $inputFile $outputFile | Out-Null

  if (-not (Test-Path $outputFile)) {
    throw "dwg2dxf ran but did not produce output: $outputFile"
  }
}

$inputPath = (Resolve-Path $In).Path
$outPath = $Out

if (-not (Test-Path $inputPath)) {
  throw "Input not found: $inputPath"
}

$oda = Find-OdaFileConverter
if ($oda) {
  Convert-With-Oda -odaExe $oda -inputFile $inputPath -outputFile $outPath
  exit 0
}

# Fallback: LibreDWG's dwg2dxf if installed and on PATH.
Convert-With-LibreDwg -inputFile $inputPath -outputFile $outPath
exit 0
