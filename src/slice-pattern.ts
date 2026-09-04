import { MARD_221_ENTRIES, nearestMardEntry } from './color-palettes'
import { SliceLayer } from './slicing'

export type PatternAxisLabel = { index: number; label: number }
export type PatternLegendEntry = { code: string; color: string; count: number }
export type SlicePatternStats = { total: number; colorCount: number; legend: PatternLegendEntry[] }
export type SlicePatternPage = { column: number; row: number; startU: number; endU: number; startV: number; endV: number }

const paletteOrder = new Map(MARD_221_ENTRIES.map((entry, index) => [entry.code, index]))

export function patternAxisLabels(length: number): PatternAxisLabel[] {
  if (length <= 0) return []
  const indices = new Set<number>([0, length - 1])
  for (let index = 5; index < length; index += 5) indices.add(index)
  return [...indices].sort((left, right) => left - right).map((index) => ({ index, label: index + 1 }))
}

export function slicePatternStats(layer: SliceLayer): SlicePatternStats {
  const counts = new Map<string, { color: string; count: number }>()
  for (const voxel of layer.voxels) {
    const code = voxel.colorCode || nearestMardEntry(voxel.color).code
    const current = counts.get(code)
    counts.set(code, { color: voxel.color, count: (current?.count ?? 0) + 1 })
  }
  const legend = [...counts].map(([code, value]) => ({ code, ...value }))
    .sort((left, right) => (paletteOrder.get(left.code) ?? Number.MAX_SAFE_INTEGER) - (paletteOrder.get(right.code) ?? Number.MAX_SAFE_INTEGER))
  return { total: layer.voxels.length, colorCount: legend.length, legend }
}

export function slicePatternPages(layer: SliceLayer, maxCellsPerPage = 52): SlicePatternPage[] {
  const size = Math.max(1, Math.floor(maxCellsPerPage))
  const columns = Math.ceil(layer.width / size)
  const rows = Math.ceil(layer.height / size)
  const pages: SlicePatternPage[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const startU = layer.minU + column * size
      const endU = Math.min(layer.maxU, startU + size - 1)
      const endV = layer.maxV - row * size
      const startV = Math.max(layer.minV, endV - size + 1)
      pages.push({ column, row, startU, endU, startV, endV })
    }
  }
  return pages
}

export function sliceLayerForPatternPage(layer: SliceLayer, page: SlicePatternPage): SliceLayer {
  const voxels = layer.voxels.filter((voxel) => {
    const u = layer.plane === 'xy' || layer.plane === 'xz' ? voxel.x : voxel.y
    const v = layer.plane === 'xy' ? voxel.y : voxel.z
    return u >= page.startU && u <= page.endU && v >= page.startV && v <= page.endV
  })
  return {
    ...layer,
    minU: page.startU,
    maxU: page.endU,
    minV: page.startV,
    maxV: page.endV,
    width: page.endU - page.startU + 1,
    height: page.endV - page.startV + 1,
    voxels,
  }
}
