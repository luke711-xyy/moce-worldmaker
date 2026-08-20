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

export function buildOutlinePositions(positions: Float32Array, normals: Int8Array, quadCount: number): Float32Array {
  type Point = [number, number, number]
  type Edge = { start: Point; end: Point; normal: Point }
  type UnitEdgeState = {
    start: Point
    end: Point
    normals: Map<string, { count: number; edge: Edge }>
  }

  // Each greedy quad is emitted as four consecutive vertices. A simple
  // whole-segment map is not sufficient here: greedy meshing can produce a
  // long edge on one quad and two shorter edges on the adjacent quads (a
  // T-junction). Those edges are coplanar, but their endpoint pairs differ,
  // so the old implementation left the internal line visible. Split every
  // axis-aligned edge into unit segments first, cancel coplanar segments, and
  // merge the surviving segments again. This removes internal same-plane
  // lines without losing real creases or the silhouette.
  const unitEdges = new Map<string, UnitEdgeState>()
  const edgePairs: Array<[number, number]> = [[0, 1], [1, 2], [2, 3], [3, 0]]
  const point = (vertex: number): Point => [
    positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2],
  ]
  const normal = (vertex: number): Point => [
    normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2],
  ]
  const normalKey = (value: Point) => `${value[0]},${value[1]},${value[2]}`
  const unitSegmentKey = (start: Point, end: Point) => {
    const a = `${start[0]},${start[1]},${start[2]}`
    const b = `${end[0]},${end[1]},${end[2]}`
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  const addUnitEdge = (start: Point, end: Point, faceNormal: Point) => {
    const delta = [end[0] - start[0], end[1] - start[1], end[2] - start[2]]
    const axis = delta.findIndex((value) => value !== 0)
    if (axis < 0) return
    const direction = delta[axis] > 0 ? 1 : -1
    const length = Math.abs(delta[axis])
    const normalId = normalKey(faceNormal)
    for (let offset = 0; offset < length; offset += 1) {
      const unitStart: Point = [...start]
      const unitEnd: Point = [...start]
      unitStart[axis] += direction * offset
      unitEnd[axis] += direction * (offset + 1)
      // Greedy quads can wind their edges in opposite directions. Normalize
      // every unit segment before storing it; otherwise run joining can
      // backtrack and leave short spikes or drop a perimeter segment.
      const normalizedStart: Point = [...unitStart]
      const normalizedEnd: Point = [...unitEnd]
      if (normalizedStart[axis] > normalizedEnd[axis]) {
        const swap = normalizedStart[axis]
        normalizedStart[axis] = normalizedEnd[axis]
        normalizedEnd[axis] = swap
      }
      const key = unitSegmentKey(normalizedStart, normalizedEnd)
      const previous = unitEdges.get(key)
      if (!previous) {
        unitEdges.set(key, {
          start: normalizedStart,
          end: normalizedEnd,
          normals: new Map([[normalId, {
            count: 1,
            edge: { start: normalizedStart, end: normalizedEnd, normal: faceNormal },
          }]]),
        })
        continue
      }
      const sameNormal = previous.normals.get(normalId)
      if (sameNormal) {
        sameNormal.count += 1
      } else {
        previous.normals.set(normalId, {
          count: 1,
          edge: { start: normalizedStart, end: normalizedEnd, normal: faceNormal },
        })
      }
    }
  }

  for (let quad = 0; quad < quadCount; quad += 1) {
    const base = quad * 4
    const faceNormal = normal(base)
    edgePairs.forEach(([startIndex, endIndex]) => {
      const start = point(base + startIndex)
      const end = point(base + endIndex)
      addUnitEdge(start, end, faceNormal)
    })
  }

  // A surviving geometric edge can be shared by two perpendicular faces.
  // It still needs only one line. Group the unit segments by their supporting
  // line and one deterministic surviving normal, then join adjacent runs.
  const runs = new Map<string, Edge[]>()
  unitEdges.forEach((state) => {
    // A coplanar partition edge is emitted twice with the same face normal;
    // a perimeter edge is emitted once. Different normals on one geometric
    // edge represent a real crease/silhouette and keep one line.
    const surviving = [...state.normals.values()].find((entry) => entry.count === 1)?.edge
    if (!surviving) return
    const axis = [0, 1, 2].find((index) => state.start[index] !== state.end[index]) ?? 0
    const fixed = [0, 1, 2].filter((index) => index !== axis).map((index) => state.start[index]).join(',')
    const runKey = `${axis}|${fixed}|${normalKey(surviving.normal)}`
    const run = runs.get(runKey)
    if (run) run.push(surviving)
    else runs.set(runKey, [surviving])
  })

  const output: number[] = []
  runs.forEach((segments) => {
    const axis = [0, 1, 2].find((index) => segments[0].start[index] !== segments[0].end[index]) ?? 0
    segments.sort((a, b) => Math.min(a.start[axis], a.end[axis]) - Math.min(b.start[axis], b.end[axis]))
    let current = segments[0]
    for (let index = 1; index < segments.length; index += 1) {
      const next = segments[index]
      const currentEnd = Math.max(current.start[axis], current.end[axis])
      const nextStart = Math.min(next.start[axis], next.end[axis])
      if (currentEnd === nextStart) {
        current = { ...current, end: next.end }
      } else {
        output.push(...current.start, ...current.end)
        current = next
      }
    }
    output.push(...current.start, ...current.end)
  })
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
            const ao = Math.max(0.84, 1 - (sideUOccupied ? 0.08 : 0) - (sideVOccupied ? 0.08 : 0) - (cornerOccupied ? 0.04 : 0))
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
