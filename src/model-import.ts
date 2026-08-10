import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { MATERIALS, Material, Voxel, VoxelAsset } from './voxel'

export type VoxelizeMode = 'surface' | 'solid'

export type ModelImportOptions = {
  /** Maximum output dimension measured in voxel cells. */
  targetSizeVoxels?: number
  mode?: VoxelizeMode
  /** Fallback material for STL or models without a usable material color. */
  materialId?: string
  palette?: Material[]
  onProgress?: (progress: number, label: string) => void
}

export type ModelImportDiagnostics = {
  sourceFormat: 'glb' | 'gltf' | 'obj' | 'stl' | 'vox'
  mode: VoxelizeMode
  targetSizeVoxels: number
  triangleCount: number
  partCount: number
  closedMesh: boolean
  voxelCount?: number
  warnings: string[]
}

export type ModelImportResult = {
  asset: VoxelAsset
  diagnostics: ModelImportDiagnostics
}

type ModelTriangle = {
  a: THREE.Vector3
  b: THREE.Vector3
  c: THREE.Vector3
  partId: string
  materialId: string
  baseColor?: string
  vertexColorA?: THREE.Color
  vertexColorB?: THREE.Color
  vertexColorC?: THREE.Color
  uvA?: THREE.Vector2
  uvB?: THREE.Vector2
  uvC?: THREE.Vector2
  textureSampler?: TextureSampler
}

type TextureSampler = (uv: THREE.Vector2) => string | undefined

type MaterialInfo = {
  materialId: string
  baseColor?: string
  textureSampler?: TextureSampler
}

type NormalizedTriangle = Omit<ModelTriangle, 'a' | 'b' | 'c'> & {
  a: THREE.Vector3
  b: THREE.Vector3
  c: THREE.Vector3
}

const DEFAULT_TARGET_SIZE_VOXELS = 32
export const MAX_TARGET_SIZE_VOXELS = 256
/** Neutral default for mesh formats without a preserved material pipeline. */
export const DEFAULT_IMPORTED_MODEL_COLOR = '#a5a6a2'
const SURFACE_DISTANCE_SQ = 0.75 // half the diagonal of one voxel cell, squared
const EPSILON = 1e-7

function parseGltf(buffer: ArrayBuffer): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', (result) => resolve(result.scene), reject)
  })
}

function modelFromStl(buffer: ArrayBuffer): THREE.Object3D {
  const geometry = new STLLoader().parse(buffer)
  // STL files conventionally use Z-up coordinates, while the editor's asset
  // grid uses Y as the vertical voxel axis.  Convert Z-up to the editor's
  // Y-up convention before bounds calculation and voxelization; otherwise a
  // standing model is imported lying on its side.
  geometry.rotateX(-Math.PI / 2)
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#d2a354' }))
}

function modelFromObj(text: string): THREE.Object3D {
  return new OBJLoader().parse(text)
}

function parseHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
}

function materialColor(material: THREE.Material | THREE.Material[] | undefined): string | undefined {
  const candidate = Array.isArray(material) ? material[0] : material
  const color = candidate && 'color' in candidate ? (candidate as THREE.MeshStandardMaterial).color : undefined
  return color instanceof THREE.Color ? `#${color.getHexString()}` : undefined
}

function normalizedAttributeChannel(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number, channel: 0 | 1 | 2): number {
  const value = channel === 0 ? attribute.getX(index) : channel === 1 ? attribute.getY(index) : attribute.getZ(index)
  // Three.js BufferAttribute#getX/Y/Z already normalizes integer attributes
  // when `normalized` is true. Keep this helper independent of the backing
  // typed-array width so it also works for InterleavedBufferAttributes.
  return Math.max(0, Math.min(1, value))
}

function srgbColorFromChannels(r: number, g: number, b: number): THREE.Color {
  const toHex = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')
  return new THREE.Color(`#${toHex(r)}${toHex(g)}${toHex(b)}`)
}

/** Read a GLTF COLOR_0 value, including normalized integer vertex colors. */
export function vertexColorAt(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, index: number): THREE.Color | undefined {
  if (!attribute || attribute.itemSize < 3) return undefined
  return srgbColorFromChannels(
    normalizedAttributeChannel(attribute, index, 0),
    normalizedAttributeChannel(attribute, index, 1),
    normalizedAttributeChannel(attribute, index, 2),
  )
}

