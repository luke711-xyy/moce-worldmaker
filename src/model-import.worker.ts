import { importModelBufferAsVoxelAssetWithDiagnostics, ModelImportOptions } from './model-import'

type WorkerRequest = {
  fileName: string
  buffer: ArrayBuffer
  options: Omit<ModelImportOptions, 'onProgress'>
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: unknown) => void
}

workerScope.onmessage = async (event) => {
  try {
    const { fileName, buffer, options } = event.data
    const result = await importModelBufferAsVoxelAssetWithDiagnostics(fileName, buffer, {
      ...options,
      onProgress: (progress, label) => workerScope.postMessage({ type: 'progress', progress, label }),
    })
    workerScope.postMessage({ type: 'result', result })
  } catch (error) {
    workerScope.postMessage({ type: 'error', message: error instanceof Error ? error.message : '模型体素化失败' })
  }
}
