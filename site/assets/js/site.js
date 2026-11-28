/*
 * speak.brbnn.com: the shortcuts and the download for the visitor's system, and the demo.
 *
 * The page reads well without this script: the shortcuts default to Windows and Linux, the
 * download links open the latest release on GitHub, and the demo shows its first example
 * finished. The release's files come from release.json, which tools/build.mjs writes when the
 * site is deployed, so the page itself never calls another host.
 */

const REPO = 'https://github.com/rodolphebarbanneau/speak'
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

// ───────────────────────────── the visitor's system ─────────────────────────────

/**
 * Where the page is open, from the browser's own report (client hints where it has them)
 * or else its user-agent string. Phones, tablets and Chromebooks give nothing: no build of
 * Speak runs there. A port of brbnn.com's src/lib/downloads.ts.
 */
function systemOf({ userAgent: ua, platform = '', mobile, architecture, bitness, maxTouchPoints = 0 }) {
  if (mobile || /Android|iPhone|iPad|iPod|CrOS/i.test(ua) || /Android|Chrome ?OS/i.test(platform)) return undefined
  let os
  if (/Windows/i.test(platform) || /Windows NT/i.test(ua)) os = 'windows'
  else if (/mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) {
    // An iPad asks for desktop sites as a Mac: it is the one with a touch screen.
    if (maxTouchPoints > 1) return undefined
    os = 'mac'
  } else if (/Linux/i.test(platform) || /Linux|X11/i.test(ua)) os = 'linux'
  if (!os) return undefined

  // Client hints say it plainly. The user-agent string only on Windows and Linux: a Mac's
  // says "Intel" whatever is inside.
  const hint = architecture?.toLowerCase()
  let arch
  if (hint === 'arm') arch = bitness === '32' ? undefined : 'arm64'
  else if (hint === 'x86') arch = 'x64'
  else if (/aarch64|arm64/i.test(ua)) arch = 'arm64'
  else if (os !== 'mac' && /x86_64|x64|Win64|WOW64|amd64/i.test(ua)) arch = 'x64'
  return { os, arch }
}

/** The build to offer a system, and the others worth naming beside it. */
function chooseBuild(builds, system) {
  const mine = builds.filter((b) => b.os === system.os)
  let runs
  if (system.arch) {
    const native = mine.filter((b) => b.arch === system.arch || b.arch === 'universal')
    // Arm Windows emulates x64, and an Arm Mac translates it.
    runs = native.length > 0 || system.arch !== 'arm64' || system.os === 'linux' ? native : mine.filter((b) => b.arch === 'x64')
  } else {
    // Unknown: a Mac is most likely Apple silicon by now; anything else, most likely x64.
    const likely = system.os === 'mac' ? 'arm64' : 'x64'
    const order = (b) => (b.arch === likely ? 0 : b.arch === 'universal' ? 1 : 2)
    runs = [...mine].sort((a, b) => order(a) - order(b))
  }
  const [build] = runs
  if (!build) return undefined
  const others = runs.filter(
    (o) => o !== build && ((o.arch === build.arch && o.format !== build.format) || (o.format === build.format && o.arch !== build.arch))
  )
  return { build, others }
}

const OS_NAME = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }

/** How a build is told apart from its siblings: the kind of Mac, the Linux package. */
function describe(build) {
  if (build.os === 'mac') return { x64: 'Intel', arm64: 'Apple silicon', universal: 'any Mac' }[build.arch]
  if (build.os === 'linux') return build.format.toLowerCase() === 'appimage' ? 'AppImage' : `.${build.format}`
  return build.arch === 'arm64' ? 'Arm' : ''
}

const browser = () => ({
  userAgent: navigator.userAgent,
  platform: navigator.userAgentData?.platform ?? navigator.platform,
  mobile: navigator.userAgentData?.mobile,
  maxTouchPoints: navigator.maxTouchPoints
})

