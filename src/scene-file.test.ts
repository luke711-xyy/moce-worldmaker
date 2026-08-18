import { describe, expect, it } from 'vitest'
import { createSceneFile, parseSceneFile, parseSceneFileText, restoreProject, sceneContentSignature, SceneFileError } from './scene-file'
import { makeDefaultProject, makeEmptyProject } from './voxel'

describe('莫测造境场景文件', () => {
  it('only embeds assets referenced by the current scene', () => {
    const project = makeDefaultProject()
    const file = createSceneFile(project)
    const used = new Set(project.instances.map((instance) => instance.assetId))
    expect(file.format).toBe('moce-scene')
    expect(file.sceneAssets.map((asset) => asset.id).sort()).toEqual([...used].sort())
    expect(file.sceneAssets.every((asset) => asset.isTemplate === false)).toBe(true)
  })

  it('writes canonical scene entities without legacy instance records', () => {
    const sample = makeDefaultProject()
    const template = sample.assets.find((asset) => asset.isTemplate === true)!
    const project = makeEmptyProject()
    project.assets = [template]
    project.customVoxels = [
      { x: 3, y: 4, z: 0, materialId: '#c96043', entityId: 'custom-1' },
      { x: 4, y: 4, z: 0, materialId: '#c96043', entityId: 'custom-1' },
    ]
    project.customEntitySources = { 'custom-1': { assetId: template.id, categoryPath: ['基础件'] } }

    const file = createSceneFile(project)
    expect(file.scene.instances).toEqual([])
    expect(file.scene.customVoxels).toHaveLength(2)
    expect(file.sceneAssets.map((asset) => asset.id)).toEqual([template.id])

    const restored = restoreProject(parseSceneFile(file))
    expect(restored.instances).toEqual([])
    expect(restored.customVoxels).toEqual(project.customVoxels)
    expect(restored.customEntitySources).toEqual(project.customEntitySources)
  })

  it('does not make a materialized scene dirty when its template metadata changes', () => {
    const sample = makeDefaultProject()
    const template = sample.assets.find((asset) => asset.isTemplate === true)!
    const project = makeEmptyProject()
    project.assets = [template]
    project.customVoxels = [{ x: 0, y: 0, z: 0, materialId: '#c96043', entityId: 'custom-1' }]
    project.customEntitySources = { 'custom-1': { assetId: template.id, categoryPath: ['基础件'] } }

    const before = sceneContentSignature(project)
    project.assets[0] = { ...template, name: '改过的模板名', color: '#ffffff', categoryPath: ['新分类'] }
    expect(sceneContentSignature(project)).toBe(before)
  })

  it('round-trips scene entities, instances, assemblies and colors', () => {
    const project = makeDefaultProject()
    project.voxelSizeMm = 2.5
    project.customVoxels = [{ x: 2, y: 3, z: 4, materialId: '#c96043', entityId: 'custom-1', preserveVoxelCells: true }]
    project.customVoxelRenderModes = { 'custom-1': 'cells' }
    project.customColors = { 'custom-1': '#c96043' }
    project.customEntityOffsets = { 'custom-1': { x: 7, y: 2, z: -4 } }
    project.assemblies = [{ id: 'assembly-1', name: '装配体 1', memberKeys: ['voxel:custom-1'] }]
    project.instances[0].colorOverride = '#123456'
    const restored = restoreProject(parseSceneFile(createSceneFile(project)))
    expect(restored.customVoxels).toEqual(project.customVoxels)
    expect(restored.customVoxelRenderModes).toEqual(project.customVoxelRenderModes)
    expect(restored.customColors).toEqual(project.customColors)
    expect(restored.customEntityOffsets).toEqual(project.customEntityOffsets)
    expect(restored.assemblies).toEqual(project.assemblies)
    expect(restored.instances[0].colorOverride).toBe('#123456')
    expect(restored.voxelSizeMm).toBe(2.5)
  })

  it('rejects unsupported versions, malformed data and missing asset references', () => {
    expect(() => parseSceneFile({ format: 'moce-scene', formatVersion: 2 })).toThrow(SceneFileError)
    expect(() => parseSceneFileText('{bad json')).toThrow('有效的JSON')
    const project = makeDefaultProject()
    const file = createSceneFile(project)
    file.scene.instances[0].assetId = 'missing-asset'
    expect(() => parseSceneFile(file)).toThrow('未包含的资产')
  })

  it('rejects scene files whose boundary is smaller than 10 voxels', () => {
    const file = createSceneFile(makeDefaultProject())
    file.scene.sceneBounds!.x = 9
    expect(() => parseSceneFile(file)).toThrow('scene.sceneBounds.x必须是10到1000之间的整数')
  })

  it('migrates the old full ProjectState export and gives stable signatures', () => {
    const project = makeDefaultProject()
    const legacy = JSON.stringify(project)
    const parsed = parseSceneFileText(legacy)
    expect(parsed.formatVersion).toBe(1)
    expect(parsed.sceneAssets.length).toBeGreaterThan(0)
    expect(sceneContentSignature(project)).toBe(sceneContentSignature(restoreProject(parsed)))
  })

  it('detects an appended voxel in place', () => {
    const project = makeDefaultProject()
    const before = sceneContentSignature(project)
    project.customVoxels.push({ x: 9, y: 2, z: 1, materialId: '#c96043', entityId: 'custom-append' })
    expect(sceneContentSignature(project)).not.toBe(before)
  })

  it('detects same-length voxel replacement in place', () => {
    const project = makeDefaultProject()
    project.customVoxels = [
      { x: 1, y: 2, z: 0, materialId: '#c96043', entityId: 'custom-same-length' },
      { x: 2, y: 2, z: 0, materialId: '#c96043', entityId: 'custom-same-length' },
    ]
    const before = sceneContentSignature(project)
    project.customVoxels[0] = { ...project.customVoxels[0], x: 8, paintMaterialId: '#ffffff' }
    expect(sceneContentSignature(project)).not.toBe(before)
  })
})
