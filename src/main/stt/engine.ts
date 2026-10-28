import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import extractZip from 'extract-zip'
import * as tar from 'tar'
import { LANGUAGES } from '../../shared/constants'
import type { BinaryVariant, EngineId, EngineStatus } from '../../shared/types'
import { configStore } from '../config'
import { downloads } from '../download'
import { log } from '../log'
import { paths } from '../paths'
import { delay, findDirContaining, freePort, isLinux, isMac, isWin, lowerPriority, run, shellEnv, which } from '../util'
import { binaryOption, binaryOptions, MODELS, VAD_MODEL, WHISPER_CPP_TAG, type ModelDef } from './catalog'

const exe = (name: string) => (isWin ? `${name}.exe` : name)
const SERVER = exe('whisper-server')
const PARAKEET = exe('parakeet-cli')
const MANAGED_DIR = join(paths.bin, 'whisper-cpp')
const MANIFEST = join(MANAGED_DIR, 'installed.json')

interface Manifest {
  variant: BinaryVariant
  tag: string
  dir: string
}

interface BinaryLocation {
  dir: string
  source: 'custom' | 'managed' | 'bundled' | 'system'
  variant?: string
}

export interface TranscribeOptions {
  language: string
  prompt?: string
  signal?: AbortSignal
}

export interface TranscribeResult {
  text: string
  /** The language whisper detected, when asked to auto-detect (Parakeet doesn't say). */
  detected?: string
  engine: EngineId
  model: string
  ms: number
}

/** whisper names languages in English ("french"): Speak's ISO code, or that name when Speak has none. */
function languageCode(name: string): string {
  return LANGUAGES.find((l) => l.name.toLowerCase() === name)?.code ?? name
}

function threads(): number {
  const n = configStore.get().transcription.threads
  return n > 0 ? n : Math.max(2, Math.min(8, availableParallelism() - 1))
}

