import type { Voxel } from './voxel'

export type DrawingPlane = 'xy' | 'xz' | 'yz'
export type DrawOperation = 'add' | 'subtract' | 'paint'
export type VoxelTool = 'select' | 'brush' | 'erase' | 'line' | 'cuboid' | 'sphere' | 'extrude'
export type VoxelAxis = 'x' | 'y' | 'z'

export type PlanePoint = { u: number; v: number; layer: number }

export type ToolCell = Pick<Voxel, 'x' | 'y' | 'z'>

/**
 * The editor-facing ground plane is X/Y with Z as height. Project files keep
 * the historical storage layout (X/Z on the ground and Y as height), so the
 * corresponding voxel-tools plane is `xz`. Shape tools use this plane
 * unconditionally; the user-selectable drawing plane is only for planar
 * brush/erase/line tools.
 */
export const EDITOR_GROUND_PLANE: DrawingPlane = 'xz'

/**
 * Drawing-plane names are literal voxel-coordinate planes.  The old version
 * translated XY to XZ and XZ to XY to compensate for the renderer's legacy
 * storage layout, which made the plane selector lie to the user.  Rendering
 * and scene serialization already have their own coordinate conversion; the
 * drawing algorithm must keep the selected plane literal and predictable.
 */
export function planeAxes(plane: DrawingPlane): ['x' | 'y' | 'z', 'x' | 'y' | 'z', 'x' | 'y' | 'z'] {
  if (plane === 'xy') return ['x', 'y', 'z']
  if (plane === 'xz') return ['x', 'z', 'y']
  return ['y', 'z', 'x']
}

export function planePointToVoxel(plane: DrawingPlane, point: PlanePoint): ToolCell {
  const [uAxis, vAxis, layerAxis] = planeAxes(plane)
  return { x: uAxis === 'x' ? point.u : vAxis === 'x' ? point.v : point.layer, y: uAxis === 'y' ? point.u : vAxis === 'y' ? point.v : point.layer, z: uAxis === 'z' ? point.u : vAxis === 'z' ? point.v : point.layer }
}

export function makePlaneVoxel(plane: DrawingPlane, u: number, v: number, layer: number, materialId = ''): Voxel {
  const [uAxis, vAxis, layerAxis] = planeAxes(plane)
  const cell = { x: 0, y: 0, z: 0, materialId }
  cell[uAxis] = u
  cell[vAxis] = v
  cell[layerAxis] = layer
  return cell
}

export function projectVoxelToPlane(plane: DrawingPlane, voxel: ToolCell): PlanePoint {
  const [uAxis, vAxis, layerAxis] = planeAxes(plane)
  return { u: voxel[uAxis], v: voxel[vAxis], layer: voxel[layerAxis] }
}

/** The scene floor is storage Y=0; drawing may never create Y<0. */
export function clampPlanePointToGround(plane: DrawingPlane, point: PlanePoint): PlanePoint {
  const [uAxis, vAxis, layerAxis] = planeAxes(plane)
  return {
    u: uAxis === 'y' ? Math.max(0, point.u) : point.u,
    v: vAxis === 'y' ? Math.max(0, point.v) : point.v,
    layer: layerAxis === 'y' ? Math.max(0, point.layer) : point.layer,
  }
}

export function toolCellKey(cell: ToolCell): string {
  return `${cell.x},${cell.y},${cell.z}`
}

/**
 * Return the empty cells reachable from just outside a voxel model.
 *
 * A plain "neighbor is empty" test treats a sealed cavity as a visible
 * surface. That is useful for editing, but it makes a solid model and the
 * same model after shell extraction produce different fixed thumbnails. The
 * preview path uses this flood fill to keep enclosed cavity walls out of the
 * external silhouette.
 *
 * Very large bounds are left to the caller's conservative fallback so a
 * thumbnail cannot allocate an unbounded dense air volume.
 */
