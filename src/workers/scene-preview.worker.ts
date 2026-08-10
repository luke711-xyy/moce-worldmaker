/// <reference lib="webworker" />

import type { ScenePreviewWorkerRequest, ScenePreviewWorkerResponse } from '../runtime/scene-preview-client'
import { exteriorAirKeys, toolCellKey } from '../voxel-tools'

type SourceVoxel = { x: number; y: number; z: number; color: number }
type Face = { orientation: 0 | 1 | 2 | 3 | 4 | 5; plane: number; a: number; b: number; color: number; sortKey: number }

const key = (x: number, y: number, z: number) => `${x},${y},${z}`

function stableHash(voxel: SourceVoxel): number {
  let hash = 2166136261
  hash = Math.imul(hash ^ voxel.x, 16777619)
  hash = Math.imul(hash ^ voxel.y, 16777619)
  hash = Math.imul(hash ^ voxel.z, 16777619)
  return hash >>> 0
}

function boundsOf(voxels: SourceVoxel[]): [number, number, number, number, number, number] {
  const first = voxels[0]
  let minX = first.x
  let minY = first.y
  let minZ = first.z
  let maxX = first.x
  let maxY = first.y
  let maxZ = first.z
  for (let index = 1; index < voxels.length; index += 1) {
    const voxel = voxels[index]
    minX = Math.min(minX, voxel.x)
    minY = Math.min(minY, voxel.y)
    minZ = Math.min(minZ, voxel.z)
    maxX = Math.max(maxX, voxel.x)
    maxY = Math.max(maxY, voxel.y)
    maxZ = Math.max(maxZ, voxel.z)
  }
  return [minX, minY, minZ, maxX, maxY, maxZ]
}

function selectVoxels(all: SourceVoxel[], occupancy: Set<string>, maxVoxels: number, exteriorAir: Set<string> | null, exteriorOnly: boolean): SourceVoxel[] {
  if (!exteriorOnly && all.length <= maxVoxels) return all
  const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const surface = all.filter((voxel) => directions.some(([dx, dy, dz]) => {
    const neighbor = key(voxel.x + dx, voxel.y + dy, voxel.z + dz)
    return !occupancy.has(neighbor) && (exteriorAir === null || exteriorAir.has(neighbor))
  }))
  // The inspector uses exteriorOnly for a fixed camera thumbnail. Feed that
  // path only the external surface cells even when the source is below the
  // sampling limit; otherwise a shell operation changes the preview merely
  // because the hidden interior cell set changed.
  const source = surface.length ? surface : all
  if (source.length <= maxVoxels) return source
  const bounds = boundsOf(all)
  const required = new Map<string, SourceVoxel>()
  const extrema = [
    (voxel: SourceVoxel) => voxel.x === bounds[0],
    (voxel: SourceVoxel) => voxel.x === bounds[3],
    (voxel: SourceVoxel) => voxel.y === bounds[1],
    (voxel: SourceVoxel) => voxel.y === bounds[4],
    (voxel: SourceVoxel) => voxel.z === bounds[2],
    (voxel: SourceVoxel) => voxel.z === bounds[5],
  ]
  extrema.forEach((predicate) => {
    const voxel = source.find(predicate)
    if (voxel) required.set(key(voxel.x, voxel.y, voxel.z), voxel)
  })
  const ranked = source.slice().sort((left, right) => stableHash(left) - stableHash(right) || key(left.x, left.y, left.z).localeCompare(key(right.x, right.y, right.z)))
  const sampled = [...required.values()]
  const sampledKeys = new Set(required.keys())
  for (const voxel of ranked) {
    if (sampled.length >= maxVoxels) break
    const voxelKey = key(voxel.x, voxel.y, voxel.z)
    if (sampledKeys.has(voxelKey)) continue
    sampledKeys.add(voxelKey)
    sampled.push(voxel)
  }
  return sampled
}

