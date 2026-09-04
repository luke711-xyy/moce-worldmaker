export const MARD_221_PALETTE_ID = 'mard-221' as const

export type ColorPaletteId = typeof MARD_221_PALETTE_ID

export type PaletteEntry = {
  paletteId: ColorPaletteId
  code: string
  name: string
  hex: string
  rgb: readonly [number, number, number]
  materialId: string
}

export type SceneColorPolicy = {
  paletteId: ColorPaletteId
  maxColors: number
  allowedCodes: string[]
}

const RAW_MARD_221: ReadonlyArray<readonly [string, string]> = [
  ['A1', 'faf5cd'], ['A2', 'fcfed6'], ['A3', 'fcff92'], ['A4', 'f7ec5c'], ['A5', 'f0d83a'], ['A6', 'fda951'], ['A7', 'fa8c4f'], ['A8', 'fbda4d'], ['A9', 'f79d5f'], ['A10', 'f47e38'], ['A11', 'fedb99'], ['A12', 'fda276'], ['A13', 'fec667'], ['A14', 'f75842'], ['A15', 'fbf65e'], ['A16', 'feff97'], ['A17', 'fde173'], ['A18', 'fcbf80'], ['A19', 'fd7e77'], ['A20', 'f9d66e'], ['A21', 'fae393'], ['A22', 'edf878'], ['A23', 'e4c8ba'], ['A24', 'f3f6a9'], ['A25', 'ffd785'], ['A26', 'ffc734'],
  ['B1', 'dff13b'], ['B2', '64f343'], ['B3', 'a1f586'], ['B4', '5fdf34'], ['B5', '39e158'], ['B6', '64e0a4'], ['B7', '3eae7c'], ['B8', '1d9b54'], ['B9', '2a5037'], ['B10', '9ad1ba'], ['B11', '627032'], ['B12', '1a6e3d'], ['B13', 'c8e87d'], ['B14', 'abe84f'], ['B15', '305335'], ['B16', 'c0ed9c'], ['B17', '9eb33e'], ['B18', 'e6ed4f'], ['B19', '26b78e'], ['B20', 'cbeccf'], ['B21', '18616a'], ['B22', '0a4241'], ['B23', '343b1a'], ['B24', 'e8faa6'], ['B25', '4e846d'], ['B26', '907c35'], ['B27', 'd0e0af'], ['B28', '9ee5bb'], ['B29', 'c6df5f'], ['B30', 'e3fbb1'], ['B31', 'b4e691'], ['B32', '92ad60'],
  ['C1', 'f0fee4'], ['C2', 'abf8fe'], ['C3', 'a2e0f7'], ['C4', '44cdfb'], ['C5', '06aadf'], ['C6', '54a7e9'], ['C7', '3977ca'], ['C8', '0f52bd'], ['C9', '3349c3'], ['C10', '3cbce3'], ['C11', '2aded3'], ['C12', '1e334e'], ['C13', 'cde7fe'], ['C14', 'd5fcf7'], ['C15', '21c5c4'], ['C16', '1858a2'], ['C17', '02d1f3'], ['C18', '213244'], ['C19', '18869d'], ['C20', '1a70a9'], ['C21', 'bccdfc'], ['C22', '6bb1bb'], ['C23', 'c8e2fd'], ['C24', '7ec5f9'], ['C25', 'a9e8e0'], ['C26', '42adcf'], ['C27', 'd0def9'], ['C28', 'bdcee8'], ['C29', '364a89'],
  ['D1', 'acb7ef'], ['D2', '868dd3'], ['D3', '3554af'], ['D4', '162d7b'], ['D5', 'b34ec6'], ['D6', 'b37bdc'], ['D7', '8758a9'], ['D8', 'e3d2fe'], ['D9', 'd5b9f4'], ['D10', '301a49'], ['D11', 'beb9e2'], ['D12', 'dc99ce'], ['D13', 'b5038d'], ['D14', '862993'], ['D15', '2f1f8c'], ['D16', 'e2e4f0'], ['D17', 'c7d3f9'], ['D18', '9a64b8'], ['D19', 'd8c2d9'], ['D20', '9a35ad'], ['D21', '940595'], ['D22', '38389a'], ['D23', 'eadbf8'], ['D24', '768ae1'], ['D25', '4950c2'], ['D26', 'd6c6eb'],
  ['E1', 'f6d4cb'], ['E2', 'fcc1dd'], ['E3', 'f6bde8'], ['E4', 'e8649e'], ['E5', 'f0569f'], ['E6', 'eb4172'], ['E7', 'c53674'], ['E8', 'fddbe9'], ['E9', 'e376c7'], ['E10', 'd13b95'], ['E11', 'f7dad4'], ['E12', 'f693bf'], ['E13', 'b5026a'], ['E14', 'fad4bf'], ['E15', 'f5c9ca'], ['E16', 'fbf4ec'], ['E17', 'f7e3ec'], ['E18', 'f9c8db'], ['E19', 'f6bbd1'], ['E20', 'd7c6ce'], ['E21', 'c09da4'], ['E22', 'b38c9f'], ['E23', '937d8a'], ['E24', 'debee5'],
  ['F1', 'fe9381'], ['F2', 'f63d4b'], ['F3', 'ee4e3e'], ['F4', 'fb2a40'], ['F5', 'e10328'], ['F6', '913635'], ['F7', '911932'], ['F8', 'bb0126'], ['F9', 'e0677a'], ['F10', '874628'], ['F11', '592323'], ['F12', 'f3536b'], ['F13', 'f45c45'], ['F14', 'fcadb2'], ['F15', 'd50527'], ['F16', 'f8c0a9'], ['F17', 'e89b7d'], ['F18', 'd07f4a'], ['F19', 'be454a'], ['F20', 'c69495'], ['F21', 'f2b8c6'], ['F22', 'f7c3d0'], ['F23', 'ed806c'], ['F24', 'e09daf'], ['F25', 'e84854'],
  ['G1', 'ffe4d3'], ['G2', 'fcc6ac'], ['G3', 'f1c4a5'], ['G4', 'dcb387'], ['G5', 'e7b34e'], ['G6', 'e3a014'], ['G7', '985c3a'], ['G8', '713d2f'], ['G9', 'e4b685'], ['G10', 'da8c42'], ['G11', 'dac898'], ['G12', 'fec993'], ['G13', 'b2714b'], ['G14', '8b684c'], ['G15', 'f6f8e3'], ['G16', 'f2d8c1'], ['G17', '77544e'], ['G18', 'ffe3d5'], ['G19', 'dd7d41'], ['G20', 'a5452f'], ['G21', 'b38561'],
  ['H1', 'ffffff'], ['H2', 'fbfbfb'], ['H3', 'b4b4b4'], ['H4', '878787'], ['H5', '464648'], ['H6', '2c2c2c'], ['H7', '010101'], ['H8', 'e7d6dc'], ['H9', 'efedee'], ['H10', 'ebebeb'], ['H11', 'cdcdcd'], ['H12', 'fdf6ee'], ['H13', 'f4efd1'], ['H14', 'ced7d4'], ['H15', '9aa6a6'], ['H16', '1b1213'], ['H17', 'f0eeef'], ['H18', 'fcfff6'], ['H19', 'f2eee5'], ['H20', '96a09f'], ['H21', 'f8fbe6'], ['H22', 'cacad2'], ['H23', '9b9c94'],
  ['M1', 'bbc6b6'], ['M2', '909994'], ['M3', '697e81'], ['M4', 'e0d4bc'], ['M5', 'd1ccaf'], ['M6', 'b0aa86'], ['M7', 'b0a796'], ['M8', 'ae8082'], ['M9', 'a68862'], ['M10', 'c4b3bb'], ['M11', '9d7693'], ['M12', '644b51'], ['M13', 'c79266'], ['M14', 'c27563'], ['M15', '747d7a'],
]

