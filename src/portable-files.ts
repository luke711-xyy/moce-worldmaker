import { MoceSceneFile, parseSceneFile } from './scene-file'
import { AssetAssembly, SceneAssembly, SceneEntityPart, Voxel, VoxelAsset, ProjectState, makeAssetFromSceneParts, normalizeAssetCategoryPath, scenePartVoxels, voxelBounds } from './voxel'

export const MOCE_ASSET_FORMAT = 'moce-asset' as const
export const MOCE_ENTITY_FORMAT = 'moce-entity' as const
export const MOCE_PORTABLE_FORMAT_VERSION = 1 as const

export type MoceAssetFile = {
  format: typeof MOCE_ASSET_FORMAT
  formatVersion: typeof MOCE_PORTABLE_FORMAT_VERSION
  assets: VoxelAsset[]
  categories: string[][]
}

export type PortableEntity = {
  id: string
  name: string
  gridPosition: { x: number; y: number; z: number }
  sourceMemberKeys: string[]
  asset: VoxelAsset
}

export type PortableEntityAssembly = Pick<SceneAssembly, 'id' | 'name' | 'memberKeys' | 'nameMode'> & {
  parentAssemblyId?: string
}

export type MoceEntityFile = {
  format: typeof MOCE_ENTITY_FORMAT
  formatVersion: typeof MOCE_PORTABLE_FORMAT_VERSION
  name: string
  entities: PortableEntity[]
  assemblies: PortableEntityAssembly[]
}

export type MocePortableFile = MoceSceneFile | MoceAssetFile | MoceEntityFile

