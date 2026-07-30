import { SceneEntityPart, Voxel } from '../voxel'
import {
  projectVoxelToRuntime,
  RUNTIME_CHUNK_VOLUME,
  RUNTIME_OCCUPANCY_WORDS,
  runtimeVoxelAddress,
  RuntimeVoxelCoord,
  translateRuntimeVoxel,
} from './runtime-coordinates'

export type RuntimeChunk = {
  key: string
  occupancyBits: Uint32Array
  materialIds: Uint8Array
  ownerIds: Uint32Array
  overflowOwners: Map<number, Set<number>>
  dataRevision: number
}

export type OccupancyHit = {
  occupied: boolean
  ownerIds: string[]
}

function bitAddress(localIndex: number): { wordIndex: number; bitMask: number } {
  return {
    wordIndex: localIndex >>> 5,
    bitMask: 1 << (localIndex & 31),
  }
}

function createRuntimeChunk(key: string): RuntimeChunk {
  return {
    key,
    occupancyBits: new Uint32Array(RUNTIME_OCCUPANCY_WORDS),
    materialIds: new Uint8Array(RUNTIME_CHUNK_VOLUME),
    ownerIds: new Uint32Array(RUNTIME_CHUNK_VOLUME),
    overflowOwners: new Map(),
    dataRevision: 0,
  }
}

export class SceneOccupancyIndex {
  readonly chunks = new Map<string, RuntimeChunk>()

  private readonly ownerIdToHandle = new Map<string, number>()
  private readonly handleToOwnerId: string[] = ['']
  private readonly ownerVoxels = new Map<number, RuntimeVoxelCoord[]>()
  private readonly materialIdToIndex = new Map<string, number>()
  private nextMaterialIndex = 1

  static fromParts(parts: SceneEntityPart[]): SceneOccupancyIndex {
    const index = new SceneOccupancyIndex()
    parts.forEach((part) => index.insertOwner(part.id, part.voxels))
    return index
  }

  clear(): void {
    this.chunks.clear()
    this.ownerIdToHandle.clear()
    this.handleToOwnerId.splice(1)
    this.ownerVoxels.clear()
    this.materialIdToIndex.clear()
    this.nextMaterialIndex = 1
  }

  hasOwner(ownerId: string): boolean {
    return this.ownerIdToHandle.has(ownerId)
  }

  insertOwner(ownerId: string, voxels: Voxel[]): void {
    if (this.ownerIdToHandle.has(ownerId)) this.removeOwner(ownerId)
    const ownerHandle = this.registerOwner(ownerId)
    const runtimeVoxels = voxels.map(projectVoxelToRuntime)
    this.ownerVoxels.set(ownerHandle, runtimeVoxels)
    voxels.forEach((voxel, index) => {
      const runtimeVoxel = runtimeVoxels[index]
      const { chunkKey, localIndex } = runtimeVoxelAddress(runtimeVoxel)
      const chunk = this.chunks.get(chunkKey) ?? createRuntimeChunk(chunkKey)
      if (!this.chunks.has(chunkKey)) this.chunks.set(chunkKey, chunk)
      const { wordIndex, bitMask } = bitAddress(localIndex)
      const primaryOwner = chunk.ownerIds[localIndex]
      if (primaryOwner && primaryOwner !== ownerHandle) {
        const owners = chunk.overflowOwners.get(localIndex) ?? new Set<number>()
        owners.add(ownerHandle)
        chunk.overflowOwners.set(localIndex, owners)
      } else {
        chunk.ownerIds[localIndex] = ownerHandle
      }
      chunk.occupancyBits[wordIndex] |= bitMask
      chunk.materialIds[localIndex] = this.materialIndex(voxel.materialId)
      chunk.dataRevision += 1
    })
  }

