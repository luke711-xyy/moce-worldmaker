import { MoceSceneFile } from './scene-file'

export type LocalSceneRef = {
  name: string
  libraryId?: string
}

export type LocalSceneDraft = {
  ref: LocalSceneRef | null
  sceneFile: MoceSceneFile
  updatedAt: number
}

const ACTIVE_REF_KEY = 'moce-worldmaker-active-scene-v1'
const FALLBACK_DRAFT_KEY = 'moce-worldmaker-scene-draft-v1'
const DRAFT_DB_NAME = 'moce-worldmaker-local-v1'
const DRAFT_STORE_NAME = 'scene-drafts'
const DRAFT_KEY = 'current'

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DRAFT_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME)) request.result.createObjectStore(DRAFT_STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地场景存储打开失败'))
  })
  return databasePromise
}

function fallbackReadDraft(): LocalSceneDraft | null {
  try {
    const raw = localStorage.getItem(FALLBACK_DRAFT_KEY)
    return raw ? JSON.parse(raw) as LocalSceneDraft : null
  } catch {
    return null
  }
}

function fallbackWriteDraft(draft: LocalSceneDraft): void {
  try {
    localStorage.setItem(FALLBACK_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // The IndexedDB path is the normal path. A quota-limited fallback is
    // intentionally best-effort and must never interrupt editing.
  }
}

function fallbackClearDraft(): void {
  try { localStorage.removeItem(FALLBACK_DRAFT_KEY) } catch { /* best effort */ }
}

export function readLocalSceneRef(): LocalSceneRef | null {
  try {
    const raw = localStorage.getItem(ACTIVE_REF_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<LocalSceneRef>
    return typeof value.name === 'string' && value.name.trim()
      ? { name: value.name, ...(typeof value.libraryId === 'string' && value.libraryId ? { libraryId: value.libraryId } : {}) }
      : null
  } catch {
    return null
  }
}

export function writeLocalSceneRef(ref: LocalSceneRef | null): void {
  try {
    if (ref) localStorage.setItem(ACTIVE_REF_KEY, JSON.stringify(ref))
    else localStorage.removeItem(ACTIVE_REF_KEY)
  } catch {
    // A local session pointer is an enhancement, not a reason to block edits.
  }
}

export async function readLocalSceneDraft(): Promise<LocalSceneDraft | null> {
  const fallback = fallbackReadDraft()
  try {
    const database = await openDatabase()
    return await new Promise<LocalSceneDraft | null>((resolve, reject) => {
      const request = database.transaction(DRAFT_STORE_NAME, 'readonly').objectStore(DRAFT_STORE_NAME).get(DRAFT_KEY)
      request.onsuccess = () => {
        const indexedDraft = (request.result as LocalSceneDraft | undefined) ?? null
        // pagehide can finish localStorage synchronously while the IndexedDB
        // write is still pending. If an older IndexedDB draft is present,
        // returning it would make a refresh appear to lose the last edits.
        if (!indexedDraft) {
          resolve(fallback)
          return
        }
        if (!fallback) {
          resolve(indexedDraft)
          return
        }
        resolve((fallback.updatedAt ?? 0) > (indexedDraft.updatedAt ?? 0) ? fallback : indexedDraft)
      }
      request.onerror = () => reject(request.error ?? new Error('本地草稿读取失败'))
    })
  } catch {
    return fallback
  }
}

export async function writeLocalSceneDraft(draft: LocalSceneDraft): Promise<void> {
  // pagehide/visibilitychange may give IndexedDB too little time to finish.
  // Write the small-browser fallback before the first await so a refresh or
  // tab close always leaves a recoverable copy. IndexedDB remains the normal
  // durable store and will overwrite the fallback on the next successful
  // restore cycle.
  fallbackWriteDraft(draft)
  try {
    const database = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(DRAFT_STORE_NAME, 'readwrite').objectStore(DRAFT_STORE_NAME).put(structuredClone(draft), DRAFT_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('本地草稿保存失败'))
    })
  } catch { /* the synchronous fallback above is already available */ }
}

export async function clearLocalSceneDraft(): Promise<void> {
  try {
    const database = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(DRAFT_STORE_NAME, 'readwrite').objectStore(DRAFT_STORE_NAME).delete(DRAFT_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('本地草稿清理失败'))
    })
  } catch {
    // Continue with the fallback cleanup even when IndexedDB is unavailable.
  }
  fallbackClearDraft()
}
