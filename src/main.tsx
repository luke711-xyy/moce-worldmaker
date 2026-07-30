import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Box, Brush, ChevronDown, ChevronRight, CircleUserRound, Database, Download, Eraser, Eye, FilePlus2, FolderOpen, Grid3X3, Layers3, Lock, Minus, Move3d, Paintbrush, Palette, Plus, Redo2, RotateCcw, RotateCw, Save, Search, Settings, SlidersHorizontal, Square, SquareDashedMousePointer, Trash2, Undo2, Upload, WandSparkles, X } from 'lucide-react'
import { AssetAssembly, DEFAULT_ASSET_CATEGORY, MATERIALS, Material, ProjectState, SceneAssembly, SceneBounds, SceneEntityPart, SceneInstance, Voxel, VoxelAsset, VoxelOverride, VOXEL_WORLD_SIZE, adjacentVoxel, assetOriginGridCoordinate, findInstanceVoxelAtSceneVoxel, highestVoxelAt, instanceLocalVoxelToSceneVoxel, makeAssetFromSceneParts, makeDefaultProject, makeStl, mirrorVoxels, normalizeAssetCategoryPath, normalizeProjectNaming, resolveInstanceComponents, resolveInstanceSceneVoxels, resolveInstanceVoxels, rotateVoxels, sceneAssemblies, sceneBoundsForProject, sceneEntityParts, snapAssetOrigin, snapWorld, uniqueAssetName, uniqueTemplateAssetName, voxelCenterToWorld, voxelComponentAt, voxelComponentId, voxelComponents, voxelEntityId, voxelToWorld, worldToVoxel, worldToVoxelCell, worldToVoxelCenter } from './voxel'
import { createSceneFile, MoceSceneFile, parseSceneFileText, restoreProject, sceneContentSignature } from './scene-file'
import { LibraryResponse, deleteAsset as deleteStoredAsset, deleteScene as deleteLibraryScene, duplicateScene, importScene, loadLibrary, loadScene, saveAsset, saveAssetCategories, saveScene, validateEntityFile } from './persistence'
import { createAssetFile, createEntityFile, MoceAssetFile, MoceEntityFile, parsePortableFileText, PortableFileError } from './portable-files'
import { importModelAsVoxelAssetInWorker, ModelImportResult, VoxelizeMode } from './model-import'
import { SceneOccupancyIndex } from './runtime/spatial-index'
import { AssetTransformCache } from './runtime/asset-transform-cache'
import { raycastVoxelDda } from './runtime/voxel-dda'
import { ChunkMeshWorkerClient } from './runtime/chunk-mesh-client'
import './styles.css'

declare global {
  interface Window {
    __MOCE_PERFORMANCE__?: {
      renderCount: number
      drawCalls: number
      triangles: number
      geometries: number
      textures: number
      lastRenderAt: number
    }
  }
}

type Tool = 'select' | 'brush' | 'erase'
type CameraViewId = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'front-top' | 'front-bottom' | 'back-top' | 'back-bottom' | 'front-left' | 'front-right' | 'back-left' | 'back-right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'front-top-left' | 'front-top-right' | 'front-bottom-left' | 'front-bottom-right' | 'back-top-left' | 'back-top-right' | 'back-bottom-left' | 'back-bottom-right'
type CameraView = 'default' | CameraViewId
type CameraControlApi = {
  rotate: (deltaX: number, deltaY: number) => void
  view: (view: CameraViewId) => void
  reset: () => void
  zoomIn: () => void
  zoomOut: () => void
}

type SelectGesture = {
  pointerId: number
  kind: 'parts'
  parts: SceneEntityPart[]
  startX: number
  startY: number
  startGroundX: number
  startGroundY: number
  startVerticalZ: number
  verticalPlane: { normalX: number; normalY: number; constant: number }
  lastDeltaX: number
  lastDeltaY: number
  lastDeltaZ: number
  visualRoots: Array<{ object: THREE.Object3D; startPosition: THREE.Vector3 }>
  moved: boolean
}

type BoxSelectGesture = {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
  moved: boolean
}

type GridMoveResult = {
  moved: boolean
  blocked: boolean
  deltaX: number
  deltaY: number
  deltaZ: number
}

type PlacementPreview = {
  assetId: string
  x: number
  y: number
  z: number
  valid: boolean
}

type CopyDirectionAxis = 'x' | 'y' | 'z'

type CopyPreviewState = {
  count: number
  gap: number
  axis: CopyDirectionAxis
  sign: 1 | -1
  sourceInstanceIds: string[]
  sourceCustomIds: string[]
  asset: VoxelAsset
  origin: { x: number; y: number; z: number }
  offsets: Array<{ x: number; y: number; z: number }>
  valid: boolean
  invalidReason?: 'collision' | 'boundary'
}

type SceneVoxelRayHit = {
  voxel: Voxel
  normal: Pick<Voxel, 'x' | 'y' | 'z'>
  ownerIds: string[]
}

type TreeContextMenuState = {
  targetId: string
  assemblyId?: string
  x: number
  y: number
} | null

type AssetContextMenuState = {
  assetId: string
  x: number
  y: number
} | null

type AssetCategoryContextMenuState = {
  path: string[]
  x: number
  y: number
} | null

type SceneLibraryContextMenuState = {
  sceneId: string
  x: number
  y: number
} | null

type SceneEntityContextMenuState = {
  assetId: string
  x: number
  y: number
} | null

type AssetCategorySaveState = {
  asset: VoxelAsset
} | null

type ModelImportDialogState = {
  file: File
  result: ModelImportResult | null
  error: string
  progress: number
  progressLabel: string
  busy: boolean
}

type PendingEntityImport = {
  asset: VoxelAsset
  entityCount: number
}

type SceneFileRef = {
  name: string
  libraryId?: string
  fileHandle?: FileSystemFileHandle
}

type UnsavedDecision = 'cancel' | 'save' | 'discard'

type SceneTreeItem = {
  id: string
  label: string
  kind: 'assembly' | 'part'
  assemblyId?: string
  part?: SceneEntityPart
  children?: SceneTreeItem[]
}

const CURRENT_SCENE_ID = 'scene-main'
type PersistenceStatus = 'loading' | 'saved' | 'offline'
const MIN_ZOOM_LEVEL = 50
const MAX_ZOOM_LEVEL = 2000
const WHEEL_ZOOM_INPUT_GAIN = 4

function clampZoomLevel(value: number): number {
  return Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, value))
}

function scenePartBaseName(project: ProjectState, part: SceneEntityPart): string {
  if (part.kind === 'custom') return part.label ?? '手动体素实体'
  const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
  const asset = instance ? project.assets.find((item) => item.id === instance.assetId) : undefined
  return `${asset?.name ?? '场景实体'}${part.label && part.label !== part.partId ? ` · ${part.label}` : ''}`
}

function sceneEntityTreeName(project: ProjectState, part: SceneEntityPart): string {
  const storedName = project.entityNames?.[part.memberKey]
  if (storedName) return storedName
  return scenePartBaseName(project, part)
}

function materialColorForVoxel(project: ProjectState, voxel: Voxel, asset?: VoxelAsset): string {
  if (voxel.materialId.startsWith('#')) return voxel.materialId
  if (voxel.materialId === 'primary') return asset?.color ?? '#6c827d'
  if (voxel.materialId === 'accent') return asset?.accent ?? '#d2a354'
  return project.materials.find((material) => material.id === voxel.materialId)?.color
    ?? MATERIALS.find((material) => material.id === voxel.materialId)?.color
    ?? asset?.color
    ?? '#6c827d'
}

function scenePartsDisplayColor(project: ProjectState, parts: SceneEntityPart[], asset?: VoxelAsset): string {
  const override = parts.map((part) => part.colorOverride).find(Boolean)
  if (override) return override!
  if (asset?.templateColor) return asset.templateColor
  const firstVoxel = parts.flatMap((part) => part.voxels)[0]
  return firstVoxel ? materialColorForVoxel(project, firstVoxel, asset) : asset?.color ?? '#6c827d'
}

function scenePartVoxelDisplayColor(project: ProjectState, part: SceneEntityPart, voxel: Voxel): string {
  const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
  const asset = instance ? project.assets.find((item) => item.id === instance.assetId) : undefined
  const variant = asset && !asset.templateColor ? styleMaterialVariants[instance?.style ?? ''] : undefined
  const renderAsset = variant && asset ? { ...asset, color: variant.color, accent: variant.accent } : asset
  return part.colorOverride ?? renderAsset?.templateColor ?? materialColorForVoxel(project, voxel, renderAsset)
}

function normalizeStoredProject(loaded: ProjectState): ProjectState {
  const defaultAssets = new Map(makeDefaultProject().assets.map((asset) => [asset.id, asset]))
  const normalized: ProjectState = {
    ...loaded,
    sceneBounds: sceneBoundsForProject(loaded),
    assets: (loaded.assets ?? []).map((asset) => ({
      ...asset,
      categoryPath: normalizeAssetCategoryPath(asset.categoryPath),
      partVoxels: asset.partVoxels ?? defaultAssets.get(asset.id)?.partVoxels,
      isTemplate: asset.isTemplate ?? (!asset.source || asset.source === '场景实体保存' || (asset.kind !== 'imported' && !asset.source.includes('拆分子实体'))),
    })),
    customVoxels: (loaded.customVoxels ?? []).map((voxel, index) => ({ ...voxel, entityId: voxel.entityId ?? `legacy-${voxel.x}-${voxel.y}-${voxel.z}-${index}` })),
    customColors: { ...(loaded.customColors ?? {}) },
    entityNames: { ...(loaded.entityNames ?? {}) },
    entityNameModes: { ...(loaded.entityNameModes ?? {}) },
    entityNameSequences: { ...(loaded.entityNameSequences ?? {}) },
    entityNameParents: { ...(loaded.entityNameParents ?? {}) },
    entitySequenceCounters: { ...(loaded.entitySequenceCounters ?? {}) },
    assemblySequence: Math.max(1, loaded.assemblySequence ?? 1),
    assemblyChildSequence: { ...(loaded.assemblyChildSequence ?? {}) },
    childSequenceCounters: { ...(loaded.childSequenceCounters ?? {}) },
    assemblies: (loaded.assemblies ?? []).map((assembly) => ({ ...assembly, memberKeys: [...assembly.memberKeys] })),
    instances: [],
    lockedMemberKeys: [...new Set(loaded.lockedMemberKeys ?? [])],
  }
  const assetMap = new Map(normalized.assets.map((asset) => [asset.id, asset]))
  normalized.instances = (loaded.instances ?? []).map((instance) => {
    const asset = assetMap.get(instance.assetId)
    return {
      ...instance,
      x: snapAssetOrigin(instance.x, asset?.width ?? 1),
      y: snapWorld(instance.y ?? 0),
      z: snapAssetOrigin(instance.z, asset?.depth ?? 1),
      overrides: instance.overrides ?? [],
      partOffsets: Object.fromEntries(Object.entries(instance.partOffsets ?? {}).map(([partId, offset]) => [partId, {
        x: snapWorld(offset.x),
        y: snapWorld(offset.y),
        z: snapWorld(offset.z),
      }])),
    }
  })
  return normalizeProjectNaming(normalized)
}

function scenePartIsLocked(project: ProjectState, part: SceneEntityPart): boolean {
  const lockedKeys = new Set(project.lockedMemberKeys ?? [])
  if (lockedKeys.has(part.memberKey)) return true
  const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
  return assemblyIds.some((assemblyId) => {
    const assembly = project.assemblies?.find((item) => item.id === assemblyId)
    return Boolean(lockedKeys.has(`assembly:${assemblyId}`) || assembly?.memberKeys.some((memberKey) => lockedKeys.has(memberKey)))
  })
}

function sceneVoxelWithinBounds(voxel: Voxel, bounds: SceneBounds): boolean {
  const halfVoxel = VOXEL_WORLD_SIZE / 2
  const width = bounds.x * VOXEL_WORLD_SIZE
  const depth = bounds.y * VOXEL_WORLD_SIZE
  const height = bounds.z * VOXEL_WORLD_SIZE
  const centerX = voxelCenterToWorld(voxel.x)
  const centerY = voxelCenterToWorld(voxel.z)
  const centerZ = voxelCenterToWorld(voxel.y)
  return Math.abs(centerX) + halfVoxel <= width / 2 + 0.0001
    && Math.abs(centerY) + halfVoxel <= depth / 2 + 0.0001
    && centerZ - halfVoxel >= -0.0001
    && centerZ + halfVoxel <= height + 0.0001
}

function sceneVoxelsWithinBounds(voxels: Voxel[], bounds: SceneBounds): boolean {
  return voxels.every((voxel) => sceneVoxelWithinBounds(voxel, bounds))
}

const sharedVoxelBoxGeometry = new THREE.BoxGeometry(VOXEL_WORLD_SIZE, VOXEL_WORLD_SIZE, VOXEL_WORLD_SIZE)
sharedVoxelBoxGeometry.userData.sharedRuntimeGeometry = true

function disposeThreeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      if (!child.geometry.userData.sharedRuntimeGeometry) child.geometry.dispose()
      const material = child.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material.dispose()
    }
  })
}

function createGroundGrid(bounds: SceneBounds) {
  const width = bounds.x * VOXEL_WORLD_SIZE
  const depth = bounds.y * VOXEL_WORLD_SIZE
  const grid = new THREE.Group()
  grid.name = 'editing-grid'
  // Keep both grid layers below the voxel base. A grid at z=0 or above can
  // become coplanar with, or enter, the bottom voxel faces and then appear to
  // cut through entities because of depth precision and line rasterization.
  for (const gridZ of [-0.006, -0.002]) {
    const positions: number[] = []
    for (let index = 0; index <= bounds.x; index += 1) {
      const x = -width / 2 + index * VOXEL_WORLD_SIZE
      positions.push(x, -depth / 2, gridZ, x, depth / 2, gridZ)
    }
    for (let index = 0; index <= bounds.y; index += 1) {
      const y = -depth / 2 + index * VOXEL_WORLD_SIZE
      positions.push(-width / 2, y, gridZ, width / 2, y, gridZ)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const material = new THREE.LineBasicMaterial({ color: '#354449', transparent: true, opacity: 0.9, depthTest: true, depthWrite: false })
    const layer = new THREE.LineSegments(geometry, material)
    layer.name = 'editing-grid-layer'
    layer.renderOrder = 1
    grid.add(layer)
  }
  return grid
}

function createGroundBoundary(bounds: SceneBounds) {
  const width = bounds.x * VOXEL_WORLD_SIZE
  const depth = bounds.y * VOXEL_WORLD_SIZE
  const group = new THREE.Group()
  group.name = 'editing-ground-boundary'
  const material = new THREE.MeshBasicMaterial({ color: '#d47a5b', transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: true, depthWrite: false })
  const thickness = Math.max(0.045, VOXEL_WORLD_SIZE * 0.42)
  const bars = [
    { width: width + thickness, depth: thickness, x: 0, y: -depth / 2 },
    { width: width + thickness, depth: thickness, x: 0, y: depth / 2 },
    { width: thickness, depth: depth - thickness, x: -width / 2, y: 0 },
    { width: thickness, depth: depth - thickness, x: width / 2, y: 0 },
  ]
  bars.forEach((bar) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(bar.width, bar.depth), material.clone())
    mesh.position.set(bar.x, bar.y, -0.001)
    mesh.name = 'editing-ground-boundary-edge'
    mesh.renderOrder = 1
    group.add(mesh)
  })
  return group
}

function createBoundaryBox(bounds: SceneBounds) {
  const width = bounds.x * VOXEL_WORLD_SIZE
  const depth = bounds.y * VOXEL_WORLD_SIZE
  const height = bounds.z * VOXEL_WORLD_SIZE
  const x0 = -width / 2
  const x1 = width / 2
  const y0 = -depth / 2
  const y1 = depth / 2
  const z0 = -0.001
  const z1 = height
  const positions: number[] = []
  const edge = (a: [number, number, number], b: [number, number, number]) => positions.push(...a, ...b)
  ;[
    [[x0, y0, z0], [x1, y0, z0]], [[x1, y0, z0], [x1, y1, z0]], [[x1, y1, z0], [x0, y1, z0]], [[x0, y1, z0], [x0, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1]], [[x1, y0, z1], [x1, y1, z1]], [[x1, y1, z1], [x0, y1, z1]], [[x0, y1, z1], [x0, y0, z1]],
    [[x0, y0, z0], [x0, y0, z1]], [[x1, y0, z0], [x1, y0, z1]], [[x1, y1, z0], [x1, y1, z1]], [[x0, y1, z0], [x0, y1, z1]],
  ].forEach(([a, b]) => edge(a as [number, number, number], b as [number, number, number]))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const material = new THREE.LineBasicMaterial({ color: '#58676a', transparent: true, opacity: 0.82, depthTest: true, depthWrite: false })
  const box = new THREE.LineSegments(geometry, material)
  box.name = 'editing-boundary-box'
  box.renderOrder = 2
  return box
}

function updateEditingBoundsVisuals(scene: THREE.Scene, bounds: SceneBounds) {
  const floor = scene.getObjectByName('editing-floor') as THREE.Mesh | undefined
  if (floor) {
    floor.geometry.dispose()
    floor.geometry = new THREE.PlaneGeometry(bounds.x * VOXEL_WORLD_SIZE, bounds.y * VOXEL_WORLD_SIZE)
  }
  const oldGrid = scene.getObjectByName('editing-grid')
  if (oldGrid) {
    scene.remove(oldGrid)
    disposeThreeObject(oldGrid)
  }
  const oldBoundary = scene.getObjectByName('editing-ground-boundary')
  if (oldBoundary) {
    scene.remove(oldBoundary)
    disposeThreeObject(oldBoundary)
  }
  const oldBox = scene.getObjectByName('editing-boundary-box')
  if (oldBox) {
    scene.remove(oldBox)
    disposeThreeObject(oldBox)
  }
  scene.add(createGroundGrid(bounds), createGroundBoundary(bounds), createBoundaryBox(bounds))
}

function resolveGridMove(deltaX: number, deltaY: number, deltaZ: number, canOccupy: (deltaX: number, deltaY: number, deltaZ: number) => boolean): GridMoveResult {
  const requestedX = Math.round(deltaX)
  const requestedY = Math.round(deltaY)
  const requestedZ = Math.round(deltaZ)
  let appliedX = 0
  let appliedY = 0
  let appliedZ = 0
  const directionX = Math.sign(requestedX)
  const directionY = Math.sign(requestedY)
  const directionZ = Math.sign(requestedZ)

  while (appliedX !== requestedX || appliedY !== requestedY || appliedZ !== requestedZ) {
    const nextX = appliedX + (appliedX === requestedX ? 0 : directionX)
    const nextY = appliedY + (appliedY === requestedY ? 0 : directionY)
    const nextZ = appliedZ + (appliedZ === requestedZ ? 0 : directionZ)
    if (canOccupy(nextX, nextY, nextZ)) {
      appliedX = nextX
      appliedY = nextY
      appliedZ = nextZ
      continue
    }

    const candidates = [
      { axis: 'x', allowed: nextX !== appliedX && canOccupy(nextX, appliedY, appliedZ), remaining: Math.abs(requestedX - appliedX) },
      { axis: 'y', allowed: nextY !== appliedY && canOccupy(appliedX, nextY, appliedZ), remaining: Math.abs(requestedY - appliedY) },
      { axis: 'z', allowed: nextZ !== appliedZ && canOccupy(appliedX, appliedY, nextZ), remaining: Math.abs(requestedZ - appliedZ) },
    ].filter((candidate) => candidate.allowed)
    if (!candidates.length) break
    const selected = candidates.sort((a, b) => b.remaining - a.remaining)[0]
    if (selected.axis === 'x') {
      appliedX = nextX
    } else if (selected.axis === 'y') {
      appliedY = nextY
    } else {
      appliedZ = nextZ
    }
    if (candidates.length > 1) {
      const remainingX = Math.abs(requestedX - appliedX)
      const remainingY = Math.abs(requestedY - appliedY)
      const remainingZ = Math.abs(requestedZ - appliedZ)
      if (remainingX + remainingY + remainingZ === 0) break
    }
  }

  return {
    moved: appliedX !== 0 || appliedY !== 0 || appliedZ !== 0,
    blocked: appliedX !== requestedX || appliedY !== requestedY || appliedZ !== requestedZ,
    deltaX: appliedX,
    deltaY: appliedY,
    deltaZ: appliedZ,
  }
}

const styleColors: Record<string, string> = {
  希腊风格: '#78a1d5',
  印度风格: '#d2a354',
  中式风格: '#b7503e',
  日式风格: '#9c9b89',
  基础件: '#6c827d',
}

const styleMaterialVariants: Record<string, { color: string; accent: string }> = {
  希腊风格: { color: '#5f83bd', accent: '#e9e1d1' },
  印度风格: { color: '#d2a354', accent: '#c96043' },
  中式风格: { color: '#2e6f70', accent: '#c96043' },
  日式风格: { color: '#20252a', accent: '#6c4b38' },
}

type AssetCategoryNode = {
  name: string
  path: string[]
  key: string
  children: AssetCategoryNode[]
  assets: VoxelAsset[]
}

type ProjectHistoryEntry = {
  project: ProjectState
  editEntityId: string | null
  selectedId: string
  checkedTreePartIds: string[]
}

function assetCategoryKey(path: string[]): string {
  return path.join('\u001f')
}

function buildAssetCategoryTree(paths: Array<{ path: string[]; asset?: VoxelAsset }>): AssetCategoryNode[] {
  const roots: AssetCategoryNode[] = []
  for (const entry of paths) {
    const categoryPath = normalizeAssetCategoryPath(entry.path)
    let children = roots
    let node: AssetCategoryNode | undefined
    const traversed: string[] = []
    categoryPath.forEach((name) => {
      traversed.push(name)
      const key = assetCategoryKey(traversed)
      node = children.find((candidate) => candidate.key === key)
      if (!node) {
        node = { name, path: [...traversed], key, children: [], assets: [] }
        children.push(node)
      }
      children = node.children
    })
    if (entry.asset && node) node.assets.push(entry.asset)
  }
  return roots
}

function assetCategoryTreeFromAssets(assets: VoxelAsset[]): AssetCategoryNode[] {
  return buildAssetCategoryTree(assets.map((asset) => ({ path: normalizeAssetCategoryPath(asset.categoryPath), asset })))
}

function assetCategoryTreeFromPaths(paths: string[][]): AssetCategoryNode[] {
  return buildAssetCategoryTree(paths.map((path) => ({ path })))
}

function collectAssetCategoryPaths(assets: VoxelAsset[]): string[][] {
  const paths = new Map<string, string[]>()
  for (const asset of assets) {
    if (asset.isTemplate === false) continue
    const path = normalizeAssetCategoryPath(asset.categoryPath)
    for (let index = 1; index <= path.length; index += 1) {
      const prefix = path.slice(0, index)
      paths.set(assetCategoryKey(prefix), prefix)
    }
  }
  return [...paths.values()]
}

function normalizeAssetCategoryPaths(paths: string[][], assets: VoxelAsset[] = []): string[][] {
  const merged = new Map<string, string[]>()
  for (const path of [...paths, ...collectAssetCategoryPaths(assets)]) {
    const normalized = normalizeAssetCategoryPath(path)
    for (let index = 1; index <= normalized.length; index += 1) {
      const prefix = normalized.slice(0, index)
      merged.set(assetCategoryKey(prefix), prefix)
    }
  }
  return [...merged.values()]
}

function assetCategoryTreeFromAssetsAndPaths(assets: VoxelAsset[], paths: string[][]): AssetCategoryNode[] {
  return buildAssetCategoryTree([
    ...paths.map((path) => ({ path })),
    ...assets.map((asset) => ({ path: normalizeAssetCategoryPath(asset.categoryPath), asset })),
  ])
}

