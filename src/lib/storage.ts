/**
 * IndexedDB storage for persisting pcap file data across browser reloads.
 */

const DB_NAME = 'bgpshark-storage'
const DB_VERSION = 1
const STORE_NAME = 'pcap-files'
const FILE_KEY = 'current-file'

interface StoredFile {
  fileName: string
  data: ArrayBuffer
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
 * Save pcap file data to IndexedDB
 */
export async function savePcapFile(fileName: string, data: ArrayBuffer): Promise<void> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)

    const storedFile: StoredFile = {
      fileName,
      data,
      savedAt: Date.now(),
    }

    const request = store.put(storedFile, FILE_KEY)

    request.onerror = () => {
      reject(new Error('Failed to save file to IndexedDB'))
    }

    request.onsuccess = () => {
      resolve()
    }
  })
}

/**
 * Load pcap file data from IndexedDB
 */
export async function loadPcapFile(): Promise<{ fileName: string; data: ArrayBuffer } | null> {
  try {
    const db = await openDatabase()

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(FILE_KEY)

      request.onerror = () => {
        reject(new Error('Failed to load file from IndexedDB'))
      }

      request.onsuccess = () => {
        const result = request.result as StoredFile | undefined
        if (result) {
          resolve({
            fileName: result.fileName,
            data: result.data,
          })
        } else {
          resolve(null)
        }
      }
    })
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

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.delete(FILE_KEY)

      request.onerror = () => {
        reject(new Error('Failed to clear file from IndexedDB'))
      }

      request.onsuccess = () => {
        resolve()
      }
    })
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
