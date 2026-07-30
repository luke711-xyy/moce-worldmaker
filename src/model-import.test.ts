import { describe, expect, it } from 'vitest'
import { importModelAsVoxelAsset, importModelAsVoxelAssetWithDiagnostics } from './model-import'

const cubeObj = `
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

describe('模型转体素', () => {
  it('turns a small OBJ mesh into editable voxels', async () => {
    const asset = await importModelAsVoxelAsset(new File([cubeObj], 'sample.obj'), 'terracotta', { targetSizeMm: 8 })
    expect(asset.source).toBe('sample.obj')
    expect(asset.voxels.length).toBeGreaterThan(0)
    expect(asset.width).toBeGreaterThan(0)
    expect(asset.height).toBeGreaterThan(0)
  })

  it('uses the requested millimetre size instead of a fixed prototype size', async () => {
    const result = await importModelAsVoxelAssetWithDiagnostics(new File([cubeObj], 'cube.obj'), { targetSizeMm: 8, mode: 'solid' })
    expect(Math.max(result.asset.width, result.asset.height, result.asset.depth)).toBe(8)
    expect(result.diagnostics.closedMesh).toBe(true)
  })

  it('supports surface-only and solid voxelization modes', async () => {
    const file = new File([cubeObj], 'cube.obj')
    const surface = await importModelAsVoxelAssetWithDiagnostics(file, { targetSizeMm: 8, mode: 'surface' })
    const solid = await importModelAsVoxelAssetWithDiagnostics(file, { targetSizeMm: 8, mode: 'solid' })
    expect(solid.asset.voxels.length).toBeGreaterThan(surface.asset.voxels.length)
  })

  it('warns when solid mode receives an open mesh', async () => {
    const openObj = `v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3`
    const result = await importModelAsVoxelAssetWithDiagnostics(new File([openObj], 'open.obj'), { mode: 'solid' })
    expect(result.diagnostics.closedMesh).toBe(false)
    expect(result.diagnostics.warnings.some((warning) => warning.includes('封闭网格'))).toBe(true)
  })
})