function quantizedTextureHex(r: number, g: number, b: number): string {
  // Keep imported texture detail while bounding the number of per-voxel
  // materials. Sixteen levels per channel are enough for voxel art and
  // prevent a textured model from creating one Three.js material per pixel.
  const quantize = (channel: number) => Math.max(0, Math.min(255, Math.round(channel / 17) * 17))
  return `#${[r, g, b].map((channel) => quantize(channel).toString(16).padStart(2, '0')).join('')}`
}

function textureSamplerForMaterial(material: THREE.Material | undefined): TextureSampler | undefined {
  const candidate = material as (THREE.Material & { map?: THREE.Texture; color?: THREE.Color }) | undefined
  const map = candidate?.map
  const image = map?.image as ({ width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } & CanvasImageSource) | undefined
  const width = image?.width || image?.naturalWidth || 0
  const height = image?.height || image?.naturalHeight || 0
  if (!map || !image || !width || !height || typeof OffscreenCanvas === 'undefined') return undefined
  try {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    context.drawImage(image, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height).data
    const baseColor = candidate.color ?? new THREE.Color('#ffffff')
    return (uv: THREE.Vector2) => {
      const transformed = uv.clone()
      map.transformUv(transformed)
      const x = Math.max(0, Math.min(width - 1, Math.floor(transformed.x * width)))
      const y = Math.max(0, Math.min(height - 1, Math.floor((1 - transformed.y) * height)))
      const offset = (y * width + x) * 4
      const alpha = pixels[offset + 3] / 255
      if (alpha <= 0) return undefined
      return quantizedTextureHex(pixels[offset] * baseColor.r, pixels[offset + 1] * baseColor.g, pixels[offset + 2] * baseColor.b)
    }
  } catch {
    // Some external GLTF textures are not readable by canvas because of
    // CORS or an unsupported image decoder. Fall back to material color.
    return undefined
  }
}

function colorDistance(left: string, right: string): number {
  const toRgb = (value: string) => [0, 2, 4].map((offset) => parseInt(value.slice(offset + 1, offset + 3), 16))
  const a = toRgb(left)
  const b = toRgb(right)
  return Math.sqrt(a.reduce((sum, channel, index) => sum + (channel - b[index]) ** 2, 0))
}

function nearestPaletteMaterial(color: string | undefined, palette: Material[], fallback: string): string {
  if (!color) return fallback
  let best = palette.find((material) => material.id === color || material.name.toLowerCase() === color.toLowerCase())
  if (best) return best.id
  best = palette
    .filter((material) => parseHexColor(material.color))
    .sort((left, right) => colorDistance(color, left.color) - colorDistance(color, right.color))[0]
  return best?.id ?? fallback
}

function materialInfoForMaterial(material: THREE.Material | undefined, palette: Material[], fallback: string): MaterialInfo {
  const baseColor = materialColor(material)
  return {
    materialId: nearestPaletteMaterial(baseColor, palette, fallback),
    baseColor,
    textureSampler: textureSamplerForMaterial(material),
  }
}

function materialAtTriangle(mesh: THREE.Mesh, offset: number): THREE.Material | undefined {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const geometry = mesh.geometry as THREE.BufferGeometry
  const group = geometry.groups.find((candidate) => offset >= candidate.start && offset < candidate.start + candidate.count)
  return materials[group?.materialIndex ?? 0]
}

function barycentricWeights(point: THREE.Vector3, triangle: NormalizedTriangle): [number, number, number] {
  const v0 = triangle.b.clone().sub(triangle.a)
  const v1 = triangle.c.clone().sub(triangle.a)
  const v2 = point.clone().sub(triangle.a)
  const d00 = v0.dot(v0)
  const d01 = v0.dot(v1)
  const d11 = v1.dot(v1)
  const d20 = v2.dot(v0)
  const d21 = v2.dot(v1)
  const denominator = d00 * d11 - d01 * d01
  if (Math.abs(denominator) < EPSILON) return [1 / 3, 1 / 3, 1 / 3]
  const v = (d11 * d20 - d01 * d21) / denominator
  const w = (d00 * d21 - d01 * d20) / denominator
  const u = 1 - v - w
  const positive = [u, v, w].map((weight) => Math.max(0, weight))
  const total = positive[0] + positive[1] + positive[2]
  return total > EPSILON ? [positive[0] / total, positive[1] / total, positive[2] / total] : [1 / 3, 1 / 3, 1 / 3]
}

