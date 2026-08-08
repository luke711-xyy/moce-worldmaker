import { makePlaneVoxel, rasterizeAnchoredSphere, rasterizeCuboid, rasterizeExtrude, rasterizeLine } from '../voxel-tools'
import { buildGreedyMesh } from '../runtime/greedy-mesher'
import { computeScale, computeShell, validShellThicknesses, VoxelGeometryMesh, VoxelGeometryPreview } from '../voxel-geometry'
import type { VoxelToolsGeometryRequest, VoxelToolsShapeRequest, VoxelToolsShellOptionsRequest } from '../runtime/voxel-tools-client'

type WorkerRequest = { id: number; request: VoxelToolsShapeRequest | VoxelToolsGeometryRequest | VoxelToolsShellOptionsRequest }

// The source slice is immutable during a drag. Keeping it in the worker turns
// every subsequent pointer sample into a small request containing only the
// selected axis and distance. This is especially important for imported
// models where a single layer can contain tens of thousands of cells.
const extrudeSources = new Map<string, {
  source: import('../voxel').Voxel[]
  lastKey?: string
  lastVoxels?: import('../voxel').Voxel[]
}>()

const voxelColorKey = (voxel: { materialId: string; paintMaterialId?: string }) => voxel.paintMaterialId ?? voxel.materialId

function buildGeometryPreviewMesh(preview: VoxelGeometryPreview): VoxelGeometryMesh | null {
  if (!preview.voxels.length || !preview.bounds) return null
  const { minX, minY, minZ } = preview.bounds
  const materialKeys: string[] = []
  const materialIds = new Map<string, number>()
  const mesherVoxels = preview.voxels.map((voxel) => {
    const materialKey = voxelColorKey(voxel)
    let materialId = materialIds.get(materialKey)
    if (materialId === undefined) {
      materialId = materialKeys.length
      materialIds.set(materialKey, materialId)
      materialKeys.push(materialKey)
    }
    // The renderer's world axes are X, storage Z, storage Y. Keep the same
    // mapping as the normal scene greedy-mesh path.
    return { gx: voxel.x - minX, gy: voxel.z - minZ, gz: voxel.y - minY, materialId }
  })
  const mesh = buildGreedyMesh(mesherVoxels)
  return { ...mesh, materialKeys, minX, minY, minZ }
}

function buildShapePreviewMesh(voxels: import('../voxel').Voxel[]): VoxelGeometryMesh | null {
  if (!voxels.length) return null
  const bounds = voxels.reduce((result, voxel) => ({
    minX: Math.min(result.minX, voxel.x),
    minY: Math.min(result.minY, voxel.y),
    minZ: Math.min(result.minZ, voxel.z),
    maxX: Math.max(result.maxX, voxel.x),
    maxY: Math.max(result.maxY, voxel.y),
    maxZ: Math.max(result.maxZ, voxel.z),
  }), { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity })
  const materialKeys: string[] = []
  const materialIds = new Map<string, number>()
  const mesherVoxels = voxels.map((voxel) => {
    const materialKey = voxelColorKey(voxel)
    let materialId = materialIds.get(materialKey)
    if (materialId === undefined) {
      materialId = materialKeys.length
      materialIds.set(materialKey, materialId)
      materialKeys.push(materialKey)
    }
    return { gx: voxel.x - bounds.minX, gy: voxel.z - bounds.minZ, gz: voxel.y - bounds.minY, materialId }
  })
  const mesh = buildGreedyMesh(mesherVoxels)
  return { ...mesh, materialKeys, minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data as WorkerRequest & { type?: string; sessionId?: string }
  if (message.type === 'dispose-extrude-source') {
    if (message.sessionId) extrudeSources.delete(message.sessionId)
    return
  }
  const { id, request } = message
  try {
    if (request.kind === 'shell') {
      const geometry = computeShell(request.voxels, request.thickness)
      const mesh = buildGeometryPreviewMesh(geometry)
      self.postMessage({ id, geometry, mesh }, mesh ? [mesh.positions.buffer, mesh.normals.buffer, mesh.materialIds.buffer, mesh.indices.buffer] : [])
      return
    }
    if (request.kind === 'scale') {
      const geometry = computeScale(request.voxels, request.mode, request.factor)
      const mesh = buildGeometryPreviewMesh(geometry)
      self.postMessage({ id, geometry, mesh }, mesh ? [mesh.positions.buffer, mesh.normals.buffer, mesh.materialIds.buffer, mesh.indices.buffer] : [])
      return
    }
    if (request.kind === 'shell-options') {
      self.postMessage({ id, shellThicknesses: validShellThicknesses(request.voxels) })
      return
    }
    let voxels
    if (request.kind === 'line') {
      voxels = rasterizeLine(request.plane, request.start, request.current, request.brushSize, request.materialId)
    } else if (request.kind === 'cuboid') {
      const end = request.footprintEnd ?? request.current
      voxels = rasterizeCuboid(request.plane, request.start, end, request.start.layer, request.current.layer, request.materialId)
    } else if (request.kind === 'sphere') {
      voxels = rasterizeAnchoredSphere(request.plane, request.start, request.current, request.baseHeight, request.materialId)
    } else {
      const delta = request.extrudeDelta ?? request.current.layer - request.start.layer
      if (request.extrudeSessionId && request.source) extrudeSources.set(request.extrudeSessionId, { source: request.source })
      const session = request.extrudeSessionId ? extrudeSources.get(request.extrudeSessionId) : undefined
      const source = request.source ?? session?.source ?? []
      const cacheKey = `${request.extrudeAxis ?? 'plane'}:${request.extrudeStartLayer ?? request.start.layer}:${delta}:${request.materialId}:${request.operation ?? 'add'}`
      if (session?.lastKey === cacheKey && session.lastVoxels) voxels = session.lastVoxels
      else {
        voxels = rasterizeExtrude(request.plane, source, request.extrudeStartLayer ?? request.start.layer, delta, request.extrudeAxis, request.materialId, request.operation)
        if (session) {
          session.lastKey = cacheKey
          session.lastVoxels = voxels
        }
      }
    }
    const mesh = request.kind === 'extrude' && request.includeVoxels === false ? buildShapePreviewMesh(voxels) : null
    const response = request.kind === 'extrude' && request.includeVoxels === false
      ? { id, voxels: undefined, mesh }
      : { id, voxels, mesh: null }
    self.postMessage(response, mesh ? [mesh.positions.buffer, mesh.normals.buffer, mesh.materialIds.buffer, mesh.indices.buffer] : [])
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : '体素工具 Worker 执行失败' })
  }
}
