import { buildVariantGeometry } from './voxel-variant-geometry'
import { VARIANT_FACING_DIRECTIONS, oppositeVoxelFacing, voxelFacing, voxelRotation, voxelShape } from './voxel-variants'
import type { Voxel } from './voxel'

export type VoxelSurfaceDiagnostics = {
  duplicateFaces: number
  nonManifoldEdges: number
  weldedVertices: number
  closed: boolean
}

export type VoxelSurfaceMesh = {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  /** Lightweight vertex AO; consumers may omit it when using an unlit export. */
  ao: Float32Array
  indices: Uint32Array
  diagnostics: VoxelSurfaceDiagnostics
}

type Point = [number, number, number]
type ColorResolver = (voxel: Voxel) => string

const cubeFaces: Array<{ normal: Point; corners: Point[] }> = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
]

const pointKey = (point: Point) => point.map((value) => value.toFixed(6)).join(',')
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`
const faceKey = (points: Point[]) => points.map(pointKey).sort().join('|')

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  const direction: Point = [end[0] - start[0], end[1] - start[1], end[2] - start[2]]
  const relative: Point = [point[0] - start[0], point[1] - start[1], point[2] - start[2]]
  const length = Math.hypot(...direction)
  if (length < 1e-8) return false
  const cross: Point = [
    direction[1] * relative[2] - direction[2] * relative[1],
    direction[2] * relative[0] - direction[0] * relative[2],
    direction[0] * relative[1] - direction[1] * relative[0],
  ]
  if (Math.hypot(...cross) > 1e-6 * length) return false
  const projection = (relative[0] * direction[0] + relative[1] * direction[1] + relative[2] * direction[2]) / (length * length)
  return projection > 1e-6 && projection < 1 - 1e-6
}

function pointInsideTriangle(point: Point, triangle: Point[]): boolean {
  const [a, b, c] = triangle
  const ab: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ac: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const ap: Point = [point[0] - a[0], point[1] - a[1], point[2] - a[2]]
  const normal: Point = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
  const normalLength = Math.hypot(...normal)
  if (normalLength < 1e-8 || Math.abs(normal[0] * ap[0] + normal[1] * ap[1] + normal[2] * ap[2]) > 1e-6 * normalLength) return false
  const dot = (left: Point, right: Point) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
  const v0 = ac
  const v1 = ab
  const v2 = ap
  const d00 = dot(v0, v0)
  const d01 = dot(v0, v1)
  const d11 = dot(v1, v1)
  const d20 = dot(v2, v0)
  const d21 = dot(v2, v1)
  const denominator = d00 * d11 - d01 * d01
  if (Math.abs(denominator) < 1e-8) return false
  const v = (d11 * d20 - d01 * d21) / denominator
  const w = (d00 * d21 - d01 * d20) / denominator
  const u = 1 - v - w
  return u >= -1e-6 && v >= -1e-6 && w >= -1e-6
}

/** Count manifold segments while treating a vertex that splits a long edge as
 * a real topological split. This avoids false positives at T-junctions where
 * a variant meets a coplanar cube face with a different triangulation. */
function countSpatialNonManifoldEdges(triangles: Point[][]): number {
  const allPoints = new Map<string, Point>()
  triangles.flat().forEach((point) => allPoints.set(pointKey(point), point))
  const segments = new Map<string, { count: number; start: Point; end: Point }>()
  for (const triangle of triangles) {
    for (const [start, end] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const points = [start, end, ...[...allPoints.values()].filter((point) => pointOnSegment(point, start, end))]
      const direction: Point = [end[0] - start[0], end[1] - start[1], end[2] - start[2]]
      const lengthSquared = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2
      points.sort((left, right) => {
        const leftT = ((left[0] - start[0]) * direction[0] + (left[1] - start[1]) * direction[1] + (left[2] - start[2]) * direction[2]) / lengthSquared
        const rightT = ((right[0] - start[0]) * direction[0] + (right[1] - start[1]) * direction[1] + (right[2] - start[2]) * direction[2]) / lengthSquared
        return leftT - rightT
      })
      for (let index = 0; index < points.length - 1; index += 1) {
        const left = pointKey(points[index])
        const right = pointKey(points[index + 1])
        if (left === right) continue
        const key = left < right ? `${left}:${right}` : `${right}:${left}`
        const existing = segments.get(key)
        segments.set(key, existing ? { ...existing, count: existing.count + 1 } : { count: 1, start: points[index], end: points[index + 1] })
      }
    }
  }
  return [...segments.values()].filter(({ count, start, end }) => {
    if (count === 2) return false
    const midpoint: Point = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2]
    // A count of 1 or 3 is often a harmless T-junction: a variant boundary
    // lands inside a coplanar cube triangle. The surface is still closed in
    // space; the diagnostic should not mistake that tessellation seam for an
    // open or duplicated shell. A count of 4+ remains a real overlap.
    if ((count === 1 || count === 3) && triangles.some((triangle) => pointInsideTriangle(midpoint, triangle))) return false
    return true
  }).length
}

function facingFromNormal(normal: Point) {
  if (normal[0] === 1) return '+x' as const
  if (normal[0] === -1) return '-x' as const
  if (normal[1] === 1) return '+y' as const
  if (normal[1] === -1) return '-y' as const
  if (normal[2] === 1) return '+z' as const
  return '-z' as const
}

function variantTriangleCoveredByCubeNeighbor(
  triangle: Point[],
  voxel: Voxel,
  occupiedVoxels: Map<string, Voxel>,
): boolean {
  const epsilon = 1e-6
  const center: Point = [
    triangle.reduce((sum, point) => sum + point[0], 0) / 3,
    triangle.reduce((sum, point) => sum + point[1], 0) / 3,
    triangle.reduce((sum, point) => sum + point[2], 0) / 3,
  ]
  const contacts: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ]
  return contacts.some(([dx, dy, dz]) => {
    const neighbor = occupiedVoxels.get(cellKey(voxel.x + dx, voxel.y + dy, voxel.z + dz))
    if (!neighbor || voxelShape(neighbor) !== 'cube') return false
    const shared = [
      voxel.x + (dx > 0 ? 1 : 0),
      voxel.y + (dy > 0 ? 1 : 0),
      voxel.z + (dz > 0 ? 1 : 0),
    ]
    const normalAxis = dx !== 0 ? 0 : dy !== 0 ? 1 : 2
    if (!triangle.every((point) => Math.abs(point[normalAxis] - shared[normalAxis]) <= epsilon)) return false
    const otherAxes = [0, 1, 2].filter((axis) => axis !== normalAxis)
    return otherAxes.every((axis) => {
      const minimum = axis === 0 ? voxel.x : axis === 1 ? voxel.y : voxel.z
      return center[axis] >= minimum - epsilon && center[axis] <= minimum + 1 + epsilon
    })
  })
}

function parseColor(value: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value : '#6c827d'
  return [
    parseInt(normalized.slice(1, 3), 16) / 255,
    parseInt(normalized.slice(3, 5), 16) / 255,
    parseInt(normalized.slice(5, 7), 16) / 255,
  ]
}

function addTriangle(
  points: Point[],
  normal: Point,
  color: [number, number, number],
  vertices: Point[],
  normals: Point[],
  colors: Array<[number, number, number]>,
  indices: number[],
  seenFaces: Set<string>,
): boolean {
  const key = faceKey(points)
  if (seenFaces.has(key)) return false
  seenFaces.add(key)
  const start = vertices.length
  points.forEach((point) => {
    vertices.push(point)
    normals.push(normal)
    colors.push(color)
  })
  indices.push(start, start + 1, start + 2)
  return true
}

/**
 * Build one exterior surface for both cube and variant voxels.
 * Coordinates are kept in the editor's storage convention (X/Y/Z), so this
 * module can be shared by STL and GLB exporters without another transform.
 */
export function buildVoxelSurfaceMesh(voxels: ReadonlyArray<Voxel>, colorResolver: ColorResolver = (voxel) => voxel.materialId): VoxelSurfaceMesh {
  const occupied = new Set(voxels.map((voxel) => cellKey(voxel.x, voxel.y, voxel.z)))
  const occupiedVoxels = new Map(voxels.map((voxel) => [cellKey(voxel.x, voxel.y, voxel.z), voxel] as const))
  const vertices: Point[] = []
  const normals: Point[] = []
  const colors: Array<[number, number, number]> = []
  const indices: number[] = []
  const seenFaces = new Set<string>()
  let duplicateFaces = 0

  const append = (points: Point[], normal: Point, voxel: Voxel) => {
    const color = parseColor(colorResolver(voxel))
    if (!addTriangle(points.slice(0, 3), normal, color, vertices, normals, colors, indices, seenFaces)) duplicateFaces += 1
    if (!addTriangle([points[0], points[2], points[3]], normal, color, vertices, normals, colors, indices, seenFaces)) duplicateFaces += 1
  }

  for (const voxel of voxels) {
    if (voxelShape(voxel) === 'cube') {
      for (const face of cubeFaces) {
        const [dx, dy, dz] = face.normal
        const neighbor = occupiedVoxels.get(cellKey(voxel.x + dx, voxel.y + dy, voxel.z + dz))
        if (neighbor && (voxelShape(neighbor) === 'cube' || voxelFacing(neighbor) === oppositeVoxelFacing(facingFromNormal(face.normal)))) continue
        append(face.corners.map(([x, y, z]) => [voxel.x + x, voxel.y + y, voxel.z + z] as Point), face.normal, voxel)
      }
      continue
    }

    const [dx, dy, dz] = VARIANT_FACING_DIRECTIONS[voxelFacing(voxel)]
    const mountingNeighbor = occupiedVoxels.get(cellKey(voxel.x + dx, voxel.y + dy, voxel.z + dz))
    const hasMountingNeighbor = Boolean(mountingNeighbor && (
      voxelShape(mountingNeighbor) === 'cube'
      || voxelFacing(mountingNeighbor) === oppositeVoxelFacing(voxelFacing(voxel))
    ))
    const source = buildVariantGeometry(voxelShape(voxel) as Exclude<ReturnType<typeof voxelShape>, 'cube'>, voxelFacing(voxel), voxelRotation(voxel), !hasMountingNeighbor)
    const transformed: Point[] = []
    for (let index = 0; index < source.positions.length; index += 3) {
      // buildVariantGeometry uses Three's X/Z/Y order; convert back once.
      transformed.push([
        voxel.x + source.positions[index],
        voxel.y + source.positions[index + 2],
        voxel.z + source.positions[index + 1],
      ])
    }
    for (let index = 0; index < source.indices.length; index += 3) {
      const triangle = [transformed[source.indices[index]], transformed[source.indices[index + 1]], transformed[source.indices[index + 2]]]
      // A cube neighbor already owns the complete shared cell face. Remove
      // only variant triangles lying on that coplanar contact, rather than
      // deleting the entire cube face and creating a hole where the variant
      // covers only part of the logical cell boundary.
      if (variantTriangleCoveredByCubeNeighbor(triangle, voxel, occupiedVoxels)) continue
      const normal: Point = [source.normals[source.indices[index] * 3], source.normals[source.indices[index] * 3 + 2], source.normals[source.indices[index] * 3 + 1]]
      const color = parseColor(colorResolver(voxel))
      if (!addTriangle(triangle, normal, color, vertices, normals, colors, indices, seenFaces)) duplicateFaces += 1
    }
  }

  // Weld vertices by position and recompute a stable flat normal per vertex.
  // Triangle indices remain intentionally flat-shaded: adjoining voxel faces
  // should retain a readable edge instead of becoming a smoothed blob.
  // A single spatial vertex cannot carry two different colors or two hard
  // face normals in a vertex-colored mesh. Keep those cases split while still
  // welding the common vertices of the same planar face. This avoids the
  // classic "one color leaks into the neighbouring face" artifact after a
  // multi-color export and keeps voxel edges crisp under studio lighting.
  const welded = new Map<string, number>()
  const weldedPositions: Point[] = []
  const weldedNormals: Point[] = []
  const weldedColors: Array<[number, number, number]> = []
  const weldedAo: number[] = []
  const remapped: number[] = []
  let weldedVertices = 0
  for (let index = 0; index < vertices.length; index += 1) {
    const color = colors[index]
    const key = `${pointKey(vertices[index])}|${pointKey(normals[index])}|${color.map((value) => value.toFixed(6)).join(',')}`
    const existing = welded.get(key)
    if (existing !== undefined) {
      remapped.push(existing)
      weldedVertices += 1
      continue
    }
    const next = weldedPositions.length
    welded.set(key, next)
    weldedPositions.push(vertices[index])
    weldedNormals.push(normals[index])
    weldedColors.push(colors[index])
    // Approximate corner occlusion from the number of occupied cells around
    // the grid vertex. It is intentionally subtle: geometry readability must
    // survive even when a model is viewed from a grazing angle.
    const [px, py, pz] = vertices[index]
    let occupiedAround = 0
    for (const ox of [-1, 0]) for (const oy of [-1, 0]) for (const oz of [-1, 0]) {
      if (occupied.has(cellKey(px + ox, py + oy, pz + oz))) occupiedAround += 1
    }
    weldedAo.push(1 - Math.min(0.12, occupiedAround * 0.015))
    remapped.push(next)
  }

  const triangles = []
  for (let index = 0; index < remapped.length; index += 3) {
    triangles.push([weldedPositions[remapped[index]], weldedPositions[remapped[index + 1]], weldedPositions[remapped[index + 2]]])
  }
  const nonManifoldEdges = countSpatialNonManifoldEdges(triangles)

  return {
    positions: new Float32Array(weldedPositions.flat()),
    normals: new Float32Array(weldedNormals.flat()),
    colors: new Float32Array(weldedColors.flat()),
    ao: new Float32Array(weldedAo),
    indices: new Uint32Array(remapped),
    diagnostics: {
      duplicateFaces,
      nonManifoldEdges,
      weldedVertices,
      closed: nonManifoldEdges === 0,
    },
  }
}