function mergeFaces(faces: Face[]): Int32Array {
  const groups = new Map<string, Map<string, Face>>()
  faces.forEach((face) => {
    const groupKey = `${face.orientation}:${face.plane}`
    const group = groups.get(groupKey) ?? new Map<string, Face>()
    group.set(`${face.a},${face.b}`, face)
    groups.set(groupKey, group)
  })
  const rectangles: Array<Face & { width: number; height: number }> = []
  groups.forEach((remaining) => {
    while (remaining.size) {
      const first = remaining.values().next().value as Face
      let width = 1
      while (remaining.get(`${first.a + width},${first.b}`)?.color === first.color) width += 1
      let height = 1
      while (true) {
        let complete = true
        for (let offset = 0; offset < width; offset += 1) {
          if (remaining.get(`${first.a + offset},${first.b + height}`)?.color !== first.color) {
            complete = false
            break
          }
        }
        if (!complete) break
        height += 1
      }
      for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) remaining.delete(`${first.a + column},${first.b + row}`)
      rectangles.push({ ...first, width, height })
    }
  })
  rectangles.sort((left, right) => left.sortKey - right.sortKey)
  const packed = new Int32Array(rectangles.length * 7)
  rectangles.forEach((face, index) => {
    const offset = index * 7
    packed[offset] = face.orientation
    packed[offset + 1] = face.plane
    packed[offset + 2] = face.a
    packed[offset + 3] = face.b
    packed[offset + 4] = face.width
    packed[offset + 5] = face.height
    packed[offset + 6] = face.color
  })
  return packed
}

function buildPreview(request: ScenePreviewWorkerRequest): ScenePreviewWorkerResponse {
  const unique = new Map<string, SourceVoxel>()
  for (let index = 0; index < request.voxels.length; index += 4) {
    const voxel = {
      x: request.voxels[index],
      y: request.voxels[index + 1],
      z: request.voxels[index + 2],
      color: request.voxels[index + 3] >>> 0,
    }
    unique.set(key(voxel.x, voxel.y, voxel.z), voxel)
  }
  const all = [...unique.values()]
  if (!all.length) return { type: 'scene-preview-built', requestId: request.requestId, bounds: new Int32Array(6), faces: new Int32Array(), sourceVoxelCount: 0, sampledVoxelCount: 0 }
  const occupancy = new Set(unique.keys())
  const exteriorAir = request.exteriorOnly ? exteriorAirKeys(all) : null
  const bounds = boundsOf(all)
  const sampled = selectVoxels(all, occupancy, Math.max(1, request.maxVoxels), exteriorAir, Boolean(request.exteriorOnly))
  const sampledKeys = new Set(sampled.map((voxel) => key(voxel.x, voxel.y, voxel.z)))
  const hasVoxel = (x: number, y: number, z: number) => occupancy.has(key(x, y, z))
  const faces: Face[] = []
  sampled.forEach((voxel) => {
    const sortKey = voxel.x + voxel.z + voxel.y * 0.02
    const visibleFace = (x: number, y: number, z: number) => !hasVoxel(x, y, z) && (!request.exteriorOnly || exteriorAir === null || exteriorAir.has(key(x, y, z)))
    if (visibleFace(voxel.x, voxel.y + 1, voxel.z)) faces.push({ orientation: 0, plane: voxel.y + 1, a: voxel.x, b: voxel.z, color: voxel.color, sortKey })
    if (visibleFace(voxel.x + 1, voxel.y, voxel.z)) faces.push({ orientation: 1, plane: voxel.x + 1, a: voxel.z, b: voxel.y, color: voxel.color, sortKey })
    if (visibleFace(voxel.x, voxel.y, voxel.z + 1)) faces.push({ orientation: 2, plane: voxel.z + 1, a: voxel.x, b: voxel.y, color: voxel.color, sortKey })
    if (request.exteriorOnly) return
    if (visibleFace(voxel.x, voxel.y - 1, voxel.z)) faces.push({ orientation: 3, plane: voxel.y, a: voxel.x, b: voxel.z, color: voxel.color, sortKey: sortKey - 0.04 })
    if (visibleFace(voxel.x - 1, voxel.y, voxel.z)) faces.push({ orientation: 4, plane: voxel.x, a: voxel.z, b: voxel.y, color: voxel.color, sortKey: sortKey - 0.02 })
    if (visibleFace(voxel.x, voxel.y, voxel.z - 1)) faces.push({ orientation: 5, plane: voxel.z, a: voxel.x, b: voxel.y, color: voxel.color, sortKey: sortKey - 0.01 })
  })
  // Keep this set alive until face generation completes. It also makes the
  // intended sampling boundary explicit for future progressive LOD passes.
  void sampledKeys
  return { type: 'scene-preview-built', requestId: request.requestId, bounds: new Int32Array(bounds), faces: mergeFaces(faces), sourceVoxelCount: all.length, sampledVoxelCount: sampled.length }
}

self.onmessage = (event: MessageEvent<ScenePreviewWorkerRequest>) => {
  if (event.data.type !== 'build-scene-preview') return
  const response = buildPreview(event.data)
  self.postMessage(response, { transfer: [response.bounds.buffer, response.faces.buffer] })
}

export {}
