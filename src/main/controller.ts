import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Notification, systemPreferences } from 'electron'
import { needsAi } from '../shared/constants'
import type { OverlayState, Phase, PreviewState, Session, SessionAction, SessionVersion, Style } from '../shared/types'
import { aiConfigured, editText, processTranscript } from './ai'
import { cleanTranscript, encodeWav, prepareAudio } from './audio'
import { configStore } from './config'
import { history, newSessionId } from './history'
import { hotkeys } from './hotkeys'
import { log } from './log'
import { captureFocus, restoreFocus, type FocusTarget } from './platform/focus'
import { copyToClipboard, pasteText } from './platform/paste'
import { engine } from './stt/engine'
import { PARAKEET_LANGUAGES } from './stt/catalog'
import { isMac } from './util'
import { broadcast, hideOverlay, hidePreview, onPreviewClose, overlay, preview, previewVisible, showOverlay, showPreview } from './windows'

type Purpose = 'dictation' | 'edit'

const MIN_SPEECH_MS = 250
/** Real microphones always have a noise floor; a peak this low means digital silence. */
const SILENT_PEAK = 1e-4

function noSignalMessage(device: string): string {
  const name = device ? `"${device}"` : 'The microphone'
  return `No signal from ${name}. Pick your microphone in Speak → general → input.`
}

/** Orchestrates: record → transcribe → AI → preview dialog or direct paste. */
class Controller extends EventEmitter {
  phase: Phase = 'idle'
  private purpose: Purpose = 'dictation'
  private target: FocusTarget | null = null
  private recordStartedAt = 0
  private maxTimer: NodeJS.Timeout | null = null
  private abort: AbortController | null = null
  private recorderReq = 0
  private pendingResult: ((r: { samples: Float32Array | null; error?: string }) => void) | null = null
  private pendingStart: ((r: { ok: boolean; error?: string; device?: string }) => void) | null = null
  /** Label of the microphone used by the current/last recording. */
  private device = ''
  private overlayTimer: NodeJS.Timeout | null = null

  /** Session currently shown in the preview dialog. */
  private current: Session | null = null
  private previewBusy: PreviewState['busy'] = null
  private previewError: string | undefined
  private lastText = ''

  constructor() {
    super()
    onPreviewClose(() => void this.previewCancel())
  }

  // ---------------------------------------------------------------- hotkeys

  onShortcutPress(): void {
    if (this.phase === 'idle') void this.startRecording(previewVisible() && this.current ? 'edit' : 'dictation')
    else if (this.phase === 'recording') void this.stopRecording()
    else this.flash({ phase: 'info', message: 'Still working on the previous dictation…' })
  }

  onShortcutRelease(heldMs: number): void {
    const mode = configStore.get().recordMode
    if (this.phase !== 'recording') return
    if (mode === 'hold' || (mode === 'hybrid' && heldMs > 400)) void this.stopRecording()
  }

  toggle(): void {
    this.onShortcutPress()
  }

  // ---------------------------------------------------------------- overlay

  private setPhase(phase: Phase): void {
    this.phase = phase
    hotkeys.setCancelActive(phase !== 'idle')
    this.emit('phase', phase)
  }

  private overlayState(state: OverlayState): void {
    if (this.overlayTimer) clearTimeout(this.overlayTimer)
    this.overlayTimer = null
    broadcast('overlay', state)
    if (!configStore.get().ui.showOverlay && state.phase !== 'error') return
    if (state.phase === 'idle') hideOverlay()
    else showOverlay()
  }

  /** Show a transient message in the overlay. */
  private flash(state: OverlayState, ms = 2200): void {
    this.overlayState(state)
    this.overlayTimer = setTimeout(() => {
      if (this.phase === 'idle') this.overlayState({ phase: 'idle' })
    }, ms)
  }

  private sound(name: 'start' | 'stop' | 'error' | 'done'): void {
    if (configStore.get().audio.sounds) overlay?.webContents.send('speak:recorder', { type: 'sound', name })
  }

  private updatePreviewBusy(busy: PreviewState['busy'], error?: string): void {
    this.previewBusy = busy
    this.previewError = error
    this.sendPreview()
  }

  // ---------------------------------------------------------------- recording

