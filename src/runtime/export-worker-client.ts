import type { ExportFormat, ExportWorkerRequest, ExportWorkerResponse } from '../workers/export.worker'
import { makeStlWithDiagnostics } from '../voxel'
import type { VoxelAsset } from '../voxel'

export type ExportWorkerResult = {
  data: ArrayBuffer
  diagnostics?: ReturnType<typeof makeStlWithDiagnostics>['diagnostics']
}

export class ExportWorkerClient {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<number, {
    resolve: (result: ExportWorkerResult) => void
    reject: (error: Error) => void
    onProgress?: (progress: number, phase: string) => void
  }>()

  constructor() {
    this.worker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      const response = event.data
      const pending = this.pending.get(response.id)
      if (!pending) return
      if (response.type === 'progress') {
        pending.onProgress?.(response.progress, response.phase)
        return
      }
      this.pending.delete(response.id)
      if (response.type === 'error') pending.reject(new Error(response.message))
      else pending.resolve({ data: response.data, diagnostics: response.diagnostics })
    }
    this.worker.onerror = (event) => {
      const error = new Error(event.message || '导出 Worker 执行失败')
      this.pending.forEach(({ reject }) => reject(error))
      this.pending.clear()
    }
  }

  export(asset: VoxelAsset, format: ExportFormat, voxelSizeMm: number, onProgress?: (progress: number, phase: string) => void): Promise<ExportWorkerResult> {
    const id = this.nextId++
    const request: ExportWorkerRequest = { id, format, asset, voxelSizeMm }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      this.worker.postMessage(request)
    })
  }

  dispose() {
    this.worker.terminate()
    const error = new Error('导出 Worker 已关闭')
    this.pending.forEach(({ reject }) => reject(error))
    this.pending.clear()
  }
}
