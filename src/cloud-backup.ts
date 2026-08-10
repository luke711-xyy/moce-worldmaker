import { MoceSceneFile } from './scene-file'
import { VoxelAsset } from './voxel'
import { cacheTransferChunk, clearTransferCache, readTransferChunk } from './local-transfer-cache'

export const CLOUD_TRANSFER_PART_BYTES = 8 * 1024 * 1024
const MAX_RECONNECT_MS = 120_000

export type CloudUsage = {
  assetBytes: number
  sceneBytes: number
  totalBytes: number
  accountBytes: number
  assetQuotaBytes: number
  sceneQuotaBytes: number
  accountQuotaBytes: number
  assetRemainingBytes: number
  sceneRemainingBytes: number
  accountRemainingBytes: number
}

export type CloudAssetSummary = {
  id: string
  name: string
  blobHash: string
  sizeBytes: number
  categoryPath: string[]
  updatedAt: string
  cloudOnly: true
}

export type CloudSceneSummary = {
  id: string
  name: string
  currentVersionId: string
  blobHash: string | null
  sizeBytes: number
  versionCount: number
  updatedAt: string
  cloudOnly: true
  instanceCount?: number
  entityCount?: number
  assemblyCount?: number
}

export type CloudTransferStatus = 'queued' | 'transferring' | 'reconnecting' | 'completed' | 'failed' | 'cancelled'

export type CloudTransfer = {
  transferId: string
  direction: 'upload' | 'download'
  objectKind: 'asset' | 'scene'
  objectId: string
  versionId?: string | null
  name: string
  totalBytes: number
  totalParts: number
  completedParts: number[]
  blobHash: string
  status: CloudTransferStatus
  expiresAt: string
}

export type CloudProgress = {
  transfer: CloudTransfer
  transferredBytes: number
  status: CloudTransferStatus
  error?: string
}

export type CloudConflict = {
  objectKind: 'asset' | 'scene'
  id: string
  name: string
  reason: 'name' | 'id'
}

type TransferStartResponse = {
  transfer: CloudTransfer
  effectiveId?: string
  effectiveName?: string
}

