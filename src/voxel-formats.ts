import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { MATERIALS, Voxel, VoxelAsset, deduplicateVoxels, voxelBounds } from './voxel'
import { buildVariantGeometry } from './voxel-variant-geometry'
import { voxelFacing, voxelRotation, voxelShape } from './voxel-variants'

export type VoxImportResult = {
  asset: VoxelAsset
  modelCount: number
  warnings: string[]
}

type VoxModel = {
  width: number
  height: number
  depth: number
  voxels: Array<{ x: number; y: number; z: number; color: string }>
}

type ColorResolver = (voxel: Voxel) => string

const VOX_HEADER = 'VOX '
const VOX_VERSION = 150
const MAX_VOX_AXIS = 256
const FALLBACK_COLOR = '#6c827d'

function readFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function readInt32(view: DataView, offset: number): number {
  return view.getInt32(offset, true)
}

function readString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/, '')
}

function normalizeHex(value: string | undefined, fallback = FALLBACK_COLOR): string {
  if (!value) return fallback
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
  const material = MATERIALS.find((item) => item.id === value)
  return material?.color ?? fallback
}

function parseRgbaPalette(payload: Uint8Array): string[] {
  const palette = Array.from({ length: 256 }, () => FALLBACK_COLOR)
  for (let index = 0; index < Math.min(256, Math.floor(payload.length / 4)); index += 1) {
    const offset = index * 4
    const alpha = payload[offset + 3]
    if (alpha === 0) continue
    palette[index] = `#${[payload[offset], payload[offset + 1], payload[offset + 2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
  }
  MATERIALS.forEach((material, index) => {
    if (index + 1 < palette.length && palette[index + 1] === FALLBACK_COLOR) palette[index + 1] = normalizeHex(material.color)
  })
  return palette
}

export function parseVox(buffer: ArrayBuffer): { models: VoxModel[]; palette: string[] } {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  if (bytes.length < 20 || readFourCC(bytes, 0) !== VOX_HEADER) throw new Error('不是有效的 MagicaVoxel .vox 文件')
  const version = readUint32(view, 4)
  if (version !== VOX_VERSION) throw new Error(`暂不支持的 .vox 版本：${version}，当前支持版本 ${VOX_VERSION}`)
  if (readFourCC(bytes, 8) !== 'MAIN') throw new Error('.vox 文件缺少 MAIN 主块')

  const models: VoxModel[] = []
  const sizes: Array<{ width: number; height: number; depth: number }> = []
  const xyziPayloads: Uint8Array[] = []
  let palette = parseRgbaPalette(new Uint8Array())

  const walkChunks = (offset: number, limit: number) => {
    let cursor = offset
    while (cursor + 12 <= limit) {
      const id = readFourCC(bytes, cursor)
      const contentSize = readUint32(view, cursor + 4)
      const childrenSize = readUint32(view, cursor + 8)
      const contentStart = cursor + 12
      const contentEnd = contentStart + contentSize
      const childrenEnd = contentEnd + childrenSize
      if (contentEnd > limit || childrenEnd > limit) throw new Error('.vox 文件块长度超出文件范围')
      const content = bytes.subarray(contentStart, contentEnd)
      if (id === 'SIZE' && content.length >= 12) {
        sizes.push({ width: readInt32(new DataView(content.buffer, content.byteOffset, content.byteLength), 0), height: readInt32(new DataView(content.buffer, content.byteOffset, content.byteLength), 4), depth: readInt32(new DataView(content.buffer, content.byteOffset, content.byteLength), 8) })
      } else if (id === 'XYZI') {
        xyziPayloads.push(content)
      } else if (id === 'RGBA' && content.length >= 1024) {
        palette = parseRgbaPalette(content)
      }
      if (childrenSize) walkChunks(contentEnd, childrenEnd)
      cursor = childrenEnd
    }
  }
  walkChunks(20, bytes.length)
  const modelCount = Math.min(sizes.length, xyziPayloads.length)
  for (let modelIndex = 0; modelIndex < modelCount; modelIndex += 1) {
    const size = sizes[modelIndex]
    if (size.width < 1 || size.height < 1 || size.depth < 1 || size.width > MAX_VOX_AXIS || size.height > MAX_VOX_AXIS || size.depth > MAX_VOX_AXIS) throw new Error(`.vox 第 ${modelIndex + 1} 个模型尺寸超出 256³ 体素限制`)
    const payload = xyziPayloads[modelIndex]
    if (payload.length < 4) continue
    const count = readUint32(new DataView(payload.buffer, payload.byteOffset, payload.byteLength), 0)
    const voxels: VoxModel['voxels'] = []
    const available = Math.min(count, Math.floor((payload.length - 4) / 4))
    for (let index = 0; index < available; index += 1) {
      const offset = 4 + index * 4
      const x = payload[offset]
      const y = payload[offset + 1]
      const z = payload[offset + 2]
      const colorIndex = payload[offset + 3]
      if (x >= size.width || y >= size.height || z >= size.depth) continue
      voxels.push({ x, y, z, color: palette[colorIndex] ?? FALLBACK_COLOR })
    }
    models.push({ width: size.width, height: size.height, depth: size.depth, voxels })
  }
  if (!models.length || !models.some((model) => model.voxels.length)) throw new Error('.vox 文件中没有可读取的体素模型')
  return { models, palette }
}

export function importVoxBufferAsVoxelAsset(fileName: string, buffer: ArrayBuffer): VoxImportResult {
  const parsed = parseVox(buffer)
  const partVoxels: Record<string, Voxel[]> = {}
  const allVoxels: Voxel[] = []
  let width = 1
  let depth = 1
  let height = 1
  parsed.models.forEach((model, modelIndex) => {
    const partId = `vox-model-${modelIndex + 1}`
    const voxels = model.voxels.map((voxel) => ({
      // MagicaVoxel uses X/Y as the ground plane and Z as vertical. The
      // editor uses X/Z as the ground plane and Y as vertical.
      x: voxel.x,
      y: voxel.z,
      z: voxel.y,
      materialId: voxel.color,
    }))
    partVoxels[partId] = voxels
    allVoxels.push(...voxels)
    width = Math.max(width, model.width)
    depth = Math.max(depth, model.height)
    height = Math.max(height, model.depth)
  })
  const voxels = deduplicateVoxels(allVoxels)
  const colors = [...new Set(voxels.map((voxel) => normalizeHex(voxel.materialId)))]
  const asset: VoxelAsset = {
    id: `vox-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: fileName.replace(/\.vox$/i, '') || 'VOX 导入实体',
    style: 'VOX 导入',
    kind: 'imported',
    color: colors[0] ?? FALLBACK_COLOR,
    accent: colors[1] ?? colors[0] ?? '#d2a354',
    width,
    depth,
    height,
    parts: Object.keys(partVoxels),
    partVoxels,
    voxels,
    source: 'MagicaVoxel .vox 导入',
    isTemplate: false,
  }
  const warnings = parsed.models.length > 1
    ? ['文件包含多个 VOX 模型，已作为同一实体的多个可编辑部件导入；模型场景变换信息未写入标准体素资产。']
    : []
  return { asset, modelCount: parsed.models.length, warnings }
}