  removeOwner(ownerId: string): void {
    const ownerHandle = this.ownerIdToHandle.get(ownerId)
    if (!ownerHandle) return
    for (const voxel of this.ownerVoxels.get(ownerHandle) ?? []) {
      const { chunkKey, localIndex } = runtimeVoxelAddress(voxel)
      const chunk = this.chunks.get(chunkKey)
      if (!chunk) continue
      const primaryOwner = chunk.ownerIds[localIndex]
      const overflowOwners = chunk.overflowOwners.get(localIndex)
      if (primaryOwner === ownerHandle) {
        const promotedOwner = overflowOwners?.values().next().value as number | undefined
        if (promotedOwner) {
          chunk.ownerIds[localIndex] = promotedOwner
          overflowOwners!.delete(promotedOwner)
          if (!overflowOwners!.size) chunk.overflowOwners.delete(localIndex)
        } else {
          chunk.ownerIds[localIndex] = 0
          chunk.materialIds[localIndex] = 0
          const { wordIndex, bitMask } = bitAddress(localIndex)
          chunk.occupancyBits[wordIndex] &= ~bitMask
        }
      } else if (overflowOwners?.delete(ownerHandle) && !overflowOwners.size) {
        chunk.overflowOwners.delete(localIndex)
      }
      chunk.dataRevision += 1
      if (!chunk.ownerIds.some(Boolean) && !chunk.overflowOwners.size) this.chunks.delete(chunkKey)
    }
    this.ownerVoxels.delete(ownerHandle)
    this.ownerIdToHandle.delete(ownerId)
    this.handleToOwnerId[ownerHandle] = ''
  }

  replaceOwner(ownerId: string, voxels: Voxel[]): void {
    this.removeOwner(ownerId)
    this.insertOwner(ownerId, voxels)
  }

  queryProjectVoxel(voxel: Pick<Voxel, 'x' | 'y' | 'z'>): OccupancyHit {
    return this.queryRuntimeVoxel(projectVoxelToRuntime(voxel))
  }

  queryRuntimeVoxel(voxel: RuntimeVoxelCoord): OccupancyHit {
    const { chunkKey, localIndex } = runtimeVoxelAddress(voxel)
    const chunk = this.chunks.get(chunkKey)
    if (!chunk) return { occupied: false, ownerIds: [] }
    const { wordIndex, bitMask } = bitAddress(localIndex)
    if ((chunk.occupancyBits[wordIndex] & bitMask) === 0) return { occupied: false, ownerIds: [] }
    const handles = new Set<number>()
    const primaryOwner = chunk.ownerIds[localIndex]
    if (primaryOwner) handles.add(primaryOwner)
    chunk.overflowOwners.get(localIndex)?.forEach((owner) => handles.add(owner))
    return {
      occupied: handles.size > 0,
      ownerIds: [...handles].map((handle) => this.handleToOwnerId[handle]).filter(Boolean),
    }
  }

  collidesProjectVoxels(
    voxels: Array<Pick<Voxel, 'x' | 'y' | 'z'>>,
    excludedOwnerIds: Iterable<string> = [],
  ): boolean {
    const excluded = new Set(excludedOwnerIds)
    return voxels.some((voxel) => {
      const hit = this.queryProjectVoxel(voxel)
      return hit.ownerIds.some((ownerId) => !excluded.has(ownerId))
    })
  }

  collidesTranslatedProjectVoxels(
    voxels: Array<Pick<Voxel, 'x' | 'y' | 'z'>>,
    delta: Pick<Voxel, 'x' | 'y' | 'z'>,
    excludedOwnerIds: Iterable<string> = [],
  ): boolean {
    const runtimeDelta = projectVoxelToRuntime(delta)
    const excluded = new Set(excludedOwnerIds)
    return voxels.some((voxel) => {
      const translated = translateRuntimeVoxel(projectVoxelToRuntime(voxel), runtimeDelta)
      const hit = this.queryRuntimeVoxel(translated)
      return hit.ownerIds.some((ownerId) => !excluded.has(ownerId))
    })
  }

  private registerOwner(ownerId: string): number {
    const existing = this.ownerIdToHandle.get(ownerId)
    if (existing) return existing
    const handle = this.handleToOwnerId.length
    this.ownerIdToHandle.set(ownerId, handle)
    this.handleToOwnerId.push(ownerId)
    return handle
  }

  private materialIndex(materialId: string): number {
    const existing = this.materialIdToIndex.get(materialId)
    if (existing) return existing
    const index = this.nextMaterialIndex
    this.nextMaterialIndex = this.nextMaterialIndex >= 255 ? 1 : this.nextMaterialIndex + 1
    this.materialIdToIndex.set(materialId, index)
    return index
  }
}