function App() {
  const [project, setProject] = useState<ProjectState>(() => normalizeStoredProject(makeDefaultProject()))
  const projectRef = useRef(project)
  const historyRef = useRef<{ past: ProjectHistoryEntry[]; future: ProjectHistoryEntry[] }>({ past: [], future: [] })
  const [historyRevision, setHistoryRevision] = useState(0)
  const [selectedId, setSelectedId] = useState('inst-chinese')
  const [tool, setTool] = useState<Tool>('select')
  const [activeMaterial, setActiveMaterial] = useState('terracotta')
  const [recentMaterialIds, setRecentMaterialIds] = useState(() => MATERIALS.slice(0, 8).map((material) => material.id))
  const [notice, setNotice] = useState('就绪 · 本地工程未保存')
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<'正交' | '透视'>('正交')
  const [showGrid, setShowGrid] = useState(true)
  const [showBoundary, setShowBoundary] = useState(true)
  const [boundaryOpen, setBoundaryOpen] = useState(false)
  const [boundaryDraft, setBoundaryDraft] = useState<SceneBounds>(() => sceneBoundsForProject(makeDefaultProject()))
  const [dragAxis, setDragAxis] = useState<'horizontal' | 'vertical'>('horizontal')
  const [editEntityId, setEditEntityId] = useState<string | null>(null)
  const [placementAssetId, setPlacementAssetId] = useState<string | null>(null)
  const [pendingEntityImport, setPendingEntityImport] = useState<PendingEntityImport | null>(null)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [cameraControlApi, setCameraControlApi] = useState<CameraControlApi | null>(null)
  const [copyPreview, setCopyPreview] = useState<CopyPreviewState | null>(null)
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>('loading')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [library, setLibrary] = useState<LibraryResponse>({ assets: [], scenes: [], assetCategories: [] })
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [sceneFileRef, setSceneFileRef] = useState<SceneFileRef | null>(null)
  const [savedSceneSignature, setSavedSceneSignature] = useState<string | null>(null)
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false)
  const [sceneLibraryContextMenu, setSceneLibraryContextMenu] = useState<SceneLibraryContextMenuState>(null)
  const [selectedLibrarySceneId, setSelectedLibrarySceneId] = useState<string | null>(null)
  const [selectedLibrarySceneProject, setSelectedLibrarySceneProject] = useState<ProjectState | null>(null)
  const [assetSidebarCollapsed, setAssetSidebarCollapsed] = useState(false)
  const [expandedAssemblies, setExpandedAssemblies] = useState<Record<string, boolean>>({})
  const [checkedTreePartIds, setCheckedTreePartIds] = useState<string[]>([])
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState>(null)
  const [assetContextMenu, setAssetContextMenu] = useState<AssetContextMenuState>(null)
  const [assetCategoryContextMenu, setAssetCategoryContextMenu] = useState<AssetCategoryContextMenuState>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [assetCategoryPaths, setAssetCategoryPaths] = useState<string[][]>(() => collectAssetCategoryPaths(makeDefaultProject().assets))
  const [assetCategorySave, setAssetCategorySave] = useState<AssetCategorySaveState>(null)
  const persistenceReadyRef = useRef(false)
  const interactionActiveRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sceneLibraryImportInputRef = useRef<HTMLInputElement>(null)
  const entityFileInputRef = useRef<HTMLInputElement>(null)
  const modelImportInputRef = useRef<HTMLInputElement>(null)
  const pendingSceneOperationRef = useRef<(() => Promise<void>) | null>(null)
  const [modelImportDialog, setModelImportDialog] = useState<ModelImportDialogState | null>(null)
  const [modelImportTargetSize, setModelImportTargetSize] = useState(32)
  const [modelImportMode, setModelImportMode] = useState<VoxelizeMode>('solid')
  const [modelImportPreserveParts, setModelImportPreserveParts] = useState(true)

  const currentSceneBounds = sceneBoundsForProject(project)
  const currentSceneSignature = useMemo(() => {
    try {
      return sceneContentSignature(project)
    } catch {
      return ''
    }
  }, [project])
  const sceneDirty = savedSceneSignature !== null && currentSceneSignature !== savedSceneSignature

  const sceneFitsBounds = (candidate: SceneBounds, source = projectRef.current) => {
    if (!sceneVoxelsWithinBounds(source.customVoxels, candidate)) return false
    const assetMap = new Map(source.assets.map((asset) => [asset.id, asset]))
    return source.instances.every((instance) => {
      const asset = assetMap.get(instance.assetId)
      return !asset || sceneVoxelsWithinBounds(resolveInstanceSceneVoxels(instance, asset), candidate)
    })
  }

  const applySceneBounds = () => {
    const next: SceneBounds = {
      x: Math.max(1, Math.min(1000, Math.round(boundaryDraft.x))),
      y: Math.max(1, Math.min(1000, Math.round(boundaryDraft.y))),
      z: Math.max(1, Math.min(1000, Math.round(boundaryDraft.z))),
    }
    if (!sceneFitsBounds(next)) {
      setNotice('场地尺寸不能缩小：已有实体超出新的场景边界，请先移动实体后再应用。')
      return
    }
    updateProject((draft) => {
      draft.sceneBounds = next
      draft.sceneSizeCm = Math.max(next.x, next.y) * VOXEL_WORLD_SIZE
    })
    setBoundaryDraft(next)
    setBoundaryOpen(false)
    setNotice(`已应用场地边界 · XY ${next.x} × ${next.y} · Z ${next.z} 体素`)
  }

  const sceneParts = useMemo(() => sceneEntityParts(project), [project])
  const assetTransformCacheRef = useRef<AssetTransformCache | null>(null)
  if (!assetTransformCacheRef.current) assetTransformCacheRef.current = new AssetTransformCache()
  const sceneOccupancyRef = useRef<SceneOccupancyIndex | null>(null)
  if (!sceneOccupancyRef.current) sceneOccupancyRef.current = SceneOccupancyIndex.fromParts(sceneParts)
  useEffect(() => {
    sceneOccupancyRef.current?.syncParts(sceneParts)
  }, [sceneParts])
  const lockedPartIds = useMemo(() => new Set(sceneParts.filter((part) => scenePartIsLocked(project, part)).map((part) => part.id)), [project, sceneParts])
  const selectedAssemblyId = selectedId.startsWith('assembly:') ? selectedId.slice('assembly:'.length) : undefined
  const selectedScenePart = sceneParts.find((part) => part.id === selectedId) ?? sceneParts.find((part) => part.instanceId === selectedId)
  const selectedInstance = selectedScenePart?.instanceId ? project.instances.find((instance) => instance.id === selectedScenePart.instanceId) : project.instances.find((instance) => instance.id === selectedId)
  const selectedAsset = selectedInstance ? project.assets.find((asset) => asset.id === selectedInstance.assetId) : undefined
  const selectedAssembly = selectedAssemblyId ? project.assemblies?.find((assembly) => assembly.id === selectedAssemblyId) : undefined
  const selectedEntityParts = useMemo(() => {
    const checkedPartIds = new Set(checkedTreePartIds.filter((id) => !id.startsWith('assembly:')))
    const checkedAssemblyIds = new Set(checkedTreePartIds.filter((id) => id.startsWith('assembly:')).map((id) => id.slice('assembly:'.length)))
    if (selectedAssemblyId && !checkedTreePartIds.length) checkedAssemblyIds.add(selectedAssemblyId)
    if (selectedScenePart?.instanceId && !checkedTreePartIds.length && !selectedAssemblyId && selectedId === selectedScenePart.instanceId) {
      return sceneParts.filter((part) => part.instanceId === selectedScenePart.instanceId)
    }
    if (selectedScenePart && !checkedTreePartIds.length && !selectedAssemblyId) checkedPartIds.add(selectedScenePart.id)
    if (!checkedPartIds.size && !checkedAssemblyIds.size) return []
    return sceneParts.filter((part) => checkedPartIds.has(part.id) || (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).some((assemblyId) => checkedAssemblyIds.has(assemblyId)))
  }, [sceneParts, selectedScenePart, selectedAssemblyId, selectedId, checkedTreePartIds])
  const singleAssemblySelected = Boolean(selectedAssemblyId && (!checkedTreePartIds.length || (checkedTreePartIds.length === 1 && checkedTreePartIds[0] === `assembly:${selectedAssemblyId}`)))
  const multipleSelected = selectedEntityParts.length > 1 && !singleAssemblySelected
  const selectedEntityRootIds = new Set(selectedEntityParts.map((part) => part.instanceId ? `instance:${part.instanceId}` : part.id))
  const canEnterSelectedEditMode = Boolean(selectedId && selectedEntityParts.length && !editEntityId && (Boolean(selectedAssemblyId) || selectedEntityRootIds.size === 1))
  const selectedDisplayName = multipleSelected ? '多个实体' : (selectedAssembly?.name?.trim() || (selectedScenePart ? sceneEntityTreeName(project, selectedScenePart) : selectedAsset?.name ?? (selectedEntityParts[0] ? sceneEntityTreeName(project, selectedEntityParts[0]) : '未选择')))
  const selectedSourceAssets = [...new Map(selectedEntityParts
    .filter((part) => part.kind === 'asset' && part.instanceId)
    .map((part) => project.instances.find((instance) => instance.id === part.instanceId))
    .filter((instance): instance is SceneInstance => Boolean(instance))
    .map((instance) => [instance.assetId, project.assets.find((asset) => asset.id === instance.assetId)])
    .filter((entry): entry is [string, VoxelAsset] => Boolean(entry[1]))).values()]
  const selectedSourceAsset = selectedAsset ?? (selectedSourceAssets.length === 1 ? selectedSourceAssets[0] : undefined)
  const selectedTemplateSource = selectedSourceAsset?.isTemplate === true
    ? selectedSourceAsset
    : selectedSourceAsset?.templateSourceId
      ? project.assets.find((asset) => asset.id === selectedSourceAsset.templateSourceId && asset.isTemplate === true)
      : undefined
  const selectedSource = multipleSelected
    ? '多个来源'
    : selectedTemplateSource
    ? `资产库 · ${normalizeAssetCategoryPath(selectedTemplateSource.categoryPath).join(' / ')}`
    : '还未保存到资产库'
  const sceneTreeItems = useMemo<SceneTreeItem[]>(() => {
    const baseNameForPart = (part: SceneEntityPart) => sceneEntityTreeName(project, part)
    const assemblies = project.assemblies ?? []
    const assemblyMap = new Map(assemblies.map((assembly) => [assembly.id, assembly]))
    const partMatchesMemberKey = (part: SceneEntityPart, memberKey: string) => part.memberKey === memberKey || (memberKey.startsWith('asset:') && part.memberKey.startsWith(`${memberKey}:`))
    const partItem = (part: SceneEntityPart): SceneTreeItem => {
      const displayLabel = baseNameForPart(part)
      return { id: part.id, kind: 'part', part: { ...part, displayLabel }, label: displayLabel }
    }
    const renderAssembly = (assemblyId: string, seen = new Set<string>()): SceneTreeItem | null => {
      const assembly = assemblyMap.get(assemblyId)
      if (!assembly || seen.has(assemblyId)) return null
      const nextSeen = new Set([...seen, assemblyId])
      const displayLabel = assembly.name?.trim() || '装配体'
      const children: SceneTreeItem[] = []
      for (const memberKey of assembly.memberKeys) {
        if (memberKey.startsWith('assembly:')) {
          const child = renderAssembly(memberKey.slice('assembly:'.length), nextSeen)
          if (child) children.push(child)
          continue
        }
        sceneParts.filter((part) => partMatchesMemberKey(part, memberKey)).forEach((part) => children.push(partItem(part)))
      }
      return { id: `assembly:${assemblyId}`, kind: 'assembly', assemblyId, label: displayLabel, children }
    }
    const referencedAssemblies = new Set(assemblies.flatMap((assembly) => assembly.memberKeys.filter((key) => key.startsWith('assembly:')).map((key) => key.slice('assembly:'.length))))
    const items: SceneTreeItem[] = assemblies.filter((assembly) => !referencedAssemblies.has(assembly.id)).map((assembly) => renderAssembly(assembly.id)).filter((item): item is SceneTreeItem => Boolean(item))
    const nestedPartIds = new Set(sceneParts.filter((part) => (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).length > 0).map((part) => part.id))
    sceneParts.filter((part) => !nestedPartIds.has(part.id)).forEach((part) => items.push(partItem(part)))
    return items
  }, [project.assets, project.instances, sceneParts])
  const canUndo = historyRevision >= 0 && historyRef.current.past.length > 0
  const canRedo = historyRevision >= 0 && historyRef.current.future.length > 0
  const recentMaterials = useMemo(() => {
    const materialsById = new Map(project.materials.map((material) => [material.id, material]))
    const ids = [...recentMaterialIds, ...project.materials.map((material) => material.id)]
    return [...new Set(ids)].map((id) => materialsById.get(id)).filter((material): material is Material => Boolean(material)).slice(0, 8)
  }, [project.materials, recentMaterialIds])

  const useMaterial = (materialId: string) => {
    setActiveMaterial(materialId)
    setRecentMaterialIds((ids) => [materialId, ...ids.filter((id) => id !== materialId)].slice(0, 8))
  }

  const commitProject = (next: ProjectState, trackHistory = true) => {
    const normalizedNext = normalizeStoredProject(next)
    if (trackHistory) {
      historyRef.current.past = [...historyRef.current.past, {
        project: structuredClone(projectRef.current),
        editEntityId,
        selectedId,
        checkedTreePartIds: [...checkedTreePartIds],
      }].slice(-50)
      historyRef.current.future = []
    }
    sceneOccupancyRef.current?.syncParts(sceneEntityParts(normalizedNext))
    projectRef.current = normalizedNext
    setProject(normalizedNext)
    setHistoryRevision((value) => value + 1)
  }

  const updateProject = (updater: (draft: ProjectState) => void, trackHistory = true) => {
    const next = structuredClone(projectRef.current)
    updater(next)
    commitProject(next, trackHistory)
  }

  const replaceProject = (next: ProjectState, trackHistory = true) => {
    commitProject(structuredClone(next), trackHistory)
  }

  const markSceneSaved = (savedProject: ProjectState, fileRef?: SceneFileRef | null) => {
    setSavedSceneSignature(sceneContentSignature(savedProject))
    if (fileRef !== undefined) setSceneFileRef(fileRef)
  }

  const requestSceneReplace = (operation: () => Promise<void>) => {
    if (!sceneDirty) {
      void operation()
      return
    }
    pendingSceneOperationRef.current = operation
    setUnsavedDialogOpen(true)
  }

  const downloadSceneFile = (sceneFile: MoceSceneFile, fileName: string) => {
    const blob = new Blob([JSON.stringify(sceneFile, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName.endsWith('.moceworld') ? fileName : `${fileName}.moceworld`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const downloadPortableFile = (file: MoceAssetFile | MoceEntityFile, fileName: string, extension: '.moceasset' | '.moceentity') => {
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName.endsWith(extension) ? fileName : `${fileName}${extension}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const saveProjectAsFile = async (forceSaveAs = false): Promise<boolean> => {
    const snapshot = structuredClone(projectRef.current)
    let sceneFile: MoceSceneFile
    try {
      sceneFile = createSceneFile(snapshot)
    } catch (error) {
      setNotice(error instanceof Error ? `保存失败 · ${error.message}` : '保存失败 · 场景文件生成失败')
      return false
    }
    const suggestedName = `${snapshot.name || '未命名场景'}.moceworld`
    const pickerWindow = window as Window & { showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle> }
    let handle = !forceSaveAs ? sceneFileRef?.fileHandle : undefined
    let fileName = sceneFileRef?.name || suggestedName
    try {
      if (!handle && pickerWindow.showSaveFilePicker) {
        handle = await pickerWindow.showSaveFilePicker({
          suggestedName,
          types: [{ description: '莫测造境场景文件', accept: { 'application/json': ['.moceworld'] } }],
        })
        fileName = handle.name
      }
      if (handle) {
        const writable = await handle.createWritable()
        await writable.write(JSON.stringify(sceneFile, null, 2))
        await writable.close()
      } else {
        downloadSceneFile(sceneFile, fileName)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false
      setNotice(`保存文件失败 · ${error instanceof Error ? error.message : '无法写入文件'}`)
      return false
    }
    const targetSceneId = forceSaveAs ? CURRENT_SCENE_ID : sceneFileRef?.libraryId ?? CURRENT_SCENE_ID
    let persisted = true
    try {
      await saveScene(targetSceneId, sceneFile)
      setPersistenceStatus('saved')
    } catch {
      persisted = false
      setPersistenceStatus('offline')
    }
    markSceneSaved(snapshot, { name: fileName, libraryId: forceSaveAs ? undefined : sceneFileRef?.libraryId, fileHandle: handle })
    setNotice(persisted ? `场景已保存 · ${fileName}` : `文件已保存 · 场景库同步失败 · ${fileName}`)
    return true
  }

  const handleUnsavedDecision = async (decision: UnsavedDecision) => {
    if (decision === 'cancel') {
      pendingSceneOperationRef.current = null
      setUnsavedDialogOpen(false)
      return
    }
    const operation = pendingSceneOperationRef.current
    if (!operation) {
      setUnsavedDialogOpen(false)
      return
    }
    if (decision === 'save') {
      const saved = await saveProjectAsFile(false)
      if (!saved) return
    }
    pendingSceneOperationRef.current = null
    setUnsavedDialogOpen(false)
    await operation()
  }

  useEffect(() => {
    let cancelled = false
    loadScene(CURRENT_SCENE_ID).then((loaded) => {
      if (cancelled) return
      const normalized = normalizeStoredProject(loaded)
      replaceProject(normalized, false)
      setRecentMaterialIds(normalized.materials.slice(0, 8).map((material) => material.id))
      setSelectedId(normalized.instances[0]?.id ?? sceneEntityParts(normalized)[0]?.id ?? '')
      persistenceReadyRef.current = true
      setPersistenceStatus('saved')
      markSceneSaved(normalized, null)
      void saveScene(CURRENT_SCENE_ID, createSceneFile(normalized)).catch(() => setPersistenceStatus('offline'))
      setNotice(`已加载场景 · ${normalized.name}`)
    }).catch(async (error: unknown) => {
      if (cancelled) return
      if (error instanceof Error && error.message.includes('场景不存在')) {
        try {
          await saveScene(CURRENT_SCENE_ID, createSceneFile(projectRef.current))
          persistenceReadyRef.current = true
          setPersistenceStatus('saved')
          markSceneSaved(projectRef.current, null)
          setNotice('已创建场景 · 莫测里·第一街区')
        } catch {
          setPersistenceStatus('offline')
          setNotice('场景库不可用 · 当前使用本地草稿')
        }
      } else {
        setPersistenceStatus('offline')
        setNotice('后端连接失败 · 当前使用本地草稿')
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadLibrary().then((loaded) => {
      if (cancelled) return
      setLibrary(loaded)
      setAssetCategoryPaths(normalizeAssetCategoryPaths(loaded.assetCategories ?? [], projectRef.current.assets))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!persistenceReadyRef.current) return
    let idleId: number | null = null
    let timer = 0
    const persist = () => {
      try {
        saveScene(CURRENT_SCENE_ID, createSceneFile(project)).then(() => setPersistenceStatus('saved')).catch(() => setPersistenceStatus('offline'))
      } catch {
        setPersistenceStatus('offline')
      }
    }
    const schedulePersist = () => {
      if (interactionActiveRef.current) {
        timer = window.setTimeout(schedulePersist, 250)
        return
      }
      idleId = window.requestIdleCallback ? window.requestIdleCallback(persist, { timeout: 1500 }) : null
      if (idleId === null) persist()
    }
    timer = window.setTimeout(schedulePersist, 1200)
    return () => {
      window.clearTimeout(timer)
      if (idleId !== null && window.cancelIdleCallback) window.cancelIdleCallback(idleId)
    }
  }, [project])

  const undoProject = () => {
    const previous = historyRef.current.past.pop()
    if (!previous) {
      setNotice('没有可撤销的操作')
      return
    }
    historyRef.current.future.push({
      project: structuredClone(projectRef.current),
      editEntityId,
      selectedId,
      checkedTreePartIds: [...checkedTreePartIds],
    })
    sceneOccupancyRef.current?.syncParts(sceneEntityParts(previous.project))
    projectRef.current = previous.project
    setProject(previous.project)
    setEditEntityId(previous.editEntityId)
    setSelectedId(previous.selectedId)
    setCheckedTreePartIds([...previous.checkedTreePartIds])
    setHistoryRevision((value) => value + 1)
    setNotice('已撤销')
  }

  const redoProject = () => {
    const next = historyRef.current.future.pop()
    if (!next) {
      setNotice('没有可重做的操作')
      return
    }
    historyRef.current.past.push({
      project: structuredClone(projectRef.current),
      editEntityId,
      selectedId,
      checkedTreePartIds: [...checkedTreePartIds],
    })
    sceneOccupancyRef.current?.syncParts(sceneEntityParts(next.project))
    projectRef.current = next.project
    setProject(next.project)
    setEditEntityId(next.editEntityId)
    setSelectedId(next.selectedId)
    setCheckedTreePartIds([...next.checkedTreePartIds])
    setHistoryRevision((value) => value + 1)
    setNotice('已重做')
  }

  const addVoxel = (voxel: Voxel) => {
    useMaterial(voxel.materialId)
    const currentProject = projectRef.current
    const currentParts = sceneEntityParts(currentProject)
    const editAssemblyId = editEntityId?.startsWith('assembly:') ? editEntityId.slice('assembly:'.length) : undefined
    const editingCustomPart = currentParts.find((part) => part.kind === 'custom' && (part.id === editEntityId || (editAssemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editAssemblyId))))
    const editingCustomId = editingCustomPart?.partId
    const neighbors = [
      { x: voxel.x + 1, y: voxel.y, z: voxel.z }, { x: voxel.x - 1, y: voxel.y, z: voxel.z },
      { x: voxel.x, y: voxel.y + 1, z: voxel.z }, { x: voxel.x, y: voxel.y - 1, z: voxel.z },
      { x: voxel.x, y: voxel.y, z: voxel.z + 1 }, { x: voxel.x, y: voxel.y, z: voxel.z - 1 },
    ]
    const assetNeighbor = editEntityId
      ? currentParts.find((part) => part.kind === 'asset'
        && (part.id === editEntityId || Boolean(editAssemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editAssemblyId)))
        && part.voxels.some((candidate) => neighbors.some((neighbor) => sceneVoxelKey(candidate) === sceneVoxelKey(neighbor))))
      : undefined
    if (editAssemblyId) {
      const entityId = `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      updateProject((draft) => {
        if (draft.customVoxels.some((item) => item.x === voxel.x && item.y === voxel.y && item.z === voxel.z)) return
        draft.customVoxels.push({ ...voxel, entityId })
        const assembly = (draft.assemblies ?? []).find((item) => item.id === editAssemblyId)
        if (assembly && !assembly.memberKeys.includes(`voxel:${entityId}`)) assembly.memberKeys.push(`voxel:${entityId}`)
      })
      setSelectedId(`custom:${entityId}`)
      setNotice(`装配体编辑模式 · 已新建子实体并加入当前装配体 · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
      return
    }
    if (assetNeighbor?.instanceId && editEntityId) {
      const instance = currentProject.instances.find((item) => item.id === assetNeighbor.instanceId)
      const asset = instance ? currentProject.assets.find((item) => item.id === instance.assetId) : undefined
      const sceneNeighbor = assetNeighbor.voxels.find((candidate) => neighbors.some((neighbor) => sceneVoxelKey(candidate) === sceneVoxelKey(neighbor)))
      const localNeighbor = instance && asset && sceneNeighbor ? findInstanceVoxelAtSceneVoxel(instance, asset, sceneNeighbor) : undefined
      if (instance && asset && sceneNeighbor && localNeighbor) {
        const angle = instance.rotation * Math.PI / 180
        const sceneDeltaX = voxel.x - sceneNeighbor.x
        const sceneDeltaZ = voxel.z - sceneNeighbor.z
        const localTarget = {
          x: localNeighbor.x + Math.round(Math.cos(angle) * sceneDeltaX - Math.sin(angle) * sceneDeltaZ),
          y: localNeighbor.y + (voxel.y - sceneNeighbor.y),
          z: localNeighbor.z + Math.round(Math.sin(angle) * sceneDeltaX + Math.cos(angle) * sceneDeltaZ),
          materialId: voxel.materialId,
        }
        editInstanceVoxel(instance.id, localTarget, 'add')
        if (assetNeighbor.assemblyId) setNotice(`已在装配体上修改 · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
        return
      }
    }
    if (editEntityId && !editingCustomId) {
      const editingAssetPart = currentParts.find((part) => part.kind === 'asset' && (part.id === editEntityId || part.instanceId === editEntityId))
      if (editingAssetPart) {
        const entityId = `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        let targetAssemblyId = editingAssetPart.assemblyIds?.[0]
        updateProject((draft) => {
          if (draft.customVoxels.some((item) => item.x === voxel.x && item.y === voxel.y && item.z === voxel.z)) return
          draft.customVoxels.push({ ...voxel, entityId })
          if (!targetAssemblyId) {
            const assemblyNumber = Math.max(1, draft.assemblySequence ?? 1)
            draft.assemblySequence = assemblyNumber + 1
            targetAssemblyId = `assembly-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            draft.assemblies = [...(draft.assemblies ?? []), {
              id: targetAssemblyId,
              name: `装配体 ${assemblyNumber}`,
              nameMode: 'auto',
              sequence: assemblyNumber,
              memberKeys: [editingAssetPart.memberKey],
            }]
          }
          const assembly = (draft.assemblies ?? []).find((item) => item.id === targetAssemblyId)
          if (assembly && !assembly.memberKeys.includes(`voxel:${entityId}`)) assembly.memberKeys.push(`voxel:${entityId}`)
        })
        if (targetAssemblyId) {
          setEditEntityId(`assembly:${targetAssemblyId}`)
          setCheckedTreePartIds([`assembly:${targetAssemblyId}`])
        }
        setSelectedId(`custom:${entityId}`)
        setNotice(`已在当前编辑实体上新建子实体 · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
        return
      }
      setNotice('当前处于实体编辑模式 · 请点击当前实体表面或相邻面进行修改')
      return
    }
    // Outside edit mode every brush stroke starts a new user entity, even if
    // the new voxel touches an existing custom entity. Only an explicit edit
    // target is allowed to reuse an existing entity id.
    const entityId = editingCustomId ?? `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    updateProject((draft) => {
      const exists = draft.customVoxels.some((item) => item.x === voxel.x && item.y === voxel.y && item.z === voxel.z)
      if (exists) return
      draft.customVoxels.push({ ...voxel, entityId })
    })
    const customEntitySelectionId = `custom:${entityId}`
    setSelectedId(customEntitySelectionId)
    if (!editingCustomId) setEditEntityId(customEntitySelectionId)
    setNotice(editingCustomId ? `已在当前用户实体上添加体素 · ${voxel.x}, ${voxel.y}, ${voxel.z}` : `已新建用户实体并进入编辑模式 · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
  }

  const removeVoxel = (voxel: Voxel) => {
    const entityId = voxelEntityId(voxel)
    updateProject((draft) => {
      const remaining = draft.customVoxels.filter((item) => !(item.x === voxel.x && item.y === voxel.y && item.z === voxel.z))
      const grouped = new Map<string, Voxel[]>()
      remaining.forEach((item) => grouped.set(voxelEntityId(item), [...(grouped.get(voxelEntityId(item)) ?? []), item]))
      const splitEntityIds = new Set<string>()
      const normalized: Voxel[] = []
      grouped.forEach((items, originalId) => {
        const components = voxelComponents(items)
        components.forEach((component, index) => {
          const nextId = index === 0 ? originalId : `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`
          if (index > 0) splitEntityIds.add(originalId)
          component.forEach((item) => normalized.push({ ...item, entityId: nextId }))
        })
      })
      draft.customVoxels = normalized
      if (splitEntityIds.has(entityId)) draft.assemblies = (draft.assemblies ?? []).filter((assembly) => !assembly.memberKeys.includes(`voxel:${entityId}`))
    })
    setNotice(`已擦除体素 · ${voxel.x}, ${voxel.y}, ${voxel.z}${entityId ? ' · 已重新计算实体边界' : ''}`)
  }

  const editInstanceVoxel = (instanceId: string, voxel: Voxel, mode: VoxelOverride['mode']) => {
    if (mode === 'add') useMaterial(voxel.materialId)
    updateProject((draft) => {
      const instance = draft.instances.find((item) => item.id === instanceId)
      if (!instance) return
      const overrides = instance.overrides ?? []
      instance.overrides = overrides.filter((item) => !(item.x === voxel.x && item.y === voxel.y && item.z === voxel.z))
      instance.overrides.push({ ...voxel, mode })
    })
    setNotice(`${mode === 'remove' ? '已擦除资产体素' : '已在资产上添加体素'} · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
  }

  const sceneVoxelKey = (voxel: Pick<Voxel, 'x' | 'y' | 'z'>) => `${voxel.x},${voxel.y},${voxel.z}`

  const hasAssetCollisionAt = (asset: VoxelAsset, x: number, y: number, z: number, rotation = 0, overrides: VoxelOverride[] = [], excludedInstanceId?: string) => {
    const movingInstance: SceneInstance = { id: 'placement-preview', assetId: asset.id, x, y, z, rotation, style: asset.style, visible: true, overrides }
    const transformed = assetTransformCacheRef.current!.get(movingInstance, asset)
    const translation = assetTransformCacheRef.current!.translation(asset, x, y, z)
    const excludedOwnerIds = excludedInstanceId
      ? sceneEntityParts(projectRef.current).filter((part) => part.instanceId === excludedInstanceId).map((part) => part.id)
      : []
    return sceneOccupancyRef.current!.collidesTranslatedProjectVoxels(transformed.localVoxels, translation, excludedOwnerIds)
  }

  const hasInstanceCollisionAt = (instanceId: string, x: number, y: number, z: number) => {
    const currentProject = projectRef.current
    const movingInstance = currentProject.instances.find((instance) => instance.id === instanceId)
    if (!movingInstance || !movingInstance.visible) return false
    const assetMap = new Map(currentProject.assets.map((asset) => [asset.id, asset]))
    const movingAsset = assetMap.get(movingInstance.assetId)
    if (!movingAsset) return false
    return hasAssetCollisionAt(movingAsset, x, y, z, movingInstance.rotation, movingInstance.overrides ?? [], instanceId)
  }

  const hasCustomComponentCollisionAt = (component: Voxel[], deltaX: number, deltaY: number, deltaZ: number) => {
    const excludedOwnerIds = [...new Set(component.map((voxel) => `custom:${voxelEntityId(voxel)}`))]
    return sceneOccupancyRef.current!.collidesTranslatedProjectVoxels(component, { x: deltaX, y: deltaY, z: deltaZ }, excludedOwnerIds)
  }

  const raycastSceneVoxel = (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }): SceneVoxelRayHit | null => {
    const hit = raycastVoxelDda(
      { x: origin.x / VOXEL_WORLD_SIZE, y: origin.y / VOXEL_WORLD_SIZE, z: origin.z / VOXEL_WORLD_SIZE },
      direction,
      (voxel) => sceneOccupancyRef.current!.queryRuntimeVoxel(voxel),
      4000,
    )
    if (!hit) return null
    return {
      voxel: { x: hit.voxel.gx, y: hit.voxel.gz, z: hit.voxel.gy, materialId: '' },
      normal: { x: hit.normal.gx, y: hit.normal.gz, z: hit.normal.gy },
      ownerIds: hit.ownerIds,
    }
  }

  const beginPlacement = (asset: VoxelAsset) => {
    interactionActiveRef.current = true
    setPendingEntityImport(null)
    setPlacementAssetId(asset.id)
    setNotice(`正在拖动资产 · ${asset.name}`)
  }

  const openModelImportDialog = (file: File) => {
    setModelImportTargetSize(32)
    setModelImportMode('solid')
    setModelImportPreserveParts(true)
    setModelImportDialog({ file, result: null, error: '', progress: 0, progressLabel: '等待开始', busy: false })
  }

  const runModelImport = async () => {
    const current = modelImportDialog
    if (!current || current.busy) return
    setModelImportDialog((state) => state ? { ...state, result: null, error: '', busy: true, progress: 0, progressLabel: '准备体素化' } : state)
    try {
      const result = await importModelAsVoxelAssetInWorker(current.file, {
        targetSizeMm: Math.max(1, Math.min(256, Math.round(modelImportTargetSize || 1))),
        mode: modelImportMode,
        materialId: activeMaterial,
        palette: projectRef.current.materials,
        preserveParts: modelImportPreserveParts,
        onProgress: (progress, label) => setModelImportDialog((state) => state ? { ...state, progress, progressLabel: label } : state),
      })
      setModelImportDialog((state) => state ? { ...state, result, busy: false, progress: 1, progressLabel: '体素化完成' } : state)
    } catch (error) {
      setModelImportDialog((state) => state ? { ...state, busy: false, error: error instanceof Error ? error.message : '模型体素化失败', progressLabel: '体素化失败' } : state)
    }
  }

  const confirmModelImport = () => {
    const result = modelImportDialog?.result
    if (!result) return
    const asset = structuredClone(result.asset)
    updateProject((draft) => { draft.assets.push(asset) })
    setModelImportDialog(null)
    beginPlacement(asset)
    setNotice(`模型已转为 ${asset.voxels.length} 个 1 mm 体素 · 请拖动放置`)
  }

  const endPlacement = () => {
    interactionActiveRef.current = false
    setPlacementAssetId(null)
    setPendingEntityImport(null)
  }

  const assetWithinSceneBoundary = (asset: VoxelAsset, x: number, y: number, z: number) => {
    const bounds = sceneBoundsForProject(projectRef.current)
    const previewInstance: SceneInstance = { id: 'placement-preview', assetId: asset.id, x, y, z, rotation: 0, style: asset.style, visible: true, overrides: [] }
    return sceneVoxelsWithinBounds(assetTransformCacheRef.current!.resolve(previewInstance, asset), bounds)
  }

  const previewPlacementAt = (assetId: string, x: number, z: number): PlacementPreview | null => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId) ?? (pendingEntityImport?.asset.id === assetId ? pendingEntityImport.asset : undefined)
    if (!asset) return null
    const position = { assetId, x: snapAssetOrigin(x, asset.width), y: 0, z: snapAssetOrigin(z, asset.depth) }
    return { ...position, valid: assetWithinSceneBoundary(asset, position.x, position.y, position.z) && !hasAssetCollisionAt(asset, position.x, position.y, position.z) }
  }

  const placeAssetAt = (assetId: string, x: number, z: number) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId) ?? (pendingEntityImport?.asset.id === assetId ? pendingEntityImport.asset : undefined)
    if (!asset) return
    const position = { x: snapAssetOrigin(x, asset.width), y: 0, z: snapAssetOrigin(z, asset.depth) }
    const outsideBoundary = !assetWithinSceneBoundary(asset, position.x, position.y, position.z)
    if (outsideBoundary || hasAssetCollisionAt(asset, position.x, position.y, position.z)) {
      setNotice(outsideBoundary ? `无法放置资产 · ${asset.name} 超出场景边界` : `无法放置资产 · ${asset.name} 与已有实体重叠`)
      endPlacement()
      return
    }
    const instanceId = `instance-${asset.id}-${Date.now()}`
    // A placed scene instance must own an immutable snapshot. Otherwise later
    // edits to the template asset (name, color, or geometry) leak into entities
    // that already exist in the scene.
    const sceneAsset: VoxelAsset = {
      ...structuredClone(asset),
      id: `scene-asset-${instanceId}`,
      source: asset.isTemplate === true ? '资产库实例快照' : (asset.source ?? '场景实体实例快照'),
      isTemplate: false,
      templateSourceId: asset.isTemplate === true ? asset.id : asset.templateSourceId,
    }
    let placedRootAssemblyId = ''
    let placedMemberKeys: string[] = []
    let editTargetAfterPlacement = editEntityId ?? ''
    const editingPart = editEntityId && !editEntityId.startsWith('assembly:')
      ? sceneEntityParts(projectRef.current).find((part) => part.id === editEntityId)
      : undefined
    const existingEditAssemblyId = editEntityId?.startsWith('assembly:')
      ? editEntityId.slice('assembly:'.length)
      : editingPart?.assemblyIds?.[0]
    updateProject((draft) => {
      draft.assets.push(sceneAsset)
      draft.instances.push({ id: instanceId, assetId: sceneAsset.id, ...position, rotation: 0, style: sceneAsset.style, visible: true, overrides: [] })
      if (sceneAsset.assembly) {
        const nodeIds = new Map(sceneAsset.assembly.nodes.map((node) => [node.id, `assembly-${instanceId}-${node.id}`]))
        sceneAsset.assembly.nodes.forEach((node) => {
          const memberKeys = [...new Set(node.memberKeys.flatMap((memberKey) => {
            if (memberKey.startsWith('assembly:')) {
              const mapped = nodeIds.get(memberKey.slice('assembly:'.length))
              return mapped ? [`assembly:${mapped}`] : []
            }
            if (memberKey.startsWith('part:')) return [`asset:${instanceId}:${memberKey.slice('part:'.length)}`]
            return []
          }))]
          if (memberKeys.length < 2) return
          const sceneAssemblyId = nodeIds.get(node.id)!
          draft.assemblies = [...(draft.assemblies ?? []), { id: sceneAssemblyId, name: node.name || sceneAsset.assembly?.name || '装配体', memberKeys }]
        })
        placedRootAssemblyId = nodeIds.get(sceneAsset.assembly.rootId) ?? ''
        placedMemberKeys = placedRootAssemblyId ? [`assembly:${placedRootAssemblyId}`] : []
      } else {
        placedMemberKeys = resolveInstanceComponents(asset, []).map(({ partId }) => `asset:${instanceId}:${partId}`)
      }
      if (editEntityId && placedMemberKeys.length) {
        let targetAssemblyId = existingEditAssemblyId
        if (!targetAssemblyId && editingPart) {
          const assemblyNumber = Math.max(1, draft.assemblySequence ?? 1)
          draft.assemblySequence = assemblyNumber + 1
          targetAssemblyId = `assembly-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          draft.assemblies = [...(draft.assemblies ?? []), { id: targetAssemblyId, name: `装配体 ${assemblyNumber}`, nameMode: 'auto', sequence: assemblyNumber, memberKeys: [editingPart.memberKey] }]
        }
        const targetAssembly = targetAssemblyId ? (draft.assemblies ?? []).find((assembly) => assembly.id === targetAssemblyId) : undefined
        if (targetAssembly) {
          targetAssembly.memberKeys = [...new Set([...targetAssembly.memberKeys, ...placedMemberKeys])]
          editTargetAfterPlacement = `assembly:${targetAssembly.id}`
        }
      }
    })
    if (editTargetAfterPlacement) {
      setEditEntityId(editTargetAfterPlacement)
      setCheckedTreePartIds([editTargetAfterPlacement])
      setSelectedId(editTargetAfterPlacement)
    } else setSelectedId(placedRootAssemblyId ? `assembly:${placedRootAssemblyId}` : instanceId)
    setNotice(`已放置资产 · ${asset.name}`)
    endPlacement()
  }

  const moveInstance = (instanceId: string, x: number, y: number, z: number, trackHistory = true) => {
    const instance = projectRef.current.instances.find((item) => item.id === instanceId)
    if (!instance) return false
    const asset = projectRef.current.assets.find((item) => item.id === instance.assetId)
    const currentX = assetOriginGridCoordinate(instance.x, asset?.width ?? 1)
    const currentY = worldToVoxel(instance.y ?? 0)
    const currentZ = assetOriginGridCoordinate(instance.z, asset?.depth ?? 1)
    const requestedX = assetOriginGridCoordinate(x, asset?.width ?? 1) - currentX
    const requestedY = worldToVoxel(y) - currentY
    const requestedZ = assetOriginGridCoordinate(z, asset?.depth ?? 1) - currentZ
    const bounds = sceneBoundsForProject(projectRef.current)
    const result = resolveGridMove(requestedX, requestedY, requestedZ, (deltaX, deltaY, deltaZ) => {
      const candidate = { ...instance, x: snapAssetOrigin(instance.x + voxelToWorld(deltaX), asset?.width ?? 1), y: voxelToWorld(currentY + deltaY), z: snapAssetOrigin(instance.z + voxelToWorld(deltaZ), asset?.depth ?? 1) }
      return (!asset || sceneVoxelsWithinBounds(resolveInstanceSceneVoxels(candidate, asset), bounds)) && !hasInstanceCollisionAt(instanceId, candidate.x, candidate.y ?? 0, candidate.z)
    })
    if (!result.moved) {
      if (result.blocked) setNotice('资产已抵达碰撞边界 · 该方向无法继续')
      return false
    }
    const nextX = snapAssetOrigin(instance.x + voxelToWorld(result.deltaX), asset?.width ?? 1)
    const nextY = voxelToWorld(currentY + result.deltaY)
    const nextZ = snapAssetOrigin(instance.z + voxelToWorld(result.deltaZ), asset?.depth ?? 1)
    updateProject((draft) => {
      const next = draft.instances.find((item) => item.id === instanceId)
      if (next) {
        next.x = nextX
        next.y = nextY
        next.z = nextZ
      }
    }, trackHistory)
    if (result.blocked) setNotice('已抵达碰撞边界 · 该方向无法继续')
    return true
  }

  const moveCustomComponent = (component: Voxel[], deltaX: number, deltaY: number, deltaZ: number, trackHistory = true): GridMoveResult => {
    if (!deltaX && !deltaY && !deltaZ) return { moved: false, blocked: false, deltaX: 0, deltaY: 0, deltaZ: 0 }
    const bounds = sceneBoundsForProject(projectRef.current)
    const result = resolveGridMove(deltaX, deltaY, deltaZ, (stepX, stepY, stepZ) => sceneVoxelsWithinBounds(component.map((voxel) => ({ ...voxel, x: voxel.x + stepX, y: voxel.y + stepY, z: voxel.z + stepZ })), bounds) && !hasCustomComponentCollisionAt(component, stepX, stepY, stepZ))
    if (!result.moved) {
      if (result.blocked) setNotice('体素实体已抵达碰撞边界 · 该方向无法继续')
      return result
    }
    updateProject((draft) => {
      const movingKeys = new Set(component.map(sceneVoxelKey))
      draft.customVoxels = draft.customVoxels.map((voxel) => movingKeys.has(sceneVoxelKey(voxel)) ? { ...voxel, x: voxel.x + result.deltaX, y: voxel.y + result.deltaY, z: voxel.z + result.deltaZ } : voxel)
    }, trackHistory)
    if (result.blocked) setNotice('已抵达碰撞边界 · 该方向无法继续')
    return result
  }

  const previewScenePartsMove = (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number): GridMoveResult => {
    if (!deltaX && !deltaY && !deltaZ) return { moved: false, blocked: false, deltaX: 0, deltaY: 0, deltaZ: 0 }
    const movableParts = parts.filter((part) => !scenePartIsLocked(projectRef.current, part))
    if (!movableParts.length) {
      return { moved: false, blocked: true, deltaX: 0, deltaY: 0, deltaZ: 0 }
    }
    const movingVoxels = movableParts.flatMap((part) => part.voxels)
    const movingIds = movableParts.map((part) => part.id)
    const bounds = sceneBoundsForProject(projectRef.current)
    return resolveGridMove(deltaX, deltaY, deltaZ, (stepX, stepY, stepZ) => {
      const movedVoxels = movingVoxels.map((voxel) => ({ ...voxel, x: voxel.x + stepX, y: voxel.y + stepY, z: voxel.z + stepZ }))
      return sceneVoxelsWithinBounds(movedVoxels, bounds)
        && !sceneOccupancyRef.current!.collidesTranslatedProjectVoxels(movingVoxels, { x: stepX, y: stepY, z: stepZ }, movingIds)
    })
  }

  const commitScenePartsMove = (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number): GridMoveResult => {
    const result = previewScenePartsMove(parts, deltaX, deltaY, deltaZ)
    if (!result.moved) {
      if (result.blocked) setNotice('实体已抵达碰撞边界 · 该方向无法继续')
      return result
    }
    const movableParts = parts.filter((part) => !scenePartIsLocked(projectRef.current, part))
    const currentParts = sceneEntityParts(projectRef.current)
    const movingIds = new Set(movableParts.map((part) => part.id))
    const movingCustomIds = new Set(movableParts.filter((part) => part.kind === 'custom').flatMap((part) => part.voxels.map(voxelEntityId)))
    const assetPartsByInstance = new Map<string, SceneEntityPart[]>()
    movableParts.filter((part) => part.kind === 'asset' && part.instanceId).forEach((part) => {
      const list = assetPartsByInstance.get(part.instanceId!) ?? []
      list.push(part)
      assetPartsByInstance.set(part.instanceId!, list)
    })
    const currentPartsByInstance = new Map<string, SceneEntityPart[]>()
    currentParts.filter((part) => part.kind === 'asset' && part.instanceId).forEach((part) => {
      const list = currentPartsByInstance.get(part.instanceId!) ?? []
      list.push(part)
      currentPartsByInstance.set(part.instanceId!, list)
    })
    const nextProject = structuredClone(projectRef.current)
    if (movingCustomIds.size) {
      nextProject.customVoxels = nextProject.customVoxels.map((voxel) => movingCustomIds.has(voxelEntityId(voxel))
          ? { ...voxel, x: voxel.x + result.deltaX, y: voxel.y + result.deltaY, z: voxel.z + result.deltaZ }
          : voxel)
    }
    assetPartsByInstance.forEach((selectedParts, instanceId) => {
      const instance = nextProject.instances.find((item) => item.id === instanceId)
      if (!instance) return
      const allParts = currentPartsByInstance.get(instanceId) ?? []
      const movesWholeInstance = allParts.length > 0 && selectedParts.length === allParts.length && allParts.every((part) => movingIds.has(part.id))
      if (movesWholeInstance) {
        const asset = nextProject.assets.find((item) => item.id === instance.assetId)
        instance.x = snapAssetOrigin(instance.x + voxelToWorld(result.deltaX), asset?.width ?? 1)
        instance.y = voxelToWorld(worldToVoxel(instance.y ?? 0) + result.deltaY)
        instance.z = snapAssetOrigin(instance.z + voxelToWorld(result.deltaZ), asset?.depth ?? 1)
        return
      }
      const offsets = instance.partOffsets ?? {}
      selectedParts.forEach((part) => {
        const current = offsets[part.partId] ?? { x: 0, y: 0, z: 0 }
        offsets[part.partId] = {
          x: snapWorld(current.x + voxelToWorld(result.deltaX)),
          y: snapWorld(current.y + voxelToWorld(result.deltaY)),
          z: snapWorld(current.z + voxelToWorld(result.deltaZ)),
        }
      })
      instance.partOffsets = offsets
    })
    commitProject(nextProject, true)
    if (result.blocked) setNotice('已抵达碰撞边界 · 该方向无法继续')
    return result
  }

  const assembleSceneParts = (parts: SceneEntityPart[], selectionIds: string[] = []) => {
    const nextProject = structuredClone(projectRef.current)
    const partsById = new Map(parts.map((part) => [part.id, part]))
    const explicitAssemblyKeys = selectionIds.filter((id) => id.startsWith('assembly:'))
    const selectedPartKeys = selectionIds.filter((id) => !id.startsWith('assembly:')).map((id) => partsById.get(id)).filter((part): part is SceneEntityPart => Boolean(part)).map((part) => {
      const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
      return assemblyIds.length ? `assembly:${assemblyIds[assemblyIds.length - 1]}` : part.memberKey
    })
    const memberKeys = [...new Set(selectionIds.length ? [...explicitAssemblyKeys, ...selectedPartKeys] : parts.map((part) => {
      const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
      return assemblyIds.length ? `assembly:${assemblyIds[assemblyIds.length - 1]}` : part.memberKey
    }))]
    if (memberKeys.length < 2) {
      setNotice('至少选择两个实体或装配体后才能重新组装')
      return
    }
    const assemblyId = `assembly-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const assemblyNumber = Math.max(1, nextProject.assemblySequence ?? 1)
    nextProject.assemblySequence = assemblyNumber + 1
    const detachedMembers = new Set(memberKeys)
    nextProject.assemblies = (nextProject.assemblies ?? []).map((assembly) => ({
      ...assembly,
      memberKeys: assembly.memberKeys.filter((memberKey) => !detachedMembers.has(memberKey)),
    })).filter((assembly) => assembly.memberKeys.length > 0)
    nextProject.assemblies.push({ id: assemblyId, name: `装配体 ${assemblyNumber}`, nameMode: 'auto', sequence: assemblyNumber, memberKeys })
    commitProject(nextProject)
    setCheckedTreePartIds([])
    setSelectedId(`assembly:${assemblyId}`)
    setNotice(`已重新组装 · ${memberKeys.length} 个成员`)
  }

  const resolveOperationParts = (ids: string[], sourceProject = projectRef.current) => {
    const currentParts = sceneEntityParts(sourceProject)
    const selectedIds = new Set(ids)
    const assemblyIds = new Set(ids.filter((id) => id.startsWith('assembly:')).map((id) => id.slice('assembly:'.length)))
    return currentParts.filter((part) => selectedIds.has(part.id) || (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).some((assemblyId) => assemblyIds.has(assemblyId)))
  }

  const toggleLockedSceneParts = (parts: SceneEntityPart[]) => {
    if (!parts.length) return
    const memberKeys = [...new Set(parts.map((part) => part.memberKey))]
    const lockedKeys = new Set(projectRef.current.lockedMemberKeys ?? [])
    const unlock = memberKeys.every((memberKey) => lockedKeys.has(memberKey))
    updateProject((draft) => {
      const next = new Set(draft.lockedMemberKeys ?? [])
      memberKeys.forEach((memberKey) => unlock ? next.delete(memberKey) : next.add(memberKey))
      draft.lockedMemberKeys = [...next]
    })
    setNotice(unlock ? `已取消固定 · ${memberKeys.length} 个实体` : `已固定 · ${memberKeys.length} 个实体`)
  }

  const dissolveSceneAssembly = (assemblyId: string) => {
    const assembly = projectRef.current.assemblies?.find((item) => item.id === assemblyId)
    if (!assembly) return
    const firstMember = assembly.memberKeys[0] ?? ''
    const firstPart = sceneEntityParts(projectRef.current).find((part) => {
      const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
      return assemblyIds.includes(assemblyId) || part.memberKey === firstMember || (firstMember.startsWith('asset:') && part.memberKey.startsWith(`${firstMember}:`)) || (firstMember.startsWith('voxel:') && part.memberKey === firstMember)
    })
    updateProject((draft) => {
      const target = (draft.assemblies ?? []).find((item) => item.id === assemblyId)
      const replacement = target?.memberKeys ?? []
      draft.assemblies = (draft.assemblies ?? [])
        .filter((item) => item.id !== assemblyId)
        .map((item) => ({ ...item, memberKeys: item.memberKeys.flatMap((memberKey) => memberKey === `assembly:${assemblyId}` ? replacement : [memberKey]) }))
    })
    setCheckedTreePartIds([])
    setSelectedId(firstPart?.id ?? '')
    setTreeContextMenu(null)
    setNotice(`已原位解散装配体 · ${assembly.memberKeys.length} 个子实体恢复独立`)
  }

  const assembleCheckedTreeParts = () => {
    const parts = resolveOperationParts(checkedTreePartIds)
    assembleSceneParts(parts, checkedTreePartIds)
  }

  const renameSceneEntity = (targetId: string, assemblyId?: string) => {
    const targetAssemblyId = assemblyId ?? (targetId.startsWith('assembly:') ? targetId.slice('assembly:'.length) : undefined)
    const assembly = targetAssemblyId ? projectRef.current.assemblies?.find((item) => item.id === targetAssemblyId) : undefined
    const part = !assembly ? sceneEntityParts(projectRef.current).find((item) => item.id === targetId) : undefined
    if (!assembly && !part) return
    const currentName = assembly?.name ?? projectRef.current.entityNames?.[part!.memberKey] ?? scenePartBaseName(projectRef.current, part!)
    const requested = window.prompt('重命名实体', currentName)
    const trimmed = requested?.trim()
    if (!trimmed) return
    const usedNames = new Set<string>(assembly
      ? (projectRef.current.assemblies ?? []).filter((item) => item.id !== assembly.id).map((item) => item.name?.trim()).filter((name): name is string => Boolean(name))
      : Object.entries(projectRef.current.entityNames ?? {}).filter(([key]) => key !== part!.memberKey).map(([, name]) => name))
    let nextName = trimmed
    let suffix = 2
    while (usedNames.has(nextName)) nextName = `${trimmed} ${suffix++}`
    updateProject((draft) => {
      if (targetAssemblyId) {
        const target = (draft.assemblies ?? []).find((item) => item.id === targetAssemblyId)
        if (target) {
          target.name = nextName
          target.nameMode = 'custom'
        }
      } else if (part) {
        draft.entityNames = { ...(draft.entityNames ?? {}), [part.memberKey]: nextName }
        draft.entityNameModes = { ...(draft.entityNameModes ?? {}), [part.memberKey]: 'custom' }
      }
    })
    setTreeContextMenu(null)
    setNotice(`已重命名 · ${nextName}`)
  }

  const enterEditMode = (entityId: string) => {
    if (entityId.startsWith('assembly:')) {
      const confirmed = window.confirm('您正在编辑装配体。任何体素添加将会新建该装配体下的子实体，在对应子实体上进行的擦除将会直接作用于对应子实体。确定要继续吗？')
      if (!confirmed) return
    }
    setEditEntityId(entityId)
    setSelectedId(entityId)
    setCheckedTreePartIds([entityId])
    if (!entityId.startsWith('assembly:')) revealScenePartPath(entityId)
    setTreeContextMenu(null)
    setNotice('已进入编辑修改模式 · 当前实体的修改将保留在场景实例上')
  }

  const exitEditMode = () => {
    setEditEntityId(null)
    setNotice('已退出编辑修改模式')
  }

  const changeTool = (nextTool: Tool) => {
    setTool(nextTool)
    if (!editEntityId) {
      setSelectedId('')
      setCheckedTreePartIds([])
    }
    setTreeContextMenu(null)
  }

  const saveProject = () => saveProjectAsFile(false)

  const saveProjectAs = () => saveProjectAsFile(true)

  const mergeLocalTemplateAssets = (loaded: ProjectState): ProjectState => {
    const loadedAssetIds = new Set(loaded.assets.map((asset) => asset.id))
    const localTemplateAssets = projectRef.current.assets.filter((asset) => asset.isTemplate !== false && !loadedAssetIds.has(asset.id))
    return { ...loaded, assets: [...loaded.assets, ...structuredClone(localTemplateAssets)] }
  }

  const applyOpenedProject = (loaded: ProjectState, fileRef: SceneFileRef | null, message: string) => {
    const normalized = normalizeStoredProject(mergeLocalTemplateAssets(loaded))
    replaceProject(normalized, false)
    setRecentMaterialIds(normalized.materials.slice(0, 8).map((material) => material.id))
    setSelectedId(normalized.instances[0]?.id ?? sceneEntityParts(normalized)[0]?.id ?? '')
    setEditEntityId(null)
    setCheckedTreePartIds([])
    markSceneSaved(normalized, fileRef)
    setNotice(message)
  }

  const openProject = async (file: File) => {
    try {
      const parsed = parseSceneFileText(await file.text())
      const restored = restoreProject(parsed)
      requestSceneReplace(async () => {
        applyOpenedProject(restored, { name: file.name }, `已打开场景 · ${restored.name}`)
      })
    } catch (error) {
      setNotice(`打开失败 · ${error instanceof Error ? error.message : '文件不是有效的莫测工程'}`)
    }
  }

  const importPortableEntities = async (portable: MoceAssetFile | MoceEntityFile) => {
    if (portable.format !== 'moce-entity') throw new PortableFileError('当前文件不是普通实体文件')
    try {
      await validateEntityFile(portable)
    } catch {
      setPersistenceStatus('offline')
    }
    if (!portable.entities.length) {
      setNotice('普通实体文件中没有可导入的实体')
      return
    }
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const existingAssets = projectRef.current.assets
    const importedNames: VoxelAsset[] = []
    const entityPartIds = new Map<string, string>()
    const minGrid = {
      x: Math.min(...portable.entities.map((entity) => entity.gridPosition.x)),
      y: Math.min(...portable.entities.map((entity) => entity.gridPosition.y)),
      z: Math.min(...portable.entities.map((entity) => entity.gridPosition.z)),
    }
    const sourceVoxels: Voxel[] = []
    const partVoxels: Record<string, Voxel[]> = {}
    portable.entities.forEach((entity, index) => {
      const sourceName = entity.name || entity.asset.name || '导入实体'
      const uniqueName = uniqueAssetName([...existingAssets, ...importedNames], sourceName)
      importedNames.push({ ...structuredClone(entity.asset), id: `entity-name-${index}`, name: uniqueName })
      const partId = uniqueName
      entityPartIds.set(entity.id, partId)
      const entityColor = entity.asset.templateColor ?? entity.asset.color
      const voxels = entity.asset.voxels.map((voxel) => ({
        x: voxel.x + entity.gridPosition.x - minGrid.x,
        y: voxel.y + entity.gridPosition.y - minGrid.y,
        z: voxel.z + entity.gridPosition.z - minGrid.z,
        // Portable ordinary entities may carry a whole-entity template color.
        // Flatten it into voxel colors before combining the import preview so
        // one imported entity cannot recolor its siblings.
        materialId: entity.asset.templateColor
          ? entityColor
          : voxel.materialId === 'primary'
            ? entity.asset.color
            : voxel.materialId === 'accent'
              ? entity.asset.accent
              : voxel.materialId,
      }))
      partVoxels[partId] = voxels
      sourceVoxels.push(...voxels)
    })
    const maxX = Math.max(...sourceVoxels.map((voxel) => voxel.x))
    const maxY = Math.max(...sourceVoxels.map((voxel) => voxel.y))
    const maxZ = Math.max(...sourceVoxels.map((voxel) => voxel.z))
    const assemblyIdMap = new Map(portable.assemblies.map((assembly) => [assembly.id, `import-assembly-${batchId}-${assembly.id}`]))
    const assemblyNodes: AssetAssembly['nodes'] = portable.assemblies.map((assembly) => ({
      id: assemblyIdMap.get(assembly.id)!,
      name: assembly.name ?? '装配体',
      memberKeys: assembly.memberKeys.flatMap((memberKey) => {
        if (memberKey.startsWith('entity:')) {
          const partId = entityPartIds.get(memberKey.slice('entity:'.length))
          return partId ? [`part:${partId}`] : []
        }
        if (memberKey.startsWith('assembly:')) {
          const childId = assemblyIdMap.get(memberKey.slice('assembly:'.length))
          return childId ? [`assembly:${childId}`] : []
        }
        return []
      }),
    }))
    const childAssemblyIds = new Set(portable.assemblies.flatMap((assembly) => assembly.memberKeys.filter((key) => key.startsWith('assembly:')).map((key) => key.slice('assembly:'.length))))
    const rootAssembly = portable.assemblies.find((assembly) => !childAssemblyIds.has(assembly.id))
    const previewAsset: VoxelAsset = {
      id: `entity-import-preview-${batchId}`,
      name: uniqueAssetName([...existingAssets, ...importedNames], portable.name || '导入实体'),
      style: '导入实体',
      kind: 'imported',
      color: importedNames[0]?.color ?? '#6c827d',
      accent: importedNames[0]?.accent ?? '#d2a354',
      width: maxX + 1,
      depth: maxZ + 1,
      height: maxY + 1,
      parts: Object.keys(partVoxels),
      partVoxels,
      voxels: sourceVoxels,
      source: '普通实体文件导入预览',
      isTemplate: false,
      assembly: rootAssembly && assemblyNodes.length ? { name: rootAssembly.name ?? '装配体', rootId: assemblyIdMap.get(rootAssembly.id)!, nodes: assemblyNodes } : undefined,
    }
    setPendingEntityImport({ asset: previewAsset, entityCount: portable.entities.length })
    setPlacementAssetId(previewAsset.id)
    interactionActiveRef.current = true
    setNotice(`已导入普通实体文件 · ${portable.entities.length} 个实体 · 请在场景中手动选择放置位置`)
  }

  const importEntityFileFromDisk = async (file: File) => {
    try {
      const portable = parsePortableFileText(await file.text())
      if (portable.format !== 'moce-entity') throw new PortableFileError('导入实体只支持普通实体文件（.moceentity），不支持场景文件或资产模板文件')
      await importPortableEntities(portable)
    } catch (error) {
      setNotice(`导入失败 · ${error instanceof Error ? error.message : '文件结构无效'}`)
    }
  }

  const createNewProject = () => {
    requestSceneReplace(async () => {
      const next = normalizeStoredProject(makeDefaultProject())
      replaceProject(next)
      setSelectedId('inst-chinese')
      setEditEntityId(null)
      setCheckedTreePartIds([])
      markSceneSaved(next, null)
      setNotice('已新建街区工程')
    })
  }

  const exportSelectedPart = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要导出的实体')
      return
    }
    const exportName = selectedAsset?.name ?? selectedEntityParts[0]?.label ?? '选中实体'
    const exportAsset = makeAssetFromSceneParts(`export-${Date.now()}`, exportName, selectedEntityParts, selectedAsset?.color ?? '#6c827d', selectedAsset?.accent ?? '#d2a354')
    const stl = makeStl(exportAsset)
    const blob = new Blob([stl], { type: 'model/stl' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${exportName}-选中实体.stl`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice(`已导出选中实体 · ${exportName} · ${selectedEntityParts.length} 个实体`)
  }

  const exportSceneStl = () => {
    const allParts = sceneEntityParts(projectRef.current)
    if (!allParts.length) {
      setNotice('当前场景没有可导出的实体')
      return
    }
    const sceneAsset = makeAssetFromSceneParts(`scene-export-${Date.now()}`, projectRef.current.name || '莫测造境场景', allParts, '#6c827d', '#d2a354')
    const stl = makeStl(sceneAsset)
    const blob = new Blob([stl], { type: 'model/stl' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${projectRef.current.name || '莫测造境场景'}-完整场景.stl`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice(`已导出完整场景 STL · ${allParts.length} 个实体`)
  }

  const exportSelectedEntityFile = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要导出的实体')
      return
    }
    const exportParts = selectedEntityParts.map((part) => ({ ...part, displayLabel: sceneEntityTreeName(projectRef.current, part) }))
    const file = createEntityFile(projectRef.current, exportParts, selectedDisplayName || '莫测造境实体')
    downloadPortableFile(file, selectedDisplayName || '莫测造境实体', '.moceentity')
    setNotice(`已导出普通实体文件 · ${file.entities.length} 个实体`)
  }

  const exportTemplateAssets = (assetIds: string[]) => {
    const assets = projectRef.current.assets.filter((asset) => asset.isTemplate !== false && assetIds.includes(asset.id))
    if (!assets.length) {
      setNotice('请先选择要导出的模板实体')
      return
    }
    const file = createAssetFile(assets, assetCategoryPaths)
    const baseName = assets.length === 1 ? assets[0].name : `莫测造境资产-${assets.length}个`
    downloadPortableFile(file, baseName, '.moceasset')
    setNotice(`已导出资产库实体文件 · ${assets.length} 个实体`)
  }

  const filteredAssets = project.assets
    .filter((asset) => asset.isTemplate !== false)
    .filter((asset) => asset.name.toLowerCase().includes(query.toLowerCase()))

  const replaceMaterialColor = (materialId: string, color: string) => {
    useMaterial(materialId)
    updateProject((draft) => {
      const material = draft.materials.find((item) => item.id === materialId)
      if (material) material.color = color
    })
    setNotice(`已替换调色板颜色 · ${color.toUpperCase()}`)
  }

  const refreshLibrary = async () => {
    setLibraryBusy(true)
    try {
      const loaded = await loadLibrary()
      setLibrary(loaded)
      setAssetCategoryPaths(normalizeAssetCategoryPaths(loaded.assetCategories ?? [], projectRef.current.assets))
    } catch {
      setNotice('资产库加载失败 · 请检查后端服务')
    } finally {
      setLibraryBusy(false)
    }
  }

  const openLibrary = async () => {
    setLibraryOpen(true)
    setSelectedLibrarySceneId(null)
    setSelectedLibrarySceneProject(null)
    setSceneLibraryContextMenu(null)
    await refreshLibrary()
  }

  const applyStoredProject = (loaded: ProjectState, fileRef: SceneFileRef | null, message: string) => {
    const normalized = normalizeStoredProject(loaded)
    replaceProject(normalized, false)
    setRecentMaterialIds(normalized.materials.slice(0, 8).map((material) => material.id))
    setSelectedId(normalized.instances[0]?.id ?? sceneEntityParts(normalized)[0]?.id ?? '')
    setEditEntityId(null)
    setCheckedTreePartIds([])
    persistenceReadyRef.current = true
    setPersistenceStatus('saved')
    markSceneSaved(normalized, fileRef)
    setNotice(message)
  }

  const loadStoredScene = async (sceneId: string, name: string) => {
    requestSceneReplace(async () => {
      setLibraryBusy(true)
      try {
        applyStoredProject(await loadScene(sceneId), { name: `${name}.moceworld`, libraryId: sceneId }, `已加载场景 · ${name}`)
        setLibraryOpen(false)
      } catch {
        setNotice('场景加载失败 · 数据库中不存在该场景')
      } finally {
        setLibraryBusy(false)
      }
    })
  }

  const selectLibraryScene = async (sceneId: string, name: string, x: number, y: number) => {
    setSelectedLibrarySceneId(sceneId)
    setSceneLibraryContextMenu({ sceneId, x, y })
    setLibraryBusy(true)
    try {
      setSelectedLibrarySceneProject(normalizeStoredProject(await loadScene(sceneId)))
    } catch {
      setSelectedLibrarySceneProject(null)
      setNotice(`场景实体加载失败 · ${name}`)
    } finally {
      setLibraryBusy(false)
    }
  }

  const requestSaveAssetToLibrary = (sourceAsset: VoxelAsset) => {
    const localAsset: VoxelAsset = {
      ...structuredClone(sourceAsset),
      id: `asset-library-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: sourceAsset.name?.trim() || '未命名实体',
      source: '场景库实体保存',
      isTemplate: true,
      templateSourceId: undefined,
    }
    setAssetCategorySave({ asset: localAsset })
  }

  const saveAssetToLibrary = (requestedName: string, categoryPath: string[]) => {
    if (!assetCategorySave) return
    const name = uniqueTemplateAssetName(projectRef.current.assets, requestedName.trim() || assetCategorySave.asset.name || '未命名实体')
    const asset: VoxelAsset = {
      ...structuredClone(assetCategorySave.asset),
      name,
      categoryPath: normalizeAssetCategoryPath(categoryPath),
      isTemplate: true,
    }
    updateProject((draft) => { draft.assets.push(asset) })
    void saveAsset(asset).catch(() => setPersistenceStatus('offline'))
    setAssetCategorySave(null)
    setNotice(`已保存实体到当前资产库 · ${asset.name} · ${asset.categoryPath?.join(' / ') ?? DEFAULT_ASSET_CATEGORY}`)
  }

  const addLibrarySceneEntityToCurrentScene = (sourceAsset: VoxelAsset) => {
    const sceneAsset: VoxelAsset = {
      ...structuredClone(sourceAsset),
      id: `scene-entity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: '场景库实体',
      isTemplate: false,
    }
    updateProject((draft) => { draft.assets.push(sceneAsset) })
    setLibraryOpen(false)
    setSelectedLibrarySceneId(null)
    setSelectedLibrarySceneProject(null)
    beginPlacement(sceneAsset)
    setNotice(`已添加实体到当前场景 · 请拖动放置 · ${sceneAsset.name}`)
  }

  const deleteLibrarySceneEntity = async (sceneId: string, assetId: string, name: string) => {
    const sceneName = library.scenes.find((scene) => scene.id === sceneId)?.name ?? '当前场景'
    if (!window.confirm(`确定从场景“${sceneName}”删除实体“${name}”？该实体的场景实例也会被删除。`)) return
    try {
      const source = selectedLibrarySceneProject ?? normalizeStoredProject(await loadScene(sceneId))
      const next: ProjectState = {
        ...source,
        assets: source.assets.filter((asset) => asset.id !== assetId),
        instances: source.instances.filter((instance) => instance.assetId !== assetId),
      }
      await saveScene(sceneId, createSceneFile(next))
      setSelectedLibrarySceneProject(normalizeStoredProject(next))
      await refreshLibrary()
      setNotice(`已从场景中删除实体 · ${name}`)
    } catch (error) {
      setNotice(`场景实体删除失败 · ${error instanceof Error ? error.message : '请检查后端服务'}`)
    }
  }

  /**
   * Migrate legacy instances that still point directly at a template asset.
   * New placements already receive snapshots, but older projects can contain
   * these shared references. Detaching them before a template edit preserves
   * the scene's previous name and color permanently.
   */
  const detachLegacyTemplateInstances = (draft: ProjectState, templateAssetId: string): VoxelAsset[] => {
    const template = draft.assets.find((asset) => asset.id === templateAssetId && asset.isTemplate !== false)
    if (!template) return []
    const snapshots: VoxelAsset[] = []
    draft.instances
      .filter((instance) => instance.assetId === templateAssetId)
      .forEach((instance, index) => {
        const preservedColor = instance.colorOverride ?? template.templateColor ?? template.color
        const snapshot: VoxelAsset = {
          ...structuredClone(template),
          id: `scene-asset-legacy-${instance.id}-${Date.now()}-${index + 1}`,
          source: '资产库实例快照',
          isTemplate: false,
          templateSourceId: template.id,
          color: preservedColor,
          templateColor: preservedColor,
        }
        draft.assets.push(snapshot)
        instance.assetId = snapshot.id
        instance.colorOverride = undefined
        snapshots.push(snapshot)
      })
    return snapshots
  }

  const renameTemplateAsset = (assetId: string) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId)
    if (!asset) return
    const requested = window.prompt('重命名模板实体', asset.name)
    if (!requested?.trim()) return
    const name = uniqueTemplateAssetName(projectRef.current.assets, requested, assetId)
    const nextAsset = { ...asset, name }
    let detachedAssets: VoxelAsset[] = []
    updateProject((draft) => {
      detachedAssets = detachLegacyTemplateInstances(draft, assetId)
      const target = draft.assets.find((item) => item.id === assetId)
      if (target) target.name = name
    })
    void Promise.all([nextAsset, ...detachedAssets].map((item) => saveAsset(item))).catch(() => setPersistenceStatus('offline'))
    setAssetContextMenu(null)
    setNotice(name === requested.trim() ? `已重命名模板实体 · ${name}` : `名称冲突，已重命名为 · ${name}`)
  }

  const duplicateTemplateAsset = (assetId: string) => {
    const source = projectRef.current.assets.find((item) => item.id === assetId)
    if (!source) return
    const copy: VoxelAsset = {
      ...structuredClone(source),
      id: `asset-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: uniqueTemplateAssetName(projectRef.current.assets, source.name),
      source: '资产库副本',
      isTemplate: true,
    }
    updateProject((draft) => { draft.assets.push(copy) })
    void saveAsset(copy).catch(() => setPersistenceStatus('offline'))
    setAssetContextMenu(null)
    setNotice(`已创建资产副本 · ${copy.name}`)
  }

  const changeTemplateAssetColor = (assetId: string, color: string) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId)
    if (!asset) return
    const normalizedColor = /^#[0-9a-f]{6}$/i.test(color) ? color : '#6c827d'
    const nextAsset = { ...asset, color: normalizedColor, templateColor: normalizedColor }
    let detachedAssets: VoxelAsset[] = []
    updateProject((draft) => {
      detachedAssets = detachLegacyTemplateInstances(draft, assetId)
      const target = draft.assets.find((item) => item.id === assetId)
      if (target) {
        target.color = normalizedColor
        target.templateColor = normalizedColor
      }
    })
    void Promise.all([nextAsset, ...detachedAssets].map((item) => saveAsset(item))).catch(() => setPersistenceStatus('offline'))
    setAssetContextMenu(null)
    setNotice(`已更新模板实体颜色 · ${normalizedColor.toUpperCase()}`)
  }

  const deleteTemplateAsset = (assetId: string) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId)
    if (!asset) return
    const usedByScene = projectRef.current.instances.some((instance) => instance.assetId === assetId)
    if (!window.confirm(usedByScene ? `模板“${asset.name}”仍被场景实例使用。删除资产库记录但保留场景实例？` : `确定删除模板“${asset.name}”？`)) return
    if (usedByScene) {
      const nextAsset = { ...asset, isTemplate: false }
      updateProject((draft) => {
        const target = draft.assets.find((item) => item.id === assetId)
        if (target) target.isTemplate = false
      })
      void saveAsset(nextAsset).catch(() => setPersistenceStatus('offline'))
      setNotice(`已从资产库移除 · 场景实例仍保留 · ${asset.name}`)
    } else {
      updateProject((draft) => { draft.assets = draft.assets.filter((item) => item.id !== assetId) })
      void deleteStoredAsset(assetId).catch(() => setPersistenceStatus('offline'))
      setNotice(`已删除模板实体 · ${asset.name}`)
    }
    setAssetContextMenu(null)
  }

  const persistAssetCategoryPaths = (paths: string[][]) => {
    const normalized = normalizeAssetCategoryPaths(paths, projectRef.current.assets)
    setAssetCategoryPaths(normalized)
    void saveAssetCategories(normalized).catch(() => setPersistenceStatus('offline'))
  }

  const createAssetCategory = (parentPath: string[] | null = null) => {
    const parentLabel = parentPath?.length ? `（父类别：${parentPath.join(' / ')}）` : ''
    const requested = window.prompt(`新建${parentPath?.length ? '子' : ''}类别${parentLabel}`, '')
    if (!requested?.trim()) return
    const segments = requested.split(/[\\/／>＞]/).map((value) => value.trim()).filter(Boolean)
    if (!segments.length) return
    const nextPath = [...(parentPath ?? []), ...segments]
    const nextKey = assetCategoryKey(nextPath)
    if (assetCategoryPaths.some((path) => assetCategoryKey(path) === nextKey)) {
      setNotice(`类别已存在 · ${nextPath.join(' / ')}`)
      setAssetCategoryContextMenu(null)
      return
    }
    persistAssetCategoryPaths([...assetCategoryPaths, nextPath])
    setAssetCategoryContextMenu(null)
    setNotice(`已新建类别 · ${nextPath.join(' / ')}`)
  }

  const deleteAssetCategory = (categoryPath: string[]) => {
    const prefixKey = assetCategoryKey(categoryPath)
    const affectedAssets = projectRef.current.assets.filter((asset) => {
      if (asset.isTemplate === false) return false
      const path = normalizeAssetCategoryPath(asset.categoryPath)
      return assetCategoryKey(path.slice(0, categoryPath.length)) === prefixKey
    })
    if (!window.confirm(`删除类别“${categoryPath.join(' / ')}”将同时删除其中的 ${affectedAssets.length} 个模板实体；场景中已经存在的实体会保留，但变为未保存实体。确定删除吗？`)) return
    const affectedIds = new Set(affectedAssets.map((asset) => asset.id))
    const usedIds = new Set(projectRef.current.instances.filter((instance) => affectedIds.has(instance.assetId)).map((instance) => instance.assetId))
    const removedAssets = affectedAssets.filter((asset) => !usedIds.has(asset.id))
    updateProject((draft) => {
      draft.assets = draft.assets
        .filter((asset) => !affectedIds.has(asset.id) || usedIds.has(asset.id))
        .map((asset) => affectedIds.has(asset.id) ? { ...asset, isTemplate: false } : asset)
    })
    const nextCategoryPaths = normalizeAssetCategoryPaths(assetCategoryPaths.filter((path) => assetCategoryKey(path.slice(0, categoryPath.length)) !== prefixKey), projectRef.current.assets)
    setAssetCategoryPaths(nextCategoryPaths)
    void (async () => {
      try {
        for (const asset of removedAssets) await deleteStoredAsset(asset.id)
        for (const asset of affectedAssets.filter((item) => usedIds.has(item.id))) await saveAsset({ ...asset, isTemplate: false })
        await saveAssetCategories(nextCategoryPaths)
      } catch {
        setPersistenceStatus('offline')
      }
    })()
    setAssetCategoryContextMenu(null)
    setAssetContextMenu(null)
    setNotice(`已删除类别 · ${categoryPath.join(' / ')} · ${affectedAssets.length} 个模板实体`)
  }

  const importSceneFileToLibrary = async (file: File) => {
    try {
      const sceneFile = parseSceneFileText(await file.text())
      const result = await importScene(sceneFile)
      await refreshLibrary()
      setNotice(`已导入场景到场景库 · ${result.scene.name}`)
    } catch (error) {
      setNotice(`场景导入失败 · ${error instanceof Error ? error.message : '文件结构无效'}`)
    }
  }

  const duplicateStoredScene = async (sceneId: string, name: string) => {
    const requestedName = window.prompt('副本名称', `${name}·副本`)
    if (!requestedName?.trim()) return
    try {
      await duplicateScene(sceneId, requestedName.trim())
      await refreshLibrary()
      setNotice(`已创建场景副本 · ${requestedName.trim()}`)
    } catch {
      setNotice('场景副本创建失败 · 请检查后端服务')
    }
    setSceneLibraryContextMenu(null)
  }

  const deleteStoredScene = async (sceneId: string, name: string) => {
    if (!window.confirm(`确定从场景库删除“${name}”？当前场景不会因此被删除。`)) return
    try {
      await deleteLibraryScene(sceneId)
      await refreshLibrary()
      setNotice(`已删除场景 · ${name}`)
    } catch {
      setNotice('场景删除失败 · 请检查后端服务')
    }
    setSceneLibraryContextMenu(null)
  }

  const makeAssemblyTemplateAsset = (sourceProject: ProjectState, sourceParts: SceneEntityPart[], rootAssemblyId: string): VoxelAsset | null => {
    const sourceAssemblies = sourceProject.assemblies ?? []
    const assemblyMap = new Map(sourceAssemblies.map((assembly) => [assembly.id, assembly]))
    const rootAssembly = assemblyMap.get(rootAssemblyId)
    if (!rootAssembly) return null
    const assemblyIds = new Set<string>()
    const collectAssemblyIds = (assemblyId: string) => {
      if (assemblyIds.has(assemblyId)) return
      assemblyIds.add(assemblyId)
      assemblyMap.get(assemblyId)?.memberKeys.filter((key) => key.startsWith('assembly:')).forEach((key) => collectAssemblyIds(key.slice('assembly:'.length)))
    }
    collectAssemblyIds(rootAssemblyId)
    const includedParts = sourceParts.filter((part) => (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(rootAssemblyId))
    if (includedParts.length < 2) return null
    const allVoxels = includedParts.flatMap((part) => part.voxels)
    const minX = Math.min(...allVoxels.map((voxel) => voxel.x))
    const minY = Math.min(...allVoxels.map((voxel) => voxel.y))
    const minZ = Math.min(...allVoxels.map((voxel) => voxel.z))
    const partIdMap = new Map<string, string>()
    const partVoxels: Record<string, Voxel[]> = {}
    includedParts.forEach((part, index) => {
      const localPartId = `part-${index + 1}`
      partIdMap.set(part.id, localPartId)
      partVoxels[localPartId] = part.voxels.map((voxel) => ({ x: voxel.x - minX, y: voxel.y - minY, z: voxel.z - minZ, materialId: voxel.materialId }))
    })
    const uniqueVoxels = new Map<string, Voxel>()
    Object.values(partVoxels).flat().forEach((voxel) => uniqueVoxels.set(`${voxel.x},${voxel.y},${voxel.z}`, voxel))
    const mapStoredMemberKey = (storedKey: string): string[] => {
      if (storedKey.startsWith('assembly:')) {
        const mappedAssemblyId = `assembly-node-${storedKey.slice('assembly:'.length)}`
        return assemblyIds.has(storedKey.slice('assembly:'.length)) ? [`assembly:${mappedAssemblyId}`] : []
      }
      const matchingParts = includedParts.filter((part) => part.memberKey === storedKey || (storedKey.startsWith('asset:') && part.memberKey.startsWith(`${storedKey}:`)))
      return matchingParts.map((part) => `part:${partIdMap.get(part.id)}`).filter((key): key is string => Boolean(key))
    }
    const nodes = [...assemblyIds].map((assemblyId) => {
      const assembly = assemblyMap.get(assemblyId)!
      return {
        id: `assembly-node-${assemblyId}`,
        name: assembly.name?.trim() || '装配体',
        memberKeys: [...new Set(assembly.memberKeys.flatMap(mapStoredMemberKey))],
      }
    })
    const rootName = rootAssembly.name?.trim() || '装配体'
    const width = Math.max(...allVoxels.map((voxel) => voxel.x)) - minX + 1
    const depth = Math.max(...allVoxels.map((voxel) => voxel.z)) - minZ + 1
    const height = Math.max(...allVoxels.map((voxel) => voxel.y)) - minY + 1
    const assembly: AssetAssembly = { name: rootName, rootId: `assembly-node-${rootAssemblyId}`, nodes }
    return {
      id: `asset-assembly-${Date.now()}`,
      name: rootName,
      style: '自定义实体',
      kind: 'imported',
      color: selectedAsset?.color ?? '#6c827d',
      accent: selectedAsset?.accent ?? '#d2a354',
      width,
      depth,
      height,
      parts: Object.keys(partVoxels),
      partVoxels,
      voxels: [...uniqueVoxels.values()],
      source: '装配体模板保存',
      assembly,
      isTemplate: true,
    }
  }

  const saveSelectedEntityAsAsset = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择一个实体')
      return
    }
    // A scene part can get its visible color from an instance override, a
    // template color, or an individual palette/material voxel. Flatten that
    // resolved appearance into each voxel before creating the template. A
    // single asset-level templateColor would otherwise recolor every voxel in
    // a multi-selection with the first selected entity's color.
    const colorizedParts = selectedEntityParts.map((part) => ({
      ...part,
      voxels: part.voxels.map((voxel) => ({
        ...voxel,
        materialId: scenePartVoxelDisplayColor(projectRef.current, part, voxel),
      })),
    }))
    const assemblyRootId = multipleSelected ? undefined : (selectedAssemblyId ?? (selectedEntityParts.flatMap((part) => part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).find((assemblyId) => !(project.assemblies ?? []).some((candidate) => candidate.memberKeys.includes(`assembly:${assemblyId}`)))))
    const assemblyAsset = assemblyRootId ? makeAssemblyTemplateAsset(projectRef.current, colorizedParts, assemblyRootId) : null
    const baseName = multipleSelected ? '多个实体' : (selectedDisplayName || assemblyAsset?.name || selectedAsset?.name || '手动体素实体')
    const templateColor = scenePartsDisplayColor(project, selectedEntityParts, selectedAsset)
    const templateAccent = selectedAsset?.accent ?? '#d2a354'
    const asset = assemblyAsset
      ? { ...assemblyAsset, name: baseName, color: templateColor }
      : makeAssetFromSceneParts(`asset-custom-${Date.now()}`, baseName, colorizedParts, templateColor, templateAccent)
    // A multi-selection is a set of independently colored parts. Keep those
    // resolved colors in each voxel's materialId and never add a whole-asset
    // templateColor, otherwise the first selected entity recolors the entire
    // saved template when it is rendered later.
    if (multipleSelected) delete asset.templateColor
    setAssetCategorySave({ asset: { ...asset, isTemplate: true } })
  }

  const splitSelectedEntity = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择一个实体')
      return
    }
    if (selectedInstance && selectedAsset?.partVoxels && Object.keys(selectedAsset.partVoxels).length > 1 && !(selectedInstance.overrides ?? []).length) {
      const createdAssets: VoxelAsset[] = []
      const createdInstances: SceneInstance[] = []
      Object.entries(selectedAsset.partVoxels).forEach(([partName, voxels], index) => {
        const suffix = `part-${index + 1}-${Date.now()}`
        const childAsset: VoxelAsset = {
          ...structuredClone(selectedAsset),
          id: `asset-${selectedAsset.id}-${suffix}`,
          name: uniqueAssetName([...project.assets, ...createdAssets], `${selectedAsset.name}·${partName}`),
          parts: [partName],
          partVoxels: { [partName]: structuredClone(voxels) },
          voxels: structuredClone(voxels),
          source: `${selectedAsset.name} · 拆分子实体`,
          isTemplate: false,
        }
        const childInstance: SceneInstance = {
          ...structuredClone(selectedInstance),
          id: `${selectedInstance.id}-${suffix}`,
          assetId: childAsset.id,
          overrides: [],
          partOffsets: {},
        }
        createdAssets.push(childAsset)
        createdInstances.push(childInstance)
      })
      updateProject((draft) => {
        draft.assets.push(...createdAssets)
        draft.instances = draft.instances.filter((instance) => instance.id !== selectedInstance.id)
        draft.instances.push(...createdInstances)
        draft.assemblies = (draft.assemblies ?? []).filter((assembly) => !assembly.memberKeys.includes(`asset:${selectedInstance.id}`))
      })
      createdAssets.forEach((asset) => { void saveAsset(asset).catch(() => setPersistenceStatus('offline')) })
      setSelectedId(createdInstances[0]?.id ?? '')
      setNotice(`已拆分实体 · ${createdInstances.length} 个子实体可分别摆放`)
      return
    }
    const memberKeys = new Set(selectedEntityParts.map((part) => part.memberKey))
    const hadAssembly = selectedEntityParts.some((part) => part.assemblyId)
    updateProject((draft) => {
      draft.assemblies = (draft.assemblies ?? []).filter((assembly) => !assembly.memberKeys.some((memberKey) => memberKeys.has(memberKey)))
    })
    setNotice(hadAssembly ? `已拆分实体 · ${selectedEntityParts.length} 个子实体可分别摆放` : `实体已保持独立 · ${selectedEntityParts.length} 个子实体`)
  }

  const copySourceParts = (sourceProject: ProjectState, sourceInstanceIds: string[], sourceCustomIds: string[]) => {
    const parts = sceneEntityParts(sourceProject)
    return parts.filter((part) => (part.instanceId && sourceInstanceIds.includes(part.instanceId)) || (part.kind === 'custom' && sourceCustomIds.includes(part.partId)))
  }

  const createCopyPreview = (sourceProject: ProjectState, sourceParts: SceneEntityPart[], count: number, gap: number, axis: CopyDirectionAxis, sign: 1 | -1): CopyPreviewState | null => {
    if (!sourceParts.length) return null
    const sourceVoxels = sourceParts.flatMap((part) => part.voxels)
    if (!sourceVoxels.length) return null
    const minX = Math.min(...sourceVoxels.map((voxel) => voxel.x))
    const minY = Math.min(...sourceVoxels.map((voxel) => voxel.y))
    const minZ = Math.min(...sourceVoxels.map((voxel) => voxel.z))
    const maxX = Math.max(...sourceVoxels.map((voxel) => voxel.x))
    const maxY = Math.max(...sourceVoxels.map((voxel) => voxel.y))
    const maxZ = Math.max(...sourceVoxels.map((voxel) => voxel.z))
    const dimensions = { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 }
    // The persisted voxel layout keeps Y as vertical and Z as the second
    // ground-plane axis. The editor-facing axes are X/Y on the ground and Z
    // vertical, so translate the user choice before calculating the offset.
    const dataAxis: Record<CopyDirectionAxis, 'x' | 'y' | 'z'> = { x: 'x', y: 'z', z: 'y' }
    const selectedDataAxis = dataAxis[axis]
    const distance = dimensions[selectedDataAxis] + gap
    const offsets = Array.from({ length: count }, (_, index) => ({ x: selectedDataAxis === 'x' ? sign * distance * (index + 1) : 0, y: selectedDataAxis === 'y' ? sign * distance * (index + 1) : 0, z: selectedDataAxis === 'z' ? sign * distance * (index + 1) : 0 }))
    const bounds = sceneBoundsForProject(sourceProject)
    const inBounds = (voxel: Voxel) => voxel.x >= -Math.floor(bounds.x / 2) && voxel.x < Math.ceil(bounds.x / 2) && voxel.z >= -Math.floor(bounds.y / 2) && voxel.z < Math.ceil(bounds.y / 2) && voxel.y >= 0 && voxel.y < bounds.z
    const movingOwnerIds = sourceParts.map((part) => part.id)
    let invalidReason: CopyPreviewState['invalidReason']
    for (const offset of offsets) {
      if (sourceVoxels.some((voxel) => !inBounds({ ...voxel, x: voxel.x + offset.x, y: voxel.y + offset.y, z: voxel.z + offset.z }))) {
        invalidReason = 'boundary'
        break
      }
      if (sceneOccupancyRef.current?.collidesTranslatedProjectVoxels(sourceVoxels, offset, movingOwnerIds)) {
        invalidReason = 'collision'
        break
      }
    }
    const previewAsset = makeAssetFromSceneParts('copy-preview', '复制预览', sourceParts, '#6c827d', '#d2a354', (voxel, part) => scenePartVoxelDisplayColor(sourceProject, part, voxel))
    // The preview asset may retain empty coordinate space before its first
    // voxel (makeAssetFromSceneParts deliberately keeps the scene origin for
    // positive coordinates). Use the actual non-empty local minima here, not
    // zero, otherwise the source position gets added a second time.
    const previewMinX = Math.min(...previewAsset.voxels.map((voxel) => voxel.x))
    const previewMinY = Math.min(...previewAsset.voxels.map((voxel) => voxel.y))
    const previewMinZ = Math.min(...previewAsset.voxels.map((voxel) => voxel.z))
    // Keep this origin in the same argument order as toSceneWorld:
    // editor X, editor Z (vertical), editor Y (the second ground-plane axis).
    // The previous order put the scene's horizontal Z into Three.js' vertical
    // coordinate, which made a ground-level copy preview appear high in the air.
    // Account for the preview asset's own local minimum as well. Some source
    // entities are already elevated in the scene; using minY directly there
    // would apply that height twice because the asset snapshot retains it.
    const origin = {
      x: (minX - previewMinX + previewAsset.width / 2) * VOXEL_WORLD_SIZE,
      y: (minY - previewMinY) * VOXEL_WORLD_SIZE,
      z: (minZ - previewMinZ + previewAsset.depth / 2) * VOXEL_WORLD_SIZE,
    }
    return { count, gap, axis, sign, sourceInstanceIds: [...new Set(sourceParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))], sourceCustomIds: [...new Set(sourceParts.filter((part) => part.kind === 'custom').map((part) => part.partId))], asset: previewAsset, origin, offsets, valid: !invalidReason, invalidReason }
  }

  const startDuplicatePreview = (requestedCount: number) => {
    const sourceProject = projectRef.current
    if (!selectedEntityParts.length) {
      setNotice('请先选择要复制的实体')
      return
    }
    const count = Math.max(1, Math.min(99, Math.round(requestedCount) || 1))
    const preview = createCopyPreview(sourceProject, selectedEntityParts.map((part) => structuredClone(part)), count, 1, 'x', 1)
    setCopyPreview(preview)
    setNotice(preview?.valid ? '请选择复制方向，确认后生成实体' : preview?.invalidReason === 'collision' ? '默认复制方向会与已有实体重叠，请选择其他方向' : '默认复制方向超出场景边界，请选择其他方向')
  }

  const changeCopyPreviewDirection = (axis: CopyDirectionAxis, sign: 1 | -1) => {
    if (!copyPreview) return
    const sourceProject = projectRef.current
    const sourceParts = copySourceParts(sourceProject, copyPreview.sourceInstanceIds, copyPreview.sourceCustomIds)
    setCopyPreview(createCopyPreview(sourceProject, sourceParts, copyPreview.count, copyPreview.gap, axis, sign))
  }

  const changeCopyPreviewGap = (gap: number) => {
    if (!copyPreview) return
    const sourceProject = projectRef.current
    const sourceParts = copySourceParts(sourceProject, copyPreview.sourceInstanceIds, copyPreview.sourceCustomIds)
    const nextGap = Math.max(0, Math.min(99, Math.round(gap)))
    setCopyPreview(createCopyPreview(sourceProject, sourceParts, copyPreview.count, nextGap, copyPreview.axis, copyPreview.sign))
  }

  const confirmDuplicate = () => {
    if (!copyPreview) return
    const sourceProject = projectRef.current
    const sourceParts = copySourceParts(sourceProject, copyPreview.sourceInstanceIds, copyPreview.sourceCustomIds)
    const currentPreview = createCopyPreview(sourceProject, sourceParts, copyPreview.count, copyPreview.gap, copyPreview.axis, copyPreview.sign)
    if (!currentPreview?.valid) {
      setNotice(currentPreview?.invalidReason === 'collision' ? '复制被拒绝：会与已有实体重叠' : '复制被拒绝：会超出场景边界')
      setCopyPreview(currentPreview)
      return
    }
    const selectedAssemblyIds = new Set(sourceParts.flatMap((part) => part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])))
    const assemblies = sourceProject.assemblies ?? []
    const assemblyMap = new Map(assemblies.map((assembly) => [assembly.id, assembly]))
    const rootAssemblyIds = [...selectedAssemblyIds].filter((assemblyId) => ![...selectedAssemblyIds].some((candidateId) => assemblyMap.get(candidateId)?.memberKeys.includes(`assembly:${assemblyId}`)))
    const assemblyTreeIds = new Set<string>()
    const collectAssemblyTree = (assemblyId: string) => { if (assemblyTreeIds.has(assemblyId)) return; assemblyTreeIds.add(assemblyId); assemblyMap.get(assemblyId)?.memberKeys.filter((key) => key.startsWith('assembly:')).forEach((key) => collectAssemblyTree(key.slice('assembly:'.length))) }
    rootAssemblyIds.forEach(collectAssemblyTree)
    const copyBatchId = Date.now()
    let firstSelection = ''
    updateProject((draft) => {
      for (let copyIndex = 0; copyIndex < currentPreview.count; copyIndex += 1) {
        const offset = currentPreview.offsets[copyIndex]
        const instanceMap = new Map<string, string>()
        const customMap = new Map<string, string>()
        const clonedInstanceIds: string[] = []
        currentPreview.sourceInstanceIds.forEach((oldId) => {
          const current = draft.instances.find((instance) => instance.id === oldId)
          if (!current) return
          const newId = `${oldId}-copy-${copyBatchId}-${copyIndex + 1}`
          instanceMap.set(oldId, newId); clonedInstanceIds.push(newId)
          const translateWorld = (value: number, delta: number) => Number((value + voxelToWorld(delta)).toFixed(3))
          const clonedInstance = { ...structuredClone(current), id: newId, overrides: structuredClone(current.overrides ?? []), partOffsets: structuredClone(current.partOffsets ?? {}) }
          // Horizontal copies must preserve the source elevation exactly. Only
          // a user-selected editor Z offset is allowed to change instance.y.
          clonedInstance.x = translateWorld(current.x, offset.x)
          clonedInstance.z = translateWorld(current.z, offset.z)
          if (offset.y !== 0) clonedInstance.y = translateWorld(current.y ?? 0, offset.y)
          draft.instances.push(clonedInstance)
        })
        currentPreview.sourceCustomIds.forEach((oldId) => {
          const newId = `${oldId}-copy-${copyBatchId}-${copyIndex + 1}`
          customMap.set(oldId, newId)
          draft.customVoxels.filter((voxel) => voxelEntityId(voxel) === oldId).forEach((voxel) => draft.customVoxels.push({ ...structuredClone(voxel), x: voxel.x + offset.x, y: voxel.y + offset.y, z: voxel.z + offset.z, entityId: newId }))
          if (draft.customColors?.[oldId]) draft.customColors = { ...(draft.customColors ?? {}), [newId]: draft.customColors[oldId] }
        })
        const assemblyMapForCopy = new Map<string, string>(); [...assemblyTreeIds].forEach((oldId) => assemblyMapForCopy.set(oldId, `assembly-${copyBatchId}-${copyIndex + 1}-${oldId}`))
        const mapLeafKey = (memberKey: string) => { for (const [oldId, newId] of instanceMap) if (memberKey === `asset:${oldId}` || memberKey.startsWith(`asset:${oldId}:`)) return memberKey.replace(`asset:${oldId}`, `asset:${newId}`); for (const [oldId, newId] of customMap) if (memberKey === `voxel:${oldId}`) return `voxel:${newId}`; return memberKey }
        const mapMemberKey = (memberKey: string) => memberKey.startsWith('assembly:') ? `assembly:${assemblyMapForCopy.get(memberKey.slice('assembly:'.length)) ?? memberKey.slice('assembly:'.length)}` : mapLeafKey(memberKey)
        ;[...assemblyTreeIds].forEach((oldId) => { const sourceAssembly = assemblyMap.get(oldId); if (!sourceAssembly) return; draft.assemblies = [...(draft.assemblies ?? []), { ...structuredClone(sourceAssembly), id: assemblyMapForCopy.get(oldId)!, nameMode: 'auto', sequence: undefined, parentAssemblyId: undefined, name: (() => { const number = Math.max(1, draft.assemblySequence ?? 1); draft.assemblySequence = number + 1; return `装配体 ${number}` })(), memberKeys: sourceAssembly.memberKeys.map(mapMemberKey) }] })
        if (!firstSelection) firstSelection = rootAssemblyIds[0] ? `assembly:${assemblyMapForCopy.get(rootAssemblyIds[0])}` : clonedInstanceIds[0] ? clonedInstanceIds[0] : currentPreview.sourceCustomIds[0] ? `custom:${customMap.get(currentPreview.sourceCustomIds[0])}` : ''
      }
    })
    setCopyPreview(null); setCheckedTreePartIds([]); setSelectedId(firstSelection); setNotice(`已复制 ${sourceParts.length} 个选中实体 × ${currentPreview.count} · 装配体结构已保留`)
  }

  const deleteSelected = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要删除的实体')
      return
    }
    deleteSceneParts(selectedEntityParts.map((part) => part.id))
  }

  const deleteSceneParts = (requestedIds: string[]) => {
    const targetParts = resolveOperationParts(requestedIds, projectRef.current)
    if (!targetParts.length) {
      setTreeContextMenu(null)
      return
    }
    const removedCustomIds = new Set(targetParts.filter((part) => part.kind === 'custom').map((part) => part.partId))
    const removedInstanceIds = new Set(targetParts.filter((part) => part.kind === 'asset' && part.instanceId).map((part) => part.instanceId!))
    const removedMemberKeys = new Set(targetParts.map((part) => part.memberKey))
    updateProject((draft) => {
      draft.customVoxels = draft.customVoxels.filter((voxel) => !removedCustomIds.has(voxelEntityId(voxel)))
      draft.instances = draft.instances.filter((instance) => !removedInstanceIds.has(instance.id))
      draft.assemblies = (draft.assemblies ?? []).filter((assembly) => !assembly.memberKeys.some((memberKey) => removedMemberKeys.has(memberKey) || (memberKey.startsWith('asset:') && removedInstanceIds.has(memberKey.split(':')[1])) || (memberKey.startsWith('voxel:') && removedCustomIds.has(memberKey.slice('voxel:'.length)))))
      draft.lockedMemberKeys = (draft.lockedMemberKeys ?? []).filter((memberKey) => !removedMemberKeys.has(memberKey))
      const remainingLeafKeys = new Set(sceneEntityParts({ ...draft, assemblies: [] }).map((part) => part.memberKey))
      const assemblyMap = new Map((draft.assemblies ?? []).map((assembly) => [assembly.id, assembly]))
      const normalized = new Map<string, string[]>()
      const isValidAssembly = (assemblyId: string, trail = new Set<string>()): boolean => {
        if (normalized.has(assemblyId)) return (normalized.get(assemblyId) ?? []).length >= 2
        if (trail.has(assemblyId)) return false
        const assembly = assemblyMap.get(assemblyId)
        if (!assembly) return false
        const kept = assembly.memberKeys.filter((memberKey) => {
          if (memberKey.startsWith('assembly:')) return isValidAssembly(memberKey.slice('assembly:'.length), new Set([...trail, assemblyId]))
          return remainingLeafKeys.has(memberKey) || (memberKey.startsWith('asset:') && [...remainingLeafKeys].some((key) => key.startsWith(`${memberKey}:`)))
        })
        normalized.set(assemblyId, kept)
        return kept.length >= 2
      }
      ;(draft.assemblies ?? []).forEach((assembly) => { isValidAssembly(assembly.id) })
      draft.assemblies = (draft.assemblies ?? []).map((assembly) => ({ ...assembly, memberKeys: normalized.get(assembly.id) ?? [] })).filter((assembly) => assembly.memberKeys.length >= 2)
    })
    if (requestedIds.includes(editEntityId ?? '') || targetParts.some((part) => part.id === editEntityId || (editEntityId?.startsWith('assembly:') && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editEntityId.slice('assembly:'.length))))) setEditEntityId(null)
    setCheckedTreePartIds((ids) => ids.filter((id) => !targetParts.some((part) => part.id === id)))
    setSelectedId('')
    setTreeContextMenu(null)
    setNotice(`已删除 · ${targetParts.length} 个实体`)
  }

  const deleteSceneTreeEntity = (targetId: string, assemblyId?: string) => {
    const selectedIds = checkedTreePartIds.length && (checkedTreePartIds.includes(targetId) || (assemblyId && checkedTreePartIds.some((id) => sceneParts.find((part) => part.id === id)?.assemblyIds?.includes(assemblyId))))
      ? checkedTreePartIds
      : [assemblyId ? `assembly:${assemblyId}` : targetId]
    deleteSceneParts(selectedIds)
  }

  const selectedTransformEditable = selectedEntityParts.length === 1
  const selectedPosition = selectedTransformEditable && selectedScenePart
    ? selectedScenePart.kind === 'asset' && selectedInstance
      ? [selectedInstance.x, selectedInstance.z, selectedInstance.y ?? 0]
      : selectedScenePart.voxels[0]
        ? [voxelCenterToWorld(selectedScenePart.voxels[0].x), voxelCenterToWorld(selectedScenePart.voxels[0].z), voxelCenterToWorld(selectedScenePart.voxels[0].y)]
        : [0, 0, 0]
    : [0, 0, 0]

  const changeSelectedTransform = (axis: number, requestedValue: number) => {
    if (!selectedTransformEditable || !selectedScenePart || !Number.isFinite(requestedValue)) return
    const bounds = sceneBoundsForProject(projectRef.current)
    const limits = axis === 0
      ? { min: -bounds.x * VOXEL_WORLD_SIZE / 2, max: bounds.x * VOXEL_WORLD_SIZE / 2 }
      : axis === 1
        ? { min: -bounds.y * VOXEL_WORLD_SIZE / 2, max: bounds.y * VOXEL_WORLD_SIZE / 2 }
        : { min: 0, max: bounds.z * VOXEL_WORLD_SIZE }
    const value = Math.max(limits.min, Math.min(limits.max, requestedValue))
    if (selectedScenePart.kind === 'asset' && selectedInstance) {
      const property = axis === 0 ? 'x' : axis === 1 ? 'z' : 'y'
      updateProject((draft) => {
        const instance = draft.instances.find((item) => item.id === selectedInstance.id)
        if (!instance) return
        const asset = draft.assets.find((item) => item.id === instance.assetId)
        instance[property] = property === 'x'
          ? snapAssetOrigin(value, asset?.width ?? 1)
          : property === 'z'
            ? snapAssetOrigin(value, asset?.depth ?? 1)
            : snapWorld(value)
      })
      setNotice(`已更新位置 ${['X', 'Y', 'Z'][axis]} · 已限制在场景边界内`)
      return
    }
    const entityId = selectedScenePart.partId
    const firstVoxel = selectedScenePart.voxels[0]
    if (!firstVoxel) return
    const targetVoxel = axis === 2 ? Math.round(value / VOXEL_WORLD_SIZE - 0.5) : worldToVoxelCenter(value)
    const currentVoxel = axis === 0 ? firstVoxel.x : axis === 1 ? firstVoxel.z : firstVoxel.y
    const delta = targetVoxel - currentVoxel
    if (!delta) return
    updateProject((draft) => {
      draft.customVoxels = draft.customVoxels.map((voxel) => {
        if (voxelEntityId(voxel) !== entityId) return voxel
        if (axis === 0) return { ...voxel, x: voxel.x + delta }
        if (axis === 1) return { ...voxel, z: voxel.z + delta }
        return { ...voxel, y: voxel.y + delta }
      })
    })
    setNotice(`已更新手动实体位置 ${['X', 'Y', 'Z'][axis]} · 已限制在场景边界内`)
  }

  const selectedColor = scenePartsDisplayColor(project, selectedEntityParts, selectedAsset)
  const previewVoxelColors = useMemo(() => {
    const colors: Record<string, string> = {}
    selectedEntityParts.forEach((part) => {
      const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
      const asset = instance ? project.assets.find((item) => item.id === instance.assetId) : undefined
      // Match buildAssetGroup's precedence: an instance override, template
      // color, or custom-entity color is applied to every voxel, including
      // voxels whose materialId is ivory/gold/etc. Only an ordinary asset with
      // no whole-entity color uses its material colors below.
      const wholeEntityColor = part.colorOverride ?? asset?.templateColor ?? (part.kind === 'custom' ? project.customColors?.[part.partId] : undefined)
      const primaryColor = wholeEntityColor ?? asset?.color
      part.voxels.forEach((voxel) => {
        const key = `${voxel.x},${voxel.y},${voxel.z}`
        if (wholeEntityColor) colors[key] = wholeEntityColor
        else if (voxel.materialId === 'primary' && primaryColor) colors[key] = primaryColor
        else if (voxel.materialId === 'accent') colors[key] = asset?.accent ?? '#d2a354'
        else if (voxel.materialId.startsWith('#')) colors[key] = voxel.materialId
        else colors[key] = materialColorForVoxel(project, voxel, asset)
      })
    })
    return colors
  }, [project, selectedEntityParts])
  const changeSelectedColor = (color: string) => {
    if (!selectedEntityParts.length) return
    const instanceIds = new Set(selectedEntityParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))
    const customIds = new Set(selectedEntityParts.filter((part) => part.kind === 'custom').map((part) => part.partId))
    updateProject((draft) => {
      draft.instances.forEach((instance) => { if (instanceIds.has(instance.id)) instance.colorOverride = color })
      draft.customColors = { ...(draft.customColors ?? {}) }
      customIds.forEach((entityId) => { draft.customColors![entityId] = color })
    })
    setNotice(`已更新选中实体颜色 · ${color.toUpperCase()}`)
  }

  type SceneTransformAxis = 'x' | 'y' | 'z'
  const sceneAxisToVoxelAxis = (axis: SceneTransformAxis): 'x' | 'y' | 'z' => axis === 'x' ? 'x' : axis === 'y' ? 'z' : 'y'

  const transformedEntitiesWithinSceneBoundary = (mode: 'mirror' | 'rotate', axis: SceneTransformAxis, degrees: 90 | 180 | 270 = 90) => {
    const bounds = sceneBoundsForProject(projectRef.current)
    const withinBoundary = (voxels: Voxel[]) => sceneVoxelsWithinBounds(voxels, bounds)
    const voxelAxis = sceneAxisToVoxelAxis(axis)
    const customIds = new Set<string>()
    for (const part of selectedEntityParts) {
      if (part.kind !== 'custom' || customIds.has(part.partId)) continue
      customIds.add(part.partId)
      const source = projectRef.current.customVoxels.filter((voxel) => voxelEntityId(voxel) === part.partId)
      const transformed = mode === 'mirror' ? mirrorVoxels(source, voxelAxis) : rotateVoxels(source, voxelAxis, degrees)
      if (!withinBoundary(transformed)) return false
    }
    const assetMap = new Map(projectRef.current.assets.map((asset) => [asset.id, asset]))
    const instanceIds = new Set<string>()
    for (const part of selectedEntityParts) {
      if (!part.instanceId || instanceIds.has(part.instanceId)) continue
      instanceIds.add(part.instanceId)
      const instance = projectRef.current.instances.find((candidate) => candidate.id === part.instanceId)
      const asset = instance ? assetMap.get(instance.assetId) : undefined
      if (!instance || !asset) continue
      const simulated = structuredClone(instance)
      if (mode === 'mirror') simulated.mirror = { x: simulated.mirror?.x ?? false, y: simulated.mirror?.y ?? false, z: simulated.mirror?.z ?? false, [axis]: !(simulated.mirror?.[axis] ?? false) }
      else {
        const key = axis === 'x' ? 'rotationX' : axis === 'y' ? 'rotationY' : 'rotationZ'
        simulated[key] = ((simulated[key] ?? 0) + degrees) % 360
      }
      if (!withinBoundary(resolveInstanceSceneVoxels(simulated, asset))) return false
    }
    return true
  }

  const applyCustomVoxelTransform = (parts: SceneEntityPart[], transform: (voxels: Voxel[]) => Voxel[]) => {
    const selectedCustomIds = new Set(parts.filter((part) => part.kind === 'custom').map((part) => part.partId))
    if (!selectedCustomIds.size) return false
    updateProject((draft) => {
      const transformedByKey = new Map<string, Voxel>()
      for (const entityId of selectedCustomIds) {
        const source = draft.customVoxels.filter((voxel) => voxelEntityId(voxel) === entityId)
        const transformed = transform(source)
        source.forEach((voxel, index) => transformedByKey.set(`${entityId}:${voxel.x},${voxel.y},${voxel.z}`, { ...transformed[index], entityId }))
      }
      draft.customVoxels = draft.customVoxels.map((voxel) => transformedByKey.get(`${voxelEntityId(voxel)}:${voxel.x},${voxel.y},${voxel.z}`) ?? voxel)
    })
    return true
  }

  const selectedContainsLockedEntity = () => selectedEntityParts.some((part) => scenePartIsLocked(projectRef.current, part))

  const mirrorSelectedEntities = (axis: SceneTransformAxis) => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要镜像的实体')
      return
    }
    if (selectedContainsLockedEntity()) {
      setNotice('选中的实体中包含已固定实体 · 请先取消固定后再镜像')
      return
    }
    if (!transformedEntitiesWithinSceneBoundary('mirror', axis)) {
      setNotice('当前操作会使实体超出场景范围，请先移动后再操作。')
      return
    }
    const voxelAxis = sceneAxisToVoxelAxis(axis)
    const customChanged = applyCustomVoxelTransform(selectedEntityParts, (voxels) => mirrorVoxels(voxels, voxelAxis))
    const instanceIds = new Set(selectedEntityParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))
    if (instanceIds.size) {
      updateProject((draft) => {
        draft.instances.forEach((instance) => {
          if (!instanceIds.has(instance.id)) return
          instance.mirror = { x: instance.mirror?.x ?? false, y: instance.mirror?.y ?? false, z: instance.mirror?.z ?? false, [axis]: !(instance.mirror?.[axis] ?? false) }
        })
      })
    }
    setNotice(`已镜像选中实体 · ${axis.toUpperCase()} 轴${customChanged && instanceIds.size ? ' · 资产实例同步镜像' : ''}`)
  }

  const rotateSelectedEntities = (axis: SceneTransformAxis, degrees: 90 | 180 | 270) => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要旋转的实体')
      return
    }
    if (selectedContainsLockedEntity()) {
      setNotice('选中的实体中包含已固定实体 · 请先取消固定后再旋转')
      return
    }
    if (!transformedEntitiesWithinSceneBoundary('rotate', axis, degrees)) {
      setNotice('当前操作会使实体超出场景范围，请先移动后再操作。')
      return
    }
    const voxelAxis = sceneAxisToVoxelAxis(axis)
    applyCustomVoxelTransform(selectedEntityParts, (voxels) => rotateVoxels(voxels, voxelAxis, degrees))
    const instanceIds = new Set(selectedEntityParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))
    if (instanceIds.size) {
      updateProject((draft) => {
        draft.instances.forEach((instance) => {
          if (!instanceIds.has(instance.id)) return
          const key = axis === 'x' ? 'rotationX' : axis === 'y' ? 'rotationY' : 'rotationZ'
          instance[key] = ((instance[key] ?? 0) + degrees) % 360
        })
      })
    }
    setNotice(`已旋转选中实体 · ${axis.toUpperCase()} 轴 ${degrees}°`)
  }

  const operateOnSceneSelection = (partIds: string[], operation: 'delete' | 'lock' | 'assemble') => {
    const parts = resolveOperationParts(partIds)
    if (operation === 'delete') deleteSceneParts(partIds)
    if (operation === 'lock') toggleLockedSceneParts(parts)
    if (operation === 'assemble') assembleSceneParts(parts)
    setCheckedTreePartIds([])
  }

  const toggleTreeLock = (targetId: string, assemblyId?: string) => {
    const targetIds = assemblyId ? [`assembly:${assemblyId}`] : [targetId]
    const targetParts = resolveOperationParts(targetIds)
    const usesChecked = checkedTreePartIds.length > 0 && (checkedTreePartIds.includes(targetId) || targetParts.some((part) => checkedTreePartIds.includes(part.id)))
    operateOnSceneSelection(usesChecked ? checkedTreePartIds : targetIds, 'lock')
  }

  const resetSelectedTransform = () => {
    if (!selectedInstance) return
    if (selectedContainsLockedEntity()) {
      setNotice('当前实体已固定 · 请先取消固定后再重置变换')
      return
    }
    updateProject((draft) => {
      const instance = draft.instances.find((item) => item.id === selectedInstance.id)
      if (instance) { instance.x = 0; instance.y = 0; instance.z = 0; instance.rotation = 0; instance.rotationX = 0; instance.rotationY = 0; instance.rotationZ = 0; instance.mirror = { x: false, y: false, z: false }; instance.partOffsets = {} }
    })
    setNotice('已重置选中实例变换')
  }

  const revealScenePartPath = (partId: string) => {
    const part = sceneEntityParts(projectRef.current).find((candidate) => candidate.id === partId)
    if (!part) return
    const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
    if (assemblyIds.length) setExpandedAssemblies((current) => ({ ...current, ...Object.fromEntries(assemblyIds.map((assemblyId) => [assemblyId, true])) }))
  }

  const selectTreeItem = (id: string, additive = false) => {
    if (editEntityId && id !== editEntityId) {
      setTreeContextMenu(null)
      setNotice('编辑模式下只能操作当前编辑实体')
      return
    }
    setCopyPreview(null)
    const removing = additive && checkedTreePartIds.includes(id)
    setCheckedTreePartIds((current) => {
      if (!additive) return [id]
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return [...next]
    })
    setSelectedId(removing && checkedTreePartIds.length === 1 ? '' : id)
    if (!removing && !id.startsWith('assembly:')) revealScenePartPath(id)
    setTreeContextMenu(null)
  }

  const toggleTreeChecked = (id: string) => {
    if (editEntityId && id !== editEntityId) {
      setTreeContextMenu(null)
      setNotice('编辑模式下只能操作当前编辑实体')
      return
    }
    setCopyPreview(null)
    const removing = checkedTreePartIds.includes(id)
    setCheckedTreePartIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
    setSelectedId(removing && selectedId === id ? '' : id)
    if (!removing && !id.startsWith('assembly:')) revealScenePartPath(id)
    setTreeContextMenu(null)
  }

  const selectScenePart = (id: string) => {
    setCopyPreview(null)
    setSelectedId(id)
    setCheckedTreePartIds([id])
    revealScenePartPath(id)
    setTreeContextMenu(null)
  }

  const updateSceneCheckedSelection = (partIds: string[], additive = false) => {
    setCopyPreview(null)
    setCheckedTreePartIds((current) => {
      if (!additive) return [...new Set(partIds)]
      const next = new Set(current)
      const allSelected = partIds.length > 0 && partIds.every((partId) => next.has(partId))
      partIds.forEach((partId) => allSelected ? next.delete(partId) : next.add(partId))
      return [...next]
    })
    if (partIds[0]) {
      setSelectedId(partIds[0])
      revealScenePartPath(partIds[0])
    }
    else if (!additive) setSelectedId('')
    setTreeContextMenu(null)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Box size={19} strokeWidth={1.7} /></div>
          <div><div className="brand-name">莫测造境</div><div className="brand-subtitle">体素世界编辑器</div></div>
        </div>
        <div className="top-actions">
          <ActionButton icon={<FilePlus2 size={17} />} label="新建" onClick={createNewProject} />
          <ActionButton icon={<FolderOpen size={17} />} label="打开" onClick={() => fileInputRef.current?.click()} />
          <ActionButton icon={<Database size={17} />} label="场景库" onClick={openLibrary} />
          <ActionButton icon={<Save size={17} />} label="保存" onClick={saveProject} />
          <ActionButton icon={<Save size={17} />} label="另存" onClick={saveProjectAs} />
          <div className="top-divider" />
          <ActionButton icon={<WandSparkles size={17} />} label="模型转体素" onClick={() => modelImportInputRef.current?.click()} />
          <ActionButton icon={<Upload size={17} />} label="导入实体" onClick={() => entityFileInputRef.current?.click()} />
          <ActionButton icon={<Download size={17} />} label="导出场景" onClick={exportSceneStl} strong />
          <button className="icon-button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={undoProject}><Undo2 size={17} /></button>
          <button className="icon-button" title="重做" aria-label="重做" disabled={!canRedo} onClick={redoProject}><Redo2 size={17} /></button>
          <div className="top-spacer" />
          <button className="icon-button" title="设置" onClick={() => setNotice('设置面板将在下一阶段接入')}><Settings size={17} /></button>
        </div>
        <input ref={fileInputRef} className="hidden-input" type="file" accept=".json,.moceworld" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void openProject(file) }} />
        <input ref={modelImportInputRef} className="hidden-input" type="file" accept=".glb,.gltf,.obj,.stl" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) openModelImportDialog(file) }} />
        <input ref={entityFileInputRef} className="hidden-input" type="file" accept=".moceentity" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importEntityFileFromDisk(file) }} />
        <input ref={sceneLibraryImportInputRef} className="hidden-input" type="file" accept=".json,.moceworld" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importSceneFileToLibrary(file) }} />
      </header>

      <main className={`workspace ${assetSidebarCollapsed ? 'asset-sidebar-collapsed' : ''}`} onClick={() => { if (treeContextMenu) setTreeContextMenu(null); if (assetContextMenu) setAssetContextMenu(null); if (assetCategoryContextMenu) setAssetCategoryContextMenu(null); if (sceneLibraryContextMenu) setSceneLibraryContextMenu(null) }}>
        <AssetSidebar assets={filteredAssets} categoryPaths={assetCategoryPaths} query={query} setQuery={setQuery} selectedAssetIds={selectedAssetIds} onToggleAssetSelection={(assetId) => setSelectedAssetIds((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId])} onClearAssetSelection={() => setSelectedAssetIds([])} onExportAssets={exportTemplateAssets} collapsed={assetSidebarCollapsed} onToggleCollapsed={() => setAssetSidebarCollapsed((value) => !value)} onNotice={setNotice} onBeginPlacement={beginPlacement} onEndPlacement={endPlacement} onContextMenu={(assetId, x, y) => { setAssetContextMenu({ assetId, x, y }); setAssetCategoryContextMenu(null) }} contextMenu={assetContextMenu} categoryContextMenu={assetCategoryContextMenu} onCategoryContextMenu={(path, x, y) => { setAssetCategoryContextMenu({ path, x, y }); setAssetContextMenu(null) }} onCreateCategory={createAssetCategory} onDeleteCategory={deleteAssetCategory} onRenameAsset={renameTemplateAsset} onDuplicateAsset={duplicateTemplateAsset} onDeleteAsset={deleteTemplateAsset} onChangeAssetColor={changeTemplateAssetColor} />
        <section className="viewport-panel">
          <div className="viewport-toolbar">
            <div className="view-toggle">{(['正交', '透视'] as const).map((mode) => <button key={mode} className={viewMode === mode ? 'active' : ''} onClick={() => { setViewMode(mode); setNotice(`已切换视图 · ${mode}`) }}>{mode}</button>)}</div>
            <div className="toolbar-spacer" />
            <button className="micro-control" onClick={() => setNotice('当前体素单位 · 1 mm')}><Grid3X3 size={14} /> 1 mm体素 <ChevronDown size={13} /></button>
            <div className="boundary-control-wrap">
              <button className={`micro-control ${boundaryOpen ? 'active' : ''}`} onClick={() => { setBoundaryDraft(currentSceneBounds); setBoundaryOpen((value) => !value) }}><SlidersHorizontal size={14} /> 边界 <ChevronDown size={13} /></button>
              {boundaryOpen && <div className="boundary-popover" onClick={(event) => event.stopPropagation()}>
                <div className="boundary-popover-title">场景边界</div>
                <div className="boundary-popover-subtitle">按体素设置地面尺寸与 Z 轴限高</div>
                <div className="boundary-fields">
                  {([['x', 'X 宽度'], ['y', 'Y 深度'], ['z', 'Z 高度']] as const).map(([axis, label]) => <label key={axis} className="boundary-field"><span>{label}</span><input type="number" min={1} max={1000} step={1} value={boundaryDraft[axis]} onChange={(event) => setBoundaryDraft((current) => ({ ...current, [axis]: Math.max(1, Math.min(1000, Number(event.target.value) || 1)) }))} /><em>体素</em></label>)}
                </div>
                <div className="boundary-limit">最大尺寸：1000 × 1000 × 1000 体素</div>
                <div className="boundary-actions"><button onClick={() => { setBoundaryDraft(currentSceneBounds); setBoundaryOpen(false) }}>取消</button><button className="primary" onClick={applySceneBounds}>应用</button></div>
              </div>}
            </div>
          </div>
          <VoxelViewport project={project} selectedId={selectedId} selectedPartIds={selectedEntityParts.map((part) => part.id)} checkedPartIds={checkedTreePartIds} lockedPartIds={lockedPartIds} editEntityId={editEntityId} tool={tool} activeMaterial={activeMaterial} materials={recentMaterials} dragAxis={dragAxis} placementAsset={pendingEntityImport?.asset ?? project.assets.find((asset) => asset.id === placementAssetId) ?? null} copyPreview={copyPreview} viewMode={viewMode} showGrid={showGrid} showBoundary={showBoundary} zoomLevel={zoomLevel} onZoomChange={(value) => setZoomLevel(clampZoomLevel(value))} onCameraApiChange={setCameraControlApi} onInteractionChange={(active) => { interactionActiveRef.current = active }} onRaycastVoxel={raycastSceneVoxel} onSelect={selectScenePart} onSelectMultiple={updateSceneCheckedSelection} onCancelPendingEntityOperation={() => setCopyPreview(null)} onSelectMaterial={useMaterial} onReplaceMaterial={replaceMaterialColor} onAddVoxel={addVoxel} onRemoveVoxel={removeVoxel} onEditInstanceVoxel={editInstanceVoxel} onPreviewScenePartsMove={previewScenePartsMove} onCommitScenePartsMove={commitScenePartsMove} onPreviewPlacement={previewPlacementAt} onPlaceAsset={placeAssetAt} onNotice={setNotice} onExitEditMode={exitEditMode} onEnterEditMode={enterEditMode} onRename={renameSceneEntity} onBatchOperation={operateOnSceneSelection}>
            <SceneTreePanel items={sceneTreeItems} selectedId={selectedId} selectedPartIds={selectedEntityParts.map((part) => part.id)} checkedPartIds={checkedTreePartIds} lockedPartIds={lockedPartIds} expandedAssemblies={expandedAssemblies} contextMenu={treeContextMenu} onToggleExpanded={(assemblyId) => setExpandedAssemblies((current) => ({ ...current, [assemblyId]: !(current[assemblyId] ?? true) }))} onSelect={selectTreeItem} onToggleChecked={toggleTreeChecked} onAssemble={assembleCheckedTreeParts} onDissolve={dissolveSceneAssembly} onEnterEdit={enterEditMode} onRename={renameSceneEntity} onDelete={deleteSceneTreeEntity} onToggleLock={toggleTreeLock} onContextMenu={(targetId, x, y, assemblyId) => { if (!editEntityId || targetId === editEntityId) setTreeContextMenu({ targetId, assemblyId, x, y }) }} />
          </VoxelViewport>
          <div className="viewport-footer">
            <div className="tool-group">
              <ToolButton icon={<SquareDashedMousePointer size={17} />} label="选择" description="实体移动" active={tool === 'select'} onClick={() => changeTool('select')} />
              <ToolButton icon={<Paintbrush size={17} />} label="体素笔刷" description="绘制实体" active={tool === 'brush'} onClick={() => changeTool('brush')} />
              <ToolButton icon={<Eraser size={17} />} label="擦除" description="擦除实体" active={tool === 'erase'} onClick={() => changeTool('erase')} />
            </div>
            <div className="footer-separator" />
            <button className={`footer-control ${showGrid ? 'active' : ''}`} onClick={() => { setShowGrid((value) => !value); setNotice(showGrid ? '已隐藏网格' : '已显示网格') }}><Grid3X3 size={16} /> 网格</button>
            <button className={`footer-control ${showBoundary ? 'active' : ''}`} onClick={() => { setShowBoundary((value) => !value); setNotice(showBoundary ? '已隐藏场景边框' : '已显示场景边框') }}><Square size={16} /> 边框</button>
            <div className="drag-axis-control" aria-label="拖动方向"><Move3d size={14} /><span>拖动</span><button className={dragAxis === 'horizontal' ? 'active' : ''} onClick={() => { setDragAxis('horizontal'); setNotice('拖动方向 · 水平（X/Y）') }}>水平 X/Y</button><button className={dragAxis === 'vertical' ? 'active' : ''} onClick={() => { setDragAxis('vertical'); setNotice('拖动方向 · 竖直（Z）') }}>竖直 Z</button></div>
            <div className="footer-status"><span className={`status-dot ${persistenceStatus === 'offline' ? 'offline' : ''}`} /> {notice}</div>
            {cameraControlApi && <ViewportCameraControls showJoystick={false} onRotate={cameraControlApi.rotate} onView={(view) => { cameraControlApi.view(view); setNotice(`已切换视角 · ${cameraViewLabel(view)}`) }} onReset={() => { cameraControlApi.reset(); setNotice('视角已回中 · 缩放已恢复 100%') }} />}
            <div className="zoom-control"><button className="zoom-step" title="缩小" onClick={() => { if (cameraControlApi) cameraControlApi.zoomOut(); else setZoomLevel((value) => clampZoomLevel(value - (value > 100 ? 50 : 10))); setNotice('已缩小视图') }}><Minus size={14} /></button><div className="zoom-track"><div className="zoom-value" style={{ width: `${((zoomLevel - MIN_ZOOM_LEVEL) / (MAX_ZOOM_LEVEL - MIN_ZOOM_LEVEL)) * 100}%` }} /></div><button className="zoom-step" title="放大" onClick={() => { if (cameraControlApi) cameraControlApi.zoomIn(); else setZoomLevel((value) => clampZoomLevel(value + (value >= 100 ? 50 : 10))); setNotice('已放大视图') }}><Plus size={14} /></button><span className="zoom-percent">{Math.round(zoomLevel)}%</span></div>
          </div>
        </section>
        <Inspector entityName={selectedDisplayName} source={selectedSource} selectedAsset={selectedAsset} selectedPart={selectedScenePart} selectedParts={selectedEntityParts} editEntityId={editEntityId} canEnterEditMode={canEnterSelectedEditMode} editTargetId={selectedId} position={selectedPosition} transformEditable={selectedTransformEditable} selectedColor={selectedColor} previewColor={selectedEntityParts.length === 1 ? selectedEntityParts[0]?.colorOverride : undefined} previewVoxelColors={previewVoxelColors} previewMaterialColors={Object.fromEntries(project.materials.map((material) => [material.id, material.color]))} copyPreview={copyPreview} onChangeTransform={changeSelectedTransform} onChangeColor={changeSelectedColor} onMirror={mirrorSelectedEntities} onRotate={rotateSelectedEntities} onExport={exportSelectedPart} onExportEntityFile={exportSelectedEntityFile} onDuplicate={startDuplicatePreview} onChangeCopyDirection={changeCopyPreviewDirection} onChangeCopyGap={changeCopyPreviewGap} onConfirmDuplicate={confirmDuplicate} onCancelDuplicate={() => setCopyPreview(null)} onDelete={deleteSelected} onResetTransform={resetSelectedTransform} onSaveAsAsset={saveSelectedEntityAsAsset} onEnterEditMode={enterEditMode} />
      </main>
      {libraryOpen && <SceneLibraryDialog library={library} busy={libraryBusy} selectedSceneId={selectedLibrarySceneId} selectedSceneProject={selectedLibrarySceneProject} onClose={() => { setLibraryOpen(false); setSceneLibraryContextMenu(null); setSelectedLibrarySceneId(null); setSelectedLibrarySceneProject(null) }} onImportScene={() => sceneLibraryImportInputRef.current?.click()} onLoadScene={loadStoredScene} onSelectScene={selectLibraryScene} onSaveSceneEntity={requestSaveAssetToLibrary} onAddSceneEntityToCurrentScene={addLibrarySceneEntityToCurrentScene} onDeleteSceneEntity={deleteLibrarySceneEntity} contextMenu={sceneLibraryContextMenu} onContextMenu={(sceneId, x, y) => setSceneLibraryContextMenu({ sceneId, x, y })} onCloseContextMenu={() => setSceneLibraryContextMenu(null)} onDuplicateScene={duplicateStoredScene} onDeleteScene={deleteStoredScene} />}
      {assetCategorySave && <AssetCategorySaveDialog asset={assetCategorySave.asset} assets={project.assets.filter((item) => item.isTemplate !== false)} onCancel={() => setAssetCategorySave(null)} onSave={saveAssetToLibrary} />}
      {modelImportDialog && <ModelImportDialog state={modelImportDialog} targetSizeMm={modelImportTargetSize} mode={modelImportMode} preserveParts={modelImportPreserveParts} onTargetSizeChange={setModelImportTargetSize} onModeChange={setModelImportMode} onPreservePartsChange={setModelImportPreserveParts} onStart={runModelImport} onConfirm={confirmModelImport} onCancel={() => setModelImportDialog(null)} />}
      {unsavedDialogOpen && <UnsavedChangesDialog onDecision={handleUnsavedDecision} />}
    </div>
  )
}

function ActionButton({ icon, label, onClick, strong = false }: { icon: React.ReactNode; label: string; onClick: () => void; strong?: boolean }) {
  return <button className={`action-button ${strong ? 'action-strong' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button>
}

function TreeLabel({ text }: { text: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [distance, setDistance] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current
      const content = contentRef.current
      if (!viewport || !content) return
      const nextDistance = Math.max(0, content.scrollWidth - viewport.clientWidth)
      setDistance(nextDistance)
      setOverflowing(nextDistance > 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (viewportRef.current) observer.observe(viewportRef.current)
    return () => observer.disconnect()
  }, [text])
  return <span ref={viewportRef} className={`scene-tree-label ${overflowing ? 'overflowing' : ''}`} title={text} style={{ '--tree-label-distance': `${distance}px` } as React.CSSProperties}><span ref={contentRef} className="scene-tree-label-text">{text}</span></span>
}

function SceneTreePanel({ items, selectedId, selectedPartIds, expandedAssemblies, checkedPartIds, lockedPartIds, contextMenu, onToggleExpanded, onSelect, onToggleChecked, onAssemble, onDissolve, onEnterEdit, onRename, onDelete, onToggleLock, onContextMenu }: { items: SceneTreeItem[]; selectedId: string; selectedPartIds: string[]; expandedAssemblies: Record<string, boolean>; checkedPartIds: string[]; lockedPartIds: Set<string>; contextMenu: TreeContextMenuState; onToggleExpanded: (assemblyId: string) => void; onSelect: (id: string, additive?: boolean) => void; onToggleChecked: (id: string) => void; onAssemble: () => void; onDissolve: (assemblyId: string) => void; onEnterEdit: (id: string) => void; onRename: (targetId: string, assemblyId?: string) => void; onDelete: (targetId: string, assemblyId?: string) => void; onToggleLock: (targetId: string, assemblyId?: string) => void; onContextMenu: (targetId: string, x: number, y: number, assemblyId?: string) => void }) {
  const scrollTree = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const list = event.currentTarget.closest('.scene-tree-list')
    if (list) list.scrollTop += event.deltaY
  }
  const leafPartIds = (item: SceneTreeItem): string[] => item.kind === 'part' ? (item.part ? [item.part.id] : []) : item.children?.flatMap(leafPartIds) ?? []
  const findItem = (list: SceneTreeItem[], id: string): SceneTreeItem | undefined => {
    for (const item of list) {
      if (item.id === id) return item
      const nested = item.children ? findItem(item.children, id) : undefined
      if (nested) return nested
    }
    return undefined
  }
  const renderItem = (item: SceneTreeItem, child = false): React.ReactNode => {
    if (item.kind === 'part' && item.part) {
      const part = item.part
      const selected = selectedPartIds.includes(part.id)
      const checkedAssemblyIds = new Set(checkedPartIds.filter((id) => id.startsWith('assembly:')).map((id) => id.slice('assembly:'.length)))
      const partAssemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
      const checked = checkedPartIds.includes(part.id) || partAssemblyIds.some((assemblyId) => checkedAssemblyIds.has(assemblyId))
      const locked = lockedPartIds.has(part.id)
      return <div className={`scene-tree-row ${child ? 'child' : ''} ${selected ? 'selected' : ''}`} key={part.id} onWheel={scrollTree} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(part.id, event.clientX, event.clientY) }}>
        <input type="checkbox" aria-label={`选择子实体 ${part.displayLabel ?? part.label ?? part.partId}`} checked={checked} onChange={() => onToggleChecked(part.id)} onClick={(event) => event.stopPropagation()} />
        <button className={`scene-tree-select ${checked ? 'checked' : ''}`} onClick={(event) => onSelect(part.id, event.metaKey || event.shiftKey)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(part.id, event.clientX, event.clientY) }} title="在右侧预览中查看实体"><span className="tree-node-mark" /><TreeLabel text={part.displayLabel ?? part.label ?? part.partId} />{locked && <Lock size={11} className="tree-lock" />}</button>
      </div>
    }
    const leaves = leafPartIds(item)
    const checked = checkedPartIds.includes(item.id) || (leaves.length > 0 && leaves.every((id) => checkedPartIds.includes(id)))
    const locked = leaves.length > 0 && leaves.every((id) => lockedPartIds.has(id))
    return <div className="scene-tree-assembly" key={item.id}>
      <div className={`scene-tree-row assembly-row ${child ? 'child' : ''} ${selectedId === item.id ? 'selected' : ''}`} onWheel={scrollTree} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(item.id, event.clientX, event.clientY, item.assemblyId) }}>
        <input type="checkbox" aria-label={`选择装配体 ${item.label}`} checked={checked} onChange={() => onToggleChecked(item.id)} onClick={(event) => event.stopPropagation()} />
        <button className="tree-expander" aria-label={expandedAssemblies[item.assemblyId!] === false ? '展开装配体' : '折叠装配体'} onClick={() => onToggleExpanded(item.assemblyId!)}>{expandedAssemblies[item.assemblyId!] === false ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
        <button className={`scene-tree-select ${checked ? 'checked' : ''}`} onClick={(event) => onSelect(item.id, event.metaKey || event.shiftKey)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(item.id, event.clientX, event.clientY, item.assemblyId) }}><Layers3 size={13} className="assembly-mark" /><TreeLabel text={item.label} />{locked && <Lock size={11} className="tree-lock" />}</button>
      </div>
      {expandedAssemblies[item.assemblyId!] !== false && <div className="scene-tree-children">{item.children?.map((childItem) => renderItem(childItem, true))}</div>}
    </div>
  }
  const contextItem = contextMenu ? findItem(items, contextMenu.targetId) : undefined
  const contextPartIds = contextItem ? leafPartIds(contextItem) : contextMenu ? [contextMenu.targetId] : []
  const operatesOnChecked = checkedPartIds.length >= 1 && (checkedPartIds.includes(contextMenu?.targetId ?? '') || contextPartIds.some((id) => checkedPartIds.includes(id)))
  const operationPartIds = operatesOnChecked ? checkedPartIds : contextPartIds
  const operationLocked = operationPartIds.length > 0 && operationPartIds.every((id) => lockedPartIds.has(id))
  const canEnterEdit = checkedPartIds.length < 2
  return <aside className="scene-tree-panel">
    <div className="scene-tree-list">
      {items.length === 0 && <div className="scene-tree-empty">场景中暂无用户实体</div>}
      {items.map((item) => renderItem(item))}
    </div>
    {contextMenu && <div className="scene-tree-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}>{checkedPartIds.length >= 2 && <button onClick={onAssemble}>组装已选实体</button>}<button onClick={() => onRename(contextMenu.targetId, contextMenu.assemblyId)}>重命名</button><button onClick={() => onToggleLock(contextMenu.targetId, contextMenu.assemblyId)}>{operationLocked ? '取消固定所选实体' : '固定所选实体'}</button>{canEnterEdit && <button onClick={() => onEnterEdit(contextMenu.targetId)}>进入编辑修改模式</button>}{contextMenu.assemblyId && <button onClick={() => onDissolve(contextMenu.assemblyId!)}>原位解散装配体</button>}<button className="danger" onClick={() => onDelete(contextMenu.targetId, contextMenu.assemblyId)}>删除所选实体</button></div>}
  </aside>
}

