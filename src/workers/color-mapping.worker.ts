import { WeightedColorSample, nearestMardEntry, optimizeMardAllowedCodes } from '../color-palettes'

type Request = {
  id: number
  samples: WeightedColorSample[]
  maxColors: number
  allowedCodes?: string[]
}

type Response = {
  id: number
  allowedCodes?: string[]
  mapping?: Record<string, string>
  error?: string
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage: (message: Response) => void
}

scope.onmessage = (event) => {
  const request = event.data
  try {
    const allowedCodes = request.allowedCodes?.length
      ? [...request.allowedCodes]
      : optimizeMardAllowedCodes(request.samples, request.maxColors)
    const mapping = Object.fromEntries(request.samples.map((sample) => [sample.color.toLowerCase(), nearestMardEntry(sample.color, allowedCodes).code]))
    scope.postMessage({ id: request.id, allowedCodes, mapping })
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : '颜色映射失败' })
  }
}
