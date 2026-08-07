import { makePlaneVoxel, rasterizeAnchoredSphere, rasterizeCuboid, rasterizeExtrude, rasterizeLine } from '../voxel-tools'
import { buildGreedyMesh } from '../runtime/greedy-mesher'
import { computeScale, computeShell, VoxelGeometryMesh, VoxelGeometryPreview } from '../voxel-geometry'
import type { VoxelToolsGeometryRequest, VoxelToolsShapeRequest } from '../runtime/voxel-tools-client'

type WorkerRequest = { id: number; request: VoxelToolsShapeRequest | VoxelToolsGeometryRequest }

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

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, request } = event.data
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
      voxels = rasterizeExtrude(request.plane, request.source ?? [], request.extrudeStartLayer ?? request.start.layer, delta, request.extrudeAxis, request.materialId, request.operation)
    }
    self.postMessage({ id, voxels })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : '体素工具 Worker 执行失败' })
  }
}
