import type { ProjectState, SceneAssembly, Voxel } from './voxel'
import { customEntityOffset, sceneEntityParts, scenePartVoxels, sceneBoundsForProject, sceneToStoredCustomVoxel } from './voxel'
import type { VoxelCoordinate, VoxelOperation, VoxelProgram } from './mcp-protocol'

export class McpProgramError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'McpProgramError' }
}

export type ApplyResult = { project: ProjectState; changedEntityIds: string[]; createdEntityIds: string[]; voxelCount: number }
const cellKey = (v: VoxelCoordinate) => `${v.x},${v.y},${v.z}`
const normalizeEntityId = (id: string) => id.startsWith('custom:') ? id.slice('custom:'.length) : id

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new McpProgramError('invalid_integer', `${label} 必须是整数`)
  return value
}
function coordinate(value: VoxelCoordinate | undefined, label: string): VoxelCoordinate {
  if (!value) throw new McpProgramError('invalid_coordinate', `${label} 缺少坐标`)
  return { x: integer(value.x, `${label}.x`), y: integer(value.y, `${label}.y`), z: integer(value.z, `${label}.z`) }
}
function add(a: VoxelCoordinate, b: VoxelCoordinate): VoxelCoordinate { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z } }
function unique(voxels: Voxel[]): Voxel[] { return [...new Map(voxels.map((v) => [cellKey(v), v])).values()] }

function line3d(start: VoxelCoordinate, end: VoxelCoordinate): VoxelCoordinate[] {
  const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y), Math.abs(end.z - start.z))
  if (steps === 0) return [start]
  const result: VoxelCoordinate[] = []
  for (let i = 0; i <= steps; i += 1) result.push({ x: Math.round(start.x + (end.x - start.x) * i / steps), y: Math.round(start.y + (end.y - start.y) * i / steps), z: Math.round(start.z + (end.z - start.z) * i / steps) })
  return [...new Map(result.map((v) => [cellKey(v), v])).values()]
}

function primitive(op: Extract<VoxelOperation, { type: 'create_primitive' }>, materialId: string): Voxel[] {
  const origin = coordinate(op.origin, 'origin')
  if (op.primitive === 'line') return line3d(origin, coordinate(op.end ?? origin, 'end')).map((v) => ({ ...v, materialId }))
  if (op.primitive === 'sphere') {
    const radius = integer(op.radius ?? 1, 'radius'); if (radius < 1) throw new McpProgramError('invalid_size', '球体半径必须大于 0')
    const result: Voxel[] = []
    for (let x = -radius; x <= radius; x += 1) for (let y = -radius; y <= radius; y += 1) for (let z = -radius; z <= radius; z += 1) if (x * x + y * y + z * z <= radius * radius) result.push({ x: origin.x + x, y: origin.y + y, z: origin.z + z, materialId })
    return result
  }
  if (op.primitive === 'cylinder') {
    const radius = integer(op.radius ?? 1, 'radius'), height = integer(op.height ?? 1, 'height'); if (radius < 1 || height < 1) throw new McpProgramError('invalid_size', '圆柱尺寸必须大于 0')
    const result: Voxel[] = []
    for (let y = 0; y < height; y += 1) for (let x = -radius; x <= radius; x += 1) for (let z = -radius; z <= radius; z += 1) if (x * x + z * z <= radius * radius) result.push({ x: origin.x + x, y: origin.y + y, z: origin.z + z, materialId })
    return result
  }
  const size = op.size ?? { x: 1, y: 1, z: 1 }; const sx = integer(size.x, 'size.x'), sy = integer(size.y, 'size.y'), sz = integer(size.z, 'size.z')
  if (sx < 1 || sy < 1 || sz < 1) throw new McpProgramError('invalid_size', '长方体尺寸必须大于 0')
  const result: Voxel[] = []
  for (let x = 0; x < sx; x += 1) for (let y = 0; y < sy; y += 1) for (let z = 0; z < sz; z += 1) result.push({ x: origin.x + x, y: origin.y + y, z: origin.z + z, materialId })
  return result
}

