import { Voxel } from '../voxel'

export const RUNTIME_CHUNK_SIZE = 32
export const RUNTIME_CHUNK_VOLUME = RUNTIME_CHUNK_SIZE ** 3
export const RUNTIME_OCCUPANCY_WORDS = RUNTIME_CHUNK_VOLUME / 32

export type RuntimeVoxelCoord = {
  gx: number
  gy: number
  gz: number
}

export type RuntimeVoxel = RuntimeVoxelCoord & {
  materialId: string
  entityId?: string
}

export type RuntimeChunkCoord = {
  cx: number
  cy: number
  cz: number
}

export type RuntimeLocalCoord = {
  lx: number
  ly: number
  lz: number
}

/**
 * Project files historically store X/Z on the ground plane and Y as height.
 * Runtime code uses the editor-facing X/Y ground plane with Z as height.
 */
export function projectVoxelToRuntime(voxel: Pick<Voxel, 'x' | 'y' | 'z'>): RuntimeVoxelCoord {
  return { gx: voxel.x, gy: voxel.z, gz: voxel.y }
}

export function runtimeVoxelToProject(voxel: RuntimeVoxelCoord, materialId: string, entityId?: string): Voxel {
  return {
    x: voxel.gx,
    y: voxel.gz,
    z: voxel.gy,
    materialId,
    ...(entityId ? { entityId } : {}),
  }
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor)
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

export function runtimeChunkCoord(voxel: RuntimeVoxelCoord): RuntimeChunkCoord {
  return {
    cx: floorDiv(voxel.gx, RUNTIME_CHUNK_SIZE),
    cy: floorDiv(voxel.gy, RUNTIME_CHUNK_SIZE),
    cz: floorDiv(voxel.gz, RUNTIME_CHUNK_SIZE),
  }
}

export function runtimeLocalCoord(voxel: RuntimeVoxelCoord): RuntimeLocalCoord {
  return {
    lx: positiveModulo(voxel.gx, RUNTIME_CHUNK_SIZE),
    ly: positiveModulo(voxel.gy, RUNTIME_CHUNK_SIZE),
    lz: positiveModulo(voxel.gz, RUNTIME_CHUNK_SIZE),
  }
}

export function runtimeChunkKey(coord: RuntimeChunkCoord): string {
  return `${coord.cx},${coord.cy},${coord.cz}`
}

export function runtimeLocalIndex(coord: RuntimeLocalCoord): number {
  return coord.lx | (coord.ly << 5) | (coord.lz << 10)
}

export function runtimeVoxelAddress(voxel: RuntimeVoxelCoord): { chunkKey: string; localIndex: number } {
  return {
    chunkKey: runtimeChunkKey(runtimeChunkCoord(voxel)),
    localIndex: runtimeLocalIndex(runtimeLocalCoord(voxel)),
  }
}

export function translateRuntimeVoxel(voxel: RuntimeVoxelCoord, delta: RuntimeVoxelCoord): RuntimeVoxelCoord {
  return {
    gx: voxel.gx + delta.gx,
    gy: voxel.gy + delta.gy,
    gz: voxel.gz + delta.gz,
  }
}