function uniquePartId(requested: string, used: Set<string>): string {
  const base = requested.trim() || '模型主体'
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let suffix = 2
  while (used.has(`${base} ${suffix}`)) suffix += 1
  const result = `${base} ${suffix}`
  used.add(result)
  return result
}

function extractTriangles(object: THREE.Object3D, palette: Material[], fallbackMaterial: string): ModelTriangle[] {
  object.updateMatrixWorld(true)
  const triangles: ModelTriangle[] = []
  const usedParts = new Set<string>()
  const materialCache = new Map<THREE.Material, MaterialInfo>()
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const position = geometry.getAttribute('position')
    if (!position) return
    const partId = uniquePartId(mesh.name || child.parent?.name || '模型主体', usedParts)
    const index = geometry.index
    const uv = geometry.getAttribute('uv')
    const vertexColors = geometry.getAttribute('color')
    const getIndex = (offset: number) => index ? index.getX(offset) : offset
    for (let offset = 0; offset + 2 < (index ? index.count : position.count); offset += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(position, getIndex(offset)).applyMatrix4(mesh.matrixWorld)
      const b = new THREE.Vector3().fromBufferAttribute(position, getIndex(offset + 1)).applyMatrix4(mesh.matrixWorld)
      const c = new THREE.Vector3().fromBufferAttribute(position, getIndex(offset + 2)).applyMatrix4(mesh.matrixWorld)
      if (a.distanceToSquared(b) < EPSILON || b.distanceToSquared(c) < EPSILON || c.distanceToSquared(a) < EPSILON) continue
      const sourceMaterial = materialAtTriangle(mesh, offset)
      const info: MaterialInfo = sourceMaterial
        ? (materialCache.get(sourceMaterial) ?? (() => { const next = materialInfoForMaterial(sourceMaterial, palette, fallbackMaterial); materialCache.set(sourceMaterial, next); return next })())
        : { materialId: fallbackMaterial }
      const ia = getIndex(offset)
      const ib = getIndex(offset + 1)
      const ic = getIndex(offset + 2)
      triangles.push({
        a,
        b,
        c,
        partId,
        materialId: info.materialId,
        baseColor: info.baseColor,
        vertexColorA: vertexColorAt(vertexColors, ia),
        vertexColorB: vertexColorAt(vertexColors, ib),
        vertexColorC: vertexColorAt(vertexColors, ic),
        textureSampler: info.textureSampler,
        uvA: uv ? new THREE.Vector2(uv.getX(ia), uv.getY(ia)) : undefined,
        uvB: uv ? new THREE.Vector2(uv.getX(ib), uv.getY(ib)) : undefined,
        uvC: uv ? new THREE.Vector2(uv.getX(ic), uv.getY(ic)) : undefined,
      })
    }
  })
  return triangles
}

function normalizeTriangles(triangles: ModelTriangle[], targetSizeVoxels: number): { triangles: NormalizedTriangle[]; width: number; height: number; depth: number } {
  const bounds = new THREE.Box3()
  triangles.forEach(({ a, b, c }) => bounds.expandByPoint(a).expandByPoint(b).expandByPoint(c))
  const size = bounds.getSize(new THREE.Vector3())
  const largest = Math.max(size.x, size.y, size.z, EPSILON)
  const scale = targetSizeVoxels / largest
  const min = bounds.min.clone()
  const clean = (value: number) => Math.round(value * 1e9) / 1e9
  const normalize = (point: THREE.Vector3) => {
    const normalized = point.clone().sub(min).multiplyScalar(scale)
    return new THREE.Vector3(clean(normalized.x), clean(normalized.y), clean(normalized.z))
  }
  const normalized = triangles.map((triangle) => ({ ...triangle, a: normalize(triangle.a), b: normalize(triangle.b), c: normalize(triangle.c) }))
  const dimension = (value: number) => Math.max(1, Math.ceil(value - 1e-9))
  return {
    triangles: normalized,
    width: dimension(size.x * scale),
    height: dimension(size.y * scale),
    depth: dimension(size.z * scale),
  }
}

