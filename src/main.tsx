import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Box, Brush, ChevronDown, ChevronRight, CircleUserRound, Database, Download, Eraser, Eye, FilePlus2, FolderOpen, Grid3X3, Layers3, Lock, Minus, Move3d, Paintbrush, Palette, Plus, Redo2, RotateCcw, RotateCw, Save, Search, Settings, SlidersHorizontal, SquareDashedMousePointer, Trash2, Undo2, Upload, WandSparkles, X } from 'lucide-react'
import { AssetAssembly, MATERIALS, Material, ProjectState, SceneEntityPart, SceneInstance, Voxel, VoxelAsset, VoxelOverride, VOXEL_WORLD_SIZE, adjacentVoxel, findInstanceVoxelAtSceneVoxel, highestVoxelAt, makeAssetFromSceneParts, makeDefaultProject, makeStl, mirrorVoxels, normalizeProjectNaming, resolveInstanceComponents, resolveInstanceSceneVoxels, resolveInstanceVoxels, rotateVoxels, sceneAssemblies, sceneEntityParts, snapWorld, uniqueAssetName, voxelCenterToWorld, voxelComponentAt, voxelComponentId, voxelComponents, voxelEntityId, voxelToWorld, worldToVoxel } from './voxel'
import { importModelAsVoxelAsset } from './model-import'
import { LibraryResponse, loadAsset, loadLibrary, loadScene, saveAsset, saveScene } from './persistence'
import './styles.css'

