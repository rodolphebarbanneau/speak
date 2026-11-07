import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { log } from '../log'
import { paths } from '../paths'
import { delay } from '../util'

/**
 * Web pages, read as their visible text: the page is loaded in a hidden window (so pages built by
 * scripts, like a GitHub issue, have their content), its text kept in ~/.speak/context/web and
 * fetched again when it's used, at most every few minutes; offline, the last copy is used. The
 * window is sandboxed, with its own session that keeps nothing on disk: no sign-in, no download,
 * no permission, no popup. Pages that need a sign-in show what a signed-out visitor sees.
 */

const REFRESH_MS = 10 * 60_000
const LOAD_TIMEOUT_MS = 30_000
const PARTITION = 'speak-context'

export interface Page {
  url: string
  title: string
  text: string
  at: number
}

export const pageFile = (url: string) => join(paths.context, 'web', `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.json`)

let sessionReady = false

function contextSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION)
  if (sessionReady) return ses
  sessionReady = true
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  // A plain browser: some sites turn away what looks like an embedded app.
  ses.setUserAgent(app.userAgentFallback.replace(/\s(?:Electron|speak)\/\S+/gi, ''))
  return ses
}

function tidy(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function render(url: string): Promise<Page> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1600,
    webPreferences: {
      session: contextSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      images: false,
      webgl: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let status = 0
  win.webContents.on('did-navigate', (_e, _url, code) => (status = code))
  try {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${url} took too long to load`)), LOAD_TIMEOUT_MS)
    })
    try {
      await Promise.race([win.loadURL(url), timeout])
    } finally {
      clearTimeout(timer)
    }
    if (status >= 400) throw new Error(`${url} answered ${status}`)
    const read = async () => tidy(String(await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true)))
    // Pages that draw their content with scripts: wait until the text stops changing (4 s at most).
    let text = await read()
    for (let i = 0; i < 10; i++) {
      await delay(400)
      const next = await read()
      if (next && next.length === text.length) break
      text = next
    }
    if (!text) throw new Error(`No text to read on ${url}${/\.pdf($|[?#])/i.test(url) ? ': PDF files are not supported' : ''}`)
    return { url, title: win.webContents.getTitle(), text, at: Date.now() }
  } catch (err) {
    const message = (err as Error).message.replace(/^Error: /, '')
    const code = message.match(/\bERR_[A-Z_]+/)?.[0]
    // ERR_ABORTED: the address is a file to download (a PDF, an archive), not a page.
    if (code === 'ERR_ABORTED') throw new Error(`${url} is not a web page (a file to download?)`)
    if (code) throw new Error(`Could not load ${url}: check the address and your connection (${code.toLowerCase().replace(/^err_/, '').replace(/_/g, ' ')})`)
    throw new Error(message)
  } finally {
    win.destroy()
  }
}

/** The page at `url`, from Speak's copy when it's recent, else loaded again. */
export async function readPage(url: string, refresh = false): Promise<Page> {
  const file = pageFile(url)
  const cached = await readFile(file, 'utf8')
    .then((s) => JSON.parse(s) as Page)
    .catch(() => null)
  if (cached && !refresh && Date.now() - cached.at < REFRESH_MS) return cached
  try {
    const page = await render(url)
    await mkdir(join(paths.context, 'web'), { recursive: true })
    await writeFile(file, JSON.stringify(page))
    log.info(`Read ${url}: ${page.text.length} characters`)
    return page
  } catch (err) {
    if (!cached) throw err
    log.warn(`Could not read ${url} again, using the copy from before:`, (err as Error).message)
    return cached
  }
}

export async function removePage(url: string): Promise<void> {
  await rm(pageFile(url), { force: true })
}
