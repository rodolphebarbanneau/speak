/** "874 MB", "1.6 GB" */
export const sizeMB = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`)

/** The message of an error thrown by an IPC call, without Electron's "Error invoking remote method" prefix. */
export const ipcError = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** "github.com/rodolphe…/issues/12": too long a name loses its middle, where it says the least. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) * 0.55)
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`
}

/** What a context is, in a word. */
export const CONTEXT_KINDS = { folder: 'folder', git: 'git repository', url: 'web page', clipboard: 'clipboard' } as const
