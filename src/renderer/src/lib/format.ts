/** "874 MB", "1.6 GB" */
export const sizeMB = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`)

/** The message of an error thrown by an IPC call, without Electron's "Error invoking remote method" prefix. */
export const ipcError = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
