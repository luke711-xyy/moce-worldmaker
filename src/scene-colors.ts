import {
  MARD_221_ENTRIES,
  PaletteEntry,
  SceneColorPolicy,
  WeightedColorSample,
  mardEntryByCode,
  nearestMardEntry,
  normalizeHexColor,
  normalizeSceneColorPolicy,
  paletteColorForMaterialId,
  paletteEntryByMaterialId,
} from './color-palettes'
import { MATERIALS, Material, ProjectState, Voxel, VoxelAsset, voxelEntityId } from './voxel'

const validHex = (value: string | undefined): value is string => Boolean(value && /^#[0-9a-f]{6}$/i.test(value))

export function resolveProjectColorToken(project: Pick<ProjectState, 'materials'>, token: string | undefined, fallback = '#878787'): string {
  const paletteColor = paletteColorForMaterialId(token)
  if (paletteColor) return paletteColor
  if (validHex(token)) return token.toLowerCase()
  return project.materials.find((material) => material.id === token)?.color
    ?? MATERIALS.find((material) => material.id === token)?.color
    ?? fallback
}

export function paletteMaterialsForPolicy(policy: SceneColorPolicy): Material[] {
  const normalized = normalizeSceneColorPolicy(policy)
  return normalized.allowedCodes
    .map((code) => mardEntryByCode(code))
    .filter((entry): entry is PaletteEntry => Boolean(entry))
    .map((entry) => ({ id: entry.materialId, name: entry.name, color: entry.hex }))
}

export function sceneAllowedEntries(project: Pick<ProjectState, 'colorPolicy'>): PaletteEntry[] {
  const policy = normalizeSceneColorPolicy(project.colorPolicy)
  return policy.allowedCodes.map((code) => mardEntryByCode(code)).filter((entry): entry is PaletteEntry => Boolean(entry))
}

export function mapColorToScenePolicy(color: string, policy: SceneColorPolicy): PaletteEntry {
  return nearestMardEntry(normalizeHexColor(color), normalizeSceneColorPolicy(policy).allowedCodes)
}

function currentCustomVoxelColor(project: ProjectState, voxel: Voxel): string {
  if (voxel.sourceColor && validHex(voxel.sourceColor)) return voxel.sourceColor.toLowerCase()
  if (voxel.paintMaterialId) return resolveProjectColorToken(project, voxel.paintMaterialId)
  const entityColor = project.customColors?.[voxelEntityId(voxel)]
  if (entityColor) return resolveProjectColorToken(project, entityColor)
  return resolveProjectColorToken(project, voxel.materialId)
}

export function sourceColorForVoxel(project: ProjectState, voxel: Voxel): string {
  return currentCustomVoxelColor(project, voxel)
}

export function collectSceneColorSamples(project: ProjectState): WeightedColorSample[] {
  const weights = new Map<string, number>()
  for (const voxel of project.customVoxels) {
    const color = normalizeHexColor(currentCustomVoxelColor(project, voxel))
    weights.set(color, (weights.get(color) ?? 0) + 1)
  }
  for (const instance of project.instances) {
    if (instance.colorOverride) {
      const color = normalizeHexColor(resolveProjectColorToken(project, instance.colorOverride))
      weights.set(color, (weights.get(color) ?? 0) + 1)
    }
    for (const override of instance.overrides ?? []) {
      const token = override.sourceColor ?? override.paintMaterialId ?? override.materialId
      const color = normalizeHexColor(resolveProjectColorToken(project, token))
      weights.set(color, (weights.get(color) ?? 0) + 1)
    }
  }
  return [...weights].map(([color, weight]) => ({ color, weight }))
}

export type ScenePaletteUsage = {
  totalVoxels: number
  countsByCode: Record<string, number>
}

export function scenePaletteUsage(project: ProjectState): ScenePaletteUsage {
  const countsByCode: Record<string, number> = {}
  for (const voxel of project.customVoxels) {
    const entry = paletteEntryByMaterialId(voxel.paintMaterialId ?? voxel.materialId)
      ?? mapColorToScenePolicy(currentCustomVoxelColor(project, voxel), normalizeSceneColorPolicy(project.colorPolicy))
    countsByCode[entry.code] = (countsByCode[entry.code] ?? 0) + 1
  }
  return { totalVoxels: project.customVoxels.length, countsByCode }
}

/**
 * Re-map scene-owned geometry while leaving reusable asset-library templates
 * untouched. Source colours travel with voxel records through later geometry
 * transforms, so increasing the scene colour allowance can restore detail.
 */
export function remapProjectToSceneColorPolicy(project: ProjectState, requestedPolicy: SceneColorPolicy): ProjectState {
  const policy = normalizeSceneColorPolicy(requestedPolicy)
  const customVoxels = project.customVoxels.map((voxel) => {
    const sourceColor = normalizeHexColor(currentCustomVoxelColor(project, voxel))
    const entry = mapColorToScenePolicy(sourceColor, policy)
    const { paintMaterialId: _paintMaterialId, ...rest } = voxel
    return { ...rest, materialId: entry.materialId, sourceColor }
  })
  const instances = project.instances.map((instance) => ({
    ...instance,
    colorOverride: instance.colorOverride
      ? mapColorToScenePolicy(resolveProjectColorToken(project, instance.colorOverride), policy).hex
      : instance.colorOverride,
    overrides: (instance.overrides ?? []).map((override) => {
      const sourceColor = normalizeHexColor(resolveProjectColorToken(project, override.sourceColor ?? override.paintMaterialId ?? override.materialId))
      const entry = mapColorToScenePolicy(sourceColor, policy)
      const { paintMaterialId: _paintMaterialId, ...rest } = override
      return { ...rest, materialId: entry.materialId, sourceColor }
    }),
  }))
  return {
    ...project,
    colorPolicy: policy,
    materials: paletteMaterialsForPolicy(policy),
    customVoxels,
    customColors: {},
    instances,
  }
}

/** Migrate a legacy free-colour scene exactly once. */
export function ensureProjectSceneColorPolicy(project: ProjectState): ProjectState {
  if (project.colorPolicy) {
    const colorPolicy = normalizeSceneColorPolicy(project.colorPolicy)
    const allowedMaterialIds = new Set(colorPolicy.allowedCodes.map((code) => mardEntryByCode(code)?.materialId).filter((value): value is string => Boolean(value)))
    const needsRepair = Object.keys(project.customColors ?? {}).length > 0
      || project.customVoxels.some((voxel) => !allowedMaterialIds.has(voxel.materialId) || Boolean(voxel.paintMaterialId) || !validHex(voxel.sourceColor))
      || project.instances.some((instance) => Boolean(instance.colorOverride) || (instance.overrides ?? []).some((override) => !allowedMaterialIds.has(override.materialId) || Boolean(override.paintMaterialId) || !validHex(override.sourceColor)))
    if (needsRepair) return remapProjectToSceneColorPolicy(project, colorPolicy)
    return { ...project, colorPolicy, materials: paletteMaterialsForPolicy(colorPolicy) }
  }
  return remapProjectToSceneColorPolicy(project, normalizeSceneColorPolicy({
    paletteId: 'mard-221',
    maxColors: MARD_221_ENTRIES.length,
    allowedCodes: MARD_221_ENTRIES.map((entry) => entry.code),
  }))
}

export function recolorVoxelsToPaletteEntry(voxels: readonly Voxel[], entry: PaletteEntry): Voxel[] {
  return voxels.map((voxel) => {
    const { paintMaterialId: _paintMaterialId, ...rest } = voxel
    return { ...rest, materialId: entry.materialId, sourceColor: entry.hex }
  })
}

export function remapAssetForScene(project: Pick<ProjectState, 'materials' | 'colorPolicy'>, asset: VoxelAsset): VoxelAsset {
  const policy = normalizeSceneColorPolicy(project.colorPolicy)
  const sourceForVoxel = (voxel: Voxel) => {
    if (validHex(voxel.sourceColor)) return voxel.sourceColor
    if (voxel.paintMaterialId) return resolveProjectColorToken(project, voxel.paintMaterialId)
    if (voxel.materialId === 'primary') return asset.templateColor ?? asset.color
    if (voxel.materialId === 'accent') return asset.accent
    return resolveProjectColorToken(project, voxel.materialId, asset.color)
  }
  const remapVoxel = (voxel: Voxel): Voxel => {
    const sourceColor = normalizeHexColor(sourceForVoxel(voxel))
    const entry = mapColorToScenePolicy(sourceColor, policy)
    const { paintMaterialId: _paintMaterialId, ...rest } = voxel
    return { ...rest, materialId: entry.materialId, sourceColor }
  }
  const color = mapColorToScenePolicy(asset.templateColor ?? asset.color, policy).hex
  const accent = mapColorToScenePolicy(asset.accent, policy).hex
  return {
    ...asset,
    color,
    accent,
    templateColor: asset.templateColor ? color : asset.templateColor,
    voxels: asset.voxels.map(remapVoxel),
    partVoxels: asset.partVoxels
      ? Object.fromEntries(Object.entries(asset.partVoxels).map(([partId, voxels]) => [partId, voxels.map(remapVoxel)]))
      : asset.partVoxels,
  }
}
