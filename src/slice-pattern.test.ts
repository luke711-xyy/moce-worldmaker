import { describe, expect, it } from 'vitest'
import { patternAxisLabels, slicePatternPages, slicePatternStats } from './slice-pattern'
import { SliceLayer } from './slicing'

const layer = (width: number, height: number): SliceLayer => ({
  plane: 'xy', coordinate: 0, index: 0, minU: 0, maxU: width - 1, minV: 0, maxV: height - 1, width, height,
  voxels: [
    { x: 0, y: 0, z: 0, materialId: 'palette:mard-221:F3', color: '#ee4e3e', colorCode: 'F3' },
    { x: 1, y: 0, z: 0, materialId: 'palette:mard-221:H2', color: '#fbfbfb', colorCode: 'H2' },
    { x: 2, y: 0, z: 0, materialId: 'palette:mard-221:F3', color: '#ee4e3e', colorCode: 'F3' },
  ],
})

describe('拼豆图纸数据', () => {
  it('labels 1, 6, 11 and the final cell on all axes', () => {
    expect(patternAxisLabels(12)).toEqual([{ index: 0, label: 1 }, { index: 5, label: 6 }, { index: 10, label: 11 }, { index: 11, label: 12 }])
  })

  it('counts MARD codes and sorts the legend by palette order', () => {
    expect(slicePatternStats(layer(12, 8))).toEqual({
      total: 3,
      colorCount: 2,
      legend: [{ code: 'F3', color: '#ee4e3e', count: 2 }, { code: 'H2', color: '#fbfbfb', count: 1 }],
    })
  })

  it('splits oversized layers into stable 52 by 52 pages', () => {
    const pages = slicePatternPages(layer(120, 70))
    expect(pages).toHaveLength(6)
    expect(pages[0]).toMatchObject({ startU: 0, endU: 51, startV: 18, endV: 69 })
    expect(pages.at(-1)).toMatchObject({ startU: 104, endU: 119, startV: 0, endV: 17 })
  })
})