function AssetSidebar({ assets, categoryPaths, query, setQuery, selectedAssetIds, onToggleAssetSelection, onClearAssetSelection, onExportAssets, collapsed, onToggleCollapsed, onNotice, onBeginPlacement, onEndPlacement, contextMenu, onContextMenu, categoryContextMenu, onCategoryContextMenu, onCreateCategory, onDeleteCategory, onRenameAsset, onDuplicateAsset, onDeleteAsset, onChangeAssetColor }: { assets: VoxelAsset[]; categoryPaths: string[][]; query: string; setQuery: (value: string) => void; selectedAssetIds: string[]; onToggleAssetSelection: (assetId: string) => void; onClearAssetSelection: () => void; onExportAssets: (assetIds: string[]) => void; collapsed: boolean; onToggleCollapsed: () => void; onNotice: (value: string) => void; onBeginPlacement: (asset: VoxelAsset) => void; onEndPlacement: () => void; contextMenu: AssetContextMenuState; onContextMenu: (assetId: string, x: number, y: number) => void; categoryContextMenu: AssetCategoryContextMenuState; onCategoryContextMenu: (path: string[], x: number, y: number) => void; onCreateCategory: (parentPath: string[] | null) => void; onDeleteCategory: (path: string[]) => void; onRenameAsset: (assetId: string) => void; onDuplicateAsset: (assetId: string) => void; onDeleteAsset: (assetId: string) => void; onChangeAssetColor: (assetId: string, color: string) => void }) {
  const categoryTree = assetCategoryTreeFromAssetsAndPaths(assets, categoryPaths)
  const [activeNav, setActiveNav] = useState('组件')
  const [expandedCategoryKeys, setExpandedCategoryKeys] = useState<Record<string, boolean>>({})
  const draggedAssetRef = useRef(false)
  const navItems = [
    { label: '组件', icon: <Box size={17} /> },
    { label: '生成', icon: <WandSparkles size={17} /> },
    { label: '角色', icon: <CircleUserRound size={17} /> },
    { label: '图层', icon: <Layers3 size={17} /> },
    { label: '网格', icon: <Grid3X3 size={17} /> },
  ]
  const renderAssetCard = (asset: VoxelAsset) => <div className={`asset-card ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`} key={asset.id} role="button" tabIndex={0} onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); draggedAssetRef.current = true; onBeginPlacement(asset) }} onPointerUp={(event) => { if (event.button !== 0) return; event.preventDefault(); draggedAssetRef.current = false; onEndPlacement() }} onPointerCancel={() => { draggedAssetRef.current = false; onEndPlacement() }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(asset.id, event.clientX, event.clientY) }} onClick={() => { if (draggedAssetRef.current) { draggedAssetRef.current = false; return } onNotice('请按住组件拖动到三维场地后放置') }} title="按住拖动到场地放置">
    <label className="asset-select-box" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedAssetIds.includes(asset.id)} onChange={() => onToggleAssetSelection(asset.id)} aria-label={`选择${asset.name}`} /></label>
    <VoxelThumbnail asset={asset} />
    <span>{asset.name.replace('·主屋', '')}</span>
  </div>
  const renderCategoryNode = (node: AssetCategoryNode, depth = 0): React.ReactNode => {
    const expanded = expandedCategoryKeys[node.key] ?? true
    return <div className="asset-category-node" key={node.key}>
      <button className="asset-category-row" style={{ paddingLeft: `${8 + depth * 13}px` }} onClick={() => setExpandedCategoryKeys((current) => ({ ...current, [node.key]: !expanded }))} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onCategoryContextMenu(node.path, event.clientX, event.clientY) }} title="展开或收起类别">
        <ChevronDown size={13} className={expanded ? '' : 'category-collapsed-icon'} /><span className="asset-category-name">{node.name}</span><span className="asset-category-count">{node.assets.length + node.children.reduce((count, child) => count + child.assets.length, 0)}</span>
      </button>
      {expanded && <div className="asset-category-children">
        {node.children.map((child) => renderCategoryNode(child, depth + 1))}
        {node.assets.length > 0 && <div className="asset-category-assets"><div className="asset-grid">{node.assets.map(renderAssetCard)}</div></div>}
      </div>}
    </div>
  }
  return <aside className={`asset-sidebar ${collapsed ? 'collapsed' : ''}`}>
    <div className="panel-title-row"><div><h2>资产库</h2><p>类别树 · 模板实体</p></div><button className="panel-collapse-button" aria-label={collapsed ? '展开资产库' : '收起资产库'} title={collapsed ? '展开资产库' : '收起资产库'} onClick={onToggleCollapsed}>{collapsed ? <ChevronRight size={18} /> : <ChevronRight size={18} className="collapse-left" />}</button></div>
    {collapsed ? <button className="collapsed-asset-toggle" aria-label="展开资产库" onClick={onToggleCollapsed}><Box size={17} /></button> : <>
    <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组件" /><SlidersHorizontal size={14} /></label>
    {selectedAssetIds.length > 0 && <div className="asset-selection-actions"><span>已选 {selectedAssetIds.length} 个模板实体</span><button onClick={() => onExportAssets(selectedAssetIds)} title="导出选中模板实体"><Download size={12} /></button><button onClick={onClearAssetSelection} title="清除选择"><X size={12} /></button></div>}
    <div className="asset-scroll">
      {categoryTree.length ? categoryTree.map((node) => renderCategoryNode(node)) : <div className="asset-category-empty">资产库暂无类别</div>}
    </div>
    <div className="sidebar-nav">{navItems.map(({ label, icon }) => <button key={label} className={activeNav === label ? 'active' : ''} onClick={() => { setActiveNav(label); onNotice(label === '组件' ? '模板实体库已打开' : `${label}功能尚未接入工程数据`) }}>{icon}<span>{label}</span></button>)}</div></>}
    {categoryContextMenu && <div className="asset-context-menu" style={{ left: categoryContextMenu.x, top: categoryContextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><button onClick={() => onCreateCategory(categoryContextMenu.path)}>新建子类别</button><button onClick={() => onCreateCategory(null)}>新建根类别</button><button className="danger" onClick={() => onDeleteCategory(categoryContextMenu.path)}>删除类别</button></div>}
    {contextMenu && (() => {
      const asset = assets.find((item) => item.id === contextMenu.assetId)
      if (!asset) return null
      const color = /^#[0-9a-f]{6}$/i.test(asset.templateColor ?? asset.color) ? (asset.templateColor ?? asset.color) : '#6c827d'
      return <div className="asset-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}>
        <button onClick={() => onRenameAsset(asset.id)}>重命名</button>
        <button onClick={() => onDuplicateAsset(asset.id)}>创建副本</button>
        <button onClick={() => onExportAssets([asset.id])}>导出实体文件</button>
        <label className="asset-context-color"><span>修改颜色</span><input type="color" aria-label="选择资产颜色" value={color} onChange={(event) => onChangeAssetColor(asset.id, event.target.value)} /></label>
        <button className="danger" onClick={() => onDeleteAsset(asset.id)}>删除资产</button>
      </div>
    })()}
  </aside>
}

function AssetCategorySaveDialog({ asset, assets, onCancel, onSave }: { asset: VoxelAsset; assets: VoxelAsset[]; onCancel: () => void; onSave: (name: string, categoryPath: string[]) => void }) {
  const existingPaths = collectAssetCategoryPaths(assets)
  const categoryPaths = existingPaths.length ? existingPaths : [[DEFAULT_ASSET_CATEGORY]]
  const initialPath = categoryPaths.find((path) => assetCategoryKey(path) === assetCategoryKey(normalizeAssetCategoryPath(asset.categoryPath))) ?? categoryPaths[0]
  const [selectedPath, setSelectedPath] = useState(initialPath)
  const [draftName, setDraftName] = useState(asset.name)
  const [draftCategory, setDraftCategory] = useState('')
  const [customPaths, setCustomPaths] = useState<string[][]>([])
  const allPaths = [...categoryPaths, ...customPaths.filter((path) => !categoryPaths.some((candidate) => assetCategoryKey(candidate) === assetCategoryKey(path)))]
  const roots = assetCategoryTreeFromPaths(allPaths)
  const renderCategory = (node: AssetCategoryNode, depth = 0): React.ReactNode => <div className="asset-category-picker-node" key={node.key}>
    <button className={`asset-category-picker-row ${assetCategoryKey(selectedPath) === node.key ? 'active' : ''}`} style={{ paddingLeft: `${12 + depth * 16}px` }} onClick={() => setSelectedPath(node.path)}><ChevronRight size={12} /><span>{node.name}</span></button>
    {node.children.map((child) => renderCategory(child, depth + 1))}
  </div>
  const addCategory = (asChild: boolean) => {
    const segments = draftCategory.split(/[\\/／>＞]/).map((value) => value.trim()).filter(Boolean)
    if (!segments.length) return
    const path = [...(asChild ? selectedPath : []), ...segments]
    setCustomPaths((current) => [...current, ...path.reduce<string[][]>((result, _name, index) => { result.push(path.slice(0, index + 1)); return result }, [])])
    setSelectedPath(path)
    setDraftCategory('')
  }
  return <div className="modal-backdrop asset-category-dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onCancel()}>
    <section className="asset-category-dialog" role="dialog" aria-modal="true" aria-label="选择资产类别">
      <div className="asset-category-dialog-heading"><div><h2>保存到资产库</h2><p>{asset.name}</p></div><button className="icon-button" aria-label="取消保存资产" onClick={onCancel}><X size={17} /></button></div>
      <div className="asset-category-dialog-body"><div className="field-label">实体名称</div><input className="asset-category-name-input" value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="请输入实体名称" /><div className="field-label">选择类别</div><div className="asset-category-picker">{roots.map((node) => renderCategory(node))}</div><div className="asset-category-add"><input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} placeholder={`在“${selectedPath.join(' / ')}”下新建子类别`} onKeyDown={(event) => { if (event.key === 'Enter') addCategory(true) }} /><button onClick={() => addCategory(true)}>新建子类别</button><button onClick={() => addCategory(false)}>新建根类别</button></div><p className="asset-category-hint">资产会保存到：{selectedPath.join(' / ')}</p></div>
      <div className="asset-category-dialog-actions"><button onClick={onCancel}>取消</button><button className="primary" onClick={() => onSave(draftName.trim() || asset.name, selectedPath)}>保存</button></div>
    </section>
  </div>
}

