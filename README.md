# Speak

Cross-platform voice dictation for your desktop. Press a shortcut, speak naturally (in French, English or 25+ other languages), and get clean text, optionally translated, where your cursor is: a prompt box in T3 Code or Claude Code, a chat, an email, an editor.

- **Local speech recognition**: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with Whisper large-v3-turbo (GPU on NVIDIA/Apple Silicon) or NVIDIA Parakeet v3. Audio never leaves your machine.
- **AI cleanup & translation**: removes hesitations, repetitions and self-corrections ("la somme, non pardon, la moyenne" → "the average"), applies a style, translates. Runs through the coding-agent CLI you already use, **Claude Code** or **Codex**, with your own login. No API keys.
- **Compose**: say what to write and give the context ("réponds poliment : l'export PDF n'est pas prévu, propose l'export CSV"), and the AI writes it: an email, a reply, a message. Text you had selected (the email you're answering) is used as material.
- **Preview dialog or direct paste**: check the result, **edit it by voice** ("ajoute qu'il faut gérer la liste vide"), copy, or insert it into the window you were typing in.
- **Tray app**: runs in the background; history of every dictation (text + audio) in `~/.speak`.
- **Keyboard-first, terminal look**: [Omarchy](https://omarchy.org)'s default Tokyo Night palette, JetBrains Mono, native window frames.

## Usage

1. Launch Speak (it lives in the system tray). The window opens on your history; on the first launch, **set up speak** leads to the setup checklist:
   - **Speech recognition**: one click installs the engine (the CUDA build if you have an NVIDIA GPU) and the speech model (Whisper large-v3-turbo Q8).
   - **AI provider**: pick Claude Code or Codex. Speak detects the installed CLI and shows whether you're signed in.
2. Put your cursor in any text field and press **Ctrl+Shift+Space** (⌘⇧Space on macOS):
   - **hold** it while you speak and release to finish, or
   - **tap** to start and tap again to stop. **Esc** cancels.
3. Depending on _After dictation_:
   - **Preview dialog**: review/edit the text, change style or output language (re-processed instantly from the same transcript), **Edit by voice** (button, Ctrl+E, or your dictation shortcut), then **Insert** (Enter; Shift+Enter adds a new line), **Copy** (Ctrl+Shift+C) or **Cancel** (Esc).
   - **Paste directly**: the text is inserted immediately.

Styles: **Verbatim** (no AI unless translating), **Clean** (default), **Structured** (organized as a prompt or message), **Summary**.

Tip: set your spoken language explicitly (e.g. French) and add your jargon to **Vocabulary** (settings → general). Both feed Whisper and the AI pass and noticeably improve accuracy.

### Compose

Dictation keeps your words: even "write a function that…" comes out as that sentence, ready to send to an AI assistant. To have the AI _write_ something for you instead, press **Ctrl+Alt+Space** (⌘⇧⌥Space on macOS) and speak a brief: what to write (an email, a reply, a message; tone, length, language) and the context to use, in any order and any language.

> Écris un mail à un client qui demande un export PDF. Contexte : on a déjà l'export CSV, le PDF n'est pas possible pour l'instant et je ne suis pas sûr qu'on le fera. Reste poli, propose le CSV, en anglais.

The AI sticks to what you said: no invented facts, promises or offers, your doubts kept as doubts, and `[placeholders]` for missing details such as a name. If text is selected when you compose (an email to answer, a draft to rework), it is sent along as material, and a reply is written in that text's language. The output then follows _After dictation_ like any dictation, and you can switch a recording between dictation and compose in the preview's **style** menu.

Compose writes more freely than cleanup, so it has its own model (**settings → ai → compose model**): Claude Code composes with **sonnet**, which stayed faithful to the brief where haiku occasionally added a sentence of its own, while dictation keeps the faster, cheaper haiku.

### Command line

The executable accepts flags that are forwarded to the running instance, useful for desktop-environment shortcuts (e.g. on Wayland) or scripts:

```
Speak --toggle        start/stop dictation
Speak --compose       start/stop a compose dictation
Speak --cancel        cancel the current dictation
Speak --show          open the main window
Speak --file=x.wav    process an audio file (as if dictated)
```

## Data folder (`~/.speak`)

Override with the `SPEAK_HOME` environment variable.

| Path                                   | Content                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `config.json`                          | All settings                                                                                        |
| `history/YYYY-MM-DD/<id>/session.json` | Raw transcript, every version (AI result, voice edits, manual edits), timings, what you did with it |
| `history/YYYY-MM-DD/<id>/audio.wav`    | The recording (optional, see settings; retention configurable)                                      |
| `models/`                              | Whisper / Parakeet / Silero VAD models                                                              |
| `bin/whisper-cpp/`                     | Managed whisper.cpp engine                                                                          |
| `logs/speak.log`                       | Diagnostics                                                                                         |

## AI providers: Claude Code or Codex

Speak runs the **user's own, unmodified CLI** non-interactively. The transcript goes in on stdin, wrapped in tags with instructions to rewrite it, never to answer or execute what was dictated. Speak never reads, stores or proxies credentials. When you're not signed in, it opens a terminal running the CLI's own sign-in, and usage counts toward your plan limits.

| Provider        | Default                     | Command                                                                                                                                                                                       |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | `haiku`, effort medium      | `claude -p --model haiku --effort medium --system-prompt-file … --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence --output-format json`   |
| **Codex**       | `gpt-6-luna`, effort medium | `codex exec -m gpt-6-luna -c model_reasoning_effort="medium" -c model_instructions_file="…" --ignore-user-config --ignore-rules --sandbox read-only --ephemeral --skip-git-repo-check -o … -` |

Both run without tools, plugins, MCP servers or project settings, and with Speak's instructions in place of the coding-agent prompt. Cheap, fast models are the default because dictation cleanup doesn't need a frontier model; pick another model or effort in **settings → ai**. Codex's model list comes from its own catalog (`~/.codex/models_cache.json`).

## Platform notes

|              | Windows                                       | macOS                                                                            | Linux                                                                  |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Engine       | Downloaded in-app (CUDA 12 / CUDA 11.8 / CPU) | Bundled in release builds (Metal), or Homebrew `whisper-cpp`, or a custom folder | Downloaded in-app (CPU) or a custom build                              |
| Hold-to-talk | ✓                                             | needs Accessibility permission                                                   | X11 ✓ · Wayland: toggle only (bind `Speak --toggle`)                   |
| Auto-paste   | ✓ (not into apps running as administrator)    | needs Accessibility permission                                                   | X11 (uses `xdotool` if installed) · Wayland needs `wtype` or `ydotool` |

When auto-paste isn't possible, the text is left on the clipboard and a notification tells you to paste.

**First launch on macOS**: release builds without an Apple certificate are ad-hoc signed, so macOS asks once before opening Speak. Control-click Speak in Applications and choose **Open**, or allow it in **System Settings → Privacy & Security**.

**"No signal from …"**: the microphone sends pure silence. Usually the system default input is a virtual device (Voicemod, Voicemeeter…) that isn't routing audio. Pick your microphone in **settings → general → input** and use **[ test ]** (live meter + playback), or change the default input in your system sound settings.

## Updates

Speak checks this repository's GitHub releases at startup and every 4 hours. With **settings → about → updates → automatic** on (the default), new versions download in the background and install when Speak quits; the tray menu and **[ restart & update ]** install right away. Turn it off to choose when to download and install, from the same section.

Updates work with the Windows installer, the AppImage and the .deb (which asks for your password). On macOS they need a signed build; unsigned builds point you to the releases page.

## Development

```bash
npm install
npm run dev          # electron-vite dev server + Electron
npm run typecheck
npm run build        # bundle to out/
npm run dist:dir     # unpacked app in dist/
npm run dist         # installers (NSIS / DMG+ZIP / AppImage+deb)
npm run icons        # regenerate icons (scripts/generate-icons.mjs)
```

> If you launch from inside another Electron app's terminal (e.g. T3 Code, VS Code), unset `ELECTRON_RUN_AS_NODE` first.

Releases: bump `version` in `package.json` and push a matching `v*` tag; `.github/workflows/release.yml` builds Windows, macOS (compiling whisper.cpp with Metal via `scripts/build-whisper.sh`) and Linux, and uploads the installers with their update manifests (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) to a draft GitHub release. Publishing the draft rolls the update out to every install. Signing is optional (`CSC_LINK`, `APPLE_ID`… secrets); unsigned builds trigger SmartScreen/Gatekeeper warnings and can't update themselves on macOS.

To test an update without publishing, build a newer version into another folder, serve that folder over HTTP and start a packaged build with `SPEAK_UPDATE_FEED=http://localhost:<port>/`.

### Architecture

```
src/
  main/                     Electron main process
    index.ts                bootstrap, single instance, CLI flags
    controller.ts           pipeline: record → transcribe → AI → preview | paste
    hotkeys.ts              global shortcut (press) + keyboard hook (release → hold-to-talk)
    stt/engine.ts           whisper.cpp install, whisper-server lifecycle, parakeet-cli
    ai/                     prompts + coding-agent CLIs (claude-code, codex)
    platform/               focus capture/restore, paste simulation, keyboard hook, autostart
    audio.ts                WAV codec, silence trimming, hallucination filter
    history.ts, config.ts   ~/.speak storage
    windows.ts, tray.ts     overlay pill, preview dialog, main window, tray menu
  preload/                  typed `window.speak` bridge
  renderer/src/
    overlay/                recording pill + microphone capture (Web Audio worklet → 16 kHz)
    preview/                preview dialog
    app/                    main window: history + settings
  shared/                   types, constants, API contract
```