export class PortableFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortableFileError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new PortableFileError(`${label}必须是对象`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PortableFileError(`${label}必须是非空字符串`)
  return value
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new PortableFileError(`${label}必须是整数`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new PortableFileError(`${label}必须是数组`)
  return value
}

function validateVoxel(value: unknown, label: string) {
  const voxel = object(value, label)
  integer(voxel.x, `${label}.x`)
  integer(voxel.y, `${label}.y`)
  integer(voxel.z, `${label}.z`)
  text(voxel.materialId, `${label}.materialId`)
  if (voxel.paintMaterialId !== undefined) text(voxel.paintMaterialId, `${label}.paintMaterialId`)
  if (voxel.shape !== undefined && (typeof voxel.shape !== 'string' || !['cube', 'tri-prism', 'quarter-cylinder', 'stair'].includes(voxel.shape))) throw new PortableFileError(`${label}.shape无效`)
  if (voxel.facing !== undefined && (typeof voxel.facing !== 'string' || !['+x', '-x', '+y', '-y', '+z', '-z'].includes(voxel.facing))) throw new PortableFileError(`${label}.facing无效`)
  if (voxel.rotation !== undefined && (typeof voxel.rotation !== 'number' || ![0, 1, 2, 3].includes(voxel.rotation))) throw new PortableFileError(`${label}.rotation无效`)
  if (voxel.neighborMask !== undefined && (typeof voxel.neighborMask !== 'number' || !Number.isInteger(voxel.neighborMask) || voxel.neighborMask < 0 || voxel.neighborMask > 63)) throw new PortableFileError(`${label}.neighborMask无效`)
  if (voxel.variantId !== undefined) text(voxel.variantId, `${label}.variantId`)
}

function validateAsset(value: unknown, label: string): asserts value is VoxelAsset {
  const asset = object(value, label)
  text(asset.id, `${label}.id`)
  text(asset.name, `${label}.name`)
  text(asset.style, `${label}.style`)
  text(asset.kind, `${label}.kind`)
  text(asset.color, `${label}.color`)
  text(asset.accent, `${label}.accent`)
  for (const dimension of ['width', 'depth', 'height'] as const) {
    const size = integer(asset[dimension], `${label}.${dimension}`)
    if (size < 1) throw new PortableFileError(`${label}.${dimension}必须是正整数`)
  }
  array(asset.parts ?? [], `${label}.parts`).forEach((part, index) => text(part, `${label}.parts[${index}]`))
  array(asset.voxels, `${label}.voxels`).forEach((voxel, index) => validateVoxel(voxel, `${label}.voxels[${index}]`))
  if (asset.partVoxels !== undefined) {
    const partVoxels = object(asset.partVoxels, `${label}.partVoxels`)
    Object.entries(partVoxels).forEach(([partId, voxels]) => array(voxels, `${label}.partVoxels.${partId}`).forEach((voxel, index) => validateVoxel(voxel, `${label}.partVoxels.${partId}[${index}]`)))
  }
  if (asset.categoryPath !== undefined) array(asset.categoryPath, `${label}.categoryPath`).forEach((part, index) => text(part, `${label}.categoryPath[${index}]`))
}

function validateAssetFile(value: unknown): asserts value is MoceAssetFile {
  const file = object(value, '资产库实体文件')
  if (file.format !== MOCE_ASSET_FORMAT) throw new PortableFileError('文件不是莫测造境资产库实体文件')
  if (file.formatVersion !== MOCE_PORTABLE_FORMAT_VERSION) throw new PortableFileError(`不支持的资产文件版本：${String(file.formatVersion)}`)
  const assets = array(file.assets, 'assets')
  const ids = new Set<string>()
  assets.forEach((asset, index) => {
    validateAsset(asset, `assets[${index}]`)
    if (ids.has(asset.id)) throw new PortableFileError(`assets中存在重复实体ID：${asset.id}`)
    ids.add(asset.id)
  })
  array(file.categories, 'categories').forEach((path, index) => array(path, `categories[${index}]`).forEach((segment, segmentIndex) => text(segment, `categories[${index}][${segmentIndex}]`)))
}

function validateEntityFile(value: unknown): asserts value is MoceEntityFile {
  const file = object(value, '普通实体文件')
  if (file.format !== MOCE_ENTITY_FORMAT) throw new PortableFileError('文件不是莫测造境普通实体文件')
  if (file.formatVersion !== MOCE_PORTABLE_FORMAT_VERSION) throw new PortableFileError(`不支持的实体文件版本：${String(file.formatVersion)}`)
  text(file.name, 'name')
  const entities = array(file.entities, 'entities')
  const ids = new Set<string>()
  entities.forEach((entity, index) => {
    const item = object(entity, `entities[${index}]`)
    const entityId = text(item.id, `entities[${index}].id`)
    text(item.name, `entities[${index}].name`)
    if (ids.has(entityId)) throw new PortableFileError(`entities中存在重复实体ID：${entityId}`)
    ids.add(entityId)
    const position = object(item.gridPosition, `entities[${index}].gridPosition`)
    integer(position.x, `entities[${index}].gridPosition.x`)
    integer(position.y, `entities[${index}].gridPosition.y`)
    integer(position.z, `entities[${index}].gridPosition.z`)
    array(item.sourceMemberKeys, `entities[${index}].sourceMemberKeys`).forEach((key, keyIndex) => text(key, `entities[${index}].sourceMemberKeys[${keyIndex}]`))
    validateAsset(item.asset, `entities[${index}].asset`)
  })
  const assemblyIds = new Set<string>()
  array(file.assemblies, 'assemblies').forEach((assembly, index) => {
    const item = object(assembly, `assemblies[${index}]`)
    const assemblyId = text(item.id, `assemblies[${index}].id`)
    if (assemblyIds.has(assemblyId)) throw new PortableFileError(`assemblies中存在重复装配体ID：${assemblyId}`)
    assemblyIds.add(assemblyId)
    array(item.memberKeys, `assemblies[${index}].memberKeys`).forEach((key, keyIndex) => text(key, `assemblies[${index}].memberKeys[${keyIndex}]`))
  })
}

function uniqueCategories(assets: VoxelAsset[], categories: string[][]): string[][] {
  const output = new Map<string, string[]>()
  for (const path of [...categories, ...assets.map((asset) => normalizeAssetCategoryPath(asset.categoryPath))]) {
    const normalized = normalizeAssetCategoryPath(path)
    for (let index = 1; index <= normalized.length; index += 1) {
      const prefix = normalized.slice(0, index)
      output.set(prefix.join('\u001f'), prefix)
    }
  }
  return [...output.values()]
}

export function createAssetFile(assets: VoxelAsset[], categories: string[][] = []): MoceAssetFile {
  const snapshots = structuredClone(assets).map((asset) => ({ ...asset, isTemplate: true }))
  return {
    format: MOCE_ASSET_FORMAT,
    formatVersion: MOCE_PORTABLE_FORMAT_VERSION,
    assets: snapshots,
    categories: uniqueCategories(snapshots, categories),
  }
}

function partMatchesMemberKey(part: SceneEntityPart, storedKey: string): boolean {
  return part.memberKey === storedKey || (storedKey.startsWith('asset:') && part.memberKey.startsWith(`${storedKey}:`))
}

export function createEntityFile(project: ProjectState, parts: SceneEntityPart[], name = '莫测造境实体', voxelColorResolver?: (voxel: Voxel, part: SceneEntityPart) => string) : MoceEntityFile {
  const groups = new Map<string, SceneEntityPart[]>()
  parts.forEach((part) => {
    // Each scene file-tree part is a portable entity. Do not collapse parts by
    // instanceId: an instance may contain several independent scene entities,
    // and collapsing them loses both their names and their spatial relation.
    const key = `part:${part.id}`
    groups.set(key, [...(groups.get(key) ?? []), part])
  })
  const entities: PortableEntity[] = []
  const groupMemberKeys = new Map<string, string[]>()
  for (const [groupKey, groupParts] of groups) {
    // A portable entity must carry the final displayed color, not only the
    // material key used by the source scene. Material keys can resolve to a
    // different palette after import, while paintMaterialId also supports
    // per-voxel colors. Keep the original materialId for compatibility and
    // write the resolved display color into paintMaterialId when a caller
    // provides the scene renderer's color resolver.
    const exportParts = voxelColorResolver
      ? groupParts.map((part) => ({
        ...part,
        sceneOffset: undefined,
        voxels: scenePartVoxels(part).map((voxel) => {
          const color = voxelColorResolver(voxel, part)
          return /^#[0-9a-f]{6}$/i.test(color)
            ? { ...voxel, paintMaterialId: color }
            : voxel
        }),
      }))
      : groupParts
    const sourceVoxels = exportParts.flatMap((part) => scenePartVoxels(part))
    if (!sourceVoxels.length) continue
    const bounds = voxelBounds(sourceVoxels)!
    const minX = bounds.min.x
    const minY = bounds.min.y
    const minZ = bounds.min.z
    const entityId = `entity-${entities.length + 1}`
    const first = groupParts[0]
    const entityName = first ? (first.displayLabel ?? first.label ?? (first.kind === 'custom' ? '手动体素实体' : '场景实体')) : '场景实体'
    const sourceAsset = first?.instanceId
      ? project.assets.find((asset) => asset.id === project.instances.find((instance) => instance.id === first.instanceId)?.assetId)
      : undefined
    const entityColor = first?.colorOverride ?? project.customColors?.[first?.partId ?? ''] ?? sourceAsset?.templateColor ?? sourceAsset?.color ?? '#6c827d'
    const asset = makeAssetFromSceneParts(entityId, entityName, exportParts, entityColor, sourceAsset?.accent ?? '#d2a354')
    asset.templateColor = entityColor
    const partVoxels: Record<string, Voxel[]> = {}
    exportParts.forEach((part, index) => {
      partVoxels[`part-${index + 1}`] = scenePartVoxels(part).map((voxel) => ({ ...voxel, x: voxel.x - minX, y: voxel.y - minY, z: voxel.z - minZ }))
    })
    asset.parts = Object.keys(partVoxels)
    asset.partVoxels = partVoxels
    asset.source = '普通实体文件'
    asset.isTemplate = false
    entities.push({ id: entityId, name: entityName, gridPosition: { x: minX, y: minY, z: minZ }, sourceMemberKeys: [...new Set(groupParts.map((part) => part.memberKey))], asset })
    groupMemberKeys.set(groupKey, groupParts.map((part) => part.memberKey))
  }

  const selectedMemberKeys = new Set(entities.flatMap((entity) => entity.sourceMemberKeys))
  const selectedAssemblyIds = new Set(parts.flatMap((part) => part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])))
  const assemblyMap = new Map((project.assemblies ?? []).map((assembly) => [assembly.id, assembly]))
  const entityForMemberKey = (memberKey: string) => entities.find((entity) => entity.sourceMemberKeys.some((sourceKey) => sourceKey === memberKey || (memberKey.startsWith('asset:') && sourceKey.startsWith(`${memberKey}:`))))
  const assemblies: PortableEntityAssembly[] = []
  for (const sourceId of selectedAssemblyIds) {
    const source = assemblyMap.get(sourceId)
    if (!source) continue
    const memberKeys = [...new Set(source.memberKeys.flatMap((memberKey) => {
      if (memberKey.startsWith('assembly:')) return selectedAssemblyIds.has(memberKey.slice('assembly:'.length)) ? [memberKey] : []
      const entity = entityForMemberKey(memberKey)
      return entity ? [`entity:${entity.id}`] : []
    }))]
    if (memberKeys.length < 2) continue
    assemblies.push({ id: source.id, name: source.name, nameMode: source.nameMode, parentAssemblyId: source.parentAssemblyId, memberKeys })
  }
  // Keep the complete selected assembly graph even when several entities are
  // exported. Import uses this graph to reconstruct nested and sibling
  // assemblies instead of turning the batch into one synthetic entity.
  return { format: MOCE_ENTITY_FORMAT, formatVersion: MOCE_PORTABLE_FORMAT_VERSION, name, entities, assemblies }
}

