import type { Voxel } from './voxel'

export type GeometryVoxel = Voxel & { sourcePartId?: string }
export type GeometryScaleMode = 'up' | 'down'

export type GeometryBounds = {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
  width: number
  height: number
  depth: number
}

export type VoxelGeometryPreview = {
  voxels: GeometryVoxel[]
  bounds: GeometryBounds | null
  voxelCount: number
  warnings: string[]
  valid: boolean
}

/** Compact render payload for large geometry previews. The full voxel list is
 * kept separately for confirmation; this payload is only the visible greedy
 * surface mesh needed by Three.js. */
export type VoxelGeometryMesh = {
  positions: Float32Array
  normals: Int8Array
  materialIds: Uint8Array
  indices: Uint32Array
  outlinePositions?: Float32Array
  materialKeys: string[]
  minX: number
  minY: number
  minZ: number
}

// Keep preview generation bounded. The final export path can be extended for
// larger jobs, but the interactive Three.js preview must not allocate a mesh
// with millions of instances in one click.
export const MAX_INTERACTIVE_GEOMETRY_VOXELS = 500_000

const NEIGHBORS: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

function key(x: number, y: number, z: number) { return `${x},${y},${z}` }

function boundsOf(voxels: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>): GeometryBounds | null {
  if (!voxels.length) return null
  const first = voxels[0]
  const result = { minX: first.x, minY: first.y, minZ: first.z, maxX: first.x, maxY: first.y, maxZ: first.z }
  for (let i = 1; i < voxels.length; i += 1) {
    const voxel = voxels[i]
    result.minX = Math.min(result.minX, voxel.x); result.minY = Math.min(result.minY, voxel.y); result.minZ = Math.min(result.minZ, voxel.z)
    result.maxX = Math.max(result.maxX, voxel.x); result.maxY = Math.max(result.maxY, voxel.y); result.maxZ = Math.max(result.maxZ, voxel.z)
  }
  return { ...result, width: result.maxX - result.minX + 1, height: result.maxY - result.minY + 1, depth: result.maxZ - result.minZ + 1 }
}

function result(voxels: GeometryVoxel[], warnings: string[] = [], valid = true, deduplicate = true, sort = true): VoxelGeometryPreview {
  if (!deduplicate) {
    return { voxels, bounds: boundsOf(voxels), voxelCount: voxels.length, warnings, valid: valid && voxels.length > 0 }
  }
  const unique = new Map<string, GeometryVoxel>()
  voxels.forEach((voxel) => { if (!unique.has(key(voxel.x, voxel.y, voxel.z))) unique.set(key(voxel.x, voxel.y, voxel.z), { ...voxel }) })
  const next = [...unique.values()]
  if (sort) next.sort((a, b) => key(a.x, a.y, a.z).localeCompare(key(b.x, b.y, b.z)))
  return { voxels: next, bounds: boundsOf(next), voxelCount: next.length, warnings, valid: valid && next.length > 0 }
}

function nearestSourceMap(source: GeometryVoxel[], target: Set<string>): Map<string, GeometryVoxel> {
  const assigned = new Map<string, GeometryVoxel>()
  const queue: GeometryVoxel[] = []
  source.forEach((voxel) => {
    const cell = { ...voxel }
    const cellKey = key(cell.x, cell.y, cell.z)
    if (target.has(cellKey) && !assigned.has(cellKey)) { assigned.set(cellKey, cell); queue.push(cell) }
  })
  let head = 0
  while (head < queue.length) {
    const current = queue[head++]
    for (const [dx, dy, dz] of NEIGHBORS) {
      const next = { ...current, x: current.x + dx, y: current.y + dy, z: current.z + dz }
      const nextKey = key(next.x, next.y, next.z)
      if (target.has(nextKey) && !assigned.has(nextKey)) { assigned.set(nextKey, { ...next, materialId: current.materialId, paintMaterialId: current.paintMaterialId, sourcePartId: current.sourcePartId }); queue.push(next) }
    }
  }
  return assigned
}

function erosion(input: Set<string>): Set<string> {
  const kept = new Set<string>()
  input.forEach((cell) => {
    const [x, y, z] = cell.split(',').map(Number)
    if (NEIGHBORS.every(([dx, dy, dz]) => input.has(key(x + dx, y + dy, z + dz)))) kept.add(cell)
  })
  return kept
}

