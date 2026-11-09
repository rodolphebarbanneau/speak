import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isMac, isWin, run, shellEnv, which } from '../util'

/**
 * Open an app by its name, as the system's own launcher would: the Run box on Windows (App Paths,
 * PATH), Launch Services on macOS (an app's name or bundle id, else an app whose name has it),
 * the desktop's applications on Linux (their .desktop entries, else a command on the PATH).
 * `background`: without taking the focus, where the system allows (macOS).
 */
export async function openApp(name: string, background: boolean): Promise<void> {
  if (isWin) {
    const r = await run('cmd.exe', ['/d', '/c', 'start', '""', name], { timeoutMs: 10_000 })
    if (r.code !== 0) throw new Error(`Could not open "${name}": ${r.stderr.trim() || `exit ${r.code}`}`)
    return
  }
  if (isMac) return openMac(name, background)
  return openLinux(name)
}

async function openMac(name: string, background: boolean): Promise<void> {
  const flags = background ? ['-g'] : []
  const bundleId = /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(name)
  const r = await run('open', [...flags, bundleId ? '-b' : '-a', name], { timeoutMs: 10_000 })
  if (r.code === 0) return
  const app = findMacApp(name)
  if (app) {
    const again = await run('open', [...flags, app], { timeoutMs: 10_000 })
    if (again.code === 0) return
    throw new Error(`Could not open "${name}": ${again.stderr.trim() || `exit ${again.code}`}`)
  }
  throw new Error(`Could not open "${name}": no app by that name (${r.stderr.trim() || `exit ${r.code}`}).`)
}

/** An installed app whose name is `name` ("mail"), or has it ("outlook" → Microsoft Outlook). */
function findMacApp(name: string): string | null {
  const want = name.toLowerCase().replace(/\.app$/, '')
  const dirs = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]
  let partial: string | null = null
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.endsWith('.app')) continue
      const n = e.slice(0, -4).toLowerCase()
      if (n === want) return join(dir, e)
      if (!partial && n.includes(want)) partial = join(dir, e)
    }
  }
  return partial
}

async function openLinux(name: string): Promise<void> {
  const entry = findDesktopEntry(name)
  if (entry) {
    if (which('gtk-launch') && (await run('gtk-launch', [entry.id], { timeoutMs: 10_000 }).catch(() => null))?.code === 0) return
    if (entry.exec) return launch(entry.exec)
  }
  const bin = which(name) ?? which(name.toLowerCase())
  if (bin) return launch(`"${bin.replace(/"/g, '\\"')}"`)
  throw new Error(`Could not open "${name}": no app by that name.`)
}

/** Started on its own (it outlives Speak's call, and isn't tied to it). */
function launch(command: string): void {
  const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore', env: shellEnv() })
  child.on('error', () => undefined)
  child.unref()
}

/** The desktop's applications (the XDG data folders), by file name or by the name they show. */
function findDesktopEntry(name: string): { id: string; exec: string } | null {
  const want = name.toLowerCase().replace(/\.desktop$/, '')
  const home = process.env.XDG_DATA_HOME || join(homedir(), '.local/share')
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  const dirs = [home, ...dataDirs, '/var/lib/flatpak/exports/share', join(home, 'flatpak/exports/share'), '/var/lib/snapd/desktop'].map((d) =>
    join(d, 'applications')
  )
  let partial: { id: string; exec: string } | null = null
  const seen = new Set<string>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.desktop'))
    } catch {
      continue
    }
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      let body: string
      try {
        body = readFileSync(join(dir, file), 'utf8')
      } catch {
        continue
      }
      // The [Desktop Entry] group only (actions have their own Name and Exec).
      const main = body.split(/^\[(?!Desktop Entry\])/m)[0]
      const field = (key: string) => main.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
      if (field('Type') !== 'Application' || field('NoDisplay') === 'true' || field('Hidden') === 'true') continue
      const id = file.slice(0, -'.desktop'.length)
      // Field codes (%f, %U…) are for files and addresses: none here.
      const entry = {
        id,
        exec: field('Exec')
          .replace(/%%/g, '\0')
          .replace(/%[a-zA-Z]/g, '')
          .replace(/\0/g, '%')
          .trim()
      }
      const shown = field('Name').toLowerCase()
      const last = id.toLowerCase().split('.').pop() ?? ''
      if (shown === want || id.toLowerCase() === want || last === want) return entry
      if (!partial && (shown.includes(want) || id.toLowerCase().includes(want))) partial = entry
    }
  }
  return partial
}