// The shortcuts first, synchronously, so they never flash the wrong system's keys. iPhones
// and iPads count as Macs here: their owners most likely have one.
{
  const system = systemOf(browser())
  if (system?.os === 'mac' || (!system && /iPhone|iPad|Macintosh/i.test(navigator.userAgent))) document.documentElement.dataset.os = 'mac'
}

// ───────────────────────────── downloads ─────────────────────────────

async function setUpDownloads() {
  let release
  try {
    const response = await fetch('release.json', { cache: 'no-cache' })
    if (!response.ok) return
    release = await response.json()
  } catch {
    return // the links keep pointing at the release page
  }
  if (!release || !Array.isArray(release.builds)) return

  let hints = {}
  try {
    hints = (await navigator.userAgentData?.getHighEntropyValues(['architecture', 'bitness'])) ?? {}
  } catch {
    // Not offered: the user-agent string is all there is.
  }
  const system = systemOf({ ...browser(), architecture: hints.architecture, bitness: hints.bitness })
  const choice = system && chooseBuild(release.builds, system)

  // The table: each row's file, its size, and the visitor's own.
  for (const row of document.querySelectorAll('.builds tr[data-build]')) {
    const [os, arch, format] = row.dataset.build.split(' ')
    const build = release.builds.find((b) => b.os === os && b.arch === arch && b.format.toLowerCase() === format.toLowerCase())
    if (!build) continue
    row.querySelector('a').href = build.url
    row.querySelector('.sz').textContent = megabytes(build.size)
    if (choice?.build === build) row.classList.add('is-mine')
  }

  // The hero's button, and the line under it.
  const main = document.getElementById('dl-main')
  const note = document.getElementById('dl-note')
  const parts = [`v${release.version}`]
  if (choice) {
    main.href = choice.build.url
    main.firstChild.textContent = `download for ${OS_NAME[choice.build.os]} `
    const kind = describe(choice.build)
    if (kind) parts.push(kind)
    note.replaceChildren(parts.join(' · '))
    for (const other of choice.others) {
      const link = document.createElement('a')
      link.href = other.url
      link.textContent = `${describe(other)} ↓`
      note.append(' · ', link)
    }
    if (choice.others.length === 0) note.append(' · free and open source')
  } else {
    // A phone, or a system no build runs on: the button shows every build instead.
    main.href = '#download'
    note.replaceChildren(`${parts[0]} · free and open source · Windows, macOS, Linux`)
  }

  const rel = document.getElementById('dl-rel')
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(new Date(release.published))
  const notes = document.createElement('a')
  notes.className = 'br'
  notes.href = release.page || `${REPO}/releases/latest`
  notes.textContent = 'what’s new ↗'
  rel.replaceChildren(`latest · v${release.version} · ${date} `, notes)
  rel.hidden = false
}

const megabytes = (bytes) => (Number.isFinite(bytes) ? `${Math.round(bytes / 1048576)} MB` : '')

setUpDownloads()

// ───────────────────────────── the demo ─────────────────────────────

/** An element, with text nodes only: nothing here is parsed as HTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'class') el.className = value
    else el.setAttribute(key, value)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid)
  return el
}

const appWindow = (app, sub, ...body) =>
  h('div', { class: 'win app' }, h('div', { class: 'win-t' }, h('b', null, app), ` · ${sub}`), h('div', { class: 'win-b' }, ...body))

function textField(cls = '', placeholder) {
  const field = h('div', { class: `field ${cls}`.trim() }, h('span', { class: 'caret' }))
  if (placeholder) field.dataset.ph = placeholder
  return field
}

const FILES = [
  ['invoice-0412.pdf', 'pdf'],
  ['notes.txt', 'text'],
  ['report.pdf', 'pdf'],
  ['scan.pdf', 'pdf']
]

/**
 * The four examples, from the README. `said` is what was said, in pieces: a piece marked
 * true is dropped when Speak cleans up.
 */
