import { MoceSceneFile } from './scene-file'
import { VoxelAsset } from './voxel'
import { withAssetThumbnail } from './asset-thumbnail'

export type LocalLibraryAssetSummary = Pick<VoxelAsset, 'id' | 'name' | 'kind' | 'style' | 'width' | 'depth' | 'height'> & {
  voxelCount: number
  updatedAt: string | null
}

export type LocalLibrarySceneSummary = {
  id: string
  name: string
  assetCount: number
  instanceCount: number
  customVoxelCount: number
  assemblyCount: number
  entityCount: number
  updatedAt: string
}

export type LocalLibrarySnapshot = {
  assets: LocalLibraryAssetSummary[]
  scenes: LocalLibrarySceneSummary[]
  assetCategories: string[][]
}

type LocalSceneRecord = {
  id: string
  sceneFile: MoceSceneFile
  createdAt: string
  updatedAt: string
}

const DB_NAME = 'moce-worldmaker-local-library-v1'
const DB_VERSION = 2
const ASSETS_STORE = 'assets'
const ASSET_REVISIONS_STORE = 'asset-revisions'
const SCENES_STORE = 'scenes'
const META_STORE = 'metadata'
const CATEGORIES_KEY = 'asset-categories'

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
      if (!database.objectStoreNames.contains(ASSETS_STORE)) database.createObjectStore(ASSETS_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(ASSET_REVISIONS_STORE)) database.createObjectStore(ASSET_REVISIONS_STORE, { keyPath: 'key' })
      if (!database.objectStoreNames.contains(SCENES_STORE)) database.createObjectStore(SCENES_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地工程数据库打开失败'))
  })
  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地工程数据库操作失败'))
  })
}

async function readAll<T>(storeName: string): Promise<T[]> {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readonly')
  return requestResult(transaction.objectStore(storeName).getAll())
}

async function put(storeName: string, value: unknown): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readwrite')
  await requestResult(transaction.objectStore(storeName).put(structuredClone(value)))
}

async function deleteValue(storeName: string, key: IDBValidKey): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readwrite')
  await requestResult(transaction.objectStore(storeName).delete(key))
}

async function readMeta<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase()
  const transaction = database.transaction(META_STORE, 'readonly')
  return requestResult(transaction.objectStore(META_STORE).get(key))
}

async function writeMeta(key: string, value: unknown): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(META_STORE, 'readwrite')
  await requestResult(transaction.objectStore(META_STORE).put(structuredClone(value), key))
}

function categoryPath(asset: VoxelAsset): string[] {
  return Array.isArray(asset.categoryPath) && asset.categoryPath.length
    ? asset.categoryPath.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : ['未命名类别']
}

function collectCategories(assets: VoxelAsset[], explicit: string[][] = []): string[][] {
  const result = new Map<string, string[]>()
  for (const path of [...explicit, ...assets.filter((asset) => asset.isTemplate !== false).map(categoryPath)]) {
    for (let index = 1; index <= path.length; index += 1) {
      const prefix = path.slice(0, index)
      result.set(prefix.join('\u001f'), prefix)
    }
  }
  return [...result.values()].sort((left, right) => left.join('\u001f').localeCompare(right.join('\u001f')))
}

function assetSummary(asset: VoxelAsset, updatedAt: string | null): LocalLibraryAssetSummary {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    style: asset.style,
    width: asset.width,
    depth: asset.depth,
    height: asset.height,
    voxelCount: asset.voxels.length,
    updatedAt,
  }
}

function sceneSummary(record: LocalSceneRecord): LocalLibrarySceneSummary {
  const scene = record.sceneFile.scene
  const entityIds = new Set(scene.customVoxels.map((voxel, index) => voxel.entityId ?? `legacy-${voxel.x},${voxel.y},${voxel.z}-${index}`))
  return {
    id: record.id,
    name: scene.name || '未命名场景',
    assetCount: record.sceneFile.sceneAssets.length,
    instanceCount: scene.instances.length,
    customVoxelCount: scene.customVoxels.length,
    assemblyCount: scene.assemblies?.length ?? 0,
    entityCount: scene.instances.length + entityIds.size,
    updatedAt: record.updatedAt,
  }
}

export async function loadLocalAssets(): Promise<VoxelAsset[]> {
  return readAll<VoxelAsset>(ASSETS_STORE)
}

