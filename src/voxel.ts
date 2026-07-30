export type Material = {
  id: string
  name: string
  color: string
}

export type Voxel = {
  x: number
  y: number
  z: number
  materialId: string
  entityId?: string
}

export type VoxelNormal = Pick<Voxel, 'x' | 'y' | 'z'>

export type VoxelOverride = Voxel & {
  // Missing mode is treated as an additive override for older project files.
  mode?: 'add' | 'remove'
}

export type VoxelAsset = {
  id: string
  name: string
  /** Hierarchical asset-library category, from root to leaf. */
  categoryPath?: string[]
  style: string
  kind: 'house' | 'road' | 'public' | 'nature' | 'character' | 'imported'
  color: string
  accent: string
  /** Optional whole-asset color saved by the template editor. */
  templateColor?: string
  width: number
  depth: number
  height: number
  parts: string[]
  partVoxels?: Record<string, Voxel[]>
  voxels: Voxel[]
  source?: string
  assembly?: AssetAssembly
  /** Only template assets appear in the left asset library. */
  isTemplate?: boolean
  /** Stable link back to the template used to create a scene snapshot. */
  templateSourceId?: string
}

export type AssetAssembly = {
  name: string
  rootId: string
  nodes: Array<{ id: string; name: string; memberKeys: string[] }>
}

export type SceneInstance = {
  id: string
  assetId: string
  x: number
  y?: number
  z: number
  rotation: number
  style: string
  visible: boolean
  overrides: VoxelOverride[]
  partOffsets?: Record<string, { x: number; y: number; z: number }>
  colorOverride?: string
  mirror?: { x: boolean; y: boolean; z: boolean }
  rotationX?: number
  rotationY?: number
  rotationZ?: number
}

export type ProjectState = {
  version: 1
  name: string
  voxelSizeMm: 1
  sceneSizeCm: number
  /** Scene envelope in project voxels: X/Y are the ground plane, Z is height. */
  sceneBounds?: SceneBounds
  materials: Material[]
  assets: VoxelAsset[]
  instances: SceneInstance[]
  customVoxels: Voxel[]
  customColors?: Record<string, string>
  entityNames?: Record<string, string>
  entityNameModes?: Record<string, 'auto' | 'custom'>
  entityNameSequences?: Record<string, number>
  entityNameParents?: Record<string, string>
  entitySequenceCounters?: Record<string, number>
  assemblySequence?: number
  assemblyChildSequence?: Record<string, number>
  /** Shared sibling counter for both child entities and child assemblies. */
  childSequenceCounters?: Record<string, number>
  assemblies?: SceneAssembly[]
  lockedMemberKeys?: string[]
}

export const DEFAULT_ASSET_CATEGORY = '未命名类别'

export function normalizeAssetCategoryPath(path: unknown): string[] {
  if (!Array.isArray(path)) return [DEFAULT_ASSET_CATEGORY]
  const normalized = path
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
  return normalized.length ? normalized : [DEFAULT_ASSET_CATEGORY]
}

export type SceneBounds = {
  x: number
  y: number
  z: number
}

export type SceneAssembly = {
  id: string
  name?: string
  memberKeys: string[]
  /** Persistent sibling number used by hierarchical names. */
  sequence?: number
  /** Parent assembly ID when this node is nested. */
  parentAssemblyId?: string
  nameMode?: 'auto' | 'custom'
}

export type SceneEntityPart = {
  id: string
  kind: 'asset' | 'custom'
  instanceId?: string
  partId: string
  memberKey: string
  assemblyId?: string
  /** Assembly path from the nearest child assembly to the outermost parent. */
  assemblyIds?: string[]
  label?: string
  displayLabel?: string
  colorOverride?: string
  voxels: Voxel[]
}

export function uniqueAssetName(assets: VoxelAsset[], requestedName: string): string {
  const baseName = requestedName.trim() || '未命名实体'
  const existing = new Set(assets.map((asset) => asset.name))
  if (!existing.has(baseName)) return baseName
  let index = 2
  while (existing.has(`${baseName} ${index}`)) index += 1
  return `${baseName} ${index}`
}

export function uniqueTemplateAssetName(assets: VoxelAsset[], requestedName: string, excludedAssetId?: string): string {
  const baseName = requestedName.trim() || '未命名实体'
  const existing = new Set(assets.filter((asset) => asset.id !== excludedAssetId).map((asset) => asset.name.trim()))
  if (!existing.has(baseName)) return baseName
  let index = 1
  while (existing.has(`${baseName} (${index})`)) index += 1
  return `${baseName} (${index})`
}

