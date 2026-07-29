#!/usr/bin/env node

import { appendFileSync } from 'node:fs'

const [tag] = process.argv.slice(2)
const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN

function fail(message) {
  console.error(`Finalize release error: ${message}`)
  process.exit(1)
}

function requireValue(value, name) {
  if (!value) {
    fail(`${name} is required.`)
  }
  return value
}

async function github(path, options = {}) {
  const { accept, ...requestOptions } = options
  const response = await fetch(`https://api.github.com${path}`, {
    ...requestOptions,
    headers: {
      Accept: accept ?? 'application/vnd.github+json',
      Authorization: `Bearer ${requireValue(token, 'GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const body = await response.text()
    fail(`GitHub API ${response.status} for ${path}: ${body}`)
  }

  if (accept === 'application/octet-stream') {
    return response.text()
  }

  if (response.status === 204) {
    return undefined
  }

  return response.json()
}

function releaseOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    appendFileSync(output, `${name}=${value}\n`, 'utf8')
  }
}

function expectedAssets(version) {
  const prefix = `macroni-v${version}`
  return [
    `${prefix}-linux-x64.AppImage`,
    `${prefix}-linux-x64.AppImage.sig`,
    `${prefix}-linux-x64.deb`,
    `${prefix}-linux-x64.deb.sig`,
    `${prefix}-macos-arm64.app.tar.gz`,
    `${prefix}-macos-arm64.app.tar.gz.sig`,
    `${prefix}-macos-arm64.dmg`,
    `${prefix}-macos-x64.app.tar.gz`,
    `${prefix}-macos-x64.app.tar.gz.sig`,
    `${prefix}-macos-x64.dmg`,
    `${prefix}-windows-x64-setup.exe`,
    `${prefix}-windows-x64-setup.exe.sig`,
    `${prefix}-windows-x64.msi`,
    `${prefix}-windows-x64.msi.sig`,
  ]
}

async function findRelease(owner, repo, tag) {
  for (let page = 1; page <= 10; page += 1) {
    const releases = await github(
      `/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
    )
    const release = releases.find((candidate) => candidate.tag_name === tag)
    if (release || releases.length < 100) {
      return release
    }
  }

  fail(`could not resolve ${tag} within the first 1,000 releases.`)
}

requireValue(tag, 'tag argument')
requireValue(repository, 'GITHUB_REPOSITORY')
if (repository !== 'leftautomated/macroni-releases') {
  fail(`refusing to finalize a release in "${repository}".`)
}

const version = tag.replace(/^v/, '')
if (
  tag !== `v${version}` ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  fail(`"${tag}" must be a stable v-prefixed semantic version.`)
}

const [owner, repo] = repository.split('/')
if (!owner || !repo) {
  fail(`GITHUB_REPOSITORY "${repository}" is invalid.`)
}

const release = await findRelease(owner, repo, tag)
if (!release) {
  fail(`${tag} does not have a draft release.`)
}
if (!release.draft) {
  fail(`${tag} must remain a draft until final verification succeeds.`)
}

const expectedMarker = `<!-- macroni-release:v1 version=${version} `
if (!release.body?.includes(expectedMarker)) {
  fail(`release body does not contain the ${version} schema marker.`)
}
if (!/<!-- macroni-source-sha:[0-9a-f]{40} -->/.test(release.body)) {
  fail('release body does not contain source provenance.')
}

const assets = await github(
  `/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`,
)
const latestAsset = assets.find((asset) => asset.name === 'latest.json')
const buildAssets = assets.filter((asset) => asset.name !== 'latest.json')
const actualNames = new Set(buildAssets.map((asset) => asset.name))
const expectedNames = expectedAssets(version)
const missing = expectedNames.filter((name) => !actualNames.has(name))
const unexpected = [...actualNames].filter((name) => !expectedNames.includes(name))

if (missing.length > 0 || unexpected.length > 0) {
  const details = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    unexpected.length > 0 ? `unexpected: ${unexpected.join(', ')}` : undefined,
  ].filter(Boolean)
  fail(`release asset contract failed (${details.join('; ')}).`)
}