function fillClosedCavities(input: GeometryVoxel[], bounds: GeometryBounds): Set<string> {
  const solid = new Set(input.map((voxel) => key(voxel.x, voxel.y, voxel.z)))
  const minX = bounds.minX - 1, maxX = bounds.maxX + 1
  const minY = bounds.minY - 1, maxY = bounds.maxY + 1
  const minZ = bounds.minZ - 1, maxZ = bounds.maxZ + 1
  const outside = new Set<string>()
  const queue: Array<[number, number, number]> = [[minX, minY, minZ]]
  outside.add(key(minX, minY, minZ))
  let head = 0
  while (head < queue.length) {
    const [x, y, z] = queue[head++]
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy, nz = z + dz
      if (nx < minX || nx > maxX || ny < minY || ny > maxY || nz < minZ || nz > maxZ) continue
      const nextKey = key(nx, ny, nz)
      if (solid.has(nextKey) || outside.has(nextKey)) continue
      outside.add(nextKey)
      queue.push([nx, ny, nz])
    }
  }
  const filled = new Set(solid)
  for (let x = bounds.minX; x <= bounds.maxX; x += 1) for (let y = bounds.minY; y <= bounds.maxY; y += 1) for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
    const cell = key(x, y, z)
    if (!solid.has(cell) && !outside.has(cell)) filled.add(cell)
  }
  return filled
}

/** Fill sealed cavities and retain the requested number of six-neighbor surface layers. */
export function computeShell(input: GeometryVoxel[], thickness: number): VoxelGeometryPreview {
  const thicknessInt = Math.max(1, Math.round(thickness))
  if (!input.length) return result([], ['没有可处理的体素'], false)
  const bounds = boundsOf(input)!
  const volume = bounds.width * bounds.height * bounds.depth
  if (volume > 8_000_000) return result([], ['模型包围盒过大，无法安全填充内部空腔'], false)
  const filled = fillClosedCavities(input, bounds)
  let core = new Set(filled)
  let iterations = 0
  while (core.size) { const next = erosion(core); iterations += 1; core = next }
  let retainedCore = new Set(filled)
  for (let i = 0; i < thicknessInt; i += 1) retainedCore = erosion(retainedCore)
  const shellKeys = new Set<string>()
  filled.forEach((cell) => { if (!retainedCore.has(cell)) shellKeys.add(cell) })
  const sourceMap = nearestSourceMap(input, filled)
  const output: GeometryVoxel[] = []
  shellKeys.forEach((cell) => {
    const [x, y, z] = cell.split(',').map(Number)
    const source = sourceMap.get(cell) ?? input[0]
    output.push({ x, y, z, materialId: source.materialId, ...(source.paintMaterialId ? { paintMaterialId: source.paintMaterialId } : {}), ...(source.sourcePartId ? { sourcePartId: source.sourcePartId } : {}) })
  })
  const warnings = iterations <= thicknessInt ? ['模型厚度不足，当前结果退化为完整实体'] : []
  return result(output, warnings)
}

export function validShellThicknesses(voxels: GeometryVoxel[]): number[] {
  if (!voxels.length) return []
  const bounds = boundsOf(voxels)!
  if (bounds.width * bounds.height * bounds.depth > 8_000_000) return [1]
  const values: number[] = []
  let current = fillClosedCavities(voxels, bounds)
  for (let thickness = 1; thickness <= Math.max(bounds.width, bounds.height, bounds.depth); thickness += 1) {
    values.push(thickness)
    current = erosion(current)
    if (!current.size) break
  }
  return values
}

function majorityVoxel(cells: GeometryVoxel[]): GeometryVoxel | undefined {
  if (!cells.length) return undefined
  const counts = new Map<string, { count: number; voxel: GeometryVoxel }>()
  cells.slice().sort((a, b) => key(a.x, a.y, a.z).localeCompare(key(b.x, b.y, b.z))).forEach((voxel) => {
    const color = voxel.paintMaterialId ?? voxel.materialId
    const entry = counts.get(color) ?? { count: 0, voxel }
    entry.count += 1; counts.set(color, entry)
  })
  return [...counts.values()].sort((a, b) => b.count - a.count || key(a.voxel.x, a.voxel.y, a.voxel.z).localeCompare(key(b.voxel.x, b.voxel.y, b.voxel.z)))[0]?.voxel
}