function ModelImportDialog({ state, targetSizeMm, mode, preserveParts, onTargetSizeChange, onModeChange, onPreservePartsChange, onStart, onConfirm, onCancel }: { state: ModelImportDialogState; targetSizeMm: number; mode: VoxelizeMode; preserveParts: boolean; onTargetSizeChange: (value: number) => void; onModeChange: (value: VoxelizeMode) => void; onPreservePartsChange: (value: boolean) => void; onStart: () => void; onConfirm: () => void; onCancel: () => void }) {
  const result = state.result
  const diagnostics = result?.diagnostics
  const sizeLabel = result ? `${result.asset.width} × ${result.asset.height} × ${result.asset.depth} mm` : '尚未生成'
  return <div className="modal-backdrop model-import-dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !state.busy && onCancel()}>
    <section className="model-import-dialog" role="dialog" aria-modal="true" aria-label="模型转体素">
      <div className="model-import-heading"><div><h2>模型转体素</h2><p>{state.file.name} · 统一 1 mm 体素</p></div><button className="icon-button" aria-label="关闭模型转体素" disabled={state.busy} onClick={onCancel}><X size={17} /></button></div>
      <div className="model-import-body">
        <div className="model-import-settings">
          <label className="model-import-field"><span>目标最大尺寸</span><div><input type="number" min={1} max={256} step={1} value={targetSizeMm} disabled={state.busy} onChange={(event) => onTargetSizeChange(Math.max(1, Math.min(256, Number(event.target.value) || 1)))} /><em>mm</em></div></label>
          <div className="model-import-field"><span>体素化方式</span><div className="model-import-mode"><button className={mode === 'solid' ? 'active' : ''} disabled={state.busy} onClick={() => onModeChange('solid')}>实体填充</button><button className={mode === 'surface' ? 'active' : ''} disabled={state.busy} onClick={() => onModeChange('surface')}>仅表面</button></div></div>
          <label className="model-import-check"><input type="checkbox" checked={preserveParts} disabled={state.busy} onChange={(event) => onPreservePartsChange(event.target.checked)} /><span>按模型部件保留可编辑分件</span></label>
          <p className="model-import-hint">实体填充适合封闭模型；开放模型会提示可能需要手工修补。体素化后仍可在场景中继续绘制、擦除和拆分。</p>
        </div>
        <div className="model-import-preview"><div className="model-import-preview-title"><span>体素预览</span><span>{sizeLabel}</span></div>{result ? <VoxelMiniPreview voxels={result.asset.voxels} asset={result.asset} /> : <div className="model-import-empty">设置参数后点击“开始体素化”</div>}</div>
        <div className="model-import-status"><div className="model-import-progress"><span style={{ width: `${Math.round(state.progress * 100)}%` }} /></div><span>{state.progressLabel}{state.busy ? ` · ${Math.round(state.progress * 100)}%` : ''}</span></div>
        {state.error && <div className="model-import-error">{state.error}</div>}
        {diagnostics && <div className="model-import-diagnostics"><span>{diagnostics.triangleCount} 个三角面</span><span>{diagnostics.partCount} 个部件</span><span>{diagnostics.closedMesh ? '封闭网格' : '开放网格'}</span>{diagnostics.warnings.map((warning) => <p key={warning}>提示：{warning}</p>)}</div>}
      </div>
      <div className="model-import-actions"><button onClick={onCancel} disabled={state.busy}>取消</button><button onClick={onStart} disabled={state.busy}>{state.busy ? '体素化中…' : result ? '重新体素化' : '开始体素化'}</button><button className="primary" onClick={onConfirm} disabled={!result || state.busy}>确认并放置</button></div>
    </section>
  </div>
}

