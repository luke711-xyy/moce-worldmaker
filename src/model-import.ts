import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { MATERIALS, Material, Voxel, VoxelAsset } from './voxel'

export type VoxelizeMode = 'surface' | 'solid'

export type ModelImportOptions = {
  /** Maximum output dimension in 1 mm voxels. */
  targetSizeMm?: number
  mode?: VoxelizeMode
  /** Fallback material for STL or models without a usable material color. */
  materialId?: string
  palette?: Material[]
  preserveParts?: boolean
  onProgress?: (progress: number, label: string) => void
}

export type ModelImportDiagnostics = {
  sourceFormat: 'glb' | 'gltf' | 'obj' | 'stl'
  mode: VoxelizeMode
  targetSizeMm: number
  triangleCount: number
  partCount: number
  closedMesh: boolean
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
}

type NormalizedTriangle = Omit<ModelTriangle, 'a' | 'b' | 'c'> & {
  a: THREE.Vector3
  b: THREE.Vector3
  c: THREE.Vector3
}

const DEFAULT_TARGET_SIZE_MM = 32
const MAX_TARGET_SIZE_MM = 256
const SURFACE_DISTANCE_SQ = 0.75 // half the diagonal of a 1 mm voxel, squared
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

function materialIdForMesh(mesh: THREE.Mesh, palette: Material[], fallback: string): string {
  const directMaterial = materialColor(mesh.material)
  return nearestPaletteMaterial(directMaterial, palette, fallback)
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
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const position = geometry.getAttribute('position')
    if (!position) return
    const partId = uniquePartId(mesh.name || child.parent?.name || '模型主体', usedParts)
    const meshMaterial = materialIdForMesh(mesh, palette, fallbackMaterial)
    const index = geometry.index
    const getIndex = (offset: number) => index ? index.getX(offset) : offset
    for (let offset = 0; offset + 2 < (index ? index.count : position.count); offset += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(position, getIndex(offset)).applyMatrix4(mesh.matrixWorld)
      const b = new THREE.Vector3().fromBufferAttribute(position, getIndex(offset + 1)).applyMatrix4(mesh.matrixWorld)
      const c = new THREE.Vector3().fromBufferAttribute(position, getIndex(offset + 2)).applyMatrix4(mesh.matrixWorld)
      if (a.distanceToSquared(b) < EPSILON || b.distanceToSquared(c) < EPSILON || c.distanceToSquared(a) < EPSILON) continue
      triangles.push({ a, b, c, partId, materialId: meshMaterial })
    }
  })
  return triangles
}

function normalizeTriangles(triangles: ModelTriangle[], targetSizeMm: number): { triangles: NormalizedTriangle[]; width: number; height: number; depth: number } {
  const bounds = new THREE.Box3()
  triangles.forEach(({ a, b, c }) => bounds.expandByPoint(a).expandByPoint(b).expandByPoint(c))
  const size = bounds.getSize(new THREE.Vector3())
  const largest = Math.max(size.x, size.y, size.z, EPSILON)
  const scale = targetSizeMm / largest
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
        materialByKey.set(key, triangle.materialId)
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

function createAssetFromVoxelKeys(fileName: string, keys: Set<string>, materialByKey: Map<string, string>, partByKey: Map<string, string>, dimensions: { width: number; height: number; depth: number }, palette: Material[], fallbackMaterial: string, preserveParts: boolean, color: string): VoxelAsset {
  const voxels: Voxel[] = [...keys].map((key) => {
    const [x, y, z] = key.split(',').map(Number)
    return { x, y, z, materialId: materialByKey.get(key) ?? fallbackMaterial }
  })
  const grouped = new Map<string, Voxel[]>()
  if (preserveParts) {
    voxels.forEach((voxel) => {
      const key = voxelKey(voxel.x, voxel.y, voxel.z)
      const part = partByKey.get(key) ?? '模型主体'
      grouped.set(part, [...(grouped.get(part) ?? []), voxel])
    })
  }
  const parts = preserveParts && grouped.size ? [...grouped.keys()] : ['导入模型']
  const partVoxels = preserveParts && grouped.size ? Object.fromEntries(grouped.entries()) : undefined
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
    parts,
    partVoxels,
    source: fileName,
    isTemplate: false,
    voxels,
  }
}

export async function importModelBufferAsVoxelAssetWithDiagnostics(fileName: string, buffer: ArrayBuffer, options: ModelImportOptions = {}): Promise<ModelImportResult> {
  const extension = fileName.split('.').pop()?.toLowerCase() as ModelImportDiagnostics['sourceFormat'] | undefined
  if (extension !== 'glb' && extension !== 'gltf' && extension !== 'obj' && extension !== 'stl') throw new Error('仅支持 GLB、GLTF、OBJ、STL')
  const targetSizeMm = Math.max(1, Math.min(MAX_TARGET_SIZE_MM, Math.round(options.targetSizeMm ?? DEFAULT_TARGET_SIZE_MM)))
  const mode = options.mode ?? 'solid'
  const fallbackMaterial = options.materialId ?? 'terracotta'
  const palette = options.palette?.length ? options.palette : MATERIALS
  options.onProgress?.(0.02, '正在解析模型')
  let object: THREE.Object3D
  if (extension === 'glb' || extension === 'gltf') object = await parseGltf(buffer)
  else if (extension === 'stl') object = modelFromStl(buffer)
  else object = modelFromObj(new TextDecoder().decode(buffer))
  const triangles = extractTriangles(object, palette, fallbackMaterial)
  if (!triangles.length) throw new Error('模型中没有可读取的三角面')
  options.onProgress?.(0.12, `已读取 ${triangles.length} 个三角面`)
  const normalized = normalizeTriangles(triangles, targetSizeMm)
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
  const asset = createAssetFromVoxelKeys(fileName, keys, surface.materialByKey, surface.partByKey, dimensions, palette, fallbackMaterial, options.preserveParts !== false, palette.find((material) => material.id === fallbackMaterial)?.color ?? '#a5a6a2')
  options.onProgress?.(1, '体素化完成')
  return {
    asset,
    diagnostics: { sourceFormat: extension, mode, targetSizeMm, triangleCount: triangles.length, partCount: new Set(triangles.map((triangle) => triangle.partId)).size, closedMesh, warnings },
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
