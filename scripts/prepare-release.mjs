#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs'

const [tag, notesPath, sourceSha] = process.argv.slice(2)
const repository = process.env.GITHUB_REPOSITORY
const token = process.env.GITHUB_TOKEN

function fail(message) {
  console.error(`Prepare release error: ${message}`)
  process.exit(1)
}

function requireValue(value, name) {
  if (!value) {
    fail(`${name} is required.`)
  }
  return value
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${requireValue(token, 'GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const body = await response.text()
    fail(`GitHub API ${response.status} for ${path}: ${body}`)
  }

  if (response.status === 204) {
    return undefined
  }

  return response.json()
}

function releaseOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT
  if (!output) {
    fail('GITHUB_OUTPUT is required.')
  }
  appendFileSync(output, `${name}=${value}\n`, 'utf8')
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
requireValue(notesPath, 'release notes path argument')
requireValue(sourceSha, 'source SHA argument')
requireValue(repository, 'GITHUB_REPOSITORY')
if (repository !== 'leftautomated/macroni-releases') {
  fail(`refusing to prepare a release in "${repository}".`)
}

const version = tag.replace(/^v/, '')
if (
  tag !== `v${version}` ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  fail(`"${tag}" must be a stable v-prefixed semantic version.`)
}

if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  fail(`"${sourceSha}" is not a full Git commit SHA.`)
}

const [owner, repo] = repository.split('/')
if (!owner || !repo) {
  fail(`GITHUB_REPOSITORY "${repository}" is invalid.`)
}

const renderedNotes = readFileSync(notesPath, 'utf8').trimEnd()
const expectedMarker = `<!-- macroni-release:v1 version=${version} `
if (!renderedNotes.includes(expectedMarker)) {
  fail(`release notes do not contain the ${version} schema marker.`)
}

const provenanceMarker = `<!-- macroni-source-sha:${sourceSha} -->`
const body = `${renderedNotes}\n\n${provenanceMarker}\n`
let release = await findRelease(owner, repo, tag)

if (release && !release.draft) {
  fail(`${tag} is already published and cannot be rebuilt.`)
}

const releaseProperties = {
  tag_name: tag,
  target_commitish: 'main',
  name: `Macroni ${tag} Beta`,
  body,
  draft: true,
  prerelease: false,
}

if (release) {
  release = await github(`/repos/${owner}/${repo}/releases/${release.id}`, {
    method: 'PATCH',
    body: JSON.stringify(releaseProperties),
  })
} else {
  release = await github(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    body: JSON.stringify(releaseProperties),
  })
}

const assets = await github(
  `/repos/${owner}/${repo}/releases/${release.id}/assets?per_page=100`,
)
await Promise.all(
  assets.map((asset) =>
    github(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
      method: 'DELETE',
    }),
  ),
)

console.log(
  `Prepared clean draft ${tag} at ${release.html_url}; removed ${assets.length} stale assets.`,
)
releaseOutput('release_id', release.id)
releaseOutput('release_url', release.html_url)