function VoxelThumbnail({ asset }: { asset: VoxelAsset }) {
  return <div className="thumbnail-scene" aria-label={`${asset.name} 3D 预览`}><VoxelMiniPreview voxels={asset.voxels} asset={asset} /></div>
}

function SceneLibraryDialog({ library, busy, selectedSceneId, selectedSceneProject, onClose, onImportScene, onLoadScene, onSelectScene, onSaveSceneEntity, onAddSceneEntityToCurrentScene, onDeleteSceneEntity, contextMenu, onContextMenu, onCloseContextMenu, onDuplicateScene, onDeleteScene }: { library: LibraryResponse; busy: boolean; selectedSceneId: string | null; selectedSceneProject: ProjectState | null; onClose: () => void; onImportScene: () => void; onLoadScene: (id: string, name: string) => void; onSelectScene: (id: string, name: string, x: number, y: number) => void; onSaveSceneEntity: (asset: VoxelAsset) => void; onAddSceneEntityToCurrentScene: (asset: VoxelAsset) => void; onDeleteSceneEntity: (sceneId: string, assetId: string, name: string) => void | Promise<void>; contextMenu: SceneLibraryContextMenuState; onContextMenu: (sceneId: string, x: number, y: number) => void; onCloseContextMenu: () => void; onDuplicateScene: (sceneId: string, name: string) => void; onDeleteScene: (sceneId: string, name: string) => void }) {
  const [entityContextMenu, setEntityContextMenu] = useState<SceneEntityContextMenuState>(null)
  const menuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contextScene = contextMenu ? library.scenes.find((scene) => scene.id === contextMenu.sceneId) : undefined
  const selectedAssetIds = new Set(selectedSceneProject?.instances.map((instance) => instance.assetId) ?? [])
  const selectedSceneEntities = selectedSceneProject?.assets.filter((asset) => selectedAssetIds.has(asset.id)) ?? []
  const cancelMenuClose = () => {
    if (menuCloseTimerRef.current) {
      clearTimeout(menuCloseTimerRef.current)
      menuCloseTimerRef.current = null
    }
  }
  const scheduleMenuClose = () => {
    cancelMenuClose()
    menuCloseTimerRef.current = setTimeout(() => {
      onCloseContextMenu()
      setEntityContextMenu(null)
      menuCloseTimerRef.current = null
    }, 180)
  }
  const openSceneMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    cancelMenuClose()
    setEntityContextMenu(null)
    const scene = event.currentTarget.dataset.sceneId ? library.scenes.find((item) => item.id === event.currentTarget.dataset.sceneId) : undefined
    if (scene) onSelectScene(scene.id, scene.name, event.clientX + 8, event.clientY + 8)
  }
  const openEntityMenu = (event: React.MouseEvent<HTMLButtonElement>, assetId: string) => {
    event.preventDefault()
    event.stopPropagation()
    cancelMenuClose()
    onCloseContextMenu()
    setEntityContextMenu({ assetId, x: event.clientX + 8, y: event.clientY + 8 })
  }
  const closeMenus = () => {
    cancelMenuClose()
    onCloseContextMenu()
    setEntityContextMenu(null)
  }
  useEffect(() => () => cancelMenuClose(), [])
  return <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="library-dialog" role="dialog" aria-modal="true" aria-label="场景库" onPointerDown={(event) => { const target = event.target as HTMLElement; if (!target.closest('button, input, .scene-library-context-menu')) closeMenus() }}>
      <div className="library-dialog-heading"><div><h2>场景库</h2><p>场景文件与场景实体由当前工程自动管理</p></div><button className="icon-button" aria-label="关闭场景库" onClick={onClose}><X size={17} /></button></div>
      <div className="library-dialog-toolbar"><span>{library.scenes.length} 个场景 · {selectedSceneId ? `${selectedSceneEntities.length} 个实体` : '未选择场景'}</span><div className="library-toolbar-actions"><button className="tiny-button" onClick={onImportScene} disabled={busy}><FolderOpen size={13} /> 导入场景文件</button></div></div>
      <div className="library-columns">
        <div className="library-column"><div className="library-column-title">场景</div>{library.scenes.length ? library.scenes.map((scene) => <button className={`library-row ${selectedSceneId === scene.id ? 'selected' : ''}`} data-scene-id={scene.id} key={scene.id} onPointerEnter={openSceneMenu} onPointerLeave={scheduleMenuClose} onClick={openSceneMenu} onContextMenu={openSceneMenu}><div><strong>{scene.name}</strong><span>{scene.instanceCount} 个实例 · {scene.customVoxelCount} 个手动体素 · {scene.assetCount} 个依赖实体</span></div><ChevronRight size={15} /></button>) : <div className="empty-panel">尚无场景</div>}</div>
        <div className="library-column"><div className="library-column-title">实体</div>{!selectedSceneId ? <div className="empty-panel">请选择场景查看实体</div> : selectedSceneEntities.length ? selectedSceneEntities.map((asset) => <button className="library-row" key={asset.id} onClick={(event) => openEntityMenu(event, asset.id)} onContextMenu={(event) => openEntityMenu(event, asset.id)}><div><strong>{asset.name}</strong><span>{asset.style} · {asset.voxels.length} 个体素</span></div><ChevronRight size={15} /></button>) : <div className="empty-panel">当前场景没有可显示的实体</div>}</div>
      </div>
      {contextScene && contextMenu && <div className="scene-library-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerEnter={cancelMenuClose} onPointerLeave={scheduleMenuClose} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><button onClick={() => { closeMenus(); onLoadScene(contextScene.id, contextScene.name) }}>打开场景</button><button onClick={() => { closeMenus(); onDuplicateScene(contextScene.id, contextScene.name) }}>创建副本</button><button className="danger" onClick={() => { closeMenus(); onDeleteScene(contextScene.id, contextScene.name) }}>删除场景</button></div>}
      {entityContextMenu && selectedSceneId && (() => {
        const entity = selectedSceneEntities.find((asset) => asset.id === entityContextMenu.assetId)
        if (!entity) return null
        return <div className="scene-library-context-menu" style={{ left: entityContextMenu.x, top: entityContextMenu.y }} onPointerEnter={cancelMenuClose} onPointerLeave={scheduleMenuClose} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><button onClick={() => { closeMenus(); onSaveSceneEntity(entity) }}>保存到当前资产库</button><button onClick={() => { closeMenus(); onAddSceneEntityToCurrentScene(entity) }}>添加到当前场景</button><button className="danger" onClick={() => { closeMenus(); onDeleteSceneEntity(selectedSceneId, entity.id, entity.name) }}>删除该实体</button></div>
      })()}
      {busy && <div className="library-loading">正在访问场景库…</div>}
    </section>
  </div>
}