type Tool = 'select' | 'brush' | 'erase'
type CameraViewId = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'front-top' | 'front-bottom' | 'back-top' | 'back-bottom' | 'front-left' | 'front-right' | 'back-left' | 'back-right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'front-top-left' | 'front-top-right' | 'front-bottom-left' | 'front-bottom-right' | 'back-top-left' | 'back-top-right' | 'back-bottom-left' | 'back-bottom-right'
type CameraView = 'default' | CameraViewId
type CameraControlApi = {
  rotate: (deltaX: number, deltaY: number) => void
  view: (view: CameraViewId) => void
  reset: () => void
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
  historyTracked: boolean
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

type TreeContextMenuState = {
  targetId: string
  assemblyId?: string
  x: number
  y: number
} | null

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

function scenePartBaseName(project: ProjectState, part: SceneEntityPart): string {
  if (part.kind === 'custom') return part.label ?? '手动体素实体'
  const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
  const asset = instance ? project.assets.find((item) => item.id === instance.assetId) : undefined
  return `${asset?.name ?? '场景实体'}${part.label && part.label !== part.partId ? ` · ${part.label}` : ''}`
}

function normalizeStoredProject(loaded: ProjectState): ProjectState {
  const defaultAssets = new Map(makeDefaultProject().assets.map((asset) => [asset.id, asset]))
  const normalized: ProjectState = {
    ...loaded,
    assets: (loaded.assets ?? []).map((asset) => ({
      ...asset,
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
    instances: (loaded.instances ?? []).map((instance) => ({ ...instance, x: snapWorld(instance.x), y: snapWorld(instance.y ?? 0), z: snapWorld(instance.z), overrides: instance.overrides ?? [], partOffsets: instance.partOffsets ?? {} })),
    lockedMemberKeys: [...new Set(loaded.lockedMemberKeys ?? [])],
  }
  return normalizeProjectNaming(normalized)
}

function scenePartIsLocked(project: ProjectState, part: SceneEntityPart): boolean {
  const lockedKeys = new Set(project.lockedMemberKeys ?? [])
  if (lockedKeys.has(part.memberKey)) return true
  const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
  return assemblyIds.some((assemblyId) => {
    const assembly = project.assemblies?.find((item) => item.id === assemblyId)
    return Boolean(assembly?.memberKeys.some((memberKey) => lockedKeys.has(memberKey) || memberKey === part.memberKey))
  })
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

function App() {
  const [project, setProject] = useState<ProjectState>(() => normalizeStoredProject(makeDefaultProject()))
  const projectRef = useRef(project)
  const historyRef = useRef<{ past: ProjectState[]; future: ProjectState[] }>({ past: [], future: [] })
  const [historyRevision, setHistoryRevision] = useState(0)
  const [selectedId, setSelectedId] = useState('inst-chinese')
  const [tool, setTool] = useState<Tool>('select')
  const [activeStyle, setActiveStyle] = useState('全部')
  const [activeMaterial, setActiveMaterial] = useState('terracotta')
  const [recentMaterialIds, setRecentMaterialIds] = useState(() => MATERIALS.slice(0, 8).map((material) => material.id))
  const [notice, setNotice] = useState('就绪 · 本地工程未保存')
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<'正交' | '透视'>('正交')
  const [showGrid, setShowGrid] = useState(true)
  const [showGround, setShowGround] = useState(true)
  const [dragAxis, setDragAxis] = useState<'horizontal' | 'vertical'>('horizontal')
  const [editEntityId, setEditEntityId] = useState<string | null>(null)
  const [placementAssetId, setPlacementAssetId] = useState<string | null>(null)
  const [placementPreview, setPlacementPreview] = useState<PlacementPreview | null>(null)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [cameraControlApi, setCameraControlApi] = useState<CameraControlApi | null>(null)
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>('loading')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [library, setLibrary] = useState<LibraryResponse>({ assets: [], scenes: [] })
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [assetSidebarCollapsed, setAssetSidebarCollapsed] = useState(false)
  const [expandedAssemblies, setExpandedAssemblies] = useState<Record<string, boolean>>({})
  const [checkedTreePartIds, setCheckedTreePartIds] = useState<string[]>([])
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState>(null)
  const persistenceReadyRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)

  const sceneParts = useMemo(() => sceneEntityParts(project), [project])
  const lockedPartIds = useMemo(() => new Set(sceneParts.filter((part) => scenePartIsLocked(project, part)).map((part) => part.id)), [project, sceneParts])
  const selectedAssemblyId = selectedId.startsWith('assembly:') ? selectedId.slice('assembly:'.length) : undefined
  const selectedScenePart = sceneParts.find((part) => part.id === selectedId) ?? sceneParts.find((part) => part.instanceId === selectedId)
  const selectedInstance = selectedScenePart?.instanceId ? project.instances.find((instance) => instance.id === selectedScenePart.instanceId) : project.instances.find((instance) => instance.id === selectedId)
  const selectedAsset = selectedInstance ? project.assets.find((asset) => asset.id === selectedInstance.assetId) : undefined
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
  const sceneTreeItems = useMemo<SceneTreeItem[]>(() => {
    const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
    const baseNameForPart = (part: SceneEntityPart) => {
      const storedName = project.entityNames?.[part.memberKey]
      if (storedName) return storedName
      if (part.kind === 'custom') return part.label ?? '手动体素实体'
      const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
      const asset = instance ? assetMap.get(instance.assetId) : undefined
      return `${asset?.name ?? '场景实体'}${part.label && part.label !== part.partId ? ` · ${part.label}` : ''}`
    }
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
      historyRef.current.past = [...historyRef.current.past, structuredClone(projectRef.current)].slice(-50)
      historyRef.current.future = []
    }
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
      void saveScene(CURRENT_SCENE_ID, normalized).catch(() => setPersistenceStatus('offline'))
      setNotice(`已加载后端场景 · ${normalized.name}`)
    }).catch(async (error: unknown) => {
      if (cancelled) return
      if (error instanceof Error && error.message.includes('场景不存在')) {
        try {
          await saveScene(CURRENT_SCENE_ID, projectRef.current)
          persistenceReadyRef.current = true
          setPersistenceStatus('saved')
          setNotice('已创建后端场景 · 莫测里·第一街区')
        } catch {
          setPersistenceStatus('offline')
          setNotice('后端场景不可用 · 当前使用本地草稿')
        }
      } else {
        setPersistenceStatus('offline')
        setNotice('后端连接失败 · 当前使用本地草稿')
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!persistenceReadyRef.current) return
    const timer = window.setTimeout(() => {
      saveScene(CURRENT_SCENE_ID, project).then(() => setPersistenceStatus('saved')).catch(() => setPersistenceStatus('offline'))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [project])

  const undoProject = () => {
    const previous = historyRef.current.past.pop()
    if (!previous) {
      setNotice('没有可撤销的操作')
      return
    }
    historyRef.current.future.push(structuredClone(projectRef.current))
    projectRef.current = previous
    setProject(previous)
    setHistoryRevision((value) => value + 1)
    setNotice('已撤销')
  }

  const redoProject = () => {
    const next = historyRef.current.future.pop()
    if (!next) {
      setNotice('没有可重做的操作')
      return
    }
    historyRef.current.past.push(structuredClone(projectRef.current))
    projectRef.current = next
    setProject(next)
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
    const assetNeighbor = currentParts.find((part) => part.kind === 'asset' && part.voxels.some((candidate) => neighbors.some((neighbor) => sceneVoxelKey(candidate) === sceneVoxelKey(neighbor))))
    const touchingCustomIds = [...new Set(currentProject.customVoxels.filter((candidate) => neighbors.some((neighbor) => sceneVoxelKey(candidate) === sceneVoxelKey(neighbor))).map(voxelEntityId))]
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
    if (assetNeighbor?.instanceId) {
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
      setNotice('当前处于实体编辑模式 · 请点击当前实体表面或相邻面进行修改')
      return
    }
    const entityId = touchingCustomIds[0] ?? editingCustomId ?? voxel.entityId ?? `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    updateProject((draft) => {
      const exists = draft.customVoxels.some((item) => item.x === voxel.x && item.y === voxel.y && item.z === voxel.z)
      if (exists) return
      draft.customVoxels = draft.customVoxels.map((item) => touchingCustomIds.includes(voxelEntityId(item)) ? { ...item, entityId } : item)
      draft.customVoxels.push({ ...voxel, entityId })
      if (touchingCustomIds.length > 1) {
        draft.assemblies = (draft.assemblies ?? []).filter((assembly) => !assembly.memberKeys.some((memberKey) => touchingCustomIds.some((id) => memberKey === `voxel:${id}`)))
      }
    })
    const customEntitySelectionId = `custom:${entityId}`
    setSelectedId(customEntitySelectionId)
    if (!touchingCustomIds.length && !editingCustomId) setEditEntityId(customEntitySelectionId)
    setNotice(touchingCustomIds.length || editingCustomId ? `已在用户实体上添加体素 · ${voxel.x}, ${voxel.y}, ${voxel.z}` : `已新建用户实体并进入编辑模式 · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
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
    const currentProject = projectRef.current
    const movingInstance: SceneInstance = { id: 'placement-preview', assetId: asset.id, x, y, z, rotation, style: asset.style, visible: true, overrides }
    const movingKeys = new Set(resolveInstanceSceneVoxels(movingInstance, asset).map(sceneVoxelKey))
    if (currentProject.customVoxels.some((voxel) => movingKeys.has(sceneVoxelKey(voxel)))) return true
    const assetMap = new Map(currentProject.assets.map((item) => [item.id, item]))
    return currentProject.instances.some((other) => {
      if (!other.visible || other.id === excludedInstanceId) return false
      const otherAsset = assetMap.get(other.assetId)
      if (!otherAsset) return false
      const otherKeys = new Set(resolveInstanceSceneVoxels(other, otherAsset).map(sceneVoxelKey))
      return [...movingKeys].some((key) => otherKeys.has(key))
    })
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
    const movingKeys = new Set(component.map((voxel) => sceneVoxelKey({ ...voxel, x: voxel.x + deltaX, y: voxel.y + deltaY, z: voxel.z + deltaZ })))
    const componentKeys = new Set(component.map(sceneVoxelKey))
    if (projectRef.current.customVoxels.some((voxel) => !componentKeys.has(sceneVoxelKey(voxel)) && movingKeys.has(sceneVoxelKey(voxel)))) return true
    const assetMap = new Map(projectRef.current.assets.map((asset) => [asset.id, asset]))
    return projectRef.current.instances.some((instance) => {
      if (!instance.visible) return false
      const asset = assetMap.get(instance.assetId)
      if (!asset) return false
      const occupiedKeys = new Set(resolveInstanceSceneVoxels(instance, asset).map(sceneVoxelKey))
      return [...movingKeys].some((key) => occupiedKeys.has(key))
    })
  }

  const beginPlacement = (asset: VoxelAsset) => {
    setPlacementAssetId(asset.id)
    setPlacementPreview(null)
    setNotice(`正在拖动资产 · ${asset.name}`)
  }

  const endPlacement = () => {
    setPlacementAssetId(null)
    setPlacementPreview(null)
  }

  const assetWithinSceneBoundary = (asset: VoxelAsset, x: number, y: number, z: number) => {
    const boundary = Math.max(1, projectRef.current.sceneSizeCm / 2)
    const previewInstance: SceneInstance = { id: 'placement-preview', assetId: asset.id, x, y, z, rotation: 0, style: asset.style, visible: true, overrides: [] }
    return resolveInstanceSceneVoxels(previewInstance, asset).every((voxel) => {
      const worldX = voxelToWorld(voxel.x)
      const worldY = voxelCenterToWorld(voxel.y)
      const worldZ = voxelToWorld(voxel.z)
      return Math.abs(worldX) <= boundary && Math.abs(worldY) <= boundary && Math.abs(worldZ) <= boundary
    })
  }

  const updatePlacementPreview = (assetId: string, x: number, z: number) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId)
    if (!asset) return
    const position = { assetId, x: snapWorld(x), y: 0, z: snapWorld(z) }
    setPlacementPreview({ ...position, valid: assetWithinSceneBoundary(asset, position.x, position.y, position.z) && !hasAssetCollisionAt(asset, position.x, position.y, position.z) })
  }

  const placeAssetAt = (assetId: string, x: number, z: number) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId)
    if (!asset) return
    const position = { x: snapWorld(x), y: 0, z: snapWorld(z) }
    const outsideBoundary = !assetWithinSceneBoundary(asset, position.x, position.y, position.z)
    if (outsideBoundary || hasAssetCollisionAt(asset, position.x, position.y, position.z)) {
      setNotice(outsideBoundary ? `无法放置资产 · ${asset.name} 超出场景边界` : `无法放置资产 · ${asset.name} 与已有实体重叠`)
      endPlacement()
      return
    }
    const instanceId = `instance-${asset.id}-${Date.now()}`
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
      draft.instances.push({ id: instanceId, assetId: asset.id, ...position, rotation: 0, style: asset.style, visible: true, overrides: [] })
      if (asset.assembly) {
        const nodeIds = new Map(asset.assembly.nodes.map((node) => [node.id, `assembly-${instanceId}-${node.id}`]))
        asset.assembly.nodes.forEach((node) => {
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
          draft.assemblies = [...(draft.assemblies ?? []), { id: sceneAssemblyId, name: node.name || asset.assembly?.name || '装配体', memberKeys }]
        })
        placedRootAssemblyId = nodeIds.get(asset.assembly.rootId) ?? ''
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
    const currentX = worldToVoxel(instance.x)
    const currentY = worldToVoxel(instance.y ?? 0)
    const currentZ = worldToVoxel(instance.z)
    const requestedX = worldToVoxel(x) - currentX
    const requestedY = worldToVoxel(y) - currentY
    const requestedZ = worldToVoxel(z) - currentZ
    const result = resolveGridMove(requestedX, requestedY, requestedZ, (deltaX, deltaY, deltaZ) => !hasInstanceCollisionAt(instanceId, voxelToWorld(currentX + deltaX), voxelToWorld(currentY + deltaY), voxelToWorld(currentZ + deltaZ)))
    if (!result.moved) {
      if (result.blocked) setNotice('资产已抵达碰撞边界 · 该方向无法继续')
      return false
    }
    const nextX = voxelToWorld(currentX + result.deltaX)
    const nextY = voxelToWorld(currentY + result.deltaY)
    const nextZ = voxelToWorld(currentZ + result.deltaZ)
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
    const result = resolveGridMove(deltaX, deltaY, deltaZ, (stepX, stepY, stepZ) => !hasCustomComponentCollisionAt(component, stepX, stepY, stepZ))
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

  const moveSceneParts = (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number, trackHistory = true): GridMoveResult => {
    if (!deltaX && !deltaY && !deltaZ) return { moved: false, blocked: false, deltaX: 0, deltaY: 0, deltaZ: 0 }
    const movableParts = parts.filter((part) => !scenePartIsLocked(projectRef.current, part))
    if (!movableParts.length) {
      setNotice('选中的实体已固定 · 请先取消固定')
      return { moved: false, blocked: true, deltaX: 0, deltaY: 0, deltaZ: 0 }
    }
    const currentParts = sceneEntityParts(projectRef.current)
    const movingIds = new Set(movableParts.map((part) => part.id))
    const movingVoxels = movableParts.flatMap((part) => part.voxels)
    const staticVoxels = currentParts.filter((part) => !movingIds.has(part.id)).flatMap((part) => part.voxels)
    const staticKeys = new Set(staticVoxels.map(sceneVoxelKey))
    const result = resolveGridMove(deltaX, deltaY, deltaZ, (stepX, stepY, stepZ) => movingVoxels.every((voxel) => !staticKeys.has(sceneVoxelKey({ x: voxel.x + stepX, y: voxel.y + stepY, z: voxel.z + stepZ }))))
    if (!result.moved) {
      if (result.blocked) setNotice('实体已抵达碰撞边界 · 该方向无法继续')
      return result
    }
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
        instance.x = voxelToWorld(worldToVoxel(instance.x) + result.deltaX)
        instance.y = voxelToWorld(worldToVoxel(instance.y ?? 0) + result.deltaY)
        instance.z = voxelToWorld(worldToVoxel(instance.z) + result.deltaZ)
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
    commitProject(nextProject, trackHistory)
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

  const saveProject = async () => {
    let persisted = true
    try {
      await saveScene(CURRENT_SCENE_ID, project)
      setPersistenceStatus('saved')
    } catch {
      persisted = false
      setPersistenceStatus('offline')
      setNotice('后端保存失败 · 仍将导出本地工程文件')
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${project.name}.moceworld`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice(persisted ? '工程已保存并导出 · 后端数据库 + .moceworld' : '工程已导出 · .moceworld')
  }

  const openProject = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ProjectState
        replaceProject(normalizeStoredProject({
          ...parsed,
          customVoxels: (parsed.customVoxels ?? []).map((voxel, index) => ({ ...voxel, entityId: voxel.entityId ?? `legacy-${voxel.x}-${voxel.y}-${voxel.z}-${index}` })),
          assemblies: parsed.assemblies ?? [],
          instances: parsed.instances.map((instance) => ({ ...instance, x: snapWorld(instance.x), y: snapWorld(instance.y ?? 0), z: snapWorld(instance.z), overrides: instance.overrides ?? [], partOffsets: instance.partOffsets ?? {} })),
        }))
        setRecentMaterialIds(parsed.materials.slice(0, 8).map((material) => material.id))
        setSelectedId(sceneEntityParts(normalizeStoredProject(parsed))[0]?.id ?? parsed.instances[0]?.id ?? '')
        setNotice(`已打开工程 · ${parsed.name}`)
      } catch {
        setNotice('打开失败 · 文件不是有效的莫测工程')
      }
    }
    reader.readAsText(file)
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

  const importModel = async (file: File) => {
    try {
      setNotice(`正在体素化 · ${file.name}`)
    const imported = await importModelAsVoxelAsset(file, activeMaterial)
    if (!imported.voxels.length) throw new Error('模型没有可转换的表面体素')
      const instanceId = `instance-${imported.id}`
      updateProject((draft) => {
        draft.assets.push(imported)
        draft.instances.push({ id: instanceId, assetId: imported.id, x: 0, y: 0, z: 0, rotation: 0, style: '导入模型', visible: true, overrides: [] })
      })
      setSelectedId(instanceId)
      setNotice(`已完成体素化 · ${imported.voxels.length} 个体素 · ${file.name}`)
    } catch (error) {
      setNotice(`模型导入失败 · ${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  const filteredAssets = project.assets.filter((asset) => asset.isTemplate !== false).filter((asset) => {
    const styleMatch = activeStyle === '全部' || asset.style === activeStyle
    const queryMatch = asset.name.toLowerCase().includes(query.toLowerCase())
    return styleMatch && queryMatch
  })

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
      setLibrary(await loadLibrary())
    } catch {
      setNotice('资产库加载失败 · 请检查后端服务')
    } finally {
      setLibraryBusy(false)
    }
  }

  const openLibrary = async () => {
    setLibraryOpen(true)
    await refreshLibrary()
  }

  const applyStoredProject = (loaded: ProjectState, message: string) => {
    const normalized = normalizeStoredProject(loaded)
    replaceProject(normalized, false)
    setRecentMaterialIds(normalized.materials.slice(0, 8).map((material) => material.id))
    setSelectedId(normalized.instances[0]?.id ?? sceneEntityParts(normalized)[0]?.id ?? '')
    persistenceReadyRef.current = true
    setPersistenceStatus('saved')
    setNotice(message)
  }

  const loadStoredScene = async (sceneId: string, name: string) => {
    setLibraryBusy(true)
    try {
      applyStoredProject(await loadScene(sceneId), `已加载场景 · ${name}`)
      setLibraryOpen(false)
    } catch {
      setNotice('场景加载失败 · 数据库中不存在该场景')
    } finally {
      setLibraryBusy(false)
    }
  }

  const loadStoredAsset = async (assetId: string, name: string) => {
    setLibraryBusy(true)
    try {
      const asset = await loadAsset(assetId)
      updateProject((draft) => {
        if (!draft.assets.some((item) => item.id === asset.id)) draft.assets.push(asset)
      })
      setNotice(`已载入资产 · ${name}`)
    } catch {
      setNotice('资产加载失败 · 数据库中不存在该资产')
    } finally {
      setLibraryBusy(false)
    }
  }

  const saveCurrentSceneAsNew = async () => {
    const requestedName = window.prompt('新场景名称', `${project.name}·副本`)
    if (!requestedName?.trim()) return
    const sceneId = `scene-${Date.now()}`
    try {
      await saveScene(sceneId, { ...project, name: requestedName.trim() })
      await refreshLibrary()
      setNotice(`已保存新场景 · ${requestedName.trim()}`)
    } catch {
      setPersistenceStatus('offline')
      setNotice('新场景保存失败 · 请检查后端服务')
    }
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
    const assemblyRootId = selectedAssemblyId ?? (selectedEntityParts.flatMap((part) => part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).find((assemblyId) => !(project.assemblies ?? []).some((candidate) => candidate.memberKeys.includes(`assembly:${assemblyId}`))))
    const assemblyAsset = assemblyRootId ? makeAssemblyTemplateAsset(projectRef.current, selectedEntityParts, assemblyRootId) : null
    const baseName = assemblyAsset?.name ?? (selectedAsset ? `${selectedAsset.name}·副本` : '自定义体素实体')
    const name = assemblyAsset ? baseName : uniqueAssetName(project.assets, baseName)
    const asset = assemblyAsset ? { ...assemblyAsset, name } : makeAssetFromSceneParts(`asset-custom-${Date.now()}`, name, selectedEntityParts, selectedAsset?.color ?? '#6c827d', selectedAsset?.accent ?? '#d2a354')
    updateProject((draft) => draft.assets.push(asset))
    void saveAsset(asset).catch(() => setPersistenceStatus('offline'))
    setNotice(assemblyAsset ? `已保存装配体模板 · ${name} · 内含 ${selectedEntityParts.length} 个实体` : `已保存为新实体 · ${name}`)
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

  const duplicateSelected = (requestedCount: number) => {
    const sourceProject = projectRef.current
    const sourceParts = selectedEntityParts.map((part) => structuredClone(part))
    if (!sourceParts.length) {
      setNotice('请先选择要复制的实体')
      return
    }
    const count = Math.max(1, Math.min(99, Math.round(requestedCount) || 1))
    const selectedInstanceIds = [...new Set(sourceParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))]
    const selectedCustomIds = [...new Set(sourceParts.filter((part) => part.kind === 'custom').map((part) => part.partId))]
    const assemblies = sourceProject.assemblies ?? []
    const assemblyMap = new Map(assemblies.map((assembly) => [assembly.id, assembly]))
    const selectedAssemblyIds = new Set(sourceParts.flatMap((part) => part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])))
    const rootAssemblyIds = [...selectedAssemblyIds].filter((assemblyId) => ![...selectedAssemblyIds].some((candidateId) => assemblyMap.get(candidateId)?.memberKeys.includes(`assembly:${assemblyId}`)))
    const assemblyTreeIds = new Set<string>()
    const collectAssemblyTree = (assemblyId: string) => {
      if (assemblyTreeIds.has(assemblyId)) return
      assemblyTreeIds.add(assemblyId)
      assemblyMap.get(assemblyId)?.memberKeys.filter((key) => key.startsWith('assembly:')).forEach((key) => collectAssemblyTree(key.slice('assembly:'.length)))
    }
    rootAssemblyIds.forEach(collectAssemblyTree)
    const copyBatchId = Date.now()
    let firstSelection = ''
    updateProject((draft) => {
      const boundary = Math.max(1, draft.sceneSizeCm / 2)
      for (let copyIndex = 0; copyIndex < count; copyIndex += 1) {
        const instanceMap = new Map<string, string>()
        const customMap = new Map<string, string>()
        const clonedInstanceIds: string[] = []
        selectedInstanceIds.forEach((oldId) => {
          const current = draft.instances.find((instance) => instance.id === oldId)
          if (!current) return
          const newId = `${oldId}-copy-${copyBatchId}-${copyIndex + 1}`
          instanceMap.set(oldId, newId)
          clonedInstanceIds.push(newId)
          const offset = copyIndex + 1
          draft.instances.push({
            ...structuredClone(current),
            id: newId,
            x: Math.max(-boundary, Math.min(boundary, snapWorld(current.x + offset))),
            z: Math.max(-boundary, Math.min(boundary, snapWorld(current.z + offset))),
            overrides: structuredClone(current.overrides ?? []),
            partOffsets: structuredClone(current.partOffsets ?? {}),
          })
        })
        selectedCustomIds.forEach((oldId) => {
          const newId = `${oldId}-copy-${copyBatchId}-${copyIndex + 1}`
          customMap.set(oldId, newId)
          const voxelOffset = (copyIndex + 1) * 10
          draft.customVoxels.filter((voxel) => voxelEntityId(voxel) === oldId).forEach((voxel) => {
            draft.customVoxels.push({ ...structuredClone(voxel), x: voxel.x + voxelOffset, z: voxel.z + voxelOffset, entityId: newId })
          })
          if (draft.customColors?.[oldId]) {
            draft.customColors = { ...(draft.customColors ?? {}), [newId]: draft.customColors[oldId] }
          }
        })
        const assemblyMapForCopy = new Map<string, string>()
        ;[...assemblyTreeIds].forEach((oldId) => assemblyMapForCopy.set(oldId, `assembly-${copyBatchId}-${copyIndex + 1}-${oldId}`))
        const mapLeafKey = (memberKey: string) => {
          for (const [oldId, newId] of instanceMap) {
            if (memberKey === `asset:${oldId}` || memberKey.startsWith(`asset:${oldId}:`)) return memberKey.replace(`asset:${oldId}`, `asset:${newId}`)
          }
          for (const [oldId, newId] of customMap) if (memberKey === `voxel:${oldId}`) return `voxel:${newId}`
          return memberKey
        }
        const mapMemberKey = (memberKey: string) => memberKey.startsWith('assembly:')
          ? `assembly:${assemblyMapForCopy.get(memberKey.slice('assembly:'.length)) ?? memberKey.slice('assembly:'.length)}`
          : mapLeafKey(memberKey)
        ;[...assemblyTreeIds].forEach((oldId) => {
          const sourceAssembly = assemblyMap.get(oldId)
          if (!sourceAssembly) return
          draft.assemblies = [...(draft.assemblies ?? []), {
            ...structuredClone(sourceAssembly),
            id: assemblyMapForCopy.get(oldId)!,
            nameMode: 'auto',
            sequence: undefined,
            parentAssemblyId: undefined,
            name: (() => {
              const assemblyNumber = Math.max(1, draft.assemblySequence ?? 1)
              draft.assemblySequence = assemblyNumber + 1
              return `装配体 ${assemblyNumber}`
            })(),
            memberKeys: sourceAssembly.memberKeys.map(mapMemberKey),
          }]
        })
        if (!firstSelection) firstSelection = rootAssemblyIds[0] ? `assembly:${assemblyMapForCopy.get(rootAssemblyIds[0])}` : clonedInstanceIds[0] ? clonedInstanceIds[0] : selectedCustomIds[0] ? `custom:${customMap.get(selectedCustomIds[0])}` : ''
      }
    })
    setCheckedTreePartIds([])
    setSelectedId(firstSelection)
    setNotice(`已复制 ${sourceParts.length} 个选中实体 × ${count} · 装配体结构已保留`)
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
        ? [voxelToWorld(selectedScenePart.voxels[0].x), voxelToWorld(selectedScenePart.voxels[0].z), voxelCenterToWorld(selectedScenePart.voxels[0].y)]
        : [0, 0, 0]
    : [0, 0, 0]

  const changeSelectedTransform = (axis: number, requestedValue: number) => {
    if (!selectedTransformEditable || !selectedScenePart || !Number.isFinite(requestedValue)) return
    const boundary = Math.max(1, projectRef.current.sceneSizeCm / 2)
    const value = Math.max(-boundary, Math.min(boundary, requestedValue))
    if (selectedScenePart.kind === 'asset' && selectedInstance) {
      const property = axis === 0 ? 'x' : axis === 1 ? 'z' : 'y'
      updateProject((draft) => {
        const instance = draft.instances.find((item) => item.id === selectedInstance.id)
        if (!instance) return
        instance[property] = snapWorld(value)
      })
      setNotice(`已更新位置 ${['X', 'Y', 'Z'][axis]} · 已限制在场景边界内`)
      return
    }
    const entityId = selectedScenePart.partId
    const firstVoxel = selectedScenePart.voxels[0]
    if (!firstVoxel) return
    const targetVoxel = axis === 2 ? Math.round(value / VOXEL_WORLD_SIZE - 0.5) : worldToVoxel(value)
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

  const selectedColor = selectedEntityParts[0]?.colorOverride ?? selectedAsset?.color ?? '#6c827d'
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

  const mirrorSelectedEntities = (axis: SceneTransformAxis) => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要镜像的实体')
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
    const removing = checkedTreePartIds.includes(id)
    setCheckedTreePartIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
    setSelectedId(removing && selectedId === id ? '' : id)
    if (!removing && !id.startsWith('assembly:')) revealScenePartPath(id)
    setTreeContextMenu(null)
  }

  const selectScenePart = (id: string) => {
    setSelectedId(id)
    setCheckedTreePartIds([id])
    revealScenePartPath(id)
    setTreeContextMenu(null)
  }

  const updateSceneCheckedSelection = (partIds: string[], additive = false) => {
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
          <ActionButton icon={<FilePlus2 size={17} />} label="新建" onClick={() => { replaceProject(makeDefaultProject()); setSelectedId('inst-chinese'); setNotice('已新建街区工程') }} />
          <ActionButton icon={<FolderOpen size={17} />} label="打开" onClick={() => fileInputRef.current?.click()} />
          <ActionButton icon={<Database size={17} />} label="场景库" onClick={openLibrary} />
          <ActionButton icon={<Save size={17} />} label="保存" onClick={saveProject} />
          <div className="top-divider" />
          <ActionButton icon={<Upload size={17} />} label="导入模型" onClick={() => modelInputRef.current?.click()} />
          <ActionButton icon={<Download size={17} />} label="导出部件" onClick={exportSelectedPart} strong />
          <button className="icon-button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={undoProject}><Undo2 size={17} /></button>
          <button className="icon-button" title="重做" aria-label="重做" disabled={!canRedo} onClick={redoProject}><Redo2 size={17} /></button>
          <div className="top-spacer" />
          <button className="icon-button" title="设置" onClick={() => setNotice('设置面板将在下一阶段接入')}><Settings size={17} /></button>
        </div>
        <input ref={fileInputRef} className="hidden-input" type="file" accept=".json,.moceworld" onChange={(event) => event.target.files?.[0] && openProject(event.target.files[0])} />
        <input ref={modelInputRef} className="hidden-input" type="file" accept=".glb,.gltf,.obj,.stl" onChange={(event) => event.target.files?.[0] && importModel(event.target.files[0])} />
      </header>

      <main className={`workspace ${assetSidebarCollapsed ? 'asset-sidebar-collapsed' : ''}`} onClick={() => treeContextMenu && setTreeContextMenu(null)}>
        <AssetSidebar assets={filteredAssets} query={query} setQuery={setQuery} activeStyle={activeStyle} setActiveStyle={setActiveStyle} collapsed={assetSidebarCollapsed} onToggleCollapsed={() => setAssetSidebarCollapsed((value) => !value)} onNotice={setNotice} onBeginPlacement={beginPlacement} onEndPlacement={endPlacement} />
        <section className="viewport-panel">
          <div className="viewport-toolbar">
            <div className="view-toggle">{(['正交', '透视'] as const).map((mode) => <button key={mode} className={viewMode === mode ? 'active' : ''} onClick={() => { setViewMode(mode); setNotice(`已切换视图 · ${mode}`) }}>{mode}</button>)}</div>
            <div className="toolbar-spacer" />
            <button className="micro-control" onClick={() => setNotice('当前体素单位 · 1 mm')}><Grid3X3 size={14} /> 1 mm体素 <ChevronDown size={13} /></button>
            <button className="micro-control" onClick={() => setNotice('边界设置面板尚未接入')}><SlidersHorizontal size={14} /> 边界 <ChevronDown size={13} /></button>
          </div>
          <VoxelViewport project={project} selectedId={selectedId} selectedPartIds={selectedEntityParts.map((part) => part.id)} checkedPartIds={checkedTreePartIds} lockedPartIds={lockedPartIds} editEntityId={editEntityId} tool={tool} activeMaterial={activeMaterial} materials={recentMaterials} dragAxis={dragAxis} placementAsset={project.assets.find((asset) => asset.id === placementAssetId) ?? null} placementPreview={placementPreview} viewMode={viewMode} showGrid={showGrid} showGround={showGround} zoomLevel={zoomLevel} onCameraApiChange={setCameraControlApi} onSelect={selectScenePart} onSelectMultiple={updateSceneCheckedSelection} onSelectMaterial={useMaterial} onReplaceMaterial={replaceMaterialColor} onAddVoxel={addVoxel} onRemoveVoxel={removeVoxel} onEditInstanceVoxel={editInstanceVoxel} onMoveSceneParts={moveSceneParts} onPlacementMove={updatePlacementPreview} onPlaceAsset={placeAssetAt} onNotice={setNotice} onExitEditMode={exitEditMode} onEnterEditMode={enterEditMode} onRename={renameSceneEntity} onBatchOperation={operateOnSceneSelection}>
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
            <button className={`footer-control ${showGround ? 'active' : ''}`} onClick={() => { setShowGround((value) => !value); setNotice(showGround ? '已隐藏地面' : '已显示地面') }}><Layers3 size={16} /> 地面 <ChevronDown size={13} /></button>
            <div className="drag-axis-control" aria-label="拖动方向"><Move3d size={14} /><span>拖动</span><button className={dragAxis === 'horizontal' ? 'active' : ''} onClick={() => { setDragAxis('horizontal'); setNotice('拖动方向 · 水平（X/Y）') }}>水平 X/Y</button><button className={dragAxis === 'vertical' ? 'active' : ''} onClick={() => { setDragAxis('vertical'); setNotice('拖动方向 · 竖直（Z）') }}>竖直 Z</button></div>
            <div className="footer-status"><span className={`status-dot ${persistenceStatus === 'offline' ? 'offline' : ''}`} /> {notice}</div>
            {cameraControlApi && <ViewportCameraControls showJoystick={false} onRotate={cameraControlApi.rotate} onView={(view) => { cameraControlApi.view(view); setNotice(`已切换视角 · ${cameraViewLabel(view)}`) }} onReset={() => { cameraControlApi.reset(); setZoomLevel(100); setNotice('视角已回中 · 缩放已恢复 100%') }} />}
            <div className="zoom-control"><button className="zoom-step" title="缩小" onClick={() => { setZoomLevel((value) => Math.max(50, value - 10)); setNotice('已缩小视图') }}><Minus size={14} /></button><div className="zoom-track"><div className="zoom-value" style={{ width: `${Math.max(0, Math.min(100, ((zoomLevel - 50) / 150) * 100))}%` }} /></div><button className="zoom-step" title="放大" onClick={() => { setZoomLevel((value) => Math.min(200, value + 10)); setNotice('已放大视图') }}><Plus size={14} /></button><span className="zoom-percent">{zoomLevel}%</span></div>
          </div>
        </section>
        <Inspector selectedAsset={selectedAsset} selectedInstance={selectedInstance} selectedPart={selectedScenePart} selectedParts={selectedEntityParts} editEntityId={editEntityId} position={selectedPosition} transformEditable={selectedTransformEditable} selectedColor={selectedColor} onChangeTransform={changeSelectedTransform} onChangeColor={changeSelectedColor} onMirror={mirrorSelectedEntities} onRotate={rotateSelectedEntities} onExport={exportSelectedPart} onDuplicate={duplicateSelected} onDelete={deleteSelected} onResetTransform={resetSelectedTransform} onSaveAsAsset={saveSelectedEntityAsAsset} />
      </main>
      {libraryOpen && <SceneLibraryDialog library={library} busy={libraryBusy} onClose={() => setLibraryOpen(false)} onRefresh={refreshLibrary} onSaveScene={saveCurrentSceneAsNew} onLoadScene={loadStoredScene} onLoadAsset={loadStoredAsset} />}
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

function AssetSidebar({ assets, query, setQuery, activeStyle, setActiveStyle, collapsed, onToggleCollapsed, onNotice, onBeginPlacement, onEndPlacement }: { assets: VoxelAsset[]; query: string; setQuery: (value: string) => void; activeStyle: string; setActiveStyle: (value: string) => void; collapsed: boolean; onToggleCollapsed: () => void; onNotice: (value: string) => void; onBeginPlacement: (asset: VoxelAsset) => void; onEndPlacement: () => void }) {
  const baseStyles = ['希腊风格', '印度风格', '中式风格', '日式风格', '基础件']
  const styles = ['全部', ...baseStyles, ...[...new Set(assets.map((asset) => asset.style))].filter((style) => !baseStyles.includes(style))]
  const assetGroups = [...baseStyles, ...[...new Set(assets.map((asset) => asset.style))].filter((style) => !baseStyles.includes(style))]
  const [activeNav, setActiveNav] = useState('组件')
  const draggedAssetRef = useRef(false)
  const navItems = [
    { label: '组件', icon: <Box size={17} /> },
    { label: '生成', icon: <WandSparkles size={17} /> },
    { label: '角色', icon: <CircleUserRound size={17} /> },
    { label: '图层', icon: <Layers3 size={17} /> },
    { label: '网格', icon: <Grid3X3 size={17} /> },
  ]
  return <aside className={`asset-sidebar ${collapsed ? 'collapsed' : ''}`}>
    <div className="panel-title-row"><div><h2>资产库</h2><p>模板实体</p></div><button className="panel-collapse-button" aria-label={collapsed ? '展开资产库' : '收起资产库'} title={collapsed ? '展开资产库' : '收起资产库'} onClick={onToggleCollapsed}>{collapsed ? <ChevronRight size={18} /> : <ChevronRight size={18} className="collapse-left" />}</button></div>
    {collapsed ? <button className="collapsed-asset-toggle" aria-label="展开资产库" onClick={onToggleCollapsed}><Box size={17} /></button> : <>
    <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组件" /><SlidersHorizontal size={14} /></label>
    <div className="style-tabs">{styles.map((style) => <button key={style} className={activeStyle === style ? 'active' : ''} onClick={() => setActiveStyle(style)}>{style}</button>)}</div>
    <div className="asset-scroll">
      {assetGroups.map((style) => {
        const group = assets.filter((asset) => asset.style === style)
        if (activeStyle !== '全部' && activeStyle !== style) return null
        if (!group.length) return null
        return <div className="asset-group" key={style}>
          <div className="group-heading"><span className="style-dot" style={{ background: styleColors[style] ?? '#a5a6a2' }} />{style}<ChevronDown size={15} /></div>
          <div className="asset-grid">{group.map((asset) => <button className="asset-card" key={asset.id} onPointerDown={() => { draggedAssetRef.current = true; onBeginPlacement(asset) }} onPointerUp={() => { draggedAssetRef.current = false; onEndPlacement() }} onPointerCancel={() => { draggedAssetRef.current = false; onEndPlacement() }} onClick={(event) => { if (draggedAssetRef.current) { event.preventDefault(); draggedAssetRef.current = false; return } onNotice('请按住组件拖动到三维场地后放置') }} title="按住拖动到场地放置">
            <VoxelThumbnail asset={asset} />
            <span>{asset.name.replace('·主屋', '')}</span>
          </button>)}</div>
        </div>
      })}
    </div>
    <div className="sidebar-nav">{navItems.map(({ label, icon }) => <button key={label} className={activeNav === label ? 'active' : ''} onClick={() => { setActiveNav(label); onNotice(label === '组件' ? '模板实体库已打开' : `${label}功能尚未接入工程数据`) }}>{icon}<span>{label}</span></button>)}</div></>}
  </aside>
}

function VoxelThumbnail({ asset }: { asset: VoxelAsset }) {
  return <div className="thumbnail-scene" style={{ '--thumb-main': asset.color, '--thumb-accent': asset.accent } as React.CSSProperties}>
    <div className="thumb-ground" />
    <div className="thumb-house"><div className="thumb-roof" /><div className="thumb-body" /><div className="thumb-door" /></div>
  </div>
}

function SceneLibraryDialog({ library, busy, onClose, onRefresh, onSaveScene, onLoadScene, onLoadAsset }: { library: LibraryResponse; busy: boolean; onClose: () => void; onRefresh: () => void; onSaveScene: () => void; onLoadScene: (id: string, name: string) => void; onLoadAsset: (id: string, name: string) => void }) {
  return <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="library-dialog" role="dialog" aria-modal="true" aria-label="后端场景库">
      <div className="library-dialog-heading"><div><h2>后端场景库</h2><p>资产、场景与手动体素均由当前工程自动入库</p></div><button className="icon-button" aria-label="关闭场景库" onClick={onClose}><X size={17} /></button></div>
      <div className="library-dialog-toolbar"><span>{library.scenes.length} 个场景 · {library.assets.length} 个资产</span><div className="library-toolbar-actions"><button className="tiny-button" onClick={onSaveScene} disabled={busy}><Save size={13} /> 当前场景另存为</button><button className="tiny-button" onClick={onRefresh} disabled={busy}><RotateCw size={13} /> 刷新</button></div></div>
      <div className="library-columns">
        <div className="library-column"><div className="library-column-title">场景</div>{library.scenes.length ? library.scenes.map((scene) => <button className="library-row" key={scene.id} onClick={() => onLoadScene(scene.id, scene.name)}><div><strong>{scene.name}</strong><span>{scene.instanceCount} 个实例 · {scene.customVoxelCount} 个手动体素</span></div><ChevronRight size={15} /></button>) : <div className="empty-panel">尚无后端场景</div>}</div>
        <div className="library-column"><div className="library-column-title">资产</div>{library.assets.length ? library.assets.map((asset) => <button className="library-row" key={asset.id} onClick={() => onLoadAsset(asset.id, asset.name)}><div><strong>{asset.name}</strong><span>{asset.style} · {asset.voxelCount} 个体素</span></div><Plus size={15} /></button>) : <div className="empty-panel">尚无后端资产</div>}</div>
      </div>
      {busy && <div className="library-loading">正在访问后端数据库…</div>}
    </section>
  </div>
}

function ToolButton({ icon, label, description, active, onClick }: { icon: React.ReactNode; label: string; description: string; active: boolean; onClick: () => void }) {
  return <button className={`tool-button ${active ? 'active' : ''}`} data-tooltip={description} aria-label={label} onClick={onClick} title={description}>{icon}</button>
}

function Inspector({ selectedAsset, selectedInstance, selectedPart, selectedParts, editEntityId, position, transformEditable, selectedColor, onChangeTransform, onChangeColor, onMirror, onRotate, onExport, onDuplicate, onDelete, onResetTransform, onSaveAsAsset }: { selectedAsset?: VoxelAsset; selectedInstance?: SceneInstance; selectedPart?: SceneEntityPart; selectedParts: SceneEntityPart[]; editEntityId: string | null; position: number[]; transformEditable: boolean; selectedColor: string; onChangeTransform: (axis: number, value: number) => void; onChangeColor: (color: string) => void; onMirror: (axis: 'x' | 'y' | 'z') => void; onRotate: (axis: 'x' | 'y' | 'z', degrees: 90 | 180 | 270) => void; onExport: () => void; onDuplicate: (count: number) => void; onDelete: () => void; onResetTransform: () => void; onSaveAsAsset: () => void }) {
  const [copyCount, setCopyCount] = useState(1)
  const [mirrorAxis, setMirrorAxis] = useState<'x' | 'y' | 'z'>('x')
  const [rotateAxis, setRotateAxis] = useState<'x' | 'y' | 'z'>('z')
  const [rotateDegrees, setRotateDegrees] = useState<90 | 180 | 270>(90)
  const previewVoxels = selectedParts.flatMap((part) => part.voxels)
  const isAssembly = selectedParts.length > 1 && selectedParts.some((part) => part.assemblyId || part.assemblyIds?.length)
  const entityName = isAssembly ? `装配体 · ${selectedParts.length} 个子实体` : selectedAsset?.name ?? selectedPart?.label ?? (selectedPart ? '手动体素实体' : '未选择')
  const entityId = selectedInstance?.id ?? selectedPart?.id ?? '—'
  const source = isAssembly ? '当前场景 · 装配体实体' : selectedAsset ? (selectedAsset.source ?? '莫测标准组件') : (selectedPart ? '当前场景 · 用户实体' : '莫测标准组件')
  return <aside className="inspector">
    <div className="inspector-heading"><div><h2>属性</h2><p>选中对象的编辑参数</p></div><ChevronRight size={18} className="muted-icon" /></div>
    <div className="inspector-section entity-summary-section">
      <div className="field-label">选中实体</div><div className="select-field">{entityName} <ChevronDown size={14} /></div>
      <div className="field-label">实体 ID</div><div className="input-field">{entityId}</div>
      <div className="field-label">来源</div><div className="input-field muted-field">{source}</div>
      <div className="entity-preview"><VoxelMiniPreview voxels={previewVoxels} asset={selectedAsset} /></div>
    </div>
    <div className="inspector-section">
      <div className="section-heading"><span>变换</span><button className="tiny-icon" onClick={onResetTransform} title="重置变换"><RotateCcw size={13} /></button></div>
      <TransformRow icon={<Move3d size={14} />} label="位置" values={position} editable={transformEditable} onChange={onChangeTransform} />
      {!transformEditable && <div className="transform-hint">多选实体时不可直接编辑单一位置</div>}
    </div>
    <div className="inspector-section color-section">
      <div className="section-heading"><span>颜色</span><span className="instance-label">实体覆盖色</span></div>
      <ColorEditor color={selectedColor} disabled={!selectedParts.length} onChange={onChangeColor} />
    </div>
    <div className="inspector-section entity-actions-section">
      <div className="section-heading"><span>实体操作</span><span className="instance-label">{selectedParts.length} 个实体</span></div>
      <div className="entity-actions">
        <div className="copy-entity-row"><span className="copy-entity-label">复制实体</span><button onClick={() => setCopyCount((value) => Math.max(1, value - 1))} title="减少复制数量"><Minus size={13} /></button><span className="copy-entity-count">{copyCount}</span><button onClick={() => setCopyCount((value) => Math.min(99, value + 1))} title="增加复制数量"><Plus size={13} /></button><button className="copy-confirm" onClick={() => onDuplicate(copyCount)}>确定</button></div>
        <div className="entity-transform-operation"><span>镜像实体</span><div className="axis-choice">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={mirrorAxis === axis ? 'active' : ''} onClick={() => setMirrorAxis(axis)}>{axis.toUpperCase()}</button>)}</div><button className="operation-confirm" onClick={() => onMirror(mirrorAxis)}>执行</button></div>
        <div className="entity-transform-operation"><span>旋转实体</span><div className="axis-choice">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={rotateAxis === axis ? 'active' : ''} onClick={() => setRotateAxis(axis)}>{axis.toUpperCase()}</button>)}</div><div className="degree-choice">{([90, 180, 270] as const).map((degrees) => <button key={degrees} className={rotateDegrees === degrees ? 'active' : ''} onClick={() => setRotateDegrees(degrees)}>{degrees}°</button>)}</div><button className="operation-confirm" onClick={() => onRotate(rotateAxis, rotateDegrees)}>执行</button></div>
        <button onClick={onSaveAsAsset}><Save size={14} /> 保存为模板实体</button>
        <button className="danger-action" onClick={onDelete}><Trash2 size={14} /> 删除实体</button>
        <button className="export-action" onClick={onExport}><Download size={14} /> 导出选中部件 STL</button>
      </div>
    </div>
  </aside>
}

function VoxelMiniPreview({ voxels, asset }: { voxels: Voxel[]; asset?: VoxelAsset }) {
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
  const originX = 14 + spanZ * tileX
  const originY = 14 + spanY * tileY
  const project = (x: number, y: number, z: number): [number, number] => [originX + (x - z) * tileX, originY + (x + z) * tileZ - y * tileY]
  const materialColor = (materialId: string) => materialId === 'primary' ? asset?.color ?? '#6c827d' : materialId === 'accent' ? asset?.accent ?? '#d2a354' : materialId.startsWith('#') ? materialId : MATERIALS.find((material) => material.id === materialId)?.color ?? '#6c827d'
  const shadeColor = (color: string, amount: number) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return color
    const channels = [0, 2, 4].map((offset) => Math.max(0, Math.min(255, Math.round(parseInt(color.slice(offset + 1, offset + 3), 16) * amount))))
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  const orderedVoxels = voxels.slice(0, 600).map((voxel) => ({ ...voxel, x: voxel.x - minX, y: voxel.y - minY, z: voxel.z - minZ }))
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
      const color = materialColor(voxel.materialId)
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
  const edgeGeometry = createVoxelOutlineGeometry()
  const glow = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.2, depthTest: true, depthWrite: false }))
  glow.scale.setScalar(1.055)
  glow.renderOrder = 20
  glow.userData.selectionGlow = true
  glow.raycast = () => {}
  const edge = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: true, depthWrite: false }))
  edge.scale.setScalar(1.012)
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
  const stopControlPointer = (event: React.SyntheticEvent) => event.stopPropagation()
  const startJoystick = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (joystickRef.current?.pointerId === event.pointerId) {
      joystickRef.current = null
      setJoystickOffset({ x: 0, y: 0 })
    }
  }
  return <div className="viewport-camera-controls" onPointerDown={stopControlPointer} onPointerMove={stopControlPointer} onPointerUp={stopControlPointer} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}>
    {showActions && <>
      {expanded && <ViewCubeSelector onView={(view) => { onView(view); setExpanded(false) }} />}
      <button className="camera-cube-button" aria-label="展开六个标准视角" aria-expanded={expanded} title="六个标准视角" onClick={() => setExpanded((value) => !value)}><Box size={18} strokeWidth={1.8} /></button>
      <button className="camera-reset-button" aria-label="视角回中" title="视角回中" onClick={onReset}><RotateCcw size={14} /></button>
    </>}
    {showJoystick && <div className="camera-joystick" aria-label="按住拖动旋转视角"><div className="camera-joystick-ring"><button className="camera-joystick-knob" style={{ transform: `translate(${joystickOffset.x}px, ${joystickOffset.y}px)` }} aria-label="拖动摇杆旋转视角" onPointerDown={startJoystick} onPointerMove={moveJoystick} onPointerUp={endJoystick} onPointerCancel={endJoystick} /></div></div>}
  </div>
}