export function makeAssetFromSceneParts(id: string, name: string, parts: SceneEntityPart[], color = '#6c827d', accent = '#d2a354', materialIdResolver?: (voxel: Voxel, part: SceneEntityPart) => string): VoxelAsset {
  const sourceVoxels = parts.flatMap((part) => part.voxels.map((voxel) => ({
    ...voxel,
    materialId: materialIdResolver ? materialIdResolver(voxel, part) : voxel.materialId,
  })))
  const minX = Math.min(...sourceVoxels.map((voxel) => voxel.x), 0)
  const minY = Math.min(...sourceVoxels.map((voxel) => voxel.y), 0)
  const minZ = Math.min(...sourceVoxels.map((voxel) => voxel.z), 0)
  const maxX = Math.max(...sourceVoxels.map((voxel) => voxel.x), 0)
  const maxY = Math.max(...sourceVoxels.map((voxel) => voxel.y), 0)
  const maxZ = Math.max(...sourceVoxels.map((voxel) => voxel.z), 0)
  const voxels = deduplicateVoxels(sourceVoxels.map((voxel) => ({
    x: voxel.x - minX,
    y: voxel.y - minY,
    z: voxel.z - minZ,
    materialId: voxel.materialId,
  })))
  return {
    id,
    name,
    style: '自定义实体',
    kind: 'imported',
    color,
    accent,
    width: maxX - minX + 1,
    depth: maxZ - minZ + 1,
    height: maxY - minY + 1,
    parts: parts.map((part, index) => part.kind === 'asset' ? part.partId : `体素模块_${index + 1}`),
    voxels,
    source: '场景实体保存',
    isTemplate: true,
  }
}

// The viewport uses centimeters as its scene-scale unit: 1 scene unit = 1 cm.
// Therefore one project voxel (1 mm) occupies 0.1 viewport units everywhere.
export const WORLD_UNITS_PER_MM = 0.1
export const VOXEL_WORLD_SIZE = WORLD_UNITS_PER_MM

export function sceneBoundsForProject(project: Pick<ProjectState, 'sceneSizeCm' | 'sceneBounds'>): SceneBounds {
  const fallback = Math.max(1, Math.round((project.sceneSizeCm ?? 20) / VOXEL_WORLD_SIZE))
  return {
    x: Math.max(1, Math.round(project.sceneBounds?.x ?? fallback)),
    y: Math.max(1, Math.round(project.sceneBounds?.y ?? fallback)),
    z: Math.max(1, Math.round(project.sceneBounds?.z ?? fallback)),
  }
}

function roundWorld(value: number): number {
  return Number(value.toFixed(3))
}

export function voxelToWorld(value: number): number {
  return roundWorld(value * VOXEL_WORLD_SIZE)
}

export function voxelCenterToWorld(value: number): number {
  return roundWorld((value + 0.5) * VOXEL_WORLD_SIZE)
}

export function worldToVoxel(value: number): number {
  return Math.round(value / VOXEL_WORLD_SIZE)
}

/** Convert a world-space point on the ground into the cell index it falls in. */
export function worldToVoxelCell(value: number): number {
  return Math.floor(value / VOXEL_WORLD_SIZE)
}

/** Convert a world-space voxel center back into its integer cell index. */
export function worldToVoxelCenter(value: number): number {
  return Math.round(value / VOXEL_WORLD_SIZE - 0.5)
}

/**
 * Return the canonical origin for an asset whose bounding box must land on
 * integer ground-grid boundaries. Odd-sized assets have a half-cell origin;
 * even-sized assets have an integer origin.
 */
export function snapAssetOrigin(value: number, dimension: number): number {
  const halfCell = dimension % 2 ? VOXEL_WORLD_SIZE / 2 : 0
  return roundWorld((Math.round((value - halfCell) / VOXEL_WORLD_SIZE) * VOXEL_WORLD_SIZE) + halfCell)
}

export function assetOriginGridCoordinate(value: number, dimension: number): number {
  const halfCell = dimension % 2 ? 0.5 : 0
  return Math.round(value / VOXEL_WORLD_SIZE - halfCell)
}

export function snapWorld(value: number): number {
  return Number((Math.round(value / VOXEL_WORLD_SIZE) * VOXEL_WORLD_SIZE).toFixed(3))
}

export function highestVoxelAt(voxels: Voxel[], x: number, z: number): Voxel | undefined {
  return voxels
    .filter((voxel) => voxel.x === x && voxel.z === z)
    .reduce<Voxel | undefined>((highest, voxel) => (!highest || voxel.y > highest.y ? voxel : highest), undefined)
}

export function nextVoxelY(voxels: Voxel[], x: number, z: number): number {
  const highest = highestVoxelAt(voxels, x, z)
  return highest ? highest.y + 1 : 0
}

export function adjacentVoxel(voxel: Voxel, normal: VoxelNormal, materialId = voxel.materialId): Voxel {
  const components = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)]
  const axis = components.indexOf(Math.max(...components))
  const direction = [normal.x, normal.y, normal.z][axis] >= 0 ? 1 : -1
  const next = { x: voxel.x, y: voxel.y, z: voxel.z }
  if (axis === 0) next.x += direction
  if (axis === 1) next.y += direction
  if (axis === 2) next.z += direction
  return { ...next, materialId }
}

function voxelKey(voxel: Pick<Voxel, 'x' | 'y' | 'z'>): string {
  return `${voxel.x},${voxel.y},${voxel.z}`
}

export function voxelEntityId(voxel: Voxel): string {
  return voxel.entityId ?? `legacy:${voxelKey(voxel)}`
}

const voxelNeighbors = (voxel: Pick<Voxel, 'x' | 'y' | 'z'>): Array<[number, number, number]> => [
  [voxel.x + 1, voxel.y, voxel.z],
  [voxel.x - 1, voxel.y, voxel.z],
  [voxel.x, voxel.y + 1, voxel.z],
  [voxel.x, voxel.y - 1, voxel.z],
  [voxel.x, voxel.y, voxel.z + 1],
  [voxel.x, voxel.y, voxel.z - 1],
]

