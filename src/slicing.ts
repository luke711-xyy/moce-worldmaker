import { SceneEntityPart, Voxel, VoxelAsset, scenePartVoxels } from './voxel'

export type SlicePlane = 'xy' | 'xz' | 'yz'

export type SliceVoxel = Voxel & {
  color: string
}

export type SliceLayer = {
  plane: SlicePlane
  coordinate: number
  index: number
  minU: number
  maxU: number
  minV: number
  maxV: number
  width: number
  height: number
  voxels: SliceVoxel[]
}

export type SliceColorResolver = (voxel: Voxel, part: SceneEntityPart) => string

function planeCoordinates(plane: SlicePlane, voxel: Voxel): { u: number; v: number; layer: number } {
  if (plane === 'xy') return { u: voxel.x, v: voxel.y, layer: voxel.z }
  if (plane === 'xz') return { u: voxel.x, v: voxel.z, layer: voxel.y }
  return { u: voxel.y, v: voxel.z, layer: voxel.x }
}

export function sliceEntityParts(parts: SceneEntityPart[], plane: SlicePlane, resolveColor: SliceColorResolver): SliceLayer[] {
  const byCoordinate = new Map<number, Map<string, SliceVoxel>>()
  const overallBounds = {
    minU: Number.POSITIVE_INFINITY,
    maxU: Number.NEGATIVE_INFINITY,
    minV: Number.POSITIVE_INFINITY,
    maxV: Number.NEGATIVE_INFINITY,
  }
  parts.forEach((part) => {
    scenePartVoxels(part).forEach((voxel) => {
      const coordinates = planeCoordinates(plane, voxel)
      overallBounds.minU = Math.min(overallBounds.minU, coordinates.u)
      overallBounds.maxU = Math.max(overallBounds.maxU, coordinates.u)
      overallBounds.minV = Math.min(overallBounds.minV, coordinates.v)
      overallBounds.maxV = Math.max(overallBounds.maxV, coordinates.v)
      const layer = byCoordinate.get(coordinates.layer) ?? new Map<string, SliceVoxel>()
      const key = `${voxel.x},${voxel.y},${voxel.z}`
      if (!layer.has(key)) layer.set(key, { ...voxel, color: resolveColor(voxel, part) })
      byCoordinate.set(coordinates.layer, layer)
    })
  })

  return [...byCoordinate.entries()]
    .sort(([left], [right]) => left - right)
    .map(([coordinate, voxelMap], index) => {
      const voxels = [...voxelMap.values()]
      return {
        plane,
        coordinate,
        index,
        ...overallBounds,
        width: overallBounds.maxU - overallBounds.minU + 1,
        height: overallBounds.maxV - overallBounds.minV + 1,
        voxels,
      }
    })
}

export function slicePlaneLabel(plane: SlicePlane): string {
  // The editor's established user-facing convention names these two planes
  // opposite to the internal storage axes. Keep the algorithmic values stable
  // and swap only the displayed/exported labels.
  if (plane === 'xy') return 'XZ'
  if (plane === 'xz') return 'XY'
  return 'YZ'
}

export function sliceLayerToAsset(layer: SliceLayer, name: string): VoxelAsset {
  const bounds = layer.voxels.reduce((result, voxel) => ({
    minX: Math.min(result.minX, voxel.x),
    minY: Math.min(result.minY, voxel.y),
    minZ: Math.min(result.minZ, voxel.z),
    maxX: Math.max(result.maxX, voxel.x),
    maxY: Math.max(result.maxY, voxel.y),
    maxZ: Math.max(result.maxZ, voxel.z),
  }), { minX: layer.voxels[0].x, minY: layer.voxels[0].y, minZ: layer.voxels[0].z, maxX: layer.voxels[0].x, maxY: layer.voxels[0].y, maxZ: layer.voxels[0].z })
  const { minX, minY, minZ } = bounds
  const voxels = layer.voxels.map((voxel) => ({
    x: voxel.x - minX,
    y: voxel.y - minY,
    z: voxel.z - minZ,
    materialId: voxel.materialId,
    paintMaterialId: voxel.color,
  }))
  return {
    id: `slice-${layer.plane}-${layer.coordinate}-${Date.now()}`,
    name,
    style: '实体切片',
    kind: 'imported',
    color: layer.voxels[0]?.color ?? '#6c827d',
    accent: '#d2a354',
    width: bounds.maxX - minX + 1,
    depth: bounds.maxZ - minZ + 1,
    height: bounds.maxY - minY + 1,
    parts: ['slice-layer'],
    voxels,
    source: `实体切片 · ${slicePlaneLabel(layer.plane)} · 第 ${layer.index + 1} 层`,
    isTemplate: false,
  }
}
