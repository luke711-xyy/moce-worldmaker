export type MesherVoxel = {
  gx: number
  gy: number
  gz: number
  materialId: number
}

export type GreedyMeshPayload = {
  positions: Float32Array
  normals: Int8Array
  materialIds: Uint8Array
  indices: Uint32Array
  quadCount: number
}

type MaskCell = { materialId: number; sign: -1 | 1 } | null

const key = (x: number, y: number, z: number) => `${x},${y},${z}`

export function buildGreedyMesh(voxels: ReadonlyArray<MesherVoxel>): GreedyMeshPayload {
  if (!voxels.length) return {
    positions: new Float32Array(),
    normals: new Int8Array(),
    materialIds: new Uint8Array(),
    indices: new Uint32Array(),
    quadCount: 0,
  }
  const min = [
    Math.min(...voxels.map((voxel) => voxel.gx)),
    Math.min(...voxels.map((voxel) => voxel.gy)),
    Math.min(...voxels.map((voxel) => voxel.gz)),
  ]
  const max = [
    Math.max(...voxels.map((voxel) => voxel.gx)),
    Math.max(...voxels.map((voxel) => voxel.gy)),
    Math.max(...voxels.map((voxel) => voxel.gz)),
  ]
  const dimensions = max.map((value, axis) => value - min[axis] + 1)
  const occupied = new Map<string, number>()
  voxels.forEach((voxel) => occupied.set(key(voxel.gx - min[0], voxel.gy - min[1], voxel.gz - min[2]), voxel.materialId))
  const positions: number[] = []
  const normals: number[] = []
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
  return {
    positions: new Float32Array(positions),
    normals: new Int8Array(normals),
    materialIds: new Uint8Array(materialIds),
    indices: new Uint32Array(indices),
    quadCount,
  }
}
