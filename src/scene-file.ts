import { DEFAULT_VOXEL_SIZE_MM, MAX_VOXEL_SIZE_MM, MIN_VOXEL_SIZE_MM, ProjectState, SceneAssembly, SceneBounds, SceneInstance, Voxel, VoxelAsset, VoxelOverride, normalizeVoxelSizeMm, sceneBoundsForProject } from './voxel'

export const MOCE_SCENE_FORMAT = 'moce-scene' as const
export const MOCE_SCENE_FORMAT_VERSION = 1 as const

export type PortableSceneState = Omit<ProjectState, 'assets'>

export type MoceSceneFile = {
  format: typeof MOCE_SCENE_FORMAT
  formatVersion: typeof MOCE_SCENE_FORMAT_VERSION
  scene: PortableSceneState
  sceneAssets: VoxelAsset[]
}

export class SceneFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SceneFileError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new SceneFileError(`${label}必须是对象`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new SceneFileError(`${label}必须是非空字符串`)
  return value
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SceneFileError(`${label}必须是有效数字`)
  return value
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new SceneFileError(`${label}必须是数组`)
  return value
}

function validateVoxel(value: unknown, label: string, allowMode = false): asserts value is Voxel | VoxelOverride {
  const voxel = requirePlainObject(value, label)
  for (const axis of ['x', 'y', 'z'] as const) {
    const coordinate = requireNumber(voxel[axis], `${label}.${axis}`)
    if (!Number.isInteger(coordinate)) throw new SceneFileError(`${label}.${axis}必须是整数`)
  }
  requireString(voxel.materialId, `${label}.materialId`)
  if (voxel.entityId !== undefined) requireString(voxel.entityId, `${label}.entityId`)
  if (allowMode && voxel.mode !== undefined && voxel.mode !== 'add' && voxel.mode !== 'remove') throw new SceneFileError(`${label}.mode无效`)
}

function validateAsset(value: unknown, index: number): asserts value is VoxelAsset {
  const asset = requirePlainObject(value, `sceneAssets[${index}]`)
  requireString(asset.id, `sceneAssets[${index}].id`)
  requireString(asset.name, `sceneAssets[${index}].name`)
  requireString(asset.style, `sceneAssets[${index}].style`)
  requireString(asset.kind, `sceneAssets[${index}].kind`)
  requireString(asset.color, `sceneAssets[${index}].color`)
  requireString(asset.accent, `sceneAssets[${index}].accent`)
  for (const dimension of ['width', 'depth', 'height'] as const) {
    const size = requireNumber(asset[dimension], `sceneAssets[${index}].${dimension}`)
    if (!Number.isInteger(size) || size < 1) throw new SceneFileError(`sceneAssets[${index}].${dimension}必须是正整数`)
  }
  const voxels = requireArray(asset.voxels, `sceneAssets[${index}].voxels`)
  voxels.forEach((voxel, voxelIndex) => validateVoxel(voxel, `sceneAssets[${index}].voxels[${voxelIndex}]`))
  if (asset.parts !== undefined) requireArray(asset.parts, `sceneAssets[${index}].parts`).forEach((part, partIndex) => requireString(part, `sceneAssets[${index}].parts[${partIndex}]`))
  if (asset.partVoxels !== undefined) {
    const partVoxels = requirePlainObject(asset.partVoxels, `sceneAssets[${index}].partVoxels`)
    Object.entries(partVoxels).forEach(([partId, part]) => requireArray(part, `sceneAssets[${index}].partVoxels.${partId}`).forEach((voxel, voxelIndex) => validateVoxel(voxel, `sceneAssets[${index}].partVoxels.${partId}[${voxelIndex}]`)))
  }
}

