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
        materialIds: response.materialIds,
        indices: response.indices,
        quadCount: response.quadCount,
      })
    }
  }

  build(chunkKey: string, revision: number, voxels: ReadonlyArray<MesherVoxel>): Promise<GreedyMeshPayload | null> {
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
    return new Promise((resolve) => {
      this.pending.set(requestId, { revision, resolve })
      this.worker.postMessage(request, [packed.buffer])
    })
  }

  dispose(): void {
    this.worker.terminate()
    this.pending.forEach(({ resolve }) => resolve(null))
    this.pending.clear()
  }
}
