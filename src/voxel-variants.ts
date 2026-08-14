import type { Voxel } from './voxel'

export type VoxelShape = 'cube' | 'tri-prism' | 'quarter-cylinder' | 'stair'
export type VoxelFacing = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'
export type VoxelRotation = 0 | 1 | 2 | 3

export type VoxelVariant = {
  shape: VoxelShape
  facing: VoxelFacing
  rotation: VoxelRotation
}

export type VoxelFaceFrame = {
  right: readonly [number, number, number]
  up: readonly [number, number, number]
  normal: readonly [number, number, number]
}

/**
 * A right-handed frame for every logical voxel face.
 *
 * `right` and `up` are the two axes used to divide the clicked square face
 * into four triangles. Keeping this table shared with the renderer prevents
 * the interaction layer and the exported geometry from disagreeing about a
 * face's local clockwise direction.
 */
export const VOXEL_FACE_FRAMES: Record<VoxelFacing, VoxelFaceFrame> = {
  '+x': { right: [0, 0, -1], up: [0, 1, 0], normal: [1, 0, 0] },
  '-x': { right: [0, 0, 1], up: [0, 1, 0], normal: [-1, 0, 0] },
  '+y': { right: [1, 0, 0], up: [0, 0, -1], normal: [0, 1, 0] },
  '-y': { right: [1, 0, 0], up: [0, 0, 1], normal: [0, -1, 0] },
  '+z': { right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1] },
  '-z': { right: [-1, 0, 0], up: [0, 1, 0], normal: [0, 0, -1] },
}

/** Convert a point on a face into the face's local right/up coordinates. */
export function faceLocalCoordinates(
  facing: VoxelFacing,
  point: Pick<Voxel, 'x' | 'y' | 'z'>,
  center: Pick<Voxel, 'x' | 'y' | 'z'>,
): { u: number; v: number } {
  const frame = VOXEL_FACE_FRAMES[facing]
  const dx = point.x - center.x
  const dy = point.y - center.y
  const dz = point.z - center.z
  return {
    u: dx * frame.right[0] + dy * frame.right[1] + dz * frame.right[2],
    v: dx * frame.up[0] + dy * frame.up[1] + dz * frame.up[2],
  }
}

/**
 * Quantize a point on a square face into the direction of the variant's
 * special surface. The clicked face is the full square mounting face, so
 * the visible slope/arc/step points away from the clicked triangle: clicking
 * the left triangle makes the feature face right, and vice versa.
 *
 * The intermediate quarter turns are therefore the opposite of the clicked
 * triangle: left -> right (1), right -> left (3), top -> bottom (0), and
 * bottom -> top (2). The values are expressed in the canonical profile's
 * local rotation basis, whose zero direction is one quarter turn away from
 * the screen-facing face-local basis.
 */
export function rotationFromFaceLocalCoordinates(u: number, v: number, minimumDistance = 1e-4): VoxelRotation {
  if (Math.hypot(u, v) < minimumDistance) return 0
  let clicked: VoxelRotation
  if (u >= Math.abs(v)) clicked = 0
  else if (v >= Math.abs(u)) clicked = 1
  else if (-u >= Math.abs(v)) clicked = 2
  else clicked = 3
  return ((clicked + 3) % 4) as VoxelRotation
}

export const VARIANT_FACING_DIRECTIONS: Record<VoxelFacing, readonly [number, number, number]> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
}

/**
 * Return the face of a newly placed voxel that touches the face just hit.
 *
 * Hit normals point out of the existing voxel.  The mounting face of the new
 * voxel therefore has the opposite normal: if the user clicks the +z face,
 * the new shape is placed in +z but its complete square mounting face is -z.
 */
export function oppositeVoxelFacing(facing: VoxelFacing): VoxelFacing {
  return facing.startsWith('+') ? `-${facing.slice(1)}` as VoxelFacing : `+${facing.slice(1)}` as VoxelFacing
}

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

export function makeVoxelVariant(shape: VoxelShape, facing: VoxelFacing = '+y', rotation: VoxelRotation = 0): VoxelVariant {
  return { shape, facing, rotation }
}

export function applyVoxelVariant<T extends Voxel>(voxel: T, variant: Partial<VoxelVariant>): T {
  const next = {
    ...voxel,
    ...(variant.shape ? { shape: variant.shape } : {}),
    ...(variant.facing ? { facing: variant.facing } : {}),
    ...(variant.rotation !== undefined ? { rotation: variant.rotation } : {}),
  } as T & { neighborMask?: unknown; variantId?: unknown }
  if (next.shape === 'cube') {
    delete next.shape
    delete next.facing
    delete next.rotation
  }
  // Topology-derived labels are intentionally not part of the new variant
  // model. Remove them when a voxel is touched so old in-memory data cannot
  // affect rendering or export.
  delete next.neighborMask
  delete next.variantId
  return next
}

export function variantKey(voxel: Pick<Voxel, 'shape' | 'facing' | 'rotation'>): string {
  return `${voxelShape(voxel)}:${voxelFacing(voxel)}:${voxelRotation(voxel)}`
}