function UnsavedChangesDialog({ onDecision }: { onDecision: (decision: UnsavedDecision) => void | Promise<void> }) {
  return <div className="modal-backdrop unsaved-modal-backdrop"><section className="unsaved-dialog" role="dialog" aria-modal="true" aria-label="保存当前场景"><h2>当前场景有未保存改动</h2><p>继续操作前，是否先保存当前场景？</p><div className="unsaved-dialog-actions"><button onClick={() => onDecision('cancel')}>取消</button><button onClick={() => onDecision('discard')}>否</button><button className="primary" onClick={() => onDecision('save')}>是</button></div></section></div>
}

function ToolButton({ icon, label, description, active, onClick }: { icon: React.ReactNode; label: string; description: string; active: boolean; onClick: () => void }) {
  return <button className={`tool-button ${active ? 'active' : ''}`} data-tooltip={description} aria-label={label} onClick={onClick} title={description}>{icon}</button>
}

function Inspector({ entityName, source, selectedAsset, selectedPart, selectedParts, editEntityId, canEnterEditMode, editTargetId, position, transformEditable, selectedColor, previewColor, previewVoxelColors, previewMaterialColors, copyPreview, onChangeTransform, onChangeColor, onMirror, onRotate, onExport, onExportEntityFile, onDuplicate, onChangeCopyDirection, onChangeCopyGap, onConfirmDuplicate, onCancelDuplicate, onDelete, onResetTransform, onSaveAsAsset, onEnterEditMode }: { entityName: string; source: string; selectedAsset?: VoxelAsset; selectedPart?: SceneEntityPart; selectedParts: SceneEntityPart[]; editEntityId: string | null; canEnterEditMode: boolean; editTargetId: string; position: number[]; transformEditable: boolean; selectedColor: string; previewColor?: string; previewVoxelColors: Record<string, string>; previewMaterialColors: Record<string, string>; copyPreview: CopyPreviewState | null; onChangeTransform: (axis: number, value: number) => void; onChangeColor: (color: string) => void; onMirror: (axis: 'x' | 'y' | 'z') => void; onRotate: (axis: 'x' | 'y' | 'z', degrees: 90 | 180 | 270) => void; onExport: () => void; onExportEntityFile: () => void; onDuplicate: (count: number) => void; onChangeCopyDirection: (axis: CopyDirectionAxis, sign: 1 | -1) => void; onChangeCopyGap: (gap: number) => void; onConfirmDuplicate: () => void; onCancelDuplicate: () => void; onDelete: () => void; onResetTransform: () => void; onSaveAsAsset: () => void; onEnterEditMode: (entityId: string) => void }) {
  const [copyCount, setCopyCount] = useState(1)
  const [mirrorAxis, setMirrorAxis] = useState<'x' | 'y' | 'z'>('x')
  const [rotateAxis, setRotateAxis] = useState<'x' | 'y' | 'z'>('z')
  const [rotateDegrees, setRotateDegrees] = useState<90 | 180 | 270>(90)
  const selectedPartsKey = selectedParts.map((part) => part.id).join('|')
  useEffect(() => {
    // Axis/angle choices are operation-local. Selecting another entity or
    // clearing the scene selection must leave no pending transform choice
    // attached to the next entity.
    setMirrorAxis('x')
    setRotateAxis('z')
    setRotateDegrees(90)
  }, [selectedPartsKey])
  const previewVoxels = selectedParts.flatMap((part) => part.voxels)
  return <aside className="inspector">
    <div className="inspector-heading"><div><h2>属性</h2><p>选中对象的编辑参数</p></div><ChevronRight size={18} className="muted-icon" /></div>
    <div className="inspector-section entity-summary-section">
      <div className="field-label">选中实体</div><div className="select-field entity-name-field">{entityName}</div>
      <div className="field-label">来源</div><div className="input-field muted-field">{source}</div>
      <div className="entity-preview"><VoxelMiniPreview voxels={previewVoxels} asset={selectedAsset} colorOverride={previewColor} voxelColors={previewVoxelColors} materialColors={previewMaterialColors} /></div>
      {canEnterEditMode && <button className="enter-edit-button" onClick={() => onEnterEditMode(editTargetId)}>进入编辑模式</button>}
    </div>
    {selectedParts.length > 0 && <div className="inspector-section">
      <div className="section-heading"><span>变换</span><button className="tiny-icon" onClick={onResetTransform} title="重置变换"><RotateCcw size={13} /></button></div>
      <TransformRow icon={<Move3d size={14} />} label="位置" values={position} editable={transformEditable} onChange={onChangeTransform} />
      {selectedParts.length > 1 && !transformEditable && <div className="transform-hint">多选实体时不可直接编辑单一位置</div>}
    </div>}
    <div className="inspector-section color-section">
      <div className="section-heading"><span>颜色</span><span className="instance-label">实体覆盖色</span></div>
      <ColorEditor color={selectedColor} disabled={!selectedParts.length} onChange={onChangeColor} />
    </div>
    <div className="inspector-section entity-actions-section">
      <div className="section-heading"><span>实体操作</span><span className="instance-label">{selectedParts.length} 个实体</span></div>
      <div className="entity-actions">
        <div className="entity-transform-operation copy-entity-row"><span className="copy-entity-label">复制实体</span><div className="copy-count-choice"><button disabled={Boolean(copyPreview)} onClick={() => setCopyCount((value) => Math.max(1, value - 1))} title="减少复制数量">−</button><span className="copy-entity-count">{copyPreview?.count ?? copyCount}</span><button disabled={Boolean(copyPreview)} onClick={() => setCopyCount((value) => Math.min(99, value + 1))} title="增加复制数量">＋</button></div>{copyPreview ? <button className="operation-confirm copy-confirm" onClick={onCancelDuplicate}>取消</button> : <button className="operation-confirm copy-confirm" onClick={() => onDuplicate(copyCount)}>预览</button>}</div>
        {copyPreview && <div className="copy-preview-panel"><div className="copy-preview-title">复制方向</div><div className="copy-preview-axis">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={copyPreview.axis === axis ? 'active' : ''} onClick={() => onChangeCopyDirection(axis, copyPreview.sign)}>{axis.toUpperCase()}</button>)}<button className={copyPreview.sign === 1 ? 'active' : ''} onClick={() => onChangeCopyDirection(copyPreview.axis, 1)}>正向 +</button><button className={copyPreview.sign === -1 ? 'active' : ''} onClick={() => onChangeCopyDirection(copyPreview.axis, -1)}>负向 −</button></div><div className="copy-preview-gap"><span>实体间隔</span><button disabled={copyPreview.gap <= 0} onClick={() => onChangeCopyGap(copyPreview.gap - 1)}>−</button><strong>{copyPreview.gap}</strong><button disabled={copyPreview.gap >= 99} onClick={() => onChangeCopyGap(copyPreview.gap + 1)}>＋</button><em>体素</em></div><div className={`copy-preview-status ${copyPreview.valid ? 'valid' : 'invalid'}`}>{copyPreview.valid ? `预览有效 · 将生成 ${copyPreview.count} 个复制实体` : copyPreview.invalidReason === 'collision' ? '预览与已有实体重叠，无法生成' : '预览超出场景边界，无法生成'}</div><button className="operation-confirm copy-preview-generate" onClick={onConfirmDuplicate}>生成复制实体</button></div>}
        <div className="entity-transform-operation"><span>镜像实体</span><div className="axis-choice">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={mirrorAxis === axis ? 'active' : ''} onClick={() => setMirrorAxis(axis)}>{axis.toUpperCase()}</button>)}</div><button className="operation-confirm" onClick={() => onMirror(mirrorAxis)}>执行</button></div>
        <div className="entity-transform-operation"><span>旋转实体</span><div className="axis-choice">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={rotateAxis === axis ? 'active' : ''} onClick={() => setRotateAxis(axis)}>{axis.toUpperCase()}</button>)}</div><div className="degree-choice">{([90, 180, 270] as const).map((degrees) => <button key={degrees} className={rotateDegrees === degrees ? 'active' : ''} onClick={() => setRotateDegrees(degrees)}>{degrees}°</button>)}</div><button className="operation-confirm" onClick={() => onRotate(rotateAxis, rotateDegrees)}>执行</button></div>
        <button onClick={onSaveAsAsset}><Save size={14} /> 保存为模板实体</button>
        <button className="danger-action" onClick={onDelete}><Trash2 size={14} /> 删除实体</button>
        <button onClick={onExportEntityFile}><Download size={14} /> 导出普通实体文件</button>
        <button className="export-action" onClick={onExport}><Download size={14} /> 导出选中部件 STL</button>
      </div>
    </div>
  </aside>
}

function VoxelMiniPreview({ voxels, asset, colorOverride, voxelColors = {}, materialColors = {} }: { voxels: Voxel[]; asset?: VoxelAsset; colorOverride?: string; voxelColors?: Record<string, string>; materialColors?: Record<string, string> }) {
  if (!voxels.length) return <div className="mini-preview-empty">暂无预览</div>
  const minX = Math.min(...voxels.map((voxel) => voxel.x))
  const minY = Math.min(...voxels.map((voxel) => voxel.y))
  const minZ = Math.min(...voxels.map((voxel) => voxel.z))
  const maxX = Math.max(...voxels.map((voxel) => voxel.x))
  const maxY = Math.max(...voxels.map((voxel) => voxel.y))
  const maxZ = Math.max(...voxels.map((voxel) => voxel.z))
  const spanX = Math.max(1, maxX - minX + 1)
  const spanY = Math.max(1, maxY - minY + 1)
  const spanZ = Math.max(1, maxZ - minZ + 1)
  const tileX = 8
  const tileZ = 4.5
  const tileY = 7
  const width = (spanX + spanZ) * tileX + 28
  const height = (spanX + spanZ) * tileZ + spanY * tileY + 28
  const originX = 14 + spanX * tileX
  const originY = 14 + spanY * tileY
  // Keep this fixed thumbnail projection in lockstep with the viewport's
  // default camera and toSceneWorld mapping: voxel X/Z form the ground plane,
  // while voxel Y is vertical.
  const project = (x: number, y: number, z: number): [number, number] => [originX + (z - x) * tileX, originY + (x + z) * tileZ - y * tileY]
  const materialColor = (voxel: Voxel & { sourceVoxel?: Voxel }) => {
    // voxelColors is keyed by scene-space coordinates. The thumbnail only
    // normalizes the drawing coordinates, so never offset this lookup by the
    // preview bounds. Offsetting it made multi-selection fall back to the
    // first selected asset's color for every primary voxel.
    const sourceVoxel = voxel.sourceVoxel ?? voxel
    const originalKey = `${sourceVoxel.x},${sourceVoxel.y},${sourceVoxel.z}`
    return voxelColors[originalKey] ?? colorOverride ?? asset?.templateColor ?? (voxel.materialId === 'primary' ? asset?.color ?? '#6c827d' : voxel.materialId === 'accent' ? asset?.accent ?? '#d2a354' : voxel.materialId.startsWith('#') ? voxel.materialId : materialColors[voxel.materialId] ?? MATERIALS.find((material) => material.id === voxel.materialId)?.color ?? '#6c827d')
  }
  const shadeColor = (color: string, amount: number) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return color
    const channels = [0, 2, 4].map((offset) => Math.max(0, Math.min(255, Math.round(parseInt(color.slice(offset + 1, offset + 3), 16) * amount))))
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  const orderedVoxels = voxels.slice(0, 600).map((voxel) => ({ ...voxel, sourceVoxel: voxel, x: voxel.x - minX, y: voxel.y - minY, z: voxel.z - minZ }))
    .sort((left, right) => (left.x + left.z + left.y * 0.02) - (right.x + right.z + right.y * 0.02))
  const voxelKeys = new Set(orderedVoxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
  const hasVoxel = (x: number, y: number, z: number) => voxelKeys.has(`${x},${y},${z}`)
  return <div className="mini-preview" aria-label="固定斜前方实体预览"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="组合式 3D 体素预览">
    {orderedVoxels.map((voxel, index) => {
      const p000 = project(voxel.x, voxel.y, voxel.z)
      const p100 = project(voxel.x + 1, voxel.y, voxel.z)
      const p010 = project(voxel.x, voxel.y + 1, voxel.z)
      const p110 = project(voxel.x + 1, voxel.y + 1, voxel.z)
      const p001 = project(voxel.x, voxel.y, voxel.z + 1)
      const p101 = project(voxel.x + 1, voxel.y, voxel.z + 1)
      const p011 = project(voxel.x, voxel.y + 1, voxel.z + 1)
      const p111 = project(voxel.x + 1, voxel.y + 1, voxel.z + 1)
      const color = materialColor(voxel)
      const points = (values: Array<[number, number]>) => values.map(([x, y]) => `${x},${y}`).join(' ')
      return <g key={`${voxel.x}-${voxel.y}-${voxel.z}-${index}`}>
        {!hasVoxel(voxel.x, voxel.y + 1, voxel.z) && <polygon points={points([p010, p110, p111, p011])} fill={color} />}
        {!hasVoxel(voxel.x + 1, voxel.y, voxel.z) && <polygon points={points([p100, p110, p111, p101])} fill={shadeColor(color, 0.72)} />}
        {!hasVoxel(voxel.x, voxel.y, voxel.z + 1) && <polygon points={points([p001, p101, p111, p011])} fill={shadeColor(color, 0.54)} />}
      </g>
    })}
  </svg></div>
}

function TransformRow({ icon, label, values, editable, onChange }: { icon: React.ReactNode; label: string; values: number[]; editable: boolean; onChange: (axis: number, value: number) => void }) {
  return <div className="transform-row"><div className="transform-label">{icon}{label}</div><div className="transform-values">{values.map((value, index) => <label key={index}><span>{['X', 'Y', 'Z'][index]}</span><input aria-label={`位置 ${['X', 'Y', 'Z'][index]}`} type="number" step="0.1" value={Number(value.toFixed(3))} disabled={!editable} onChange={(event) => onChange(index, Number(event.target.value))} /></label>)}</div></div>
}

function ColorEditor({ color, disabled, onChange }: { color: string; disabled: boolean; onChange: (color: string) => void }) {
  const colorInputRef = useRef<HTMLInputElement>(null)
  const [hue, setHue] = useState(() => hexToHsl(color).h)
  const [saturation, setSaturation] = useState(() => hexToHsl(color).s)
  const lightness = hexToHsl(color).l
  useEffect(() => {
    const next = hexToHsl(color)
    setHue(next.h)
    setSaturation(next.s)
  }, [color])
  const updateHsl = (nextHue: number, nextSaturation: number) => onChange(hslToHex(nextHue, nextSaturation, lightness))
  return <div className="color-editor">
    <button className="inspector-color-button" aria-label="打开颜色选择器" title="选择实体颜色" disabled={disabled} style={{ background: color }} onClick={() => colorInputRef.current?.click()}><Palette size={14} /></button>
    <input ref={colorInputRef} className="hidden-color-input" type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#6c827d'} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    <div className="color-sliders">
      <label><span>色调</span><input aria-label="色调" type="range" min="0" max="360" value={hue} disabled={disabled} onChange={(event) => { const next = Number(event.target.value); setHue(next); updateHsl(next, saturation) }} /></label>
      <label><span>饱和度</span><input aria-label="饱和度" type="range" min="0" max="100" value={saturation} disabled={disabled} onChange={(event) => { const next = Number(event.target.value); setSaturation(next); updateHsl(hue, next) }} /></label>
    </div>
  </div>
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
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

function hslToHex(h: number, saturation: number, lightness: number): string {
  const s = Math.max(0, Math.min(100, saturation)) / 100
  const l = Math.max(0, Math.min(1, lightness))
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const sector = h / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  const [r1, g1, b1] = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = l - chroma / 2
  return `#${[r1, g1, b1].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`
}

function ViewportPalette({ materials, activeMaterial, onSelectMaterial, onReplaceMaterial }: { materials: Material[]; activeMaterial: string; onSelectMaterial: (id: string) => void; onReplaceMaterial: (id: string, color: string) => void }) {
  const colorInputRef = useRef<HTMLInputElement>(null)
  const active = materials.find((material) => material.id === activeMaterial) ?? materials[0]
  const stopViewportPointer = (event: React.PointerEvent) => event.stopPropagation()
  return <div className="viewport-palette" aria-label="最近使用颜色">
    <div className="viewport-palette-swatches">
      {materials.map((material) => <button key={material.id} className={`viewport-swatch ${active?.id === material.id ? 'active' : ''}`} title={`${material.name} · 点击选择，选中后可替换`} aria-label={`选择颜色 ${material.name}`} style={{ background: material.color }} onPointerDown={stopViewportPointer} onPointerUp={stopViewportPointer} onClick={() => onSelectMaterial(material.id)} />)}
    </div>
    <input ref={colorInputRef} className="hidden-color-input" type="color" value={active?.color ?? '#ffffff'} onChange={(event) => active && onReplaceMaterial(active.id, event.target.value)} />
    <button className="viewport-color-picker" aria-label="打开 RGB 调色盘" title="替换当前颜色" onPointerDown={stopViewportPointer} onPointerUp={stopViewportPointer} onClick={() => colorInputRef.current?.click()}><Palette size={16} /></button>
  </div>
}

type VoxelFaceKey = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz'

const voxelFaceDirections: Array<{ key: VoxelFaceKey; neighbor: [number, number, number]; normal: [number, number, number] }> = [
  { key: 'px', neighbor: [1, 0, 0], normal: [1, 0, 0] },
  { key: 'nx', neighbor: [-1, 0, 0], normal: [-1, 0, 0] },
  { key: 'py', neighbor: [0, 1, 0], normal: [0, 1, 0] },
  { key: 'ny', neighbor: [0, -1, 0], normal: [0, -1, 0] },
  { key: 'pz', neighbor: [0, 0, 1], normal: [0, 0, 1] },
  { key: 'nz', neighbor: [0, 0, -1], normal: [0, 0, -1] },
]

function exposedVoxelFaces(voxel: Pick<Voxel, 'x' | 'y' | 'z'>, occupied: Set<string>): VoxelFaceKey[] {
  return voxelFaceDirections.filter(({ neighbor: [dx, dy, dz] }) => !occupied.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)).map(({ key }) => key)
}

function createVoxelOutlineGeometry() {
  const half = VOXEL_WORLD_SIZE / 2
  const corners: Array<[number, number, number]> = [
    [-half, -half, -half], [half, -half, -half], [half, half, -half], [-half, half, -half],
    [-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half],
  ]
  const edgePairs: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ]
  const positions: number[] = []
  edgePairs.forEach(([aIndex, bIndex]) => positions.push(...corners[aIndex], ...corners[bIndex]))
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

function addVoxelHighlight(mesh: THREE.Mesh) {
  const existing = mesh.userData.selectionGlowParts as THREE.Object3D[] | undefined
  if (existing) return existing
  let edgeGeometry: THREE.BufferGeometry
  if (mesh instanceof THREE.InstancedMesh) {
    const baseGeometry = createVoxelOutlineGeometry()
    const sourcePositions = baseGeometry.getAttribute('position')
    const positions = new Float32Array(sourcePositions.count * 3 * mesh.count)
    const matrix = new THREE.Matrix4()
    const point = new THREE.Vector3()
    for (let instanceIndex = 0; instanceIndex < mesh.count; instanceIndex += 1) {
      mesh.getMatrixAt(instanceIndex, matrix)
      for (let vertexIndex = 0; vertexIndex < sourcePositions.count; vertexIndex += 1) {
        point.fromBufferAttribute(sourcePositions, vertexIndex).applyMatrix4(matrix)
        const offset = (instanceIndex * sourcePositions.count + vertexIndex) * 3
        positions[offset] = point.x
        positions[offset + 1] = point.y
        positions[offset + 2] = point.z
      }
    }
    baseGeometry.dispose()
    edgeGeometry = new THREE.BufferGeometry()
    edgeGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  } else {
    edgeGeometry = createVoxelOutlineGeometry()
  }
  const glow = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.2, depthTest: true, depthWrite: false }))
  if (!(mesh instanceof THREE.InstancedMesh)) glow.scale.setScalar(1.055)
  glow.renderOrder = 20
  glow.userData.selectionGlow = true
  glow.raycast = () => {}
  const edge = new THREE.LineSegments(edgeGeometry.clone(), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: true, depthWrite: false }))
  if (!(mesh instanceof THREE.InstancedMesh)) edge.scale.setScalar(1.012)
  edge.renderOrder = 21
  edge.userData.selectionGlow = true
  edge.raycast = () => {}
  mesh.add(glow, edge)
  const parts = [glow, edge]
  mesh.userData.selectionGlowParts = parts
  return parts
}

type CameraViewOption = { id: CameraViewId; label: string; direction: [number, number, number]; kind: 'face' | 'edge' | 'corner' }

const cameraViewOptions: CameraViewOption[] = [
  { id: 'front', label: '前视', direction: [0, 1, 0], kind: 'face' },
  { id: 'back', label: '后视', direction: [0, -1, 0], kind: 'face' },
  { id: 'left', label: '左视', direction: [-1, 0, 0], kind: 'face' },
  { id: 'right', label: '右视', direction: [1, 0, 0], kind: 'face' },
  { id: 'top', label: '俯视', direction: [0, 0, 1], kind: 'face' },
  { id: 'bottom', label: '仰视', direction: [0, 0, -1], kind: 'face' },
  { id: 'front-top', label: '前上视', direction: [0, 1, 1], kind: 'edge' },
  { id: 'front-bottom', label: '前下视', direction: [0, 1, -1], kind: 'edge' },
  { id: 'back-top', label: '后上视', direction: [0, -1, 1], kind: 'edge' },
  { id: 'back-bottom', label: '后下视', direction: [0, -1, -1], kind: 'edge' },
  { id: 'front-left', label: '左前视', direction: [-1, 1, 0], kind: 'edge' },
  { id: 'front-right', label: '右前视', direction: [1, 1, 0], kind: 'edge' },
  { id: 'back-left', label: '左后视', direction: [-1, -1, 0], kind: 'edge' },
  { id: 'back-right', label: '右后视', direction: [1, -1, 0], kind: 'edge' },
  { id: 'top-left', label: '左上视', direction: [-1, 0, 1], kind: 'edge' },
  { id: 'top-right', label: '右上视', direction: [1, 0, 1], kind: 'edge' },
  { id: 'bottom-left', label: '左下视', direction: [-1, 0, -1], kind: 'edge' },
  { id: 'bottom-right', label: '右下视', direction: [1, 0, -1], kind: 'edge' },
  { id: 'front-top-left', label: '左前上视', direction: [-1, 1, 1], kind: 'corner' },
  { id: 'front-top-right', label: '右前上视', direction: [1, 1, 1], kind: 'corner' },
  { id: 'front-bottom-left', label: '左前下视', direction: [-1, 1, -1], kind: 'corner' },
  { id: 'front-bottom-right', label: '右前下视', direction: [1, 1, -1], kind: 'corner' },
  { id: 'back-top-left', label: '左后上视', direction: [-1, -1, 1], kind: 'corner' },
  { id: 'back-top-right', label: '右后上视', direction: [1, -1, 1], kind: 'corner' },
  { id: 'back-bottom-left', label: '左后下视', direction: [-1, -1, -1], kind: 'corner' },
  { id: 'back-bottom-right', label: '右后下视', direction: [1, -1, -1], kind: 'corner' },
]

function cameraViewLabel(view: CameraViewId): string {
  return cameraViewOptions.find((item) => item.id === view)?.label ?? view
}

function ViewCubeTarget({ id, className, children, onView }: { id: CameraViewId; className: string; children: React.ReactNode; onView: (view: CameraViewId) => void }) {
  const option = cameraViewOptions.find((item) => item.id === id)
  const activate = () => onView(id)
  const onKeyDown = (event: React.KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activate()
    }
  }
  return <g className={`view-cube-target ${className}`} role="menuitem" tabIndex={0} aria-label={`选择${option?.label ?? id}`} onClick={activate} onKeyDown={onKeyDown}>{children}</g>
}

function ViewCubeSelector({ onView }: { onView: (view: CameraViewId) => void }) {
  return <div className="camera-view-menu" role="menu" aria-label="交互式视角立方体">
    <svg className="view-cube-svg" viewBox="0 0 136 146" aria-hidden="false">
      <g className="view-cube-faces">
        <ViewCubeTarget id="top" className="view-cube-face view-cube-face-top" onView={onView}><polygon points="44,14 122,39 83,62 5,37" /></ViewCubeTarget>
        <ViewCubeTarget id="front" className="view-cube-face view-cube-face-front" onView={onView}><polygon points="5,37 83,62 83,132 5,107" /></ViewCubeTarget>
        <ViewCubeTarget id="right" className="view-cube-face view-cube-face-right" onView={onView}><polygon points="83,62 122,39 122,109 83,132" /></ViewCubeTarget>
      </g>
      <g className="view-cube-edges">
        <ViewCubeTarget id="front-top" className="view-cube-edge view-cube-edge-front-top" onView={onView}><line x1="5" y1="37" x2="83" y2="62" /></ViewCubeTarget>
        <ViewCubeTarget id="top-right" className="view-cube-edge view-cube-edge-top-right" onView={onView}><line x1="83" y1="62" x2="122" y2="39" /></ViewCubeTarget>
        <ViewCubeTarget id="front-right" className="view-cube-edge view-cube-edge-front-right" onView={onView}><line x1="83" y1="62" x2="83" y2="132" /></ViewCubeTarget>
      </g>
      <g className="view-cube-corners">
        <ViewCubeTarget id="front-top-left" className="view-cube-corner view-cube-corner-top-left" onView={onView}><circle cx="5" cy="37" r="9" /></ViewCubeTarget>
        <ViewCubeTarget id="back-top-left" className="view-cube-corner view-cube-corner-top-back" onView={onView}><circle cx="44" cy="14" r="9" /></ViewCubeTarget>
        <ViewCubeTarget id="back-top-right" className="view-cube-corner view-cube-corner-top-right" onView={onView}><circle cx="122" cy="39" r="9" /></ViewCubeTarget>
        <ViewCubeTarget id="front-top-right" className="view-cube-corner view-cube-corner-top-front-right" onView={onView}><circle cx="83" cy="62" r="10" /></ViewCubeTarget>
        <ViewCubeTarget id="front-bottom-left" className="view-cube-corner view-cube-corner-bottom-left" onView={onView}><circle cx="5" cy="107" r="9" /></ViewCubeTarget>
        <ViewCubeTarget id="front-bottom-right" className="view-cube-corner view-cube-corner-bottom-right" onView={onView}><circle cx="83" cy="132" r="10" /></ViewCubeTarget>
        <ViewCubeTarget id="back-bottom-right" className="view-cube-corner view-cube-corner-bottom-back-right" onView={onView}><circle cx="122" cy="109" r="9" /></ViewCubeTarget>
      </g>
      <path className="view-cube-outline" d="M44 14 L122 39 L122 109 L83 132 L5 107 L5 37 Z M5 37 L83 62 L122 39 M83 62 L83 132" />
    </svg>
  </div>
}