  async startRecording(purpose: Purpose): Promise<void> {
    if (this.phase !== 'idle' || !overlay) return
    const cfg = configStore.get()
    if (isMac && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      if (!granted) return this.fail('Microphone access denied. Allow Speak in System Settings → Privacy & Security → Microphone.')
    }
    this.purpose = purpose
    this.setPhase('recording')
    if (purpose === 'dictation') this.target = await captureFocus()
    this.recordStartedAt = Date.now()
    this.overlayState({ phase: 'recording', purpose, startedAt: this.recordStartedAt })
    if (purpose === 'edit') this.updatePreviewBusy('listening')
    engine.warmup()

    const started = await new Promise<{ ok: boolean; error?: string; device?: string }>((resolve) => {
      this.pendingStart = resolve
      overlay!.webContents.send('speak:recorder', { type: 'start', deviceId: cfg.audio.deviceId, deviceLabel: cfg.audio.deviceLabel, sounds: cfg.audio.sounds })
      setTimeout(() => resolve({ ok: false, error: 'Microphone did not start (timeout).' }), 8000)
    })
    this.pendingStart = null
    if (!started.ok) {
      this.setPhase('idle')
      if (purpose === 'edit') this.updatePreviewBusy(null, started.error)
      return this.fail(started.error ?? 'Could not start the microphone.')
    }
    this.device = started.device ?? ''
    log.info(`Recording from "${this.device}"`)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = setTimeout(() => {
      if (this.phase === 'recording') void this.stopRecording()
    }, cfg.audio.maxSeconds * 1000)
  }

  recorderStarted(ok: boolean, error?: string, device?: string): void {
    this.pendingStart?.({ ok, error, device })
  }

  /** The recorder saw only digital silence: stop now instead of letting the user talk into the void. */
  recorderNoSignal(device: string): void {
    if (this.phase !== 'recording') return
    overlay?.webContents.send('speak:recorder', { type: 'cancel' })
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.setPhase('idle')
    const message = noSignalMessage(device)
    if (this.purpose === 'edit') this.updatePreviewBusy(null, message)
    this.fail(message, 7000)
  }

  recorderResult(reqId: number, samples: Float32Array | null, error?: string): void {
    if (reqId === this.recorderReq) this.pendingResult?.({ samples, error })
  }

  async stopRecording(): Promise<void> {
    if (this.phase !== 'recording' || !overlay) return
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.setPhase('transcribing')
    this.overlayState({ phase: 'transcribing', purpose: this.purpose })
    if (this.purpose === 'edit') this.updatePreviewBusy('transcribing')
    const reqId = ++this.recorderReq
    const result = await new Promise<{ samples: Float32Array | null; error?: string }>((resolve) => {
      this.pendingResult = resolve
      overlay!.webContents.send('speak:recorder', { type: 'stop', reqId })
      setTimeout(() => resolve({ samples: null, error: 'Recorder did not respond.' }), 10_000)
    })
    this.pendingResult = null
    if ((this.phase as Phase) !== 'transcribing') return // cancelled meanwhile
    if (!result.samples) {
      this.setPhase('idle')
      return this.fail(result.error ?? 'No audio captured.')
    }
    log.info(`Captured ${(result.samples.length / 16000).toFixed(1)}s of audio`)
    await this.handleAudio(result.samples)
  }

  cancel(): void {
    if (this.phase === 'idle') return
    log.info('Cancelled during', this.phase)
    if (this.phase === 'recording') overlay?.webContents.send('speak:recorder', { type: 'cancel' })
    this.pendingResult?.({ samples: null, error: 'Cancelled' })
    this.abort?.abort()
    this.abort = null
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.setPhase('idle')
    if (this.purpose === 'edit') this.updatePreviewBusy(null)
    this.flash({ phase: 'info', message: 'Cancelled' }, 1200)
  }

  private fail(message: string, ms = 4500): void {
    log.warn(message)
    this.sound('error')
    this.flash({ phase: 'error', message }, ms)
  }

  // ---------------------------------------------------------------- pipeline

