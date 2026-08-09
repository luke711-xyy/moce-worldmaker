import { describe, expect, it } from 'vitest'
import { VOXEL_WORLD_SIZE, Voxel, adjacentVoxel, deduplicateVoxels, findInstanceVoxelAtSceneVoxel, instanceLocalVoxelToSceneVoxel, instanceLocalVoxelToSceneVoxelFast, instanceRotationPivot, instanceVoxelPairs, makeAssetFromSceneParts, makeDefaultProject, makeStl, makeStlWithDiagnostics, mirrorVoxels, nextVoxelY, normalizeProjectNaming, resolveInstanceComponents, resolveInstanceSceneVoxels, resolveInstanceVoxels, rotateVoxels, sceneAssemblies, sceneBoundsForProject, sceneEntityParts, sceneInstanceGeometrySignature, sceneInstanceRenderSignature, scenePartVoxelAt, scenePartVoxelAtCoordinate, scenePartVoxels, snapAssetOrigin, snapWorld, uniqueAssetName, uniqueTemplateAssetName, voxelCenterToWorld, voxelComponentAt, voxelComponents, voxelToWorld, worldToVoxel, worldToVoxelCell, worldToVoxelCenter } from './voxel'

describe('莫测造境体素核心数据', () => {
  it('creates the four-style sample neighborhood on a 1mm grid', () => {
    const project = makeDefaultProject()
    expect(project.voxelSizeMm).toBe(1)
    expect(project.sceneSizeCm).toBe(20)
    expect(sceneBoundsForProject(project)).toEqual({ x: 200, y: 200, z: 200 })
    expect(project.instances.filter((instance) => instance.style !== '基础件')).toHaveLength(4)
  })

  it('keeps sample instances as snapshots and counts their editable parts', () => {
    const project = makeDefaultProject()
    expect(project.assets.filter((asset) => asset.isTemplate !== false)).toHaveLength(7)
    expect(project.assets.filter((asset) => asset.isTemplate === false)).toHaveLength(7)
    expect(project.instances[0].assetId).toBe('scene-sample-house-greek')
    expect(sceneEntityParts(project)).toHaveLength(19)
  })

  it('preserves a local paint override without changing the asset base material', () => {
    const asset = { ...makeDefaultProject().assets[0], voxels: [{ x: 0, y: 0, z: 0, materialId: 'primary' }] }
    const resolved = resolveInstanceVoxels(asset, [{ x: 0, y: 0, z: 0, materialId: 'teal', mode: 'paint' }])
    expect(resolved[0]).toEqual({ x: 0, y: 0, z: 0, materialId: 'primary', paintMaterialId: 'teal' })
    expect(asset.voxels[0]).toEqual({ x: 0, y: 0, z: 0, materialId: 'primary' })
  })

  it('reuses unchanged scene-part voxel arrays while appending custom voxels', () => {
    const project = makeDefaultProject()
    const firstParts = sceneEntityParts(project)
    const firstAssetPart = firstParts.find((part) => part.kind === 'asset')!
    project.customVoxels.push({ x: 12, y: 0, z: 12, materialId: 'terracotta', entityId: 'cache-test' })
    const secondParts = sceneEntityParts(project)
    const secondAssetPart = secondParts.find((part) => part.id === firstAssetPart.id)!
    expect(secondAssetPart.voxels).toBe(firstAssetPart.voxels)
    expect(secondParts.find((part) => part.id === 'custom:cache-test')?.voxels).toHaveLength(1)
  })

  it('reuses unchanged custom groups when another entity is replaced', () => {
    const project = {
      ...makeDefaultProject(),
      instances: [],
      customVoxels: [
        { x: 0, y: 0, z: 0, materialId: 'terracotta', entityId: 'replace-me' },
        { x: 4, y: 0, z: 0, materialId: 'teal', entityId: 'keep-me' },
      ],
    }
    const firstParts = sceneEntityParts(project)
    const stableVoxels = firstParts.find((part) => part.id === 'custom:keep-me')?.voxels
    const nextProject = {
      ...project,
      customVoxels: [
        { x: 1, y: 0, z: 0, materialId: 'terracotta', entityId: 'replace-me' },
        project.customVoxels[1],
      ],
    }
    const secondParts = sceneEntityParts(nextProject)
    expect(secondParts.find((part) => part.id === 'custom:keep-me')?.voxels).toBe(stableVoxels)
    expect(secondParts.find((part) => part.id === 'custom:replace-me')?.voxels[0].x).toBe(1)
  })

  it('reuses unchanged instance voxel arrays when another instance moves', () => {
    const project = makeDefaultProject()
    const firstParts = sceneEntityParts(project)
    const stablePart = firstParts.find((part) => part.instanceId === project.instances[0].id)!
    const movedProject = {
      ...project,
      instances: project.instances.map((instance, index) => index === 1
        ? { ...instance, x: instance.x + 1 }
        : instance),
    }
    const secondParts = sceneEntityParts(movedProject)
    expect(secondParts.find((part) => part.id === stablePart.id)?.voxels).toBe(stablePart.voxels)
  })

  it('keeps resolved scene parts cached when an unrelated asset is added', () => {
    const project = makeDefaultProject()
    const firstParts = sceneEntityParts(project)
    const stablePart = firstParts.find((part) => part.kind === 'asset')!
    const addedAsset = { ...project.assets[0], id: 'unrelated-cache-asset', name: '缓存测试资产' }
    const nextProject = { ...project, assets: [...project.assets, addedAsset] }
    const secondParts = sceneEntityParts(nextProject)
    expect(secondParts.find((part) => part.id === stablePart.id)?.voxels).toBe(stablePart.voxels)
  })

  it('carries the enlarged entity cell-render policy with its resolved scene part', () => {
    const project = makeDefaultProject()
    const voxels = [
      { x: 0, y: 0, z: 0, materialId: 'stone', entityId: 'enlarged-1', preserveVoxelCells: true },
      { x: 1, y: 0, z: 0, materialId: 'stone', entityId: 'enlarged-1', preserveVoxelCells: true },
    ]
    const nextProject = {
      ...project,
      instances: [],
      customVoxels: voxels,
      customVoxelRenderModes: { 'enlarged-1': 'cells' as const },
    }
    const part = sceneEntityParts(nextProject).find((candidate) => candidate.partId === 'enlarged-1')
    expect(part?.renderMode).toBe('cells')
    expect(part?.voxels.every((cell) => cell.preserveVoxelCells)).toBe(true)
  })

  it('recovers cell rendering for enlarged entities from voxel markers', () => {
    const project = makeDefaultProject()
    const nextProject = {
      ...project,
      instances: [],
      customVoxels: [{ x: 0, y: 0, z: 0, materialId: 'stone', entityId: 'legacy-enlarged', preserveVoxelCells: true }],
      customVoxelRenderModes: {},
    }
    const part = sceneEntityParts(nextProject).find((candidate) => candidate.partId === 'legacy-enlarged')
    expect(part?.renderMode).toBe('cells')
  })

  it('keeps asset topology canonical while resolving moved scene coordinates lazily', () => {
    const project = makeDefaultProject()
    const instance = project.instances[0]
    const originalPart = sceneEntityParts(project).find((part) => part.instanceId === instance.id)!
    const originalSceneVoxels = scenePartVoxels(originalPart)
    const movedProject = {
      ...project,
      instances: project.instances.map((candidate, index) => index === 0
        ? { ...candidate, x: candidate.x + 1.2, y: (candidate.y ?? 0) + 0.4, z: candidate.z - 0.7 }
        : candidate),
    }
    const movedPart = sceneEntityParts(movedProject).find((part) => part.id === originalPart.id)!
    expect(movedPart.voxels).toBe(originalPart.voxels)
    expect(movedPart.sceneOffset).toBeDefined()
    const movedSceneVoxels = scenePartVoxels(movedPart)
    expect(movedSceneVoxels).toHaveLength(originalSceneVoxels.length)
    const offset = movedPart.sceneOffset!
    const canonicalVoxel = movedPart.voxels[0]
    expect(movedSceneVoxels[0]).toEqual({
      ...canonicalVoxel,
      x: canonicalVoxel.x + offset.x,
      y: canonicalVoxel.y + offset.y,
      z: canonicalVoxel.z + offset.z,
    })
    expect(movedSceneVoxels[0].x - originalSceneVoxels[0].x).toBe(12)
    expect(movedSceneVoxels[0].y - originalSceneVoxels[0].y).toBe(4)
    expect(movedSceneVoxels[0].z - originalSceneVoxels[0].z).toBe(-7)
    expect(movedSceneVoxels).not.toEqual(originalSceneVoxels)
  })

  it('keeps asset topology canonical when only one part moves', () => {
    const project = makeDefaultProject()
    const originalPart = sceneEntityParts(project).find((part) => part.kind === 'asset')!
    const movedProject = {
      ...project,
      instances: project.instances.map((instance) => instance.id === originalPart.instanceId
        ? { ...instance, partOffsets: { ...(instance.partOffsets ?? {}), [originalPart.partId]: { x: 0.1, y: 0, z: 0 } } }
        : instance),
    }
    const movedPart = sceneEntityParts(movedProject).find((part) => part.id === originalPart.id)!
    expect(movedPart.voxels).toBe(originalPart.voxels)
    expect(movedPart.partSceneOffset).toBeDefined()
    const movedSceneVoxels = scenePartVoxels(movedPart)
    const rootOffset = movedPart.sceneOffset ?? { x: 0, y: 0, z: 0 }
    const offset = movedPart.partSceneOffset!
    expect(movedSceneVoxels[0]).toEqual({
      ...movedPart.voxels[0],
      x: movedPart.voxels[0].x + rootOffset.x + offset.x,
      y: movedPart.voxels[0].y + rootOffset.y + offset.y,
      z: movedPart.voxels[0].z + rootOffset.z + offset.z,
    })
  })

  it('reads one scene voxel with both root and part offsets without materializing the part', () => {
    const part = {
      id: 'asset:instance:part',
      kind: 'asset' as const,
      partId: 'part',
      memberKey: 'asset:instance:part',
      sceneOffset: { x: 10, y: 20, z: 30 },
      partSceneOffset: { x: 2, y: 3, z: 4 },
      voxels: [{ x: 1, y: 2, z: 3, materialId: 'primary' }],
    }
    expect(scenePartVoxelAt(part, 0)).toEqual({ x: 13, y: 25, z: 37, materialId: 'primary' })
    expect(scenePartVoxelAt(part, 1)).toBeUndefined()
  })

  it('looks up a large moved scene voxel by coordinate without a linear scan', () => {
    const voxels = Array.from({ length: 300 }, (_, index) => ({ x: index, y: 2, z: 4, materialId: 'primary' }))
    const part = {
      id: 'custom:lookup',
      kind: 'custom' as const,
      partId: 'lookup',
      memberKey: 'voxel:lookup',
      sceneOffset: { x: 10, y: 20, z: 30 },
      voxels,
    }
    expect(scenePartVoxelAtCoordinate(part, 10 + 299, 22, 34)).toEqual({ x: 309, y: 22, z: 34, materialId: 'primary' })
    expect(scenePartVoxelAtCoordinate(part, 999, 22, 34)).toBeUndefined()
  })

  it('preserves exact scene coordinates for rotated and mirrored part offsets', () => {
    const project = makeDefaultProject()
    const originalInstance = project.instances[0]
    const asset = project.assets.find((item) => item.id === originalInstance.assetId)!
    const firstPart = sceneEntityParts(project).find((part) => part.instanceId === originalInstance.id)!
    const movedInstance = {
      ...originalInstance,
      rotation: 90,
      mirror: { x: true, y: false, z: true },
      partOffsets: { ...(originalInstance.partOffsets ?? {}), [firstPart.partId]: { x: 0.1, y: 0.2, z: -0.1 } },
    }
    const movedProject = { ...project, instances: project.instances.map((instance) => instance.id === movedInstance.id ? movedInstance : instance) }
    const movedParts = sceneEntityParts(movedProject).filter((part) => part.instanceId === movedInstance.id)
    const cachedKeys = movedParts.flatMap((part) => scenePartVoxels(part)).map(({ x, y, z, materialId }) => `${x},${y},${z},${materialId}`).sort()
    const directKeys = resolveInstanceSceneVoxels(movedInstance, asset).map(({ x, y, z, materialId }) => `${x},${y},${z},${materialId}`).sort()
    expect(cachedKeys).toEqual(directKeys)
  })

  it('keeps manually authored topology canonical while moving through a lazy entity offset', () => {
    const project = makeDefaultProject()
    project.customVoxels = [
      { x: 2, y: 0, z: 3, materialId: 'terracotta', entityId: 'manual-a' },
      { x: 3, y: 0, z: 3, materialId: 'terracotta', entityId: 'manual-a' },
    ]
    project.customEntityOffsets = {}
    const originalPart = sceneEntityParts(project).find((part) => part.id === 'custom:manual-a')!
    const originalSceneVoxels = scenePartVoxels(originalPart)
    const movedProject = { ...project, customEntityOffsets: { 'manual-a': { x: 7, y: 2, z: -4 } } }
    const movedPart = sceneEntityParts(movedProject).find((part) => part.id === 'custom:manual-a')!
    expect(movedPart.voxels).toBe(originalPart.voxels)
    expect(scenePartVoxels(movedPart)[0]).toEqual({ ...originalSceneVoxels[0], x: 9, y: 2, z: -1 })
    expect(scenePartVoxels(movedPart)[1]).toEqual({ ...originalSceneVoxels[1], x: 10, y: 2, z: -1 })
  })

  it('keeps a pure instance move out of the render geometry signature', () => {
    const project = makeDefaultProject()
    const original = project.instances[0]
    const moved = { ...original, x: original.x + 1, y: (original.y ?? 0) + 1, z: original.z + 1 }
    expect(sceneInstanceRenderSignature(moved)).toBe(sceneInstanceRenderSignature(original))
    expect(sceneInstanceRenderSignature({ ...original, rotation: original.rotation + 90 })).not.toBe(sceneInstanceRenderSignature(original))
  })

  it('keeps a partial asset move out of the geometry signature', () => {
    const project = makeDefaultProject()
    const original = project.instances[0]
    const movedPart = { ...original, partOffsets: { ...(original.partOffsets ?? {}), '主体': { x: 0.1, y: 0, z: 0 } } }
    expect(sceneInstanceGeometrySignature(movedPart)).toBe(sceneInstanceGeometrySignature(original))
    expect(sceneInstanceRenderSignature(movedPart)).not.toBe(sceneInstanceRenderSignature(original))
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

  it('keeps grid lines at cell boundaries and voxel centers inside cells', () => {
    expect(worldToVoxelCell(0.01)).toBe(0)
    expect(worldToVoxelCell(-0.01)).toBe(-1)
    expect(worldToVoxelCenter(0.05)).toBe(0)
    expect(worldToVoxelCenter(-0.05)).toBe(-1)
    expect(snapAssetOrigin(0, 1)).toBe(0.05)
    expect(snapAssetOrigin(0, 2)).toBe(0)
    expect(snapAssetOrigin(0.37, 3)).toBe(0.35)
  })

  it('derives backward-compatible scene bounds from legacy scene size', () => {
    expect(sceneBoundsForProject({ sceneSizeCm: 12 })).toEqual({ x: 120, y: 120, z: 120 })
    expect(sceneBoundsForProject({ sceneSizeCm: 12, sceneBounds: { x: 300, y: 240, z: 80 } })).toEqual({ x: 300, y: 240, z: 80 })
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

  it('scales STL coordinates by the configured voxel edge length in millimeters', () => {
    const voxel = { x: 0, y: 0, z: 0, materialId: 'stone' }
    const stl = makeStl({ ...makeDefaultProject().assets[0], voxels: [voxel] }, 2)
    expect(stl).toContain('vertex 2.000000 2.000000 2.000000')
    expect(stl).toContain('vertex 0.000000 0.000000 0.000000')
  })

  it('welds vertices, unions cells, and bridges diagonal voxel contacts before STL export', () => {
    const asset = { ...makeDefaultProject().assets[0], voxels: [
      { x: 0, y: 0, z: 0, materialId: 'stone' },
      { x: 1, y: 1, z: 0, materialId: 'stone' },
    ] }
    const { diagnostics } = makeStlWithDiagnostics(asset)
    expect(diagnostics.unionVoxelCount).toBe(2)
    expect(diagnostics.bridgeVoxelCount).toBeGreaterThan(0)
    expect(diagnostics.weldedVertexCount).toBeGreaterThan(0)
    expect(diagnostics.nonManifoldEdgesBefore).toBeGreaterThan(0)
    expect(diagnostics.nonManifoldEdgesAfter).toBe(0)
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

  it('keeps authored asset part ids when resolving scene components', () => {
    const asset = makeDefaultProject().assets.find((item) => item.id === 'house-chinese')!
    const components = resolveInstanceComponents(asset)
    expect(components.map((component) => component.partId)).toEqual(asset.parts)
    expect(components.every((component) => component.voxels.length > 0)).toBe(true)
  })

  it('builds the instance local/scene voxel index in one resolution pass', () => {
    const project = makeDefaultProject()
    const instance = project.instances[0]
    const asset = project.assets.find((item) => item.id === instance.assetId)!
    const pairs = instanceVoxelPairs(instance, asset)
    expect(pairs).toHaveLength(resolveInstanceVoxels(asset, instance.overrides).length)
    const first = pairs[0]
    expect(first.scene).toEqual(instanceLocalVoxelToSceneVoxel(instance, asset, first.local))
  })

  it('keeps an imported mesh as one scene entity even when its voxels are disconnected', () => {
    const asset = {
      id: 'imported-robot',
      name: 'robot',
      style: '导入模型',
      kind: 'imported' as const,
      color: '#d2a354',
      accent: '#6c827d',
      width: 5,
      depth: 5,
      height: 5,
      parts: ['mesh-a', 'mesh-b'],
      partVoxels: {
        'mesh-a': [{ x: 0, y: 0, z: 0, materialId: 'gold' }],
        'mesh-b': [{ x: 4, y: 4, z: 4, materialId: 'jade' }],
      },
      voxels: [
        { x: 0, y: 0, z: 0, materialId: 'gold' },
        { x: 4, y: 4, z: 4, materialId: 'jade' },
      ],
      source: 'robot.glb',
    }
    const components = resolveInstanceComponents(asset)
    expect(components).toHaveLength(1)
    expect(components[0].voxels).toHaveLength(2)
  })

  it('mirrors and rotates voxel coordinates around their own bounds', () => {
    const voxels = [
      { x: 0, y: 0, z: 0, materialId: 'stone' },
      { x: 1, y: 0, z: 0, materialId: 'jade' },
      { x: 0, y: 1, z: 0, materialId: 'gold' },
    ]
    expect(mirrorVoxels(voxels, 'x').map(({ x }) => x)).toEqual([1, 0, 1])
    expect(rotateVoxels(voxels, 'z', 180)).toEqual([
      { x: 1, y: 1, z: 0, materialId: 'stone' },
      { x: 0, y: 1, z: 0, materialId: 'jade' },
      { x: 1, y: 0, z: 0, materialId: 'gold' },
    ])
  })

  it('maps scene grid cells to centered asset voxels, including rotated instances', () => {
    const project = makeDefaultProject()
    const asset = project.assets.find((item) => item.id === 'house-chinese')!
    const instance = { ...project.instances[0], assetId: asset.id, x: snapAssetOrigin(0, asset.width), z: snapAssetOrigin(0, asset.depth), rotation: 0 }
    expect(findInstanceVoxelAtSceneVoxel(instance, asset, { x: -3, y: 0, z: -3 })).toEqual(expect.objectContaining({ x: 0, y: 0, z: 0 }))
    const rotated = { ...instance, rotation: 90 }
    expect(findInstanceVoxelAtSceneVoxel(rotated, asset, { x: -3, y: 0, z: 3 })).toEqual(expect.objectContaining({ x: 0, y: 0, z: 0 }))
  })

  it('converts an asset raycast voxel back to scene coordinates before drawing', () => {
    const project = makeDefaultProject()
    const asset = project.assets.find((item) => item.id === 'house-chinese')!
    const instance = { ...project.instances[0], assetId: asset.id, x: snapAssetOrigin(3, asset.width), z: snapAssetOrigin(-2, asset.depth), rotation: 90 }
    const localVoxel = asset.voxels[0]
    const sceneVoxel = instanceLocalVoxelToSceneVoxel(instance, asset, localVoxel)
    expect(sceneVoxel).toBeDefined()
    expect(findInstanceVoxelAtSceneVoxel(instance, asset, sceneVoxel!)).toEqual(expect.objectContaining({ x: localVoxel.x, y: localVoxel.y, z: localVoxel.z }))
  })

  it('converts a raycast voxel in O(1) when its rendered part id is known', () => {
    const project = makeDefaultProject()
    const asset = project.assets.find((item) => item.id === 'house-chinese')!
    const instance = {
      ...project.instances[0],
      assetId: asset.id,
      x: snapAssetOrigin(3, asset.width),
      z: snapAssetOrigin(-2, asset.depth),
      rotation: 90,
      rotationX: 90,
      rotationY: 180,
      mirror: { x: true, y: false, z: true },
    }
    const component = resolveInstanceComponents(asset, instance.overrides)[0]
    const localVoxel = component.voxels[Math.min(3, component.voxels.length - 1)]
    expect(instanceLocalVoxelToSceneVoxelFast(instance, asset, localVoxel, component.partId))
      .toEqual(instanceLocalVoxelToSceneVoxel(instance, asset, localVoxel))
  })

  it('rotates asset instances around the effective geometry center', () => {
    const project = makeDefaultProject()
    const asset = {
      ...project.assets[0],
      id: 'pivot-test',
      width: 6,
      depth: 6,
      height: 5,
      partVoxels: undefined,
      assembly: undefined,
      voxels: [
        { x: 0, y: 0, z: 0, materialId: 'primary' },
        { x: 4, y: 0, z: 0, materialId: 'primary' },
        { x: 4, y: 3, z: 2, materialId: 'primary' },
        { x: 1, y: 3, z: 2, materialId: 'primary' },
      ],
    }
    const instance = {
      ...project.instances[0],
      assetId: asset.id,
      x: snapAssetOrigin(2, asset.width),
      z: snapAssetOrigin(-1, asset.depth),
      rotation: 0,
    }
    const pivot = instanceRotationPivot(instance, asset)
    const center = (voxels: Voxel[]) => {
      const axes = ['x', 'y', 'z'] as const
      return axes.map((axis) => {
        const values = voxels.map((voxel) => voxel[axis])
        return (voxelCenterToWorld(Math.min(...values)) + voxelCenterToWorld(Math.max(...values))) / 2
      })
    }
    const before = center(resolveInstanceSceneVoxels(instance, asset))
    const after = center(resolveInstanceSceneVoxels({ ...instance, rotation: 90, rotationPivot: pivot }, asset))
    expect(after).toEqual(before)
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

  it('resolves nested assembly paths and groups parent assemblies as one draggable unit', () => {
    const project = makeDefaultProject()
    project.customVoxels = [
      { x: 0, y: 0, z: 0, materialId: 'stone', entityId: 'a' },
      { x: 3, y: 0, z: 0, materialId: 'jade', entityId: 'b' },
      { x: 6, y: 0, z: 0, materialId: 'gold', entityId: 'c' },
    ]
    project.assemblies = [
      { id: 'assembly-child', memberKeys: ['voxel:a', 'voxel:b'] },
      { id: 'assembly-parent', memberKeys: ['assembly:assembly-child', 'voxel:c'] },
    ]
    const parts = sceneEntityParts(project).filter((part) => part.kind === 'custom')
    expect(parts.find((part) => part.partId === 'a')?.assemblyIds).toEqual(['assembly-child', 'assembly-parent'])
    expect(parts.find((part) => part.partId === 'c')?.assemblyIds).toEqual(['assembly-parent'])
    expect(sceneAssemblies(parts, { includeContacts: false })).toHaveLength(1)
    expect(sceneAssemblies(parts, { includeContacts: false })[0]).toHaveLength(3)
  })

  it('gives assemblies and all child types stable hierarchical names', () => {
    const project = makeDefaultProject()
    project.customVoxels = [
      { x: 0, y: 0, z: 0, materialId: 'stone', entityId: 'a' },
      { x: 3, y: 0, z: 0, materialId: 'jade', entityId: 'b' },
      { x: 6, y: 0, z: 0, materialId: 'gold', entityId: 'c' },
    ]
    project.assemblies = [
      { id: 'assembly-root', name: '装配体 23', memberKeys: ['assembly:assembly-child', 'voxel:c'] },
      { id: 'assembly-child', memberKeys: ['voxel:a', 'voxel:b'] },
    ]
    const normalized = normalizeProjectNaming(project)
    const names = normalized.entityNames!
    expect(normalized.assemblies?.find((item) => item.id === 'assembly-root')?.name).toBe('装配体 23')
    expect(normalized.assemblies?.find((item) => item.id === 'assembly-child')?.name).toBe('子装配体 23-1')
    expect(names['voxel:a']).toBe('手动体素实体 23-1-1')
    expect(names['voxel:b']).toBe('手动体素实体 23-1-2')
    expect(names['voxel:c']).toBe('手动体素实体 23-2')
  })

  it('does not reuse hierarchical sibling numbers after deletion', () => {
    const project = makeDefaultProject()
    project.customVoxels = [
      { x: 0, y: 0, z: 0, materialId: 'stone', entityId: 'a' },
      { x: 3, y: 0, z: 0, materialId: 'jade', entityId: 'b' },
    ]
    project.assemblies = [{ id: 'assembly-root', name: '装配体 23', memberKeys: ['voxel:a', 'voxel:b'] }]
    const first = normalizeProjectNaming(project)
    const firstNames = { ...first.entityNames }
    first.customVoxels = first.customVoxels.filter((voxel) => voxel.entityId !== 'a')
    first.assemblies![0].memberKeys = ['voxel:b']
    const afterDelete = normalizeProjectNaming(first)
    expect(afterDelete.entityNames?.['voxel:b']).toBe(firstNames['voxel:b'])
    const c = { x: 6, y: 0, z: 0, materialId: 'gold', entityId: 'c' }
    afterDelete.customVoxels.push(c)
    afterDelete.assemblies![0].memberKeys.push('voxel:c')
    const afterAdd = normalizeProjectNaming(afterDelete)
    expect(afterAdd.entityNames?.['voxel:c']).toBe('手动体素实体 23-3')
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

  it('avoids scene-name collisions when a template instance is added after a custom entity', () => {
    const project = makeDefaultProject()
    project.instances = []
    project.customVoxels = [{ x: 0, y: 0, z: 0, materialId: 'jade', entityId: 'manual-entity' }]
    project.entityNames = { 'voxel:manual-entity': '街角树' }
    project.entityNameModes = { 'voxel:manual-entity': 'custom' }
    project.instances.push({ id: 'placed-tree', assetId: 'tree-basic', x: 30, y: 0, z: 30, rotation: 0, style: '基础件', visible: true, overrides: [] })

    const normalized = normalizeProjectNaming(project)
    const rootParts = sceneEntityParts(normalized).filter((part) => !part.assemblyIds?.length)
    const rootNames = rootParts.map((part) => normalized.entityNames?.[part.memberKey] ?? '')

    expect(new Set(rootNames).size).toBe(rootNames.length)
    expect(normalized.entityNames?.['voxel:manual-entity']).toBe('街角树')
    expect(rootParts
      .filter((part) => part.instanceId === 'placed-tree')
      .map((part) => normalized.entityNames?.[part.memberKey]))
      .toContain('街角树 2')
  })

  it('uses parenthesized suffixes for template asset name collisions', () => {
    const project = makeDefaultProject()
    expect(uniqueTemplateAssetName(project.assets, '街角树')).toBe('街角树 (1)')
    const withCopy = [...project.assets, { ...project.assets.find((asset) => asset.name === '街角树')!, id: 'tree-copy', name: '街角树 (1)' }]
    expect(uniqueTemplateAssetName(withCopy, '街角树')).toBe('街角树 (2)')
    expect(uniqueTemplateAssetName(project.assets, '街角树', 'tree-basic')).toBe('街角树')
  })
})
