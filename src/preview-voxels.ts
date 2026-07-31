import { Voxel } from './voxel'

export const MAX_PREVIEW_VOXELS = 3200

export type PreviewVoxelSelection = {
  voxels: Voxel[]
  /** All source cells are kept here so sampled surface cells still occlude
   * faces correctly when the thumbnail is rendered. */
  occupancyKeys: Set<string>
}

export function previewVoxelKey(voxel: Pick<Voxel, 'x' | 'y' | 'z'>): string {
  return `${voxel.x},${voxel.y},${voxel.z}`
}

/**
 * Select a bounded, spatially distributed set for the small SVG preview.
 *
 * The old preview used voxels.slice(0, 600), which made large imported models
 * look truncated because the view box still represented the whole asset. For
 * large models, render exposed cells and reduce them by spatial buckets. This
 * keeps the whole silhouette and all extrema while keeping DOM/SVG work
 * bounded. The source occupancy remains available for face occlusion.
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
  const maxSpan = Math.max(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1)
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
  let stride = Math.max(1, Math.ceil(Math.cbrt(source.length / maxVoxels)))
  let sampled: Voxel[] = []
  while (stride <= maxSpan) {
    const buckets = new Map<string, Voxel>()
    source.forEach((voxel) => {
      const key = `${Math.floor((voxel.x - minX) / stride)},${Math.floor((voxel.y - minY) / stride)},${Math.floor((voxel.z - minZ) / stride)}`
      if (!buckets.has(key)) buckets.set(key, voxel)
    })
    const sampledKeys = new Set(required.keys())
    sampled = [...required.values()]
    for (const voxel of buckets.values()) {
      if (sampled.length >= maxVoxels) break
      const key = previewVoxelKey(voxel)
      if (!sampledKeys.has(key)) {
        sampledKeys.add(key)
        sampled.push(voxel)
      }
    }
    if (sampled.length <= maxVoxels) break
    stride += 1
  }

  // Extremely sparse models can still have more spatial buckets than the
  // budget. Keep the deterministic spatial result and trim only as a final
  // guard; this branch is no longer dependent on source array ordering.
  return { voxels: sampled.slice(0, maxVoxels), occupancyKeys }
}
