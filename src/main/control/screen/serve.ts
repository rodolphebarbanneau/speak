/**
 * The bridge process's side (see bridge.ts): one JSON request per line on stdin, one reply per
 * line on stdout, in order, each with its request's id. Runs under Electron as plain Node: only
 * Node's own modules and koffi here, never Electron's nor the main process's.
 */

export type Request = Record<string, any> & { op: string }

export function serve(handle: (req: Request) => Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ready: true }) + '\n')
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let id: unknown
      let res: Record<string, unknown>
      try {
        const req = JSON.parse(line) as Request
        id = req.id
        // Speak stopped waiting: acting now would be too late (it may have done it another way).
        res = typeof req.until === 'number' && Date.now() > req.until ? { error: 'expired' } : (handle(req) ?? {})
      } catch (err) {
        res = { error: (err as Error).message }
      }
      process.stdout.write(JSON.stringify({ ...res, id }) + '\n')
    }
  })
  // Speak is gone: so is its bridge.
  process.stdin.on('end', () => process.exit(0))
}

/** Wait, synchronously (the bridge answers one request at a time). */
export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
