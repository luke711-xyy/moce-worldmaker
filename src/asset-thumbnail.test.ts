import { describe, expect, it } from 'vitest'
import { assetPreviewAsset, withAssetThumbnail } from './asset-thumbnail'
import { VoxelAsset } from './voxel'

function asset(voxels: number): VoxelAsset {
  return {
    id: 'asset-test',
    name: '测试实体',
    style: '测试',
    kind: 'imported',
    color: '#d26945',
    accent: '#ffffff',
    width: voxels,
    depth: 1,
    height: 1,
    parts: ['主体'],
    voxels: Array.from({ length: voxels }, (_, x) => ({ x, y: 0, z: 0, materialId: 'primary' })),
  }
}

describe('资产库静态缩略图', () => {
  it('creates a bounded thumbnail snapshot instead of rendering the source array', () => {
    const source = asset(32)
    const stored = withAssetThumbnail(source)
    expect(stored.thumbnail?.version).toBe(1)
    expect(stored.thumbnail?.sourceVoxelCount).toBe(source.voxels.length)
    expect(stored.thumbnail?.voxels).not.toBe(source.voxels)

    const preview = assetPreviewAsset(stored)
    expect(preview.voxels).toBe(stored.thumbnail?.voxels)
    expect(preview.partVoxels).toBeUndefined()
  })

  it('reuses a valid snapshot and invalidates it after geometry changes', () => {
    const source = asset(4)
    const stored = withAssetThumbnail(source)
    expect(withAssetThumbnail(stored)).toBe(stored)

    const changed = withAssetThumbnail({
      ...stored,
      voxels: [...stored.voxels, { x: 4, y: 0, z: 0, materialId: 'primary' }],
    })
    expect(changed).not.toBe(stored)
    expect(changed.thumbnail?.sourceVoxelCount).toBe(5)
  })
})
