import { describe, expect, it } from 'vitest'
import { brushOffsets, clampPlanePointToGround, makePlaneVoxel, planePointToVoxel, projectVoxelToPlane, rasterizeAnchoredSphere, rasterizeCuboid, rasterizeExtrude, rasterizeLine, rasterizeLine2D, rasterizeSphere, rasterizeBrush, rasterizePlanarStroke, signedExtrudeDelta } from './voxel-tools'

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

  it('anchors a sphere on the selected ground layer', () => {
    const voxels = rasterizeAnchoredSphere('xy', { u: 2, v: 3, layer: 0 }, { u: 5, v: 3, layer: 0 }, 0)
    expect(Math.min(...voxels.map((voxel) => voxel.y))).toBe(0)
    expect(Math.max(...voxels.map((voxel) => voxel.y))).toBe(6)
  })

  it('clamps every drawing plane at the storage ground', () => {
    expect(clampPlanePointToGround('xy', { u: 2, v: -4, layer: 3 })).toEqual({ u: 2, v: 0, layer: 3 })
    expect(clampPlanePointToGround('xz', { u: 2, v: 3, layer: -4 })).toEqual({ u: 2, v: 3, layer: 0 })
    expect(clampPlanePointToGround('yz', { u: -4, v: 3, layer: 2 })).toEqual({ u: 0, v: 3, layer: 2 })
    expect(rasterizeCuboid('xy', { u: 0, v: -3, layer: 0 }, { u: 1, v: 1, layer: 0 }, 0, 0).every((voxel) => voxel.y >= 0)).toBe(true)
    expect(rasterizeLine('xy', { u: 0, v: -3, layer: 0 }, { u: 3, v: 2, layer: 0 }, 1).every((voxel) => voxel.y >= 0)).toBe(true)
    expect(rasterizeExtrude('xz', [{ x: 0, y: 0, z: 0, materialId: '' }], 0, -4).every((voxel) => voxel.y >= 0)).toBe(true)
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
})
