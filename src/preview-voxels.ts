import { Voxel } from './voxel'
import { MAX_TARGET_SIZE_MM } from './model-import'

/**
 * At 1 mm resolution, a solid model at the maximum import dimension has at
 * most this many cells on its six outer faces. The preview renders visible
 * surface cells, so this is a useful upper bound without tying the preview to
 * the full 256^3 internal volume.
 */
export const MAX_PREVIEW_VOXELS = 6 * MAX_TARGET_SIZE_MM * MAX_TARGET_SIZE_MM

export type PreviewVoxelSelection = {
  voxels: Voxel[]
  /** All source cells are kept here so sampled surface cells still occlude
   * faces correctly when the thumbnail is rendered. */
  occupancyKeys: Set<string>
}

export type PreviewFaceOrientation = 'top' | 'x' | 'z'

export type PreviewFaceCell = {
  orientation: PreviewFaceOrientation
  plane: number
  a: number
  b: number
  color: string
  sortKey: number
}

export type PreviewFaceRect = PreviewFaceCell & {
  width: number
  height: number
}

export function previewVoxelKey(voxel: Pick<Voxel, 'x' | 'y' | 'z'>): string {
  return `${voxel.x},${voxel.y},${voxel.z}`
}

/** Merge coplanar same-color unit faces into rectangles for SVG rendering. */
export function mergePreviewFaceCells(cells: PreviewFaceCell[]): PreviewFaceRect[] {
  const groups = new Map<string, Map<string, PreviewFaceCell>>()
  cells.forEach((cell) => {
    const groupKey = `${cell.orientation}:${cell.plane}`
    const group = groups.get(groupKey) ?? new Map<string, PreviewFaceCell>()
    group.set(`${cell.a},${cell.b}`, cell)
    groups.set(groupKey, group)
  })

  const rectangles: PreviewFaceRect[] = []
  groups.forEach((remaining) => {
    while (remaining.size) {
      const first = remaining.values().next().value as PreviewFaceCell
      let width = 1
      while (true) {
        const candidate = remaining.get(`${first.a + width},${first.b}`)
        if (!candidate || candidate.color !== first.color) break
        width += 1
      }

      let height = 1
      while (true) {
        let completeRow = true
        for (let offset = 0; offset < width; offset += 1) {
          const candidate = remaining.get(`${first.a + offset},${first.b + height}`)
          if (!candidate || candidate.color !== first.color) {
            completeRow = false
            break
          }
        }
        if (!completeRow) break
        height += 1
      }

      for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
        remaining.delete(`${first.a + column},${first.b + row}`)
      }
      rectangles.push({ ...first, width, height })
    }
  })

  return rectangles.sort((left, right) => left.sortKey - right.sortKey)
}

/**
 * Select a bounded, spatially distributed set for the small SVG preview.
 *
 * The old preview used voxels.slice(0, 600), which made large imported models
 * look truncated because the view box still represented the whole asset. For
 * large models, render exposed cells and reduce them by a stable spatially
 * distributed ranking. This keeps the whole silhouette and all extrema while
 * keeping DOM/SVG work bounded. The source occupancy remains available for
 * face occlusion.
 */
export function selectPreviewVoxels(voxels: Voxel[], maxVoxels = MAX_PREVIEW_VOXELS): PreviewVoxelSelection {
  const unique = new Map<string, Voxel>()
  voxels.forEach((voxel) => unique.set(previewVoxelKey(voxel), voxel))
  const all = [...unique.values()]
  const occupancyKeys = new Set(unique.keys())
  if (all.length <= maxVoxels) return { voxels: all, occupancyKeys }

  const directions = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ] as const
  const surface = all.filter((voxel) => directions.some(([dx, dy, dz]) => !occupancyKeys.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)))
  const source = surface.length ? surface : all
  if (source.length <= maxVoxels) return { voxels: source, occupancyKeys }

  const first = all[0]
  const extents = all.slice(1).reduce((result, voxel) => ({
    minX: Math.min(result.minX, voxel.x),
    minY: Math.min(result.minY, voxel.y),
    minZ: Math.min(result.minZ, voxel.z),
    maxX: Math.max(result.maxX, voxel.x),
    maxY: Math.max(result.maxY, voxel.y),
    maxZ: Math.max(result.maxZ, voxel.z),
  }), { minX: first.x, minY: first.y, minZ: first.z, maxX: first.x, maxY: first.y, maxZ: first.z })
  const { minX, minY, minZ, maxX, maxY, maxZ } = extents
  const required = new Map<string, Voxel>()
  const keepExtremum = (predicate: (voxel: Voxel) => boolean) => {
    const voxel = source.find(predicate)
    if (voxel) required.set(previewVoxelKey(voxel), voxel)
  }
  keepExtremum((voxel) => voxel.x === minX)
  keepExtremum((voxel) => voxel.x === maxX)
  keepExtremum((voxel) => voxel.y === minY)
  keepExtremum((voxel) => voxel.y === maxY)
  keepExtremum((voxel) => voxel.z === minZ)
  keepExtremum((voxel) => voxel.z === maxZ)
  const stableHash = (voxel: Voxel) => {
    let hash = 2166136261
    hash = Math.imul(hash ^ voxel.x, 16777619)
    hash = Math.imul(hash ^ voxel.y, 16777619)
    hash = Math.imul(hash ^ voxel.z, 16777619)
    return hash >>> 0
  }
  // Ranking all exposed voxels by a coordinate-derived hash gives a stable,
  // near-uniform sample. Unlike one-cell-per-bucket sampling, a model that is
  // only slightly over the limit keeps almost all of its visible cells.
  const ranked = source.slice().sort((left, right) => stableHash(left) - stableHash(right) || previewVoxelKey(left).localeCompare(previewVoxelKey(right)))
  const sampledKeys = new Set(required.keys())
  const sampled = [...required.values()]
  for (const voxel of ranked) {
    if (sampled.length >= maxVoxels) break
    const key = previewVoxelKey(voxel)
    if (!sampledKeys.has(key)) {
      sampledKeys.add(key)
      sampled.push(voxel)
    }
  }

  return { voxels: sampled, occupancyKeys }
}
