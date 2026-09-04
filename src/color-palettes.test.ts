import { describe, expect, it } from 'vitest'
import { MARD_221_ENTRIES, completeMardAllowedCodes, createDefaultSceneColorPolicy, deltaE2000, nearestMardEntry, optimizeMardAllowedCodes, paletteEntryByMaterialId } from './color-palettes'

describe('MARD 221 色卡', () => {
  it('contains the complete, unique A/B/C/D/E/F/G/H/M catalogue', () => {
    expect(MARD_221_ENTRIES).toHaveLength(221)
    expect(new Set(MARD_221_ENTRIES.map((entry) => entry.code)).size).toBe(221)
    expect(new Set(MARD_221_ENTRIES.map((entry) => entry.hex)).size).toBe(221)
    expect(Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'].map((group) => [group, MARD_221_ENTRIES.filter((entry) => entry.code.startsWith(group)).length]))).toEqual({ A: 26, B: 32, C: 29, D: 26, E: 24, F: 25, G: 21, H: 23, M: 15 })
    for (const entry of MARD_221_ENTRIES) {
      expect(entry.hex).toBe(`#${entry.rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`)
      expect(paletteEntryByMaterialId(entry.materialId)).toBe(entry)
    }
  })

  it('uses all 221 colours in a default scene', () => {
    const policy = createDefaultSceneColorPolicy()
    expect(policy.maxColors).toBe(221)
    expect(policy.allowedCodes).toHaveLength(221)
  })

  it('maps exact and nearby colours deterministically with perceptual distance', () => {
    expect(nearestMardEntry('#592323').code).toBe('F11')
    expect(nearestMardEntry('#5a2424').code).toBe('F11')
    expect(deltaE2000('#ffffff', '#ffffff')).toBeCloseTo(0, 8)
    expect(deltaE2000('#ffffff', '#010101')).toBeGreaterThan(90)
  })

  it('optimizes to a fixed number of real palette entries', () => {
    const samples = [
      { color: '#ff0000', weight: 40 },
      { color: '#00ff00', weight: 30 },
      { color: '#0000ff', weight: 20 },
      { color: '#ffffff', weight: 10 },
    ]
    const first = optimizeMardAllowedCodes(samples, 4)
    const second = optimizeMardAllowedCodes(samples, 4)
    expect(first).toEqual(second)
    expect(first).toHaveLength(4)
    expect(first.every((code) => MARD_221_ENTRIES.some((entry) => entry.code === code))).toBe(true)
  })

  it('keeps preferred scene codes before filling a larger allowance', () => {
    const completed = completeMardAllowedCodes(['F3', 'H2'], 4)
    expect(completed).toHaveLength(4)
    expect(completed).toEqual(expect.arrayContaining(['F3', 'H2']))
  })
})
