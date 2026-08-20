import { describe, expect, it } from 'vitest'
import { SceneEntityPart } from './voxel'
import { sliceEntityParts, sliceLayerToAsset, slicePlaneLabel } from './slicing'

const part = (voxels: SceneEntityPart['voxels']): SceneEntityPart => ({
  id: 'part-1', kind: 'custom', partId: 'custom-1', memberKey: 'custom:custom-1', voxels,
})

describe('slicing', () => {
  it('maps all three planes and skips empty layers', () => {
    const layers = sliceEntityParts([part([
      { x: 2, y: 4, z: 7, materialId: 'primary' },
      { x: 3, y: 4, z: 7, materialId: 'primary' },
      { x: 2, y: 5, z: 9, materialId: 'accent' },
    ])], 'xy', () => '#abcdef')
    expect(layers.map((layer) => layer.coordinate)).toEqual([7, 9])
    expect(layers[0]).toMatchObject({ width: 2, height: 2, voxels: expect.any(Array) })
    expect(layers[1]).toMatchObject({ width: 2, height: 2, minU: 2, maxU: 3, minV: 4, maxV: 5 })
  })

  it('uses the selected coordinate as the layer axis', () => {
    const voxels = [{ x: 2, y: 4, z: 7, materialId: 'primary' }]
    expect(sliceEntityParts([part(voxels)], 'xy', () => '#fff')[0].coordinate).toBe(7)
    expect(sliceEntityParts([part(voxels)], 'xz', () => '#fff')[0].coordinate).toBe(4)
    expect(sliceEntityParts([part(voxels)], 'yz', () => '#fff')[0].coordinate).toBe(2)
  })

  it('uses the product plane naming convention for display labels', () => {
    expect(slicePlaneLabel('xy')).toBe('XZ')
    expect(slicePlaneLabel('xz')).toBe('XY')
    expect(slicePlaneLabel('yz')).toBe('YZ')
  })

  it('preserves resolved colors in exported slice assets', () => {
    const layer = sliceEntityParts([part([{ x: 2, y: 4, z: 7, materialId: 'primary' }])], 'xy', () => '#123456')[0]
    const asset = sliceLayerToAsset(layer, 'slice')
    expect(asset.voxels[0]).toMatchObject({ x: 0, y: 0, z: 0, paintMaterialId: '#123456' })
  })
})