const SCENES = [
  {
    label: 'dictate',
    working: 'cleaning up…',
    said: [['so um', true], ['can we,', true], ['can we move the meeting to'], ['Monday, no sorry,', true], ['Tuesday at three']],
    result: 'Can we move the meeting to Tuesday at 3?',
    app() {
      const field = textField()
      return { el: appWindow('messages', '#launch', h('p', { class: 'msg' }, h('b', null, 'marc'), 'Still on for the review Monday?'), field), field }
    }
  },
  {
    label: 'dictate · fr → en',
    working: 'translating…',
    said: [['Est-ce que tu peux ajouter un bouton pour exporter l’historique en CSV ?']],
    result: 'Can you add a button to export the history as CSV?',
    app() {
      const field = textField('', 'ask anything…')
      return { el: appWindow('assistant', 'new chat', h('p', { class: 'msg' }, 'What are we building today?'), field), field }
    }
  },
  {
    label: 'compose',
    working: 'writing…',
    said: [['Write a short email to Sarah,'], ['the release moves to Thursday,'], ['keep it friendly']],
    result: 'Hi Sarah,\n\nQuick heads-up: the release is moving to Thursday.\n\nThanks!\n[your name]',
    app() {
      const field = textField('mail')
      const header = (key, value) => h('p', { class: 'hdr' }, h('span', null, key), h('span', null, value))
      return { el: appWindow('mail', 'new message', header('to', 'Sarah'), header('subject', 'Release date'), field), field }
    }
  },
  {
    label: 'control',
    working: 'on it…',
    said: [['Put the PDFs on my desktop in a folder']],
    control: true,
    app() {
      const files = h(
        'ul',
        { class: 'files' },
        FILES.map(([name, kind]) => h('li', { 'data-kind': kind }, h('span', null, name), h('span', null, kind)))
      )
      return { el: appWindow('files', 'desktop', files), files }
    }
  }
]

const sentence = (scene) => scene.said.map(([text]) => text).join(' ')

/** What a screen reader gets instead of the animation. */
function describeScene(scene) {
  if (scene.control) return `You say “${sentence(scene)}”. Speak’s AI makes a folder and moves the three PDFs into it, after you approve its plan.`
  const how = scene.label === 'compose' ? 'writes an email' : 'types'
  return `You say “${sentence(scene)}”. Speak ${how}: “${scene.result.replace(/\n+/g, ' ')}”`
}

function controlPanel() {
  const status = h('span', { class: 'cp-s' }, 'working')
  const dot = h('span', { class: 'pu' }, '●')
  const body = h('div', { class: 'cp-b' }, h('p', { class: 'cp-you' }, 'put the PDFs on my desktop in a folder'))
  const el = h(
    'div',
    { class: 'cpanel' },
    h('div', { class: 'cp-h' }, h('span', null, dot, ' ', h('span', { class: 'pu' }, 'control'), ' · asks the plan'), status),
    body
  )
  return { el, body, status, dot }
}

const panelLine = (mark, text, markClass = '') => h('p', { class: 'cp-l' }, h('span', { class: `cp-m ${markClass}`.trim() }, mark), h('span', null, text))

const AI_SAYS = 'Three PDFs here. I’ll put them in a new folder.'

function askBox() {
  const yes = h('span', { class: 'g' }, '[yes]')
  const el = h(
    'div',
    { class: 'cp-ask' },
    h('p', { class: 'y' }, 'approve the plan?'),
    h('p', { class: 'cp-what' }, 'make the folder PDFs, move 3 files into it'),
    h('p', null, yes, ' ', h('span', { class: 'r' }, '[no]'), ' ', h('span', { class: 'cp-s' }, '· or say what to do instead'))
  )
  return { el, yes }
}

class Aborted extends Error {}

