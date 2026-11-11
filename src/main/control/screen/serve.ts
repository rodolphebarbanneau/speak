/**
 * The bridge process's side (see bridge.ts): an Electron utility process, answering each request
 * Speak posts with one reply, in order, carrying the request's id. Only Node's own modules and
 * koffi here, never Electron's nor the main process's.
 */

export type Request = Record<string, any> & { op: string }

export function serve(handle: (req: Request) => Record<string, unknown>): void {
  const port = process.parentPort
  port.on('message', ({ data: req }: { data: Request }) => {
    let res: Record<string, unknown>
    try {
      // Speak stopped waiting: acting now would be too late (it may have done it another way).
      res = typeof req.until === 'number' && Date.now() > req.until ? { error: 'expired' } : (handle(req) ?? {})
    } catch (err) {
      res = { error: (err as Error).message }
    }
    port.postMessage({ ...res, id: req.id })
  })
  port.postMessage({ ready: true })
}

/** Wait, synchronously (the bridge answers one request at a time). */
export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