function apiPath(path: string) {
  return path
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), { credentials: 'include', ...init })
  if (!response.ok) {
    let message = `云端请求失败（${response.status}）`
    try {
      const body = await response.json() as { error?: string; code?: string; objectKind?: 'asset' | 'scene'; conflicts?: Array<{ id: string; name: string; reason: 'name' | 'id' }> }
      if (body.code === 'CLOUD_CONFLICT') {
        const error = new Error('云端对象存在冲突') as Error & { code?: string; conflicts?: CloudConflict[] }
        error.code = body.code
        error.conflicts = (body.conflicts ?? []).map((conflict) => ({ objectKind: body.objectKind ?? 'asset', ...conflict }))
        throw error
      }
      if (body.error) message = body.error
    } catch (error) {
      if (error instanceof Error && 'code' in error) throw error
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(error: unknown) {
  if (!(error instanceof Error)) return true
  // HTTP errors are deterministic unless they are a gateway/rate-limit
  // failure. Retrying a missing R2 object for two minutes only makes the UI
  // look like the user's network is broken.
  const status = error.message.match(/[（(](\d{3})[）)]/)?.[1]
  if (status) {
    const code = Number(status)
    return code === 408 || code === 429 || code >= 500
  }
  return !/401|403|400|404|409|410|413|415|422|配额|格式|不存在|参数|校验失败/.test(error.message)
}

async function withReconnect<T>(operation: () => Promise<T>, onStatus: (status: 'transferring' | 'reconnecting', error?: string) => void): Promise<T> {
  const startedAt = Date.now()
  let delay = 500
  while (true) {
    try {
      onStatus('transferring')
      return await operation()
    } catch (error) {
      if (!isRetryable(error) || Date.now() - startedAt >= MAX_RECONNECT_MS) throw error
      onStatus('reconnecting', error instanceof Error ? error.message : '网络暂时不可用')
      await wait(delay)
      delay = Math.min(8_000, delay * 2)
    }
  }
}

export async function loadCloudUsage(): Promise<CloudUsage> {
  const response = await jsonRequest<{ usage: CloudUsage }>('/api/cloud/usage')
  return response.usage
}

export async function loadCloudLibrary(): Promise<{ assets: CloudAssetSummary[]; scenes: CloudSceneSummary[] }> {
  const [assets, scenes] = await Promise.all([
    jsonRequest<{ assets: CloudAssetSummary[] }>('/api/cloud/assets'),
    jsonRequest<{ scenes: CloudSceneSummary[] }>('/api/cloud/scenes'),
  ])
  return { assets: assets.assets, scenes: scenes.scenes }
}

async function startTransfer(payload: Record<string, unknown>): Promise<TransferStartResponse> {
  return jsonRequest<TransferStartResponse>('/api/cloud/transfers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function uploadBytes(bytes: Uint8Array, transfer: CloudTransfer, onProgress?: (progress: CloudProgress) => void): Promise<CloudTransfer> {
  let completed = new Set(transfer.completedParts)
  const emit = (status: CloudTransferStatus, error?: string) => onProgress?.({ transfer: { ...transfer, completedParts: [...completed], status }, transferredBytes: Math.min(bytes.byteLength, completed.size * CLOUD_TRANSFER_PART_BYTES), status, error })
  for (let partNumber = 1; partNumber <= transfer.totalParts; partNumber += 1) {
    if (completed.has(partNumber)) continue
    const offset = (partNumber - 1) * CLOUD_TRANSFER_PART_BYTES
    const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + CLOUD_TRANSFER_PART_BYTES))
    const partHash = await hashBytes(chunk)
    const response = await withReconnect(async () => {
      return jsonRequest<{ transfer: CloudTransfer }>(`/api/cloud/transfers/${encodeURIComponent(transfer.transferId)}/parts/${partNumber}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-part-sha256': partHash },
        body: chunk,
      })
    }, (status, error) => emit(status, error))
    completed = new Set(response.transfer.completedParts)
    emit('transferring')
  }
  const complete = await withReconnect(async () => jsonRequest<{ transfer: CloudTransfer }>(`/api/cloud/transfers/${encodeURIComponent(transfer.transferId)}/complete`, { method: 'POST' }), (status, error) => emit(status, error))
  emit('completed')
  return complete.transfer
}

async function downloadBytes(transfer: CloudTransfer, onProgress?: (progress: CloudProgress) => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let transferred = 0
  for (let partNumber = 1; partNumber <= transfer.totalParts; partNumber += 1) {
    const cached = await readTransferChunk(transfer.transferId, partNumber)
    if (cached) {
      const bytes = new Uint8Array(cached)
      chunks.push(bytes)
      transferred += bytes.byteLength
      onProgress?.({ transfer, transferredBytes: transferred, status: 'transferring' })
      continue
    }
    const part = await withReconnect(async () => {
      const response = await fetch(`/api/cloud/transfers/${encodeURIComponent(transfer.transferId)}/parts/${partNumber}`, { credentials: 'include' })
      if (!response.ok) {
        if (response.status === 404) throw new Error('云端场景内容不存在（404），请重新备份该场景')
        if (response.status === 401 || response.status === 403) throw new Error(`云端下载未授权（${response.status}），请重新登录`)
        throw new Error(`下载分块失败（${response.status}）`)
      }
      return new Uint8Array(await response.arrayBuffer())
    }, (status, error) => onProgress?.({ transfer, transferredBytes: transferred, status, error }))
    await cacheTransferChunk(transfer.transferId, partNumber, part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength))
    chunks.push(part)
    transferred += part.byteLength
    onProgress?.({ transfer, transferredBytes: transferred, status: 'transferring' })
  }
  const result = new Uint8Array(transferred)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  await clearTransferCache(transfer.transferId)
  const actualHash = await hashBytes(result)
  if (transfer.blobHash && actualHash !== transfer.blobHash) throw new Error('下载完成校验失败，云端内容已损坏或不完整')
  return result
}

export async function uploadCloudAsset(asset: VoxelAsset, categoryPath: string[], conflictMode?: 'replace' | 'copy', conflictId?: string, onProgress?: (progress: CloudProgress) => void) {
  const bytes = encodeJson(asset)
  const blobHash = await hashBytes(bytes)
  const started = await startTransfer({ direction: 'upload', objectKind: 'asset', objectId: asset.id, name: asset.name, blobHash, totalBytes: bytes.byteLength, totalParts: Math.ceil(bytes.byteLength / CLOUD_TRANSFER_PART_BYTES), conflictMode, conflictId, metadata: { categoryPath } })
  const transfer = await uploadBytes(bytes, started.transfer, onProgress)
  return { transfer, effectiveId: started.effectiveId ?? asset.id, effectiveName: started.effectiveName ?? asset.name }
}

export async function uploadCloudScene(scene: MoceSceneFile, conflictMode?: 'replace' | 'copy', conflictId?: string, onProgress?: (progress: CloudProgress) => void) {
  const bytes = encodeJson(scene)
  const blobHash = await hashBytes(bytes)
  const summary = { instanceCount: scene.scene.instances.length, entityCount: scene.scene.instances.length + new Set(scene.scene.customVoxels.map((voxel) => voxel.entityId).filter(Boolean)).size, assemblyCount: scene.scene.assemblies?.length ?? 0 }
  const started = await startTransfer({ direction: 'upload', objectKind: 'scene', objectId: scene.scene.name, name: scene.scene.name, blobHash, totalBytes: bytes.byteLength, totalParts: Math.ceil(bytes.byteLength / CLOUD_TRANSFER_PART_BYTES), conflictMode, conflictId, metadata: { summary } })
  const transfer = await uploadBytes(bytes, started.transfer, onProgress)
  return { transfer, effectiveId: started.effectiveId ?? scene.scene.name, effectiveName: started.effectiveName ?? scene.scene.name }
}

export async function downloadCloudObject(kind: 'asset' | 'scene', id: string, versionId?: string, onProgress?: (progress: CloudProgress) => void): Promise<{ bytes: Uint8Array; transfer: CloudTransfer }> {
  const started = await startTransfer({ direction: 'download', objectKind: kind, objectId: id, versionId, name: id, blobHash: '0'.repeat(64), totalBytes: 1, totalParts: 1 })
  try {
    const bytes = await downloadBytes(started.transfer, onProgress)
    onProgress?.({ transfer: { ...started.transfer, status: 'completed' }, transferredBytes: bytes.byteLength, status: 'completed' })
    await jsonRequest(`/api/cloud/transfers/${encodeURIComponent(started.transfer.transferId)}`, { method: 'DELETE' }).catch(() => undefined)
    return { bytes, transfer: started.transfer }
  } catch (error) {
    const message = error instanceof Error ? error.message : '云端下载失败'
    onProgress?.({ transfer: { ...started.transfer, status: 'failed' }, transferredBytes: 0, status: 'failed', error: message })
    await clearTransferCache(started.transfer.transferId)
    await jsonRequest(`/api/cloud/transfers/${encodeURIComponent(started.transfer.transferId)}`, { method: 'DELETE' }).catch(() => undefined)
    throw error
  }
}

export async function deleteCloudAsset(id: string) {
  await jsonRequest(`/api/cloud/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function deleteCloudScene(id: string) {
  await jsonRequest(`/api/cloud/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function listCloudSceneVersions(id: string) {
  return jsonRequest<{ versions: Array<{ id: string; sceneId: string; name: string; blobHash: string; sizeBytes: number; createdAt: string }> }>(`/api/cloud/scenes/${encodeURIComponent(id)}/versions`)
}