/** A pause that ends early, rejecting, when the animation is stopped. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted())
    const abort = () => {
      clearTimeout(timer)
      reject(new Aborted())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function setUpDemo() {
  const figure = document.getElementById('demo')
  const stage = document.getElementById('stage')
  const text = document.getElementById('demo-text')
  const play = document.getElementById('demo-play')
  const tabs = [...figure.querySelectorAll('.tab')]
  if (!figure || !stage || !play) return

  let current = 0
  let playing = !reducedMotion.matches
  let inView = true
  let run = null // the AbortController of the animation under way

  /** Builds a scene's parts, empty: nothing said yet, nothing typed. */
  function build(index) {
    const scene = SCENES[index]
    const app = scene.app()
    const words = scene.said.flatMap(([piece, dropped]) => piece.split(' ').map((word) => h('span', { class: dropped ? 'w drop' : 'w' }, word)))
    const quote = h('span', { class: 'said-q' })
    words.forEach((word, i) => quote.append(word, i < words.length - 1 ? ' ' : ''))
    const said = h('p', { class: 'said' }, h('span', { class: 'said-k' }, 'you said'), quote)
    const time = h('span', { class: 'p-time' }, '0:00')
    const mode = h('span', { class: 'p-mode' }, scene.label)
    const pill = h(
      'div',
      { class: 'pill', 'data-state': 'off' },
      h('span', { class: 'p-dot' }),
      time,
      h(
        'span',
        { class: 'p-lvl' },
        Array.from({ length: 10 }, () => h('i'))
      ),
      mode,
      h('span', { class: 'p-act' }, h('span', { class: 'p-pause' }, '❚❚'), h('span', { class: 'p-ok' }, '✓'), h('span', { class: 'p-x' }, '✕'))
    )
    stage.replaceChildren(app.el, said, pill)
    stage.classList.toggle('is-control', !!scene.control)
    return { scene, ...app, said, words, pill, time, mode }
  }

  /** A scene as it ends. */
  function finish(parts) {
    const { scene } = parts
    parts.said.dataset.clean = ''
    if (scene.control) {
      const panel = controlPanel()
      panel.body.append(
        panelLine('·', 'looked at the desktop'),
        panelLine('ai', AI_SAYS, 'g'),
        panelLine('✓', 'approved the plan', 'g'),
        panelLine('✓', 'made the folder PDFs', 'g'),
        panelLine('✓', 'moved 3 files', 'g')
      )
      panel.status.className = 'g'
      panel.status.textContent = 'done 0:09'
      parts.files.querySelectorAll('[data-kind="pdf"]').forEach((li) => li.remove())
      parts.files.prepend(folderRow('3 files'))
      parts.el.after(panel.el)
    } else {
      parts.field.prepend(scene.result)
      parts.field.classList.add('has-text')
    }
  }

  const folderRow = (kind) => h('li', { class: 'is-new' }, h('span', null, 'PDFs/'), h('span', null, kind))

  /** A scene played out, from the first word to the end. */
  async function animate(parts, signal) {
    const { scene, said, words, pill, time, mode } = parts
    for (const word of words) word.hidden = true
    await sleep(600, signal)

    pill.dataset.state = 'rec'
    const started = performance.now()
    const clock = setInterval(() => (time.textContent = `0:${String(Math.floor((performance.now() - started) / 1000)).padStart(2, '0')}`), 250)
    const stopClock = () => clearInterval(clock)
    signal.addEventListener('abort', stopClock, { once: true })
    await sleep(350, signal)
    for (const word of words) {
      word.hidden = false
      await sleep(word.textContent.length > 7 ? 300 : 220, signal)
    }
    await sleep(500, signal)
    stopClock()
    signal.removeEventListener('abort', stopClock)

    pill.dataset.state = 'work'
    mode.textContent = scene.working
    said.dataset.clean = ''
    await sleep(1100, signal)

    if (scene.control) {
      pill.dataset.state = 'off'
      await playControl(parts, signal)
      return
    }

    pill.dataset.state = 'done'
    mode.textContent = 'inserted'
    const typed = document.createTextNode('')
    parts.field.prepend(typed)
    parts.field.classList.add('has-text')
    const step = scene.result.length > 60 ? 3 : 1
    for (let i = step; i < scene.result.length + step; i += step) {
      typed.data = scene.result.slice(0, i)
      await sleep(24, signal)
    }
    await sleep(900, signal)
    pill.dataset.state = 'off'
  }

  async function playControl(parts, signal) {
    const panel = controlPanel()
    parts.el.after(panel.el)
    await sleep(500, signal)
    panel.body.append(panelLine('·', 'looked at the desktop'))
    await sleep(800, signal)
    panel.body.append(panelLine('ai', AI_SAYS, 'g'))
    await sleep(900, signal)

    const ask = askBox()
    panel.body.append(ask.el)
    panel.status.className = 'y'
    panel.status.textContent = 'waiting for you'
    panel.dot.className = 'y'
    await sleep(1700, signal)
    ask.yes.classList.add('is-pressed')
    await sleep(450, signal)
    ask.el.replaceWith(panelLine('✓', 'approved the plan', 'g'))
    panel.status.className = 'cp-s'
    panel.status.textContent = 'working'
    panel.dot.className = 'pu'
    await sleep(700, signal)

    panel.body.append(panelLine('✓', 'made the folder PDFs', 'g'))
    const folder = folderRow('folder')
    parts.files.prepend(folder)
    await sleep(900, signal)

    const pdfs = [...parts.files.querySelectorAll('[data-kind="pdf"]')]
    pdfs.forEach((li) => li.classList.add('is-out'))
    await sleep(600, signal)
    pdfs.forEach((li) => li.remove())
    folder.lastChild.textContent = '3 files'
    panel.body.append(panelLine('✓', 'moved 3 files', 'g'))
    panel.status.className = 'g'
    panel.status.textContent = 'done 0:09'
  }

  function select(index) {
    current = index
    tabs.forEach((tab, i) => tab.setAttribute('aria-pressed', String(i === index)))
    text.textContent = describeScene(SCENES[index])
  }

  function stop() {
    run?.abort()
    run = null
  }

  /** Shows a scene finished, without moving. */
  function still(index) {
    stop()
    select(index)
    finish(build(index))
  }

  /** Plays from a scene on, one after the other, until stopped. */
  async function loop(index) {
    stop()
    const controller = new AbortController()
    run = controller
    try {
      for (let i = index; ; i = (i + 1) % SCENES.length) {
        select(i)
        await animate(build(i), controller.signal)
        await sleep(3200, controller.signal)
      }
    } catch (error) {
      if (!(error instanceof Aborted)) throw error
    }
  }

  const resume = () => (playing && inView && !document.hidden ? loop(current) : still(current))

  /** The stage keeps the height of its tallest example, so the page never jumps. */
  let fittedWidth = 0
  function fit() {
    const width = stage.clientWidth
    if (width === fittedWidth) return
    fittedWidth = width
    stop()
    stage.style.minHeight = ''
    let tallest = 0
    SCENES.forEach((_, i) => {
      finish(build(i))
      tallest = Math.max(tallest, stage.offsetHeight)
    })
    stage.style.minHeight = `${tallest}px`
    resume()
  }

  tabs.forEach((tab, i) =>
    tab.addEventListener('click', () => {
      select(i)
      resume()
    })
  )

  const label = () => (play.textContent = playing ? 'pause' : 'play')
  label()
  play.hidden = false
  play.addEventListener('click', () => {
    playing = !playing
    label()
    resume()
  })

  // Nothing moves where nobody is looking.
  new IntersectionObserver(([entry]) => {
    const visible = entry.isIntersecting
    if (visible === inView) return
    inView = visible
    if (playing) resume()
  }).observe(stage)
  document.addEventListener('visibilitychange', () => playing && resume())

  let resizeTimer
  addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(fit, 150)
  })

  document.fonts.ready.then(fit)
}

setUpDemo()
