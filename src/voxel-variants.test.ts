import { describe, expect, it } from 'vitest'
import { VOXEL_FACE_FRAMES, applyVoxelVariant, faceLocalCoordinates, makeVoxelVariant, oppositeVoxelFacing, rotationFromFaceLocalCoordinates, variantKey, voxelShape } from './voxel-variants'

describe('voxel variants', () => {
  it('keeps missing shape fields as ordinary cube cells', () => {
    expect(voxelShape({})).toBe('cube')
    expect(applyVoxelVariant({ x: 0, y: 0, z: 0, materialId: 'a', shape: 'stair' }, { shape: 'cube' })).toEqual({ x: 0, y: 0, z: 0, materialId: 'a' })
  })

  it('stores only shape, facing and rotation', () => {
    const variant = makeVoxelVariant('stair', '-z', 3)
    expect(variant).toEqual({ shape: 'stair', facing: '-z', rotation: 3 })
    expect(variantKey(variant)).toBe('stair:-z:3')
  })

  it('uses the opposite mounting face for an adjacent placement', () => {
    expect(oppositeVoxelFacing('+x')).toBe('-x')
    expect(oppositeVoxelFacing('-x')).toBe('+x')
    expect(oppositeVoxelFacing('+y')).toBe('-y')
    expect(oppositeVoxelFacing('-y')).toBe('+y')
    expect(oppositeVoxelFacing('+z')).toBe('-z')
    expect(oppositeVoxelFacing('-z')).toBe('+z')
  })

  it('maps the four face triangles to stable clockwise rotations', () => {
    expect(rotationFromFaceLocalCoordinates(-0.4, 0.05)).toBe(1) // click left, feature faces right
    expect(rotationFromFaceLocalCoordinates(-0.05, -0.4)).toBe(2) // click bottom, feature faces up
    expect(rotationFromFaceLocalCoordinates(0.4, -0.05)).toBe(3) // click right, feature faces left
    expect(rotationFromFaceLocalCoordinates(0.05, 0.4)).toBe(0) // click top, feature faces down
    expect(rotationFromFaceLocalCoordinates(0, 0)).toBe(0)
  })

  it('uses a face-relative coordinate system for every facing', () => {
    const center = { x: 4, y: 5, z: 6 }
    expect(faceLocalCoordinates('+x', { x: 4, y: 5, z: 5.4 }, center)).toMatchObject({ u: expect.closeTo(0.6), v: expect.closeTo(0) })
    expect(faceLocalCoordinates('+y', { x: 4, y: 5, z: 5.4 }, center)).toMatchObject({ u: expect.closeTo(0), v: expect.closeTo(0.6) })
    expect(faceLocalCoordinates('-z', { x: 3.4, y: 5.4, z: 6 }, center)).toMatchObject({ u: expect.closeTo(0.6), v: expect.closeTo(0.4) })
  })

  it('keeps every face frame orthonormal and right-handed', () => {
    for (const frame of Object.values(VOXEL_FACE_FRAMES)) {
      const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      const cross = [
        frame.right[1] * frame.up[2] - frame.right[2] * frame.up[1],
        frame.right[2] * frame.up[0] - frame.right[0] * frame.up[2],
        frame.right[0] * frame.up[1] - frame.right[1] * frame.up[0],
      ]
      expect(dot(frame.right, frame.up)).toBe(0)
      expect(dot(frame.right, frame.normal)).toBe(0)
      expect(dot(frame.up, frame.normal)).toBe(0)
      expect(cross[0]).toBeCloseTo(frame.normal[0])
      expect(cross[1]).toBeCloseTo(frame.normal[1])
      expect(cross[2]).toBeCloseTo(frame.normal[2])
    }
  })

})
