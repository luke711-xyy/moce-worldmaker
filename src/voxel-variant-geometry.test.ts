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
        for (const shape of ['tri-prism', 'quarter-cylinder', 'stair'] as const) {
          const geometry = buildVariantGeometry(shape, facing, rotation)
          expect(geometry.indices.length).toBeGreaterThan(0)
          expect(Math.max(...geometry.positions)).toBeLessThanOrEqual(1 + 1e-6)
          expect(Math.min(...geometry.positions)).toBeGreaterThanOrEqual(-1e-6)
          const expectedVolume = shape === 'tri-prism' ? 0.5 : shape === 'stair' ? 0.75 : Math.PI / 4
          expect(signedVolume(geometry.positions, geometry.indices)).toBeCloseTo(expectedVolume, 1)
        }
      }
    }
  })

  it('keeps a complete square mounting face on the clicked face', () => {
    for (const shape of ['tri-prism', 'quarter-cylinder', 'stair'] as const) {
      const geometry = buildVariantGeometry(shape, '+y', 0)
      const mountingVertices: Array<[number, number, number]> = []
      for (let index = 0; index < geometry.positions.length; index += 3) {
        const normal = [geometry.normals[index], geometry.normals[index + 1], geometry.normals[index + 2]]
        const point: [number, number, number] = [geometry.positions[index], geometry.positions[index + 1], geometry.positions[index + 2]]
        if (normal[2] > 0.999 && Math.abs(point[2] - 1) < 1e-6) mountingVertices.push(point)
      }
      const corners = new Set(mountingVertices.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`))
      expect(corners).toEqual(new Set(['0.000,0.000', '1.000,0.000', '0.000,1.000', '1.000,1.000']))
    }
  })

  it('keeps triangle winding and normals aligned after the storage-axis swap', () => {
    for (const shape of ['tri-prism', 'quarter-cylinder', 'stair'] as const) {
      const geometry = buildVariantGeometry(shape, '+y', 0)
      for (let index = 0; index < geometry.indices.length; index += 3) {
        const a = geometry.indices[index] * 3
        const b = geometry.indices[index + 1] * 3
        const c = geometry.indices[index + 2] * 3
        const ab = [geometry.positions[b] - geometry.positions[a], geometry.positions[b + 1] - geometry.positions[a + 1], geometry.positions[b + 2] - geometry.positions[a + 2]]
        const ac = [geometry.positions[c] - geometry.positions[a], geometry.positions[c + 1] - geometry.positions[a + 1], geometry.positions[c + 2] - geometry.positions[a + 2]]
        const cross = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ]
        const normal = [geometry.normals[a], geometry.normals[a + 1], geometry.normals[a + 2]]
        const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2]
        expect(dot).toBeGreaterThan(0)
      }
    }
  })

  it('can omit only the internal mounting face for realtime adjacency rendering', () => {
    for (const shape of ['tri-prism', 'quarter-cylinder', 'stair'] as const) {
      const closed = buildVariantGeometry(shape, '+y', 0, true)
      const open = buildVariantGeometry(shape, '+y', 0, false)
      expect(open.indices.length).toBe(closed.indices.length - 6)
    }
  })
})
