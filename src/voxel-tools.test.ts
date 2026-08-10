import { describe, expect, it } from 'vitest'
import { EDITOR_GROUND_PLANE, brushOffsets, clampPlanePointToGround, exteriorAirKeys, exteriorSurfaceVoxels, makePlaneVoxel, planePointToVoxel, projectVoxelToPlane, rasterizeAnchoredSphere, rasterizeCuboid, rasterizeExtrude, rasterizeLine, rasterizeLine2D, rasterizeSphere, rasterizeBrush, rasterizePlanarStroke, selectExtrudeLayer, signedExtrudeDelta } from './voxel-tools'

describe('voxel plane tools', () => {
  it('maps all three drawing planes without changing the fixed axis', () => {
    expect(planePointToVoxel('xy', { u: 2, v: 3, layer: 4 })).toEqual({ x: 2, y: 3, z: 4 })
    expect(planePointToVoxel('xz', { u: 2, v: 3, layer: 4 })).toEqual({ x: 2, y: 4, z: 3 })
    expect(planePointToVoxel('yz', { u: 2, v: 3, layer: 4 })).toEqual({ x: 4, y: 2, z: 3 })
    expect(projectVoxelToPlane('xy', { x: 2, y: 3, z: 4 })).toEqual({ u: 2, v: 3, layer: 4 })
  })

  it('keeps brush offsets deterministic and cached by size', () => {
    expect(brushOffsets(1)).toEqual([{ u: 0, v: 0 }])
    expect(brushOffsets(2)).toHaveLength(4)
    expect(brushOffsets(99)).toEqual(brushOffsets(99))
    expect(brushOffsets(100).length).toBeGreaterThan(brushOffsets(99).length)
    expect(rasterizeBrush('xy', { u: 4, v: 5, layer: 7 }, 1, 'red')[0]).toEqual({ x: 4, y: 5, z: 7, materialId: 'red' })
  })

  it('uses one deterministic cell set for a continuous planar stroke', () => {
    const stroke = rasterizePlanarStroke('xz', { u: 0, v: 0, layer: 2 }, { u: 3, v: 2, layer: 2 }, 1, 'red')
    expect(stroke).toHaveLength(4)
    expect(stroke.every((voxel) => voxel.y === 2)).toBe(true)
    expect(stroke[0]).toEqual({ x: 0, y: 2, z: 0, materialId: 'red' })
    expect(stroke.at(-1)).toEqual({ x: 3, y: 2, z: 2, materialId: 'red' })
  })

  it('rasterizes diagonal lines without an empty endpoint', () => {
    const cells = rasterizeLine2D({ u: 0, v: 0, layer: 0 }, { u: 4, v: 2, layer: 0 })
    expect(cells[0]).toEqual({ u: 0, v: 0 })
    expect(cells.at(-1)).toEqual({ u: 4, v: 2 })
    expect(cells.length).toBeGreaterThanOrEqual(5)
  })

  it('creates cuboids and true voxel spheres', () => {
    expect(rasterizeCuboid('xy', { u: 0, v: 0, layer: 0 }, { u: 1, v: 2, layer: 0 }, 0, 2)).toHaveLength(18)
    expect(rasterizeSphere({ x: 0, y: 0, z: 0 }, 1)).toHaveLength(7)
    expect(makePlaneVoxel('yz', 2, 3, 4)).toEqual({ x: 4, y: 2, z: 3, materialId: '' })
  })

  it('keeps shape tools on the editor XY ground plane', () => {
    expect(EDITOR_GROUND_PLANE).toBe('xz')
    const cuboid = rasterizeCuboid(EDITOR_GROUND_PLANE, { u: 2, v: 3, layer: 0 }, { u: 3, v: 4, layer: 0 }, 0, 2)
    expect(cuboid).toHaveLength(12)
    expect(cuboid.every((voxel) => voxel.y >= 0 && voxel.y <= 2)).toBe(true)
    expect(cuboid.every((voxel) => voxel.x >= 2 && voxel.x <= 3 && voxel.z >= 3 && voxel.z <= 4)).toBe(true)

    const sphere = rasterizeAnchoredSphere(EDITOR_GROUND_PLANE, { u: 4, v: 5, layer: 0 }, { u: 6, v: 5, layer: 0 }, 0)
    expect(Math.min(...sphere.map((voxel) => voxel.y))).toBe(0)
    expect(sphere.some((voxel) => voxel.x === 4 && voxel.y === 2 && voxel.z === 5)).toBe(true)
  })

  it('anchors a sphere on the selected ground layer', () => {
    const voxels = rasterizeAnchoredSphere('xy', { u: 2, v: 3, layer: 0 }, { u: 5, v: 3, layer: 0 }, 0)
    expect(Math.min(...voxels.map((voxel) => voxel.y))).toBe(0)
    expect(Math.max(...voxels.map((voxel) => voxel.y))).toBe(6)
  })

  it('supports shape tools starting on an elevated XZ layer', () => {
    const cuboid = rasterizeCuboid('xz', { u: 2, v: 3, layer: 5 }, { u: 3, v: 4, layer: 5 }, 5, 5)
    expect(cuboid.every((voxel) => voxel.y === 5)).toBe(true)
    const sphere = rasterizeAnchoredSphere('xz', { u: 4, v: 5, layer: 5 }, { u: 6, v: 5, layer: 5 }, 5)
    expect(Math.min(...sphere.map((voxel) => voxel.y))).toBe(5)
    expect(Math.max(...sphere.map((voxel) => voxel.y))).toBe(9)
  })

  it('clamps every drawing plane at the storage ground', () => {
    expect(clampPlanePointToGround('xy', { u: 2, v: -4, layer: 3 })).toEqual({ u: 2, v: 0, layer: 3 })
    expect(clampPlanePointToGround('xz', { u: 2, v: 3, layer: -4 })).toEqual({ u: 2, v: 3, layer: 0 })
    expect(clampPlanePointToGround('yz', { u: -4, v: 3, layer: 2 })).toEqual({ u: 0, v: 3, layer: 2 })
    expect(rasterizeCuboid('xy', { u: 0, v: -3, layer: 0 }, { u: 1, v: 1, layer: 0 }, 0, 0).every((voxel) => voxel.y >= 0)).toBe(true)
    expect(rasterizeLine('xy', { u: 0, v: -3, layer: 0 }, { u: 3, v: 2, layer: 0 }, 1).every((voxel) => voxel.y >= 0)).toBe(true)
    expect(rasterizeExtrude('xz', [{ x: 0, y: 0, z: 0, materialId: '' }], 0, -4).every((voxel) => voxel.y >= 0)).toBe(true)
  })

  it('does not treat a sealed cavity as external thumbnail air', () => {
    const shell = []
    for (let x = 0; x < 3; x += 1) for (let y = 0; y < 3; y += 1) for (let z = 0; z < 3; z += 1) {
      if (x === 1 && y === 1 && z === 1) continue
      shell.push({ x, y, z })
    }
    const air = exteriorAirKeys(shell)
    expect(air?.has('1,1,1')).toBe(false)
    expect(air?.has('-1,1,1')).toBe(true)
  })

  it('keeps the external thumbnail surface stable before and after shell extraction', () => {
    const solid: Array<{ x: number; y: number; z: number; materialId: string }> = []
    for (let x = 0; x < 3; x += 1) for (let y = 0; y < 3; y += 1) for (let z = 0; z < 3; z += 1) solid.push({ x, y, z, materialId: '#cc6633' })
    const hollow = solid.filter((voxel) => !(voxel.x === 1 && voxel.y === 1 && voxel.z === 1))
    const keys = (voxels: typeof solid) => new Set(exteriorSurfaceVoxels(voxels).map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
    expect(keys(solid)).toEqual(keys(hollow))
  })

  it('uses the explicitly selected extrusion axis instead of the drawing plane layer', () => {
    const source = [
      { x: 2, y: 4, z: 1, materialId: 'a' },
      { x: 2, y: 4, z: 3, materialId: 'b' },
      { x: 7, y: 4, z: 1, materialId: 'c' },
    ]
    const result = rasterizeExtrude('xy', source, 2, 2, 'x')
    expect(result).toEqual([
      { x: 3, y: 4, z: 1, materialId: 'a' },
      { x: 4, y: 4, z: 1, materialId: 'a' },
      { x: 3, y: 4, z: 3, materialId: 'b' },
      { x: 4, y: 4, z: 3, materialId: 'b' },
    ])
  })

  it('preserves each source voxel material across a multicolour extrusion layer', () => {
    const source = [
      { x: 2, y: 0, z: 0, materialId: '#ff0000' },
      { x: 2, y: 1, z: 0, materialId: '#00ff00', paintMaterialId: '#00aa00' },
    ]
    expect(rasterizeExtrude('xy', source, 2, 2, 'x', '#f28c28', 'add')).toEqual([
      { x: 3, y: 0, z: 0, materialId: '#ff0000' },
      { x: 4, y: 0, z: 0, materialId: '#ff0000' },
      { x: 3, y: 1, z: 0, materialId: '#00ff00', paintMaterialId: '#00aa00' },
      { x: 4, y: 1, z: 0, materialId: '#00ff00', paintMaterialId: '#00aa00' },
    ])
  })

  it('selects the complete clicked layer instead of the entity outer face', () => {
    const source = [
      { x: 0, y: 0, z: 0, materialId: 'a' },
      { x: 0, y: 1, z: 0, materialId: 'b' },
      { x: 0, y: 2, z: 0, materialId: 'c' },
      { x: 0, y: 2, z: 1, materialId: 'd' },
      { x: 1, y: 2, z: 0, materialId: 'e' },
      { x: 1, y: 2, z: 0, materialId: 'duplicate' },
    ]
    expect(selectExtrudeLayer(source, 'x', 1)).toEqual([source[4]])
    expect(selectExtrudeLayer(source, 'y', 2)).toEqual([source[2], source[3], source[4]])
    expect(selectExtrudeLayer(source, 'y', 1)).toEqual([source[1]])
  })

  it('marks extrusion preview cells with the active material in paint mode', () => {
    const result = rasterizeExtrude('xy', [{ x: 1, y: 2, z: 0, materialId: 'old' }], 1, 1, 'x', 'new', 'paint')
    expect(result).toEqual([{ x: 2, y: 2, z: 0, materialId: 'new' }])
  })

  it('preserves the selected negative axis direction when converting screen travel', () => {
    expect(signedExtrudeDelta(3, 1, 20)).toBe(3)
    expect(signedExtrudeDelta(3, -1, 20)).toBe(-3)
    expect(signedExtrudeDelta(-2, -1, 20)).toBe(2)
    expect(signedExtrudeDelta(99, -1, 4)).toBe(-4)
  })

  it('allows negative horizontal extrusion while keeping height above ground', () => {
    expect(rasterizeExtrude('xz', [{ x: 0, y: 3, z: 0, materialId: 'a' }], 0, -2, 'z'))
      .toEqual([
        { x: 0, y: 3, z: -1, materialId: 'a' },
        { x: 0, y: 3, z: -2, materialId: 'a' },
      ])
    expect(rasterizeExtrude('xz', [{ x: 0, y: 1, z: 0, materialId: 'a' }], 1, -4, 'y'))
      .toEqual([
        { x: 0, y: 0, z: 0, materialId: 'a' },
      ])
  })
})
