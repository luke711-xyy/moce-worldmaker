import { describe, expect, it } from 'vitest'
import type { Voxel } from './voxel'
import { applyVoxelVariant, deriveVariantId, makeVoxelVariant, neighborMaskFor, recomputeVoxelVariants, variantKey, voxelShape } from './voxel-variants'

describe('voxel variants', () => {
  it('keeps missing shape fields as ordinary cube cells', () => {
    expect(voxelShape({})).toBe('cube')
    expect(applyVoxelVariant({ x: 0, y: 0, z: 0, materialId: 'a', shape: 'stair' }, { shape: 'cube' })).toEqual({ x: 0, y: 0, z: 0, materialId: 'a' })
  })

  it('computes a six-face mask independent of material or owner', () => {
    const occupied = new Set(['1,0,0', '-1,0,0', '0,0,1'])
    expect(neighborMaskFor({ x: 0, y: 0, z: 0 }, occupied)).toBe(1 | 2 | 16)
  })

  it('derives stable shape-family variants and preserves facing', () => {
    const variant = makeVoxelVariant('stair', '-z', 3, 1 | 16)
    expect(variant).toEqual({ shape: 'stair', facing: '-z', rotation: 3, neighborMask: 17, variantId: 'corner' })
    expect(deriveVariantId('tri-prism', 1 | 2 | 16)).toBe('tee')
    expect(variantKey(variant)).toBe('stair:-z:3:corner')
  })

  it('only recomputes changed cells and their six neighbours', () => {
    const source: Voxel[] = [
      { x: 0, y: 0, z: 0, materialId: 'a', shape: 'stair' as const },
      { x: 1, y: 0, z: 0, materialId: 'a', shape: 'stair' as const },
      { x: 10, y: 0, z: 0, materialId: 'a', shape: 'stair' as const },
    ]
    const result = recomputeVoxelVariants(source, new Set(['0,0,0']))
    expect(result[0].neighborMask).toBe(1)
    expect(result[1].neighborMask).toBe(2)
    expect(result[2]).toEqual(source[2])
  })
})
