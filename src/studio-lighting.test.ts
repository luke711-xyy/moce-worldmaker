import { describe, expect, it } from 'vitest'
import { STUDIO_RENDER_SETTINGS, studioFaceLight, studioShadeRgb } from './studio-lighting'

describe('studio lighting', () => {
  const axisNormals = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ] as const

  it('keeps every cardinal face above the readability floor', () => {
    axisNormals.forEach((normal) => {
      expect(studioFaceLight(normal)).toBeGreaterThanOrEqual(STUDIO_RENDER_SETTINGS.minFaceLight)
    })
  })

  it('gives the positive-Y face explicit fill instead of a near-black result', () => {
    expect(studioFaceLight([0, 1, 0])).toBeGreaterThan(0.8)
  })

  it('keeps AO as a readable attenuation rather than blackening the base color', () => {
    const shaded = studioShadeRgb([255, 128, 64], [0, -1, 0], 0)
    expect(shaded[0]).toBeGreaterThan(180)
    expect(shaded[1]).toBeGreaterThan(80)
    expect(shaded[2]).toBeGreaterThan(40)
  })
})