  /** Run the pipeline on recorded (or loaded) 16 kHz mono samples. */
  async handleAudio(raw: Float32Array, opts: { target?: FocusTarget | null } = {}): Promise<void> {
    if (opts.target !== undefined) this.target = opts.target
    const cfg = configStore.get()
    if (this.phase === 'idle') this.setPhase('transcribing')
    const abort = new AbortController()
    this.abort = abort
    const purpose = this.purpose
    try {
      const prepared = prepareAudio(raw)
      log.info(`Audio: ${(prepared.durationMs / 1000).toFixed(1)}s, peak ${prepared.peak.toFixed(4)}, speech ${(prepared.speechMs / 1000).toFixed(1)}s`)
      if (prepared.peak < SILENT_PEAK) {
        this.setPhase('idle')
        const message = noSignalMessage(this.device)
        if (purpose === 'edit') this.updatePreviewBusy(null, message)
        return this.fail(message, 7000)
      }
      if (prepared.speechMs < MIN_SPEECH_MS) {
        this.setPhase('idle')
        if (purpose === 'edit') this.updatePreviewBusy(null)
        return this.flash({ phase: 'info', message: this.device ? `No speech detected (mic: ${this.device})` : 'No speech detected' }, 3500)
      }
      const wav = encodeWav(prepared.samples)
      const language = cfg.language.input
      const t = await engine.transcribe(wav, { language, prompt: this.whisperPrompt(), signal: abort.signal })
      const transcript = cleanTranscript(t.text)
      log.info(`Transcribed ${Math.round(prepared.durationMs)}ms of audio in ${t.ms}ms (${t.engine}/${t.model})`)
      if (abort.signal.aborted) return
      if (!transcript) {
        this.setPhase('idle')
        if (purpose === 'edit') this.updatePreviewBusy(null)
        return this.flash({ phase: 'info', message: 'No speech recognized' })
      }

      if (purpose === 'edit') return await this.applyVoiceEdit(transcript, abort.signal)

      const now = new Date().toISOString()
      const session: Session = {
        id: newSessionId(),
        createdAt: now,
        updatedAt: now,
        durationMs: Math.round(prepared.durationMs),
        hasAudio: cfg.history.keepAudio,
        transcription: { engine: t.engine, model: t.model, language, ms: t.ms, text: transcript },
        style: cfg.style,
        outputLanguage: cfg.language.output,
        versions: [],
        text: transcript
      }
      if (t.engine === 'parakeet' && language !== 'auto' && !PARAKEET_LANGUAGES.has(language)) {
        log.warn(`Parakeet does not support "${language}"`)
      }
      const audio = encodeWav(raw)

      if (needsAi(session.style, session.outputLanguage)) {
        if (!aiConfigured()) {
          session.error = 'AI processing is off (Settings → AI). Showing the raw transcript.'
        } else {
          this.setPhase('processing')
          this.overlayState({ phase: 'processing', purpose })
          try {
            const r = await processTranscript(transcript, {
              inputLanguage: language,
              style: session.style,
              outputLanguage: session.outputLanguage,
              signal: abort.signal
            })
            if (abort.signal.aborted) return
            this.addVersion(session, {
              kind: 'processed',
              text: r.text,
              style: session.style,
              outputLanguage: session.outputLanguage,
              provider: r.provider,
              model: r.model,
              ms: r.ms
            })
          } catch (err) {
            if (abort.signal.aborted) return
            session.error = (err as Error).message
            log.warn('AI processing failed:', session.error)
          }
        }
      }
      await history.save(session, audio)
      this.setPhase('idle')

      if (cfg.output.mode === 'paste' && !session.error) {
        this.overlayState({ phase: 'idle' })
        const ok = await pasteText(session.text, { keys: cfg.output.pasteKeys, restoreClipboard: cfg.output.restoreClipboard })
        await this.finish(session, ok ? 'pasted' : 'copied')
        if (ok) this.sound('done')
        else this.notify('Copied to clipboard', 'Speak could not paste automatically. Press Ctrl+V / ⌘V to insert the text.')
        return
      }
      this.overlayState({ phase: 'idle' })
      this.openPreview(session)
    } catch (err) {
      if (abort.signal.aborted) return
      this.setPhase('idle')
      if (purpose === 'edit') this.updatePreviewBusy(null, (err as Error).message)
      this.fail((err as Error).message)
    } finally {
      if (this.abort === abort) this.abort = null
    }
  }

