import { describe, expect, it } from 'vitest'
import { computeScale, computeShell, validScaleFactors, validShellThicknesses } from './voxel-geometry'

const voxel = (x: number, y: number, z: number) => ({ x, y, z, materialId: '#cc6633' })
const cube = (size: number) => Array.from({ length: size ** 3 }, (_, index) => voxel(index % size, Math.floor(index / (size * size)), Math.floor(index / size) % size))

describe('voxel geometry', () => {
  it('keeps a one-layer shell and fills a sealed cavity', () => {
    const solid = cube(3)
    const hollow = solid.filter((cell) => !(cell.x === 1 && cell.y === 1 && cell.z === 1))
    const result = computeShell(hollow, 1)
    expect(result.voxelCount).toBe(26)
    const filledFallback = computeShell(hollow, 2)
    expect(filledFallback.voxels.some((cell) => cell.x === 1 && cell.y === 1 && cell.z === 1)).toBe(true)
  })

  it('does not erase a one-voxel-thick model', () => {
    const result = computeShell([voxel(0, 0, 0)], 4)
    expect(result.voxelCount).toBe(1)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(validShellThicknesses([voxel(0, 0, 0)])).toEqual([1])
  })

  it('enlarges each voxel into k cubed cells', () => {
    const result = computeScale([voxel(4, 0, 8)], 'up', 2)
    expect(result.voxelCount).toBe(8)
    expect(result.bounds?.width).toBe(2)
    expect(result.bounds?.height).toBe(2)
    expect(result.bounds?.depth).toBe(2)
    expect(result.bounds?.minY).toBe(0)
    expect(result.voxels.every((cell) => cell.preserveVoxelCells)).toBe(true)
    expect(new Set(result.voxels.map((cell) => `${cell.x},${cell.y},${cell.z}`)).size).toBe(8)
  })

  it('only exposes divisible shrink factors and uses over-half sampling', () => {
    const source = cube(4)
    expect(validScaleFactors(source)).toEqual({ up: [2, 3, 4, 5, 6, 7, 8], down: [2, 4] })
    expect(computeScale(source, 'down', 2).voxelCount).toBe(8)
    expect(computeScale(source, 'down', 3).valid).toBe(false)
  })

  it('preserves local colors and source part ownership through shell generation', () => {
    const source = [
      { ...voxel(0, 0, 0), materialId: '#111111', paintMaterialId: '#ff0000', sourcePartId: 'part-a' },
      { ...voxel(1, 0, 0), materialId: '#222222', paintMaterialId: '#00ff00', sourcePartId: 'part-b' },
    ]
    const result = computeShell(source, 1)
    expect(result.voxels).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: 0, y: 0, z: 0, paintMaterialId: '#ff0000', sourcePartId: 'part-a' }),
      expect.objectContaining({ x: 1, y: 0, z: 0, paintMaterialId: '#00ff00', sourcePartId: 'part-b' }),
    ]))
  })

  it('reports lossy partial blocks when shrinking a divisible bounding box', () => {
    const source = [
      voxel(0, 0, 0), voxel(1, 0, 0), voxel(0, 1, 0),
      voxel(0, 0, 1), voxel(1, 1, 1),
    ]
    const result = computeScale(source, 'down', 2)
    expect(result.valid).toBe(true)
    expect(result.voxelCount).toBe(1)
    expect(result.warnings[0]).toContain('非完整体素块')
  })

  it('caps interactive enlargement factors instead of allocating an unbounded preview', () => {
    const factors = validScaleFactors([voxel(0, 0, 0)], 100)
    expect(factors.up.at(-1)).toBe(79)
    expect(computeScale([voxel(0, 0, 0)], 'up', 80).valid).toBe(false)
  })
})