export function voxelComponentAt(voxels: Voxel[], origin: Pick<Voxel, 'x' | 'y' | 'z'>): Voxel[] {
  const byKey = new Map(voxels.map((voxel) => [voxelKey(voxel), voxel]))
  const start = byKey.get(voxelKey(origin))
  if (!start) return []
  const component: Voxel[] = []
  const queue = [start]
  const visited = new Set<string>()
  while (queue.length) {
    const current = queue.shift()!
    const currentKey = voxelKey(current)
    if (visited.has(currentKey)) continue
    visited.add(currentKey)
    component.push(current)
    for (const [x, y, z] of voxelNeighbors(current)) {
      const key = `${x},${y},${z}`
      const neighbor = byKey.get(key)
      if (neighbor && !visited.has(key)) queue.push(neighbor)
    }
  }
  return component
}

export function voxelComponents(voxels: Voxel[]): Voxel[][] {
  const byKey = new Map(voxels.map((voxel) => [voxelKey(voxel), voxel]))
  const remaining = new Set(byKey.keys())
  const components: Voxel[][] = []
  while (remaining.size) {
    const firstKey = remaining.values().next().value as string
    const component = voxelComponentAt([...byKey.values()], byKey.get(firstKey)!)
    components.push(component)
    component.forEach((voxel) => remaining.delete(voxelKey(voxel)))
  }
  return components
}

export function voxelComponentId(component: Voxel[]): string {
  if (!component.length) return 'empty'
  const first = [...component].sort((a, b) => voxelKey(a).localeCompare(voxelKey(b)))[0]
  return voxelKey(first)
}

export function resolveInstanceVoxels(asset: VoxelAsset, overrides: VoxelOverride[] = []): Voxel[] {
  const resolved = new Map<string, Voxel>(asset.voxels.map((voxel) => [voxelKey(voxel), { ...voxel }]))
  for (const override of overrides) {
    const key = voxelKey(override)
    if (override.mode === 'remove') {
      resolved.delete(key)
    } else {
      resolved.set(key, { x: override.x, y: override.y, z: override.z, materialId: override.materialId })
    }
  }
  return [...resolved.values()]
}

export function resolveInstanceComponents(asset: VoxelAsset, overrides: VoxelOverride[] = []): Array<{ partId: string; voxels: Voxel[] }> {
  const resolved = resolveInstanceVoxels(asset, overrides)
  if (!asset.partVoxels || !Object.keys(asset.partVoxels).length) return voxelComponents(resolved).map((voxels) => ({ partId: voxelComponentId(voxels), voxels }))
  const resolvedByKey = new Map(resolved.map((voxel) => [voxelKey(voxel), voxel]))
  const claimed = new Set<string>()
  const components = Object.entries(asset.partVoxels).flatMap(([partId, sourceVoxels]) => {
    const voxels = sourceVoxels.map((voxel) => resolvedByKey.get(voxelKey(voxel))).filter((voxel): voxel is Voxel => Boolean(voxel))
    voxels.forEach((voxel) => claimed.add(voxelKey(voxel)))
    return voxelComponents(voxels).map((component, index) => ({ partId: index === 0 ? partId : `${partId}#${index + 1}`, voxels: component }))
  }).filter((component) => component.voxels.length > 0)
  const additions = resolved.filter((voxel) => !claimed.has(voxelKey(voxel)))
  if (additions.length) components.push({ partId: voxelComponentId(additions), voxels: additions })
  return components
}

export type VoxelTransformAxis = 'x' | 'y' | 'z'

export function mirrorVoxels(voxels: Voxel[], axis: VoxelTransformAxis): Voxel[] {
  if (!voxels.length) return []
  const values = voxels.map((voxel) => voxel[axis])
  const min = Math.min(...values)
  const max = Math.max(...values)
  return voxels.map((voxel) => ({ ...voxel, [axis]: min + max - voxel[axis] }))
}

export function rotateVoxels(voxels: Voxel[], axis: VoxelTransformAxis, degrees: 90 | 180 | 270): Voxel[] {
  if (!voxels.length) return []
  const minX = Math.min(...voxels.map((voxel) => voxel.x))
  const maxX = Math.max(...voxels.map((voxel) => voxel.x))
  const minY = Math.min(...voxels.map((voxel) => voxel.y))
  const maxY = Math.max(...voxels.map((voxel) => voxel.y))
  const minZ = Math.min(...voxels.map((voxel) => voxel.z))
  const maxZ = Math.max(...voxels.map((voxel) => voxel.z))
  return voxels.map((voxel) => {
    if (degrees === 180) {
      if (axis === 'x') return { ...voxel, y: minY + maxY - voxel.y, z: minZ + maxZ - voxel.z }
      if (axis === 'y') return { ...voxel, x: minX + maxX - voxel.x, z: minZ + maxZ - voxel.z }
      return { ...voxel, x: minX + maxX - voxel.x, y: minY + maxY - voxel.y }
    }
    if (axis === 'x') {
      return degrees === 90
        ? { ...voxel, y: minY + maxZ - voxel.z, z: minZ + voxel.y - minY }
        : { ...voxel, y: minY + voxel.z - minZ, z: minZ + maxY - voxel.y }
    }
    if (axis === 'y') {
      return degrees === 90
        ? { ...voxel, x: minX + voxel.z - minZ, z: minZ + maxX - voxel.x }
        : { ...voxel, x: minX + maxZ - voxel.z, z: minZ + voxel.x - minX }
    }
    return degrees === 90
      ? { ...voxel, x: minX + maxY - voxel.y, y: minY + voxel.x - minX }
      : { ...voxel, x: minX + voxel.y - minY, y: minY + maxX - voxel.x }
  })
}

