import type { BinaryOption, BinaryVariant, EngineId } from '../../shared/types'

/** Pinned whisper.cpp build (whisper-server + parakeet-cli). */
export const WHISPER_CPP_TAG = 'b5454'
const RELEASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_TAG}`

type PlatformKey = `${NodeJS.Platform}-${string}`

const BINARIES: Partial<Record<PlatformKey, Array<Omit<BinaryOption, 'url'> & { asset: string }>>> = {
  'win32-x64': [
    { variant: 'cuda12', label: 'NVIDIA GPU (CUDA 12)', sizeMB: 685, asset: 'whisper-bin-win-cuda-12.4.0-x64.zip' },
    { variant: 'cuda11', label: 'NVIDIA GPU (CUDA 11.8, older drivers)', sizeMB: 285, asset: 'whisper-bin-win-cuda-11.8.0-x64.zip' },
    { variant: 'cpu', label: 'CPU (OpenBLAS)', sizeMB: 22, asset: 'whisper-blas-bin-x64.zip' }
  ],
  'win32-arm64': [{ variant: 'cpu', label: 'CPU (ARM64)', sizeMB: 5, asset: 'whisper-bin-win-cpu-arm64.zip' }],
  'linux-x64': [{ variant: 'cpu', label: 'CPU', sizeMB: 11, asset: 'whisper-bin-ubuntu-x64.tar.gz' }],
  'linux-arm64': [{ variant: 'cpu', label: 'CPU (ARM64)', sizeMB: 5, asset: 'whisper-bin-ubuntu-arm64.tar.gz' }]
}

export function binaryOptions(): BinaryOption[] {
  const list = BINARIES[`${process.platform}-${process.arch}`] ?? []
  return list.map(({ asset, ...rest }) => ({ ...rest, url: `${RELEASE}/${asset}` }))
}

export function binaryOption(variant: BinaryVariant): BinaryOption | undefined {
  return binaryOptions().find((b) => b.variant === variant)
}

export interface ModelDef {
  id: string
  engine: EngineId
  file: string
  url: string
  label: string
  sizeMB: number
  note?: string
}

const WHISPER_HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const PARAKEET_HF = 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main'

export const MODELS: ModelDef[] = [
  {
    id: 'large-v3-turbo-q8_0',
    engine: 'whisper',
    file: 'ggml-large-v3-turbo-q8_0.bin',
    label: 'Whisper large-v3-turbo · Q8',
    sizeMB: 874,
    note: 'Recommended: near full accuracy, fast on GPU'
  },
  {
    id: 'large-v3-turbo-q5_0',
    engine: 'whisper',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'Whisper large-v3-turbo · Q5',
    sizeMB: 574,
    note: 'Smaller download, slightly less accurate'
  },
  { id: 'large-v3-turbo', engine: 'whisper', file: 'ggml-large-v3-turbo.bin', label: 'Whisper large-v3-turbo · F16', sizeMB: 1625, note: 'Full precision' },
  {
    id: 'large-v3-q5_0',
    engine: 'whisper',
    file: 'ggml-large-v3-q5_0.bin',
    label: 'Whisper large-v3 · Q5',
    sizeMB: 1081,
    note: 'Most accurate, slowest (GPU recommended)'
  },
  { id: 'medium-q5_0', engine: 'whisper', file: 'ggml-medium-q5_0.bin', label: 'Whisper medium · Q5', sizeMB: 539, note: 'Good on CPU-only machines' },
  { id: 'small', engine: 'whisper', file: 'ggml-small.bin', label: 'Whisper small', sizeMB: 488, note: 'Fast, less accurate' },
  {
    id: 'parakeet-tdt-0.6b-v3-q8_0',
    engine: 'parakeet',
    file: 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin',
    label: 'Parakeet TDT 0.6B v3 · Q8',
    sizeMB: 669,
    note: '25 European languages, auto-detected; very fast even on CPU'
  },
  {
    id: 'parakeet-tdt-0.6b-v3-q4_k',
    engine: 'parakeet',
    file: 'ggml-parakeet-tdt-0.6b-v3-q4_k.bin',
    label: 'Parakeet TDT 0.6B v3 · Q4',
    sizeMB: 416,
    note: 'Smaller download'
  }
].map((m) => ({ ...m, url: `${m.engine === 'whisper' ? WHISPER_HF : PARAKEET_HF}/${m.file}` }) as ModelDef)

export const VAD_MODEL = {
  file: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/silero-v5.1.2/resolve/main/ggml-silero-v5.1.2.bin',
  sizeMB: 1
}

/** Languages supported by Parakeet TDT 0.6B v3 (auto-detected, no language hint). */
export const PARAKEET_LANGUAGES = new Set('bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro sk sl es sv ru uk'.split(' '))
