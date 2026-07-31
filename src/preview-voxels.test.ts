import { describe, expect, it } from 'vitest'
import { mergePreviewFaceCells, selectPreviewVoxels } from './preview-voxels'
import { Voxel } from './voxel'

function cube(size: number): Voxel[] {
  const voxels: Voxel[] = []
  for (let x = 0; x < size; x += 1) for (let y = 0; y < size; y += 1) for (let z = 0; z < size; z += 1) {
    voxels.push({ x, y, z, materialId: 'terracotta' })
  }
  return voxels
}

describe('体素预览采样', () => {
  it('keeps every voxel for small assets', () => {
    const voxels = cube(3)
    const result = selectPreviewVoxels(voxels, 100)
    expect(result.voxels).toHaveLength(voxels.length)
    expect(result.occupancyKeys.size).toBe(voxels.length)
  })

  it('does not truncate a large model to the first source cells', () => {
    const voxels = cube(20)
    const result = selectPreviewVoxels(voxels, 100)
    expect(result.voxels.length).toBeLessThanOrEqual(100)
    expect(result.occupancyKeys.size).toBe(voxels.length)
    expect(result.voxels.some((voxel) => voxel.x === 19)).toBe(true)
    expect(result.voxels.some((voxel) => voxel.y === 19)).toBe(true)
    expect(result.voxels.some((voxel) => voxel.z === 19)).toBe(true)
  })

  it('merges adjacent coplanar faces into one preview rectangle', () => {
    const cells = [0, 1, 2, 3].map((a) => ({ orientation: 'top' as const, plane: 1, a, b: 0, color: '#d2a354', sortKey: a }))
    const rectangles = mergePreviewFaceCells(cells)
    expect(rectangles).toHaveLength(1)
    expect(rectangles[0]).toMatchObject({ a: 0, b: 0, width: 4, height: 1 })
  })
})
