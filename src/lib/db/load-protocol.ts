/**
 * The messages between `loader.ts` and `load-worker.ts`.
 *
 * `start` hands over a copy of the capture's bytes. The worker answers with
 * `total` once it knows how many rows there are, then one `batch` per `next`
 * — the first one unasked — and `done` when the last has been taken. `error`
 * ends the load. The IPC buffer in a `batch` is transferred, not copied.
 */
export type LoadWorkerRequest = { type: 'start'; buffer: ArrayBuffer } | { type: 'next' }

export type LoadWorkerReply =
  | { type: 'total'; total: number }
  | { type: 'batch'; table: string; columns: string[]; ipc: Uint8Array; rows: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
