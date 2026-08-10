import { describe, expect, it } from 'vitest'
import { adjustHexHsl, hexToHsl, hslToHex } from './color-utils'

describe('颜色 HSL 调整', () => {
  it('保留颜色的明度，按增量调整色调并设置绝对饱和度', () => {
    const source = '#e86f3d'
    const before = hexToHsl(source)
    const result = adjustHexHsl(source, 45, 60)
    const after = hexToHsl(result)

    expect(after.h).toBe((before.h + 45) % 360)
    expect(after.s).toBe(60)
    expect(after.l).toBeCloseTo(before.l, 2)
  })

  it('色调支持完整 360 度回绕，饱和度两端严格对应灰度和最高饱和度', () => {
    expect(hexToHsl(hslToHex(390, 140, 0.5)).h).toBe(30)
    expect(hexToHsl(adjustHexHsl('#e86f3d', 0, 0)).s).toBe(0)
    expect(hexToHsl(adjustHexHsl('#e86f3d', 0, 100)).s).toBe(100)
    expect(hexToHsl(adjustHexHsl('#ff0000', 360, 100)).h).toBe(0)
  })
})