export function parseAssetFile(value: unknown): MoceAssetFile {
  validateAssetFile(value)
  return structuredClone(value)
}

export function parseEntityFile(value: unknown): MoceEntityFile {
  validateEntityFile(value)
  const entityIds = new Set(value.entities.map((entity) => entity.id))
  const assemblyIds = new Set(value.assemblies.map((assembly) => assembly.id))
  for (const assembly of value.assemblies) {
    for (const memberKey of assembly.memberKeys) {
      if (memberKey.startsWith('entity:') && !entityIds.has(memberKey.slice('entity:'.length))) throw new PortableFileError(`装配体引用了不存在的实体：${memberKey}`)
      if (memberKey.startsWith('assembly:') && !assemblyIds.has(memberKey.slice('assembly:'.length))) throw new PortableFileError(`装配体引用了不存在的子装配体：${memberKey}`)
    }
  }
  return structuredClone(value)
}

export function parsePortableFile(value: unknown): MocePortableFile {
  const format = isPlainObject(value) ? value.format : undefined
  if (format === 'moce-scene') return parseSceneFile(value)
  if (format === MOCE_ASSET_FORMAT) return parseAssetFile(value)
  if (format === MOCE_ENTITY_FORMAT) return parseEntityFile(value)
  throw new PortableFileError('无法识别文件类型：请使用 .moceworld、.moceasset 或 .moceentity 文件')
}

export function parsePortableFileText(textValue: string): MocePortableFile {
  let value: unknown
  try {
    value = JSON.parse(textValue)
  } catch {
    throw new PortableFileError('文件不是有效的JSON')
  }
  return parsePortableFile(value)
}
