/// <reference lib="webworker" />
import { buildGreedyMesh, MesherVoxel } from '../runtime/greedy-mesher'

export type ChunkMeshWorkerRequest = {
  type: 'build-chunk'
  requestId: number
  chunkKey: string
  revision: number
  voxels: Int32Array
}

export type ChunkMeshWorkerResponse = {
  type: 'chunk-built'
  requestId: number
  chunkKey: string
  revision: number
  positions: Float32Array
  normals: Int8Array
  materialIds: Uint8Array
  indices: Uint32Array
  quadCount: number
}

self.onmessage = (event: MessageEvent<ChunkMeshWorkerRequest>) => {
  const request = event.data
  if (request.type !== 'build-chunk') return
  const voxels: MesherVoxel[] = []
  for (let index = 0; index < request.voxels.length; index += 4) {
    voxels.push({
      gx: request.voxels[index],
      gy: request.voxels[index + 1],
      gz: request.voxels[index + 2],
      materialId: request.voxels[index + 3],
    })
  }
  const mesh = buildGreedyMesh(voxels)
  const response: ChunkMeshWorkerResponse = {
    type: 'chunk-built',
    requestId: request.requestId,
    chunkKey: request.chunkKey,
    revision: request.revision,
    ...mesh,
  }
  self.postMessage(response, {
    transfer: [
      response.positions.buffer,
      response.normals.buffer,
      response.materialIds.buffer,
      response.indices.buffer,
    ],
  })
}

export {}
