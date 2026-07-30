# Macroni

This repository hosts signed desktop releases and update metadata for Macroni.

Download the latest version from [Releases](https://github.com/leftautomated/macroni-releases/releases/latest).

The application source is maintained privately.

## Release contract

The manually dispatched `Validate source` workflow checks an exact private
source commit before it can be tagged for release. It runs frontend lint,
typecheck, tests and coverage; Rust formatting, Clippy, tests, coverage and
mutation testing; and the test suite on macOS, Windows, and Linux. Keeping
these release gates in this public repository avoids consuming private
repository Actions minutes without exposing the source or its read-only deploy
key.

The `Release` workflow accepts a `v`-prefixed tag from the private source
repository. It:

1. validates version and changelog metadata and runs the frontend quality gates;
2. creates or resets one draft release for that tag;
3. builds and signs macOS arm64/x64, Windows x64, and Linux x64 in parallel;
4. submits each outer macOS DMG for notarization, staples its ticket, and runs
   Gatekeeper assessment;
5. verifies the exact 14 build assets, then centrally creates `latest.json`
   with all supported updater platform keys.

The build workflow never publishes the release. After the `finalize` job is
green, dispatch `Promote release`, confirm permanent publication, and approve
the protected `release-promotion` environment. Promotion re-verifies the draft,
publishes it under GitHub release immutability, then idempotently projects its
public metadata into Convex.

Signing credentials remain in this repository's `release` environment. The
private source deploy key is read-only. GitHub Actions dependencies are pinned
to full commit SHAs, and no signing secret is copied to the website, Vercel, or
Convex. The separate promotion environment contains only the release-ingestion
token and URL.