function ViewportCameraControls({ onRotate, onView, onReset, showJoystick = true, showActions = true }: { onRotate: (deltaX: number, deltaY: number) => void; onView: (view: CameraViewId) => void; onReset: () => void; showJoystick?: boolean; showActions?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [joystickOffset, setJoystickOffset] = useState({ x: 0, y: 0 })
  const joystickRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const joystickButtonRef = useRef<HTMLButtonElement | null>(null)
  const stopControlPointer = (event: React.SyntheticEvent) => event.stopPropagation()
  const resetJoystick = (pointerId = joystickRef.current?.pointerId) => {
    const button = joystickButtonRef.current
    joystickRef.current = null
    if (button && pointerId !== undefined && button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId)
    setJoystickOffset({ x: 0, y: 0 })
  }
  useEffect(() => {
    // Pointer capture normally keeps the drag on the knob, but a very fast
    // trackpad/mouse gesture can still lose the element-level pointerup. A
    // window-level cleanup guarantees that the knob cannot remain latched to
    // the ring wall after release, cancellation, or window deactivation.
    const finishJoystick = (event: PointerEvent) => {
      if (joystickRef.current?.pointerId === event.pointerId) resetJoystick(event.pointerId)
    }
    const cancelJoystick = () => {
      if (joystickRef.current) resetJoystick()
    }
    window.addEventListener('pointerup', finishJoystick, true)
    window.addEventListener('pointercancel', finishJoystick, true)
    window.addEventListener('blur', cancelJoystick)
    return () => {
      window.removeEventListener('pointerup', finishJoystick, true)
      window.removeEventListener('pointercancel', finishJoystick, true)
      window.removeEventListener('blur', cancelJoystick)
    }
  }, [])
  const startJoystick = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    joystickButtonRef.current = event.currentTarget
    event.currentTarget.setPointerCapture(event.pointerId)
    joystickRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
  }
  const moveJoystick = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = joystickRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const ring = event.currentTarget.parentElement?.getBoundingClientRect()
    const knob = event.currentTarget.getBoundingClientRect()
    if (ring) {
      const maxOffset = Math.max(0, ring.width / 2 - knob.width / 2 - 1)
      const centerX = ring.left + ring.width / 2
      const centerY = ring.top + ring.height / 2
      const rawX = event.clientX - centerX
      const rawY = event.clientY - centerY
      const distance = Math.hypot(rawX, rawY)
      const scale = distance > maxOffset && distance > 0 ? maxOffset / distance : 1
      setJoystickOffset({ x: rawX * scale, y: rawY * scale })
    }
    onRotate(event.clientX - gesture.lastX, event.clientY - gesture.lastY)
    gesture.lastX = event.clientX
    gesture.lastY = event.clientY
  }
  const endJoystick = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (joystickRef.current?.pointerId === event.pointerId) resetJoystick(event.pointerId)
  }
  return <div className="viewport-camera-controls" onPointerDown={stopControlPointer} onPointerMove={stopControlPointer} onPointerUp={stopControlPointer} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}>
    {showActions && <>
      {expanded && <ViewCubeSelector onView={(view) => { onView(view); setExpanded(false) }} />}
      <button className="camera-cube-button" aria-label="展开六个标准视角" aria-expanded={expanded} title="六个标准视角" onClick={() => setExpanded((value) => !value)}><Box size={18} strokeWidth={1.8} /></button>
      <button className="camera-reset-button" aria-label="视角回中" title="视角回中" onClick={onReset}><RotateCcw size={14} /></button>
    </>}
    {showJoystick && <div className="camera-joystick" aria-label="按住拖动旋转视角"><div className="camera-joystick-ring"><button className="camera-joystick-knob" style={{ transform: `translate(${joystickOffset.x}px, ${joystickOffset.y}px)` }} aria-label="拖动摇杆旋转视角" onPointerDown={startJoystick} onPointerMove={moveJoystick} onPointerUp={endJoystick} onPointerCancel={endJoystick} onLostPointerCapture={() => resetJoystick()} /></div></div>}
  </div>
}