/** Integer voxel enlargement and loss-aware divisible reduction. */
export function computeScale(input: GeometryVoxel[], mode: GeometryScaleMode, factor: number): VoxelGeometryPreview {
  const k = Math.max(2, Math.round(factor))
  if (!input.length) return result([], ['没有可处理的体素'], false)
  const bounds = boundsOf(input)!
  if (mode === 'down' && (bounds.width % k !== 0 || bounds.height % k !== 0 || bounds.depth % k !== 0)) return result([], [`当前实体尺寸 ${bounds.width} × ${bounds.height} × ${bounds.depth} 无法按 ${k} 整除`], false)
  if (mode === 'up') {
    if (input.length * k * k * k > MAX_INTERACTIVE_GEOMETRY_VOXELS) return result([], [`放大后将生成 ${input.length * k * k * k} 个体素，超过交互预览上限 ${MAX_INTERACTIVE_GEOMETRY_VOXELS}`], false)
    const newWidth = bounds.width * k, newDepth = bounds.depth * k
    // Center X/Z around the original bounding-box center; Y is the ground-up axis and stays on the same bottom layer.
    const minX = Math.floor((bounds.minX + bounds.maxX + 1 - newWidth) / 2)
    const minZ = Math.floor((bounds.minZ + bounds.maxZ + 1 - newDepth) / 2)
    const output: GeometryVoxel[] = []
    input.forEach((voxel) => {
      for (let dx = 0; dx < k; dx += 1) for (let dy = 0; dy < k; dy += 1) for (let dz = 0; dz < k; dz += 1) output.push({
        ...voxel,
        x: minX + (voxel.x - bounds.minX) * k + dx,
        y: bounds.minY + (voxel.y - bounds.minY) * k + dy,
        z: minZ + (voxel.z - bounds.minZ) * k + dz,
        preserveVoxelCells: true,
      })
    })
    // Enlargement maps each unique source cell to a disjoint k³ block. Avoid
    // the defensive Map+lexicographic sort here; both are quadratic-ish in
    // practice for the large previews this path is designed to support.
    return result(output, [], true, false, false)
  }
  const blocks = new Map<string, GeometryVoxel[]>()
  input.forEach((voxel) => {
    const x = bounds.minX + Math.floor((voxel.x - bounds.minX) / k)
    const y = bounds.minY + Math.floor((voxel.y - bounds.minY) / k)
    const z = bounds.minZ + Math.floor((voxel.z - bounds.minZ) / k)
    const cell = key(x, y, z)
    blocks.set(cell, [...(blocks.get(cell) ?? []), voxel])
  })
  const output: GeometryVoxel[] = []
  let partialBlocks = 0
  let droppedBlocks = 0
  blocks.forEach((cells, cell) => {
    if (cells.length !== k * k * k) partialBlocks += 1
    if (cells.length * 2 > k * k * k) {
      const source = majorityVoxel(cells)!
      const [x, y, z] = cell.split(',').map(Number)
      output.push({ ...source, x, y, z })
    } else {
      droppedBlocks += 1
    }
  })
  const warnings = output.length ? (partialBlocks ? [`缩小将合并 ${partialBlocks} 个非完整体素块，可能丢失细节${droppedBlocks ? ` · ${droppedBlocks} 个体素块未达到过半而被删除` : ''}`] : []) : ['缩小后所有体素均未达到过半保留条件']
  return result(output, warnings, Boolean(output.length))
}

export function validScaleFactors(voxels: GeometryVoxel[], maxUpFactor = 8): { up: number[]; down: number[] } {
  const bounds = boundsOf(voxels)
  if (!bounds) return { up: [], down: [] }
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
  const common = gcd(gcd(bounds.width, bounds.height), bounds.depth)
  const down: number[] = []
  for (let k = 2; k <= common; k += 1) if (common % k === 0) down.push(k)
  const up: number[] = []
  for (let k = 2; k <= maxUpFactor; k += 1) if (voxels.length * k * k * k <= MAX_INTERACTIVE_GEOMETRY_VOXELS) up.push(k)
  return { up, down }
}
