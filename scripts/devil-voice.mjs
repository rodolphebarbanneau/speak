/**
 * Renders the devil theme's voice, src/themes/devil/voice.ts: Windows' David voice says "Sheitan
 * mode activated", slowly; ffmpeg's rubberband pitch shifter drops it into three voices, from an
 * octave below to almost two, shakes the middle one into a growl, roughens the whole and gives it a
 * short echo. The result is Ogg Opus, kept as base64 (no file to load at run time). Needs Windows
 * and an ffmpeg built with rubberband on the PATH.
 *
 *   node scripts/devil-voice.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Spelled as it sounds: David reads "sheitan" as "shy-tan".
const SSML =
  '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
  '<prosody rate="-25%" pitch="x-low">Shay-tahn mode <break time="120ms"/> activated.</prosody></speak>'

const VOICES = [
  // Each voice: its pitch (0.62: about 8 semitones down) and level.
  'rubberband=pitch=0.62:formant=shifted:pitchq=quality,volume=1.0',
  'rubberband=pitch=0.42:formant=shifted:pitchq=quality,tremolo=f=33:d=0.35,volume=0.75',
  'rubberband=pitch=0.30:formant=shifted,lowpass=f=500,volume=0.6'
]

const dir = mkdtempSync(join(tmpdir(), 'speak-devil-'))
const clean = join(dir, 'clean.wav')
const ogg = join(dir, 'voice.ogg')
try {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$s.SelectVoice('Microsoft David Desktop')",
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${clean}', $f)`,
    `$s.SpeakSsml('${SSML}')`,
    '$s.Dispose()'
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
  const graph = [
    `[0:a]aresample=48000,asplit=3${VOICES.map((_, i) => `[v${i}]`).join('')}`,
    ...VOICES.map((chain, i) => `[v${i}]${chain}[l${i}]`),
    `${VOICES.map((_, i) => `[l${i}]`).join('')}amix=inputs=${VOICES.length}:normalize=0,asoftclip=type=atan:threshold=0.6,` +
      'aecho=0.8:0.6:70|140:0.22|0.12,lowpass=f=5200,highpass=f=40,' +
      'silenceremove=start_periods=1:start_threshold=-50dB,afade=t=out:st=2.3:d=0.5,loudnorm=I=-15:TP=-1.0[out]'
  ].join(';')
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      clean,
      '-filter_complex',
      graph,
      '-map',
      '[out]',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '40k',
      ogg
    ],
    {
      stdio: 'inherit'
    }
  )
  const base64 = readFileSync(ogg).toString('base64')
  const lines = base64.match(/.{1,150}/g) ?? []
  writeFileSync(
    'src/themes/devil/voice.ts',
    `/** "Sheitan mode activated", from the depths: Ogg Opus, base64. Made by scripts/devil-voice.mjs. */\nexport const VOICE =\n${lines.map((l) => `  '${l}'`).join(' +\n')}\n`
  )
  console.log(`src/themes/devil/voice.ts: ${base64.length} characters`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