export function normalizeHexColor(value: string | undefined, fallback = '#878787'): string {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return fallback.toLowerCase()
  return value.toLowerCase()
}

function rgbFromHex(hex: string): readonly [number, number, number] {
  const value = normalizeHexColor(hex).slice(1)
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)]
}

export function paletteMaterialId(paletteId: ColorPaletteId, code: string): string {
  return `palette:${paletteId}:${code.toUpperCase()}`
}

export const MARD_221_ENTRIES: readonly PaletteEntry[] = RAW_MARD_221.map(([code, rawHex]) => {
  const hex = `#${rawHex.toLowerCase()}`
  return {
    paletteId: MARD_221_PALETTE_ID,
    code,
    name: `MARD ${code}`,
    hex,
    rgb: rgbFromHex(hex),
    materialId: paletteMaterialId(MARD_221_PALETTE_ID, code),
  }
})

const entryByCode = new Map(MARD_221_ENTRIES.map((entry) => [entry.code, entry]))
const entryByMaterialId = new Map(MARD_221_ENTRIES.map((entry) => [entry.materialId, entry]))
const paletteOrder = new Map(MARD_221_ENTRIES.map((entry, index) => [entry.code, index]))

export function mardEntryByCode(code: string | undefined): PaletteEntry | undefined {
  return code ? entryByCode.get(code.toUpperCase()) : undefined
}

