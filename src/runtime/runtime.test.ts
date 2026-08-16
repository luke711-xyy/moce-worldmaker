import { describe, expect, it } from 'vitest'
import { SceneEntityPart, Voxel, instanceRotationPivot } from '../voxel'
import {
  projectVoxelToRuntime,
  runtimeChunkCoord,
  runtimeLocalCoord,
  runtimeLocalIndex,
  runtimeVoxelToProject,
} from './runtime-coordinates'
import { SceneOccupancyIndex } from './spatial-index'
import { AssetTransformCache } from './asset-transform-cache'
import { buildGreedyMesh, buildOutlinePositions } from './greedy-mesher'
import { raycastVoxelDda } from './voxel-dda'

const voxel = (x: number, y: number, z: number, materialId = 'stone'): Voxel => ({ x, y, z, materialId })

const part = (id: string, voxels: Voxel[]): SceneEntityPart => ({
  id,
  kind: 'custom',
  partId: id,
  memberKey: `voxel:${id}`,
  voxels,
})

describe('runtime coordinates', () => {
  it('maps project X/Z ground coordinates to runtime X/Y and project Y to runtime Z', () => {
    const runtime = projectVoxelToRuntime(voxel(3, 7, -4))
    expect(runtime).toEqual({ gx: 3, gy: -4, gz: 7 })
    expect(runtimeVoxelToProject(runtime, 'stone')).toEqual(voxel(3, 7, -4))
  })

  it('addresses negative coordinates into stable chunks and positive local cells', () => {
    const runtime = { gx: -1, gy: -33, gz: 32 }
    expect(runtimeChunkCoord(runtime)).toEqual({ cx: -1, cy: -2, cz: 1 })
    expect(runtimeLocalCoord(runtime)).toEqual({ lx: 31, ly: 31, lz: 0 })
    expect(runtimeLocalIndex(runtimeLocalCoord(runtime))).toBe(31 | (31 << 5))
  })
})

