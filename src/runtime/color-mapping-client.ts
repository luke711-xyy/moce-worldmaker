import { WeightedColorSample } from '../color-palettes'

export type ColorMappingResult = {
  allowedCodes: string[]
  mapping: Record<string, string>
}

type Pending = {
  resolve: (result: ColorMappingResult) => void
  reject: (error: Error) => void
}

export class ColorMappingWorkerClient {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor() {
    this.worker = new Worker(new URL('../workers/color-mapping.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<{ id: number; allowedCodes?: string[]; mapping?: Record<string, string>; error?: string }>) => {
      const response = event.data
      const request = this.pending.get(response.id)
      if (!request) return
      this.pending.delete(response.id)
      if (response.error) request.reject(new Error(response.error))
      else request.resolve({ allowedCodes: response.allowedCodes ?? [], mapping: response.mapping ?? {} })
    }
    this.worker.onerror = (event) => {
      const error = new Error(event.message || '颜色映射 Worker 执行失败')
      this.pending.forEach((request) => request.reject(error))
      this.pending.clear()
    }
  }

  compute(samples: WeightedColorSample[], maxColors: number, allowedCodes?: string[]): Promise<ColorMappingResult> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, samples, maxColors, allowedCodes })
    })
  }

  dispose() {
    this.worker.terminate()
    const error = new Error('颜色映射 Worker 已关闭')
    this.pending.forEach((request) => request.reject(error))
    this.pending.clear()
  }
}