export function exteriorAirKeys(voxels: ReadonlyArray<ToolCell>, maxVolume = 8_000_000): Set<string> | null {
  if (!voxels.length) return new Set<string>()
  let minX = voxels[0].x, maxX = voxels[0].x
  let minY = voxels[0].y, maxY = voxels[0].y
  let minZ = voxels[0].z, maxZ = voxels[0].z
  const occupied = new Set<string>()
  for (const voxel of voxels) {
    minX = Math.min(minX, voxel.x); maxX = Math.max(maxX, voxel.x)
    minY = Math.min(minY, voxel.y); maxY = Math.max(maxY, voxel.y)
    minZ = Math.min(minZ, voxel.z); maxZ = Math.max(maxZ, voxel.z)
    occupied.add(toolCellKey(voxel))
  }
  const spanX = maxX - minX + 3
  const spanY = maxY - minY + 3
  const spanZ = maxZ - minZ + 3
  if (spanX * spanY * spanZ > maxVolume) return null
  const outside = new Set<string>()
  const queue: Array<[number, number, number]> = [[minX - 1, minY - 1, minZ - 1]]
  outside.add(toolCellKey({ x: minX - 1, y: minY - 1, z: minZ - 1 }))
  let head = 0
  while (head < queue.length) {
    const [x, y, z] = queue[head++]
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const nx = x + dx, ny = y + dy, nz = z + dz
      if (nx < minX - 1 || nx > maxX + 1 || ny < minY - 1 || ny > maxY + 1 || nz < minZ - 1 || nz > maxZ + 1) continue
      const next = toolCellKey({ x: nx, y: ny, z: nz })
      if (occupied.has(next) || outside.has(next)) continue
      outside.add(next)
      queue.push([nx, ny, nz])
    }
  }
  return outside
}

/**
 * Return only cells that touch air reachable from outside the model.
 *
 * This is deliberately a preview/LOD helper, not a geometry editing
 * operation: it preserves the original cell objects and never changes the
 * scene. Keeping this filter separate from face generation makes a solid
 * model and its hollow-shell version use the same external thumbnail cells.
 */
export function exteriorSurfaceVoxels<T extends ToolCell>(voxels: ReadonlyArray<T>, maxVolume = 8_000_000): T[] {
  if (!voxels.length) return []
  const exteriorAir = exteriorAirKeys(voxels, maxVolume)
  if (exteriorAir === null) return [...voxels]
  const occupied = new Set(voxels.map((voxel) => toolCellKey(voxel)))
  const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const
  return voxels.filter((voxel) => directions.some(([dx, dy, dz]) => {
    const neighbor = { x: voxel.x + dx, y: voxel.y + dy, z: voxel.z + dz }
    return !occupied.has(toolCellKey(neighbor)) && exteriorAir.has(toolCellKey(neighbor))
  }))
}

const brushCache = new Map<number, Array<{ u: number; v: number }>>()

export function brushOffsets(size: number): Array<{ u: number; v: number }> {
  const normalized = Math.max(1, Math.min(100, Math.round(size)))
  const cached = brushCache.get(normalized)
  if (cached) return cached
  const min = -Math.floor((normalized - 1) / 2)
  const max = Math.ceil((normalized - 1) / 2)
  // The radius is measured from the brush center to voxel centers. The half
  // cell margin keeps even diameters (notably size 2) symmetrical and useful.
  const radius = normalized / 2
  const center = (min + max) / 2
  const radiusSquared = radius * radius
  const offsets: Array<{ u: number; v: number }> = []
  for (let v = min; v <= max; v += 1) {
    for (let u = min; u <= max; u += 1) {
      const centerU = u - center
      const centerV = v - center
      if (centerU * centerU + centerV * centerV <= radiusSquared + 0.25 || normalized === 1) offsets.push({ u, v })
    }
  }
  const result = (offsets.length ? offsets : [{ u: 0, v: 0 }]).map(({ u, v }) => ({ u: Object.is(u, -0) ? 0 : u, v: Object.is(v, -0) ? 0 : v }))
  brushCache.set(normalized, result)
  return result
}

export function rasterizeBrush(plane: DrawingPlane, center: PlanePoint, size: number, materialId = ''): Voxel[] {
  const safeCenter = clampPlanePointToGround(plane, center)
  return brushOffsets(size).map(({ u, v }) => clampPlanePointToGround(plane, { u: safeCenter.u + u, v: safeCenter.v + v, layer: safeCenter.layer })).map((point) => makePlaneVoxel(plane, point.u, point.v, point.layer, materialId))
}

