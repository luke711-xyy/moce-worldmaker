import { describe, expect, it } from 'vitest'
import { SceneEntityPart, Voxel } from '../voxel'
import {
  projectVoxelToRuntime,
  runtimeChunkCoord,
  runtimeLocalCoord,
  runtimeLocalIndex,
  runtimeVoxelToProject,
} from './runtime-coordinates'
import { SceneOccupancyIndex } from './spatial-index'
import { AssetTransformCache } from './asset-transform-cache'
import { buildGreedyMesh } from './greedy-mesher'
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
})
