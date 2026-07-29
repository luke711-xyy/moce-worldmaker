import { describe, expect, it } from 'vitest'
import { importModelAsVoxelAsset } from './model-import'

describe('模型转体素', () => {
  it('turns a small OBJ mesh into editable voxels', async () => {
    const obj = `
v 0 0 0
v 2 0 0
v 2 2 0
v 0 2 0
v 0 0 2
v 2 0 2
v 2 2 2
v 0 2 2
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 5 1 4 8
`
    const asset = await importModelAsVoxelAsset(new File([obj], 'sample.obj'), 'terracotta')
    expect(asset.source).toBe('sample.obj')
    expect(asset.voxels.length).toBeGreaterThan(0)
    expect(asset.width).toBeGreaterThan(0)
    expect(asset.height).toBeGreaterThan(0)
  })
})
