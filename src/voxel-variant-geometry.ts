import { VOXEL_FACE_FRAMES, type VoxelFacing, type VoxelRotation, type VoxelShape } from './voxel-variants'

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
const normalize = (v: P): P => { const length = Math.hypot(...v); return length ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0] }

/**
 * Extrude a closed 2D profile through the local v axis.
 *
 * The profile is expressed as [u, 0, n] and is counter-clockwise in the
 * (u,n) plane. Its u=0 edge is the complete square face that is attached to
 * the face selected by the user. The other profile edges describe the shape
 * that extends away from that face.
 */
function addExtrudedProfile(
  positions: number[],
  normals: number[],
  indices: number[],
  profile: P[],
  capTriangles: Array<[number, number, number]>,
  includeMountingFace = true,
) {
  const front = profile.map(([u, _v, n]) => [u, 0, n] as P)
  const back = profile.map(([u, _v, n]) => [u, 1, n] as P)

  capTriangles.forEach(([a, b, c]) => {
    addTri(positions, normals, indices, front[a], front[b], front[c], [0, -1, 0])
    addTri(positions, normals, indices, back[a], back[c], back[b], [0, 1, 0])
  })

  for (let index = 0; index < profile.length; index += 1) {
    const next = (index + 1) % profile.length
    const [u0, _v0, n0] = profile[index]
    const [u1, _v1, n1] = profile[next]
    // The profile edge at u=0 is the complete square face that mounts
    // against the voxel selected by the user.  It is part of the closed
    // export mesh, but the realtime renderer can omit it when a neighbouring
    // occupied voxel already owns the coplanar face.
    if (!includeMountingFace && Math.abs(u0) < 1e-7 && Math.abs(u1) < 1e-7) continue
    const outward = normalize([n1 - n0, 0, -(u1 - u0)])
    addQuad(positions, normals, indices, front[index], back[index], back[next], front[next], outward)
  }
}

function canonical(shape: Exclude<VoxelShape, 'cube'>, includeMountingFace = true): VariantGeometry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = []
  if (shape === 'tri-prism') {
    // The profile is a right triangle of area 1/2. Its top edge n=1 is the
    // complete square mounting face; the hypotenuse is the ramp. At rotation
    // 0 the thick/high side is on the left, so the ramp descends to the right.
    const profile: P[] = [[0, 0, 0], [1, 0, 1], [0, 0, 1]]
    addExtrudedProfile(positions, normals, indices, profile, [[0, 1, 2]], includeMountingFace)
  } else if (shape === 'quarter-cylinder') {
    const segments = 12
    // A quarter disk in the (u,n) cross-section, extruded along v. The arc
    // starts at the thick/high left side and ends at the thin right side.
    const profile: P[] = [[0, 0, 0]]
    for (let index = 0; index < segments; index += 1) {
      const angle = (index + 1) * Math.PI / 2 / segments
      profile.push([Math.sin(angle), 0, 1 - Math.cos(angle)])
    }
    profile.push([0, 0, 1])
    const capTriangles: Array<[number, number, number]> = []
    for (let index = 1; index < profile.length - 1; index += 1) capTriangles.push([0, index, index + 1])
    addExtrudedProfile(positions, normals, indices, profile, capTriangles, includeMountingFace)
  } else {
    // A concave stepped profile with area 3/4: the left half fills the
    // complete depth, while the right half keeps only the outer half. The
    // mounting edge n=1 still spans the entire u range.
    const profile: P[] = [[0, 0, 0], [0.5, 0, 0], [0.5, 0, 0.5], [1, 0, 0.5], [1, 0, 1], [0, 0, 1]]
    addExtrudedProfile(positions, normals, indices, profile, [
      [0, 1, 2], [0, 2, 5], [2, 3, 4], [2, 4, 5],
    ], includeMountingFace)
  }
  return { positions, normals, indices }
}

function transformPoint(point: P, facing: VoxelFacing, rotation: VoxelRotation): P {
  const frame = VOXEL_FACE_FRAMES[facing]
  // The canonical profile uses u as the depth axis.  Its u=0 edge is the
  // complete square mounting face; v/n are the two coordinates on that
  // face.  Rotate v/n around the face normal, never u/v as the old path did.
  const depth = point[0] - 0.5, faceRight = point[1] - 0.5, faceUp = point[2] - 0.5
  const angle = rotation * Math.PI / 2
  const rotatedRight = faceRight * Math.cos(angle) - faceUp * Math.sin(angle)
  const rotatedUp = faceRight * Math.sin(angle) + faceUp * Math.cos(angle)
  // The mounting face is at u=0 and has local outward normal -u.  Mapping
  // -u to frame.normal makes `facing` describe the actual face touching the
  // neighbouring voxel, while the shape extends into the opposite side of
  // the cell.
  return [
    0.5 - frame.normal[0] * depth + frame.right[0] * rotatedRight + frame.up[0] * rotatedUp,
    0.5 - frame.normal[1] * depth + frame.right[1] * rotatedRight + frame.up[1] * rotatedUp,
    0.5 - frame.normal[2] * depth + frame.right[2] * rotatedRight + frame.up[2] * rotatedUp,
  ]
}

function transformNormal(normal: P, facing: VoxelFacing, rotation: VoxelRotation): P {
  const frame = VOXEL_FACE_FRAMES[facing]
  const angle = rotation * Math.PI / 2
  const rotatedRight = normal[1] * Math.cos(angle) - normal[2] * Math.sin(angle)
  const rotatedUp = normal[1] * Math.sin(angle) + normal[2] * Math.cos(angle)
  return normalize([
    -frame.normal[0] * normal[0] + frame.right[0] * rotatedRight + frame.up[0] * rotatedUp,
    -frame.normal[1] * normal[0] + frame.right[1] * rotatedRight + frame.up[1] * rotatedUp,
    -frame.normal[2] * normal[0] + frame.right[2] * rotatedRight + frame.up[2] * rotatedUp,
  ])
}

/** Returns unit-cell geometry in Three world-local coordinates (storage X/Z/Y mapping applied). */
export function buildVariantGeometry(shape: Exclude<VoxelShape, 'cube'>, facing: VoxelFacing = '+y', rotation: VoxelRotation = 0, includeMountingFace = true): VariantGeometry {
  const source = canonical(shape, includeMountingFace)
  const positions: number[] = [], normals: number[] = []
  for (let index = 0; index < source.positions.length; index += 3) {
    const storage = transformPoint([source.positions[index], source.positions[index + 1], source.positions[index + 2]], facing, rotation)
    positions.push(storage[0], storage[2], storage[1])
    const normal = transformNormal([source.normals[index], source.normals[index + 1], source.normals[index + 2]], facing, rotation)
    normals.push(normal[0], normal[2], normal[1])
  }
  // The mounting-frame transform itself reverses orientation once (the
  // profile's +u axis points away from the mounting face), and the storage
  // X/Y/Z -> Three X/Z/Y permutation reverses it a second time. The two
  // reflections cancel, so the canonical triangle winding remains valid.
  return { positions, normals, indices: source.indices }
}

export function variantGeometryCacheKey(shape: Exclude<VoxelShape, 'cube'>, facing: VoxelFacing, rotation: VoxelRotation, includeMountingFace = true): string {
  return `${shape}:${facing}:${rotation}:${includeMountingFace ? 'closed' : 'open'}`
}