function VoxelViewport({ project, selectedId, selectedPartIds, checkedPartIds, lockedPartIds, editEntityId, tool, activeMaterial, materials, dragAxis, placementAsset, placementPreview, viewMode, showGrid, showGround, zoomLevel, onCameraApiChange, onSelect, onSelectMultiple, onSelectMaterial, onReplaceMaterial, onAddVoxel, onRemoveVoxel, onEditInstanceVoxel, onMoveSceneParts, onPlacementMove, onPlaceAsset, onNotice, onExitEditMode, onEnterEditMode, onRename, onBatchOperation, children }: { project: ProjectState; selectedId: string; selectedPartIds: string[]; checkedPartIds: string[]; lockedPartIds: Set<string>; editEntityId: string | null; tool: Tool; activeMaterial: string; materials: Material[]; dragAxis: 'horizontal' | 'vertical'; placementAsset: VoxelAsset | null; placementPreview: PlacementPreview | null; viewMode: '正交' | '透视'; showGrid: boolean; showGround: boolean; zoomLevel: number; onCameraApiChange: (api: CameraControlApi | null) => void; onSelect: (id: string) => void; onSelectMultiple: (partIds: string[], additive?: boolean) => void; onSelectMaterial: (id: string) => void; onReplaceMaterial: (id: string, color: string) => void; onAddVoxel: (voxel: Voxel) => void; onRemoveVoxel: (voxel: Voxel) => void; onEditInstanceVoxel: (instanceId: string, voxel: Voxel, mode: VoxelOverride['mode']) => void; onMoveSceneParts: (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number, trackHistory?: boolean) => GridMoveResult; onPlacementMove: (assetId: string, x: number, z: number) => void; onPlaceAsset: (assetId: string, x: number, z: number) => void; onNotice: (message: string) => void; onExitEditMode: () => void; onEnterEditMode: (entityId: string) => void; onRename: (targetId: string, assemblyId?: string) => void; onBatchOperation: (partIds: string[], operation: 'delete' | 'lock' | 'assemble') => void; children?: React.ReactNode }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const camerasRef = useRef<{ orthographic: THREE.OrthographicCamera; perspective: THREE.PerspectiveCamera } | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const groupRef = useRef<THREE.Group | null>(null)
  const axisGizmoRef = useRef<SVGSVGElement | null>(null)
  const raycasterRef = useRef(new THREE.Raycaster())
  const pointerRef = useRef(new THREE.Vector2())
  const controlsRef = useRef<OrbitControls | null>(null)
  const editRenderStateRef = useRef<{ active: boolean; partIds: Set<string> }>({ active: false, partIds: new Set() })
  const editGestureRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null)
  const selectGestureRef = useRef<SelectGesture | null>(null)
  const boxSelectGestureRef = useRef<BoxSelectGesture | null>(null)
  const cameraGestureRef = useRef<{ pointerId: number; button: 'right'; lastX: number; lastY: number; moved: boolean; contextPartIds?: string[] } | null>(null)
  const [sceneSelectionBox, setSceneSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [sceneContextMenu, setSceneContextMenu] = useState<{ partIds: string[]; x: number; y: number } | null>(null)
  const [ready, setReady] = useState(false)
  // Keep persisted asset coordinates backward-compatible while presenting the scene
  // in the editor's conventional XY ground plane with Z as the vertical axis.
  const toSceneWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, y)

  const materialMap = useMemo(() => new Map(project.materials.map((material) => [material.id, new THREE.MeshStandardMaterial({ color: material.color, roughness: 0.72, metalness: 0.03 })])), [project.materials])

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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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
    controls.enableZoom = true
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
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(22, 22), new THREE.MeshStandardMaterial({ color: '#11181b', roughness: 0.95 }))
    floor.position.z = 0
    floor.name = 'editing-floor'
    floor.receiveShadow = true
    scene.add(floor)
    const grid = new THREE.GridHelper(20, 20, '#34464c', '#203036')
    grid.rotation.x = Math.PI / 2
    grid.position.z = -0.004
    grid.name = 'editing-grid'
    scene.add(grid)
    const group = new THREE.Group()
    scene.add(group)
    sceneRef.current = scene
    cameraRef.current = camera
    camerasRef.current = { orthographic, perspective }
    rendererRef.current = renderer
    groupRef.current = group
    controlsRef.current = controls
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
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    let frame = 0
    const occlusionRaycaster = new THREE.Raycaster()
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
    const updateEditOcclusion = () => {
      const editState = editRenderStateRef.current
      const currentCamera = cameraRef.current
      if (!editState.active || !currentCamera || !group.children.length) return
      const occludedPartIds = new Set<string>()
      const targetMeshes: THREE.Mesh[] = []
      group.traverse((object) => {
        if (object instanceof THREE.Mesh && !object.userData.selectionGlow && editState.partIds.has(object.userData.scenePartId as string)) targetMeshes.push(object)
      })
      const origin = currentCamera.getWorldPosition(new THREE.Vector3())
      targetMeshes.forEach((targetMesh) => {
        const targetPosition = targetMesh.getWorldPosition(new THREE.Vector3())
        const rayDirection = targetPosition.clone().sub(origin)
        const targetDistance = rayDirection.length()
        if (targetDistance <= 0.001) return
        rayDirection.normalize()
        occlusionRaycaster.set(origin, rayDirection)
        occlusionRaycaster.near = 0.001
        occlusionRaycaster.far = Math.max(0.001, targetDistance - 0.002)
        const occluder = occlusionRaycaster.intersectObject(group, true).find((hit) => {
          const scenePartId = hit.object.userData.scenePartId as string | undefined
          return Boolean(scenePartId && !editState.partIds.has(scenePartId) && !hit.object.userData.selectionGlow)
        })
        const scenePartId = occluder?.object.userData.scenePartId as string | undefined
        if (scenePartId) occludedPartIds.add(scenePartId)
      })
      group.traverse((object) => {
        const scenePartId = object.userData.scenePartId as string | undefined
        if (!(object instanceof THREE.Mesh) || !scenePartId || editState.partIds.has(scenePartId)) return
        const glowParts = object.userData.selectionGlowParts as THREE.Object3D[] | undefined
        glowParts?.forEach((part) => { part.visible = occludedPartIds.has(scenePartId) })
      })
    }
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls.update()
      updateEditOcclusion()
      updateAxisGizmo()
      const currentCamera = cameraRef.current ?? camera
      renderer.render(scene, currentCamera)
      const editState = editRenderStateRef.current
      if (editState.active && group.children.length) {
        const hidden: Array<{ object: THREE.Object3D; visible: boolean }> = []
        const previousBackground = scene.background
        const floorObject = scene.getObjectByName('editing-floor')
        const gridObject = scene.getObjectByName('editing-grid')
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
        renderer.autoClear = false
        renderer.clearDepth()
        renderer.render(dimScene, dimCamera)
        renderer.clearDepth()
        scene.background = null
        renderer.render(scene, currentCamera)
        scene.background = previousBackground
        renderer.autoClear = true
        hidden.reverse().forEach(({ object, visible }) => { object.visible = visible })
      }
    }
    animate()
    setReady(true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
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
  }, [viewMode])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const grid = scene.getObjectByName('editing-grid')
    const ground = scene.getObjectByName('editing-floor')
    if (grid) grid.visible = showGrid
    if (ground) ground.visible = showGround
  }, [showGrid, showGround])

  useEffect(() => {
    const cameras = camerasRef.current
    if (!cameras) return
    cameras.orthographic.zoom = zoomLevel / 100
    cameras.orthographic.updateProjectionMatrix()
    cameras.perspective.fov = Math.max(24, Math.min(52, 38 - (zoomLevel - 100) * 0.12))
    cameras.perspective.updateProjectionMatrix()
  }, [zoomLevel])

  const applyCameraView = (view: CameraView) => {
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
    if (view === 'top') {
      up = new THREE.Vector3(0, 1, 0)
    } else if (view === 'bottom') {
      up = new THREE.Vector3(0, -1, 0)
    }
    cameras.orthographic.position.copy(position)
    cameras.perspective.position.copy(position)
    cameras.orthographic.up.copy(up)
    cameras.perspective.up.copy(up)
    cameras.orthographic.lookAt(target)
    cameras.perspective.lookAt(target)
    cameras.orthographic.updateProjectionMatrix()
    cameras.perspective.updateProjectionMatrix()
    controls.target.copy(target)
    controls.update()
  }

  const rotateCameraByInput = (deltaX: number, deltaY: number) => {
    const controls = controlsRef.current
    if (!controls) return
    controls.rotateLeft(deltaX * 0.008)
    controls.rotateUp(deltaY * 0.008)
    controls.update()
  }

  useEffect(() => {
    onCameraApiChange({
      rotate: rotateCameraByInput,
      view: (view) => applyCameraView(view),
      reset: () => applyCameraView('default'),
    })
    return () => onCameraApiChange(null)
  }, [onCameraApiChange])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.clear()
    const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
    const currentSceneParts = sceneEntityParts(project)
    const selectedScenePartIds = new Set(selectedPartIds)
    const editAssemblyId = editEntityId?.startsWith('assembly:') ? editEntityId.slice('assembly:'.length) : undefined
    const editScenePartIds = new Set(currentSceneParts.filter((part) => editEntityId === part.id || (editAssemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editAssemblyId))).map((part) => part.id))
    editRenderStateRef.current = { active: Boolean(editEntityId), partIds: editScenePartIds }
    for (const instance of project.instances) {
      if (!instance.visible) continue
      const asset = assetMap.get(instance.assetId)
      if (!asset) continue
      const variant = styleMaterialVariants[instance.style]
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
        const scenePartId = object.userData.scenePartId as string | undefined
        const highlighted = Boolean(scenePartId && (selectedScenePartIds.has(scenePartId) || editScenePartIds.has(scenePartId)))
        if (highlighted) addVoxelHighlight(object)
        if (editEntityId && scenePartId && !editScenePartIds.has(scenePartId)) {
          const meshMaterial = object.material as THREE.MeshStandardMaterial
          meshMaterial.transparent = true
          meshMaterial.opacity = 0.08
          meshMaterial.depthWrite = false
          if (object.userData.outerVoxel) addVoxelHighlight(object).forEach((part) => { part.visible = false })
        }
      })
      group.add(instanceGroup)
    }
    if (project.customVoxels.length) {
      const custom = new THREE.Group()
      custom.name = 'custom-voxels'
      for (const component of voxelComponents(project.customVoxels)) {
        const occupied = new Set(component.map((candidate) => `${candidate.x},${candidate.y},${candidate.z}`))
        const componentColor = project.customColors?.[voxelEntityId(component[0])]
        component.forEach((voxel) => {
        const material = materialMap.get(voxel.materialId) ?? materialMap.get('terracotta')!
        const meshMaterial = material.clone()
        if (componentColor) meshMaterial.color.set(componentColor)
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(VOXEL_WORLD_SIZE, VOXEL_WORLD_SIZE, VOXEL_WORLD_SIZE), meshMaterial)
        mesh.position.copy(toSceneWorld(voxelToWorld(voxel.x), voxelCenterToWorld(voxel.y), voxelToWorld(voxel.z)))
        mesh.userData.customVoxel = voxel
        mesh.userData.customComponentId = voxelComponentId(component)
        mesh.userData.scenePartId = `custom:${voxelEntityId(voxel)}`
        const exposedFaces = exposedVoxelFaces(voxel, occupied)
        mesh.userData.exposedFaces = exposedFaces
        mesh.userData.outerVoxel = exposedFaces.length > 0
        if (selectedScenePartIds.has(mesh.userData.scenePartId) || editScenePartIds.has(mesh.userData.scenePartId)) addVoxelHighlight(mesh)
        if (editEntityId && !editScenePartIds.has(mesh.userData.scenePartId)) {
          meshMaterial.transparent = true
          meshMaterial.opacity = 0.08
          meshMaterial.depthWrite = false
          if (mesh.userData.outerVoxel) addVoxelHighlight(mesh).forEach((part) => { part.visible = false })
        }
        custom.add(mesh)
        })
      }
      group.add(custom)
    }
    if (placementAsset && placementPreview) {
      const variant = styleMaterialVariants[placementAsset.style]
      const renderAsset = variant ? { ...placementAsset, color: variant.color, accent: variant.accent } : placementAsset
      const preview = buildAssetGroup(renderAsset, materialMap)
      preview.position.copy(toSceneWorld(placementPreview.x, placementPreview.y, placementPreview.z))
      preview.userData.placementPreview = true
      preview.userData.editPlacementPreview = Boolean(editEntityId)
      preview.traverse((object) => {
        object.userData.placementPreview = true
        if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return
        const material = object.material.clone()
        material.transparent = true
        material.opacity = editEntityId ? (placementPreview.valid ? 0.86 : 0.66) : (placementPreview.valid ? 0.42 : 0.18)
        material.depthWrite = false
        if (!placementPreview.valid) material.color.set('#e06b5b')
        object.material = material
        if (editEntityId && object.userData.outerVoxel) addVoxelHighlight(object)
      })
      group.add(preview)
    }
  }, [project, selectedId, selectedPartIds, checkedPartIds, editEntityId, materialMap, placementAsset, placementPreview])

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
    const rawHits = groupRef.current ? raycasterRef.current.intersectObject(groupRef.current, true) : []
    const hits = editEntityId ? rawHits.filter((item) => belongsToEditEntity(item.object)) : rawHits
    const floor = scene.getObjectByName('editing-floor')
    const floorHit = floor ? raycasterRef.current.intersectObject(floor, false)[0] : undefined
    return { hits, floorPoint: floorHit?.point ?? null }
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

  const belongsToEditEntity = (object: THREE.Object3D) => {
    if (!editEntityId) return true
    const scenePartId = object.userData.scenePartId as string | undefined
    if (!scenePartId) return false
    if (scenePartId === editEntityId) return true
    if (!editEntityId.startsWith('assembly:')) return false
    const assemblyId = editEntityId.slice('assembly:'.length)
    return sceneEntityParts(project).some((part) => part.id === scenePartId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(assemblyId))
  }

  const applyEditAtPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const context = getPointerContext(event)
    if (!context) return
    const { hits, floorPoint } = context
    const hit = hits[0]
    if (tool === 'select' && editEntityId) return
    if (tool === 'select' && hit?.object.userData.scenePartId && belongsToEditEntity(hit.object)) {
      onSelect(hit.object.userData.scenePartId)
      return
    }
    if (tool !== 'brush' && tool !== 'erase') return
    const instanceHit = hits.find((item) => item.object.userData.instanceId && item.object.userData.instanceVoxel && belongsToEditEntity(item.object))
    if (instanceHit?.object.userData.instanceId && instanceHit.object.userData.instanceVoxel) {
      const instanceId = instanceHit.object.userData.instanceId as string
      const hitVoxel = instanceHit.object.userData.instanceVoxel as Voxel
      if (tool === 'brush') {
        if (!instanceHit.face) return
        const displayNormal = instanceHit.face.normal.clone().transformDirection(instanceHit.object.matrixWorld)
        onEditInstanceVoxel(instanceId, adjacentVoxel(hitVoxel, { x: displayNormal.x, y: displayNormal.z, z: displayNormal.y }, activeMaterial), 'add')
      } else {
        onEditInstanceVoxel(instanceId, hitVoxel, 'remove')
      }
      return
    }
    const customHit = hits.find((item) => item.object.userData.customVoxel && belongsToEditEntity(item.object))
    if (customHit?.object.userData.customVoxel) {
      const hitVoxel = customHit.object.userData.customVoxel as Voxel
      if (tool === 'brush') {
        if (!customHit.face) return
        const displayNormal = customHit.face.normal.clone().transformDirection(customHit.object.matrixWorld)
        onAddVoxel(adjacentVoxel(hitVoxel, { x: displayNormal.x, y: displayNormal.z, z: displayNormal.y }, activeMaterial))
      } else onRemoveVoxel(hitVoxel)
      return
    }
    if (!floorPoint) return
    const x = worldToVoxel(floorPoint.x)
    const z = worldToVoxel(floorPoint.y)
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
      if (tool === 'erase' && localVoxel) onEditInstanceVoxel(occupiedAsset.id, localVoxel, 'remove')
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
      const context = getPointerContext(event)
      const hit = context?.hits.find((item) => item.object.userData.scenePartId)
      const hitPart = hit?.object.userData.scenePartId ? sceneEntityParts(project).find((part) => part.id === hit.object.userData.scenePartId) : undefined
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
    if (editEntityId && tool === 'select') return
    if (tool === 'select') {
      const context = getPointerContext(event)
      const customHit = context?.hits.find((item) => item.object.userData.customVoxel)
      const hit = customHit ?? context?.hits.find((item) => item.object.userData.scenePartId)
      const floorPoint = context?.floorPoint
      const sceneParts = sceneEntityParts(project)
      const hitPart = hit?.object.userData.scenePartId ? sceneParts.find((part) => part.id === hit.object.userData.scenePartId) : undefined
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
          : toSceneWorld(voxelToWorld(anchorVoxel?.x ?? 0), voxelCenterToWorld(anchorVoxel?.y ?? 0), voxelToWorld(anchorVoxel?.z ?? 0))
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
          historyTracked: false,
          moved: false,
        }
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
      if (context?.floorPoint) onPlacementMove(placementAsset.id, context.floorPoint.x, context.floorPoint.y)
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
        const moveResult = onMoveSceneParts(parts, 0, deltaZ - selectGesture.lastDeltaY, 0, !selectGesture.historyTracked)
        if (moveResult.moved) {
          selectGesture.parts = parts.map((part) => ({ ...part, voxels: part.voxels.map((voxel) => ({ ...voxel, y: voxel.y + moveResult.deltaY })) }))
          selectGesture.lastDeltaY += moveResult.deltaY
          selectGesture.historyTracked = true
        }
        return
      }
      const deltaX = worldToVoxel(context.floorPoint!.x - selectGesture.startGroundX)
      const deltaZ = worldToVoxel(context.floorPoint!.y - selectGesture.startGroundY)
      if (deltaX === selectGesture.lastDeltaX && deltaZ === selectGesture.lastDeltaZ) return
      const stepX = deltaX - selectGesture.lastDeltaX
      const stepZ = deltaZ - selectGesture.lastDeltaZ
      const moveResult = onMoveSceneParts(parts, stepX, 0, stepZ, !selectGesture.historyTracked)
      if (moveResult.moved) {
        selectGesture.parts = parts.map((part) => ({ ...part, voxels: part.voxels.map((voxel) => ({ ...voxel, x: voxel.x + moveResult.deltaX, z: voxel.z + moveResult.deltaZ })) }))
        selectGesture.lastDeltaX += moveResult.deltaX
        selectGesture.lastDeltaZ += moveResult.deltaZ
        selectGesture.historyTracked = true
      }
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
      if (context?.floorPoint) onPlaceAsset(placementAsset.id, context.floorPoint.x, context.floorPoint.y)
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
    selectGestureRef.current = null
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
        selectGestureRef.current = null
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
      selectGestureRef.current = null
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
    if (context?.floorPoint) onPlacementMove(assetId, context.floorPoint.x, context.floorPoint.y)
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
    onPlaceAsset(assetId, context.floorPoint.x, context.floorPoint.y)
  }

  const sceneContextLocked = Boolean(sceneContextMenu?.partIds.length && sceneContextMenu.partIds.every((partId) => lockedPartIds.has(partId)))
  const sceneContextEditTargetId = sceneContextMenu?.partIds.length === 1 ? sceneContextMenu.partIds[0] : ''
  const sceneContextRenameTargetId = sceneContextMenu?.partIds.length === 1 ? sceneContextMenu.partIds[0] : ''
  return <div className={`viewport-canvas ${ready ? 'ready' : ''}`} ref={mountRef} onPointerDown={handleEditPointerDown} onPointerMove={handleEditPointerMove} onPointerUp={handleEditPointerUp} onPointerCancel={handleEditPointerCancel} onContextMenu={(event) => event.preventDefault()} onWheel={(event) => { if (event.ctrlKey) event.preventDefault() }} onDragOver={handlePlacementDragOver} onDrop={handlePlacementDrop}><div className="viewport-scene-tree-overlay" onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}>{children}</div>{sceneSelectionBox && <div className="scene-selection-box" style={sceneSelectionBox} />}{sceneContextMenu && <div className="scene-context-menu" style={{ left: sceneContextMenu.x, top: sceneContextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>{sceneContextRenameTargetId && <button onClick={() => { onRename(sceneContextRenameTargetId); setSceneContextMenu(null) }}>重命名</button>}{sceneContextEditTargetId && <button onClick={() => { onEnterEditMode(sceneContextEditTargetId); setSceneContextMenu(null) }}>进入编辑修改模式</button>}{sceneContextMenu.partIds.length >= 2 && <button onClick={() => { onBatchOperation(sceneContextMenu.partIds, 'assemble'); setSceneContextMenu(null) }}>组装所选实体</button>}<button onClick={() => { onBatchOperation(sceneContextMenu.partIds, 'lock'); setSceneContextMenu(null) }}>{sceneContextLocked ? '取消固定所选实体' : '固定所选实体'}</button><button className="danger" onClick={() => { onBatchOperation(sceneContextMenu.partIds, 'delete'); setSceneContextMenu(null) }}>删除所选实体</button></div>}<svg ref={axisGizmoRef} className="axis-gizmo" viewBox="0 0 64 64" aria-label="当前视图坐标系"><line data-axis-line="x" x1="32" y1="32" x2="56" y2="32" /><line data-axis-line="y" x1="32" y1="32" x2="32" y2="8" /><line data-axis-line="z" x1="32" y1="32" x2="32" y2="8" /><text data-axis-label="x" x="56" y="32">X</text><text data-axis-label="y" x="32" y="8">Y</text><text data-axis-label="z" x="32" y="8">Z</text></svg>{editEntityId && <button className="viewport-edit-exit" aria-label="退出编辑修改模式" title="退出编辑修改模式" onPointerDown={(event) => event.stopPropagation()} onClick={onExitEditMode}><X size={16} /></button>}<ViewportPalette materials={materials} activeMaterial={activeMaterial} onSelectMaterial={onSelectMaterial} onReplaceMaterial={onReplaceMaterial} /><ViewportCameraControls showActions={false} onRotate={rotateCameraByInput} onView={(view) => { applyCameraView(view); onNotice(`已切换视角 · ${cameraViewLabel(view)}`) }} onReset={() => { applyCameraView('default'); onNotice('视角已回中') }} /></div>
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
    for (const voxel of component) {
      const material = colorOverride
        ? new THREE.MeshStandardMaterial({ color: colorOverride, roughness: 0.72, metalness: 0.03 })
        : voxel.materialId === 'primary'
        ? new THREE.MeshStandardMaterial({ color: asset.color, roughness: 0.72, metalness: 0.03 })
        : voxel.materialId === 'accent'
          ? new THREE.MeshStandardMaterial({ color: asset.accent, roughness: 0.72, metalness: 0.03 })
          : materialMap.get(voxel.materialId) ?? new THREE.MeshStandardMaterial({ color: voxel.materialId.startsWith('#') ? voxel.materialId : asset.color, roughness: 0.72, metalness: 0.03 })
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(scale, scale, scale), material.clone())
      const localXIndex = mirror?.x ? asset.width - 1 - voxel.x : voxel.x
      const localYIndex = mirror?.z ? asset.height - 1 - voxel.y : voxel.y
      const localZIndex = mirror?.y ? asset.depth - 1 - voxel.z : voxel.z
      mesh.position.set((localXIndex + 0.5 - asset.width / 2) * scale, (localZIndex + 0.5 - asset.depth / 2) * scale, (localYIndex + 0.5) * scale)
      mesh.userData.instanceVoxel = { ...voxel }
      mesh.userData.instancePartId = partId
      const exposedFaces = exposedVoxelFaces(voxel, occupied)
      mesh.userData.exposedFaces = exposedFaces
      mesh.userData.outerVoxel = exposedFaces.length > 0
      mesh.castShadow = true
      mesh.receiveShadow = true
      partGroup.add(mesh)
    }
    group.add(partGroup)
  }
  return group
}

const rootElement = document.getElementById('root')!
const globalWithRoot = globalThis as typeof globalThis & { __moceRoot?: ReturnType<typeof createRoot> }
const appRoot = globalWithRoot.__moceRoot ?? createRoot(rootElement)
globalWithRoot.__moceRoot = appRoot
appRoot.render(<React.StrictMode><App /></React.StrictMode>)
