// Checks the Speak that the release workflow just packaged in dist/, on the runner that built it:
// - Electron's fuses are set as electron-builder.yml asks;
// - when the workflow signed it (SPEAK_SIGNED=1): macOS accepts it (Developer ID, notarized, its
//   ticket stapled), or Windows finds a valid signature on each file signed, from the publisher
//   that updates will be checked against;
// - it starts, and control mode's native parts work (`--self-check`, see src/main/index.ts).
// Prints each check, and exits with 1 if one fails.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'

const signed = process.env.SPEAK_SIGNED === '1'
const failed = []

function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok && detail.trim()) console.log(detail.trim().replace(/^/gm, '     '))
  if (!ok) failed.push(what)
}

function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}` }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
}

// This system's packaged apps (macOS: Apple Silicon and Intel), the first one built for this runner's chip.
const apps = {
  darwin: process.arch === 'arm64' ? ['dist/mac-arm64/Speak.app', 'dist/mac/Speak.app'] : ['dist/mac/Speak.app', 'dist/mac-arm64/Speak.app'],
  win32: ['dist/win-unpacked/Speak.exe'],
  linux: ['dist/linux-unpacked/speak']
}[process.platform].filter((a) => existsSync(a))
if (!apps.length) {
  console.log('FAIL no packaged app in dist/')
  process.exit(1)
}

// --------------------------------------------------------------- fuses

// The fuse wire holds one character per fuse: '1' on, '0' off.
const ON = '1'.charCodeAt(0)
const OFF = '0'.charCodeAt(0)
const FUSES = {
  RunAsNode: OFF,
  EnableNodeOptionsEnvironmentVariable: OFF,
  EnableNodeCliInspectArguments: OFF,
  EnableEmbeddedAsarIntegrityValidation: ON,
  OnlyLoadAppFromAsar: ON
}
for (const app of apps) {
  const wire = await getCurrentFuseWire(app)
  for (const [name, want] of Object.entries(FUSES)) {
    check(wire[FuseV1Options[name]] === want, `${app}: ${name} ${want === ON ? 'on' : 'off'}`)
  }
}

// --------------------------------------------------------------- signatures

if (signed && process.platform === 'darwin') {
  for (const app of apps) {
    const sig = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    check(sig.ok, `${app}: signature intact`, sig.out)
    const gk = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
    check(gk.ok && /Notarized Developer ID/.test(gk.out), `${app}: Gatekeeper accepts it (notarized Developer ID)`, gk.out)
    const ticket = run('xcrun', ['stapler', 'validate', app])
    check(ticket.ok, `${app}: notarization ticket stapled`, ticket.out)
  }
}

if (signed && process.platform === 'win32') {
  const files = [
    ...readdirSync('dist')
      .filter((f) => f.endsWith('.exe'))
      .map((f) => join('dist', f)),
    ...walk('dist/win-unpacked').filter((f) => /\.(exe|dll|node)$/.test(f))
  ]
  const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',')
  const r = run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-AuthenticodeSignature -LiteralPath ${list} | ForEach-Object { "$($_.Status)|$($_.SignerCertificate.Subject)|$($_.Path)" }`
  ])
  check(r.ok, 'signatures read', r.out)
  // Each update is refused unless its installer is signed under one of the names in app-update.yml
  // (electron-updater): a wrong one would keep every installed Speak from updating.
  const installers = new Set(files.filter((f) => dirname(f) === 'dist' || basename(f) === 'Speak.exe').map((f) => resolve(f).toLowerCase()))
  const signers = new Set()
  for (const line of r.out.trim().split(/\r?\n/)) {
    const [status, subject, path] = line.split('|')
    check(status === 'Valid', `${path}: signature valid`, status)
    if (status === 'Valid' && installers.has(resolve(path).toLowerCase())) {
      signers.add(/(?:^|,\s*)CN=("[^"]*"|[^,]*)/.exec(subject)?.[1].replace(/^"|"$/g, ''))
    }
  }
  const yml = readFileSync('dist/win-unpacked/resources/app-update.yml', 'utf8')
  const names = /^publisherName:\s*\n((?:\s+-.*\n?)+)/m
    .exec(yml)?.[1]
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*-\s*/, '')
        .replace(/^['"]|['"]$/g, '')
        .trim()
    )
    .filter(Boolean)
  check(
    signers.size > 0 && !!names?.length && [...signers].every((s) => names.includes(s)),
    `updates checked against the installer's signer (${[...signers].join(', ') || 'none'})`,
    `app-update.yml: publisherName ${JSON.stringify(names ?? [])}`
  )
}

// --------------------------------------------------------------- start

const app = apps[0]
const exe = process.platform === 'darwin' ? join(app, 'Contents/MacOS/Speak') : app
const home = mkdtempSync(join(tmpdir(), 'speak-check-'))
const env = { ...process.env, SPEAK_HOME: home }
delete env.ELECTRON_RUN_AS_NODE
// Linux runners can't set up Chromium's sandbox for an unpacked build (its helper isn't setuid root).
const args = ['--self-check', `--user-data-dir=${join(home, 'electron')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
const result = await new Promise((resolve) => {
  const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const timer = setTimeout(() => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'])
    else child.kill('SIGKILL')
    resolve({ code: 'timeout', out })
  }, 120_000)
  child.on('error', (err) => {
    clearTimeout(timer)
    resolve({ code: 'error', out: `${out}${err.message}` })
  })
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolve({ code, out })
  })
})
check(
  result.code === 0 && /Self-check passed/.test(result.out),
  `${app}: starts, and control mode's native parts work`,
  `exit: ${result.code}\n${result.out.split('\n').slice(-40).join('\n')}`
)

if (failed.length) {
  console.log(`\n${failed.length} check(s) failed: don't publish this draft release.`)
  process.exit(1)
}
console.log('\nAll checks passed.')