export function paletteEntryByMaterialId(materialId: string | undefined): PaletteEntry | undefined {
  return materialId ? entryByMaterialId.get(materialId) : undefined
}

export function paletteColorForMaterialId(materialId: string | undefined): string | undefined {
  return paletteEntryByMaterialId(materialId)?.hex
}

export function createDefaultSceneColorPolicy(): SceneColorPolicy {
  return { paletteId: MARD_221_PALETTE_ID, maxColors: MARD_221_ENTRIES.length, allowedCodes: MARD_221_ENTRIES.map((entry) => entry.code) }
}

export function normalizeSceneColorPolicy(value: Partial<SceneColorPolicy> | null | undefined): SceneColorPolicy {
  const maxColors = Math.max(1, Math.min(MARD_221_ENTRIES.length, Math.round(value?.maxColors ?? MARD_221_ENTRIES.length)))
  const requested = [...new Set((value?.allowedCodes ?? []).map((code) => code.toUpperCase()).filter((code) => entryByCode.has(code)))]
  const allowedCodes = requested.slice(0, maxColors)
  for (const entry of MARD_221_ENTRIES) {
    if (allowedCodes.length >= maxColors) break
    if (!allowedCodes.includes(entry.code)) allowedCodes.push(entry.code)
  }
  allowedCodes.sort((left, right) => (paletteOrder.get(left) ?? 0) - (paletteOrder.get(right) ?? 0))
  return { paletteId: MARD_221_PALETTE_ID, maxColors, allowedCodes }
}

type LabColor = { l: number; a: number; b: number }

