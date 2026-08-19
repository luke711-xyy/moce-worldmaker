import { encodeGlb, encodeVox } from '../voxel-formats'
import { makeStlWithDiagnostics } from '../voxel'
import type { VoxelAsset } from '../voxel'

export type ExportFormat = 'stl' | 'glb' | 'vox'

export type ExportWorkerRequest = {
  id: number
  format: ExportFormat
  asset: VoxelAsset
  voxelSizeMm: number
}

export type ExportWorkerResponse =
  | { id: number; type: 'progress'; progress: number; phase: string }
  | { id: number; type: 'complete'; data: ArrayBuffer; diagnostics?: ReturnType<typeof makeStlWithDiagnostics>['diagnostics'] }
  | { id: number; type: 'error'; message: string }

self.onmessage = async (event: MessageEvent<ExportWorkerRequest>) => {
  const { id, format, asset, voxelSizeMm } = event.data
  try {
    self.postMessage({ id, type: 'progress', progress: 0.05, phase: '正在准备导出数据' } satisfies ExportWorkerResponse)
    if (format === 'stl') {
      self.postMessage({ id, type: 'progress', progress: 0.2, phase: '正在生成 STL 表面' } satisfies ExportWorkerResponse)
      const result = makeStlWithDiagnostics(asset, voxelSizeMm)
      const data = new TextEncoder().encode(result.stl)
      self.postMessage({ id, type: 'complete', data: data.buffer, diagnostics: result.diagnostics } satisfies ExportWorkerResponse, [data.buffer])
      return
    }
    if (format === 'glb') {
      self.postMessage({ id, type: 'progress', progress: 0.2, phase: '正在生成 GLB 网格' } satisfies ExportWorkerResponse)
      const data = await encodeGlb(asset, (voxel) => voxel.paintMaterialId ?? voxel.materialId, voxelSizeMm)
      self.postMessage({ id, type: 'complete', data } satisfies ExportWorkerResponse, [data])
      return
    }
    self.postMessage({ id, type: 'progress', progress: 0.2, phase: '正在生成 VOX 数据' } satisfies ExportWorkerResponse)
    const data = encodeVox(asset, (voxel) => voxel.paintMaterialId ?? voxel.materialId)
    self.postMessage({ id, type: 'complete', data } satisfies ExportWorkerResponse, [data])
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : '导出失败' } satisfies ExportWorkerResponse)
  }
}