function rotatePoint(v: VoxelCoordinate, min: VoxelCoordinate, max: VoxelCoordinate, axis: 'x' | 'y' | 'z'): VoxelCoordinate {
  if (axis === 'x') return { x: v.x, y: min.y + (v.z - min.z), z: max.z - (v.y - min.y) }
  if (axis === 'y') return { x: min.x + (v.z - min.z), y: v.y, z: max.z - (v.x - min.x) }
  return { x: min.x + (v.y - min.y), y: max.y - (v.x - min.x), z: v.z }
}
function transformVoxels(source: Voxel[], axis: 'x' | 'y' | 'z', operation: 'mirror' | 'rotate', degrees = 90): Voxel[] {
  if (!source.length) return []
  const min = source.reduce((a, v) => ({ x: Math.min(a.x, v.x), y: Math.min(a.y, v.y), z: Math.min(a.z, v.z) }), { x: Infinity, y: Infinity, z: Infinity })
  const max = source.reduce((a, v) => ({ x: Math.max(a.x, v.x), y: Math.max(a.y, v.y), z: Math.max(a.z, v.z) }), { x: -Infinity, y: -Infinity, z: -Infinity })
  const turns = operation === 'mirror' ? 1 : ((degrees / 90) % 4 + 4) % 4
  return source.map((voxel) => {
    let position: VoxelCoordinate = voxel
    for (let i = 0; i < turns; i += 1) position = operation === 'mirror'
      ? axis === 'x' ? { ...position, x: min.x + max.x - position.x } : axis === 'y' ? { ...position, y: min.y + max.y - position.y } : { ...position, z: min.z + max.z - position.z }
      : rotatePoint(position, min, max, axis)
    return { ...voxel, ...position }
  })
}

function sceneLimits(project: ProjectState) {
  const b = sceneBoundsForProject(project)
  return { minX: -Math.floor(b.x / 2), maxX: Math.ceil(b.x / 2) - 1, minZ: -Math.floor(b.y / 2), maxZ: Math.ceil(b.y / 2) - 1, maxY: b.z - 1 }
}