describe('SceneOccupancyIndex', () => {
  it('indexes owners and supports exclusions for moving entities', () => {
    const index = SceneOccupancyIndex.fromParts([
      part('left', [voxel(0, 0, 0), voxel(1, 0, 0)]),
      part('right', [voxel(3, 0, 0)]),
    ])
    expect(index.queryProjectVoxel(voxel(0, 0, 0)).ownerIds).toEqual(['left'])
    expect(index.collidesTranslatedProjectVoxels([voxel(0, 0, 0)], { x: 1, y: 0, z: 0 }, ['left'])).toBe(false)
    expect(index.collidesTranslatedProjectVoxels([voxel(1, 0, 0)], { x: 2, y: 0, z: 0 }, ['left'])).toBe(true)
  })

  it('uses stationary voxels for exact collision checks on dense moving models', () => {
    const dense = Array.from({ length: 5000 }, (_, x) => voxel(x, 0, 0))
    const index = SceneOccupancyIndex.fromParts([
      part('dense', dense),
      part('stationary', [voxel(5001, 0, 0)]),
    ])
    expect(index.collidesTranslatedProjectVoxels(dense, { x: 1, y: 0, z: 0 }, ['dense'])).toBe(false)
    index.replaceOwner('stationary', [voxel(5000, 0, 0)])
    expect(index.collidesTranslatedProjectVoxels(dense, { x: 1, y: 0, z: 0 }, ['dense'])).toBe(true)
  })

  it('does not reuse collision keys after a moving voxel array changes in place', () => {
    const moving = Array.from({ length: 5000 }, (_, x) => voxel(x, 0, 0))
    const index = SceneOccupancyIndex.fromParts([
      part('moving', moving),
      part('stationary', [voxel(2499, 0, 0)]),
    ])
    expect(index.collidesTranslatedProjectVoxels(moving, { x: 0, y: 0, z: 0 }, ['moving'])).toBe(true)
    moving[2499] = voxel(6000, 0, 0)
    expect(index.collidesTranslatedProjectVoxels(moving, { x: 0, y: 0, z: 0 }, ['moving'])).toBe(false)
  })

  it('does not treat an occupied bounding-box extension as a collision', () => {
    const moving = Array.from({ length: 2500 }, (_, index) => voxel(index * 2, 0, 0))
    const index = SceneOccupancyIndex.fromParts([
      part('moving', moving),
      part('stationary', [voxel(2499, 0, 0)]),
    ])
    expect(index.collidesTranslatedProjectVoxels(moving, { x: 0, y: 0, z: 0 }, ['moving'])).toBe(false)
  })

  it('uses the broad phase for large placement previews without excluded owners', () => {
    const largeAsset = Array.from({ length: 5000 }, (_, x) => voxel(x, 0, 0))
    const index = SceneOccupancyIndex.fromParts([
      part('stationary', [voxel(10000, 0, 0)]),
    ])
    expect(index.collidesTranslatedProjectVoxels(largeAsset, { x: 0, y: 0, z: 0 })).toBe(false)
    expect(index.collidesTranslatedProjectVoxels(largeAsset, { x: 10000, y: 0, z: 0 })).toBe(true)
  })

  it('includes both owners base offsets and lazy translations in dense collision scans', () => {
    const movingTopology = Array.from({ length: 5000 }, (_, x) => voxel(x, 0, 0))
    const moving = { ...part('moving', movingTopology), sceneOffset: { x: 100, y: 0, z: 0 } }
    const stationary = { ...part('stationary', [voxel(0, 0, 0)]), sceneOffset: { x: 5101, y: 0, z: 0 } }
    const index = SceneOccupancyIndex.fromParts([moving, stationary])

    // The moving entity occupies scene X=100..5099. A +2 move reaches X=5101.
    // Because the moving side is larger, the optimized collision path scans
    // the stationary side, whose voxel reference is already in scene space.
    expect(index.collidesTranslatedSceneParts([moving], { x: 2, y: 0, z: 0 }, ['moving'])).toBe(true)
    expect(index.collidesTranslatedSceneParts([moving], { x: 1, y: 0, z: 0 }, ['moving'])).toBe(false)

    index.translateOwner('stationary', { x: 3, y: 0, z: 0 })
    // The same check remains correct after the stationary owner has also been
    // moved through the lazy transform path.
    expect(index.collidesTranslatedSceneParts([moving], { x: 5, y: 0, z: 0 }, ['moving'])).toBe(true)
  })

  it('checks canonical scene parts with lazy scene offsets without remapping their voxels', () => {
    const moving = { ...part('moving', [voxel(0, 0, 0)]), sceneOffset: { x: 10, y: 2, z: 3 } }
    const index = SceneOccupancyIndex.fromParts([moving, part('stationary', [voxel(12, 2, 3)])])
    expect(index.collidesTranslatedSceneParts([moving], { x: 2, y: 0, z: 0 }, ['moving'])).toBe(true)
    expect(index.collidesTranslatedSceneParts([moving], { x: 1, y: 0, z: 0 }, ['moving'])).toBe(false)
  })

  it('removes and replaces owners incrementally', () => {
    const index = SceneOccupancyIndex.fromParts([part('entity', [voxel(-1, 0, -1)])])
    index.replaceOwner('entity', [voxel(33, 2, 0)])
    expect(index.queryProjectVoxel(voxel(-1, 0, -1)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(33, 2, 0)).ownerIds).toEqual(['entity'])
    index.removeOwner('entity')
    expect(index.queryProjectVoxel(voxel(33, 2, 0)).occupied).toBe(false)
  })

  it('replaces a validated batch without creating false overlap owners', () => {
    const index = SceneOccupancyIndex.fromParts([
      part('old', [voxel(0, 0, 0), voxel(1, 0, 0)]),
      part('stable', [voxel(8, 0, 0)]),
    ])
    index.replaceOwnerFromValidatedBatch('old', [voxel(2, 0, 0), voxel(3, 0, 0), voxel(4, 0, 0)])
    expect(index.queryProjectVoxel(voxel(0, 0, 0)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(3, 0, 0)).ownerIds).toEqual(['old'])
    expect(index.queryProjectVoxel(voxel(8, 0, 0)).ownerIds).toEqual(['stable'])
    expect(index.chunks.get('0,0,0')?.occupiedCount).toBe(4)
  })

  it('rebuilds a validated batch in asynchronous chunks', async () => {
    const index = SceneOccupancyIndex.fromParts([
      part('old', [voxel(0, 0, 0), voxel(1, 0, 0), voxel(2, 0, 0)]),
      part('stable', [voxel(8, 0, 0)]),
    ])
    await index.removeOwnerChunked('old', 2)
    await index.insertOwnerFromValidatedBatchChunked('replacement', [voxel(3, 0, 0), voxel(4, 0, 0), voxel(5, 0, 0)], undefined, undefined, 2)
    expect(index.queryProjectVoxel(voxel(0, 0, 0)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(4, 0, 0)).ownerIds).toEqual(['replacement'])
    expect(index.queryProjectVoxel(voxel(8, 0, 0)).ownerIds).toEqual(['stable'])
  })

  it('forks independently so a background rebuild cannot mutate the live index', async () => {
    const index = SceneOccupancyIndex.fromParts([
      part('old', [voxel(0, 0, 0), voxel(1, 0, 0)]),
      part('stable', [voxel(8, 0, 0)]),
    ])
    const fork = index.fork()
    expect(fork.chunks.get('0,0,0')).toBe(index.chunks.get('0,0,0'))
    await fork.removeOwnerChunked('old', 1)
    await fork.insertOwnerFromValidatedBatchChunked('replacement', [voxel(2, 0, 0)], undefined, undefined, 1)
    expect(index.queryProjectVoxel(voxel(0, 0, 0)).ownerIds).toEqual(['old'])
    expect(index.queryProjectVoxel(voxel(2, 0, 0)).occupied).toBe(false)
    expect(fork.queryProjectVoxel(voxel(0, 0, 0)).occupied).toBe(false)
    expect(fork.queryProjectVoxel(voxel(2, 0, 0)).ownerIds).toEqual(['replacement'])
    expect(fork.queryProjectVoxel(voxel(8, 0, 0)).ownerIds).toEqual(['stable'])
    expect(fork.chunks.get('0,0,0')).not.toBe(index.chunks.get('0,0,0'))
    index.removeOwner('stable')
    expect(index.queryProjectVoxel(voxel(8, 0, 0)).occupied).toBe(false)
    expect(fork.queryProjectVoxel(voxel(8, 0, 0)).ownerIds).toEqual(['stable'])
  })

  it('tracks chunk occupancy without scanning the full chunk on removal', () => {
    const index = SceneOccupancyIndex.fromParts([part('entity', [voxel(0, 0, 0), voxel(1, 0, 0)])])
    const chunk = index.chunks.get('0,0,0')
    expect(chunk?.occupiedCount).toBe(2)
    index.removeOwner('entity')
    expect(index.chunks.has('0,0,0')).toBe(false)
  })

  it('resolves lazy owner translations without rebuilding occupancy chunks', () => {
    const index = SceneOccupancyIndex.fromParts([part('entity', [voxel(1, 2, 3)])])
    const originalChunk = index.chunks.get('0,0,0')
    index.translateOwner('entity', { x: 40, y: 5, z: -2 })
    expect(index.queryProjectVoxel(voxel(1, 2, 3)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(41, 7, 1)).ownerIds).toEqual(['entity'])
    expect(index.chunks.get('0,0,0')).toBe(originalChunk)
    index.removeOwner('entity')
    expect(index.queryProjectVoxel(voxel(41, 7, 1)).occupied).toBe(false)
  })

  it('returns current owner bounds without expanding the voxel payload', () => {
    const topology = Array.from({ length: 5000 }, (_, x) => voxel(x, 2, -3))
    const index = SceneOccupancyIndex.fromParts([part('entity', topology)])
    expect(index.getProjectBounds('entity')).toEqual({ minX: 0, maxX: 4999, minY: 2, maxY: 2, minZ: -3, maxZ: -3 })
    index.translateOwner('entity', { x: 40, y: 5, z: -2 })
    expect(index.getProjectBounds('entity')).toEqual({ minX: 40, maxX: 5039, minY: 7, maxY: 7, minZ: -5, maxZ: -5 })
  })

  it('collects only occupied owners inside a local erase region', () => {
    const index = SceneOccupancyIndex.fromParts([
      part('center', [voxel(0, 0, 0), voxel(1, 0, 0)]),
      part('outside', [voxel(8, 0, 0)]),
    ])
    expect(index.collectProjectVoxelsInRegion({ minX: -1, maxX: 2, minY: -1, maxY: 1, minZ: -1, maxZ: 1 })).toEqual(new Map([
      ['center', [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]],
    ]))
  })

  it('finds the highest custom cell in a column without flattening the scene', () => {
    const index = SceneOccupancyIndex.fromParts([
      { ...part('custom:low', [voxel(2, 1, 3)]), partId: 'low' },
      { ...part('custom:high', [voxel(2, 5, 3)]), partId: 'high' },
      { ...part('asset:asset-instance:main', [voxel(2, 9, 3)]), kind: 'asset', instanceId: 'asset-instance' },
    ])
    expect(index.highestProjectVoxelAt(2, 3, 0, 10, 'custom:')).toEqual({
      voxel: { x: 2, y: 5, z: 3 },
      ownerId: 'custom:high',
    })
  })

  it('clears a lazy translation when synchronization restores the original snapshot', () => {
    const original = [voxel(1, 2, 3)]
    const index = SceneOccupancyIndex.fromParts([part('entity', original)])
    index.translateOwner('entity', { x: 40, y: 5, z: -2 })
    const result = index.syncParts([part('entity', [voxel(1, 2, 3)])])
    expect(result.unchanged).toBe(1)
    expect(index.queryProjectVoxel(voxel(1, 2, 3)).ownerIds).toEqual(['entity'])
    expect(index.queryProjectVoxel(voxel(41, 7, 1)).occupied).toBe(false)
  })

  it('updates a moved scene part by offset without expanding its voxel array', () => {
    const topology = Array.from({ length: 5000 }, (_, x) => voxel(x, 0, 0))
    const initial = { ...part('entity', topology), sceneOffset: { x: 10, y: 0, z: 4 } }
    const index = SceneOccupancyIndex.fromParts([initial])
    const originalChunk = index.chunks.get('0,0,0')
    const moved = { ...initial, sceneOffset: { x: 70, y: 0, z: 4 } }

    const result = index.syncParts([moved])

    expect(result).toEqual({ inserted: 0, updated: 0, removed: 0, unchanged: 1 })
    expect(index.chunks.get('0,0,0')).toBe(originalChunk)
    expect(index.queryProjectVoxel(voxel(10, 0, 4)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(70, 0, 4)).ownerIds).toEqual(['entity'])
  })

  it('tracks overlapping legacy occupants without hiding non-excluded owners', () => {
    const index = SceneOccupancyIndex.fromParts([
      part('first', [voxel(4, 1, 2)]),
      part('second', [voxel(4, 1, 2)]),
    ])
    expect(index.queryProjectVoxel(voxel(4, 1, 2)).ownerIds).toEqual(['first', 'second'])
    expect(index.collidesProjectVoxels([voxel(4, 1, 2)], ['first'])).toBe(true)
    index.removeOwner('first')
    expect(index.queryProjectVoxel(voxel(4, 1, 2)).ownerIds).toEqual(['second'])
  })

  it('synchronizes only changed owners while preserving unchanged chunks', () => {
    const index = SceneOccupancyIndex.fromParts([
      part('stable', [voxel(0, 0, 0)]),
      part('moving', [voxel(2, 0, 0)]),
    ])
    const stableChunk = index.chunks.get('0,0,0')
    const result = index.syncParts([
      part('stable', [voxel(0, 0, 0)]),
      part('moving', [voxel(34, 0, 0)]),
      part('added', [voxel(-1, 0, 0)]),
    ])
    expect(result).toEqual({ inserted: 1, updated: 1, removed: 0, unchanged: 1 })
    expect(index.queryProjectVoxel(voxel(2, 0, 0)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(34, 0, 0)).ownerIds).toEqual(['moving'])
    expect(index.queryProjectVoxel(voxel(-1, 0, 0)).ownerIds).toEqual(['added'])
    expect(index.chunks.get('0,0,0')).toBe(stableChunk)
  })

  it('synchronizes a touched owner without enumerating or replacing the rest of the scene', () => {
    const stable = part('stable', [voxel(0, 0, 0)])
    const moving = part('moving', [voxel(2, 0, 0)])
    const index = SceneOccupancyIndex.fromParts([stable, moving])
    const stableChunk = index.chunks.get('0,0,0')

    index.syncOwnerParts([
      { ...moving, voxels: [voxel(3, 0, 0)] },
    ], ['moving'])

    expect(index.queryProjectVoxel(voxel(2, 0, 0)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(3, 0, 0)).ownerIds).toEqual(['moving'])
    expect(index.queryProjectVoxel(voxel(0, 0, 0)).ownerIds).toEqual(['stable'])
    expect(index.chunks.get('0,0,0')).toBe(stableChunk)
  })
})