function validateSceneState(value: unknown): asserts value is PortableSceneState {
  const scene = requirePlainObject(value, 'scene')
  if (scene.version !== 1) throw new SceneFileError('scene.version不受支持')
  requireString(scene.name, 'scene.name')
  const voxelSizeMm = requireNumber(scene.voxelSizeMm, 'scene.voxelSizeMm')
  if (voxelSizeMm < MIN_VOXEL_SIZE_MM || voxelSizeMm > MAX_VOXEL_SIZE_MM) throw new SceneFileError(`scene.voxelSizeMm必须在${MIN_VOXEL_SIZE_MM}到${MAX_VOXEL_SIZE_MM}mm之间`)
  requireNumber(scene.sceneSizeCm, 'scene.sceneSizeCm')
  const bounds = requirePlainObject(scene.sceneBounds, 'scene.sceneBounds') as unknown as SceneBounds
  for (const axis of ['x', 'y', 'z'] as const) {
    const size = requireNumber(bounds[axis], `scene.sceneBounds.${axis}`)
    if (!Number.isInteger(size) || size < 1) throw new SceneFileError(`scene.sceneBounds.${axis}必须是正整数`)
  }
  requireArray(scene.materials, 'scene.materials').forEach((material, index) => {
    const item = requirePlainObject(material, `scene.materials[${index}]`)
    requireString(item.id, `scene.materials[${index}].id`)
    requireString(item.name, `scene.materials[${index}].name`)
    requireString(item.color, `scene.materials[${index}].color`)
  })
  const instances = requireArray(scene.instances, 'scene.instances') as SceneInstance[]
  instances.forEach((instance, index) => {
    const item = requirePlainObject(instance, `scene.instances[${index}]`)
    requireString(item.id, `scene.instances[${index}].id`)
    requireString(item.assetId, `scene.instances[${index}].assetId`)
    for (const field of ['x', 'y', 'z', 'rotation'] as const) if (item[field] !== undefined) requireNumber(item[field], `scene.instances[${index}].${field}`)
    requireString(item.style, `scene.instances[${index}].style`)
    if (typeof item.visible !== 'boolean') throw new SceneFileError(`scene.instances[${index}].visible必须是布尔值`)
    requireArray(item.overrides, `scene.instances[${index}].overrides`).forEach((voxel, voxelIndex) => validateVoxel(voxel, `scene.instances[${index}].overrides[${voxelIndex}]`, true))
  })
  requireArray(scene.customVoxels, 'scene.customVoxels').forEach((voxel, index) => validateVoxel(voxel, `scene.customVoxels[${index}]`))
  if (scene.customEntityOffsets !== undefined) {
    const offsets = requirePlainObject(scene.customEntityOffsets, 'scene.customEntityOffsets')
    Object.entries(offsets).forEach(([entityId, offset]) => {
      const item = requirePlainObject(offset, `scene.customEntityOffsets.${entityId}`)
      for (const axis of ['x', 'y', 'z'] as const) {
        const value = requireNumber(item[axis], `scene.customEntityOffsets.${entityId}.${axis}`)
        if (!Number.isInteger(value)) throw new SceneFileError(`scene.customEntityOffsets.${entityId}.${axis}必须是整数`)
      }
    })
  }
  if (scene.customEntitySources !== undefined) {
    const sources = requirePlainObject(scene.customEntitySources, 'scene.customEntitySources')
    Object.entries(sources).forEach(([entityId, source]) => {
      const item = requirePlainObject(source, `scene.customEntitySources.${entityId}`)
      requireString(item.assetId, `scene.customEntitySources.${entityId}.assetId`)
      if (item.categoryPath !== undefined) requireArray(item.categoryPath, `scene.customEntitySources.${entityId}.categoryPath`).forEach((value, index) => requireString(value, `scene.customEntitySources.${entityId}.categoryPath[${index}]`))
    })
  }
  if (scene.assemblies !== undefined) requireArray(scene.assemblies, 'scene.assemblies').forEach((assembly, index) => {
    const item = requirePlainObject(assembly, `scene.assemblies[${index}]`) as SceneAssembly
    requireString(item.id, `scene.assemblies[${index}].id`)
    requireArray(item.memberKeys, `scene.assemblies[${index}].memberKeys`).forEach((key, keyIndex) => requireString(key, `scene.assemblies[${index}].memberKeys[${keyIndex}]`))
  })
}

function validatePortableSceneFile(value: unknown): asserts value is MoceSceneFile {
  const file = requirePlainObject(value, '场景文件')
  if (file.format !== MOCE_SCENE_FORMAT) throw new SceneFileError('文件不是莫测造境场景文件')
  if (file.formatVersion !== MOCE_SCENE_FORMAT_VERSION) throw new SceneFileError(`不支持的场景文件版本：${String(file.formatVersion)}`)
  validateSceneState(file.scene)
  const assets = requireArray(file.sceneAssets, 'sceneAssets')
  const ids = new Set<string>()
  assets.forEach((asset, index) => {
    validateAsset(asset, index)
    if (ids.has(asset.id)) throw new SceneFileError(`sceneAssets中存在重复资产ID：${asset.id}`)
    ids.add(asset.id)
  })
  const scene = file.scene as PortableSceneState
  scene.instances.forEach((instance) => {
    if (!ids.has(instance.assetId)) throw new SceneFileError(`场景实例引用了未包含的资产：${instance.assetId}`)
  })
}