/**
 * Rasterize one continuous planar pointer stroke.
 *
 * This is deliberately operation-agnostic: add, subtract and paint must use
 * the exact same grid cells.  Keeping the rasterizer independent from the
 * React/Three pointer handlers prevents the two tools from drifting apart
 * again (which previously made erase use a second, non-planar hit path).
 */
export function rasterizePlanarStroke(plane: DrawingPlane, start: PlanePoint, end: PlanePoint, size: number, materialId = ''): Voxel[] {
  const cells = new Map<string, Voxel>()
  for (const point of interpolatePlanePoints(start, end)) {
    for (const voxel of rasterizeBrush(plane, point, size, materialId)) {
      cells.set(toolCellKey(voxel), voxel)
    }
  }
  return [...cells.values()]
}

/** Inclusive 2D Bresenham/supercover approximation with no gaps between cells. */
export function rasterizeLine2D(start: PlanePoint, end: PlanePoint): Array<{ u: number; v: number }> {
  let x0 = Math.round(start.u)
  let y0 = Math.round(start.v)
  const x1 = Math.round(end.u)
  const y1 = Math.round(end.v)
  const dx = Math.abs(x1 - x0)
  const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0)
  const sy = y0 < y1 ? 1 : -1
  let error = dx + dy
  const result: Array<{ u: number; v: number }> = []
  while (true) {
    result.push({ u: x0, v: y0 })
    if (x0 === x1 && y0 === y1) break
    const twice = 2 * error
    if (twice >= dy) { error += dy; x0 += sx }
    if (twice <= dx) { error += dx; y0 += sy }
  }
  return result
}

export function rasterizeLine(plane: DrawingPlane, start: PlanePoint, end: PlanePoint, size: number, materialId = ''): Voxel[] {
  const safeStart = clampPlanePointToGround(plane, start)
  const safeEnd = clampPlanePointToGround(plane, end)
  const cells = new Map<string, Voxel>()
  for (const point of rasterizeLine2D(safeStart, safeEnd)) {
    for (const voxel of rasterizeBrush(plane, { u: point.u, v: point.v, layer: safeStart.layer }, size, materialId)) cells.set(toolCellKey(voxel), voxel)
  }
  return [...cells.values()]
}

export function rasterizeCuboid(plane: DrawingPlane, start: PlanePoint, end: PlanePoint, minLayer: number, maxLayer: number, materialId = ''): Voxel[] {
  const safeStart = clampPlanePointToGround(plane, start)
  const safeEnd = clampPlanePointToGround(plane, end)
  const result: Voxel[] = []
  const minU = Math.min(Math.round(safeStart.u), Math.round(safeEnd.u))
  const maxU = Math.max(Math.round(safeStart.u), Math.round(safeEnd.u))
  const minV = Math.min(Math.round(safeStart.v), Math.round(safeEnd.v))
  const maxV = Math.max(Math.round(safeStart.v), Math.round(safeEnd.v))
  const safeMinLayer = planeAxes(plane)[2] === 'y' ? Math.max(0, minLayer) : minLayer
  const safeMaxLayer = planeAxes(plane)[2] === 'y' ? Math.max(0, maxLayer) : maxLayer
  const lowLayer = Math.min(Math.round(safeMinLayer), Math.round(safeMaxLayer))
  const highLayer = Math.max(Math.round(safeMinLayer), Math.round(safeMaxLayer))
  for (let layer = lowLayer; layer <= highLayer; layer += 1) for (let v = minV; v <= maxV; v += 1) for (let u = minU; u <= maxU; u += 1) result.push(makePlaneVoxel(plane, u, v, layer, materialId))
  return result
}

export function rasterizeSphere(center: ToolCell, radius: number, materialId = ''): Voxel[] {
  const r = Math.max(0, Math.round(radius))
  const result: Voxel[] = []
  const radiusSquared = r * r + 0.25
  for (let z = -r; z <= r; z += 1) for (let y = -r; y <= r; y += 1) for (let x = -r; x <= r; x += 1) {
    if (x * x + y * y + z * z <= radiusSquared) result.push({ x: center.x + x, y: center.y + y, z: center.z + z, materialId })
  }
  return result
}

