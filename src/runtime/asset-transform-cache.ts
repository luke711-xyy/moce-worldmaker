import {
  assetOriginGridCoordinate,
  instanceVoxelPairs,
  instanceLocalVoxelToSceneVoxelFast,
  resolveInstanceSceneVoxels,
  SceneInstance,
  snapAssetOrigin,
  voxelCenterToWorld,
  Voxel,
  VoxelAsset,
  VOXEL_WORLD_SIZE,
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
    rotationPivot: instance.rotationPivot ?? null,
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

  /** Convert any scene cell to an instance-local cell, including empty cells. */
  localCoordinateAtSceneVoxel(
    instance: SceneInstance,
    asset: VoxelAsset,
    sceneVoxel: Pick<Voxel, 'x' | 'y' | 'z'>,
    componentId: string,
  ): Pick<Voxel, 'x' | 'y' | 'z'> | undefined {
    const offset = instance.partOffsets?.[componentId] ?? { x: 0, y: 0, z: 0 }
    const mirror = instance.mirror ?? { x: false, y: false, z: false }
    const rotationX = (instance.rotationX ?? 0) * Math.PI / 180
    const rotationY = (instance.rotationY ?? 0) * Math.PI / 180
    const rotationZ = -(instance.rotation + (instance.rotationZ ?? 0)) * Math.PI / 180
    const pivot = instance.rotationPivot ?? { x: 0, y: 0, z: 0 }
    const scene = {
      x: voxelCenterToWorld(sceneVoxel.x) - instance.x - pivot.x,
      y: voxelCenterToWorld(sceneVoxel.z) - instance.z - pivot.z,
      z: voxelCenterToWorld(sceneVoxel.y) - (instance.y ?? 0) - pivot.y,
    }
    // The forward transform applies X, then Y, then Z rotation. Undo it in
    // reverse order before converting the local physical position to indices.
    const cz = Math.cos(-rotationZ)
    const sz = Math.sin(-rotationZ)
    const afterZ = { x: cz * scene.x - sz * scene.y, y: sz * scene.x + cz * scene.y, z: scene.z }
    const cy = Math.cos(-rotationY)
    const sy = Math.sin(-rotationY)
    const afterY = { x: cy * afterZ.x + sy * afterZ.z, y: afterZ.y, z: -sy * afterZ.x + cy * afterZ.z }
    const cx = Math.cos(-rotationX)
    const sx = Math.sin(-rotationX)
    const local = {
      x: afterY.x + pivot.x,
      y: afterY.y + pivot.z,
      z: afterY.z + pivot.y,
    }
    const localXIndex = Math.round((local.x - (mirror.x ? -offset.x : offset.x)) / VOXEL_WORLD_SIZE - 0.5 + asset.width / 2)
    const localZIndex = Math.round((local.y - (mirror.y ? -offset.z : offset.z)) / VOXEL_WORLD_SIZE - 0.5 + asset.depth / 2)
    const localYIndex = Math.round((local.z - (mirror.z ? -offset.y : offset.y)) / VOXEL_WORLD_SIZE - 0.5)
    if (localXIndex < 0 || localXIndex >= asset.width || localZIndex < 0 || localZIndex >= asset.depth || localYIndex < 0 || localYIndex >= asset.height) return undefined
    const estimated = {
      x: mirror.x ? asset.width - 1 - localXIndex : localXIndex,
      y: mirror.z ? asset.height - 1 - localYIndex : localYIndex,
      z: mirror.y ? asset.depth - 1 - localZIndex : localZIndex,
    }
    // Rotation around an off-grid geometry center can land exactly on a cell
    // boundary before the scene-space quantization step. Try the nearby
    // integer cells through the same forward resolver and prefer an exact
    // round-trip, so empty-cell drawing does not jump to the adjacent layer.
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const candidate = { x: estimated.x + dx, y: estimated.y + dy, z: estimated.z + dz }
          if (candidate.x < 0 || candidate.x >= asset.width || candidate.y < 0 || candidate.y >= asset.height || candidate.z < 0 || candidate.z >= asset.depth) continue
          const projected = instanceLocalVoxelToSceneVoxelFast(instance, asset, { ...candidate, materialId: 'primary' }, componentId)
          if (projected.x === sceneVoxel.x && projected.y === sceneVoxel.y && projected.z === sceneVoxel.z) return candidate
        }
      }
    }
    return {
      x: mirror.x ? asset.width - 1 - localXIndex : localXIndex,
      y: mirror.z ? asset.height - 1 - localYIndex : localYIndex,
      z: mirror.y ? asset.depth - 1 - localZIndex : localZIndex,
    }
  }
}
