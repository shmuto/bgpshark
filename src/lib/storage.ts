/**
 * IndexedDB storage for persisting pcap file data across browser reloads.
 *
 * The capture is stored as a Blob, not an ArrayBuffer. Chromium refuses any
 * single IndexedDB value whose serialised form exceeds ~127MB ("The serialized
 * keys and/or value are too large"), and an ArrayBuffer is serialised inline;
 * a Blob is stored by reference and has no such ceiling. Writing a Blob is
 * also several times faster, because the bytes are not structured-cloned on
 * the main thread.
 *
 * Every request settles through its *transaction*, not the request itself.
 * That oversized-value failure is reported only as a transaction `abort` — the
 * request's `error` event never fires — and listening to the request alone
 * once left a load waiting on a promise that could never settle, stuck on
 * "Saving for next visit" forever.
 */

const DB_NAME = 'bgpshark-storage'
const DB_VERSION = 1
const STORE_NAME = 'pcap-files'
const FILE_KEY = 'current-file'

/**
 * How long a save may take before it is given up on. Writing even a large
 * Blob takes well under a second, so this only bounds a store that has gone
 * silent; a reload then simply finds nothing to restore.
 */
const SAVE_TIMEOUT_MS = 30_000

interface StoredFile {
  fileName: string
  /** A Blob since the size fix; older entries hold the bytes as an ArrayBuffer. */
  data: Blob | ArrayBuffer
  savedAt: number
}

let dbInstance: IDBDatabase | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance)
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'))
    }

    request.onsuccess = () => {
      dbInstance = request.result
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

/**
 * Run one request in its own transaction and settle when the transaction does.
 *
 * Resolves with the request's result on `complete`; rejects on `abort` or
 * `error` from either the request or the transaction, and on a synchronous
 * throw from `run` (an unclonable value throws from `put` itself).
 */
function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  timeoutMs?: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      fn()
    }

    let transaction: IDBTransaction
    let request: IDBRequest<T>
    try {
      transaction = db.transaction(STORE_NAME, mode)
      request = run(transaction.objectStore(STORE_NAME))
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const fail = () =>
      finish(() => reject(transaction.error ?? request.error ?? new Error('IndexedDB transaction failed')))
    transaction.oncomplete = () => finish(() => resolve(request.result))
    transaction.onabort = fail
    transaction.onerror = fail

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        finish(() => reject(new Error('IndexedDB transaction timed out')))
        try {
          transaction.abort()
        } catch {
          // Already finished; nothing to abort.
        }
      }, timeoutMs)
    }
  })
}

/**
 * Save pcap file data to IndexedDB.
 *
 * Pass the `File` the user chose where there is one: it is stored as is. An
 * ArrayBuffer is wrapped in a Blob first, for the size reason above.
 */
export async function savePcapFile(fileName: string, data: Blob | ArrayBuffer): Promise<void> {
  const db = await openDatabase()
  const storedFile: StoredFile = {
    fileName,
    data: data instanceof Blob ? data : new Blob([data]),
    savedAt: Date.now(),
  }
  await transact(db, 'readwrite', (store) => store.put(storedFile, FILE_KEY), SAVE_TIMEOUT_MS)
}

/**
 * Load pcap file data from IndexedDB
 */
export async function loadPcapFile(): Promise<{ fileName: string; data: ArrayBuffer } | null> {
  try {
    const db = await openDatabase()
    const result = (await transact(db, 'readonly', (store) => store.get(FILE_KEY))) as
      | StoredFile
      | undefined
    if (!result) return null
    const data = result.data instanceof Blob ? await result.data.arrayBuffer() : result.data
    return { fileName: result.fileName, data }
  } catch {
    // IndexedDB not available or error occurred
    return null
  }
}

/**
 * Clear stored pcap file from IndexedDB
 */
export async function clearPcapFile(): Promise<void> {
  try {
    const db = await openDatabase()
    await transact(db, 'readwrite', (store) => store.delete(FILE_KEY))
  } catch {
    // Ignore errors when clearing
  }
}

/**
 * Check if there's a stored pcap file
 */
export async function hasStoredFile(): Promise<boolean> {
  try {
    const file = await loadPcapFile()
    return file !== null
  } catch {
    return false
  }
}