export function findInstanceVoxelAtSceneVoxel(instance: SceneInstance, asset: VoxelAsset, sceneVoxel: Pick<Voxel, 'x' | 'y' | 'z'>): Voxel | undefined {
  return resolveInstanceComponents(asset, instance.overrides ?? []).flatMap(({ partId, voxels }) => {
    const resolvedSceneVoxels = resolveInstanceComponentSceneVoxels(instance, asset, voxels, partId)
    return voxels.filter((_, index) => {
      const voxel = resolvedSceneVoxels[index]
      return voxel.x === sceneVoxel.x && voxel.y === sceneVoxel.y && voxel.z === sceneVoxel.z
    })
  })[0]
}

function rotateSceneVector(vector: { x: number; y: number; z: number }, rotationX: number, rotationY: number, rotationZ: number): { x: number; y: number; z: number } {
  const cx = Math.cos(rotationX)
  const sx = Math.sin(rotationX)
  const cy = Math.cos(rotationY)
  const sy = Math.sin(rotationY)
  const cz = Math.cos(rotationZ)
  const sz = Math.sin(rotationZ)
  const afterX = { x: vector.x, y: cx * vector.y - sx * vector.z, z: sx * vector.y + cx * vector.z }
  const afterY = { x: cy * afterX.x + sy * afterX.z, y: afterX.y, z: -sy * afterX.x + cy * afterX.z }
  return { x: cz * afterY.x - sz * afterY.y, y: sz * afterY.x + cz * afterY.y, z: afterY.z }
}

function resolveInstanceComponentSceneVoxels(instance: SceneInstance, asset: VoxelAsset, component: Voxel[], componentId = voxelComponentId(component), x = instance.x, z = instance.z, y = instance.y ?? 0): Voxel[] {
  const offset = instance.partOffsets?.[componentId] ?? { x: 0, y: 0, z: 0 }
  const mirror = instance.mirror ?? { x: false, y: false, z: false }
  const rotationX = (instance.rotationX ?? 0) * Math.PI / 180
  const rotationY = (instance.rotationY ?? 0) * Math.PI / 180
  const rotationZ = -(instance.rotation + (instance.rotationZ ?? 0)) * Math.PI / 180
  return component.map((voxel) => {
    const localXIndex = mirror.x ? asset.width - 1 - voxel.x : voxel.x
    const localYIndex = mirror.z ? asset.height - 1 - voxel.y : voxel.y
    const localZIndex = mirror.y ? asset.depth - 1 - voxel.z : voxel.z
    const local = rotateSceneVector({
      x: (localXIndex + 0.5 - asset.width / 2) * VOXEL_WORLD_SIZE + (mirror.x ? -offset.x : offset.x),
      y: (localZIndex + 0.5 - asset.depth / 2) * VOXEL_WORLD_SIZE + (mirror.y ? -offset.z : offset.z),
      z: (localYIndex + 0.5) * VOXEL_WORLD_SIZE + (mirror.z ? -offset.y : offset.y),
    }, rotationX, rotationY, rotationZ)
    return {
      ...voxel,
      x: worldToVoxelCenter(x + local.x),
      y: Math.round((local.z + y) / VOXEL_WORLD_SIZE - 0.5),
      z: worldToVoxelCenter(z + local.y),
    }
  })
}

export function resolveInstanceSceneVoxels(instance: SceneInstance, asset: VoxelAsset, x = instance.x, z = instance.z, y = instance.y ?? 0): Voxel[] {
  return resolveInstanceComponents(asset, instance.overrides ?? []).flatMap(({ partId, voxels }) => resolveInstanceComponentSceneVoxels(instance, asset, voxels, partId, x, z, y))
}

/** Convert a voxel returned by an asset mesh raycast from asset-local space to scene space. */
export function instanceLocalVoxelToSceneVoxel(instance: SceneInstance, asset: VoxelAsset, localVoxel: Pick<Voxel, 'x' | 'y' | 'z'>): Voxel | undefined {
  for (const { partId, voxels } of resolveInstanceComponents(asset, instance.overrides ?? [])) {
    const localIndex = voxels.findIndex((voxel) => voxel.x === localVoxel.x && voxel.y === localVoxel.y && voxel.z === localVoxel.z)
    if (localIndex < 0) continue
    return resolveInstanceComponentSceneVoxels(instance, asset, voxels, partId)[localIndex]
  }
  return undefined
}

