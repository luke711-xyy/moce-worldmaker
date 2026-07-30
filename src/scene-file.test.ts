import { describe, expect, it } from 'vitest'
import { createSceneFile, parseSceneFile, parseSceneFileText, restoreProject, sceneContentSignature, SceneFileError } from './scene-file'
import { makeDefaultProject } from './voxel'

describe('莫测造境场景文件', () => {
  it('only embeds assets referenced by the current scene', () => {
    const project = makeDefaultProject()
    const file = createSceneFile(project)
    const used = new Set(project.instances.map((instance) => instance.assetId))
    expect(file.format).toBe('moce-scene')
    expect(file.sceneAssets.map((asset) => asset.id).sort()).toEqual([...used].sort())
    expect(file.sceneAssets.every((asset) => asset.isTemplate === false)).toBe(true)
  })

  it('round-trips scene entities, instances, assemblies and colors', () => {
    const project = makeDefaultProject()
    project.customVoxels = [{ x: 2, y: 3, z: 4, materialId: '#c96043', entityId: 'custom-1' }]
    project.customColors = { 'custom-1': '#c96043' }
    project.assemblies = [{ id: 'assembly-1', name: '装配体 1', memberKeys: ['voxel:custom-1'] }]
    project.instances[0].colorOverride = '#123456'
    const restored = restoreProject(parseSceneFile(createSceneFile(project)))
    expect(restored.customVoxels).toEqual(project.customVoxels)
    expect(restored.customColors).toEqual(project.customColors)
    expect(restored.assemblies).toEqual(project.assemblies)
    expect(restored.instances[0].colorOverride).toBe('#123456')
  })

  it('rejects unsupported versions, malformed data and missing asset references', () => {
    expect(() => parseSceneFile({ format: 'moce-scene', formatVersion: 2 })).toThrow(SceneFileError)
    expect(() => parseSceneFileText('{bad json')).toThrow('有效的JSON')
    const project = makeDefaultProject()
    const file = createSceneFile(project)
    file.scene.instances[0].assetId = 'missing-asset'
    expect(() => parseSceneFile(file)).toThrow('未包含的资产')
  })

  it('migrates the old full ProjectState export and gives stable signatures', () => {
    const project = makeDefaultProject()
    const legacy = JSON.stringify(project)
    const parsed = parseSceneFileText(legacy)
    expect(parsed.formatVersion).toBe(1)
    expect(parsed.sceneAssets.length).toBeGreaterThan(0)
    expect(sceneContentSignature(project)).toBe(sceneContentSignature(restoreProject(parsed)))
  })
})