function childEnv(binDir: string): NodeJS.ProcessEnv {
  const env = { ...shellEnv() }
  if (isLinux) env.LD_LIBRARY_PATH = [binDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  if (isMac) env.DYLD_LIBRARY_PATH = [binDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':')
  return env
}

class Engine {
  private server: ChildProcess | null = null
  private serverPort = 0
  private serverKey = ''
  private starting: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private gpu: EngineStatus['gpu'] | null = null

  modelPath(def: ModelDef): string {
    return join(paths.models, def.engine, def.file)
  }

  vadPath(): string {
    return join(paths.models, 'vad', VAD_MODEL.file)
  }

  async locateBinary(): Promise<BinaryLocation | null> {
    const custom = configStore.get().transcription.customBinDir.trim()
    if (custom) return existsSync(join(custom, SERVER)) || existsSync(join(custom, PARAKEET)) ? { dir: custom, source: 'custom' } : null
    try {
      const m = JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest
      if (existsSync(join(m.dir, SERVER))) return { dir: m.dir, source: 'managed', variant: m.variant }
    } catch {
      // not installed
    }
    if (app.isPackaged) {
      const bundled = join(process.resourcesPath, 'whisper')
      if (existsSync(join(bundled, SERVER))) return { dir: bundled, source: 'bundled', variant: isMac && process.arch === 'arm64' ? 'metal' : 'cpu' }
    }
    const system = which('whisper-server')
    if (system) return { dir: dirname(system), source: 'system' }
    return null
  }

  async detectGpu(): Promise<EngineStatus['gpu']> {
    if (this.gpu) return this.gpu
    this.gpu = { nvidia: false }
    if (!isMac) {
      try {
        const r = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeoutMs: 5000 })
        if (r.code === 0 && r.stdout.trim()) this.gpu = { nvidia: true, name: r.stdout.trim().split('\n')[0] }
      } catch {
        // no NVIDIA driver
      }
    }
    return this.gpu
  }

  async status(): Promise<EngineStatus> {
    const bin = await this.locateBinary()
    const gpu = await this.detectGpu()
    const options = binaryOptions()
    let platformNote: string | undefined
    if (isMac) {
      platformNote =
        'whisper.cpp publishes no macOS command-line builds. Release builds of Speak bundle them; otherwise install with Homebrew (brew install whisper-cpp) or point to a folder containing whisper-server.'
    } else if (!options.length) {
      platformNote = 'No prebuilt whisper.cpp for this platform. Build whisper.cpp and set the binary folder below.'
    }
    return {
      platform: `${process.platform}-${process.arch}`,
      binary: {
        found: !!bin,
        dir: bin?.dir,
        source: bin?.source,
        variant: bin?.variant,
        hasParakeet: !!bin && existsSync(join(bin.dir, PARAKEET))
      },
      binaryOptions: options,
      recommendedVariant: await this.recommendedVariant(),
      platformNote,
      gpu,
      models: MODELS.map((m) => ({ ...m, installed: existsSync(this.modelPath(m)) })),
      vadInstalled: existsSync(this.vadPath()),
      serverRunning: !!this.server
    }
  }

  /** The build to install on this machine: CUDA 12 with an NVIDIA GPU, else the CPU build. */
  async recommendedVariant(): Promise<BinaryVariant | undefined> {
    const options = binaryOptions()
    if (!options.length) return undefined
    if ((await this.detectGpu()).nvidia && options.some((o) => o.variant === 'cuda12')) return 'cuda12'
    return options.find((o) => o.variant === 'cpu')?.variant ?? options[0].variant
  }

  async installBinary(variant: BinaryVariant): Promise<void> {
    const opt = binaryOption(variant)
    if (!opt) throw new Error(`No ${variant} build available for ${process.platform}-${process.arch}`)
    const id = 'binary'
    const label = `whisper.cpp ${opt.label}`
    const archive = join(paths.tmp, basename(new URL(opt.url).pathname))
    await downloads.fetch(id, label, opt.url, archive)
    downloads.progress({ id, label, received: 0, total: 0, state: 'extracting' })
    try {
      this.stopServer()
      const target = join(MANAGED_DIR, `${variant}-${WHISPER_CPP_TAG}`)
      await rm(target, { recursive: true, force: true })
      await mkdir(target, { recursive: true })
      if (archive.endsWith('.zip')) await extractZip(archive, { dir: target })
      else await tar.x({ file: archive, cwd: target })
      const dir = await findDirContaining(target, SERVER)
      if (!dir) throw new Error('whisper-server not found in the downloaded archive')
      if (!isWin) {
        for (const f of await readdir(dir)) if (!f.includes('.')) await chmod(join(dir, f), 0o755).catch(() => undefined)
      }
      await writeFile(MANIFEST, JSON.stringify({ variant, tag: WHISPER_CPP_TAG, dir } satisfies Manifest, null, 2))
      // Remove other installed variants.
      for (const entry of await readdir(MANAGED_DIR)) {
        const p = join(MANAGED_DIR, entry)
        if (entry !== basename(target) && entry !== 'installed.json') await rm(p, { recursive: true, force: true })
      }
      downloads.progress({ id, label, received: 1, total: 1, state: 'done' })
      log.info('Installed whisper.cpp', variant, 'in', dir)
    } catch (err) {
      downloads.progress({ id, label, received: 0, total: 0, state: 'error', error: String((err as Error).message) })
      throw err
    } finally {
      await rm(archive, { force: true })
    }
  }

  /**
   * Install a model (if missing). A model is useless without the engine, so when none is installed (and
   * there's a build to download for this platform) the recommended one installs alongside.
   */
  async installModel(id: string): Promise<void> {
    const def = MODELS.find((m) => m.id === id)
    if (!def) throw new Error(`Unknown model ${id}`)
    const dest = this.modelPath(def)
    const variant = (await this.locateBinary()) || downloads.isActive('binary') ? undefined : await this.recommendedVariant()
    const engine = variant ? this.installBinary(variant) : Promise.resolve()
    const model = (async () => {
      await mkdir(dirname(dest), { recursive: true })
      if (def.engine === 'whisper') await this.ensureVad().catch((err) => log.warn('VAD model download failed:', err))
      if (!existsSync(dest)) await downloads.fetch(`model:${id}`, def.label, def.url, dest)
    })()
    await Promise.all([engine, model])
  }

  async deleteModel(id: string): Promise<void> {
    const def = MODELS.find((m) => m.id === id)
    if (!def) return
    if (this.serverKey.includes(this.modelPath(def))) this.stopServer()
    await rm(this.modelPath(def), { force: true })
  }

  private async ensureVad(): Promise<void> {
    if (existsSync(this.vadPath())) return
    await mkdir(dirname(this.vadPath()), { recursive: true })
    await downloads.fetch('model:vad', 'Silero VAD', VAD_MODEL.url, this.vadPath())
  }

  /** Resolve what's needed to transcribe, or throw a user-facing error. */
  private async prepare(): Promise<{ engine: EngineId; def: ModelDef; model: string; bin: BinaryLocation }> {
    const cfg = configStore.get().transcription
    const engine = cfg.engine
    const def = MODELS.find((m) => m.id === (engine === 'whisper' ? cfg.whisperModel : cfg.parakeetModel))
    if (!def) throw new Error('No speech model selected. Choose one in Speak → settings → speech.')
    const model = this.modelPath(def)
    if (!existsSync(model)) throw new Error(`The speech model "${def.label}" is not downloaded. Download it in Speak → settings → speech.`)
    const bin = await this.locateBinary()
    if (!bin) throw new Error('The transcription engine (whisper.cpp) is not installed. Install it in Speak → settings → speech.')
    if (engine === 'parakeet' && !existsSync(join(bin.dir, PARAKEET)))
      throw new Error('This whisper.cpp build has no parakeet-cli. Use Whisper or update the engine.')
    return { engine, def, model, bin }
  }

  /** Start the Whisper server ahead of time (called when recording starts). */
  warmup(): void {
    if (configStore.get().transcription.engine !== 'whisper') return
    this.prepare()
      .then(({ model, bin }) => this.ensureServer(model, bin))
      .catch(() => undefined)
  }

  async transcribe(wav: Buffer, opts: TranscribeOptions): Promise<TranscribeResult> {
    const { engine, def, model, bin } = await this.prepare()
    const started = Date.now()
    const { text, detected } =
      engine === 'whisper' ? await this.transcribeWhisper(wav, model, bin, opts) : { text: await this.transcribeParakeet(wav, model, bin, opts) }
    return { text, detected, engine, model: def.id, ms: Date.now() - started }
  }

  private async transcribeWhisper(wav: Buffer, model: string, bin: BinaryLocation, opts: TranscribeOptions): Promise<{ text: string; detected?: string }> {
    await this.ensureServer(model, bin)
    this.touch()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    // verbose_json also names the language it transcribed.
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0.0')
    form.append('temperature_inc', '0.2')
    form.append('language', opts.language || 'auto')
    if (opts.prompt) form.append('prompt', opts.prompt)
    const res = await fetch(`http://127.0.0.1:${this.serverPort}/inference`, { method: 'POST', body: form, signal: opts.signal })
    const body = await res.text()
    if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 300)}`)
    let parsed: { text?: string; language?: string; error?: string }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error(`Unexpected response from whisper-server: ${body.slice(0, 200)}`)
    }
    if (parsed.error) throw new Error(`Transcription failed: ${parsed.error}`)
    this.touch()
    const auto = !opts.language || opts.language === 'auto'
    return { text: (parsed.text ?? '').trim(), detected: auto && parsed.language ? languageCode(parsed.language) : undefined }
  }

  private async transcribeParakeet(wav: Buffer, model: string, bin: BinaryLocation, opts: TranscribeOptions): Promise<string> {
    const file = join(paths.tmp, `parakeet-${Date.now()}.wav`)
    await writeFile(file, wav)
    try {
      const args = ['-m', model, '-t', String(threads()), '-np', '-f', file]
      if (!configStore.get().transcription.useGpu) args.push('-ng')
      const r = await run(join(bin.dir, PARAKEET), args, { cwd: bin.dir, env: childEnv(bin.dir), timeoutMs: 300_000, signal: opts.signal, lowPriority: true })
      if (r.code !== 0) throw new Error(`parakeet-cli failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
      return r.stdout
        .split('\n')
        .filter((l) => l.trim() && !/^(load_backend|ggml_|parakeet_|main:|system_info)/.test(l.trim()))
        .join(' ')
        .trim()
    } finally {
      await rm(file, { force: true })
    }
  }

  private async ensureServer(model: string, bin: BinaryLocation): Promise<void> {
    const cfg = configStore.get().transcription
    const useVad = cfg.vad && existsSync(this.vadPath())
    const key = JSON.stringify([bin.dir, model, cfg.useGpu, useVad, threads()])
    if (this.server && this.serverKey === key) {
      if (this.starting) await this.starting
      return
    }
    if (this.starting && this.serverKey === key) return this.starting
    this.stopServer()
    this.serverKey = key
    this.starting = this.startServer(model, bin, cfg.useGpu, useVad).finally(() => (this.starting = null))
    return this.starting
  }

  private async startServer(model: string, bin: BinaryLocation, useGpu: boolean, useVad: boolean): Promise<void> {
    const port = await freePort()
    const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads()), '-nt', '-l', 'auto']
    if (!useGpu) args.push('-ng')
    if (useVad) args.push('--vad', '-vm', this.vadPath())
    log.info('Starting whisper-server', args.join(' '))
    const child = spawn(join(bin.dir, SERVER), args, { cwd: bin.dir, env: childEnv(bin.dir), windowsHide: true })
    lowerPriority(child)
    this.server = child
    this.serverPort = port
    let output = ''
    const collect = (d: Buffer) => {
      output = (output + d.toString()).slice(-4000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    let exited = false
    child.on('exit', (code) => {
      exited = true
      log.info('whisper-server exited', code)
      if (this.server === child) {
        this.server = null
        this.serverKey = ''
      }
    })
    child.on('error', (err) => log.error('whisper-server error', err))

    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (exited) throw new Error(`whisper-server failed to start: ${output.trim().split('\n').slice(-4).join(' ')}`)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        if (res.ok) {
          log.info('whisper-server ready on port', port)
          this.touch()
          return
        }
      } catch {
        // not listening yet
      }
      await delay(200)
    }
    this.stopServer()
    throw new Error('whisper-server did not start within 3 minutes')
  }

  /** Reset the idle timer that unloads the model. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const minutes = configStore.get().transcription.keepLoadedMinutes
    if (minutes > 0) {
      this.idleTimer = setTimeout(() => {
        log.info('Unloading idle whisper-server')
        this.stopServer()
      }, minutes * 60_000)
    }
  }

  /** Whether the Whisper model is in memory, ready for the next transcription. */
  get modelLoaded(): boolean {
    return !!this.server && !this.starting
  }

  /** Stop the server and wait (up to 3 s) for it to exit and hand the memory and the GPU back. */
  async shutdown(): Promise<void> {
    const server = this.server
    this.stopServer()
    if (!server || server.exitCode !== null) return
    await new Promise<void>((resolve) => {
      server.once('exit', () => resolve())
      setTimeout(resolve, 3000).unref()
    })
  }

  stopServer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.server) {
      this.server.kill()
      this.server = null
    }
    this.serverKey = ''
  }
}

export const engine = new Engine()
