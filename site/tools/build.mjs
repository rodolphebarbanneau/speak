// Builds speak.brbnn.com into _site/ (no dependencies): node site/tools/build.mjs [--serve]
//
// The site is plain files, copied as they are. The one thing built is release.json: the
// installers of Speak's latest release, read from GitHub here so that the page never calls
// another host. The page picks the visitor's installer from it, and without it every
// download link opens the release page instead.
//
// On GitHub Actions (CI is set), a release that can't be read fails the build, so a deploy
// never replaces the live site with one that has lost its direct links. Elsewhere it warns.
// GITHUB_TOKEN, when set, keeps the request clear of the anonymous rate limit.
//
// --serve then serves _site/ at http://localhost:8090 to look at it.

import { cpSync, createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { get } from 'node:https'
import { dirname, extname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(site, '..', '_site')
const REPO = 'rodolphebarbanneau/speak'

/** Installers by system, the one to offer first leading. Archives, manifests and block maps are not for visitors. */
const FORMATS = { windows: ['exe', 'msi'], mac: ['dmg', 'pkg'], linux: ['appimage', 'deb', 'rpm'] }

/** Sorts a release's files into the builds a visitor can install, in offering order. */
export function buildsOf(assets) {
  const builds = []
  for (const { name, browser_download_url: url, size } of assets) {
    if (!name.includes('.')) continue
    const format = name.slice(name.lastIndexOf('.') + 1)
    const os = Object.keys(FORMATS).find((key) => FORMATS[key].includes(format.toLowerCase()))
    if (!os) continue
    const arch = /universal/i.test(name) ? 'universal' : /arm64|aarch64/i.test(name) ? 'arm64' : 'x64'
    builds.push({ os, arch, format, name, url, size })
  }
  const systems = Object.keys(FORMATS)
  const rank = (b) => systems.indexOf(b.os) * 10 + FORMATS[b.os].indexOf(b.format.toLowerCase())
  return builds.sort((a, b) => rank(a) - rank(b))
}

/** GitHub's JSON for a path of its API. node:https rather than fetch, which keeps Node from exiting on Windows. */
function github(path) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'speak-site-build', 'x-github-api-version': '2022-11-28' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return new Promise((resolve, reject) => {
    const request = get(`https://api.github.com${path}`, { headers, agent: false, timeout: 20000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`GitHub answered ${response.statusCode} for ${path}`))
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`GitHub did not answer for ${path}`)))
    request.on('error', reject)
  })
}

async function build() {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(site, out, {
    recursive: true,
    filter: (source) => {
      const path = relative(site, source)
      return path !== 'tools' && !path.startsWith(`tools${sep}`) && path !== 'README.md'
    }
  })

  try {
    const latest = await github(`/repos/${REPO}/releases/latest`)
    const release = {
      version: latest.tag_name.replace(/^v/, ''),
      page: latest.html_url,
      published: latest.published_at,
      builds: buildsOf(latest.assets)
    }
    if (release.builds.length === 0) throw new Error(`release ${latest.tag_name} has no installers`)
    writeFileSync(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`)
    console.log(`release.json: v${release.version}, ${release.builds.map((b) => b.name).join(', ')}`)
  } catch (error) {
    if (process.env.CI) throw error
    console.warn(`No release.json (${error.message}): the download links will open the release page.`)
  }
  console.log(`Built ${relative(process.cwd(), out) || out}`)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

function serve(port = 8090) {
  createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname))
    let file = join(out, path)
    if (!file.startsWith(out)) return response.writeHead(403).end()
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) return response.writeHead(404).end('Not found')
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
    createReadStream(file).pipe(response)
  }).listen(port, '127.0.0.1', () => console.log(`Serving _site at http://localhost:${port}/`))
}

await build()
if (process.argv.includes('--serve')) serve()