export function sceneEntityParts(project: ProjectState): SceneEntityPart[] {
  const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
  const assemblies = project.assemblies ?? []
  const memberKeyMatches = (storedKey: string, candidateKey: string) => storedKey === candidateKey || (storedKey.startsWith('asset:') && (candidateKey.startsWith(`${storedKey}:`) || candidateKey.startsWith(`${storedKey}#`)))
  const assemblyPathForMemberKey = (memberKey: string): string[] => {
    let bestPath: string[] = []
    const visit = (key: string, path: string[], seen: Set<string>) => {
      assemblies.forEach((assembly) => {
        if (seen.has(assembly.id) || !assembly.memberKeys.some((storedKey) => memberKeyMatches(storedKey, key))) return
        const nextPath = [...path, assembly.id]
        if (nextPath.length > bestPath.length) bestPath = nextPath
        visit(`assembly:${assembly.id}`, nextPath, new Set([...seen, assembly.id]))
      })
    }
    visit(memberKey, [], new Set())
    return bestPath
  }
  const parts: SceneEntityPart[] = []
  for (const instance of project.instances) {
    if (!instance.visible) continue
    const asset = assetMap.get(instance.assetId)
    if (!asset) continue
    for (const { partId, voxels: component } of resolveInstanceComponents(asset, instance.overrides ?? [])) {
      const sceneVoxels = resolveInstanceComponentSceneVoxels(instance, asset, component, partId)
      const label = partId.split('#')[0]
      const memberKey = `asset:${instance.id}:${partId}`
      const assemblyIds = assemblyPathForMemberKey(memberKey)
      parts.push({ id: `asset:${instance.id}:${partId}`, kind: 'asset', instanceId: instance.id, partId, memberKey, assemblyId: assemblyIds[0], assemblyIds, label, colorOverride: instance.colorOverride, voxels: sceneVoxels })
    }
  }
  const customGroups = new Map<string, Voxel[]>()
  for (const voxel of project.customVoxels) {
    const entityId = voxelEntityId(voxel)
    customGroups.set(entityId, [...(customGroups.get(entityId) ?? []), { ...voxel, entityId }])
  }
  for (const [entityId, voxels] of customGroups) {
    const memberKey = `voxel:${entityId}`
    const assemblyIds = assemblyPathForMemberKey(memberKey)
    parts.push({ id: `custom:${entityId}`, kind: 'custom', partId: entityId, memberKey, assemblyId: assemblyIds[0], assemblyIds, label: '手动体素实体', colorOverride: project.customColors?.[entityId], voxels })
  }
  return parts
}

function automaticAssemblyName(name: string | undefined): boolean {
  const value = name?.trim() ?? ''
  return !value || /^装配体\s+\d+$/.test(value) || /^子装配体\s+\d+(?:-\d+)*$/.test(value)
}

