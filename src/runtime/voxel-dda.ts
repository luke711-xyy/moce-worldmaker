import { RuntimeVoxelCoord } from './runtime-coordinates'

export type VoxelDdaHit = {
  voxel: RuntimeVoxelCoord
  normal: RuntimeVoxelCoord
  distance: number
  ownerIds: string[]
}

export function raycastVoxelDda(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  query: (voxel: RuntimeVoxelCoord) => { occupied: boolean; ownerIds: string[] },
  maxDistance = 10000,
): VoxelDdaHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z)
  if (length < 1e-9) return null
  const ray = { x: direction.x / length, y: direction.y / length, z: direction.z / length }
  const voxel = { gx: Math.floor(origin.x), gy: Math.floor(origin.y), gz: Math.floor(origin.z) }
  const step = { gx: Math.sign(ray.x), gy: Math.sign(ray.y), gz: Math.sign(ray.z) }
  const delta = {
    gx: step.gx ? Math.abs(1 / ray.x) : Infinity,
    gy: step.gy ? Math.abs(1 / ray.y) : Infinity,
    gz: step.gz ? Math.abs(1 / ray.z) : Infinity,
  }
  const boundaryDistance = (coordinate: number, cell: number, axisStep: number, axisDirection: number) => {
    if (!axisStep) return Infinity
    const boundary = axisStep > 0 ? cell + 1 : cell
    return (boundary - coordinate) / axisDirection
  }
  const side = {
    gx: boundaryDistance(origin.x, voxel.gx, step.gx, ray.x),
    gy: boundaryDistance(origin.y, voxel.gy, step.gy, ray.y),
    gz: boundaryDistance(origin.z, voxel.gz, step.gz, ray.z),
  }
  let distance = 0
  let normal: RuntimeVoxelCoord = { gx: 0, gy: 0, gz: 0 }
  while (distance <= maxDistance) {
    const hit = query(voxel)
    if (hit.occupied) return { voxel: { ...voxel }, normal, distance, ownerIds: hit.ownerIds }
    if (side.gx <= side.gy && side.gx <= side.gz) {
      voxel.gx += step.gx
      distance = side.gx
      side.gx += delta.gx
      normal = { gx: -step.gx, gy: 0, gz: 0 }
    } else if (side.gy <= side.gz) {
      voxel.gy += step.gy
      distance = side.gy
      side.gy += delta.gy
      normal = { gx: 0, gy: -step.gy, gz: 0 }
    } else {
      voxel.gz += step.gz
      distance = side.gz
      side.gz += delta.gz
      normal = { gx: 0, gy: 0, gz: -step.gz }
    }
  }
  return null
}
