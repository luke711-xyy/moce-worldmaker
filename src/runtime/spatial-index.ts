import { SceneEntityPart, Voxel, scenePartVoxels } from '../voxel'
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

export type ProjectVoxelRegion = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

type RuntimeVoxelBounds = {
  minGx: number
  minGy: number
  minGz: number
  maxGx: number
  maxGy: number
  maxGz: number
}

function projectVoxelBounds(voxels: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>): RuntimeVoxelBounds | undefined {
  if (!voxels.length) return undefined
  const first = voxels[0]
  const bounds: RuntimeVoxelBounds = {
    minGx: first.x,
    minGy: first.z,
    minGz: first.y,
    maxGx: first.x,
    maxGy: first.z,
    maxGz: first.y,
  }
  for (let index = 1; index < voxels.length; index += 1) {
    const voxel = voxels[index]
    bounds.minGx = Math.min(bounds.minGx, voxel.x)
    bounds.minGy = Math.min(bounds.minGy, voxel.z)
    bounds.minGz = Math.min(bounds.minGz, voxel.y)
    bounds.maxGx = Math.max(bounds.maxGx, voxel.x)
    bounds.maxGy = Math.max(bounds.maxGy, voxel.z)
    bounds.maxGz = Math.max(bounds.maxGz, voxel.y)
  }
  return bounds
}

function scenePartOffset(part: Pick<SceneEntityPart, 'sceneOffset' | 'partSceneOffset'>): { x: number; y: number; z: number } {
  return {
    x: (part.sceneOffset?.x ?? 0) + (part.partSceneOffset?.x ?? 0),
    y: (part.sceneOffset?.y ?? 0) + (part.partSceneOffset?.y ?? 0),
    z: (part.sceneOffset?.z ?? 0) + (part.partSceneOffset?.z ?? 0),
  }
}