export function rasterizeAnchoredSphere(plane: DrawingPlane, start: PlanePoint, current: PlanePoint, baseHeight: number, materialId = ''): Voxel[] {
  const safeStart = clampPlanePointToGround(plane, start)
  const safeCurrent = clampPlanePointToGround(plane, current)
  const radius = Math.max(0, Math.round(Math.hypot(safeCurrent.u - safeStart.u, safeCurrent.v - safeStart.v)))
  const center = makePlaneVoxel(plane, safeStart.u, safeStart.v, safeStart.layer, materialId)
  center.y = Math.max(0, baseHeight) + radius
  return rasterizeSphere(center, radius, materialId)
}

/**
 * Converts travel measured along a selected signed screen direction into the
 * project's signed voxel-axis delta. A positive screen travel means "along
 * the selected direction", which is negative in storage coordinates when the
 * selected direction is the negative axis side.
 */
export function signedExtrudeDelta(projectedCellDelta: number, directionSign: 1 | -1, maxDistance: number): number {
  const max = Math.max(0, Math.round(maxDistance))
  const signed = Math.round(projectedCellDelta) * directionSign
  return Math.max(-max, Math.min(max, signed))
}

/** Select every voxel on the clicked coordinate layer perpendicular to an axis. */
export function selectExtrudeLayer(source: Voxel[], axis: VoxelAxis, layer: number): Voxel[] {
  const result: Voxel[] = []
  const seen = new Set<string>()
  for (const voxel of source) {
    if (voxel[axis] !== layer) continue
    const key = toolCellKey(voxel)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(voxel)
  }
  return result
}

export function rasterizeExtrude(plane: DrawingPlane, source: Voxel[], startLayer: number, delta: number, axisOverride?: VoxelAxis, materialId = '', operation: DrawOperation = 'add'): Voxel[] {
  if (!delta) return []
  const layerAxis = axisOverride ?? planeAxes(plane)[2]
  const step = delta > 0 ? 1 : -1
  const result: Voxel[] = []
  // Source slices are normally deduplicated when the gesture starts, but
  // keeping this guard here makes the pure algorithm safe for imported or
  // legacy data without requiring a second full-size uniqueVoxels() pass over
  // the generated extrusion result.
  const seen = new Set<string>()
  // Project X/Z are centered horizontal axes and legitimately contain
  // negative coordinates. Only storage Y is the height axis whose lower
  // bound is the ground plane.
  const endLayer = layerAxis === 'y' ? Math.max(0, startLayer + delta) : startLayer + delta
  for (const voxel of source) {
    // An explicit extrusion axis is view-selected and is intentionally
    // independent from the drawing plane. Filtering through the plane's
    // layer axis here made a valid X/Y/Z extrusion use the wrong slice.
    if (voxel[layerAxis] !== startLayer) continue
    for (let layer = startLayer + step; delta > 0 ? layer <= endLayer : layer >= endLayer; layer += step) {
      const target = { ...voxel }
      target[layerAxis] = layer
      if (target.y < 0) continue
      if (operation === 'paint') target.materialId = materialId
      const key = toolCellKey(target)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(target)
    }
  }
  return result
}

export function uniqueVoxels(voxels: Voxel[]): Voxel[] {
  const seen = new Map<string, Voxel>()
  for (const voxel of voxels) seen.set(toolCellKey(voxel), voxel)
  return [...seen.values()]
}

export function interpolatePlanePoints(start: PlanePoint, end: PlanePoint): PlanePoint[] {
  const length = Math.max(Math.abs(end.u - start.u), Math.abs(end.v - start.v), 1)
  const result: PlanePoint[] = []
  for (let index = 0; index <= length; index += 1) {
    const t = index / length
    result.push({ u: Math.round(start.u + (end.u - start.u) * t), v: Math.round(start.v + (end.v - start.v) * t), layer: start.layer })
  }
  return result
}
