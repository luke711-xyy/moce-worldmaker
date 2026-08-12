import type { Voxel } from './voxel'

export type VoxelShape = 'cube' | 'tri-prism' | 'quarter-cylinder' | 'stair'
export type VoxelFacing = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'
export type VoxelRotation = 0 | 1 | 2 | 3

export type VoxelVariant = {
  shape: VoxelShape
  facing: VoxelFacing
  rotation: VoxelRotation
  neighborMask: number
  variantId: string
}

/** Quantize a pointer drag to one of the four rotations around the facing. */
export function rotationFromScreenDelta(deltaX: number, deltaY: number, minimumDistance = 4): VoxelRotation {
  if (Math.hypot(deltaX, deltaY) < minimumDistance) return 0
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return deltaX >= 0 ? 0 : 2
  return deltaY <= 0 ? 1 : 3
}

export const VARIANT_FACING_DIRECTIONS: Record<VoxelFacing, readonly [number, number, number]> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
}

export const NEIGHBOR_DIRECTIONS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
] as const

export function voxelShape(voxel: Pick<Voxel, 'shape'>): VoxelShape {
  return voxel.shape ?? 'cube'
}

export function voxelFacing(voxel: Pick<Voxel, 'facing'>): VoxelFacing {
  return voxel.facing ?? '+y'
}

export function voxelRotation(voxel: Pick<Voxel, 'rotation'>): VoxelRotation {
  return voxel.rotation ?? 0
}

export function hasNonCubeVoxels(voxels: ReadonlyArray<Pick<Voxel, 'shape'>>): boolean {
  return voxels.some((voxel) => voxelShape(voxel) !== 'cube')
}

export function variantCellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** Six-face occupancy. Shape, color and owning entity intentionally do not matter. */
export function neighborMaskFor(voxel: Pick<Voxel, 'x' | 'y' | 'z'>, occupied: ReadonlySet<string>): number {
  let mask = 0
  NEIGHBOR_DIRECTIONS.forEach(([dx, dy, dz], index) => {
    if (occupied.has(variantCellKey(voxel.x + dx, voxel.y + dy, voxel.z + dz))) mask |= 1 << index
  })
  return mask
}

function horizontalNeighborCount(mask: number): number {
  return [0, 1, 4, 5].filter((bit) => (mask & (1 << bit)) !== 0).length
}

/** Stable semantic labels let renderers choose geometry without re-running topology rules. */
export function deriveVariantId(shape: VoxelShape, mask: number): string {
  if (shape === 'cube') return 'cube'
  const horizontal = horizontalNeighborCount(mask)
  if (horizontal >= 3) return 'tee'
  if (horizontal === 2) {
    const xConnected = (mask & 0b000011) !== 0
    const zConnected = (mask & 0b110000) !== 0
    return xConnected && zConnected ? 'corner' : 'straight'
  }
  if (horizontal === 1) return 'end'
  return shape === 'stair' ? 'single' : 'isolated'
}

export function makeVoxelVariant(shape: VoxelShape, facing: VoxelFacing = '+y', rotation: VoxelRotation = 0, neighborMask = 0): VoxelVariant {
  return { shape, facing, rotation, neighborMask, variantId: deriveVariantId(shape, neighborMask) }
}

export function applyVoxelVariant<T extends Voxel>(voxel: T, variant: Partial<VoxelVariant>): T {
  const next = {
    ...voxel,
    ...(variant.shape ? { shape: variant.shape } : {}),
    ...(variant.facing ? { facing: variant.facing } : {}),
    ...(variant.rotation !== undefined ? { rotation: variant.rotation } : {}),
    ...(variant.neighborMask !== undefined ? { neighborMask: variant.neighborMask } : {}),
    ...(variant.variantId ? { variantId: variant.variantId } : {}),
  }
  if (next.shape === 'cube') {
    delete next.shape
    delete next.facing
    delete next.rotation
    delete next.neighborMask
    delete next.variantId
  }
  return next
}

export function recomputeVoxelVariants<T extends Voxel>(voxels: ReadonlyArray<T>, changedKeys: ReadonlySet<string>): T[] {
  if (!voxels.length) return []
  const occupied = new Set(voxels.map((voxel) => variantCellKey(voxel.x, voxel.y, voxel.z)))
  const affected = new Set<string>(changedKeys)
  for (const key of changedKeys) {
    const [x, y, z] = key.split(',').map(Number)
    NEIGHBOR_DIRECTIONS.forEach(([dx, dy, dz]) => affected.add(variantCellKey(x + dx, y + dy, z + dz)))
  }
  return voxels.map((voxel) => {
    const key = variantCellKey(voxel.x, voxel.y, voxel.z)
    if (voxelShape(voxel) === 'cube' || !affected.has(key)) return voxel
    const neighborMask = neighborMaskFor(voxel, occupied)
    return applyVoxelVariant(voxel, { neighborMask, variantId: deriveVariantId(voxelShape(voxel), neighborMask) })
  })
}

export function variantKey(voxel: Pick<Voxel, 'shape' | 'facing' | 'rotation' | 'variantId'>): string {
  return `${voxelShape(voxel)}:${voxelFacing(voxel)}:${voxelRotation(voxel)}:${voxel.variantId ?? 'default'}`
}