function pointTriangleDistanceSquared(point: THREE.Vector3, triangle: NormalizedTriangle): number {
  const ab = triangle.b.clone().sub(triangle.a)
  const ac = triangle.c.clone().sub(triangle.a)
  const ap = point.clone().sub(triangle.a)
  const d1 = ab.dot(ap)
  const d2 = ac.dot(ap)
  if (d1 <= 0 && d2 <= 0) return ap.lengthSq()
  const bp = point.clone().sub(triangle.b)
  const d3 = ab.dot(bp)
  const d4 = ac.dot(bp)
  if (d3 >= 0 && d4 <= d3) return bp.lengthSq()
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return point.distanceToSquared(triangle.a.clone().addScaledVector(ab, v))
  }
  const cp = point.clone().sub(triangle.c)
  const d5 = ab.dot(cp)
  const d6 = ac.dot(cp)
  if (d6 >= 0 && d5 <= d6) return cp.lengthSq()
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return point.distanceToSquared(triangle.a.clone().addScaledVector(ac, w))
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    return point.distanceToSquared(triangle.b.clone().addScaledVector(triangle.c.clone().sub(triangle.b), w))
  }
  const normal = ab.cross(ac).normalize()
  return Math.abs(point.clone().sub(triangle.a).dot(normal)) ** 2
}

function voxelKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

function interpolatedVertexColor(triangle: NormalizedTriangle, weights: [number, number, number]): THREE.Color | undefined {
  if (!triangle.vertexColorA || !triangle.vertexColorB || !triangle.vertexColorC) return undefined
  return new THREE.Color(
    triangle.vertexColorA.r * weights[0] + triangle.vertexColorB.r * weights[1] + triangle.vertexColorC.r * weights[2],
    triangle.vertexColorA.g * weights[0] + triangle.vertexColorB.g * weights[1] + triangle.vertexColorC.g * weights[2],
    triangle.vertexColorA.b * weights[0] + triangle.vertexColorB.b * weights[1] + triangle.vertexColorC.b * weights[2],
  )
}

function multipliedColorHex(baseColor: string, vertexColor: THREE.Color): string {
  return `#${new THREE.Color(baseColor).multiply(vertexColor).getHexString()}`
}

function markSurfaceVoxels(triangles: NormalizedTriangle[], dimensions: { width: number; height: number; depth: number }, onProgress?: (progress: number) => void): { keys: Set<string>; materialByKey: Map<string, string>; partByKey: Map<string, string> } {
  const keys = new Set<string>()
  const materialByKey = new Map<string, string>()
  const partByKey = new Map<string, string>()
  triangles.forEach((triangle, triangleIndex) => {
    const minX = Math.max(0, Math.floor(Math.min(triangle.a.x, triangle.b.x, triangle.c.x) - 1))
    const maxX = Math.min(dimensions.width - 1, Math.ceil(Math.max(triangle.a.x, triangle.b.x, triangle.c.x) + 1))
    const minY = Math.max(0, Math.floor(Math.min(triangle.a.y, triangle.b.y, triangle.c.y) - 1))
    const maxY = Math.min(dimensions.height - 1, Math.ceil(Math.max(triangle.a.y, triangle.b.y, triangle.c.y) + 1))
    const minZ = Math.max(0, Math.floor(Math.min(triangle.a.z, triangle.b.z, triangle.c.z) - 1))
    const maxZ = Math.min(dimensions.depth - 1, Math.ceil(Math.max(triangle.a.z, triangle.b.z, triangle.c.z) + 1))
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) for (let z = minZ; z <= maxZ; z += 1) {
      const key = voxelKey(x, y, z)
      const center = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
      if (pointTriangleDistanceSquared(center, triangle) <= SURFACE_DISTANCE_SQ) {
        keys.add(key)
        const weights = barycentricWeights(center, triangle)
        const sampledColor = triangle.textureSampler && triangle.uvA && triangle.uvB && triangle.uvC
          ? triangle.textureSampler(new THREE.Vector2(
            triangle.uvA.x * weights[0] + triangle.uvB.x * weights[1] + triangle.uvC.x * weights[2],
            triangle.uvA.y * weights[0] + triangle.uvB.y * weights[1] + triangle.uvC.y * weights[2],
          ))
          : undefined
        const vertexColor = interpolatedVertexColor(triangle, weights)
        const resolvedColor = vertexColor
          ? multipliedColorHex(sampledColor ?? triangle.baseColor ?? '#ffffff', vertexColor)
          : sampledColor
        materialByKey.set(key, resolvedColor ?? triangle.materialId)
        partByKey.set(key, triangle.partId)
      }
    }
    onProgress?.((triangleIndex + 1) / Math.max(1, triangles.length))
  })
  return { keys, materialByKey, partByKey }
}

