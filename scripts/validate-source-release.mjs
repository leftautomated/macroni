#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function fail(messages) {
  for (const message of messages) {
    console.error(`Release validation error: ${message}`)
  }
  process.exit(1)
}

function readText(path) {
  return readFileSync(resolve(process.cwd(), 'source', path), 'utf8')
}

function cargoPackageVersion(manifest) {
  const lines = manifest.split('\n')
  const start = lines.findIndex((line) => line.trim() === '[package]')
  if (start === -1) {
    return undefined
  }

  const remainingLines = lines.slice(start + 1)
  const nextSection = remainingLines.findIndex((line) => line.startsWith('['))
  const packageLines =
    nextSection === -1 ? remainingLines : remainingLines.slice(0, nextSection)
  return packageLines
    .find((line) => line.trim().startsWith('version ='))
    ?.match(/^version\s*=\s*"([^"]+)"\s*$/)?.[1]
}

function cargoLockVersion(lockfile) {
  const packages = lockfile.split('[[package]]').slice(1)

  for (const entry of packages) {
    if (/^name\s*=\s*"macroni"\s*$/m.test(entry)) {
      return entry.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
    }
  }

  return undefined
}

const packageJson = JSON.parse(readText('package.json'))
const tauriConfig = JSON.parse(readText('src-tauri/tauri.conf.json'))
const cargoVersion = cargoPackageVersion(readText('src-tauri/Cargo.toml'))
const lockVersion = cargoLockVersion(readText('src-tauri/Cargo.lock'))
const changelog = readText('CHANGELOG.md')
const version = packageJson.version
const requestedTag = process.argv[2] ?? `v${version}`
const expectedTag = `v${version}`
const errors = []

if (
  typeof version !== 'string' ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  errors.push(
    `package.json version "${version}" must be stable semantic versioning without a prerelease suffix.`,
  )
}

if (requestedTag !== expectedTag) {
  errors.push(
    `requested tag "${requestedTag}" does not match package version tag "${expectedTag}".`,
  )
}

for (const [path, value] of [
  ['src-tauri/tauri.conf.json', tauriConfig.version],
  ['src-tauri/Cargo.toml', cargoVersion],
  ['src-tauri/Cargo.lock', lockVersion],
]) {
  if (value !== version) {
    errors.push(`${path} version "${value ?? 'missing'}" must equal "${version}".`)
  }
}

const escapedVersion = version.replaceAll('.', String.raw`\.`)
const changelogHeading = new RegExp(
  String.raw`^## \[${escapedVersion}\] - \d{4}-\d{2}-\d{2}\s*$`,
  'm',
)
if (!changelogHeading.test(changelog)) {
  errors.push(
    `CHANGELOG.md must contain a dated "## [${version}] - YYYY-MM-DD" section.`,
  )
}

if (errors.length > 0) {
  fail(errors)
}

console.log(`Release metadata is consistent for ${expectedTag}.`)