export function applyVoxelProgram(project: ProjectState, program: VoxelProgram, options: { maxVoxels?: number } = {}): ApplyResult {
  if (!program?.transactionId || !Array.isArray(program.operations)) throw new McpProgramError('invalid_program', '体素程序缺少 transactionId 或 operations')
  const draft = structuredClone(project) as ProjectState
  draft.customVoxels = [...(draft.customVoxels ?? [])]
  draft.customColors = { ...(draft.customColors ?? {}) }
  draft.entityNames = { ...(draft.entityNames ?? {}) }
  draft.assemblies = [...(draft.assemblies ?? [])]
  const groups = new Map<string, Voxel[]>()
  for (const voxel of draft.customVoxels) { const id = voxel.entityId ?? 'unassigned'; groups.set(id, [...(groups.get(id) ?? []), { ...voxel, entityId: id }]) }
  const external = new Map<string, string>()
  for (const part of sceneEntityParts(project, { isolated: true })) if (part.kind === 'asset') for (const voxel of scenePartVoxels(part)) external.set(cellKey(voxel), part.id)
  const limits = sceneLimits(draft)
  const inBounds = (v: VoxelCoordinate) => v.x >= limits.minX && v.x <= limits.maxX && v.z >= limits.minZ && v.z <= limits.maxZ && v.y >= 0 && v.y <= limits.maxY
  const customOffset = (id: string) => customEntityOffset(draft, id)
  const toScene = (id: string, v: VoxelCoordinate) => add(v, customOffset(id))
  const assertCustom = (raw: string) => { const id = normalizeEntityId(raw); if (!groups.has(id)) throw new McpProgramError('entity_not_found', `找不到普通实体：${id}`); return id }
  const occupancy = (excluded: Set<string>) => {
    const occupied = new Map<string, string>()
    for (const [id, voxels] of groups) if (!excluded.has(id)) for (const voxel of voxels) occupied.set(cellKey(toScene(id, voxel)), id)
    external.forEach((owner, cell) => occupied.set(cell, owner)); return occupied
  }
  const validate = (voxels: VoxelCoordinate[], excluded: Set<string>) => {
    const occupied = occupancy(excluded), seen = new Set<string>()
    for (const voxel of voxels) { if (!inBounds(voxel)) throw new McpProgramError('out_of_bounds', `体素 ${cellKey(voxel)} 超出场景边界或低于地面`); const cell = cellKey(voxel); if (occupied.has(cell) || seen.has(cell)) throw new McpProgramError('collision', `体素 ${cell} 与其他实体重叠`); seen.add(cell) }
  }
  const created: string[] = [], changed = new Set<string>(); let serial = 0
  const makeId = () => `mcp-${program.transactionId}-${serial++}`
  for (const op of program.operations) {
    if (op.type === 'create_primitive') {
      const id = normalizeEntityId(op.entityId ?? makeId()); if (groups.has(id)) throw new McpProgramError('duplicate_entity', `实体 ID 已存在：${id}`)
      const voxels = unique(primitive(op, op.materialId ?? 'terracotta')); validate(voxels, new Set()); groups.set(id, voxels.map((v) => ({ ...v, entityId: id }))); draft.entityNames[id] ??= op.name?.trim() || id; created.push(id); changed.add(id); continue
    }
    if (op.type === 'add_voxels') {
      const id = normalizeEntityId(op.entityId ?? makeId()); if (!groups.has(id)) { groups.set(id, []); created.push(id); draft.entityNames[id] ??= id }
      const target = groups.get(id)!; const existing = new Set(target.map((v) => cellKey(toScene(id, v))))
      if (op.name?.trim()) draft.entityNames[id] = op.name.trim()
      // MCP coordinates are always scene-space coordinates. Convert back to
      // stored entity coordinates only at the final write.
      const additions = unique(op.voxels.map((item) => ({ ...coordinate(item, 'voxel'), materialId: item.materialId ?? 'terracotta' }))).filter((v) => !existing.has(cellKey(v)))
      validate(additions, new Set([id])); target.push(...additions.map((v) => ({ ...sceneToStoredCustomVoxel(draft, v, id), entityId: id }))); changed.add(id); continue
    }
    if (op.type === 'subtract_voxels' || op.type === 'paint_voxels') {
      const ids = (op.entityIds ?? [...groups.keys()]).map(assertCustom); const wanted = new Set((op.voxels ?? []).map((v) => cellKey(coordinate(v, 'voxel'))))
      if (op.type === 'paint_voxels' && !op.materialId) throw new McpProgramError('invalid_material', '改色操作缺少 materialId')
      for (const id of ids) { const target = groups.get(id)!; groups.set(id, op.type === 'subtract_voxels' ? wanted.size ? target.filter((v) => !wanted.has(cellKey(toScene(id, v)))) : [] : target.map((v) => wanted.has(cellKey(toScene(id, v))) ? { ...v, materialId: op.materialId } : v)); changed.add(id) }
      continue
    }
    if (op.type === 'transform_entities') {
      const ids = op.entityIds.map(assertCustom); const excluded = new Set(ids); const results = ids.map((id) => ({ id, voxels: transformVoxels(groups.get(id)!.map((v) => ({ ...v, ...toScene(id, v) })), op.axis, op.operation, op.degrees ?? 90) })); validate(results.flatMap((r) => r.voxels), excluded)
      results.forEach(({ id, voxels }) => groups.set(id, unique(voxels.map((v) => ({ ...v, ...sceneToStoredCustomVoxel(draft, v, id), entityId: id }))))); ids.forEach((id) => changed.add(id)); continue
    }
    if (op.type === 'duplicate_entities') {
      const delta = coordinate(op.offset, 'offset')
      for (const sourceId of op.entityIds.map(assertCustom)) {
        const id = `${sourceId}-copy-${serial++}`
        const sceneVoxels = groups.get(sourceId)!.map((v) => ({ ...v, ...add(toScene(sourceId, v), delta), entityId: id }))
        validate(sceneVoxels, new Set())
        const next = unique(sceneVoxels.map((v) => ({ ...sceneToStoredCustomVoxel(draft, v, id), entityId: id })))
        groups.set(id, next)
        draft.entityNames[id] = `${draft.entityNames[sourceId] ?? sourceId} (副本)`
        created.push(id); changed.add(id)
      }
      continue
    }
    if (op.type === 'delete_entities') {
      for (const id of op.entityIds.map(assertCustom)) { groups.delete(id); delete draft.entityNames[id]; delete draft.customColors?.[id]; delete draft.customEntityOffsets?.[id]; draft.assemblies = draft.assemblies.map((assembly) => ({ ...assembly, memberKeys: assembly.memberKeys.filter((member) => member !== `voxel:${id}`) })).filter((assembly) => assembly.memberKeys.length > 0); changed.add(id) }
      continue
    }
    if (op.type === 'extrude_region') {
      const id = assertCustom(op.entityId), delta = integer(op.delta, 'delta'); if (!delta) continue; const wanted = new Set(op.source.map((v) => cellKey(coordinate(v, 'source')))); const source = groups.get(id)!.filter((v) => wanted.has(cellKey(toScene(id, v)))); if (!source.length) throw new McpProgramError('empty_extrude', '拉伸源区域为空')
      const additions: Voxel[] = [], sign = Math.sign(delta); for (let distance = 1; distance <= Math.abs(delta); distance += 1) for (const voxel of source) additions.push({ ...voxel, ...add(toScene(id, voxel), axisDelta(op.axis, distance * sign)), entityId: id }); validate(additions, new Set([id])); const merged = new Map(groups.get(id)!.map((v) => [cellKey(toScene(id, v)), v])); additions.forEach((v) => merged.set(cellKey(v), { ...sceneToStoredCustomVoxel(draft, v, id), entityId: id })); groups.set(id, [...merged.values()]); changed.add(id); continue
    }
    if (op.type === 'assemble_entities') {
      const ids = op.entityIds.map(assertCustom), id = op.assemblyId?.trim() || `mcp-assembly-${program.transactionId}-${serial++}`, members = ids.map((member) => `voxel:${member}`), existing = draft.assemblies.find((assembly) => assembly.id === id)
      if (existing) existing.memberKeys = [...new Set([...existing.memberKeys, ...members])]; else draft.assemblies.push({ id, name: op.name?.trim() || `装配体 ${draft.assemblies.length + 1}`, memberKeys: members, sequence: draft.assemblies.length + 1 } as SceneAssembly)
      ids.forEach((member) => changed.add(member)); continue
    }
    throw new McpProgramError('unsupported_operation', `不支持的操作：${(op as { type?: string }).type ?? 'unknown'}`)
  }
  draft.customVoxels = [...groups.values()].flat(); const maxVoxels = options.maxVoxels ?? 500_000; if (draft.customVoxels.length > maxVoxels) throw new McpProgramError('voxel_budget', `结果超过 ${maxVoxels.toLocaleString()} 个体素预算`)
  return { project: draft, changedEntityIds: [...changed], createdEntityIds: created, voxelCount: draft.customVoxels.length }
}

function axisDelta(axis: 'x' | 'y' | 'z', value: number): VoxelCoordinate { return axis === 'x' ? { x: value, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: value, z: 0 } : { x: 0, y: 0, z: value } }
