[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$targetDirectory = Join-Path $PSScriptRoot '..\src-tauri\target'
$artifacts = @(
  Get-ChildItem -Path $targetDirectory -Include '*.msi', '*.exe' -File -Recurse |
    Where-Object {
      ($_.Name -eq 'macroni.exe' -and $_.FullName -match '[\\/]release[\\/]') -or
      $_.FullName -match '[\\/]bundle[\\/](msi|nsis)[\\/]'
    } |
    Sort-Object -Property FullName -Unique
)

if ($artifacts.Count -eq 0) {
  throw "No Windows executables or installers were found beneath '$targetDirectory'."
}

$invalidArtifacts = @(
  foreach ($artifact in $artifacts) {
    $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
    Write-Host "$($signature.Status): $($artifact.FullName)"

    if ($signature.Status -ne 'Valid') {
      $artifact.FullName
    }
  }
)

if ($invalidArtifacts.Count -gt 0) {
  throw "Invalid or missing Authenticode signatures: $($invalidArtifacts -join ', ')"
}
