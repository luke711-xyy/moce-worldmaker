export type MesherVoxel = {
  gx: number
  gy: number
  gz: number
  materialId: number
}

export type GreedyMeshPayload = {
  positions: Float32Array
  normals: Int8Array
  ao: Float32Array
  materialIds: Uint8Array
  indices: Uint32Array
  outlinePositions?: Float32Array
  quadCount: number
}

export type GreedyMeshOptions = {
  includeOutline?: boolean
}

type MaskCell = { materialId: number; sign: -1 | 1 } | null

const key = (x: number, y: number, z: number) => `${x},${y},${z}`

function buildOutlinePositions(positions: Float32Array, normals: Int8Array, quadCount: number): Float32Array {
  type Edge = {
    start: [number, number, number]
    end: [number, number, number]
    normal: [number, number, number]
  }
  // Each greedy quad is emitted as four consecutive vertices. Cancel the
  // shared edge of coplanar quads and retain boundary/feature edges. This
  // replaces main-thread EdgesGeometry work for large selected models.
  const edges = new Map<string, Edge | null>()
  const edgePairs: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 0]]
  const point = (vertex: number): [number, number, number] => [
    positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2],
  ]
  const pointKey = (value: [number, number, number]) => `${value[0]},${value[1]},${value[2]}`
  const normal = (vertex: number): [number, number, number] => [
    normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2],
  ]
  for (let quad = 0; quad < quadCount; quad += 1) {
    const base = quad * 4
    const faceNormal = normal(base)
    edgePairs.forEach(([startIndex, endIndex]) => {
      const start = point(base + startIndex)
      const end = point(base + endIndex)
      const startKey = pointKey(start)
      const endKey = pointKey(end)
      const key = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`
      const previous = edges.get(key)
      if (previous === undefined) {
        edges.set(key, { start, end, normal: faceNormal })
      } else if (previous && previous.normal[0] === faceNormal[0] && previous.normal[1] === faceNormal[1] && previous.normal[2] === faceNormal[2]) {
        edges.set(key, null)
      }
    })
  }
  const output: number[] = []
  edges.forEach((edge) => { if (edge) output.push(...edge.start, ...edge.end) })
  return new Float32Array(output)
}

export function buildGreedyMesh(voxels: ReadonlyArray<MesherVoxel>, options: GreedyMeshOptions = {}): GreedyMeshPayload {
  if (!voxels.length) return {
    positions: new Float32Array(),
    normals: new Int8Array(),
    ao: new Float32Array(),
    materialIds: new Uint8Array(),
    indices: new Uint32Array(),
    outlinePositions: options.includeOutline ? new Float32Array() : undefined,
    quadCount: 0,
  }
  // Do not use Math.min/max(...array) here. A large imported or procedurally
  // drawn shape can contain tens of thousands of voxels, and spreading that
  // array into a function call overflows the JavaScript call stack before the
  // mesher even starts. One pass is also cheaper than creating three mapped
  // temporary arrays.
  const first = voxels[0]
  const min = [first.gx, first.gy, first.gz]
  const max = [first.gx, first.gy, first.gz]
  for (let index = 1; index < voxels.length; index += 1) {
    const voxel = voxels[index]
    if (voxel.gx < min[0]) min[0] = voxel.gx
    if (voxel.gy < min[1]) min[1] = voxel.gy
    if (voxel.gz < min[2]) min[2] = voxel.gz
    if (voxel.gx > max[0]) max[0] = voxel.gx
    if (voxel.gy > max[1]) max[1] = voxel.gy
    if (voxel.gz > max[2]) max[2] = voxel.gz
  }
  const dimensions = max.map((value, axis) => value - min[axis] + 1)
  const occupied = new Map<string, number>()
  voxels.forEach((voxel) => occupied.set(key(voxel.gx - min[0], voxel.gy - min[1], voxel.gz - min[2]), voxel.materialId))
  const positions: number[] = []
  const normals: number[] = []
  const aoValues: number[] = []
  const materialIds: number[] = []
  const indices: number[] = []
  let quadCount = 0

  for (let axis = 0; axis < 3; axis += 1) {
    const u = (axis + 1) % 3
    const v = (axis + 2) % 3
    const x = [0, 0, 0]
    const q = [0, 0, 0]
    q[axis] = 1
    const mask: MaskCell[] = new Array(dimensions[u] * dimensions[v]).fill(null)
    for (x[axis] = -1; x[axis] < dimensions[axis];) {
      let n = 0
      for (x[v] = 0; x[v] < dimensions[v]; x[v] += 1) {
        for (x[u] = 0; x[u] < dimensions[u]; x[u] += 1) {
          const a = x[axis] >= 0 ? occupied.get(key(x[0], x[1], x[2])) : undefined
          const b = x[axis] < dimensions[axis] - 1 ? occupied.get(key(x[0] + q[0], x[1] + q[1], x[2] + q[2])) : undefined
          mask[n++] = a === undefined && b === undefined || a !== undefined && b !== undefined
            ? null
            : a !== undefined
              ? { materialId: a, sign: 1 }
              : { materialId: b!, sign: -1 }
        }
      }
      x[axis] += 1
      n = 0
      for (let j = 0; j < dimensions[v]; j += 1) {
        for (let i = 0; i < dimensions[u];) {
          const cell = mask[n]
          if (!cell) {
            i += 1
            n += 1
            continue
          }
          let width = 1
          while (i + width < dimensions[u]) {
            const candidate = mask[n + width]
            if (!candidate || candidate.materialId !== cell.materialId || candidate.sign !== cell.sign) break
            width += 1
          }
          let height = 1
          heightLoop: while (j + height < dimensions[v]) {
            for (let offset = 0; offset < width; offset += 1) {
              const candidate = mask[n + offset + height * dimensions[u]]
              if (!candidate || candidate.materialId !== cell.materialId || candidate.sign !== cell.sign) break heightLoop
            }
            height += 1
          }
          x[u] = i
          x[v] = j
          const du = [0, 0, 0]
          const dv = [0, 0, 0]
          du[u] = width
          dv[v] = height
          const base = x.map((value, index) => value + min[index])
          const corners = [
            base,
            base.map((value, index) => value + du[index]),
            base.map((value, index) => value + du[index] + dv[index]),
            base.map((value, index) => value + dv[index]),
          ]
          const order = cell.sign > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1]
          const firstVertex = positions.length / 3
          order.forEach((cornerIndex) => {
            positions.push(...corners[cornerIndex])
            const normal = [0, 0, 0]
            normal[axis] = cell.sign
            normals.push(...normal)
            const faceCell = base.map((value, index) => value + (cell.sign < 0 ? q[index] : 0))
            const deltaU = cornerIndex === 0 || cornerIndex === 3 ? -1 : 1
            const deltaV = cornerIndex === 0 || cornerIndex === 1 ? -1 : 1
            const sideU = [...faceCell]
            const sideV = [...faceCell]
            const corner = [...faceCell]
            sideU[u] += deltaU
            sideV[v] += deltaV
            corner[u] += deltaU
            corner[v] += deltaV
            const occupiedAt = (point: number[]) => occupied.has(key(point[0] - min[0], point[1] - min[1], point[2] - min[2]))
            const sideUOccupied = occupiedAt(sideU)
            const sideVOccupied = occupiedAt(sideV)
            const cornerOccupied = occupiedAt(corner)
            const ao = sideUOccupied && sideVOccupied
              ? 0.52
              : 1 - (sideUOccupied ? 0.18 : 0) - (sideVOccupied ? 0.18 : 0) - (cornerOccupied ? 0.10 : 0)
            aoValues.push(ao)
            materialIds.push(cell.materialId)
          })
          indices.push(firstVertex, firstVertex + 1, firstVertex + 2, firstVertex, firstVertex + 2, firstVertex + 3)
          quadCount += 1
          for (let h = 0; h < height; h += 1) {
            for (let w = 0; w < width; w += 1) mask[n + w + h * dimensions[u]] = null
          }
          i += width
          n += width
        }
      }
    }
  }
  const positionBuffer = new Float32Array(positions)
  const normalBuffer = new Int8Array(normals)
  return {
    positions: positionBuffer,
    normals: normalBuffer,
    ao: new Float32Array(aoValues),
    materialIds: new Uint8Array(materialIds),
    indices: new Uint32Array(indices),
    outlinePositions: options.includeOutline ? buildOutlinePositions(positionBuffer, normalBuffer, quadCount) : undefined,
    quadCount,
  }
}
