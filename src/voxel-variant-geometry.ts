import type { VoxelFacing, VoxelRotation, VoxelShape } from './voxel-variants'

export type VariantGeometry = { positions: number[]; normals: number[]; indices: number[] }
type P = [number, number, number]

const addQuad = (positions: number[], normals: number[], indices: number[], a: P, b: P, c: P, d: P, normal: P) => {
  const start = positions.length / 3
  ;[a, b, c, d].forEach((point) => positions.push(...point))
  ;[a, b, c, d].forEach(() => normals.push(...normal))
  indices.push(start, start + 1, start + 2, start, start + 2, start + 3)
}
const addTri = (positions: number[], normals: number[], indices: number[], a: P, b: P, c: P, normal: P) => {
  const start = positions.length / 3
  ;[a, b, c].forEach((point) => positions.push(...point))
  ;[a, b, c].forEach(() => normals.push(...normal))
  indices.push(start, start + 1, start + 2)
}
const addBox = (positions: number[], normals: number[], indices: number[], min: P, max: P) => {
  const [x0, y0, z0] = min, [x1, y1, z1] = max
  addQuad(positions, normals, indices, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0])
  addQuad(positions, normals, indices, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0])
  addQuad(positions, normals, indices, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0])
  addQuad(positions, normals, indices, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0])
  addQuad(positions, normals, indices, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1])
  addQuad(positions, normals, indices, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1])
}

const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = (v: P): P => { const length = Math.hypot(...v); return length ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0] }
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

function canonical(shape: Exclude<VoxelShape, 'cube'>): VariantGeometry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = []
  if (shape === 'tri-prism') {
    // Right triangular prism: z <= x, extruded along local Y.
    const a: P = [0, 0, 0], b: P = [1, 0, 0], c: P = [1, 0, 1]
    const d: P = [0, 1, 0], e: P = [1, 1, 0], f: P = [1, 1, 1]
    addQuad(positions, normals, indices, a, b, e, d, [0, -1, 0])
    addQuad(positions, normals, indices, b, c, f, e, normalize([1, 0, -1]))
    addQuad(positions, normals, indices, a, d, f, c, normalize([-1, 0, 1]))
    addTri(positions, normals, indices, a, c, b, [0, 0, -1])
    addTri(positions, normals, indices, d, e, f, [0, 0, 1])
  } else if (shape === 'quarter-cylinder') {
    const segments = 12
    const bottomCenter: P = [0, 0, 0]
    const topCenter: P = [0, 0, 1]
    for (let index = 0; index < segments; index += 1) {
      const a = index * Math.PI / 2 / segments, b = (index + 1) * Math.PI / 2 / segments
      const p1: P = [Math.cos(a), Math.sin(a), 0], p2: P = [Math.cos(b), Math.sin(b), 0]
      const q1: P = [p1[0], p1[1], 1], q2: P = [p2[0], p2[1], 1]
      addQuad(positions, normals, indices, p1, p2, q2, q1, normalize([Math.cos((a + b) / 2), Math.sin((a + b) / 2), 0]))
      addTri(positions, normals, indices, bottomCenter, p2, p1, [0, 0, -1])
      addTri(positions, normals, indices, topCenter, q1, q2, [0, 0, 1])
    }
    addQuad(positions, normals, indices, [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, -1, 0])
    addQuad(positions, normals, indices, [0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0], [-1, 0, 0])
  } else {
    // Lower half full; upper half occupies x=[0,.5]: 3/4 cell volume.
    addBox(positions, normals, indices, [0, 0, 0], [1, 0.5, 1])
    addBox(positions, normals, indices, [0, 0.5, 0], [0.5, 1, 1])
  }
  return { positions, normals, indices }
}

const basis: Record<VoxelFacing, { right: P; up: P; normal: P }> = {
  '+x': { right: [0, 0, -1], up: [0, 1, 0], normal: [1, 0, 0] },
  '-x': { right: [0, 0, 1], up: [0, 1, 0], normal: [-1, 0, 0] },
  '+y': { right: [1, 0, 0], up: [0, 0, 1], normal: [0, 1, 0] },
  '-y': { right: [1, 0, 0], up: [0, 0, -1], normal: [0, -1, 0] },
  '+z': { right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1] },
  '-z': { right: [-1, 0, 0], up: [0, 1, 0], normal: [0, 0, -1] },
}

function transformPoint(point: P, facing: VoxelFacing, rotation: VoxelRotation): P {
  const frame = basis[facing]
  const u = point[0] - 0.5, v = point[1] - 0.5, n = point[2] - 0.5
  const angle = rotation * Math.PI / 2
  const ru = u * Math.cos(angle) - v * Math.sin(angle), rv = u * Math.sin(angle) + v * Math.cos(angle)
  return [0.5 + frame.right[0] * ru + frame.up[0] * rv + frame.normal[0] * n, 0.5 + frame.right[1] * ru + frame.up[1] * rv + frame.normal[1] * n, 0.5 + frame.right[2] * ru + frame.up[2] * rv + frame.normal[2] * n]
}

function transformNormal(normal: P, facing: VoxelFacing, rotation: VoxelRotation): P {
  const frame = basis[facing]
  const angle = rotation * Math.PI / 2
  const ru = normal[0] * Math.cos(angle) - normal[1] * Math.sin(angle), rv = normal[0] * Math.sin(angle) + normal[1] * Math.cos(angle)
  return normalize([frame.right[0] * ru + frame.up[0] * rv + frame.normal[0] * normal[2], frame.right[1] * ru + frame.up[1] * rv + frame.normal[1] * normal[2], frame.right[2] * ru + frame.up[2] * rv + frame.normal[2] * normal[2]])
}

/** Returns unit-cell geometry in Three world-local coordinates (storage X/Z/Y mapping applied). */
export function buildVariantGeometry(shape: Exclude<VoxelShape, 'cube'>, facing: VoxelFacing = '+y', rotation: VoxelRotation = 0, variantId = 'isolated'): VariantGeometry {
  const source = canonical(shape)
  const positions: number[] = [], normals: number[] = []
  for (let index = 0; index < source.positions.length; index += 3) {
    const storage = transformPoint([source.positions[index], source.positions[index + 1], source.positions[index + 2]], facing, rotation)
    positions.push(storage[0], storage[2], storage[1])
    const normal = transformNormal([source.normals[index], source.normals[index + 1], source.normals[index + 2]], facing, rotation)
    normals.push(normal[0], normal[2], normal[1])
  }
  // Derived topology variants use deterministic mirrored/turned local geometry.
  // Keeping this small and shared avoids generating a separate mesh for every cell.
  if (variantId === 'corner' || variantId === 'outer' || variantId === 'mirror') {
    for (let index = 0; index < positions.length; index += 3) positions[index] = 1 - positions[index]
  }
  return { positions, normals, indices: source.indices }
}

export function variantGeometryCacheKey(shape: Exclude<VoxelShape, 'cube'>, facing: VoxelFacing, rotation: VoxelRotation, variantId: string): string {
  return `${shape}:${facing}:${rotation}:${variantId}`
}
