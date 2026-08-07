export type HslColor = { h: number; s: number; l: number }

export function hexToHsl(hex: string): HslColor {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '6c827d'
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h = Math.round(h * 60)
    if (h < 0) h += 360
  }
  const l = (max + min) / 2
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))
  return { h, s: Math.round(s * 100), l }
}

export function hslToHex(h: number, saturation: number, lightness: number): string {
  const s = Math.max(0, Math.min(100, saturation)) / 100
  const l = Math.max(0, Math.min(1, lightness))
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const sector = ((h % 360) + 360) % 360 / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  const [r1, g1, b1] = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = l - chroma / 2
  return `#${[r1, g1, b1].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Rotate the source hue while setting an absolute saturation target.
 *
 * Hue is intentionally a delta so multi-colour entities keep their relative
 * colour relationships. Saturation is an absolute slider value: 0 is always
 * grayscale and 100 is always the maximum saturation. This also makes the
 * control deterministic for entities whose voxels start with different
 * saturation values.
 */
export function adjustHexHsl(color: string, hueDelta: number, saturationTarget: number): string {
  const source = hexToHsl(color)
  return hslToHex(source.h + hueDelta, saturationTarget, source.l)
}
