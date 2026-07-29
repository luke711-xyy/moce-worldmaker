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
  style: string
  kind: 'house' | 'road' | 'public' | 'nature' | 'character' | 'imported'
  color: string
  accent: string
  width: number
  depth: number
  height: number
  parts: string[]
  partVoxels?: Record<string, Voxel[]>
  voxels: Voxel[]
  source?: string
  /** Only template assets appear in the left asset library. */
  isTemplate?: boolean
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
}

export type ProjectState = {
  version: 1
  name: string
  voxelSizeMm: 1
  sceneSizeCm: 20
  materials: Material[]
  assets: VoxelAsset[]
  instances: SceneInstance[]
  customVoxels: Voxel[]
  customColors?: Record<string, string>
  entityNames?: Record<string, string>
  assemblySequence?: number
  assemblies?: SceneAssembly[]
  lockedMemberKeys?: string[]
}

export type SceneAssembly = {
  id: string
  name?: string
  memberKeys: string[]
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

export function makeAssetFromSceneParts(id: string, name: string, parts: SceneEntityPart[], color = '#6c827d', accent = '#d2a354'): VoxelAsset {
  const sourceVoxels = parts.flatMap((part) => part.voxels)
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

export function findInstanceVoxelAtSceneVoxel(instance: SceneInstance, asset: VoxelAsset, sceneVoxel: Pick<Voxel, 'x' | 'y' | 'z'>): Voxel | undefined {
  const angle = instance.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const worldX = voxelToWorld(sceneVoxel.x) - instance.x
  const worldZ = voxelToWorld(sceneVoxel.z) - instance.z
  const resolved = resolveInstanceVoxels(asset, instance.overrides ?? [])
  return voxelComponents(resolved).flatMap((component) => {
    const offset = instance.partOffsets?.[voxelComponentId(component)] ?? { x: 0, y: 0, z: 0 }
    const adjustedWorldX = worldX - offset.x
    const adjustedWorldZ = worldZ - offset.z
    const localX = cos * adjustedWorldX - sin * adjustedWorldZ
    const localZ = sin * adjustedWorldX + cos * adjustedWorldZ
    const localY = sceneVoxel.y - worldToVoxel((instance.y ?? 0) + offset.y)
    const localVoxel = {
      x: Math.round(localX / VOXEL_WORLD_SIZE + asset.width / 2 - 0.5),
      y: localY,
      z: Math.round(localZ / VOXEL_WORLD_SIZE + asset.depth / 2 - 0.5),
    }
    return component.filter((voxel) => voxel.x === localVoxel.x && voxel.y === localVoxel.y && voxel.z === localVoxel.z)
  })[0]
}

function resolveInstanceComponentSceneVoxels(instance: SceneInstance, asset: VoxelAsset, component: Voxel[], x = instance.x, z = instance.z, y = instance.y ?? 0): Voxel[] {
  const angle = instance.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const offset = instance.partOffsets?.[voxelComponentId(component)] ?? { x: 0, y: 0, z: 0 }
  return component.map((voxel) => {
    const localX = (voxel.x + 0.5 - asset.width / 2) * VOXEL_WORLD_SIZE
    const localZ = (voxel.z + 0.5 - asset.depth / 2) * VOXEL_WORLD_SIZE
    return {
      ...voxel,
      x: worldToVoxel(x + cos * localX + sin * localZ + offset.x),
      y: worldToVoxel(y + offset.y) + voxel.y,
      z: worldToVoxel(z - sin * localX + cos * localZ + offset.z),
    }
  })
}

export function resolveInstanceSceneVoxels(instance: SceneInstance, asset: VoxelAsset, x = instance.x, z = instance.z, y = instance.y ?? 0): Voxel[] {
  return voxelComponents(resolveInstanceVoxels(asset, instance.overrides ?? [])).flatMap((component) => resolveInstanceComponentSceneVoxels(instance, asset, component, x, z, y))
}

export function sceneEntityParts(project: ProjectState): SceneEntityPart[] {
  const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
  const assemblies = project.assemblies ?? []
  const memberKeyMatches = (storedKey: string, candidateKey: string) => storedKey === candidateKey || (storedKey.startsWith('asset:') && candidateKey.startsWith(`${storedKey}:`))
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
    const resolved = resolveInstanceVoxels(asset, instance.overrides ?? [])
    for (const component of voxelComponents(resolved)) {
      const partId = voxelComponentId(component)
      const sceneVoxels = resolveInstanceComponentSceneVoxels(instance, asset, component)
      const label = Object.entries(asset.partVoxels ?? {}).find(([, sourceVoxels]) => sourceVoxels.some((sourceVoxel) => component.some((voxel) => voxelKey(sourceVoxel) === voxelKey(voxel))))?.[0] ?? partId
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
  return { version: 1, name: '莫测里·第一街区', voxelSizeMm: 1, sceneSizeCm: 20, materials: MATERIALS, assets, instances, customVoxels: [], customColors: {}, entityNames: {}, assemblySequence: 1, assemblies: [], lockedMemberKeys: [] }
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
