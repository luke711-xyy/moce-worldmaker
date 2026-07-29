import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { Voxel, VoxelAsset } from './voxel'

function parseGltf(buffer: ArrayBuffer): Promise<THREE.Object3D> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', (result) => resolve(result.scene), reject)
  })
}

function modelFromStl(buffer: ArrayBuffer): THREE.Object3D {
  const geometry = new STLLoader().parse(buffer)
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#d2a354' }))
}

function modelFromObj(text: string): THREE.Object3D {
  return new OBJLoader().parse(text)
}

function addPoint(set: Set<string>, point: THREE.Vector3) {
  set.add(`${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`)
}

function sampleSegment(set: Set<string>, a: THREE.Vector3, b: THREE.Vector3) {
  const distance = a.distanceTo(b)
  const steps = Math.max(1, Math.ceil(distance * 2))
  for (let step = 0; step <= steps; step += 1) addPoint(set, a.clone().lerp(b, step / steps))
}

function sampleTriangle(set: Set<string>, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  sampleSegment(set, a, b)
  sampleSegment(set, b, c)
  sampleSegment(set, c, a)
  const ab = Math.max(1, Math.ceil(a.distanceTo(b) * 2))
  const ac = Math.max(1, Math.ceil(a.distanceTo(c) * 2))
  for (let i = 0; i <= ab; i += 1) {
    const edgeStart = a.clone().lerp(b, i / ab)
    for (let j = 0; j <= ac; j += 1) addPoint(set, edgeStart.clone().lerp(c, j / ac))
  }
}

function voxelizeObject(object: THREE.Object3D, materialId: string): Voxel[] {
  object.updateMatrixWorld(true)
  const sourcePoints: THREE.Vector3[] = []
  const triangles: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = []
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const position = geometry.getAttribute('position')
    if (!position) return
    const readPoint = (index: number) => new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld)
    const index = geometry.index
    for (let i = 0; i < (index ? index.count : position.count); i += 3) {
      const a = readPoint(index ? index.getX(i) : i)
      const b = readPoint(index ? index.getX(i + 1) : i + 1)
      const c = readPoint(index ? index.getX(i + 2) : i + 2)
      triangles.push([a, b, c])
      sourcePoints.push(a, b, c)
    }
  })
  if (!sourcePoints.length) return []
  const bounds = new THREE.Box3().setFromPoints(sourcePoints)
  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  const maxSize = Math.max(size.x, size.y, size.z, 0.001)
  const scale = 16 / maxSize
  const sampled = new Set<string>()
  const normalize = (point: THREE.Vector3) => point.clone().sub(center).multiplyScalar(scale)
  for (const [a, b, c] of triangles) sampleTriangle(sampled, normalize(a), normalize(b), normalize(c))

  // For closed-ish models, fill vertical columns so the result behaves like a printable solid.
  const columns = new Map<string, { min: number; max: number }>()
  for (const key of sampled) {
    const [x, y, z] = key.split(',').map(Number)
    const columnKey = `${x},${z}`
    const current = columns.get(columnKey)
    if (!current) columns.set(columnKey, { min: y, max: y })
    else { current.min = Math.min(current.min, y); current.max = Math.max(current.max, y) }
  }
  const filled = new Set<string>(sampled)
  for (const [columnKey, range] of columns) {
    const [x, z] = columnKey.split(',').map(Number)
    for (let y = range.min; y <= range.max; y += 1) filled.add(`${x},${y},${z}`)
  }
  const coordinates = Array.from(filled).map((key) => key.split(',').map(Number))
  const minX = Math.min(...coordinates.map(([x]) => x))
  const minY = Math.min(...coordinates.map(([, y]) => y))
  const minZ = Math.min(...coordinates.map(([, , z]) => z))
  return coordinates.map(([x, y, z]) => ({ x: x - minX, y: y - minY, z: z - minZ, materialId }))
}

export async function importModelAsVoxelAsset(file: File, materialId: string): Promise<VoxelAsset> {
  const extension = file.name.split('.').pop()?.toLowerCase()
  const buffer = await file.arrayBuffer()
  let object: THREE.Object3D
  if (extension === 'glb' || extension === 'gltf') object = await parseGltf(buffer)
  else if (extension === 'stl') object = modelFromStl(buffer)
  else if (extension === 'obj') object = modelFromObj(new TextDecoder().decode(buffer))
  else throw new Error('仅支持 GLB、OBJ、STL')
  const voxels = voxelizeObject(object, materialId)
  const width = Math.max(1, ...voxels.map((voxel) => voxel.x + 1))
  const height = Math.max(1, ...voxels.map((voxel) => voxel.y + 1))
  const depth = Math.max(1, ...voxels.map((voxel) => voxel.z + 1))
  return {
    id: `import-${Date.now()}`,
    name: file.name.replace(/\.[^/.]+$/, ''),
    style: '导入模型',
    kind: 'imported',
    color: '#a5a6a2',
    accent: '#d2a354',
    width,
    depth,
    height,
    parts: ['导入模型'],
    source: file.name,
    isTemplate: false,
    voxels,
  }
}