function colorDistance(left: string, right: string): number {
  const rgb = (color: string) => [0, 2, 4].map((offset) => parseInt(color.slice(offset + 1, offset + 3), 16))
  const a = rgb(normalizeHex(left))
  const b = rgb(normalizeHex(right))
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

function buildVoxPalette(voxels: Voxel[], colorResolver: ColorResolver): { palette: string[]; indices: Map<string, number> } {
  const unique = [...new Set(voxels.map((voxel) => normalizeHex(colorResolver(voxel))))]
  const palette = Array.from({ length: 256 }, () => '#000000')
  const colors = unique.slice(0, 255)
  colors.forEach((color, index) => { palette[index + 1] = color })
  const indices = new Map<string, number>()
  unique.forEach((color) => {
    const exactIndex = colors.indexOf(color)
    if (exactIndex >= 0) {
      indices.set(color, exactIndex + 1)
      return
    }
    let bestIndex = 1
    let bestDistance = Infinity
    colors.forEach((candidate, index) => {
      const distance = colorDistance(color, candidate)
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index + 1 }
    })
    indices.set(color, bestIndex)
  })
  return { palette, indices }
}

function chunk(id: string, content: Uint8Array<ArrayBufferLike>, children: Uint8Array<ArrayBufferLike> = new Uint8Array()): Uint8Array<ArrayBufferLike> {
  const bytes = new Uint8Array(12 + content.length + children.length)
  bytes.set([...id].map((character) => character.charCodeAt(0)), 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, content.length, true)
  view.setUint32(8, children.length, true)
  bytes.set(content, 12)
  bytes.set(children, 12 + content.length)
  return bytes
}

function concatBytes(...chunks: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(chunks.reduce((size, value) => size + value.length, 0))
  let offset = 0
  chunks.forEach((value) => { result.set(value, offset); offset += value.length })
  return result
}

