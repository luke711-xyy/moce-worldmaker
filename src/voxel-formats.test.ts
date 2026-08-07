import { describe, expect, it } from 'vitest'
import { encodeVox, importVoxBufferAsVoxelAsset, parseVox } from './voxel-formats'
import { makeDefaultProject, VoxelAsset } from './voxel'

describe('莫测造境体素格式', () => {
  it('can round-trip a colored asset through MagicaVoxel VOX', () => {
    const base = makeDefaultProject().assets[0]
    const asset: VoxelAsset = {
      ...base,
      name: 'VOX 测试实体',
      width: 2,
      depth: 1,
      height: 2,
      parts: ['main'],
      voxels: [
        { x: 0, y: 0, z: 0, materialId: '#ff0000' },
        { x: 1, y: 1, z: 0, materialId: '#00ff00' },
      ],
    }
    const encoded = encodeVox(asset)
    const parsed = parseVox(encoded)
    expect(parsed.models).toHaveLength(1)
    expect(parsed.models[0].voxels).toHaveLength(2)
    const imported = importVoxBufferAsVoxelAsset('roundtrip.vox', encoded)
    expect(imported.asset.voxels).toEqual(expect.arrayContaining([
      { x: 0, y: 0, z: 0, materialId: '#ff0000' },
      { x: 1, y: 1, z: 0, materialId: '#00ff00' },
    ]))
  })

  it('converts MagicaVoxel Z-up into the editor Y-up axis', () => {
    const base = makeDefaultProject().assets[0]
    const encoded = encodeVox({
      ...base,
      width: 1,
      depth: 1,
      height: 3,
      voxels: [
        { x: 0, y: 0, z: 0, materialId: '#336699' },
        { x: 0, y: 2, z: 0, materialId: '#336699' },
      ],
    })
    const imported = importVoxBufferAsVoxelAsset('axis.vox', encoded)
    expect(imported.asset.voxels).toContainEqual({ x: 0, y: 2, z: 0, materialId: '#336699' })
  })
})
