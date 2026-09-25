/**
 * The load worker: a capture's bytes in, DuckDB-ready Arrow batches out.
 *
 * Everything between the pcap file and the IPC buffer DuckDB reads — parsing,
 * decoding, flattening into rows, encoding as Arrow — used to run on the page's
 * own thread. Behind a loading screen that only cost time; with the capture on
 * screen while DuckDB fills, it cost the page: a profile of a 50MB capture
 * showed the main thread idle for a quarter of the load, and the reader got
 * hundreds of stalls of up to half a second each. Here it runs on its own core.
 *
 * It parses the capture again rather than being handed the page's parsed
 * packets. Posting those would mean structured-cloning millions of objects,
 * which costs about what parsing does and would happen on the page's thread;
 * the bytes clone in milliseconds, and the parsers are deterministic, so the
 * frame numbers match the page's exactly — which is all the filter needs,
 * since DuckDB only ever answers with frame numbers.
 *
 * Batches go out one per request (`next`), with the following one encoded
 * while DuckDB inserts the last. That keeps at most two encoded batches alive
 * however far ahead the worker could otherwise race.
 */
import { isPcapng, parsePcap, parsePcapng } from '../pcap'
import { parseBgpFromPackets } from '../bgp'
import { flattenCapture } from './rows'
import { encodeTable } from './arrow-batch'
import type { LoadWorkerReply, LoadWorkerRequest } from './load-protocol'

type Batch = Extract<LoadWorkerReply, { type: 'batch' }>

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LoadWorkerRequest>) => void) | null
  postMessage(message: LoadWorkerReply, transfer?: Transferable[]): void
}

let batches: Generator<Batch> | null = null
let prepared: Batch | null = null

function* allBatches(buffer: ArrayBuffer): Generator<Batch> {
  const pcap = isPcapng(buffer) ? parsePcapng(buffer) : parsePcap(buffer)
  const tables = flattenCapture(parseBgpFromPackets(pcap.packets).packets)
  const total = tables.reduce((sum, [, rows]) => sum + rows.length, 0)
  scope.postMessage({ type: 'total', total })
  for (const [table, rows] of tables) {
    for (const batch of encodeTable(rows)) yield { type: 'batch', table, ...batch }
    // Nothing needs a table's rows once they are encoded; on a large capture
    // they are the biggest thing this worker holds.
    rows.length = 0
  }
}

function prepare(): void {
  const step = batches?.next()
  prepared = step && !step.done ? step.value : null
}

function send(): void {
  const batch = prepared
  if (!batch) {
    scope.postMessage({ type: 'done' })
    return
  }
  scope.postMessage(batch, [batch.ipc.buffer as ArrayBuffer])
  // Encode the next one while DuckDB is busy with this one.
  prepare()
}

scope.onmessage = (event) => {
  try {
    if (event.data.type === 'start') {
      batches = allBatches(event.data.buffer)
      prepare()
      send()
    } else if (event.data.type === 'next') {
      send()
    }
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
