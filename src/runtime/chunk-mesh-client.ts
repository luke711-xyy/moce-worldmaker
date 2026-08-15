import { GreedyMeshPayload, MesherVoxel } from './greedy-mesher'
import type { ChunkMeshWorkerRequest, ChunkMeshWorkerResponse } from '../workers/chunk-mesh.worker'

type PendingRequest = {
  revision: number
  resolve: (mesh: GreedyMeshPayload | null) => void
}

export class ChunkMeshWorkerClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private readonly latestRevision = new Map<string, number>()
  private readonly meshCache = new Map<string, GreedyMeshPayload>()
  private readonly meshCachePromises = new Map<string, Promise<GreedyMeshPayload | null>>()
  private readonly maxCachedMeshes = 8
  private nextRequestId = 1

  constructor() {
    this.worker = new Worker(new URL('../workers/chunk-mesh.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<ChunkMeshWorkerResponse>) => {
      const response = event.data
      const pending = this.pending.get(response.requestId)
      if (!pending) return
      this.pending.delete(response.requestId)
      if (this.latestRevision.get(response.chunkKey) !== response.revision || pending.revision !== response.revision) {
        pending.resolve(null)
        return
      }
      pending.resolve({
        positions: response.positions,
        normals: response.normals,
        ao: response.ao,
        materialIds: response.materialIds,
        indices: response.indices,
        outlinePositions: response.outlinePositions,
        quadCount: response.quadCount,
      })
    }
  }

  build(chunkKey: string, revision: number, voxels: ReadonlyArray<MesherVoxel>, cacheKey?: string): Promise<GreedyMeshPayload | null> {
    if (cacheKey) {
      const cached = this.meshCache.get(cacheKey)
      if (cached) {
        this.meshCache.delete(cacheKey)
        this.meshCache.set(cacheKey, cached)
        return Promise.resolve(cached)
      }
      const pending = this.meshCachePromises.get(cacheKey)
      if (pending) return pending
    }
    const requestId = this.nextRequestId++
    this.latestRevision.set(chunkKey, revision)
    const packed = new Int32Array(voxels.length * 4)
    voxels.forEach((voxel, index) => {
      const offset = index * 4
      packed[offset] = voxel.gx
      packed[offset + 1] = voxel.gy
      packed[offset + 2] = voxel.gz
      packed[offset + 3] = voxel.materialId
    })
    const request: ChunkMeshWorkerRequest = { type: 'build-chunk', requestId, chunkKey, revision, voxels: packed }
    const requestPromise = new Promise<GreedyMeshPayload | null>((resolve) => {
      this.pending.set(requestId, { revision, resolve })
      this.worker.postMessage(request, [packed.buffer])
    })
    if (!cacheKey) return requestPromise

    const cachedPromise = requestPromise.then((payload) => {
      this.meshCachePromises.delete(cacheKey)
      if (!payload) return null
      this.meshCache.set(cacheKey, payload)
      while (this.meshCache.size > this.maxCachedMeshes) {
        const oldest = this.meshCache.keys().next().value as string | undefined
        if (!oldest) break
        this.meshCache.delete(oldest)
      }
      return payload
    })
    this.meshCachePromises.set(cacheKey, cachedPromise)
    return cachedPromise
  }

  dispose(): void {
    this.worker.terminate()
    this.pending.forEach(({ resolve }) => resolve(null))
    this.pending.clear()
    this.meshCache.clear()
    this.meshCachePromises.clear()
  }
}