function boundsOverlap(owner: RuntimeVoxelBounds, target: RuntimeVoxelBounds, translation?: RuntimeVoxelCoord): boolean {
  const offsetX = translation?.gx ?? 0
  const offsetY = translation?.gy ?? 0
  const offsetZ = translation?.gz ?? 0
  return owner.minGx + offsetX <= target.maxGx && owner.maxGx + offsetX >= target.minGx
    && owner.minGy + offsetY <= target.maxGy && owner.maxGy + offsetY >= target.minGy
    && owner.minGz + offsetZ <= target.maxGz && owner.maxGz + offsetZ >= target.minGz
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
  // Keep canonical topology and scene translation separate. A transform-only
  // sync can then update one offset instead of expanding and sorting every
  // voxel in a large entity.
  private readonly ownerSourceRefs = new Map<string, ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>>()
  private readonly ownerBaseOffsets = new Map<string, RuntimeVoxelCoord>()
  private readonly projectVoxelKeyCache = new WeakMap<object, Set<string>>()
  private readonly projectVoxelBoundsCache = new WeakMap<object, RuntimeVoxelBounds>()
  private readonly materialIdToIndex = new Map<string, number>()
  private nextMaterialIndex = 1

  static fromParts(parts: SceneEntityPart[]): SceneOccupancyIndex {
    const index = new SceneOccupancyIndex()
    parts.forEach((part) => index.insertPart(part))
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
    this.ownerSourceRefs.clear()
    this.ownerBaseOffsets.clear()
    this.materialIdToIndex.clear()
    this.nextMaterialIndex = 1
  }

  hasOwner(ownerId: string): boolean {
    return this.ownerIdToHandle.has(ownerId)
  }

  insertOwner(
    ownerId: string,
    voxels: Voxel[],
    sourceVoxels: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>> = voxels,
    baseOffset: Pick<Voxel, 'x' | 'y' | 'z'> = { x: 0, y: 0, z: 0 },
  ): void {
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
    this.ownerSourceRefs.set(ownerId, sourceVoxels)
    this.ownerBaseOffsets.set(ownerId, projectVoxelToRuntime(baseOffset))
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
    this.ownerSourceRefs.delete(ownerId)
    this.ownerBaseOffsets.delete(ownerId)
    this.ownerIdToHandle.delete(ownerId)
    this.handleToOwnerId[ownerHandle] = ''
  }

  replaceOwner(
    ownerId: string,
    voxels: Voxel[],
    sourceVoxels: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>> = voxels,
    baseOffset: Pick<Voxel, 'x' | 'y' | 'z'> = { x: 0, y: 0, z: 0 },
  ): void {
    this.removeOwner(ownerId)
    this.insertOwner(ownerId, voxels, sourceVoxels, baseOffset)
  }

  private insertPart(part: SceneEntityPart): void {
    const offset = scenePartOffset(part)
    this.insertOwner(part.id, scenePartVoxels(part), part.voxels, offset)
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
    const result: OccupancySyncResult = { inserted: 0, updated: 0, removed: 0, unchanged: 0 }
    const incomingIds = new Set(parts.map((part) => part.id))
    for (const ownerId of [...this.ownerIdToHandle.keys()]) {
      if (incomingIds.has(ownerId)) continue
      this.removeOwner(ownerId)
      result.removed += 1
    }
    parts.forEach((part) => {
      const ownerId = part.id
      const existingKeys = this.ownerVoxelKeys.get(ownerId)
      if (!existingKeys) {
        this.insertPart(part)
        result.inserted += 1
        return
      }
      const ownerHandle = this.ownerIdToHandle.get(ownerId)
      const sourceVoxels = this.ownerSourceRefs.get(ownerId)
      if (ownerHandle !== undefined && sourceVoxels === part.voxels) {
        // Project updates preserve the canonical voxel array for pure moves
        // and part offsets. Keep the chunks at their base position and make
        // queries use the current absolute translation instead. This path is
        // O(1), including when the entity contains hundreds of thousands of
        // voxels.
        const currentOffset = projectVoxelToRuntime(scenePartOffset(part))
        const baseOffset = this.ownerBaseOffsets.get(ownerId) ?? { gx: 0, gy: 0, gz: 0 }
        const translation = {
          gx: currentOffset.gx - baseOffset.gx,
          gy: currentOffset.gy - baseOffset.gy,
          gz: currentOffset.gz - baseOffset.gz,
        }
        if (translation.gx || translation.gy || translation.gz) this.ownerTranslations.set(ownerHandle, translation)
        else this.ownerTranslations.delete(ownerHandle)
        result.unchanged += 1
        return
      }
      const voxels = scenePartVoxels(part)
      const lazyTranslation = ownerHandle ? this.ownerTranslations.get(ownerHandle) : undefined
      if (ownerHandle !== undefined && lazyTranslation) {
        // Undo can restore a freshly cloned project snapshot. When its
        // absolute coordinates match the stored base topology, clear the
        // pending translation without rebuilding chunks.
        const nextKeys = this.sortedVoxelKeys(voxels)
        const isOriginalTopology = existingKeys.length === nextKeys.length && existingKeys.every((key, index) => key === nextKeys[index])
        if (isOriginalTopology) {
          this.ownerTranslations.delete(ownerHandle)
          this.ownerVoxelRefs.set(ownerId, voxels)
          this.ownerVoxelKeys.set(ownerId, nextKeys)
          this.ownerSourceRefs.set(ownerId, part.voxels)
          this.ownerBaseOffsets.set(ownerId, projectVoxelToRuntime(scenePartOffset(part)))
          result.unchanged += 1
          return
        }
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
      this.replaceOwner(ownerId, voxels, part.voxels, scenePartOffset(part))
      result.updated += 1
    })
    return result
  }

  queryProjectVoxel(voxel: Pick<Voxel, 'x' | 'y' | 'z'>): OccupancyHit {
    return this.queryRuntimeVoxel(projectVoxelToRuntime(voxel))
  }

  /**
   * Enumerate only the occupied project cells inside a small integer region.
   *
   * Tools such as quick erase need owner information around the pointer, not
   * a flattened copy of every scene voxel. Walking the region through the
   * chunk-backed query keeps the work proportional to the brush volume and
   * also accounts for lazy owner translations created by entity dragging.
   */
  collectProjectVoxelsInRegion(region: ProjectVoxelRegion): Map<string, Array<Pick<Voxel, 'x' | 'y' | 'z'>>> {
    const result = new Map<string, Array<Pick<Voxel, 'x' | 'y' | 'z'>>>()
    const minX = Math.ceil(Math.min(region.minX, region.maxX))
    const maxX = Math.floor(Math.max(region.minX, region.maxX))
    const minY = Math.ceil(Math.min(region.minY, region.maxY))
    const maxY = Math.floor(Math.max(region.minY, region.maxY))
    const minZ = Math.ceil(Math.min(region.minZ, region.maxZ))
    const maxZ = Math.floor(Math.max(region.minZ, region.maxZ))
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const ownerIds = this.queryProjectVoxel({ x, y, z }).ownerIds
          if (!ownerIds.length) continue
          const point = { x, y, z }
          ownerIds.forEach((ownerId) => {
            const cells = result.get(ownerId)
            if (cells) cells.push(point)
            else result.set(ownerId, [point])
          })
        }
      }
    }
    return result
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

    // First use owner AABBs as a broad phase. A large imported model often
    // has only a handful of nearby stationary owners; scanning all of its
    // voxels for every pointermove is unnecessary when their bounds do not
    // overlap. The narrow phase below remains exact at voxel resolution.
    if (excluded.size) {
      const cacheKey = voxels as object
      let movingBounds = this.projectVoxelBoundsCache.get(cacheKey)
      if (!movingBounds) {
        movingBounds = projectVoxelBounds(voxels)
        if (movingBounds) this.projectVoxelBoundsCache.set(cacheKey, movingBounds)
      }
      if (!movingBounds) return false
      const translatedMovingBounds: RuntimeVoxelBounds = {
        minGx: movingBounds.minGx + runtimeDelta.gx,
        minGy: movingBounds.minGy + runtimeDelta.gy,
        minGz: movingBounds.minGz + runtimeDelta.gz,
        maxGx: movingBounds.maxGx + runtimeDelta.gx,
        maxGy: movingBounds.maxGy + runtimeDelta.gy,
        maxGz: movingBounds.maxGz + runtimeDelta.gz,
      }
      const candidates: Array<[ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>, RuntimeVoxelCoord | undefined]> = []
      for (const [ownerId, ownerVoxels] of this.ownerVoxelRefs) {
        if (excluded.has(ownerId)) continue
        const ownerHandle = this.ownerIdToHandle.get(ownerId)
        const translation = ownerHandle ? this.ownerTranslations.get(ownerHandle) : undefined
        const bounds = ownerHandle ? this.ownerBounds.get(ownerHandle) : undefined
        if (!bounds || !boundsOverlap(bounds, translatedMovingBounds, translation)) continue
        candidates.push([ownerVoxels, translation])
      }
      if (!candidates.length) return false
      const movingKeys = this.projectVoxelKeyCache.get(cacheKey) ?? new Set(voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
      this.projectVoxelKeyCache.set(cacheKey, movingKeys)
      for (const [ownerVoxels, translation] of candidates) {
        for (const voxel of ownerVoxels) {
          const currentX = voxel.x + (translation?.gx ?? 0)
          const currentY = voxel.y + (translation?.gz ?? 0)
          const currentZ = voxel.z + (translation?.gy ?? 0)
          if (movingKeys.has(`${currentX - delta.x},${currentY - delta.y},${currentZ - delta.z}`)) return true
        }
      }
      return false
    }

    return voxels.some((voxel) => {
      const translated = translateRuntimeVoxel(projectVoxelToRuntime(voxel), runtimeDelta)
      const hit = this.queryRuntimeVoxel(translated)
      return hit.ownerIds.some((ownerId) => !excluded.has(ownerId))
    })
  }

  /**
   * Collision check for scene parts whose topology is stored in canonical
   * coordinates and whose scene translation is kept on the part metadata.
   * This avoids scenePartVoxels() allocating a second array for every cell of
   * a large entity merely to test a drag preview.
   */
  collidesTranslatedSceneParts(
    parts: ReadonlyArray<SceneEntityPart>,
    delta: Pick<Voxel, 'x' | 'y' | 'z'>,
    excludedOwnerIds: Iterable<string> = [],
  ): boolean {
    return parts.some((part) => {
      const rootOffset = part.sceneOffset ?? { x: 0, y: 0, z: 0 }
      const partOffset = part.partSceneOffset ?? { x: 0, y: 0, z: 0 }
      return this.collidesTranslatedProjectVoxels(part.voxels, {
        x: delta.x + rootOffset.x + partOffset.x,
        y: delta.y + rootOffset.y + partOffset.y,
        z: delta.z + rootOffset.z + partOffset.z,
      }, excludedOwnerIds)
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