function rgbToLab(hex: string): LabColor {
  const [red, green, blue] = rgbFromHex(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175
  const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883
  const pivot = (value: number) => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116
  const fx = pivot(x)
  const fy = pivot(y)
  const fz = pivot(z)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

const radians = (degrees: number) => degrees * Math.PI / 180
const degrees = (angle: number) => angle * 180 / Math.PI

/** CIEDE2000 perceptual colour difference. */
export function deltaE2000(leftHex: string, rightHex: string): number {
  const left = rgbToLab(leftHex)
  const right = rgbToLab(rightHex)
  const c1 = Math.hypot(left.a, left.b)
  const c2 = Math.hypot(right.a, right.b)
  const cBar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))
  const a1Prime = (1 + g) * left.a
  const a2Prime = (1 + g) * right.a
  const c1Prime = Math.hypot(a1Prime, left.b)
  const c2Prime = Math.hypot(a2Prime, right.b)
  const hue = (b: number, a: number) => {
    const value = degrees(Math.atan2(b, a))
    return value < 0 ? value + 360 : value
  }
  const h1Prime = c1Prime === 0 ? 0 : hue(left.b, a1Prime)
  const h2Prime = c2Prime === 0 ? 0 : hue(right.b, a2Prime)
  const deltaL = right.l - left.l
  const deltaC = c2Prime - c1Prime
  let deltaHDegrees = h2Prime - h1Prime
  if (c1Prime * c2Prime === 0) deltaHDegrees = 0
  else if (deltaHDegrees > 180) deltaHDegrees -= 360
  else if (deltaHDegrees < -180) deltaHDegrees += 360
  const deltaH = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(radians(deltaHDegrees / 2))
  const lBar = (left.l + right.l) / 2
  const cPrimeBar = (c1Prime + c2Prime) / 2
  let hPrimeBar = h1Prime + h2Prime
  if (c1Prime * c2Prime === 0) hPrimeBar = h1Prime + h2Prime
  else if (Math.abs(h1Prime - h2Prime) <= 180) hPrimeBar /= 2
  else if (hPrimeBar < 360) hPrimeBar = (hPrimeBar + 360) / 2
  else hPrimeBar = (hPrimeBar - 360) / 2
  const t = 1
    - 0.17 * Math.cos(radians(hPrimeBar - 30))
    + 0.24 * Math.cos(radians(2 * hPrimeBar))
    + 0.32 * Math.cos(radians(3 * hPrimeBar + 6))
    - 0.2 * Math.cos(radians(4 * hPrimeBar - 63))
  const deltaTheta = 30 * Math.exp(-(((hPrimeBar - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(cPrimeBar ** 7 / (cPrimeBar ** 7 + 25 ** 7))
  const sl = 1 + 0.015 * (lBar - 50) ** 2 / Math.sqrt(20 + (lBar - 50) ** 2)
  const sc = 1 + 0.045 * cPrimeBar
  const sh = 1 + 0.015 * cPrimeBar * t
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc
  const lTerm = deltaL / sl
  const cTerm = deltaC / sc
  const hTerm = deltaH / sh
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rt * cTerm * hTerm)
}

export function nearestMardEntry(color: string, allowedCodes: readonly string[] = MARD_221_ENTRIES.map((entry) => entry.code)): PaletteEntry {
  const normalized = normalizeHexColor(color)
  const candidates = allowedCodes.map((code) => entryByCode.get(code.toUpperCase())).filter((entry): entry is PaletteEntry => Boolean(entry))
  const source = candidates.length ? candidates : MARD_221_ENTRIES
  let best = source[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of source) {
    const distance = deltaE2000(normalized, candidate.hex)
    if (distance < bestDistance - 1e-9) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export type WeightedColorSample = { color: string; weight: number }

function mappingCost(samples: readonly WeightedColorSample[], entries: readonly PaletteEntry[]): number {
  if (!entries.length) return Number.POSITIVE_INFINITY
  return samples.reduce((total, sample) => {
    let closest = Number.POSITIVE_INFINITY
    for (const entry of entries) closest = Math.min(closest, deltaE2000(sample.color, entry.hex))
    return total + closest * Math.max(0, sample.weight)
  }, 0)
}

/**
 * Select a deterministic, weighted subset of fixed MARD colours. The greedy
 * reduction step is followed by candidate swaps, so every result remains a
 * real purchasable bead colour rather than an arbitrary cluster centroid.
 */
export function optimizeMardAllowedCodes(samples: readonly WeightedColorSample[], requestedCount: number): string[] {
  const count = Math.max(1, Math.min(MARD_221_ENTRIES.length, Math.round(requestedCount)))
  if (count === MARD_221_ENTRIES.length) return MARD_221_ENTRIES.map((entry) => entry.code)
  const normalizedSamples = samples
    .filter((sample) => Number.isFinite(sample.weight) && sample.weight > 0)
    .map((sample) => ({ color: normalizeHexColor(sample.color), weight: sample.weight }))
  if (!normalizedSamples.length) {
    const selected: PaletteEntry[] = [nearestMardEntry('#808080')]
    while (selected.length < count) {
      let best: PaletteEntry | undefined
      let bestDistance = -1
      for (const candidate of MARD_221_ENTRIES) {
        if (selected.includes(candidate)) continue
        const distance = Math.min(...selected.map((entry) => deltaE2000(candidate.hex, entry.hex)))
        if (distance > bestDistance + 1e-9) { best = candidate; bestDistance = distance }
      }
      if (!best) break
      selected.push(best)
    }
    return selected.map((entry) => entry.code).sort((left, right) => (paletteOrder.get(left) ?? 0) - (paletteOrder.get(right) ?? 0))
  }
  // Textured imports can contain tens of thousands of distinct source RGB
  // values. Candidate selection only needs their weighted relationship to the
  // purchasable MARD colours, so aggregate them to the nearest catalogue
  // colour first. This bounds optimisation to 221 weighted samples without
  // discarding sourceColor from the actual voxels used for final remapping.
  const quantizedWeights = new Map<string, number>()
  normalizedSamples.forEach((sample) => {
    const entry = nearestMardEntry(sample.color)
    quantizedWeights.set(entry.code, (quantizedWeights.get(entry.code) ?? 0) + sample.weight)
  })
  const optimizationSamples = [...quantizedWeights].map(([code, weight]) => ({ color: mardEntryByCode(code)!.hex, weight }))
  const distances = optimizationSamples.map((sample) => MARD_221_ENTRIES.map((entry) => deltaE2000(sample.color, entry.hex)))
  const selected: PaletteEntry[] = []
  const selectedIndices = new Set<number>()
  const bestDistances = optimizationSamples.map(() => Number.POSITIVE_INFINITY)
  while (selected.length < count) {
    let bestIndex = -1
    let bestCost = Number.POSITIVE_INFINITY
    for (let candidateIndex = 0; candidateIndex < MARD_221_ENTRIES.length; candidateIndex += 1) {
      if (selectedIndices.has(candidateIndex)) continue
      let cost = 0
      for (let sampleIndex = 0; sampleIndex < optimizationSamples.length; sampleIndex += 1) {
        cost += Math.min(bestDistances[sampleIndex], distances[sampleIndex][candidateIndex]) * optimizationSamples[sampleIndex].weight
      }
      if (cost < bestCost - 1e-9) { bestIndex = candidateIndex; bestCost = cost }
    }
    if (bestIndex < 0) break
    selected.push(MARD_221_ENTRIES[bestIndex])
    selectedIndices.add(bestIndex)
    for (let sampleIndex = 0; sampleIndex < optimizationSamples.length; sampleIndex += 1) {
      bestDistances[sampleIndex] = Math.min(bestDistances[sampleIndex], distances[sampleIndex][bestIndex])
    }
  }
  // A bounded local swap improves small, highly compressed palettes. Large
  // palettes already have dense coverage and would gain little from an
  // O(k²) search.
  let currentCost = mappingCost(optimizationSamples, selected)
  for (let pass = 0; pass < (count <= 16 ? 2 : 0); pass += 1) {
    let improved = false
    for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
      for (const candidate of MARD_221_ENTRIES) {
        if (selected.includes(candidate)) continue
        const trial = selected.map((entry, index) => index === selectedIndex ? candidate : entry)
        const cost = mappingCost(normalizedSamples, trial)
        if (cost < currentCost - 1e-9) {
          selected[selectedIndex] = candidate
          currentCost = cost
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return selected.map((entry) => entry.code).sort((left, right) => (paletteOrder.get(left) ?? 0) - (paletteOrder.get(right) ?? 0))
}

export function completeMardAllowedCodes(preferredCodes: readonly string[], requestedCount: number): string[] {
  const count = Math.max(1, Math.min(MARD_221_ENTRIES.length, Math.round(requestedCount)))
  const selected = [...new Set(preferredCodes.map((code) => code.toUpperCase()).filter((code) => entryByCode.has(code)))].slice(0, count)
  if (!selected.length) selected.push(nearestMardEntry('#808080').code)
  while (selected.length < count) {
    let bestCode = ''
    let bestDistance = -1
    for (const candidate of MARD_221_ENTRIES) {
      if (selected.includes(candidate.code)) continue
      const distance = Math.min(...selected.map((code) => deltaE2000(candidate.hex, entryByCode.get(code)!.hex)))
      if (distance > bestDistance + 1e-9) { bestCode = candidate.code; bestDistance = distance }
    }
    if (!bestCode) break
    selected.push(bestCode)
  }
  return selected.sort((left, right) => (paletteOrder.get(left) ?? 0) - (paletteOrder.get(right) ?? 0))
}

export function readableTextColor(background: string): '#111111' | '#ffffff' {
  const [red, green, blue] = rgbFromHex(background).map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 > 0.48 ? '#111111' : '#ffffff'
}
