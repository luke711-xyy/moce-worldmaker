import { describe, expect, it } from 'vitest'
import { VOXEL_WORLD_SIZE, adjacentVoxel, deduplicateVoxels, findInstanceVoxelAtSceneVoxel, makeAssetFromSceneParts, makeDefaultProject, makeStl, nextVoxelY, resolveInstanceVoxels, sceneAssemblies, sceneEntityParts, snapWorld, uniqueAssetName, voxelCenterToWorld, voxelComponentAt, voxelComponents, voxelToWorld, worldToVoxel } from './voxel'

describe('莫测造境体素核心数据', () => {
  it('creates the four-style sample neighborhood on a 1mm grid', () => {
    const project = makeDefaultProject()
    expect(project.voxelSizeMm).toBe(1)
    expect(project.sceneSizeCm).toBe(20)
    expect(project.instances.filter((instance) => instance.style !== '基础件')).toHaveLength(4)
  })

  it('uses one shared viewport conversion for every 1mm voxel', () => {
    expect(VOXEL_WORLD_SIZE).toBe(0.1)
    expect(voxelToWorld(10)).toBe(1)
    expect(voxelToWorld(67)).toBe(6.7)
    expect(voxelCenterToWorld(0)).toBe(0.05)
    expect(voxelCenterToWorld(2)).toBe(0.25)
    expect(worldToVoxel(1)).toBe(10)
    expect(snapWorld(0.30000000000000004)).toBe(0.3)
  })

  it('exports a voxel asset as ASCII STL with a solid boundary', () => {
    const project = makeDefaultProject()
    const house = project.assets.find((asset) => asset.id === 'house-chinese')!
    const stl = makeStl(house)
    expect(stl.startsWith('solid house-chinese')).toBe(true)
    expect(stl).toContain('facet normal')
    expect(stl.endsWith('endsolid house-chinese')).toBe(true)
  })

  it('deduplicates overlapping voxels before manufacturing export', () => {
    const voxel = { x: 0, y: 0, z: 0, materialId: 'stone' }
    expect(deduplicateVoxels([voxel, voxel])).toEqual([voxel])
    const stl = makeStl({ ...makeDefaultProject().assets[0], voxels: [voxel, voxel] })
    expect((stl.match(/facet normal/g) ?? []).length).toBe(12)
  })

  it('stacks a new voxel above the highest voxel in the column', () => {
    expect(nextVoxelY([{ x: 2, y: 0, z: 3, materialId: 'stone' }, { x: 2, y: 2, z: 3, materialId: 'stone' }], 2, 3)).toBe(3)
    expect(nextVoxelY([], 2, 3)).toBe(0)
  })

  it('adds a voxel on the face indicated by the hit normal', () => {
    const voxel = { x: 2, y: 3, z: 4, materialId: 'stone' }
    expect(adjacentVoxel(voxel, { x: 1, y: 0, z: 0 }, 'terracotta')).toEqual({ x: 3, y: 3, z: 4, materialId: 'terracotta' })
    expect(adjacentVoxel(voxel, { x: 0, y: -1, z: 0 })).toEqual({ x: 2, y: 2, z: 4, materialId: 'stone' })
    expect(adjacentVoxel(voxel, { x: 0, y: 0, z: -1 })).toEqual({ x: 2, y: 3, z: 3, materialId: 'stone' })
  })

  it('resolves per-instance additions and removals without changing the source asset', () => {
    const project = makeDefaultProject()
    const house = project.assets.find((asset) => asset.id === 'house-chinese')!
    const originalCount = house.voxels.length
    const uniqueOriginalCount = new Set(house.voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`)).size
    const removed = house.voxels[0]
    const added = { x: 20, y: 2, z: 20, materialId: 'gold' }
    const resolved = resolveInstanceVoxels(house, [
      { ...removed, mode: 'remove' },
      { ...added, mode: 'add' },
    ])
    expect(resolved).not.toContainEqual(removed)
    expect(resolved).toContainEqual(added)
    expect(resolved).toHaveLength(uniqueOriginalCount)
    expect(house.voxels).toHaveLength(originalCount)
  })

  it('maps scene grid cells to centered asset voxels, including rotated instances', () => {
    const project = makeDefaultProject()
    const asset = project.assets.find((item) => item.id === 'house-chinese')!
    const instance = { ...project.instances[0], assetId: asset.id, x: 0, z: 0, rotation: 0 }
    expect(findInstanceVoxelAtSceneVoxel(instance, asset, { x: -3, y: 0, z: -3 })).toEqual(expect.objectContaining({ x: 0, y: 0, z: 0 }))
    const rotated = { ...instance, rotation: 90 }
    expect(findInstanceVoxelAtSceneVoxel(rotated, asset, { x: -3, y: 0, z: 3 })).toEqual(expect.objectContaining({ x: 0, y: 0, z: 0 }))
  })

  it('groups only face-connected voxels into one draggable component', () => {
    const voxels = [
      { x: 0, y: 0, z: 0, materialId: 'stone' },
      { x: 1, y: 0, z: 0, materialId: 'stone' },
      { x: 1, y: 1, z: 0, materialId: 'stone' },
      { x: 2, y: 1, z: 1, materialId: 'stone' },
    ]
    expect(voxelComponentAt(voxels, voxels[0])).toHaveLength(3)
    expect(voxelComponents(voxels).map((component) => component.length).sort()).toEqual([1, 3])
  })

  it('treats touching scene parts as one assembly while keeping separated parts independent', () => {
    const parts = [
      { id: 'custom:a', kind: 'custom' as const, partId: 'a', memberKey: 'voxel:a', voxels: [{ x: 0, y: 0, z: 0, materialId: 'stone' }] },
      { id: 'asset:b', kind: 'asset' as const, instanceId: 'b', partId: 'b', memberKey: 'asset:b', voxels: [{ x: 1, y: 0, z: 0, materialId: 'jade' }] },
      { id: 'custom:c', kind: 'custom' as const, partId: 'c', memberKey: 'voxel:c', voxels: [{ x: 4, y: 0, z: 0, materialId: 'gold' }] },
    ]
    expect(sceneAssemblies(parts).map((assembly) => assembly.length).sort()).toEqual([1, 2])
  })

  it('splits a preset asset into independently addressable scene parts after removal', () => {
    const project = makeDefaultProject()
    const asset = project.assets.find((item) => item.id === 'tree-basic')!
    const instance = project.instances.find((item) => item.id === 'inst-tree-a')!
    const bridge = asset.voxels.find((voxel) => voxel.y === 2)!
    instance.overrides = [{ ...bridge, mode: 'remove' }]
    const parts = sceneEntityParts(project).filter((part) => part.instanceId === instance.id)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => part.voxels.length > 0)).toBe(true)
  })

  it('keeps adjacent hand-drawn voxels separate until an assembly is persisted', () => {
    const project = makeDefaultProject()
    project.customVoxels = [
      { x: 0, y: 0, z: 0, materialId: 'stone', entityId: 'a' },
      { x: 1, y: 0, z: 0, materialId: 'jade', entityId: 'b' },
    ]
    const separateParts = sceneEntityParts(project).filter((part) => part.kind === 'custom')
    expect(separateParts).toHaveLength(2)
    expect(sceneAssemblies(separateParts, { includeContacts: false }).map((assembly) => assembly.length)).toEqual([1, 1])
    project.assemblies = [{ id: 'assembly-1', memberKeys: ['voxel:a', 'voxel:b'] }]
    const assembledParts = sceneEntityParts(project).filter((part) => part.kind === 'custom')
    expect(sceneAssemblies(assembledParts, { includeContacts: false })).toHaveLength(1)
    expect(sceneAssemblies(assembledParts, { includeContacts: false })[0]).toHaveLength(2)
  })

  it('creates a normalized reusable asset from selected scene parts with a unique name', () => {
    const project = makeDefaultProject()
    const parts = sceneEntityParts(project).filter((part) => part.instanceId === 'inst-tree-a')
    const asset = makeAssetFromSceneParts('asset-custom-1', uniqueAssetName(project.assets, '街角树·副本'), parts)
    expect(asset.name).toBe('街角树·副本')
    expect(asset.voxels).toHaveLength(parts.flatMap((part) => part.voxels).length)
    expect(Math.min(...asset.voxels.map((voxel) => voxel.x))).toBe(0)
    expect(Math.min(...asset.voxels.map((voxel) => voxel.y))).toBe(0)
  })

  it('increments copied asset names without overwriting existing assets', () => {
    const project = makeDefaultProject()
    expect(uniqueAssetName(project.assets, '街角树')).toBe('街角树 2')
    expect(uniqueAssetName(project.assets, '全新实体')).toBe('全新实体')
  })
})
