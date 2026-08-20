import { describe, expect, it } from 'vitest'
import { createAssetFile, createEntityFile, parseAssetFile, parseEntityFile, parsePortableFileText, PortableFileError } from './portable-files'
import { makeDefaultProject, makeEmptyProject, sceneEntityParts } from './voxel'

describe('莫测造境实体传播文件', () => {
  it('保存资产库实体及其类别树，并可往返解析', () => {
    const project = makeDefaultProject()
    const asset = { ...project.assets[0], categoryPath: ['建筑', '希腊风格'], isTemplate: true }
    const file = createAssetFile([asset], [['建筑'], ['建筑', '希腊风格']])
    expect(file.format).toBe('moce-asset')
    expect(file.categories).toEqual([['建筑'], ['建筑', '希腊风格']])
    expect(parseAssetFile(JSON.parse(JSON.stringify(file))).assets[0].categoryPath).toEqual(['建筑', '希腊风格'])
  })

  it('保存普通实体的体素、位置和装配关系', () => {
    const project = makeDefaultProject()
    const parts = sceneEntityParts(project).filter((part) => part.instanceId === project.instances[0].id)
    project.assemblies = [{ id: 'assembly-export', name: '装配体 1', memberKeys: parts.slice(0, 2).map((part) => part.memberKey) }]
    const selected = sceneEntityParts(project).filter((part) => parts.slice(0, 2).some((source) => source.id === part.id))
    const file = createEntityFile(project, selected, '测试实体')
    expect(file.format).toBe('moce-entity')
    expect(file.entities.length).toBeGreaterThan(0)
    expect(file.entities[0].asset.voxels.length).toBeGreaterThan(0)
    expect(file.entities[0].gridPosition).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), z: expect.any(Number) }))
    expect(file.assemblies).toHaveLength(1)
    expect(file.assemblies[0].memberKeys).toEqual(file.entities.slice(0, 2).map((entity) => `entity:${entity.id}`))
    const parsed = parseEntityFile(JSON.parse(JSON.stringify(file)))
    expect(parsed.name).toBe('测试实体')
    expect(parsed.entities).toHaveLength(file.entities.length)
  })

  it('多选没有装配关系的实体时保留独立实体和相对空间关系', () => {
    const project = makeEmptyProject()
    project.customVoxels = [
      { x: -8, y: 0, z: 3, materialId: 'terracotta', entityId: 'entity-left' },
      { x: -4, y: 1, z: 3, materialId: 'jade', entityId: 'entity-right' },
    ]
    const parts = sceneEntityParts(project)
    const file = createEntityFile(project, parts, '两个实体')
    expect(file.entities).toHaveLength(2)
    expect(file.assemblies).toHaveLength(0)
    expect(file.entities.map((entity) => entity.gridPosition)).toEqual([
      { x: -8, y: 0, z: 3 },
      { x: -4, y: 1, z: 3 },
    ])
  })

  it('导出位于不同高度的实体时不会把世界高度重复写入资产局部坐标', () => {
    const project = makeEmptyProject()
    project.customVoxels = [
      { x: 0, y: 5, z: 0, materialId: 'jade', entityId: 'entity-low' },
      { x: 0, y: 9, z: 0, materialId: 'terracotta', entityId: 'entity-high' },
    ]
    const file = createEntityFile(project, sceneEntityParts(project), '上下实体')
    expect(file.entities.map((entity) => entity.gridPosition.y)).toEqual([5, 9])
    expect(file.entities.map((entity) => Math.min(...entity.asset.voxels.map((voxel) => voxel.y)))).toEqual([0, 0])
  })

  it('导出普通实体时保留每个体素的最终显示颜色', () => {
    const project = makeDefaultProject()
    project.customVoxels = [
      { x: 0, y: 0, z: 0, materialId: 'terracotta', entityId: 'color-entity' },
      { x: 1, y: 0, z: 0, materialId: 'jade', entityId: 'color-entity' },
    ]
    const part = sceneEntityParts(project).find((candidate) => candidate.kind === 'custom')
    expect(part).toBeDefined()
    const file = createEntityFile(project, [part!], '彩色实体', (voxel) => voxel.x === 0 ? '#ef6b4d' : '#53c995')
    const voxels = file.entities[0].asset.voxels
    expect(voxels.map((voxel) => voxel.paintMaterialId)).toEqual(['#ef6b4d', '#53c995'])
    expect(parseEntityFile(JSON.parse(JSON.stringify(file))).entities[0].asset.voxels.map((voxel) => voxel.paintMaterialId)).toEqual(['#ef6b4d', '#53c995'])
  })

  it('拒绝把一种实体文件当成另一种格式打开', () => {
    const project = makeDefaultProject()
    const file = createAssetFile([project.assets[0]])
    expect(() => parsePortableFileText(JSON.stringify({ ...file, format: 'moce-entity' }))).toThrow(PortableFileError)
  })
})