function lastHierarchicalNumber(name: string | undefined): number | undefined {
  const match = name?.trim().match(/(?:^|\s)(\d+(?:-\d+)*)$/)
  if (!match) return undefined
  const last = match[1].split('-').pop()
  const value = Number(last)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function rootAssemblyNumber(name: string | undefined): number | undefined {
  const match = name?.trim().match(/^装配体\s+(\d+)$/)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Persist and normalize the naming scheme used by the scene tree.
 *
 * Root assemblies use `装配体 N`. Their direct children use the root path,
 * e.g. `手动体素实体 N-1` and `子装配体 N-1`; deeper levels append another
 * sibling number. Sibling numbers live in persistent counters so deleting a
 * node never causes a later node to be renumbered.
 */
export function normalizeProjectNaming(project: ProjectState): ProjectState {
  const next = structuredClone(project)
  const assemblies = next.assemblies ?? []
  const assemblyMap = new Map(assemblies.map((assembly) => [assembly.id, assembly]))
  const parentByAssembly = new Map<string, string | undefined>()
  assemblies.forEach((parent) => parent.memberKeys.forEach((memberKey) => {
    if (!memberKey.startsWith('assembly:')) return
    const childId = memberKey.slice('assembly:'.length)
    if (assemblyMap.has(childId) && !parentByAssembly.has(childId)) parentByAssembly.set(childId, parent.id)
  }))

  const usedRootSequences = new Set<number>()
  const usedChildSequences = new Map<string, Set<number>>()
  const childCounters = { ...(next.childSequenceCounters ?? {}) }
  Object.entries(next.assemblyChildSequence ?? {}).forEach(([parentId, counter]) => {
    const key = `assembly:${parentId}`
    childCounters[key] = Math.max(childCounters[key] ?? 1, counter)
  })
  Object.entries(next.entitySequenceCounters ?? {}).forEach(([scope, counter]) => {
    if (scope.startsWith('assembly:')) childCounters[scope] = Math.max(childCounters[scope] ?? 1, counter)
  })
  const pathNumbers = new Map<string, number[]>()
  let nextRootSequence = Math.max(1, next.assemblySequence ?? 1)
  assemblies.forEach((assembly) => {
    const parentId = parentByAssembly.get(assembly.id)
    const scope = parentId ?? 'root'
    const used = parentId ? (usedChildSequences.get(parentId) ?? new Set<number>()) : usedRootSequences
    if (parentId) usedChildSequences.set(parentId, used)
    const priorParent = assembly.parentAssemblyId
    const auto = assembly.nameMode !== 'custom' && (assembly.nameMode === 'auto' || automaticAssemblyName(assembly.name))
    let sequence = Number.isInteger(assembly.sequence) && (assembly.sequence ?? 0) > 0 ? assembly.sequence : undefined
    if (!sequence && auto) sequence = parentId ? lastHierarchicalNumber(assembly.name) : rootAssemblyNumber(assembly.name)
    const parentChanged = priorParent !== parentId
    if (parentChanged && priorParent !== undefined && parentId === undefined) sequence = undefined
    if (parentChanged && priorParent === undefined && parentId !== undefined) {
      sequence = /^子装配体\s+\d+(?:-\d+)*$/.test(assembly.name?.trim() ?? '') ? lastHierarchicalNumber(assembly.name) : undefined
    }
    if (!sequence || used.has(sequence)) {
      if (parentId) {
        const counterKey = `assembly:${parentId}`
        const nextSequence = Math.max(1, childCounters[counterKey] ?? 1, ...used, 0)
        sequence = nextSequence
        childCounters[counterKey] = nextSequence + 1
      } else {
        sequence = Math.max(1, nextRootSequence, ...usedRootSequences, 0)
        nextRootSequence = sequence + 1
      }
    }
    used.add(sequence)
    if (parentId) {
      const counterKey = `assembly:${parentId}`
      childCounters[counterKey] = Math.max(childCounters[counterKey] ?? 1, sequence + 1)
    }
    else nextRootSequence = Math.max(nextRootSequence, sequence + 1)
    assembly.sequence = sequence
    assembly.parentAssemblyId = parentId
    assembly.nameMode = auto ? 'auto' : 'custom'
    const parentPath = parentId ? (pathNumbers.get(parentId) ?? []) : []
    pathNumbers.set(assembly.id, [...parentPath, sequence])
  })

  const unresolved = new Set(assemblies.map((assembly) => assembly.id))
  const visitAssembly = (assemblyId: string, trail = new Set<string>()) => {
    if (!unresolved.has(assemblyId) || trail.has(assemblyId)) return
    const assembly = assemblyMap.get(assemblyId)
    if (!assembly) return
    const parentId = parentByAssembly.get(assemblyId)
    if (parentId && unresolved.has(parentId)) visitAssembly(parentId, new Set([...trail, assemblyId]))
    const path = [...(parentId ? (pathNumbers.get(parentId) ?? []) : []), assembly.sequence ?? 1]
    pathNumbers.set(assemblyId, path)
    if (assembly.nameMode === 'auto') assembly.name = parentId ? `子装配体 ${path.join('-')}` : `装配体 ${path[0]}`
    unresolved.delete(assemblyId)
    assembly.memberKeys.filter((key) => key.startsWith('assembly:')).forEach((key) => visitAssembly(key.slice('assembly:'.length), new Set([...trail, assemblyId])))
  }
  assemblies.forEach((assembly) => visitAssembly(assembly.id))
  next.assemblySequence = nextRootSequence
  next.assemblyChildSequence = Object.fromEntries(Object.entries(childCounters)
    .filter(([scope]) => scope.startsWith('assembly:'))
    .map(([scope, counter]) => [scope.slice('assembly:'.length), counter]))
  next.childSequenceCounters = childCounters

  const parts = sceneEntityParts(next)
  const names = { ...(next.entityNames ?? {}) }
  const modes = { ...(next.entityNameModes ?? {}) }
  const sequences = { ...(next.entityNameSequences ?? {}) }
  const parents = { ...(next.entityNameParents ?? {}) }
  const entityCounters = { ...childCounters, ...(next.entitySequenceCounters ?? {}) }
  const usedEntitySequences = new Map<string, Set<number>>()
  const usedStandaloneNames = new Set<string>()
  const assetMap = new Map(next.assets.map((asset) => [asset.id, asset]))
  const scopeForParent = (parentId?: string) => parentId ? `assembly:${parentId}` : 'root'
  const partBaseName = (part: SceneEntityPart) => {
    if (part.kind === 'custom') return '手动体素实体'
    const instance = part.instanceId ? next.instances.find((item) => item.id === part.instanceId) : undefined
    const asset = instance ? assetMap.get(instance.assetId) : undefined
    const sourceName = asset?.name?.trim() ?? ''
    return /^装配体\s+\d+$/.test(sourceName) || /^子装配体\s+\d+(?:-\d+)*$/.test(sourceName) ? '子实体' : (sourceName || '子实体')
  }
  const directParentOf = (part: SceneEntityPart) => part.assemblyIds?.[0] ?? part.assemblyId
  parts.forEach((part) => {
    const parentId = directParentOf(part)
    const scope = scopeForParent(parentId)
    if (!parentId) {
      const current = names[part.memberKey]
      if (!current) {
        const base = partBaseName(part)
        let candidate = base
        let suffix = 2
        while (usedStandaloneNames.has(candidate)) candidate = `${base} ${suffix++}`
        names[part.memberKey] = candidate
      }
      usedStandaloneNames.add(names[part.memberKey])
      parents[part.memberKey] = ''
      if (!modes[part.memberKey]) modes[part.memberKey] = 'auto'
      return
    }
    parents[part.memberKey] = parentId
    if (modes[part.memberKey] === 'custom') return
    modes[part.memberKey] = 'auto'
    const used = usedEntitySequences.get(scope) ?? new Set<number>()
    usedEntitySequences.set(scope, used)
    let sequence = Number.isInteger(sequences[part.memberKey]) && (sequences[part.memberKey] ?? 0) > 0 ? sequences[part.memberKey] : undefined
    const previousParent = next.entityNameParents?.[part.memberKey]
    if (previousParent !== parentId) sequence = lastHierarchicalNumber(names[part.memberKey])
    if (!sequence || used.has(sequence)) {
      const nextSequence = Math.max(1, childCounters[scope] ?? 1, entityCounters[scope] ?? 1, ...used, 0)
      sequence = nextSequence
      childCounters[scope] = nextSequence + 1
    }
    used.add(sequence)
    childCounters[scope] = Math.max(childCounters[scope] ?? 1, entityCounters[scope] ?? 1, sequence + 1)
    sequences[part.memberKey] = sequence
    const path = pathNumbers.get(parentId) ?? [assemblyMap.get(parentId)?.sequence ?? 1]
    names[part.memberKey] = `${partBaseName(part)} ${path.join('-')}-${sequence}`
  })
  next.entityNames = names
  next.entityNameModes = modes
  next.entityNameSequences = sequences
  next.entityNameParents = parents
  next.entitySequenceCounters = { ...entityCounters, ...childCounters }
  next.childSequenceCounters = childCounters
  return next
}

export function sceneAssemblies(parts: SceneEntityPart[], options: { includeContacts?: boolean } = {}): SceneEntityPart[][] {
  const parent = parts.map((_, index) => index)
  const find = (index: number): number => {
    if (parent[index] === index) return index
    parent[index] = find(parent[index])
    return parent[index]
  }
  const join = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }
  const firstByAssembly = new Map<string, number>()
  parts.forEach((part, index) => {
    for (const assemblyId of part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])) {
      const first = firstByAssembly.get(assemblyId)
      if (first === undefined) firstByAssembly.set(assemblyId, index)
      else join(first, index)
    }
  })
  const occupied = new Map<string, number[]>()
  if (options.includeContacts !== false) parts.forEach((part, partIndex) => part.voxels.forEach((voxel) => {
    const key = voxelKey(voxel)
    occupied.set(key, [...(occupied.get(key) ?? []), partIndex])
  }))
  const neighbors = (voxel: Pick<Voxel, 'x' | 'y' | 'z'>) => [
    [voxel.x + 1, voxel.y, voxel.z], [voxel.x - 1, voxel.y, voxel.z],
    [voxel.x, voxel.y + 1, voxel.z], [voxel.x, voxel.y - 1, voxel.z],
    [voxel.x, voxel.y, voxel.z + 1], [voxel.x, voxel.y, voxel.z - 1],
  ]
  parts.forEach((part, partIndex) => part.voxels.forEach((voxel) => {
    for (const key of [voxelKey(voxel), ...neighbors(voxel).map(([x, y, z]) => `${x},${y},${z}`)]) {
      for (const otherIndex of occupied.get(key) ?? []) join(partIndex, otherIndex)
    }
  }))
  const groups = new Map<number, SceneEntityPart[]>()
  parts.forEach((part, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), part]))
  return [...groups.values()]
}

