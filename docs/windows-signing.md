# Windows release signing

Macroni's Windows release artifacts are signed with Azure Artifact Signing during
the Tauri bundling step. Tauri invokes `scripts/sign-windows.ps1` for the app
executable and for each generated installer before `tauri-action` uploads them to
the draft GitHub release.

Authentication uses GitHub Actions OpenID Connect (OIDC). The Azure workload
identity must trust this subject:

```text
repo:leftautomated/macroni:environment:release
```

No Azure client secret is stored in GitHub.

## GitHub environment variables

Configure these variables on the `release` environment:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Client ID of the federated Entra application |
| `AZURE_TENANT_ID` | Microsoft Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription containing the signing account |
| `AZURE_ARTIFACT_SIGNING_ENDPOINT` | Regional endpoint such as `https://eus.codesigning.azure.net` |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT` | Artifact Signing account name |
| `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE` | Public Trust certificate profile name |

The Entra service principal needs the **Artifact Signing Certificate Profile
Signer** role scoped to the certificate profile.

## Release behavior

The signing configuration is kept in
`src-tauri/tauri.windows-signing.conf.json` and is passed only by the Windows
release job. Ordinary local builds do not require Azure credentials.

Every signature uses SHA-256 and Microsoft's RFC 3161 timestamp service. The
release job fails if the compiled executable or either MSI/NSIS installer has a
missing or invalid Authenticode signature.