export async function saveLocalAsset(asset: VoxelAsset): Promise<VoxelAsset> {
  const stored = { ...structuredClone(withAssetThumbnail(asset)), isTemplate: asset.isTemplate !== false }
  await put(ASSETS_STORE, stored)
  await put(ASSET_REVISIONS_STORE, {
    key: `${stored.id}:${new Date().toISOString()}:${crypto.randomUUID()}`,
    assetId: stored.id,
    revisionId: crypto.randomUUID(),
    asset: stored,
    createdAt: new Date().toISOString(),
  })
  return stored
}

export async function deleteLocalAsset(assetId: string): Promise<void> {
  await deleteValue(ASSETS_STORE, assetId)
}

export async function loadLocalAssetCategories(): Promise<string[][]> {
  return (await readMeta<string[][]>(CATEGORIES_KEY)) ?? []
}

export async function saveLocalAssetCategories(categories: string[][]): Promise<void> {
  await writeMeta(CATEGORIES_KEY, categories)
}

export async function loadLocalScene(sceneId: string): Promise<MoceSceneFile> {
  const database = await openDatabase()
  const transaction = database.transaction(SCENES_STORE, 'readonly')
  const record = await requestResult(transaction.objectStore(SCENES_STORE).get(sceneId)) as LocalSceneRecord | undefined
  if (!record) throw new Error('本地场景不存在')
  return structuredClone(record.sceneFile)
}

export async function saveLocalScene(sceneFile: MoceSceneFile, sceneId?: string): Promise<{ id: string; scene: LocalLibrarySceneSummary }> {
  const now = new Date().toISOString()
  const id = sceneId || `local-scene-${crypto.randomUUID()}`
  const database = await openDatabase()
  const transaction = database.transaction(SCENES_STORE, 'readonly')
  const previous = await requestResult(transaction.objectStore(SCENES_STORE).get(id)) as LocalSceneRecord | undefined
  const record: LocalSceneRecord = {
    id,
    sceneFile: structuredClone(sceneFile),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  await put(SCENES_STORE, record)
  return { id, scene: sceneSummary(record) }
}

export async function deleteLocalScene(sceneId: string): Promise<void> {
  await deleteValue(SCENES_STORE, sceneId)
}

export async function duplicateLocalScene(sceneId: string, requestedName?: string): Promise<{ id: string; scene: LocalLibrarySceneSummary }> {
  const source = await loadLocalScene(sceneId)
  const records = await readAll<LocalSceneRecord>(SCENES_STORE)
  const base = requestedName?.trim() || `${source.scene.name || '未命名场景'}·副本`
  const names = new Set(records.map((record) => record.sceneFile.scene.name.trim()))
  let name = base
  let index = 1
  while (names.has(name)) name = `${base} (${index++})`
  source.scene.name = name
  return saveLocalScene(source)
}

export async function loadLocalLibrary(): Promise<LocalLibrarySnapshot> {
  const [assets, records, explicitCategories] = await Promise.all([
    loadLocalAssets(),
    readAll<LocalSceneRecord>(SCENES_STORE),
    loadLocalAssetCategories(),
  ])
  const assetTimes = new Map<string, string | null>()
  const summaries = assets.map((asset) => assetSummary(asset, assetTimes.get(asset.id) ?? null))
  return {
    assets: summaries,
    scenes: records.map(sceneSummary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    assetCategories: collectCategories(assets, explicitCategories),
  }
}

export async function initializeLocalLibrary(defaultAssets: VoxelAsset[]): Promise<{ assets: VoxelAsset[]; categories: string[][] }> {
  const stored = await loadLocalAssets()
  const preparedStored = stored.map(withAssetThumbnail)
  const migrated = preparedStored.filter((asset, index) => asset !== stored[index])
  if (migrated.length) await Promise.all(migrated.map((asset) => saveLocalAsset(asset)))
  const preparedDefaults = defaultAssets.map(withAssetThumbnail)
  const categories = await loadLocalAssetCategories()
  return {
    assets: [...preparedDefaults.map((asset) => structuredClone(asset)), ...preparedStored.filter((asset) => !defaultAssets.some((item) => item.id === asset.id))],
    categories: collectCategories([...preparedDefaults, ...preparedStored], categories),
  }
}

export async function clearLocalLibrary(): Promise<void> {
  const database = await openDatabase()
  await Promise.all([ASSETS_STORE, ASSET_REVISIONS_STORE, SCENES_STORE, META_STORE].map(async (storeName) => {
    const transaction = database.transaction(storeName, 'readwrite')
    await requestResult(transaction.objectStore(storeName).clear())
  }))
}