function VoxelViewport({ project, selectedId, selectedPartIds, checkedPartIds, lockedPartIds, editEntityId, tool, activeMaterial, materials, dragAxis, placementAsset, copyPreview, viewMode, showGrid, showBoundary, zoomLevel, onZoomChange, onCameraApiChange, onInteractionChange, onRaycastVoxel, onSelect, onSelectMultiple, onCancelPendingEntityOperation, onSelectMaterial, onReplaceMaterial, onAddVoxel, onRemoveVoxel, onEditInstanceVoxel, onPreviewScenePartsMove, onCommitScenePartsMove, onPreviewPlacement, onPlaceAsset, onNotice, onExitEditMode, onEnterEditMode, onRename, onBatchOperation, children }: { project: ProjectState; selectedId: string; selectedPartIds: string[]; checkedPartIds: string[]; lockedPartIds: Set<string>; editEntityId: string | null; tool: Tool; activeMaterial: string; materials: Material[]; dragAxis: 'horizontal' | 'vertical'; placementAsset: VoxelAsset | null; copyPreview: CopyPreviewState | null; viewMode: '正交' | '透视'; showGrid: boolean; showBoundary: boolean; zoomLevel: number; onZoomChange: (value: number) => void; onCameraApiChange: (api: CameraControlApi | null) => void; onInteractionChange: (active: boolean) => void; onRaycastVoxel: (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }) => SceneVoxelRayHit | null; onSelect: (id: string) => void; onSelectMultiple: (partIds: string[], additive?: boolean) => void; onCancelPendingEntityOperation: () => void; onSelectMaterial: (id: string) => void; onReplaceMaterial: (id: string, color: string) => void; onAddVoxel: (voxel: Voxel) => void; onRemoveVoxel: (voxel: Voxel) => void; onEditInstanceVoxel: (instanceId: string, voxel: Voxel, mode: VoxelOverride['mode']) => void; onPreviewScenePartsMove: (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number) => GridMoveResult; onCommitScenePartsMove: (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number) => GridMoveResult; onPreviewPlacement: (assetId: string, x: number, z: number) => PlacementPreview | null; onPlaceAsset: (assetId: string, x: number, z: number) => void; onNotice: (message: string) => void; onExitEditMode: () => void; onEnterEditMode: (entityId: string) => void; onRename: (targetId: string, assemblyId?: string) => void; onBatchOperation: (partIds: string[], operation: 'delete' | 'lock' | 'assemble') => void; children?: React.ReactNode }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const camerasRef = useRef<{ orthographic: THREE.OrthographicCamera; perspective: THREE.PerspectiveCamera } | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const groupRef = useRef<THREE.Group | null>(null)
  const placementGroupRef = useRef<THREE.Group | null>(null)
  const copyPreviewGroupRef = useRef<THREE.Group | null>(null)
  const placementPreviewRef = useRef<PlacementPreview | null>(null)
  const chunkMeshWorkerRef = useRef<ChunkMeshWorkerClient | null>(null)
  const chunkMeshRevisionRef = useRef(0)
  const axisGizmoRef = useRef<SVGSVGElement | null>(null)
  const raycasterRef = useRef(new THREE.Raycaster())
  const pointerRef = useRef(new THREE.Vector2())
  const controlsRef = useRef<OrbitControls | null>(null)
  const onZoomChangeRef = useRef(onZoomChange)
  const zoomReportFrameRef = useRef<number | null>(null)
  const cameraZoomLevelRef = useRef(100)
  const invalidateRenderRef = useRef<(durationMs?: number) => void>(() => {})
  const perspectiveBaseDistanceRef = useRef(Math.sqrt(16 ** 2 + 18 ** 2 + 18 ** 2))
  const editRenderStateRef = useRef<{ active: boolean; partIds: Set<string> }>({ active: false, partIds: new Set() })
  const editGestureRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null)
  const selectGestureRef = useRef<SelectGesture | null>(null)
  const boxSelectGestureRef = useRef<BoxSelectGesture | null>(null)
  const cameraGestureRef = useRef<{ pointerId: number; button: 'right'; lastX: number; lastY: number; moved: boolean; contextPartIds?: string[] } | null>(null)
  const [sceneSelectionBox, setSceneSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [sceneContextMenu, setSceneContextMenu] = useState<{ partIds: string[]; x: number; y: number } | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    onZoomChangeRef.current = onZoomChange
  }, [onZoomChange])
  useEffect(() => {
    const client = new ChunkMeshWorkerClient()
    chunkMeshWorkerRef.current = client
    return () => {
      client.dispose()
      chunkMeshWorkerRef.current = null
    }
  }, [])
  // Keep persisted asset coordinates backward-compatible while presenting the scene
  // in the editor's conventional XY ground plane with Z as the vertical axis.
  const toSceneWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, y)

  const scheduleZoomReport = () => {
    if (zoomReportFrameRef.current !== null) return
    zoomReportFrameRef.current = requestAnimationFrame(() => {
      zoomReportFrameRef.current = null
      onZoomChangeRef.current(cameraZoomLevelRef.current)
    })
  }

  // This is the single imperative zoom path. Wheel/trackpad input and the
  // footer buttons both call it; React only receives the coalesced value for
  // the percentage ruler and never drives the camera during a gesture.
  const setCameraZoomLevel = (requestedZoom: number) => {
    const cameras = camerasRef.current
    const controls = controlsRef.current
    const nextZoom = clampZoomLevel(requestedZoom)
    if (!cameras || !controls) {
      onZoomChangeRef.current(nextZoom)
      return
    }
    if (Math.abs(cameraZoomLevelRef.current - nextZoom) < 0.001) return
    cameraZoomLevelRef.current = nextZoom
    const factor = nextZoom / 100
    cameras.orthographic.zoom = factor
    cameras.orthographic.updateProjectionMatrix()
    const direction = cameras.perspective.position.clone().sub(controls.target)
    if (direction.lengthSq() > 0.000001) {
      cameras.perspective.position.copy(controls.target).add(direction.normalize().multiplyScalar(perspectiveBaseDistanceRef.current / factor))
    }
    cameras.perspective.zoom = 1
    cameras.perspective.fov = 38
    cameras.perspective.updateProjectionMatrix()
    controls.update()
    scheduleZoomReport()
    invalidateRenderRef.current(220)
  }

  const materialMap = useMemo(() => new Map(project.materials.map((material) => [material.id, new THREE.MeshStandardMaterial({ color: material.color, roughness: 0.72, metalness: 0.03 })])), [project.materials])
  useEffect(() => () => {
    materialMap.forEach((material) => material.dispose())
  }, [materialMap])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#161b1e')
    const orthographic = new THREE.OrthographicCamera(-13, 13, 9, -9, 0.1, 1000)
    orthographic.position.set(16, 18, 18)
    orthographic.up.set(0, 0, 1)
    orthographic.lookAt(0, 0, 0)
    const perspective = new THREE.PerspectiveCamera(38, 1, 0.1, 1000)
    perspective.position.set(16, 18, 18)
    perspective.up.set(0, 0, 1)
    perspective.lookAt(0, 0, 0)
    const camera = orthographic
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    // Keep the WebGL back buffer at one stable size for the lifetime of the
    // viewport. Resizing it while a pointer gesture is in progress makes the
    // canvas briefly clear/reallocate, which is perceived as a flash even
    // though the render loop itself is running at a good frame rate.
    const staticPixelRatio = Math.min(window.devicePixelRatio, 1.5)
    renderer.setPixelRatio(staticPixelRatio)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    const dimScene = new THREE.Scene()
    const dimCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const dimPlane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.44, depthTest: false, depthWrite: false }))
    dimPlane.renderOrder = 1000
    dimScene.add(dimPlane)
    mount.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enabled = true
    controls.enableDamping = true
    controls.enablePan = true
    // Handle wheel/pinch zoom in one place below. Leaving OrbitControls' own
    // dolly handler enabled would let it change the camera first and then let
    // the React zoom synchronizer change it again in the same gesture.
    controls.enableZoom = false
    controls.enableRotate = true
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN
    controls.touches.ONE = THREE.TOUCH.ROTATE
    controls.rotateSpeed = 0.72
    // A higher damping factor makes release feel immediate while retaining a small amount of smoothing.
    controls.dampingFactor = 0.18
    controls.panSpeed = 0.8
    controls.zoomSpeed = 0.85
    controls.target.set(0, 0, 0)
    const ambient = new THREE.HemisphereLight('#f4f0e8', '#263238', 2.4)
    scene.add(ambient)
    const key = new THREE.DirectionalLight('#fff0d8', 3.5)
    key.position.set(10, 10, 22)
    key.castShadow = true
    scene.add(key)
    const initialBounds = sceneBoundsForProject(project)
    // The bottom of voxel row y=0 is the scene ground at z=0. Keep the floor
    // on that exact datum; depthWrite is disabled so the coplanar floor does
    // not prevent the voxel faces and grid from resolving their own depth.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(initialBounds.x * VOXEL_WORLD_SIZE, initialBounds.y * VOXEL_WORLD_SIZE), new THREE.MeshStandardMaterial({ color: '#11181b', roughness: 0.95, side: THREE.DoubleSide, depthWrite: false }))
    floor.position.z = 0
    floor.name = 'editing-floor'
    floor.receiveShadow = true
    scene.add(floor)
    scene.add(createGroundGrid(initialBounds), createGroundBoundary(initialBounds), createBoundaryBox(initialBounds))
    const group = new THREE.Group()
    const placementGroup = new THREE.Group()
    const copyPreviewGroup = new THREE.Group()
    placementGroup.name = 'placement-preview-root'
    copyPreviewGroup.name = 'copy-preview-root'
    scene.add(group)
    scene.add(placementGroup)
    scene.add(copyPreviewGroup)
    sceneRef.current = scene
    cameraRef.current = camera
    camerasRef.current = { orthographic, perspective }
    rendererRef.current = renderer
    groupRef.current = group
    placementGroupRef.current = placementGroup
    copyPreviewGroupRef.current = copyPreviewGroup
    controlsRef.current = controls
    let frame = 0
    let renderUntil = 0
    let animate = () => {}
    const invalidateRender = (durationMs = 0) => {
      renderUntil = Math.max(renderUntil, performance.now() + durationMs)
      if (!frame) frame = requestAnimationFrame(animate)
    }
    invalidateRenderRef.current = invalidateRender
    // Initialize the camera from the external ruler once. After this point
    // all zoom changes go through setCameraZoomLevel imperatively.
    setCameraZoomLevel(zoomLevel)
    const applyWheelZoom = (event: WheelEvent) => {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return
      event.preventDefault()
      const scale = Math.pow(0.95, controls.zoomSpeed * WHEEL_ZOOM_INPUT_GAIN * Math.abs(event.deltaY * 0.01))
      const nextZoom = cameraZoomLevelRef.current * (event.deltaY < 0 ? 1 / scale : scale)
      setCameraZoomLevel(nextZoom)
    }
    renderer.domElement.addEventListener('wheel', applyWheelZoom, { passive: false })
    const resize = () => {
      const width = mount.clientWidth || 800
      const height = mount.clientHeight || 600
      const aspect = width / height
      const view = 12
      orthographic.left = -view * aspect
      orthographic.right = view * aspect
      orthographic.top = view
      orthographic.bottom = -view
      orthographic.updateProjectionMatrix()
      perspective.aspect = aspect
      perspective.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      invalidateRender()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    let renderCount = 0
    const updateAxisGizmo = () => {
      const svg = axisGizmoRef.current
      const currentCamera = cameraRef.current
      if (!svg || !currentCamera) return
      currentCamera.updateMatrixWorld()
      const center = 32
      const length = 24
      const axes = [
        { key: 'x', vector: new THREE.Vector3(1, 0, 0), color: '#cf7052' },
        { key: 'y', vector: new THREE.Vector3(0, 1, 0), color: '#79b081' },
        { key: 'z', vector: new THREE.Vector3(0, 0, 1), color: '#7b9ed0' },
      ]
      axes.forEach(({ key, vector, color }) => {
        // Transform a direction, not a point: camera panning must never change
        // the length or angle of the axis indicator.
        const point = vector.clone().transformDirection(currentCamera.matrixWorldInverse)
        const endX = center + point.x * length
        const endY = center - point.y * length
        const line = svg.querySelector<SVGLineElement>(`[data-axis-line="${key}"]`)
        const label = svg.querySelector<SVGTextElement>(`[data-axis-label="${key}"]`)
        if (line) {
          line.setAttribute('x1', `${center}`)
          line.setAttribute('y1', `${center}`)
          line.setAttribute('x2', `${endX}`)
          line.setAttribute('y2', `${endY}`)
          line.setAttribute('stroke', color)
          line.setAttribute('opacity', `${point.z < 0 ? 1 : 0.42}`)
        }
        if (label) {
          label.setAttribute('x', `${endX}`)
          label.setAttribute('y', `${endY}`)
          label.setAttribute('fill', color)
          label.setAttribute('opacity', `${point.z < 0 ? 1 : 0.42}`)
        }
      })
    }
    animate = () => {
      frame = 0
      const controlsAnimating = controls.update()
      updateAxisGizmo()
      const currentCamera = cameraRef.current ?? camera
      renderer.render(scene, currentCamera)
      const editState = editRenderStateRef.current
      if (editState.active && group.children.length) {
        const hidden: Array<{ object: THREE.Object3D; visible: boolean }> = []
        const previousBackground = scene.background
        const floorObject = scene.getObjectByName('editing-floor')
        const gridObject = scene.getObjectByName('editing-grid')
        const groundBoundaryObject = scene.getObjectByName('editing-ground-boundary')
        const boundaryBoxObject = scene.getObjectByName('editing-boundary-box')
        const subtreeContainsEditPart = (object: THREE.Object3D): boolean => {
          if (object.userData.editPlacementPreview) return true
          const scenePartId = object.userData.scenePartId as string | undefined
          if (scenePartId) return editState.partIds.has(scenePartId)
          return object.children.some(subtreeContainsEditPart)
        }
        const hideOutsideEditPart = (object: THREE.Object3D) => {
          if (object.userData.editPlacementPreview) return
          const scenePartId = object.userData.scenePartId as string | undefined
          if (scenePartId) {
            if (!editState.partIds.has(scenePartId)) {
              hidden.push({ object, visible: object.visible })
              object.visible = false
            }
            return
          }
          if (!subtreeContainsEditPart(object)) {
            hidden.push({ object, visible: object.visible })
            object.visible = false
            return
          }
          object.children.forEach(hideOutsideEditPart)
        }
        group.children.forEach(hideOutsideEditPart)
        if (floorObject) { hidden.push({ object: floorObject, visible: floorObject.visible }); floorObject.visible = false }
        if (gridObject) { hidden.push({ object: gridObject, visible: gridObject.visible }); gridObject.visible = false }
        if (groundBoundaryObject) { hidden.push({ object: groundBoundaryObject, visible: groundBoundaryObject.visible }); groundBoundaryObject.visible = false }
        if (boundaryBoxObject) { hidden.push({ object: boundaryBoxObject, visible: boundaryBoxObject.visible }); boundaryBoxObject.visible = false }
        // The edit overlay is a second pass. Keep all temporary renderer and
        // scene state guarded so an interrupted frame can never leave
        // autoClear/background/visibility in a partially restored state.
        const previousAutoClear = renderer.autoClear
        renderer.autoClear = false
        try {
          renderer.clearDepth()
          renderer.render(dimScene, dimCamera)
          renderer.clearDepth()
          scene.background = null
          renderer.render(scene, currentCamera)
        } finally {
          scene.background = previousBackground
          renderer.autoClear = previousAutoClear
          hidden.reverse().forEach(({ object, visible }) => { object.visible = visible })
        }
      }
      renderCount += 1
      window.__MOCE_PERFORMANCE__ = {
        renderCount,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        lastRenderAt: performance.now(),
      }
      renderer.domElement.dataset.renderCount = `${renderCount}`
      renderer.domElement.dataset.drawCalls = `${renderer.info.render.calls}`
      renderer.domElement.dataset.triangles = `${renderer.info.render.triangles}`
      renderer.domElement.dataset.geometries = `${renderer.info.memory.geometries}`
      renderer.domElement.dataset.textures = `${renderer.info.memory.textures}`
      if (controlsAnimating || performance.now() < renderUntil) {
        frame = requestAnimationFrame(animate)
      }
    }
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    invalidateRender()
    setReady(true)
    return () => {
      cancelAnimationFrame(frame)
      if (zoomReportFrameRef.current !== null) cancelAnimationFrame(zoomReportFrameRef.current)
      invalidateRenderRef.current = () => {}
      observer.disconnect()
      renderer.domElement.removeEventListener('wheel', applyWheelZoom)
      controls.dispose()
      disposeThreeObject(scene)
      renderer.dispose()
      dimPlane.geometry.dispose()
      dimPlane.material.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    const cameras = camerasRef.current
    const controls = controlsRef.current
    if (!cameras || !controls) return
    const nextCamera = viewMode === '透视' ? cameras.perspective : cameras.orthographic
    cameraRef.current = nextCamera
    controls.object = nextCamera
    controls.update()
    invalidateRenderRef.current()
  }, [viewMode])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const grid = scene.getObjectByName('editing-grid')
    const ground = scene.getObjectByName('editing-floor')
    const groundBoundary = scene.getObjectByName('editing-ground-boundary')
    const boundaryBox = scene.getObjectByName('editing-boundary-box')
    if (grid) grid.visible = showGrid
    if (ground) ground.visible = true
    if (groundBoundary) groundBoundary.visible = showBoundary
    if (boundaryBox) boundaryBox.visible = showBoundary
    invalidateRenderRef.current()
  }, [showGrid, showBoundary])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    updateEditingBoundsVisuals(scene, sceneBoundsForProject(project))
    const grid = scene.getObjectByName('editing-grid')
    const ground = scene.getObjectByName('editing-floor')
    const groundBoundary = scene.getObjectByName('editing-ground-boundary')
    const boundaryBox = scene.getObjectByName('editing-boundary-box')
    if (grid) grid.visible = showGrid
    if (ground) ground.visible = true
    if (groundBoundary) groundBoundary.visible = showBoundary
    if (boundaryBox) boundaryBox.visible = showBoundary
    invalidateRenderRef.current()
  }, [project.sceneBounds?.x, project.sceneBounds?.y, project.sceneBounds?.z, project.sceneSizeCm, showGrid, showBoundary])

  const applyCameraView = (view: CameraView, requestedZoom = cameraZoomLevelRef.current) => {
    const cameras = camerasRef.current
    const controls = controlsRef.current
    if (!cameras || !controls) return
    // OrbitControls stores its release velocity internally. Disable damping for one
    // update so reset/view changes never inherit the previous fling.
    const dampingEnabled = controls.enableDamping
    controls.enableDamping = false
    controls.update()
    controls.enableDamping = dampingEnabled
    const target = new THREE.Vector3(0, 0, 0)
    const distance = 28
    let position = new THREE.Vector3(16, 18, 18)
    let up = new THREE.Vector3(0, 0, 1)
    if (view !== 'default') {
      const option = cameraViewOptions.find((item) => item.id === view)
      if (option) position = new THREE.Vector3(...option.direction).normalize().multiplyScalar(distance)
    }
    perspectiveBaseDistanceRef.current = position.length()
    const nextZoom = clampZoomLevel(requestedZoom)
    cameraZoomLevelRef.current = nextZoom
    const zoomFactor = nextZoom / 100
    const perspectivePosition = position.clone().divideScalar(zoomFactor)
    if (view === 'top') {
      up = new THREE.Vector3(0, 1, 0)
    } else if (view === 'bottom') {
      up = new THREE.Vector3(0, -1, 0)
    }
    cameras.orthographic.position.copy(position)
    cameras.perspective.position.copy(perspectivePosition)
    cameras.orthographic.up.copy(up)
    cameras.perspective.up.copy(up)
    cameras.orthographic.lookAt(target)
    cameras.perspective.lookAt(target)
    cameras.orthographic.updateProjectionMatrix()
    cameras.perspective.updateProjectionMatrix()
    controls.target.copy(target)
    controls.update()
    scheduleZoomReport()
    invalidateRenderRef.current(220)
  }

  const rotateCameraByInput = (deltaX: number, deltaY: number) => {
    const controls = controlsRef.current
    if (!controls) return
    controls.rotateLeft(deltaX * 0.008)
    controls.rotateUp(deltaY * 0.008)
    controls.update()
    invalidateRenderRef.current(220)
  }

  useEffect(() => {
    onCameraApiChange({
      rotate: rotateCameraByInput,
      view: (view) => applyCameraView(view),
      reset: () => {
        applyCameraView('default', 100)
        // Reset the visible ruler immediately as part of the same operation;
        // it must not depend on the next animation frame being delivered.
        onZoomChangeRef.current(100)
      },
      zoomIn: () => setCameraZoomLevel(cameraZoomLevelRef.current + (cameraZoomLevelRef.current >= 100 ? 50 : 10)),
      zoomOut: () => setCameraZoomLevel(cameraZoomLevelRef.current - (cameraZoomLevelRef.current > 100 ? 50 : 10)),
    })
    return () => onCameraApiChange(null)
  }, [onCameraApiChange])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    disposeThreeObject(group)
    group.clear()
    const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
    for (const instance of project.instances) {
      if (!instance.visible) continue
      const asset = assetMap.get(instance.assetId)
      if (!asset) continue
      const variant = asset.templateColor ? undefined : styleMaterialVariants[instance.style]
      const renderAsset = variant ? { ...asset, color: variant.color, accent: variant.accent } : asset
      const instanceGroup = buildAssetGroup(renderAsset, materialMap, instance.overrides, instance.partOffsets, instance.rotation, instance.colorOverride, instance.mirror, instance.rotationX, instance.rotationY, instance.rotationZ)
      instanceGroup.position.copy(toSceneWorld(instance.x, instance.y ?? 0, instance.z))
      instanceGroup.userData.instanceId = instance.id
      instanceGroup.traverse((object) => {
        object.userData.instanceId = instance.id
        if (object.userData.instancePartId) object.userData.scenePartId = `asset:${instance.id}:${object.userData.instancePartId}`
      })
      instanceGroup.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object.userData.selectionGlow) return
        const meshMaterial = object.material as THREE.MeshStandardMaterial
        object.userData.baseRenderColor = meshMaterial.color.getHex()
      })
      group.add(instanceGroup)
    }
    if (project.customVoxels.length) {
      const custom = new THREE.Group()
      custom.name = 'custom-voxels'
      // Rendering ownership must follow the persisted entityId, not geometric
      // connectivity. Two independent user entities are allowed to touch; if
      // they are rendered as one connected component, the first voxel's id and
      // color leak into the other entity and selection/highlight becomes wrong.
      const voxelsByEntity = new Map<string, Voxel[]>()
      project.customVoxels.forEach((voxel) => {
        const entityId = voxelEntityId(voxel)
        voxelsByEntity.set(entityId, [...(voxelsByEntity.get(entityId) ?? []), voxel])
      })
      for (const [entityId, component] of voxelsByEntity) {
        const componentGroup = new THREE.Group()
        const componentScenePartId = `custom:${entityId}`
        componentGroup.userData.scenePartId = componentScenePartId
        const occupied = new Set(component.map((candidate) => `${candidate.x},${candidate.y},${candidate.z}`))
        const componentColor = project.customColors?.[entityId]
        const greedyColorIds = new Map<string, number>()
        const greedyColors: string[] = ['#ffffff']
        const greedyVoxels = component.map((voxel) => {
          const color = componentColor
            ? new THREE.Color(componentColor)
            : (materialMap.get(voxel.materialId) ?? materialMap.get('terracotta')!).color.clone()
          const colorKey = `#${color.getHexString()}`
          let materialId = greedyColorIds.get(colorKey)
          if (!materialId) {
            materialId = greedyColors.length
            greedyColorIds.set(colorKey, materialId)
            greedyColors.push(colorKey)
          }
          return { gx: voxel.x, gy: voxel.z, gz: voxel.y, materialId }
        })
        componentGroup.userData.greedyVoxels = greedyVoxels
        componentGroup.userData.greedyColors = greedyColors
        const batches = new Map<string, { color: THREE.Color; voxels: Voxel[] }>()
        component.forEach((voxel) => {
          const color = componentColor
            ? new THREE.Color(componentColor)
            : (materialMap.get(voxel.materialId) ?? materialMap.get('terracotta')!).color.clone()
          const key = color.getHexString()
          const batch = batches.get(key) ?? { color, voxels: [] }
          batch.voxels.push(voxel)
          batches.set(key, batch)
        })
        batches.forEach(({ color, voxels }) => {
          const meshMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.03 })
          const mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, meshMaterial, voxels.length)
          const matrix = new THREE.Matrix4()
          voxels.forEach((voxel, index) => {
            matrix.makeTranslation(voxelCenterToWorld(voxel.x), voxelCenterToWorld(voxel.z), voxelCenterToWorld(voxel.y))
            mesh.setMatrixAt(index, matrix)
          })
          mesh.instanceMatrix.needsUpdate = true
          mesh.userData.customVoxels = voxels
          mesh.userData.customComponentId = voxelComponentId(component)
          mesh.userData.scenePartId = componentScenePartId
          mesh.userData.outerVoxel = voxels.some((voxel) => exposedVoxelFaces(voxel, occupied).length > 0)
          mesh.userData.baseRenderColor = meshMaterial.color.getHex()
          componentGroup.add(mesh)
        })
        custom.add(componentGroup)
      }
      group.add(custom)
    }
    invalidateRenderRef.current()
  }, [project, materialMap])

  useEffect(() => {
    const group = groupRef.current
    const client = chunkMeshWorkerRef.current
    if (!group || !client) return
    const revision = ++chunkMeshRevisionRef.current
    let cancelled = false
    group.traverse((object) => {
      if (!(object instanceof THREE.Group)) return
      const voxels = object.userData.greedyVoxels as Array<{ gx: number; gy: number; gz: number; materialId: number }> | undefined
      const colors = object.userData.greedyColors as string[] | undefined
      const scenePartId = object.userData.scenePartId as string | undefined
      if (!voxels || voxels.length < 64 || !colors || !scenePartId) return
      void client.build(scenePartId, revision, voxels).then((payload) => {
        if (cancelled || !payload || !object.parent) return
        const positions = payload.positions.slice()
        for (let index = 0; index < positions.length; index += 1) positions[index] *= VOXEL_WORLD_SIZE
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3, true))
        const vertexColors = new Float32Array(payload.materialIds.length * 3)
        payload.materialIds.forEach((materialId, index) => {
          const color = new THREE.Color(colors[materialId] ?? '#6c827d')
          vertexColors[index * 3] = color.r
          vertexColors[index * 3 + 1] = color.g
          vertexColors[index * 3 + 2] = color.b
        })
        geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3))
        geometry.setIndex(new THREE.BufferAttribute(payload.indices, 1))
        geometry.computeBoundingSphere()
        const material = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.72, metalness: 0.03 })
        const greedyMesh = new THREE.Mesh(geometry, material)
        greedyMesh.userData.scenePartId = scenePartId
        greedyMesh.userData.baseRenderColor = 0xffffff
        greedyMesh.userData.greedyMesh = true
        greedyMesh.userData.skipVoxelHighlight = true
        const editState = editRenderStateRef.current
        if (editState.active && !editState.partIds.has(scenePartId)) material.color.multiplyScalar(0.5)
        object.children.forEach((child) => {
          if (child instanceof THREE.InstancedMesh) {
            child.userData.renderInstanceCount = child.count
            child.count = 0
          }
        })
        object.add(greedyMesh)
        invalidateRenderRef.current()
      })
    })
    return () => {
      cancelled = true
    }
  }, [project, materialMap])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const currentSceneParts = sceneEntityParts(project)
    const selectedScenePartIds = new Set(selectedPartIds)
    const editAssemblyId = editEntityId?.startsWith('assembly:') ? editEntityId.slice('assembly:'.length) : undefined
    const editScenePartIds = new Set(currentSceneParts.filter((part) => editEntityId === part.id || (editAssemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editAssemblyId))).map((part) => part.id))
    editRenderStateRef.current = { active: Boolean(editEntityId), partIds: editScenePartIds }
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData.selectionGlow) return
      const oldHighlights = object.userData.selectionGlowParts as THREE.Object3D[] | undefined
      oldHighlights?.forEach((highlight) => {
        object.remove(highlight)
        disposeThreeObject(highlight)
      })
      delete object.userData.selectionGlowParts
      const scenePartId = object.userData.scenePartId as string | undefined
      const meshMaterial = object.material as THREE.MeshStandardMaterial
      const baseColor = object.userData.baseRenderColor as number | undefined
      if (baseColor !== undefined) meshMaterial.color.setHex(baseColor)
      meshMaterial.transparent = false
      meshMaterial.opacity = 1
      meshMaterial.depthWrite = true
      if (!scenePartId) return
      if (!object.userData.skipVoxelHighlight && (selectedScenePartIds.has(scenePartId) || editScenePartIds.has(scenePartId))) addVoxelHighlight(object)
      if (editEntityId && !editScenePartIds.has(scenePartId)) {
        meshMaterial.color.multiplyScalar(0.5)
        if (!object.userData.skipVoxelHighlight && object.userData.outerVoxel) addVoxelHighlight(object).forEach((part) => { part.visible = false })
      }
    })
    invalidateRenderRef.current()
  }, [project, selectedPartIds, checkedPartIds, editEntityId])

  useEffect(() => {
    const placementRoot = placementGroupRef.current
    if (!placementRoot) return
    disposeThreeObject(placementRoot)
    placementRoot.clear()
    placementPreviewRef.current = null
    invalidateRenderRef.current()
    if (!placementAsset) return
    const variant = placementAsset.templateColor ? undefined : styleMaterialVariants[placementAsset.style]
    const renderAsset = variant ? { ...placementAsset, color: variant.color, accent: variant.accent } : placementAsset
    const preview = buildAssetGroup(renderAsset, materialMap)
    preview.visible = false
    preview.userData.placementPreview = true
    preview.userData.editPlacementPreview = Boolean(editEntityId)
    preview.traverse((object) => {
      object.userData.placementPreview = true
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return
      const material = object.material
      object.userData.placementBaseColor = material.color.getHex()
      material.transparent = true
      material.opacity = editEntityId ? 0.86 : 0.42
      material.depthWrite = false
      if (editEntityId && object.userData.outerVoxel) addVoxelHighlight(object)
    })
    placementRoot.add(preview)
    invalidateRenderRef.current()
  }, [placementAsset, editEntityId, materialMap])

  useEffect(() => {
    const root = copyPreviewGroupRef.current
    if (!root) return
    disposeThreeObject(root)
    root.clear()
    if (!copyPreview) {
      invalidateRenderRef.current()
      return
    }
    copyPreview.offsets.forEach((offset) => {
      const preview = buildAssetGroup(copyPreview.asset, materialMap)
      preview.position.copy(toSceneWorld(copyPreview.origin.x + offset.x * VOXEL_WORLD_SIZE, copyPreview.origin.y + offset.y * VOXEL_WORLD_SIZE, copyPreview.origin.z + offset.z * VOXEL_WORLD_SIZE))
      preview.userData.copyPreview = true
      preview.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return
        object.material.transparent = true
        object.material.opacity = copyPreview.valid ? 0.32 : 0.2
        object.material.depthWrite = false
        if (!copyPreview.valid) object.material.color.set('#e06b5b')
      })
      root.add(preview)
    })
    invalidateRenderRef.current(160)
  }, [copyPreview, materialMap])

  const showPlacementPreview = (previewState: PlacementPreview | null) => {
    const preview = placementGroupRef.current?.children[0]
    placementPreviewRef.current = previewState
    if (!preview || !previewState) {
      if (preview) preview.visible = false
      invalidateRenderRef.current()
      return
    }
    preview.visible = true
    preview.position.copy(toSceneWorld(previewState.x, previewState.y, previewState.z))
    preview.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return
      object.material.opacity = editEntityId ? (previewState.valid ? 0.86 : 0.66) : (previewState.valid ? 0.42 : 0.18)
      const baseColor = object.userData.placementBaseColor as number | undefined
      object.material.color.set(previewState.valid ? (baseColor ?? 0xffffff) : '#e06b5b')
    })
    invalidateRenderRef.current(80)
  }

  const getPointerContext = (event: { clientX: number; clientY: number }) => {
    const renderer = rendererRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    const mount = mountRef.current
    if (!renderer || !scene || !camera || !mount) return null
    const rect = renderer.domElement.getBoundingClientRect()
    pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycasterRef.current.setFromCamera(pointerRef.current, camera)
    const rawHits = !placementAsset && groupRef.current ? raycasterRef.current.intersectObject(groupRef.current, true) : []
    const hits = editEntityId ? rawHits.filter((item) => belongsToEditEntity(item.object)) : rawHits
    const voxelHit = onRaycastVoxel(raycasterRef.current.ray.origin, raycasterRef.current.ray.direction)
    const floor = scene.getObjectByName('editing-floor')
    const floorHit = floor ? raycasterRef.current.intersectObject(floor, false)[0] : undefined
    return { rawHits, hits, voxelHit, floorPoint: floorHit?.point ?? null }
  }

  const makeVerticalPlane = (anchor: THREE.Vector3) => {
    const camera = cameraRef.current
    const viewDirection = new THREE.Vector3(0, 0, 1)
    camera?.getWorldDirection(viewDirection)
    viewDirection.z = 0
    if (viewDirection.lengthSq() < 0.0001) viewDirection.set(0, 0, 1)
    viewDirection.normalize()
    return { normalX: viewDirection.x, normalY: viewDirection.y, constant: -(viewDirection.x * anchor.x + viewDirection.y * anchor.y) }
  }

  const getVerticalPoint = (planeData: SelectGesture['verticalPlane']) => {
    const plane = new THREE.Plane(new THREE.Vector3(planeData.normalX, planeData.normalY, 0), planeData.constant)
    return raycasterRef.current.ray.intersectPlane(plane, new THREE.Vector3())
  }

  const handleEntityDoubleClick = (event: { clientX: number; clientY: number }) => {
    if (tool !== 'select' || placementAsset || editEntityId) return
    const context = getPointerContext(event)
    const hit = context?.hits.find((item) => item.object.userData.scenePartId)
    const hitPart = hit?.object.userData.scenePartId ? sceneEntityParts(project).find((part) => part.id === hit.object.userData.scenePartId) : undefined
    if (!hitPart) return
    onEnterEditMode(hitPart.id)
  }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const handleDoubleClick = (event: MouseEvent) => handleEntityDoubleClick(event)
    mount.addEventListener('dblclick', handleDoubleClick)
    return () => mount.removeEventListener('dblclick', handleDoubleClick)
  }, [project, tool, placementAsset, onEnterEditMode])

  const scenePartIdsInBox = (startX: number, startY: number, endX: number, endY: number) => {
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera) return []
    const rect = renderer.domElement.getBoundingClientRect()
    const minX = Math.min(startX, endX)
    const maxX = Math.max(startX, endX)
    const minY = Math.min(startY, endY)
    const maxY = Math.max(startY, endY)
    const selected = new Set<string>()
    for (const part of sceneEntityParts(project)) {
      if (part.voxels.some((voxel) => {
        const point = toSceneWorld(voxelCenterToWorld(voxel.x), voxelCenterToWorld(voxel.y), voxelCenterToWorld(voxel.z)).project(camera)
        const screenX = rect.left + (point.x + 1) * 0.5 * rect.width
        const screenY = rect.top + (1 - point.y) * 0.5 * rect.height
        return screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY
      })) selected.add(part.id)
    }
    return [...selected]
  }

  const hitSelectionPartIds = (part: SceneEntityPart) => {
    return [part.id]
  }

  const collectDragVisualRoots = (partIds: string[]) => {
    const group = groupRef.current
    if (!group) return []
    const requestedIds = new Set(partIds)
    const roots: SelectGesture['visualRoots'] = []
    group.traverse((object) => {
      const scenePartId = object.userData.scenePartId as string | undefined
      const parentPartId = object.parent?.userData.scenePartId as string | undefined
      if (!scenePartId || !requestedIds.has(scenePartId) || parentPartId === scenePartId || object.userData.selectionGlow) return
      roots.push({ object, startPosition: object.position.clone() })
    })
    return roots
  }

  const setDragVisualOffset = (gesture: SelectGesture, deltaX: number, deltaY: number, deltaZ: number) => {
    const worldOffset = new THREE.Vector3(voxelToWorld(deltaX), voxelToWorld(deltaZ), voxelToWorld(deltaY))
    gesture.visualRoots.forEach(({ object, startPosition }) => {
      object.position.copy(startPosition).add(worldOffset)
    })
    invalidateRenderRef.current(80)
  }

  const resetDragVisuals = (gesture: SelectGesture) => {
    gesture.visualRoots.forEach(({ object, startPosition }) => {
      object.position.copy(startPosition)
    })
    invalidateRenderRef.current()
  }

  const commitDragGesture = (gesture: SelectGesture) => {
    if (!gesture.moved || (!gesture.lastDeltaX && !gesture.lastDeltaY && !gesture.lastDeltaZ)) {
      resetDragVisuals(gesture)
      return
    }
    const result = onCommitScenePartsMove(gesture.parts, gesture.lastDeltaX, gesture.lastDeltaY, gesture.lastDeltaZ)
    if (!result.moved) resetDragVisuals(gesture)
  }

  const belongsToEditEntity = (object: THREE.Object3D) => {
    if (!editEntityId) return true
    const scenePartId = object.userData.scenePartId as string | undefined
    if (!scenePartId) return false
    if (scenePartId === editEntityId) return true
    if (!editEntityId.startsWith('assembly:')) return false
    const assemblyId = editEntityId.slice('assembly:'.length)
    return sceneEntityParts(project).some((part) => part.id === scenePartId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(assemblyId))
  }

  const intersectionVoxel = (hit: THREE.Intersection<THREE.Object3D>, collectionKey: 'instanceVoxels' | 'customVoxels', legacyKey: 'instanceVoxel' | 'customVoxel'): Voxel | undefined => {
    const voxels = hit.object.userData[collectionKey] as Voxel[] | undefined
    if (voxels && typeof hit.instanceId === 'number') return voxels[hit.instanceId]
    return hit.object.userData[legacyKey] as Voxel | undefined
  }

  const sceneVoxelFromHit = (hit: THREE.Intersection<THREE.Object3D>): Voxel | undefined => {
    const localVoxel = intersectionVoxel(hit, 'instanceVoxels', 'instanceVoxel')
    const instanceId = hit.object.userData.instanceId as string | undefined
    if (!localVoxel || !instanceId) return intersectionVoxel(hit, 'customVoxels', 'customVoxel')
    const instance = project.instances.find((candidate) => candidate.id === instanceId)
    const asset = instance ? project.assets.find((candidate) => candidate.id === instance.assetId) : undefined
    return instance && asset ? instanceLocalVoxelToSceneVoxel(instance, asset, localVoxel) : undefined
  }

  const applyEditAtPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const context = getPointerContext(event)
    if (!context) return
    const { rawHits, hits, floorPoint } = context
    const hit = hits[0]
    if (tool === 'select' && editEntityId) return
    if (tool === 'select' && hit?.object.userData.scenePartId && belongsToEditEntity(hit.object)) {
      onSelect(hit.object.userData.scenePartId)
      return
    }
    if (tool !== 'brush' && tool !== 'erase') return
    // Edit mode changes rendering emphasis, not physical occupancy. If a
    // different entity is the first visible voxel hit, use that entity only as
    // a collision surface. The new voxel is still handed to the current edit
    // target, so editing can build against another entity without modifying
    // the entity that was clicked.
    if (editEntityId) {
      const firstVoxelHit = rawHits.find((item) => {
        const hasVoxel = Boolean(intersectionVoxel(item, 'instanceVoxels', 'instanceVoxel') || intersectionVoxel(item, 'customVoxels', 'customVoxel'))
        return hasVoxel
      })
      if (firstVoxelHit && !belongsToEditEntity(firstVoxelHit.object)) {
        const hitVoxel = sceneVoxelFromHit(firstVoxelHit)
        if (tool === 'brush' && hitVoxel && firstVoxelHit.face) {
          const displayNormal = firstVoxelHit.face.normal.clone().transformDirection(firstVoxelHit.object.matrixWorld)
          onAddVoxel(adjacentVoxel(hitVoxel, { x: displayNormal.x, y: displayNormal.z, z: displayNormal.y }, activeMaterial))
        } else {
          onNotice('擦除模式只能作用于当前编辑实体 · 其他实体仍会阻挡穿透')
        }
        return
      }
    }
    const instanceHit = hits.find((item) => item.object.userData.instanceId && intersectionVoxel(item, 'instanceVoxels', 'instanceVoxel') && belongsToEditEntity(item.object))
    if (instanceHit?.object.userData.instanceId) {
      const instanceId = instanceHit.object.userData.instanceId as string
      const localHitVoxel = intersectionVoxel(instanceHit, 'instanceVoxels', 'instanceVoxel')
      if (!localHitVoxel) return
      if (!editEntityId) {
        const hitVoxel = sceneVoxelFromHit(instanceHit)
        if (!hitVoxel) return
        if (tool === 'brush' && instanceHit.face) {
          const displayNormal = instanceHit.face.normal.clone().transformDirection(instanceHit.object.matrixWorld)
          onAddVoxel(adjacentVoxel(hitVoxel, { x: displayNormal.x, y: displayNormal.z, z: displayNormal.y }, activeMaterial))
        } else {
          onNotice('非编辑模式下不能擦除资产实体 · 请先进入编辑模式')
        }
      } else if (tool === 'brush') {
        if (!instanceHit.face) return
        const displayNormal = instanceHit.face.normal.clone().transformDirection(instanceHit.object.matrixWorld)
        onEditInstanceVoxel(instanceId, adjacentVoxel(localHitVoxel, { x: displayNormal.x, y: displayNormal.z, z: displayNormal.y }, activeMaterial), 'add')
      } else {
        onEditInstanceVoxel(instanceId, localHitVoxel, 'remove')
      }
      return
    }
    const ddaCustomOwner = context.voxelHit?.ownerIds.find((ownerId) => ownerId.startsWith('custom:'))
    if (ddaCustomOwner && (!editEntityId || ddaCustomOwner === editEntityId)) {
      const hitVoxel = project.customVoxels.find((voxel) => voxelEntityId(voxel) === ddaCustomOwner.slice('custom:'.length)
        && voxel.x === context.voxelHit!.voxel.x
        && voxel.y === context.voxelHit!.voxel.y
        && voxel.z === context.voxelHit!.voxel.z)
      if (hitVoxel) {
        if (tool === 'brush') onAddVoxel(adjacentVoxel(hitVoxel, context.voxelHit!.normal, activeMaterial))
        else onRemoveVoxel(hitVoxel)
        return
      }
    }
    const customHit = hits.find((item) => intersectionVoxel(item, 'customVoxels', 'customVoxel') && belongsToEditEntity(item.object))
    if (customHit) {
      const hitVoxel = intersectionVoxel(customHit, 'customVoxels', 'customVoxel')
      if (!hitVoxel) return
      if (tool === 'brush') {
        if (!customHit.face) return
        const displayNormal = customHit.face.normal.clone().transformDirection(customHit.object.matrixWorld)
        onAddVoxel(adjacentVoxel(hitVoxel, { x: displayNormal.x, y: displayNormal.z, z: displayNormal.y }, activeMaterial))
      } else onRemoveVoxel(hitVoxel)
      return
    }
    if (!floorPoint) return
    const x = worldToVoxelCell(floorPoint.x)
    const z = worldToVoxelCell(floorPoint.y)
    const sceneVoxel = { x, y: 0, z, materialId: activeMaterial }
    const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
    const occupiedAsset = project.instances.find((instance) => {
      if (!instance.visible) return false
      const asset = assetMap.get(instance.assetId)
      return asset ? Boolean(findInstanceVoxelAtSceneVoxel(instance, asset, sceneVoxel)) : false
    })
    if (occupiedAsset) {
      const asset = assetMap.get(occupiedAsset.assetId)
      const localVoxel = asset ? findInstanceVoxelAtSceneVoxel(occupiedAsset, asset, sceneVoxel) : undefined
      if (editEntityId && tool === 'erase' && localVoxel) onEditInstanceVoxel(occupiedAsset.id, localVoxel, 'remove')
      else onNotice('目标网格已有资产体素 · 请点击资产表面编辑')
      return
    }
    if (tool === 'brush') {
      if (project.customVoxels.some((voxel) => voxel.x === x && voxel.y === 0 && voxel.z === z)) onNotice('目标网格已有体素 · 请点击体素表面添加')
      else onAddVoxel(sceneVoxel)
    } else {
      const highest = highestVoxelAt(project.customVoxels, x, z)
      if (highest) onRemoveVoxel(highest)
    }
  }

  const handleEditPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 0 || event.button === 2) setSceneContextMenu(null)
    if (event.button === 0 || event.button === 2) event.currentTarget.setPointerCapture(event.pointerId)
    if (event.button === 2) {
      if (placementAsset) return
      if (tool === 'select') onCancelPendingEntityOperation()
      const context = getPointerContext(event)
      const hit = context?.hits.find((item) => item.object.userData.scenePartId)
      const hitPartId = context?.voxelHit?.ownerIds[0] ?? hit?.object.userData.scenePartId
      const hitPart = hitPartId ? sceneEntityParts(project).find((part) => part.id === hitPartId) : undefined
      const explicitMultiSelection = selectedPartIds.length > 1 && (checkedPartIds.length > 1 || (checkedPartIds.length === 1 && !checkedPartIds[0].startsWith('assembly:')))
      const targetPartIds = !editEntityId && hitPart
        ? explicitMultiSelection && selectedPartIds.includes(hitPart.id) ? selectedPartIds : hitSelectionPartIds(hitPart)
        : []
      cameraGestureRef.current = { pointerId: event.pointerId, button: 'right', lastX: event.clientX, lastY: event.clientY, moved: false, contextPartIds: targetPartIds }
      if (controlsRef.current) controlsRef.current.enabled = false
      return
    }
    if (event.button !== 0) return
    if (placementAsset) return
    // A scene click starts a new selection/drag interaction. Any pending
    // entity operation must be abandoned before that interaction begins.
    if (tool === 'select') onCancelPendingEntityOperation()
    if (editEntityId && tool === 'select') return
    if (tool === 'select') {
      const context = getPointerContext(event)
      const customHit = context?.hits.find((item) => intersectionVoxel(item, 'customVoxels', 'customVoxel'))
      const hit = customHit ?? context?.hits.find((item) => item.object.userData.scenePartId)
      const floorPoint = context?.floorPoint
      const sceneParts = sceneEntityParts(project)
      const hitPartId = context?.voxelHit?.ownerIds[0] ?? hit?.object.userData.scenePartId
      const hitPart = hitPartId ? sceneParts.find((part) => part.id === hitPartId) : undefined
      if (hitPart) {
        const explicitMultiSelection = selectedPartIds.length > 1 && (checkedPartIds.length > 1 || (checkedPartIds.length === 1 && !checkedPartIds[0].startsWith('assembly:')))
        const selectedParts = explicitMultiSelection && selectedPartIds.includes(hitPart.id)
          ? sceneParts.filter((part) => selectedPartIds.includes(part.id))
          : [hitPart]
        const instanceId = hitPart.instanceId
        const instance = instanceId ? project.instances.find((item) => item.id === instanceId) : undefined
        if (event.metaKey || event.shiftKey) {
          onSelectMultiple(hitSelectionPartIds(hitPart), true)
          onNotice('已加入复选 · 可继续选择多个实体')
          return
        }
        onSelect(hitPart.id)
        if (selectedParts.every((part) => lockedPartIds.has(part.id))) {
          onNotice('当前实体已固定 · 请先在右键菜单中取消固定')
          return
        }
        const movableParts = selectedParts.filter((part) => !lockedPartIds.has(part.id))
        const anchorVoxel = hitPart.voxels[0]
        const anchor = instance
          ? toSceneWorld(instance.x, instance.y ?? 0, instance.z)
          : toSceneWorld(voxelCenterToWorld(anchorVoxel?.x ?? 0), voxelCenterToWorld(anchorVoxel?.y ?? 0), voxelCenterToWorld(anchorVoxel?.z ?? 0))
        const selectionLabel = selectedParts.some((part) => part.assemblyId || part.assemblyIds?.length) ? '已选中装配体' : '已选中实体'
        onNotice(`${selectionLabel} · ${selectedParts.length} 个零件`)
        selectGestureRef.current = {
          pointerId: event.pointerId,
          kind: 'parts',
          parts: movableParts,
          startX: event.clientX,
          startY: event.clientY,
          startGroundX: floorPoint?.x ?? 0,
          startGroundY: floorPoint?.y ?? 0,
          startVerticalZ: getVerticalPoint(makeVerticalPlane(anchor))?.z ?? anchor.z,
          verticalPlane: makeVerticalPlane(anchor),
          lastDeltaX: 0,
          lastDeltaY: 0,
          lastDeltaZ: 0,
          visualRoots: collectDragVisualRoots(movableParts.map((part) => part.id)),
          moved: false,
        }
        onInteractionChange(true)
      } else {
        boxSelectGestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY, additive: event.metaKey || event.shiftKey, moved: false }
        setSceneSelectionBox(null)
        if (controlsRef.current) controlsRef.current.enabled = false
      }
      if (controlsRef.current) controlsRef.current.enabled = false
      return
    }
    if (tool !== 'brush' && tool !== 'erase') return
    editGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
  }

  const handleEditPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (placementAsset) {
      const context = getPointerContext(event)
      showPlacementPreview(context?.floorPoint ? onPreviewPlacement(placementAsset.id, context.floorPoint.x, context.floorPoint.y) : null)
      return
    }
    const cameraGesture = cameraGestureRef.current
    if (cameraGesture?.pointerId === event.pointerId) {
      const controls = controlsRef.current
      if (controls) {
        const deltaX = event.clientX - cameraGesture.lastX
        const deltaY = event.clientY - cameraGesture.lastY
        if (Math.hypot(event.clientX - cameraGesture.lastX, event.clientY - cameraGesture.lastY) > 2) cameraGesture.moved = true
        controls.pan(deltaX, deltaY)
        controls.update()
        invalidateRenderRef.current(120)
      }
      cameraGesture.lastX = event.clientX
      cameraGesture.lastY = event.clientY
      return
    }
    const boxGesture = boxSelectGestureRef.current
    if (boxGesture?.pointerId === event.pointerId) {
      boxGesture.currentX = event.clientX
      boxGesture.currentY = event.clientY
      boxGesture.moved = boxGesture.moved || Math.hypot(event.clientX - boxGesture.startX, event.clientY - boxGesture.startY) > 5
      const rect = rendererRef.current?.domElement.getBoundingClientRect()
      if (rect && boxGesture.moved) {
        setSceneSelectionBox({
          left: Math.min(boxGesture.startX, event.clientX) - rect.left,
          top: Math.min(boxGesture.startY, event.clientY) - rect.top,
          width: Math.abs(event.clientX - boxGesture.startX),
          height: Math.abs(event.clientY - boxGesture.startY),
        })
      }
      return
    }
    const selectGesture = selectGestureRef.current
    if (selectGesture?.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - selectGesture.startX, event.clientY - selectGesture.startY) > 5) selectGesture.moved = true
      const context = getPointerContext(event)
      if (!selectGesture.moved || !context || (dragAxis === 'horizontal' && !context.floorPoint)) return
      const parts = selectGesture.parts
      if (dragAxis === 'vertical') {
        const verticalPoint = getVerticalPoint(selectGesture.verticalPlane)
        if (!verticalPoint) return
        const deltaZ = worldToVoxel(verticalPoint.z - selectGesture.startVerticalZ)
        if (deltaZ === selectGesture.lastDeltaY) return
        const moveResult = onPreviewScenePartsMove(parts, 0, deltaZ, 0)
        selectGesture.lastDeltaX = moveResult.deltaX
        selectGesture.lastDeltaY = moveResult.deltaY
        selectGesture.lastDeltaZ = moveResult.deltaZ
        setDragVisualOffset(selectGesture, moveResult.deltaX, moveResult.deltaY, moveResult.deltaZ)
        return
      }
      const deltaX = worldToVoxel(context.floorPoint!.x - selectGesture.startGroundX)
      const deltaZ = worldToVoxel(context.floorPoint!.y - selectGesture.startGroundY)
      if (deltaX === selectGesture.lastDeltaX && deltaZ === selectGesture.lastDeltaZ) return
      const moveResult = onPreviewScenePartsMove(parts, deltaX, 0, deltaZ)
      selectGesture.lastDeltaX = moveResult.deltaX
      selectGesture.lastDeltaY = moveResult.deltaY
      selectGesture.lastDeltaZ = moveResult.deltaZ
      setDragVisualOffset(selectGesture, moveResult.deltaX, moveResult.deltaY, moveResult.deltaZ)
      return
    }
    const gesture = editGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.moved = true
  }

  const handleEditPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (placementAsset) {
      const context = getPointerContext(event)
      const preview = context?.floorPoint ? onPreviewPlacement(placementAsset.id, context.floorPoint.x, context.floorPoint.y) : placementPreviewRef.current
      if (preview) onPlaceAsset(placementAsset.id, preview.x, preview.z)
      else onNotice('请将资产放置在三维场地内')
      return
    }
    const cameraGesture = cameraGestureRef.current
    if (cameraGesture?.pointerId === event.pointerId) {
      cameraGestureRef.current = null
      if (controlsRef.current) controlsRef.current.enabled = true
      if (cameraGesture.button === 'right' && !cameraGesture.moved && cameraGesture.contextPartIds?.length) setSceneContextMenu({ partIds: cameraGesture.contextPartIds, x: event.clientX, y: event.clientY })
      return
    }
    const boxGesture = boxSelectGestureRef.current
    if (boxGesture?.pointerId === event.pointerId) {
      boxSelectGestureRef.current = null
      setSceneSelectionBox(null)
      if (controlsRef.current) controlsRef.current.enabled = true
      const selectedPartIds = boxGesture.moved ? scenePartIdsInBox(boxGesture.startX, boxGesture.startY, boxGesture.currentX, boxGesture.currentY) : []
      onSelectMultiple(selectedPartIds, boxGesture.additive)
      onNotice(selectedPartIds.length ? `已框选 ${selectedPartIds.length} 个实体` : '已取消选择')
      return
    }
    const selectGesture = selectGestureRef.current
    if (selectGesture?.pointerId === event.pointerId) {
      selectGestureRef.current = null
      commitDragGesture(selectGesture)
      onInteractionChange(false)
      if (controlsRef.current) controlsRef.current.enabled = true
      return
    }
    const gesture = editGestureRef.current
    editGestureRef.current = null
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.moved) return
    applyEditAtPointer(event)
  }

  const handleEditPointerCancel = () => {
    if (placementAsset) return
    cameraGestureRef.current = null
    boxSelectGestureRef.current = null
    setSceneSelectionBox(null)
    editGestureRef.current = null
    if (selectGestureRef.current) resetDragVisuals(selectGestureRef.current)
    selectGestureRef.current = null
    onInteractionChange(false)
    if (controlsRef.current) controlsRef.current.enabled = true
  }

  useEffect(() => {
    const finishWindowPointer = (event: PointerEvent) => {
      const cameraGesture = cameraGestureRef.current
      if (cameraGesture?.pointerId === event.pointerId) {
        cameraGestureRef.current = null
        if (controlsRef.current) controlsRef.current.enabled = true
        if (cameraGesture.button === 'right' && !cameraGesture.moved && cameraGesture.contextPartIds?.length) {
          setSceneContextMenu({ partIds: cameraGesture.contextPartIds, x: event.clientX, y: event.clientY })
        }
        return
      }
      const boxGesture = boxSelectGestureRef.current
      if (boxGesture?.pointerId === event.pointerId) {
        boxSelectGestureRef.current = null
        setSceneSelectionBox(null)
        if (controlsRef.current) controlsRef.current.enabled = true
        const selectedPartIds = boxGesture.moved ? scenePartIdsInBox(boxGesture.startX, boxGesture.startY, event.clientX, event.clientY) : []
        onSelectMultiple(selectedPartIds, boxGesture.additive)
        onNotice(selectedPartIds.length ? `已框选 ${selectedPartIds.length} 个实体` : '已取消选择')
        return
      }
      if (selectGestureRef.current?.pointerId === event.pointerId) {
        const selectGesture = selectGestureRef.current
        selectGestureRef.current = null
        commitDragGesture(selectGesture)
        onInteractionChange(false)
        if (controlsRef.current) controlsRef.current.enabled = true
        return
      }
      editGestureRef.current = null
    }
    const cancelWindowPointer = () => {
      cameraGestureRef.current = null
      boxSelectGestureRef.current = null
      setSceneSelectionBox(null)
      editGestureRef.current = null
      if (selectGestureRef.current) resetDragVisuals(selectGestureRef.current)
      selectGestureRef.current = null
      onInteractionChange(false)
      if (controlsRef.current) controlsRef.current.enabled = true
    }
    window.addEventListener('pointerup', finishWindowPointer)
    window.addEventListener('pointercancel', cancelWindowPointer)
    window.addEventListener('blur', cancelWindowPointer)
    return () => {
      window.removeEventListener('pointerup', finishWindowPointer)
      window.removeEventListener('pointercancel', cancelWindowPointer)
      window.removeEventListener('blur', cancelWindowPointer)
    }
  }, [onNotice, onSelectMultiple])

  const handlePlacementDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    const assetId = placementAsset?.id ?? event.dataTransfer.getData('application/x-moce-asset')
    if (!assetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const context = getPointerContext(event)
    showPlacementPreview(context?.floorPoint ? onPreviewPlacement(assetId, context.floorPoint.x, context.floorPoint.y) : null)
  }

  const handlePlacementDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const assetId = placementAsset?.id ?? event.dataTransfer.getData('application/x-moce-asset')
    if (!assetId) return
    event.preventDefault()
    const context = getPointerContext(event)
    if (!context?.floorPoint) {
      onNotice('请将资产放置在三维场地内')
      return
    }
    const preview = onPreviewPlacement(assetId, context.floorPoint.x, context.floorPoint.y)
    if (preview) onPlaceAsset(assetId, preview.x, preview.z)
  }

  const sceneContextLocked = Boolean(sceneContextMenu?.partIds.length && sceneContextMenu.partIds.every((partId) => lockedPartIds.has(partId)))
  const sceneContextEditTargetId = sceneContextMenu?.partIds.length === 1 ? sceneContextMenu.partIds[0] : ''
  const sceneContextRenameTargetId = sceneContextMenu?.partIds.length === 1 ? sceneContextMenu.partIds[0] : ''
  return <div className={`viewport-canvas ${ready ? 'ready' : ''}`} ref={mountRef} onPointerDown={handleEditPointerDown} onPointerMove={handleEditPointerMove} onPointerUp={handleEditPointerUp} onPointerCancel={handleEditPointerCancel} onContextMenu={(event) => event.preventDefault()} onDragOver={handlePlacementDragOver} onDrop={handlePlacementDrop}><div className="viewport-scene-tree-overlay" onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}>{children}</div>{sceneSelectionBox && <div className="scene-selection-box" style={sceneSelectionBox} />}{sceneContextMenu && <div className="scene-context-menu" style={{ left: sceneContextMenu.x, top: sceneContextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>{sceneContextRenameTargetId && <button onClick={() => { onRename(sceneContextRenameTargetId); setSceneContextMenu(null) }}>重命名</button>}{sceneContextEditTargetId && <button onClick={() => { onEnterEditMode(sceneContextEditTargetId); setSceneContextMenu(null) }}>进入编辑修改模式</button>}{sceneContextMenu.partIds.length >= 2 && <button onClick={() => { onBatchOperation(sceneContextMenu.partIds, 'assemble'); setSceneContextMenu(null) }}>组装所选实体</button>}<button onClick={() => { onBatchOperation(sceneContextMenu.partIds, 'lock'); setSceneContextMenu(null) }}>{sceneContextLocked ? '取消固定所选实体' : '固定所选实体'}</button><button className="danger" onClick={() => { onBatchOperation(sceneContextMenu.partIds, 'delete'); setSceneContextMenu(null) }}>删除所选实体</button></div>}<svg ref={axisGizmoRef} className="axis-gizmo" viewBox="0 0 64 64" aria-label="当前视图坐标系"><line data-axis-line="x" x1="32" y1="32" x2="56" y2="32" /><line data-axis-line="y" x1="32" y1="32" x2="32" y2="8" /><line data-axis-line="z" x1="32" y1="32" x2="32" y2="8" /><text data-axis-label="x" x="56" y="32">X</text><text data-axis-label="y" x="32" y="8">Y</text><text data-axis-label="z" x="32" y="8">Z</text></svg>{editEntityId && <button className="viewport-edit-exit" aria-label="退出编辑修改模式" title="退出编辑修改模式" onPointerDown={(event) => event.stopPropagation()} onClick={onExitEditMode}><X size={16} /></button>}<ViewportPalette materials={materials} activeMaterial={activeMaterial} onSelectMaterial={onSelectMaterial} onReplaceMaterial={onReplaceMaterial} /><ViewportCameraControls showActions={false} onRotate={rotateCameraByInput} onView={(view) => { applyCameraView(view); onNotice(`已切换视角 · ${cameraViewLabel(view)}`) }} onReset={() => { applyCameraView('default', 100); onZoomChange(100); onNotice('视角已回中 · 缩放已恢复 100%') }} /></div>
}

function buildAssetGroup(asset: VoxelAsset, materialMap: Map<string, THREE.MeshStandardMaterial>, overrides: VoxelOverride[] = [], partOffsets: SceneInstance['partOffsets'] = {}, rotation = 0, colorOverride?: string, mirror: SceneInstance['mirror'] = undefined, rotationX = 0, rotationY = 0, rotationZ = 0) {
  const group = new THREE.Group()
  const scale = VOXEL_WORLD_SIZE
  const voxels = resolveInstanceVoxels(asset, overrides)
  group.rotation.set(rotationX * Math.PI / 180, rotationY * Math.PI / 180, -(rotation + rotationZ) * Math.PI / 180)
  if (!voxels.length) {
    const placeholder = new THREE.Mesh(new THREE.BoxGeometry(asset.width * scale, asset.depth * scale, asset.height * scale), new THREE.MeshStandardMaterial({ color: asset.color, roughness: 0.76 }))
    placeholder.position.z = asset.height * scale / 2
    placeholder.userData.instanceId = asset.id
    group.add(placeholder)
    return group
  }
  for (const { partId, voxels: component } of resolveInstanceComponents(asset, overrides)) {
    const occupied = new Set(component.map((candidate) => `${candidate.x},${candidate.y},${candidate.z}`))
    const partGroup = new THREE.Group()
    const offset = partOffsets?.[partId] ?? { x: 0, y: 0, z: 0 }
    partGroup.position.set(mirror?.x ? -offset.x : offset.x, mirror?.y ? -offset.z : offset.z, mirror?.z ? -offset.y : offset.y)
    partGroup.userData.instancePartId = partId
    const batches = new Map<string, { color: THREE.Color; voxels: Voxel[] }>()
    component.forEach((voxel) => {
      const color = new THREE.Color(
        colorOverride
        ?? asset.templateColor
        ?? (voxel.materialId === 'primary'
          ? asset.color
          : voxel.materialId === 'accent'
            ? asset.accent
            : materialMap.get(voxel.materialId)?.color.getStyle()
              ?? (voxel.materialId.startsWith('#') ? voxel.materialId : asset.color)),
      )
      const key = color.getHexString()
      const batch = batches.get(key) ?? { color, voxels: [] }
      batch.voxels.push(voxel)
      batches.set(key, batch)
    })
    batches.forEach(({ color, voxels }) => {
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.03 })
      const mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, material, voxels.length)
      const matrix = new THREE.Matrix4()
      voxels.forEach((voxel, index) => {
        const localXIndex = mirror?.x ? asset.width - 1 - voxel.x : voxel.x
        const localYIndex = mirror?.z ? asset.height - 1 - voxel.y : voxel.y
        const localZIndex = mirror?.y ? asset.depth - 1 - voxel.z : voxel.z
        matrix.makeTranslation((localXIndex + 0.5 - asset.width / 2) * scale, (localZIndex + 0.5 - asset.depth / 2) * scale, (localYIndex + 0.5) * scale)
        mesh.setMatrixAt(index, matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.userData.instanceVoxels = voxels.map((voxel) => ({ ...voxel }))
      mesh.userData.instancePartId = partId
      mesh.userData.outerVoxel = voxels.some((voxel) => exposedVoxelFaces(voxel, occupied).length > 0)
      mesh.castShadow = false
      mesh.receiveShadow = false
      partGroup.add(mesh)
    })
    group.add(partGroup)
  }
  return group
}

const rootElement = document.getElementById('root')!
const globalWithRoot = globalThis as typeof globalThis & { __moceRoot?: ReturnType<typeof createRoot> }
const appRoot = globalWithRoot.__moceRoot ?? createRoot(rootElement)
globalWithRoot.__moceRoot = appRoot
appRoot.render(<React.StrictMode><App /></React.StrictMode>)
