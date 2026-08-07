export type ScenePreviewInputVoxel = {
  x: number
  y: number
  z: number
  color: string
}

export type ScenePreviewFace = {
  orientation: 0 | 1 | 2
  plane: number
  a: number
  b: number
  width: number
  height: number
  color: number
}

export type ScenePreviewPayload = {
  bounds: [number, number, number, number, number, number]
  faces: ScenePreviewFace[]
  sourceVoxelCount: number
  sampledVoxelCount: number
}

export type ScenePreviewWorkerRequest = {
  type: 'build-scene-preview'
  requestId: number
  maxVoxels: number
  voxels: Int32Array
}

export type ScenePreviewWorkerResponse = {
  type: 'scene-preview-built'
  requestId: number
  bounds: Int32Array
  faces: Int32Array
  sourceVoxelCount: number
  sampledVoxelCount: number
}

function colorToInt(value: string): number {
  const normalized = value.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return 0x6c827d
  return Number.parseInt(normalized, 16) >>> 0
}

export class ScenePreviewWorkerClient {
  private worker: Worker
  private readonly pending = new Map<number, (payload: ScenePreviewPayload | null) => void>()
  private nextRequestId = 1

  constructor() {
    this.worker = this.createWorker()
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('../workers/scene-preview.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ScenePreviewWorkerResponse>) => {
      const response = event.data
      const resolve = this.pending.get(response.requestId)
      if (!resolve) return
      this.pending.delete(response.requestId)
      const faces: ScenePreviewFace[] = []
      for (let index = 0; index < response.faces.length; index += 7) {
        faces.push({
          orientation: response.faces[index] as 0 | 1 | 2,
          plane: response.faces[index + 1],
          a: response.faces[index + 2],
          b: response.faces[index + 3],
          width: response.faces[index + 4],
          height: response.faces[index + 5],
          color: response.faces[index + 6] >>> 0,
        })
      }
      resolve({
        bounds: [...response.bounds] as [number, number, number, number, number, number],
        faces,
        sourceVoxelCount: response.sourceVoxelCount,
        sampledVoxelCount: response.sampledVoxelCount,
      })
    }
    worker.onerror = () => {
      this.pending.forEach((resolve) => resolve(null))
      this.pending.clear()
    }
    return worker
  }

  build(voxels: ReadonlyArray<ScenePreviewInputVoxel>, maxVoxels: number): Promise<ScenePreviewPayload | null> {
    // A scene row can be changed while a previous 10 MB scene is still being
    // processed. Workers cannot be interrupted in the middle of a synchronous
    // message handler, so replace the worker before starting the newest job.
    if (this.pending.size) {
      this.pending.forEach((resolve) => resolve(null))
      this.pending.clear()
      this.worker.terminate()
      this.worker = this.createWorker()
    }
    const requestId = this.nextRequestId++
    const packed = new Int32Array(voxels.length * 4)
    voxels.forEach((voxel, index) => {
      const offset = index * 4
      packed[offset] = Math.round(voxel.x)
      packed[offset + 1] = Math.round(voxel.y)
      packed[offset + 2] = Math.round(voxel.z)
      packed[offset + 3] = colorToInt(voxel.color)
    })
    const request: ScenePreviewWorkerRequest = { type: 'build-scene-preview', requestId, maxVoxels, voxels: packed }
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.worker.postMessage(request, [packed.buffer])
    })
  }

  cancel(): void {
    this.pending.forEach((resolve) => resolve(null))
    this.pending.clear()
  }

  dispose(): void {
    this.cancel()
    this.worker.terminate()
  }
}