  private whisperPrompt(): string | undefined {
    const vocab = configStore
      .get()
      .vocabulary.split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean)
    return vocab.length ? vocab.join(', ') + '.' : undefined
  }

  private addVersion(session: Session, v: Omit<SessionVersion, 'id' | 'at'>): void {
    session.versions.push({ id: randomBytes(3).toString('hex'), at: new Date().toISOString(), ...v })
    session.text = v.text
    session.updatedAt = new Date().toISOString()
    if (v.style) session.style = v.style
    if (v.outputLanguage) session.outputLanguage = v.outputLanguage
    delete session.error
  }

  // ---------------------------------------------------------------- preview dialog

  private openPreview(session: Session): void {
    this.current = session
    this.previewBusy = null
    this.previewError = session.error
    this.sendPreview()
    showPreview()
  }

  private sendPreview(): void {
    if (!this.current || !preview) return
    const state: PreviewState = {
      session: this.current,
      busy: this.previewBusy,
      error: this.previewError,
      targetTitle: this.target?.title
    }
    preview.webContents.send('speak:preview', state)
  }

  previewReady(): void {
    this.sendPreview()
  }

  private async applyVoiceEdit(instruction: string, signal: AbortSignal): Promise<void> {
    const session = this.current
    if (!session) {
      this.setPhase('idle')
      return
    }
    this.setPhase('processing')
    this.overlayState({ phase: 'processing', purpose: 'edit' })
    this.updatePreviewBusy('processing')
    try {
      const r = await editText(session.text, instruction, signal)
      if (signal.aborted) return
      this.addVersion(session, { kind: 'edit', text: r.text, instruction, provider: r.provider, model: r.model, ms: r.ms })
      await history.save(session)
      this.setPhase('idle')
      this.overlayState({ phase: 'idle' })
      this.updatePreviewBusy(null)
      showPreview()
    } catch (err) {
      if (signal.aborted) return
      this.setPhase('idle')
      this.overlayState({ phase: 'idle' })
      this.updatePreviewBusy(null, (err as Error).message)
    }
  }

  async previewReprocess(style: Style, outputLanguage: string): Promise<void> {
    const session = this.current
    if (!session || this.phase !== 'idle') return
    if (!needsAi(style, outputLanguage)) {
      this.addVersion(session, { kind: 'processed', text: session.transcription.text, style, outputLanguage })
      await history.save(session)
      return this.updatePreviewBusy(null)
    }
    const abort = new AbortController()
    this.abort = abort
    this.setPhase('processing')
    this.updatePreviewBusy('processing')
    try {
      const r = await processTranscript(session.transcription.text, {
        inputLanguage: session.transcription.language,
        style,
        outputLanguage,
        signal: abort.signal
      })
      if (abort.signal.aborted) return
      this.addVersion(session, { kind: 'processed', text: r.text, style, outputLanguage, provider: r.provider, model: r.model, ms: r.ms })
      await history.save(session)
      this.updatePreviewBusy(null)
    } catch (err) {
      if (!abort.signal.aborted) this.updatePreviewBusy(null, (err as Error).message)
    } finally {
      if (this.abort === abort) this.abort = null
      this.setPhase('idle')
    }
  }

  previewVoiceEdit(): void {
    if (this.phase === 'recording' && this.purpose === 'edit') void this.stopRecording()
    else if (this.phase === 'idle') void this.startRecording('edit')
  }

  async previewUndo(): Promise<void> {
    const session = this.current
    if (!session || session.versions.length === 0 || this.phase !== 'idle') return
    session.versions.pop()
    const prev = session.versions[session.versions.length - 1]
    session.text = prev ? prev.text : session.transcription.text
    session.updatedAt = new Date().toISOString()
    await history.save(session)
    this.updatePreviewBusy(null)
  }

  private manualEdit(session: Session, text: string): void {
    if (text !== session.text) this.addVersion(session, { kind: 'manual', text })
  }

  async previewInsert(text: string): Promise<void> {
    const session = this.current
    if (!session) return
    if (this.phase !== 'idle') this.cancel()
    this.manualEdit(session, text)
    const cfg = configStore.get().output
    await restoreFocus(this.target, hidePreview)
    const ok = await pasteText(session.text, { keys: cfg.pasteKeys, restoreClipboard: cfg.restoreClipboard })
    if (!ok) this.notify('Copied to clipboard', 'Speak could not paste automatically. Press Ctrl+V / ⌘V to insert the text.')
    await this.finish(session, ok ? 'inserted' : 'copied')
  }

  async previewCopy(text: string): Promise<void> {
    const session = this.current
    if (!session) return
    if (this.phase !== 'idle') this.cancel()
    this.manualEdit(session, text)
    await copyToClipboard(session.text)
    await restoreFocus(this.target, hidePreview)
    await this.finish(session, 'copied')
  }

  async previewCancel(): Promise<void> {
    const session = this.current
    if (this.phase !== 'idle') this.cancel()
    if (!session) return hidePreview()
    await restoreFocus(this.target, hidePreview)
    await this.finish(session, 'cancelled')
  }

  private async finish(session: Session, action: SessionAction): Promise<void> {
    session.action = action
    session.updatedAt = new Date().toISOString()
    if (action !== 'cancelled') this.lastText = session.text
    await history.save(session)
    if (this.current === session) this.current = null
    this.emit('phase', this.phase) // refresh tray ("Copy last result")
    this.target = null
  }

  lastResult(): string {
    return this.lastText
  }

  private notify(title: string, body: string): void {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
  }

  /** Run the pipeline on a WAV file as if it had been dictated (like the shortcut: an edit when the preview is open). */
  async runFile(samples: Float32Array): Promise<void> {
    if (this.phase !== 'idle') return
    this.purpose = previewVisible() && this.current ? 'edit' : 'dictation'
    this.device = ''
    if (this.purpose === 'edit') return this.handleAudio(samples)
    await this.handleAudio(samples, { target: await captureFocus() })
  }

  async reprocessHistory(id: string, style: Style, outputLanguage: string): Promise<Session> {
    const session = await history.get(id)
    if (!session) throw new Error('Session not found')
    if (!needsAi(style, outputLanguage)) {
      this.addVersion(session, { kind: 'processed', text: session.transcription.text, style, outputLanguage })
    } else {
      const r = await processTranscript(session.transcription.text, { inputLanguage: session.transcription.language, style, outputLanguage })
      this.addVersion(session, { kind: 'processed', text: r.text, style, outputLanguage, provider: r.provider, model: r.model, ms: r.ms })
    }
    await history.save(session)
    return session
  }
}

export const controller = new Controller()
