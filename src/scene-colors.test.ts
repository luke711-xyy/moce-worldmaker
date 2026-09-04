import { describe, expect, it } from 'vitest'
import { createDefaultSceneColorPolicy, optimizeMardAllowedCodes } from './color-palettes'
import { collectSceneColorSamples, remapProjectToSceneColorPolicy, scenePaletteUsage } from './scene-colors'
import { makeEmptyProject } from './voxel'

describe('场景级 MARD 颜色限制', () => {
  it('limits all scene-owned entities to one shared allowed set', () => {
    const project = makeEmptyProject()
    project.customVoxels = [
      { x: 0, y: 0, z: 0, entityId: 'a', materialId: '#ff0000' },
      { x: 1, y: 0, z: 0, entityId: 'a', materialId: '#00ff00' },
      { x: 2, y: 0, z: 0, entityId: 'b', materialId: '#0000ff' },
      { x: 3, y: 0, z: 0, entityId: 'b', materialId: '#ffffff' },
    ]
    project.colorPolicy = undefined
    project.materials = []
    const samples = collectSceneColorSamples(project)
    const allowedCodes = optimizeMardAllowedCodes(samples, 2)
    const mapped = remapProjectToSceneColorPolicy(project, { ...createDefaultSceneColorPolicy(), maxColors: 2, allowedCodes })
    expect(new Set(mapped.customVoxels.map((voxel) => voxel.materialId)).size).toBeLessThanOrEqual(2)
    expect(Object.keys(scenePaletteUsage(mapped).countsByCode).length).toBeLessThanOrEqual(2)
    expect(mapped.customVoxels.every((voxel) => /^#[0-9a-f]{6}$/.test(voxel.sourceColor ?? ''))).toBe(true)
  })

  it('restores source detail when the scene limit is raised', () => {
    const project = makeEmptyProject()
    project.customVoxels = [
      { x: 0, y: 0, z: 0, entityId: 'a', materialId: '#ff0000' },
      { x: 1, y: 0, z: 0, entityId: 'a', materialId: '#00ff00' },
      { x: 2, y: 0, z: 0, entityId: 'a', materialId: '#0000ff' },
    ]
    project.colorPolicy = undefined
    project.materials = []
    const sources = collectSceneColorSamples(project)
    const one = remapProjectToSceneColorPolicy(project, { ...createDefaultSceneColorPolicy(), maxColors: 1, allowedCodes: optimizeMardAllowedCodes(sources, 1) })
    expect(new Set(one.customVoxels.map((voxel) => voxel.materialId)).size).toBe(1)
    const three = remapProjectToSceneColorPolicy(one, { ...createDefaultSceneColorPolicy(), maxColors: 3, allowedCodes: optimizeMardAllowedCodes(collectSceneColorSamples(one), 3) })
    expect(new Set(three.customVoxels.map((voxel) => voxel.materialId)).size).toBe(3)
  })
})
