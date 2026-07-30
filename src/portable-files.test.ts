import { describe, expect, it } from 'vitest'
import { createAssetFile, createEntityFile, parseAssetFile, parseEntityFile, parsePortableFileText, PortableFileError } from './portable-files'
import { makeDefaultProject, sceneEntityParts } from './voxel'

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
    expect(file.assemblies).toEqual([])
    const parsed = parseEntityFile(JSON.parse(JSON.stringify(file)))
    expect(parsed.name).toBe('测试实体')
    expect(parsed.entities).toHaveLength(file.entities.length)
  })

  it('拒绝把一种实体文件当成另一种格式打开', () => {
    const project = makeDefaultProject()
    const file = createAssetFile([project.assets[0]])
    expect(() => parsePortableFileText(JSON.stringify({ ...file, format: 'moce-entity' }))).toThrow(PortableFileError)
  })
})