export function encodeVox(asset: VoxelAsset, colorResolver: ColorResolver = (voxel) => voxel.materialId): ArrayBuffer {
  if (!asset.voxels.length) throw new Error('没有可导出的体素')
  const bounds = voxelBounds(asset.voxels)!
  const minX = bounds.min.x
  const minY = bounds.min.y
  const minZ = bounds.min.z
  const maxX = bounds.max.x
  const maxY = bounds.max.y
  const maxZ = bounds.max.z
  const width = maxX - minX + 1
  const depth = maxZ - minZ + 1
  const height = maxY - minY + 1
  if (Math.max(width, depth, height) > MAX_VOX_AXIS) throw new Error('.vox 单模型最大支持 256 × 256 × 256 体素；当前实体超出限制，请缩小或拆分后再导出')
  const { palette, indices } = buildVoxPalette(asset.voxels, colorResolver)
  const sizeContent = new Uint8Array(12)
  const sizeView = new DataView(sizeContent.buffer)
  sizeView.setInt32(0, width, true)
  // MagicaVoxel stores X/Y on the ground plane and Z vertically. The editor
  // stores X/Z on the ground plane and Y vertically, so the two dimensions
  // after X are intentionally written in the opposite order.
  sizeView.setInt32(4, depth, true)
  sizeView.setInt32(8, height, true)
  const xyziContent = new Uint8Array(4 + asset.voxels.length * 4)
  const xyziView = new DataView(xyziContent.buffer)
  xyziView.setUint32(0, asset.voxels.length, true)
  asset.voxels.forEach((voxel, index) => {
    const color = normalizeHex(colorResolver(voxel))
    const offset = 4 + index * 4
    xyziContent[offset] = voxel.x - minX
    xyziContent[offset + 1] = voxel.z - minZ
    xyziContent[offset + 2] = voxel.y - minY
    xyziContent[offset + 3] = indices.get(color) ?? 1
  })
  const rgbaContent = new Uint8Array(256 * 4)
  palette.forEach((color, index) => {
    const value = normalizeHex(color, '#000000').slice(1)
    const offset = index * 4
    rgbaContent[offset] = parseInt(value.slice(0, 2), 16)
    rgbaContent[offset + 1] = parseInt(value.slice(2, 4), 16)
    rgbaContent[offset + 2] = parseInt(value.slice(4, 6), 16)
    rgbaContent[offset + 3] = index === 0 ? 0 : 255
  })
  const children = concatBytes(chunk('SIZE', sizeContent), chunk('XYZI', xyziContent), chunk('RGBA', rgbaContent))
  const main = chunk('MAIN', new Uint8Array(), children)
  const header = new Uint8Array(8)
  header.set([...VOX_HEADER].map((character) => character.charCodeAt(0)), 0)
  new DataView(header.buffer).setUint32(4, VOX_VERSION, true)
  const output = concatBytes(header, main)
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer
}

type Face = { normal: [number, number, number]; corners: Array<[number, number, number]> }

const glbFaces: Face[] = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
]

function hexRgb(value: string): [number, number, number] {
  const color = normalizeHex(value)
  return [parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255]
}

export async function encodeGlb(asset: VoxelAsset, colorResolver: ColorResolver = (voxel) => voxel.materialId, voxelSizeMm = 1): Promise<ArrayBuffer> {
  if (!asset.voxels.length) throw new Error('没有可导出的体素')
  const occupied = new Set(asset.voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const scale = Math.max(0.0001, voxelSizeMm) / 1000
  const pushVertex = (x: number, y: number, z: number, normal: [number, number, number], color: [number, number, number]) => {
    positions.push(x * scale, y * scale, z * scale)
    normals.push(...normal)
    colors.push(...color)
  }
  asset.voxels.forEach((voxel) => {
    const color = hexRgb(colorResolver(voxel))
    if (voxelShape(voxel) !== 'cube') {
      const source = buildVariantGeometry(voxelShape(voxel) as Exclude<ReturnType<typeof voxelShape>, 'cube'>, voxelFacing(voxel), voxelRotation(voxel), voxel.variantId ?? 'isolated')
      for (let index = 0; index < source.indices.length; index += 3) {
        const triangle = [source.indices[index], source.indices[index + 1], source.indices[index + 2]]
        triangle.forEach((sourceIndex) => {
          const positionIndex = sourceIndex * 3
          // Runtime geometry is Three X/Z/Y; keep exported GLB in the
          // established storage X/Y/Z convention used by cube exports.
          const x = voxel.x + source.positions[positionIndex]
          const y = voxel.y + source.positions[positionIndex + 2]
          const z = voxel.z + source.positions[positionIndex + 1]
          const normal: [number, number, number] = [source.normals[positionIndex], source.normals[positionIndex + 2], source.normals[positionIndex + 1]]
          pushVertex(x, y, z, normal, color)
        })
      }
      return
    }
    glbFaces.forEach((face) => {
      const [dx, dy, dz] = face.normal
      if (occupied.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)) return
      const points = face.corners.map(([x, y, z]) => [voxel.x + x, voxel.y + y, voxel.z + z] as [number, number, number])
      const triangles = [[points[0], points[1], points[2]], [points[0], points[2], points[3]]]
      triangles.forEach((triangle) => triangle.forEach(([x, y, z]) => pushVertex(x, y, z, face.normal, color)))
    })
  })
  if (!positions.length) throw new Error('体素没有可见表面')
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = asset.name
  const scene = new THREE.Scene()
  scene.add(mesh)
  try {
    const result = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true })
    if (!(result instanceof ArrayBuffer)) throw new Error('GLB 导出器返回了非二进制数据')
    return result
  } finally {
    geometry.dispose()
    material.dispose()
  }
}
