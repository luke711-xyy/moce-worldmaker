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

export type OccupancySyncResult = {
  inserted: number
  updated: number
  removed: number
  unchanged: number
}

type RuntimeVoxelBounds = {
  minGx: number
  minGy: number
  minGz: number
  maxGx: number
  maxGy: number
  maxGz: number
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
  // A transform-only drag does not change an owner's topology. Keep the
  // original chunk entries and defer moving those entries until a structural
  // edit or a full synchronization actually requires materialization.
  private readonly ownerTranslations = new Map<number, RuntimeVoxelCoord>()
  private readonly ownerVoxelSets = new Map<number, Set<string>>()
  private readonly ownerBounds = new Map<number, RuntimeVoxelBounds>()
  // The scene-part builder reuses voxel arrays for unchanged owners. Keep the
  // source reference so syncParts can skip the old O(n log n) sorted-key
  // comparison entirely on steady brush frames.
  private readonly ownerVoxelRefs = new Map<string, ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>>()
  private readonly ownerVoxelKeys = new Map<string, string[]>()
  private readonly projectVoxelKeyCache = new WeakMap<object, Set<string>>()
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
    this.ownerTranslations.clear()
    this.ownerVoxelSets.clear()
    this.ownerBounds.clear()
    this.ownerVoxelRefs.clear()
    this.ownerVoxelKeys.clear()
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
    this.ownerVoxelSets.set(ownerHandle, new Set(runtimeVoxels.map(runtimeVoxelKey)))
    const bounds = runtimeVoxelBounds(runtimeVoxels)
    if (bounds) this.ownerBounds.set(ownerHandle, bounds)
    this.ownerTranslations.delete(ownerHandle)
    this.ownerVoxelRefs.set(ownerId, voxels)
    this.ownerVoxelKeys.set(ownerId, this.sortedVoxelKeys(voxels))
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
    this.ownerTranslations.delete(ownerHandle)
    this.ownerVoxelSets.delete(ownerHandle)
    this.ownerBounds.delete(ownerHandle)
    this.ownerVoxelRefs.delete(ownerId)
    this.ownerVoxelKeys.delete(ownerId)
    this.ownerIdToHandle.delete(ownerId)
    this.handleToOwnerId[ownerHandle] = ''
  }

  replaceOwner(ownerId: string, voxels: Voxel[]): void {
    this.removeOwner(ownerId)
    this.insertOwner(ownerId, voxels)
  }

  /**
   * Record a pure owner translation without rebuilding every chunk entry.
   * The chunks continue to hold the original topology, while all queries
   * account for this transform until a later sync replaces the owner.
   */
  translateOwner(ownerId: string, delta: Pick<Voxel, 'x' | 'y' | 'z'>): void {
    const ownerHandle = this.ownerIdToHandle.get(ownerId)
    if (!ownerHandle || (!delta.x && !delta.y && !delta.z)) return
    const runtimeDelta = projectVoxelToRuntime(delta)
    const current = this.ownerTranslations.get(ownerHandle) ?? { gx: 0, gy: 0, gz: 0 }
    this.ownerTranslations.set(ownerHandle, {
      gx: current.gx + runtimeDelta.gx,
      gy: current.gy + runtimeDelta.gy,
      gz: current.gz + runtimeDelta.gz,
    })
  }

  syncParts(parts: SceneEntityPart[]): OccupancySyncResult {
    const incoming = new Map(parts.map((part) => [part.id, part.voxels]))
    const result: OccupancySyncResult = { inserted: 0, updated: 0, removed: 0, unchanged: 0 }
    for (const ownerId of [...this.ownerIdToHandle.keys()]) {
      if (incoming.has(ownerId)) continue
      this.removeOwner(ownerId)
      result.removed += 1
    }
    incoming.forEach((voxels, ownerId) => {
      const existingKeys = this.ownerVoxelKeys.get(ownerId)
      if (!existingKeys) {
        this.insertOwner(ownerId, voxels)
        result.inserted += 1
        return
      }
      if (this.ownerVoxelRefs.get(ownerId) === voxels) {
        result.unchanged += 1
        return
      }
      const nextKeys = this.sortedVoxelKeys(voxels)
      const unchanged = existingKeys.length === nextKeys.length && existingKeys.every((key, index) => key === nextKeys[index])
      if (unchanged) {
        result.unchanged += 1
        return
      }
      this.replaceOwner(ownerId, voxels)
      result.updated += 1
    })
    return result
  }

  queryProjectVoxel(voxel: Pick<Voxel, 'x' | 'y' | 'z'>): OccupancyHit {
    return this.queryRuntimeVoxel(projectVoxelToRuntime(voxel))
  }

  queryRuntimeVoxel(voxel: RuntimeVoxelCoord): OccupancyHit {
    const { chunkKey, localIndex } = runtimeVoxelAddress(voxel)
    const chunk = this.chunks.get(chunkKey)
    if (!this.ownerTranslations.size) {
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
    const handles = new Set<number>()
    if (chunk) {
      const { wordIndex, bitMask } = bitAddress(localIndex)
      if ((chunk.occupancyBits[wordIndex] & bitMask) !== 0) {
        const primaryOwner = chunk.ownerIds[localIndex]
        if (primaryOwner && !this.ownerTranslations.has(primaryOwner)) handles.add(primaryOwner)
        chunk.overflowOwners.get(localIndex)?.forEach((owner) => {
          if (!this.ownerTranslations.has(owner)) handles.add(owner)
        })
      }
    }
    // A lazily translated owner still has stale entries in its old chunks.
    // Ignore those entries above and resolve the owner at its translated
    // coordinate using a bounds check plus a constant-time voxel-set lookup.
    // The common case has no lazy owners, so keep this branch completely out
    // of the hot query path.
    if (this.ownerTranslations.size) {
      this.ownerTranslations.forEach((translation, ownerHandle) => {
        const bounds = this.ownerBounds.get(ownerHandle)
        const local = {
          gx: voxel.gx - translation.gx,
          gy: voxel.gy - translation.gy,
          gz: voxel.gz - translation.gz,
        }
        if (!bounds || local.gx < bounds.minGx || local.gx > bounds.maxGx || local.gy < bounds.minGy || local.gy > bounds.maxGy || local.gz < bounds.minGz || local.gz > bounds.maxGz) return
        if (this.ownerVoxelSets.get(ownerHandle)?.has(runtimeVoxelKey(local))) handles.add(ownerHandle)
      })
    }
    if (!handles.size) return { occupied: false, ownerIds: [] }
    return {
      occupied: true,
      ownerIds: [...handles].map((handle) => this.handleToOwnerId[handle]).filter(Boolean),
    }
  }

  collidesProjectVoxels(
    voxels: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>,
    excludedOwnerIds: Iterable<string> = [],
  ): boolean {
    const excluded = new Set(excludedOwnerIds)
    return voxels.some((voxel) => {
      const hit = this.queryProjectVoxel(voxel)
      return hit.ownerIds.some((ownerId) => !excluded.has(ownerId))
    })
  }

  collidesTranslatedProjectVoxels(
    voxels: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>,
    delta: Pick<Voxel, 'x' | 'y' | 'z'>,
    excludedOwnerIds: Iterable<string> = [],
  ): boolean {
    const runtimeDelta = projectVoxelToRuntime(delta)
    const excluded = new Set(excludedOwnerIds)

    // Dragging a dense imported model used to scan every moving voxel on
    // every pointer event. For large selections, inspect the usually much
    // smaller set of stationary voxels instead: a collision exists exactly
    // when a stationary voxel, shifted backwards by the requested delta,
    // belongs to the moving voxel set. This preserves exact voxel collision
    // semantics while avoiding an O(large-model) scan during a drag.
    if (excluded.size && voxels.length >= 4096) {
      let stationaryVoxelCount = 0
      for (const [ownerId, ownerVoxels] of this.ownerVoxelRefs) {
        if (!excluded.has(ownerId)) stationaryVoxelCount += ownerVoxels.length
      }
      if (stationaryVoxelCount < voxels.length) {
        if (!stationaryVoxelCount) return false
        const cacheKey = voxels as object
        const movingKeys = this.projectVoxelKeyCache.get(cacheKey) ?? new Set(voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
        this.projectVoxelKeyCache.set(cacheKey, movingKeys)
        for (const [ownerId, ownerVoxels] of this.ownerVoxelRefs) {
          if (excluded.has(ownerId)) continue
          const ownerHandle = this.ownerIdToHandle.get(ownerId)
          const translation = ownerHandle ? this.ownerTranslations.get(ownerHandle) : undefined
          for (const voxel of ownerVoxels) {
            const currentX = voxel.x + (translation?.gx ?? 0)
            const currentY = voxel.y + (translation?.gz ?? 0)
            const currentZ = voxel.z + (translation?.gy ?? 0)
            if (movingKeys.has(`${currentX - delta.x},${currentY - delta.y},${currentZ - delta.z}`)) return true
          }
        }
        return false
      }
    }

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

  private sortedVoxelKeys(voxels: Array<Pick<Voxel, 'x' | 'y' | 'z'>>): string[] {
    return voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`).sort()
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

function runtimeVoxelKey(voxel: RuntimeVoxelCoord): string {
  return `${voxel.gx},${voxel.gy},${voxel.gz}`
}

function runtimeVoxelBounds(voxels: RuntimeVoxelCoord[]): RuntimeVoxelBounds | undefined {
  if (!voxels.length) return undefined
  return voxels.reduce((bounds, voxel) => ({
    minGx: Math.min(bounds.minGx, voxel.gx),
    minGy: Math.min(bounds.minGy, voxel.gy),
    minGz: Math.min(bounds.minGz, voxel.gz),
    maxGx: Math.max(bounds.maxGx, voxel.gx),
    maxGy: Math.max(bounds.maxGy, voxel.gy),
    maxGz: Math.max(bounds.maxGz, voxel.gz),
  }), {
    minGx: voxels[0].gx,
    minGy: voxels[0].gy,
    minGz: voxels[0].gz,
    maxGx: voxels[0].gx,
    maxGy: voxels[0].gy,
    maxGz: voxels[0].gz,
  })
}