if (latestAsset) {
  await github(`/repos/${owner}/${repo}/releases/assets/${latestAsset.id}`, {
    method: 'DELETE',
  })
}

const assetByName = new Map(buildAssets.map((asset) => [asset.name, asset]))
const prefix = `macroni-v${version}`

async function updateEntry(bundleName, signatureName) {
  const bundle = assetByName.get(bundleName)
  const signature = assetByName.get(signatureName)
  if (!bundle || !signature) {
    fail(`updater pair ${bundleName} and ${signatureName} is incomplete.`)
  }

  const signatureText = (
    await github(`/repos/${owner}/${repo}/releases/assets/${signature.id}`, {
      accept: 'application/octet-stream',
    })
  ).trim()
  if (!signatureText) {
    fail(`${signatureName} is empty.`)
  }

  return {
    signature: signatureText,
    url: bundle.browser_download_url,
  }
}

const [macArm, macX64, windowsNsis, windowsMsi, linuxAppImage, linuxDeb] =
  await Promise.all([
    updateEntry(
      `${prefix}-macos-arm64.app.tar.gz`,
      `${prefix}-macos-arm64.app.tar.gz.sig`,
    ),
    updateEntry(
      `${prefix}-macos-x64.app.tar.gz`,
      `${prefix}-macos-x64.app.tar.gz.sig`,
    ),
    updateEntry(
      `${prefix}-windows-x64-setup.exe`,
      `${prefix}-windows-x64-setup.exe.sig`,
    ),
    updateEntry(
      `${prefix}-windows-x64.msi`,
      `${prefix}-windows-x64.msi.sig`,
    ),
    updateEntry(
      `${prefix}-linux-x64.AppImage`,
      `${prefix}-linux-x64.AppImage.sig`,
    ),
    updateEntry(
      `${prefix}-linux-x64.deb`,
      `${prefix}-linux-x64.deb.sig`,
    ),
  ])

const updaterMetadata = {
  version,
  notes: release.body,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': macArm,
    'darwin-aarch64-app': macArm,
    'darwin-x86_64': macX64,
    'darwin-x86_64-app': macX64,
    'windows-x86_64': windowsNsis,
    'windows-x86_64-nsis': windowsNsis,
    'windows-x86_64-msi': windowsMsi,
    'linux-x86_64': linuxAppImage,
    'linux-x86_64-appimage': linuxAppImage,
    'linux-x86_64-deb': linuxDeb,
  },
}
const latestJson = `${JSON.stringify(updaterMetadata, null, 2)}\n`
const uploadUrl =
  `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}` +
  '/assets?name=latest.json'
const uploadResponse = await fetch(uploadUrl, {
  method: 'POST',
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${requireValue(token, 'GITHUB_TOKEN')}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body: latestJson,
})
if (!uploadResponse.ok) {
  fail(`latest.json upload failed: ${await uploadResponse.text()}`)
}

const finalAssets = await github(
  `/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`,
)
const finalNames = new Set(finalAssets.map((asset) => asset.name))
const finalExpectedNames = [...expectedNames, 'latest.json']
const finalMissing = finalExpectedNames.filter((name) => !finalNames.has(name))
const finalUnexpected = [...finalNames].filter(
  (name) => !finalExpectedNames.includes(name),
)
if (finalMissing.length > 0 || finalUnexpected.length > 0) {
  fail('final release asset verification failed after uploading latest.json.')
}

console.log(
  `Verified ${finalAssets.length} assets and ${Object.keys(updaterMetadata.platforms).length} updater entries for ${tag}.`,
)
releaseOutput('release_url', release.html_url)
releaseOutput('asset_count', finalAssets.length)
