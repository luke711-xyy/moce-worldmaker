import { RuntimeVoxelCoord } from './runtime-coordinates'

export type VoxelDdaHit = {
  voxel: RuntimeVoxelCoord
  normal: RuntimeVoxelCoord
  distance: number
  ownerIds: string[]
}

export type RuntimeRaycastBounds = {
  minGx: number
  maxGx: number
  minGy: number
  maxGy: number
  minGz: number
  maxGz: number
}

export function raycastVoxelDda(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  query: (voxel: RuntimeVoxelCoord) => { occupied: boolean; ownerIds: string[] },
  maxDistance = 10000,
  bounds?: RuntimeRaycastBounds,
): VoxelDdaHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z)
  if (length < 1e-9) return null
  const ray = { x: direction.x / length, y: direction.y / length, z: direction.z / length }
  let startDistance = 0
  let endDistance = maxDistance
  let entrySlabs: { x: [number, number]; y: [number, number]; z: [number, number] } | undefined
  if (bounds) {
    // Do not walk thousands of empty cells when the camera has been panned
    // far away. Start just inside the scene AABB so exact-boundary floating
    // point values choose the cell the ray actually enters.
    const slab = (coordinate: number, axisDirection: number, min: number, max: number): [number, number] | null => {
      if (Math.abs(axisDirection) < 1e-12) return coordinate >= min && coordinate <= max + 1 ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] : null
      const a = (min - coordinate) / axisDirection
      const b = (max + 1 - coordinate) / axisDirection
      return [Math.min(a, b), Math.max(a, b)]
    }
    const x = slab(origin.x, ray.x, bounds.minGx, bounds.maxGx)
    const y = slab(origin.y, ray.y, bounds.minGy, bounds.maxGy)
    const z = slab(origin.z, ray.z, bounds.minGz, bounds.maxGz)
    if (!x || !y || !z) return null
    entrySlabs = { x, y, z }
    startDistance = Math.max(0, x[0], y[0], z[0])
    endDistance = Math.min(maxDistance, x[1], y[1], z[1])
    if (startDistance > endDistance) return null
  }
  const epsilon = bounds && startDistance > 0 ? 1e-7 : 0
  // If the ray enters the bounded scene before the first queried cell, keep
  // the entry face.  A hit in the first cell otherwise returned a zero
  // normal, so brush-add treated the clicked occupied cell itself as the
  // target and silently rejected it as already occupied.  This was especially
  // visible after panning/zooming or when the camera started inside the scene
  // bounds.
  let entryNormal: RuntimeVoxelCoord = { gx: 0, gy: 0, gz: 0 }
  if (bounds && startDistance > 0 && entrySlabs) {
    const entryAxis = [
      { distance: entrySlabs.x[0], axis: 'gx' as const, sign: ray.x },
      { distance: entrySlabs.y[0], axis: 'gy' as const, sign: ray.y },
      { distance: entrySlabs.z[0], axis: 'gz' as const, sign: ray.z },
    ].sort((left, right) => right.distance - left.distance)[0]
    if (entryAxis && Number.isFinite(entryAxis.distance)) entryNormal = { gx: 0, gy: 0, gz: 0, [entryAxis.axis]: entryAxis.sign > 0 ? -1 : 1 }
  }
  const start = {
    x: origin.x + ray.x * (startDistance + epsilon),
    y: origin.y + ray.y * (startDistance + epsilon),
    z: origin.z + ray.z * (startDistance + epsilon),
  }
  const voxel = { gx: Math.floor(start.x), gy: Math.floor(start.y), gz: Math.floor(start.z) }
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
    gx: boundaryDistance(start.x, voxel.gx, step.gx, ray.x),
    gy: boundaryDistance(start.y, voxel.gy, step.gy, ray.y),
    gz: boundaryDistance(start.z, voxel.gz, step.gz, ray.z),
  }
  let distance = startDistance
  let normal: RuntimeVoxelCoord = entryNormal
  const fallbackNormal = (): RuntimeVoxelCoord => {
    const components = [
      { axis: 'gx' as const, value: Math.abs(ray.x), sign: ray.x },
      { axis: 'gy' as const, value: Math.abs(ray.y), sign: ray.y },
      { axis: 'gz' as const, value: Math.abs(ray.z), sign: ray.z },
    ].sort((left, right) => right.value - left.value)[0]
    if (!components || components.value < 1e-9) return { gx: 0, gy: 0, gz: 0 }
    return { gx: 0, gy: 0, gz: 0, [components.axis]: components.sign > 0 ? -1 : 1 }
  }
  while (distance <= endDistance + 1e-6) {
    const hit = query(voxel)
    if (hit.occupied) return { voxel: { ...voxel }, normal: normal.gx || normal.gy || normal.gz ? normal : fallbackNormal(), distance, ownerIds: hit.ownerIds }
    if (side.gx <= side.gy && side.gx <= side.gz) {
      voxel.gx += step.gx
      distance = startDistance + side.gx
      side.gx += delta.gx
      normal = { gx: -step.gx, gy: 0, gz: 0 }
    } else if (side.gy <= side.gz) {
      voxel.gy += step.gy
      distance = startDistance + side.gy
      side.gy += delta.gy
      normal = { gx: 0, gy: -step.gy, gz: 0 }
    } else {
      voxel.gz += step.gz
      distance = startDistance + side.gz
      side.gz += delta.gz
      normal = { gx: 0, gy: 0, gz: -step.gz }
    }
  }
  return null
}
