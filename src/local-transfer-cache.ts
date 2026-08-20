const DB_NAME = 'moce-worldmaker-local-transfers-v1'
const DB_VERSION = 1
const STORE = 'chunks'

type CachedChunk = {
  key: string
  transferId: string
  partNumber: number
  bytes: ArrayBuffer
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地传输缓存打开失败'))
  })
  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地传输缓存操作失败'))
  })
}

export async function cacheTransferChunk(transferId: string, partNumber: number, bytes: ArrayBuffer): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(STORE, 'readwrite')
  const value: CachedChunk = { key: `${transferId}:${partNumber}`, transferId, partNumber, bytes: bytes.slice(0) }
  await requestResult(transaction.objectStore(STORE).put(value))
}

export async function readTransferChunk(transferId: string, partNumber: number): Promise<ArrayBuffer | undefined> {
  const database = await openDatabase()
  const transaction = database.transaction(STORE, 'readonly')
  const value = await requestResult(transaction.objectStore(STORE).get(`${transferId}:${partNumber}`)) as CachedChunk | undefined
  return value?.bytes?.slice(0)
}

export async function clearTransferCache(transferId: string): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(STORE, 'readwrite')
  const store = transaction.objectStore(STORE)
  const values = await requestResult(store.getAll()) as CachedChunk[]
  for (const value of values) if (value.transferId === transferId) store.delete(value.key)
}