describe('AssetTransformCache', () => {
  it('reuses transformed topology while applying scene translation separately', () => {
    const asset = {
      id: 'asset',
      name: 'asset',
      kind: 'house' as const,
      style: 'greek' as const,
      width: 2,
      height: 1,
      depth: 1,
      color: '#ffffff',
      accent: '#000000',
      parts: ['main'],
      voxels: [voxel(0, 0, 0), voxel(1, 0, 0)],
    }
    const instance = { id: 'instance', assetId: asset.id, x: 0, y: 0, z: 0, rotation: 0, style: asset.style, visible: true, overrides: [] }
    const cache = new AssetTransformCache()
    const first = cache.get(instance, asset)
    const second = cache.get({ ...instance, x: 8, z: 9 }, asset)
    expect(second).toBe(first)
    expect(cache.resolve({ ...instance, x: 2, z: 3 }, asset).map(({ x, y, z }) => ({ x, y, z }))).toEqual([
      { x: 19, y: 0, z: 30 },
      { x: 20, y: 0, z: 30 },
    ])
    expect(cache.localVoxelAtSceneVoxel({ ...instance, x: 2, z: 3 }, asset, { x: 19, y: 0, z: 30 })).toEqual(voxel(0, 0, 0))
    expect(cache.localVoxelAtSceneVoxel({ ...instance, x: 2, z: 3 }, asset, { x: 99, y: 0, z: 30 })).toBeUndefined()
  })

  it('resolves empty target cells for edits without creating a child entity', () => {
    const asset = {
      id: 'asset',
      name: 'asset',
      kind: 'house' as const,
      style: 'greek' as const,
      width: 2,
      height: 1,
      depth: 1,
      color: '#ffffff',
      accent: '#000000',
      parts: ['main'],
      voxels: [voxel(0, 0, 0)],
    }
    const instance = { id: 'instance', assetId: asset.id, x: 0, y: 0, z: 0.05, rotation: 0, style: asset.style, visible: true, overrides: [] }
    const cache = new AssetTransformCache()
    expect(cache.localCoordinateAtSceneVoxel(instance, asset, { x: 0, y: 0, z: 0 }, 'main')).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('round-trips rotated and mirrored asset cells', () => {
    const asset = {
      id: 'asset',
      name: 'asset',
      kind: 'house' as const,
      style: 'greek' as const,
      width: 2,
      height: 2,
      depth: 2,
      color: '#ffffff',
      accent: '#000000',
      parts: ['main'],
      voxels: [voxel(1, 1, 0)],
    }
    const instance = { id: 'instance', assetId: asset.id, x: 0, y: 0, z: 0, rotation: 90, mirror: { x: true, y: false, z: true }, style: asset.style, visible: true, overrides: [] }
    const cache = new AssetTransformCache()
    const sceneVoxel = cache.resolve(instance, asset)[0]
    expect(cache.localCoordinateAtSceneVoxel(instance, asset, sceneVoxel, 'main')).toEqual({ x: 1, y: 1, z: 0 })
  })

  it('round-trips asset cells when the rotation pivot is offset from the root', () => {
    const asset = {
      id: 'asset',
      name: 'asset',
      kind: 'house' as const,
      style: 'greek' as const,
      width: 6,
      height: 3,
      depth: 6,
      color: '#ffffff',
      accent: '#000000',
      parts: ['main'],
      voxels: [voxel(0, 0, 0), voxel(4, 2, 3)],
    }
    const base = { id: 'instance', assetId: asset.id, x: 0, y: 0, z: 0, rotation: 90, style: asset.style, visible: true, overrides: [] }
    const instance = { ...base, rotationPivot: instanceRotationPivot(base, asset) }
    const cache = new AssetTransformCache()
    const sceneVoxel = cache.resolve(instance, asset)[0]
    expect(cache.localCoordinateAtSceneVoxel(instance, asset, sceneVoxel, 'main')).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('keeps mirror and rotation variants in separate cache entries', () => {
    const asset = {
      id: 'asset',
      name: 'asset',
      kind: 'house' as const,
      style: 'greek' as const,
      width: 2,
      height: 1,
      depth: 1,
      color: '#ffffff',
      accent: '#000000',
      parts: ['main'],
      voxels: [voxel(0, 0, 0)],
    }
    const instance = { id: 'instance', assetId: asset.id, x: 0, y: 0, z: 0, rotation: 0, style: asset.style, visible: true, overrides: [] }
    const cache = new AssetTransformCache()
    expect(cache.get({ ...instance, mirror: { x: true, y: false, z: false } }, asset)).not.toBe(cache.get(instance, asset))
    expect(cache.get({ ...instance, rotation: 90 }, asset)).not.toBe(cache.get(instance, asset))
  })
})

describe('greedy mesher', () => {
  it('emits six quads for one voxel and never emits internal faces', () => {
    expect(buildGreedyMesh([{ gx: 0, gy: 0, gz: 0, materialId: 1 }]).quadCount).toBe(6)
    const twoVoxelMesh = buildGreedyMesh([
      { gx: 0, gy: 0, gz: 0, materialId: 1 },
      { gx: 1, gy: 0, gz: 0, materialId: 1 },
    ])
    expect(twoVoxelMesh.quadCount).toBe(6)
    expect(twoVoxelMesh.indices.length).toBe(36)
  })

  it('does not merge adjacent visible faces with different materials', () => {
    const mesh = buildGreedyMesh([
      { gx: 0, gy: 0, gz: 0, materialId: 1 },
      { gx: 1, gy: 0, gz: 0, materialId: 2 },
    ])
    expect(mesh.quadCount).toBe(10)
  })

  it('can build reusable feature-edge positions without main-thread geometry work', () => {
    const mesh = buildGreedyMesh([{ gx: 0, gy: 0, gz: 0, materialId: 1 }], { includeOutline: true })
    expect(mesh.outlinePositions).toBeDefined()
    // A cube has 12 outline segments, each with two 3D endpoints.
    expect(mesh.outlinePositions?.length).toBe(12 * 2 * 3)
    expect(buildGreedyMesh([{ gx: 0, gy: 0, gz: 0, materialId: 1 }]).outlinePositions).toBeUndefined()
  })

  it('removes coplanar T-junction edges from the selection outline', () => {
    const positions = new Float32Array([
      0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0,
      0, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0,
      1, 1, 0, 2, 1, 0, 2, 2, 0, 1, 2, 0,
    ])
    const normals = new Int8Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ])
    const outline = buildOutlinePositions(positions, normals, 3)
    // The three quads form a 2x2 coplanar square with a T-junction. Only its
    // four perimeter edges should remain: 4 segments * 2 endpoints * 3 axes.
    expect(outline.length).toBe(4 * 2 * 3)
  })
})

describe('voxel DDA', () => {
  it('returns the first occupied voxel and the entered face normal', () => {
    const hit = raycastVoxelDda(
      { x: -2.5, y: 0.5, z: 0.5 },
      { x: 1, y: 0, z: 0 },
      (candidate) => ({ occupied: candidate.gx === 0 && candidate.gy === 0 && candidate.gz === 0, ownerIds: ['target'] }),
      10,
    )
    expect(hit).toEqual({
      voxel: { gx: 0, gy: 0, gz: 0 },
      normal: { gx: -1, gy: 0, gz: 0 },
      distance: 2.5,
      ownerIds: ['target'],
    })
  })

  it('returns null when the ray leaves the query distance without a hit', () => {
    expect(raycastVoxelDda({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: 1 }, () => ({ occupied: false, ownerIds: [] }), 3)).toBeNull()
  })

  it('starts at the scene AABB after a far camera pan', () => {
    const hit = raycastVoxelDda(
      { x: 10000.5, y: 0.5, z: 0.5 },
      { x: -1, y: 0, z: 0 },
      (candidate) => ({ occupied: candidate.gx === 0 && candidate.gy === 0 && candidate.gz === 0, ownerIds: ['target'] }),
      20_000,
      { minGx: 0, maxGx: 2, minGy: 0, maxGy: 0, minGz: 0, maxGz: 0 },
    )
    expect(hit?.voxel).toEqual({ gx: 0, gy: 0, gz: 0 })
    expect(hit?.normal).toEqual({ gx: 1, gy: 0, gz: 0 })
  })

  it('provides a usable entry normal when the first bounded cell is occupied', () => {
    const hit = raycastVoxelDda(
      { x: 10000.5, y: 0.5, z: 0.5 },
      { x: -1, y: 0, z: 0 },
      (candidate) => ({ occupied: candidate.gx === 2 && candidate.gy === 0 && candidate.gz === 0, ownerIds: ['target'] }),
      20_000,
      { minGx: 0, maxGx: 2, minGy: 0, maxGy: 0, minGz: 0, maxGz: 0 },
    )
    expect(hit?.voxel).toEqual({ gx: 2, gy: 0, gz: 0 })
    expect(hit?.normal).toEqual({ gx: 1, gy: 0, gz: 0 })
  })

  it('uses the dominant incoming direction if the ray starts inside an occupied cell', () => {
    const hit = raycastVoxelDda(
      { x: 0.5, y: 0.5, z: 0.5 },
      { x: 1, y: 0.1, z: 0 },
      () => ({ occupied: true, ownerIds: ['target'] }),
      10,
    )
    expect(hit?.normal).toEqual({ gx: -1, gy: 0, gz: 0 })
  })
})