function rayIntersectionX(origin: THREE.Vector3, triangle: NormalizedTriangle): number | undefined {
  const direction = new THREE.Vector3(1, 0, 0)
  const edge1 = triangle.b.clone().sub(triangle.a)
  const edge2 = triangle.c.clone().sub(triangle.a)
  const h = direction.clone().cross(edge2)
  const determinant = edge1.dot(h)
  if (Math.abs(determinant) < EPSILON) return undefined
  const inverse = 1 / determinant
  const s = origin.clone().sub(triangle.a)
  const u = inverse * s.dot(h)
  if (u < -EPSILON || u > 1 + EPSILON) return undefined
  const q = s.clone().cross(edge1)
  const v = inverse * direction.dot(q)
  if (v < -EPSILON || u + v > 1 + EPSILON) return undefined
  const distance = inverse * edge2.dot(q)
  return distance >= -EPSILON ? origin.x + distance : undefined
}

function fillSolidVoxels(triangles: NormalizedTriangle[], dimensions: { width: number; height: number; depth: number }, onProgress?: (progress: number) => void): Set<string> {
  const keys = new Set<string>()
  for (let y = 0; y < dimensions.height; y += 1) {
    for (let z = 0; z < dimensions.depth; z += 1) {
      const origin = new THREE.Vector3(-1, y + 0.5, z + 0.5)
      const intersections = triangles.map((triangle) => rayIntersectionX(origin, triangle)).filter((value): value is number => value !== undefined).sort((left, right) => left - right)
      const unique: number[] = []
      intersections.forEach((value) => { if (!unique.length || Math.abs(unique[unique.length - 1] - value) > 1e-5) unique.push(value) })
      for (let index = 0; index + 1 < unique.length; index += 2) {
        const start = Math.max(0, Math.ceil(unique[index] - 0.5))
        const end = Math.min(dimensions.width - 1, Math.ceil(unique[index + 1] - 0.5) - 1)
        for (let x = start; x <= end; x += 1) keys.add(voxelKey(x, y, z))
      }
    }
    onProgress?.((y + 1) / Math.max(1, dimensions.height))
  }
  return keys
}

