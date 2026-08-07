import type { Voxel } from './voxel'

export type DrawingPlane = 'xy' | 'xz' | 'yz'
export type DrawOperation = 'add' | 'subtract' | 'paint'
export type VoxelTool = 'select' | 'brush' | 'erase' | 'line' | 'cuboid' | 'sphere' | 'extrude'
export type VoxelAxis = 'x' | 'y' | 'z'

export type PlanePoint = { u: number; v: number; layer: number }

export type ToolCell = Pick<Voxel, 'x' | 'y' | 'z'>

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

export function rasterizeExtrude(plane: DrawingPlane, source: Voxel[], startLayer: number, delta: number, axisOverride?: VoxelAxis, materialId = '', operation: DrawOperation = 'add'): Voxel[] {
  if (!delta) return []
  const layerAxis = axisOverride ?? planeAxes(plane)[2]
  const step = delta > 0 ? 1 : -1
  const result: Voxel[] = []
  for (const voxel of source) {
    // An explicit extrusion axis is view-selected and is intentionally
    // independent from the drawing plane. Filtering through the plane's
    // layer axis here made a valid X/Y/Z extrusion use the wrong slice.
    if (voxel[layerAxis] !== startLayer) continue
    for (let layer = startLayer + step; delta > 0 ? layer <= startLayer + delta : layer >= Math.max(0, startLayer + delta); layer += step) {
      const target = { ...voxel }
      target[layerAxis] = layer
      if (target.y < 0) continue
      if (operation === 'paint') target.materialId = materialId
      result.push(target)
    }
  }
  return uniqueVoxels(result)
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
