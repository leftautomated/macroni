[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $FilePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-RequiredEnvironmentVariable {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Name
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required environment variable '$Name' is not set."
  }

  return $value
}

$resolvedFilePath = (Resolve-Path -LiteralPath $FilePath).Path
$endpoint = Get-RequiredEnvironmentVariable 'AZURE_ARTIFACT_SIGNING_ENDPOINT'
$accountName = Get-RequiredEnvironmentVariable 'AZURE_ARTIFACT_SIGNING_ACCOUNT'
$certificateProfile = Get-RequiredEnvironmentVariable 'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE'

Import-Module ArtifactSigning -RequiredVersion 0.1.8 -ErrorAction Stop

$signingParameters = @{
  Endpoint = $endpoint
  CodeSigningAccountName = $accountName
  CertificateProfileName = $certificateProfile
  Files = $resolvedFilePath
  FileDigest = 'SHA256'
  TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'
  TimestampDigest = 'SHA256'
  Description = 'Macroni'
  DescriptionUrl = 'https://github.com/leftautomated/macroni'
  ExcludeEnvironmentCredential = $true
  ExcludeWorkloadIdentityCredential = $true
  ExcludeManagedIdentityCredential = $true
  ExcludeSharedTokenCacheCredential = $true
  ExcludeVisualStudioCredential = $true
  ExcludeVisualStudioCodeCredential = $true
  ExcludeAzureCliCredential = $false
  ExcludeAzurePowerShellCredential = $true
  ExcludeAzureDeveloperCliCredential = $true
  ExcludeInteractiveBrowserCredential = $true
}

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) {
  $signingParameters.CorrelationId = "github-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
}

Write-Host "Signing $resolvedFilePath with Azure Artifact Signing"
Invoke-ArtifactSigning @signingParameters