function meshIsClosed(triangles: NormalizedTriangle[]): boolean {
  const edges = new Map<string, number>()
  const pointKey = (point: THREE.Vector3) => `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`
  triangles.forEach(({ a, b, c }) => {
    const points = [a, b, c]
    for (let index = 0; index < 3; index += 1) {
      const left = pointKey(points[index])
      const right = pointKey(points[(index + 1) % 3])
      const key = left < right ? `${left}|${right}` : `${right}|${left}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  })
  return edges.size > 0 && [...edges.values()].every((count) => count === 2)
}

function createAssetFromVoxelKeys(fileName: string, keys: Set<string>, materialByKey: Map<string, string>, dimensions: { width: number; height: number; depth: number }, palette: Material[], fallbackMaterial: string, color: string): VoxelAsset {
  const voxels: Voxel[] = [...keys].map((key) => {
    const [x, y, z] = key.split(',').map(Number)
    return { x, y, z, materialId: materialByKey.get(key) ?? fallbackMaterial }
  })
  const primaryMaterial = palette.find((material) => material.id === fallbackMaterial)
  return {
    id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: fileName.replace(/\.[^/.]+$/, ''),
    style: '导入模型',
    kind: 'imported',
    color: color || primaryMaterial?.color || '#a5a6a2',
    accent: '#d2a354',
    width: dimensions.width,
    depth: dimensions.depth,
    height: dimensions.height,
    parts: ['导入模型'],
    source: fileName,
    isTemplate: false,
    voxels,
  }
}

export async function importModelBufferAsVoxelAssetWithDiagnostics(fileName: string, buffer: ArrayBuffer, options: ModelImportOptions = {}): Promise<ModelImportResult> {
  const extension = fileName.split('.').pop()?.toLowerCase() as ModelImportDiagnostics['sourceFormat'] | undefined
  if (extension !== 'glb' && extension !== 'gltf' && extension !== 'obj' && extension !== 'stl') throw new Error('仅支持 GLB、GLTF、OBJ、STL')
  const targetSizeVoxels = Math.max(1, Math.min(MAX_TARGET_SIZE_VOXELS, Math.round(options.targetSizeVoxels ?? DEFAULT_TARGET_SIZE_VOXELS)))
  const mode = options.mode ?? 'solid'
  const fallbackMaterial = options.materialId ?? 'terracotta'
  const palette = options.palette?.length ? options.palette : MATERIALS
  // GLB/GLTF have an explicit material/vertex/texture color pipeline that is
  // sampled by markSurfaceVoxels(). STL and OBJ do not have a stable color
  // contract for this editor, so loader defaults and the active brush must
  // not leak into the imported entity. Those formats intentionally start
  // neutral gray and can be recolored by the user afterward.
  const preserveEmbeddedColors = extension === 'glb' || extension === 'gltf'
  const importedFallbackMaterial = preserveEmbeddedColors ? fallbackMaterial : DEFAULT_IMPORTED_MODEL_COLOR
  const importedColor = preserveEmbeddedColors
    ? palette.find((material) => material.id === fallbackMaterial)?.color ?? DEFAULT_IMPORTED_MODEL_COLOR
    : DEFAULT_IMPORTED_MODEL_COLOR
  options.onProgress?.(0.02, '正在解析模型')
  let object: THREE.Object3D
  if (extension === 'glb' || extension === 'gltf') object = await parseGltf(buffer)
  else if (extension === 'stl') object = modelFromStl(buffer)
  else object = modelFromObj(new TextDecoder().decode(buffer))
  const triangles = extractTriangles(object, palette, fallbackMaterial)
  if (!triangles.length) throw new Error('模型中没有可读取的三角面')
  options.onProgress?.(0.12, `已读取 ${triangles.length} 个三角面`)
  const normalized = normalizeTriangles(triangles, targetSizeVoxels)
  const dimensions = { width: normalized.width, height: normalized.height, depth: normalized.depth }
  const closedMesh = meshIsClosed(normalized.triangles)
  const surface = markSurfaceVoxels(normalized.triangles, dimensions, (progress) => options.onProgress?.(0.12 + progress * 0.38, '正在生成表面体素'))
  const keys = mode === 'solid'
    ? fillSolidVoxels(normalized.triangles, dimensions, (progress) => options.onProgress?.(0.5 + progress * 0.42, '正在填充实体体素'))
    : new Set(surface.keys)
  surface.keys.forEach((key) => keys.add(key))
  if (!keys.size) throw new Error('体素化结果为空，请检查模型尺寸或网格结构')
  const warnings: string[] = []
  if (mode === 'solid' && !closedMesh) warnings.push('模型不是封闭网格，实体填充结果可能需要手动修补')
  if (extension === 'stl') warnings.push('STL 不包含材质和部件信息，已使用默认颜色和材质')
  const materialByKey = preserveEmbeddedColors ? surface.materialByKey : new Map<string, string>()
  const asset = createAssetFromVoxelKeys(fileName, keys, materialByKey, dimensions, palette, importedFallbackMaterial, importedColor)
  options.onProgress?.(1, '体素化完成')
  return {
    asset,
    diagnostics: { sourceFormat: extension, mode, targetSizeVoxels, triangleCount: triangles.length, partCount: 1, closedMesh, warnings },
  }
}

export async function importModelAsVoxelAssetWithDiagnostics(file: File, options: ModelImportOptions = {}): Promise<ModelImportResult> {
  return importModelBufferAsVoxelAssetWithDiagnostics(file.name, await file.arrayBuffer(), options)
}

export async function importModelAsVoxelAssetInWorker(file: File, options: ModelImportOptions = {}): Promise<ModelImportResult> {
  if (typeof Worker === 'undefined') return importModelAsVoxelAssetWithDiagnostics(file, options)
  const buffer = await file.arrayBuffer()
  const { onProgress, ...serializableOptions } = options
  return new Promise<ModelImportResult>((resolve, reject) => {
    const worker = new Worker(new URL('./model-import.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ type: 'progress'; progress: number; label: string } | { type: 'result'; result: ModelImportResult } | { type: 'error'; message: string }>) => {
      if (event.data.type === 'progress') onProgress?.(event.data.progress, event.data.label)
      if (event.data.type === 'result') { worker.terminate(); resolve(event.data.result) }
      if (event.data.type === 'error') { worker.terminate(); reject(new Error(event.data.message)) }
    }
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || '模型体素化 Worker 失败')) }
    worker.postMessage({ fileName: file.name, buffer, options: serializableOptions }, [buffer])
  })
}

/** Backward-compatible convenience API used by the original prototype test. */
export async function importModelAsVoxelAsset(file: File, materialId = 'terracotta', options: Omit<ModelImportOptions, 'materialId'> = {}): Promise<VoxelAsset> {
  const result = await importModelAsVoxelAssetWithDiagnostics(file, { ...options, materialId })
  return result.asset
}
