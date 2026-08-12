import { describe, expect, it } from 'vitest'
import { buildVariantGeometry } from './voxel-variant-geometry'

function signedVolume(positions: number[], indices: number[]) {
  let volume = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return Math.abs(volume)
}

describe('canonical non-cubic voxel geometry', () => {
  it('keeps all supported shapes inside one unit cell', () => {
    for (const shape of ['tri-prism', 'quarter-cylinder', 'stair'] as const) {
      const geometry = buildVariantGeometry(shape)
      expect(Math.min(...geometry.positions)).toBeGreaterThanOrEqual(-1e-6)
      expect(Math.max(...geometry.positions)).toBeLessThanOrEqual(1 + 1e-6)
    }
  })

  it('approximates the requested canonical volumes', () => {
    expect(signedVolume(buildVariantGeometry('tri-prism').positions, buildVariantGeometry('tri-prism').indices)).toBeCloseTo(0.5, 1)
    expect(signedVolume(buildVariantGeometry('quarter-cylinder').positions, buildVariantGeometry('quarter-cylinder').indices)).toBeCloseTo(Math.PI / 4, 1)
    expect(signedVolume(buildVariantGeometry('stair').positions, buildVariantGeometry('stair').indices)).toBeCloseTo(0.75, 1)
  })

  it('supports all six facings and four quarter turns', () => {
    for (const facing of ['+x', '-x', '+y', '-y', '+z', '-z'] as const) {
      for (const rotation of [0, 1, 2, 3] as const) {
        const geometry = buildVariantGeometry('tri-prism', facing, rotation)
        expect(geometry.indices.length).toBeGreaterThan(0)
        expect(Math.max(...geometry.positions)).toBeLessThanOrEqual(1 + 1e-6)
      }
    }
  })
})
