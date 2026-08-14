import { MAX_PREVIEW_VOXELS, selectPreviewVoxels } from './preview-voxels'
import { exteriorSurfaceVoxels } from './voxel-tools'
import { AssetThumbnail, Voxel, VoxelAsset } from './voxel'

/**
 * A thumbnail is a durable visual LOD, not a second live view of the scene.
 * The source signature lets migrations and geometry edits invalidate it while
 * color-only asset edits can continue to reuse the same sampled cells.
 */
export function assetVoxelSignature(voxels: ReadonlyArray<Voxel>): string {
  let hash = 2166136261
  const update = (value: string | number | undefined) => {
    const text = String(value ?? '')
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 124
    hash = Math.imul(hash, 16777619)
  }
  for (const voxel of voxels) {
    update(voxel.x)
    update(voxel.y)
    update(voxel.z)
    update(voxel.materialId)
    update(voxel.paintMaterialId)
    update(voxel.shape)
    update(voxel.facing)
    update(voxel.rotation)
  }
  return `${voxels.length}:${(hash >>> 0).toString(16)}`
}

export function createAssetThumbnail(asset: Pick<VoxelAsset, 'voxels'>): AssetThumbnail {
  const source = asset.voxels
  const surface = exteriorSurfaceVoxels(source)
  const selection = selectPreviewVoxels(surface.length ? surface : source, MAX_PREVIEW_VOXELS)
  return {
    version: 1,
    sourceSignature: assetVoxelSignature(source),
    sourceVoxelCount: source.length,
    // Copy the cells so the persisted snapshot cannot alias a mutable scene
    // edit transaction. The preview never needs the full source array.
    voxels: selection.voxels.map((voxel) => ({ ...voxel })),
  }
}

export function withAssetThumbnail(asset: VoxelAsset): VoxelAsset {
  const signature = assetVoxelSignature(asset.voxels)
  if (asset.thumbnail?.version === 1 && asset.thumbnail.sourceSignature === signature) return asset
  return { ...asset, thumbnail: createAssetThumbnail(asset) }
}

const previewAssetCache = new Map<string, VoxelAsset>()

/** Return a stable, lightweight asset object for the asset-library preview. */
export function assetPreviewAsset(asset: VoxelAsset): VoxelAsset {
  const thumbnail = asset.thumbnail
  if (!thumbnail || thumbnail.version !== 1) return asset
  const colorKey = `${asset.color}|${asset.accent}|${asset.templateColor ?? ''}`
  const key = `${asset.id}|${thumbnail.sourceSignature}|${colorKey}`
  const cached = previewAssetCache.get(key)
  if (cached) return cached
  const preview = {
    ...asset,
    // Keep the renderer away from the large canonical arrays and part map.
    voxels: thumbnail.voxels,
    partVoxels: undefined,
  }
  previewAssetCache.set(key, preview)
  if (previewAssetCache.size > 256) {
    const first = previewAssetCache.keys().next().value as string | undefined
    if (first) previewAssetCache.delete(first)
  }
  return preview
}