export function deduplicateVoxels(voxels: Voxel[]): Voxel[] {
  const unique = new Map<string, Voxel>()
  for (const voxel of voxels) unique.set(voxelKey(voxel), { ...voxel })
  return [...unique.values()]
}

export const MATERIALS: Material[] = [
  { id: 'ivory', name: '象牙白', color: '#e9e1d1' },
  { id: 'terracotta', name: '陶土红', color: '#c96043' },
  { id: 'teal', name: '青黛', color: '#2e6f70' },
  { id: 'jade', name: '玉青', color: '#4f8b76' },
  { id: 'gold', name: '鎏金', color: '#d2a354' },
  { id: 'wood', name: '深木', color: '#6c4b38' },
  { id: 'stone', name: '石灰', color: '#87847c' },
  { id: 'night', name: '墨黑', color: '#20252a' },
]

const cube = (x: number, y: number, z: number, materialId = 'ivory'): Voxel => ({ x, y, z, materialId })

function box(width: number, height: number, depth: number, materialId: string, y = 0): Voxel[] {
  const voxels: Voxel[] = []
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      for (let yy = 0; yy < height; yy += 1) voxels.push(cube(x, y + yy, z, materialId))
    }
  }
  return voxels
}

function shell(width: number, height: number, depth: number, materialId: string): Voxel[] {
  const voxels: Voxel[] = []
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < depth; z += 1) {
      for (let y = 0; y < height; y += 1) {
        if (x === 0 || x === width - 1 || z === 0 || z === depth - 1 || y === 0 || y === height - 1) {
          voxels.push(cube(x, y, z, materialId))
        }
      }
    }
  }
  return voxels
}

function roof(width: number, depth: number, y: number, materialId: string): Voxel[] {
  const voxels: Voxel[] = []
  const center = Math.floor(width / 2)
  for (let layer = 0; layer < center + 1; layer += 1) {
    const start = layer
    const end = width - layer
    for (let x = start; x < end; x += 1) {
      for (let z = 0; z < depth; z += 1) voxels.push(cube(x, y + layer, z, materialId))
    }
  }
  return voxels
}

function merge(...groups: Voxel[][]): Voxel[] {
  return groups.flat()
}

