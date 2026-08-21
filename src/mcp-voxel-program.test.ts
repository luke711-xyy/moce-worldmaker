import { describe, expect, it } from 'vitest'
import { makeEmptyProject } from './voxel'
import { applyVoxelProgram, McpProgramError } from './mcp-voxel-program'

describe('MCP voxel programs', () => {
  it('commits a primitive as one atomic ordinary voxel entity', () => {
    const result = applyVoxelProgram(makeEmptyProject(), {
      transactionId: 'primitive-test',
      label: '测试方块',
      operations: [{ type: 'create_primitive', primitive: 'cuboid', origin: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 3 }, name: '测试方块' }],
    })
    expect(result.createdEntityIds).toHaveLength(1)
    expect(result.voxelCount).toBe(6)
    expect(result.project.customVoxels.every((voxel) => voxel.entityId === result.createdEntityIds[0])).toBe(true)
  })

  it('rejects a program atomically when a new primitive collides', () => {
    const project = makeEmptyProject()
    const first = applyVoxelProgram(project, {
      transactionId: 'first', label: 'first',
      operations: [{ type: 'create_primitive', primitive: 'cuboid', origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    }).project
    expect(() => applyVoxelProgram(first, {
      transactionId: 'collision', label: 'collision',
      operations: [{ type: 'create_primitive', primitive: 'cuboid', origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }],
    })).toThrowError(McpProgramError)
    expect(first.customVoxels).toHaveLength(1)
  })

  it('accepts scene coordinates and stores them relative to a lazy entity offset', () => {
    const project = makeEmptyProject()
    project.customEntityOffsets = { entity: { x: 5, y: 0, z: 6 } }
    project.customVoxels = [{ x: 0, y: 0, z: 0, materialId: 'terracotta', entityId: 'entity' }]
    const result = applyVoxelProgram(project, {
      transactionId: 'offset-test', label: 'offset',
      operations: [{ type: 'add_voxels', entityId: 'entity', voxels: [{ x: 6, y: 0, z: 6, materialId: 'terracotta' }] }],
    })
    expect(result.project.customVoxels).toContainEqual({ x: 1, y: 0, z: 0, materialId: 'terracotta', entityId: 'entity' })
  })

  it('keeps the requested display name for an add operation', () => {
    const project = makeEmptyProject()
    const result = applyVoxelProgram(project, {
      transactionId: 'named-add', label: 'named-add',
      operations: [{
        type: 'add_voxels',
        entityId: 'named-entity',
        name: '小桥',
        voxels: [{ x: 1, y: 0, z: 2, materialId: 'terracotta' }],
      }],
    })
    expect(result.project.entityNames?.['named-entity']).toBe('小桥')
    expect(result.project.customVoxels).toContainEqual({ x: 1, y: 0, z: 2, materialId: 'terracotta', entityId: 'named-entity' })
  })
})