function isLegacyProject(value: unknown): value is ProjectState {
  if (!isPlainObject(value)) return false
  return value.version === 1 && typeof value.name === 'string' && Array.isArray(value.assets) && Array.isArray(value.instances) && Array.isArray(value.customVoxels)
}

export function createSceneFile(project: ProjectState): MoceSceneFile {
  const usedAssetIds = new Set(project.instances.map((instance) => instance.assetId))
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]))
  const missingAssetId = project.instances.find((instance) => !assetsById.has(instance.assetId))?.assetId
  if (missingAssetId) throw new SceneFileError(`当前场景引用了不存在的资产：${missingAssetId}`)
  // Do not clone the global asset library as part of the scene snapshot. A
  // library can contain several large imported models that are not used by
  // this scene; cloning them here only to discard them below made Save and
  // page-exit recovery scale with the whole library instead of this scene.
  const { assets: _assets, ...sceneSource } = project
  const scene = structuredClone(sceneSource) as PortableSceneState
  // Keep the historical asset-library order so exported scene files remain
  // stable for callers that display or diff their embedded dependencies.
  const sceneAssets = project.assets
    .filter((asset) => usedAssetIds.has(asset.id))
    .map((asset) => ({ ...structuredClone(asset), isTemplate: false }))
  scene.voxelSizeMm = normalizeVoxelSizeMm(scene.voxelSizeMm ?? DEFAULT_VOXEL_SIZE_MM)
  scene.sceneBounds = scene.sceneBounds ?? sceneBoundsForProject(project)
  scene.materials = scene.materials ?? []
  scene.customVoxels = scene.customVoxels ?? []
  scene.instances = scene.instances.map((instance) => ({ ...instance, y: instance.y ?? 0, overrides: instance.overrides ?? [], partOffsets: instance.partOffsets ?? {} }))
  scene.customColors = scene.customColors ?? {}
  scene.assemblies = scene.assemblies ?? []
  return {
    format: MOCE_SCENE_FORMAT,
    formatVersion: MOCE_SCENE_FORMAT_VERSION,
    scene,
    sceneAssets,
  }
}

export function restoreProject(sceneFile: MoceSceneFile): ProjectState {
  validatePortableSceneFile(sceneFile)
  return {
    ...structuredClone(sceneFile.scene),
    assets: structuredClone(sceneFile.sceneAssets).map((asset) => ({ ...asset, isTemplate: false })),
  }
}

export function parseSceneFile(value: unknown): MoceSceneFile {
  if (isPlainObject(value) && value.format !== undefined) {
    validatePortableSceneFile(value)
    return structuredClone(value)
  }
  if (isLegacyProject(value)) {
    return createSceneFile(value)
  }
  throw new SceneFileError('文件缺少有效的莫测造境场景格式标识')
}

export function parseSceneFileText(text: string): MoceSceneFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SceneFileError('文件不是有效的JSON')
  }
  return parseSceneFile(parsed)
}

export function sceneContentSignature(project: ProjectState): string {
  // Dirty-state checks run after every scene commit, including a transform
  // only move. Serializing a portable scene here used to structured-clone all
  // imported voxel arrays on every release, which made large entities pause
  // the UI for seconds. The portable file path still uses createSceneFile;
  // this signature only needs deterministic content equality.
  const arraySignatureCache = sceneSignatureArrayCache
  const signatureForArray = (values: unknown[]): string => {
    const cached = arraySignatureCache.get(values)
    if (cached) return cached
    const signature = JSON.stringify(values)
    arraySignatureCache.set(values, signature)
    return signature
  }
  const assetSignatures = project.assets
    .filter((asset) => project.instances.some((instance) => instance.assetId === asset.id))
    .map((asset) => [asset.id, signatureForAsset(asset)] as const)
  const { assets: _assets, materials, customVoxels, ...scene } = project
  return JSON.stringify({
    scene: {
      ...scene,
      instances: project.instances.map((instance) => ({ ...instance, y: instance.y ?? 0, overrides: instance.overrides ?? [], partOffsets: instance.partOffsets ?? {} })),
      materials: signatureForArray(materials),
      customVoxels: signatureForArray(customVoxels),
    },
    sceneAssets: assetSignatures,
  })
}

const sceneSignatureArrayCache = new WeakMap<object, string>()
const sceneSignatureAssetCache = new WeakMap<object, string>()

function signatureForAsset(asset: VoxelAsset): string {
  const cached = sceneSignatureAssetCache.get(asset)
  if (cached) return cached
  const signature = JSON.stringify(asset)
  sceneSignatureAssetCache.set(asset, signature)
  return signature
}
