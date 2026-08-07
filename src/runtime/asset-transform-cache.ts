import {
  assetOriginGridCoordinate,
  instanceVoxelPairs,
  resolveInstanceSceneVoxels,
  SceneInstance,
  snapAssetOrigin,
  Voxel,
  VoxelAsset,
  voxelBounds,
  worldToVoxel,
} from '../voxel'

export type CachedAssetTransform = {
  localVoxels: ReadonlyArray<Voxel>
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
  localVoxelBySceneKey?: Map<string, Voxel>
}

const voxelKey = (x: number, y: number, z: number) => `${x},${y},${z}`

function transformKey(instance: SceneInstance): string {
  return JSON.stringify({
    overrides: instance.overrides ?? [],
    mirror: instance.mirror ?? null,
    rotation: instance.rotation ?? 0,
    rotationX: instance.rotationX ?? 0,
    rotationY: instance.rotationY ?? 0,
    rotationZ: instance.rotationZ ?? 0,
    partOffsets: instance.partOffsets ?? {},
  })
}

function boundsForVoxels(voxels: ReadonlyArray<Voxel>): CachedAssetTransform['min'][] {
  const bounds = voxelBounds(voxels)
  return bounds ? [bounds.min, bounds.max] : [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]
}

export class AssetTransformCache {
  private readonly cache = new WeakMap<VoxelAsset, Map<string, CachedAssetTransform>>()

  get(instance: SceneInstance, asset: VoxelAsset): CachedAssetTransform {
    const key = transformKey(instance)
    const assetCache = this.cache.get(asset) ?? new Map<string, CachedAssetTransform>()
    if (!this.cache.has(asset)) this.cache.set(asset, assetCache)
    const cached = assetCache.get(key)
    if (cached) return cached
    const canonicalX = snapAssetOrigin(0, asset.width)
    const canonicalZ = snapAssetOrigin(0, asset.depth)
    const canonicalInstance = { ...instance, x: canonicalX, y: 0, z: canonicalZ }
    const localVoxels = resolveInstanceSceneVoxels(canonicalInstance, asset)
    const [min, max] = boundsForVoxels(localVoxels)
    const result = { localVoxels, min, max }
    assetCache.set(key, result)
    return result
  }

  translation(asset: VoxelAsset, x: number, y: number, z: number): Pick<Voxel, 'x' | 'y' | 'z'> {
    return {
      x: assetOriginGridCoordinate(x, asset.width),
      y: worldToVoxel(y),
      z: assetOriginGridCoordinate(z, asset.depth),
    }
  }

  resolve(instance: SceneInstance, asset: VoxelAsset, x = instance.x, z = instance.z, y = instance.y ?? 0): Voxel[] {
    const cached = this.get(instance, asset)
    const translation = this.translation(asset, x, y, z)
    return cached.localVoxels.map((voxel) => ({
      ...voxel,
      x: voxel.x + translation.x,
      y: voxel.y + translation.y,
      z: voxel.z + translation.z,
    }))
  }

  /**
   * Resolve one scene-space cell back to the asset-local voxel used by an
   * instance override. The first call for a transform variant builds a lazy
   * reverse index; subsequent batch paint/erase targets are constant-time.
   */
  localVoxelAtSceneVoxel(instance: SceneInstance, asset: VoxelAsset, sceneVoxel: Pick<Voxel, 'x' | 'y' | 'z'>): Voxel | undefined {
    const cached = this.get(instance, asset)
    if (!cached.localVoxelBySceneKey) {
      const canonicalInstance = {
        ...instance,
        x: snapAssetOrigin(0, asset.width),
        y: 0,
        z: snapAssetOrigin(0, asset.depth),
      }
      cached.localVoxelBySceneKey = new Map(
        instanceVoxelPairs(canonicalInstance, asset).map(({ local, scene }) => [voxelKey(scene.x, scene.y, scene.z), local]),
      )
    }
    const translation = this.translation(asset, instance.x, instance.y ?? 0, instance.z)
    return cached.localVoxelBySceneKey.get(voxelKey(
      sceneVoxel.x - translation.x,
      sceneVoxel.y - translation.y,
      sceneVoxel.z - translation.z,
    ))
  }
}