export function makeHouse(id: string, name: string, style: string, color: string, accent: string): VoxelAsset {
  const width = 7
  const depth = 7
  const height = 5
  const body = shell(width, height, depth, 'primary')
  const roofVoxels = merge(box(3, 1, 1, 'accent', 5), roof(width, depth, 6, 'primary'))
  const door = box(1, 2, 1, 'wood', 1)
  const windows = box(1, 1, 1, 'accent', 3)
  const decorationKeys = new Set([...door, ...windows].map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
  const bodyWithoutDecoration = body.filter((voxel) => !decorationKeys.has(`${voxel.x},${voxel.y},${voxel.z}`))
  const partVoxels = { 主体: bodyWithoutDecoration, 屋顶: roofVoxels, 门窗: door, 装饰: windows }
  return { id, name, style, kind: 'house', color, accent, width, depth, height: 9, parts: Object.keys(partVoxels), partVoxels, voxels: merge(...Object.values(partVoxels)) }
}

export function makeRoad(id: string, name: string): VoxelAsset {
  const voxels = merge(box(9, 1, 9, 'stone'), box(1, 1, 9, 'night', 1), box(9, 1, 1, 'night', 1))
  return { id, name, style: '基础件', kind: 'road', color: '#87847c', accent: '#f3d27a', width: 9, depth: 9, height: 2, parts: ['街道主体', '路面标线'], voxels }
}

export function makePlaza(id: string): VoxelAsset {
  const voxels = merge(box(7, 1, 7, 'stone'), box(3, 1, 3, 'jade', 1), box(1, 3, 1, 'gold', 2))
  return { id, name: '中央广场', style: '基础件', kind: 'public', color: '#87847c', accent: '#d2a354', width: 7, depth: 7, height: 5, parts: ['广场主体', '中心雕像'], voxels }
}

export function makeTree(id: string): VoxelAsset {
  const voxels = merge(box(1, 3, 1, 'wood'), box(3, 2, 3, 'jade', 3), box(1, 1, 1, 'jade', 5))
  return { id, name: '街角树', style: '基础件', kind: 'nature', color: '#4f8b76', accent: '#6c4b38', width: 3, depth: 3, height: 6, parts: ['树干', '树冠'], voxels }
}

export function makeDefaultProject(): ProjectState {
  const assets = [
    makeHouse('house-greek', '希腊建筑·主屋', '希腊风格', '#5f83bd', '#e9e1d1'),
    makeHouse('house-indian', '印度建筑·主屋', '印度风格', '#d2a354', '#c96043'),
    makeHouse('house-chinese', '中式建筑·主屋', '中式风格', '#2e6f70', '#c96043'),
    makeHouse('house-japanese', '日式建筑·主屋', '日式风格', '#20252a', '#6c4b38'),
    makeRoad('road-basic', '街道直线'),
    makePlaza('plaza-center'),
    makeTree('tree-basic'),
  ].map((asset) => ({ ...asset, isTemplate: true }))
  const instances: SceneInstance[] = [
    { id: 'inst-greek', assetId: 'house-greek', x: -6, y: 0, z: -6, rotation: 0, style: '希腊风格', visible: true, overrides: [] },
    { id: 'inst-indian', assetId: 'house-indian', x: 3, y: 0, z: -6, rotation: 0, style: '印度风格', visible: true, overrides: [] },
    { id: 'inst-chinese', assetId: 'house-chinese', x: -6, y: 0, z: 3, rotation: 0, style: '中式风格', visible: true, overrides: [] },
    { id: 'inst-japanese', assetId: 'house-japanese', x: 3, y: 0, z: 3, rotation: 0, style: '日式风格', visible: true, overrides: [] },
    { id: 'inst-plaza', assetId: 'plaza-center', x: -1, y: 0, z: -1, rotation: 0, style: '基础件', visible: true, overrides: [] },
    { id: 'inst-tree-a', assetId: 'tree-basic', x: -9, y: 0, z: 0, rotation: 0, style: '基础件', visible: true, overrides: [] },
    { id: 'inst-tree-b', assetId: 'tree-basic', x: 8, y: 0, z: 0, rotation: 0, style: '基础件', visible: true, overrides: [] },
  ]
  return { version: 1, name: '莫测里·第一街区', voxelSizeMm: 1, sceneSizeCm: 20, sceneBounds: { x: 200, y: 200, z: 200 }, materials: MATERIALS, assets, instances, customVoxels: [], customColors: {}, entityNames: {}, assemblySequence: 1, assemblies: [], lockedMemberKeys: [] }
}

export function makeStl(asset: VoxelAsset): string {
  const lines: string[] = [`solid ${asset.id}`]
  const face = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
    const normal = '0 0 0'
    lines.push(`facet normal ${normal}`, ' outer loop', `  vertex ${a.join(' ')}`, `  vertex ${b.join(' ')}`, `  vertex ${c.join(' ')}`, ' endloop', 'endfacet')
    lines.push(`facet normal ${normal}`, ' outer loop', `  vertex ${a.join(' ')}`, `  vertex ${c.join(' ')}`, `  vertex ${d.join(' ')}`, ' endloop', 'endfacet')
  }
  const voxels = deduplicateVoxels(asset.voxels)
  const occupied = new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`))
  const faces: Array<{ dx: number; dy: number; dz: number; corners: Array<[number, number, number]> }> = [
    { dx: 1, dy: 0, dz: 0, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { dx: -1, dy: 0, dz: 0, corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { dx: 0, dy: 1, dz: 0, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { dx: 0, dy: -1, dz: 0, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { dx: 0, dy: 0, dz: 1, corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { dx: 0, dy: 0, dz: -1, corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ]
  for (const voxel of voxels) {
    for (const { dx, dy, dz, corners } of faces) {
      if (occupied.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)) continue
      const points = corners.map(([x, y, z]) => [voxel.x + x, voxel.y + y, voxel.z + z] as [number, number, number])
      face(points[0], points[1], points[2], points[3])
    }
  }
  lines.push(`endsolid ${asset.id}`)
  return lines.join('\n')
}
