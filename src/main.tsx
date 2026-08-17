import React, { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Box, Brush, ChevronDown, ChevronLeft, ChevronRight, Cloud, Database, Download, Eraser, Eye, FilePlus2, Grid3X3, Image as ImageIcon, Layers3, Lock, LogIn, Minus, Move3d, Paintbrush, Palette, Plus, Redo2, Repeat2, RotateCcw, RotateCw, Save, Search, Settings, SlidersHorizontal, Square, SquareDashedMousePointer, ToolCase, Trash2, Undo2, Upload, UserRound, WandSparkles, X } from 'lucide-react'
import { AssetAssembly, DEFAULT_ASSET_CATEGORY, MATERIALS, Material, MAX_SCENE_BOUND_VOXELS, MIN_SCENE_BOUND_VOXELS, ProjectState, SceneAssembly, SceneBounds, SceneEntityPart, SceneInstance, Voxel, VoxelAsset, VoxelOverride, VOXEL_WORLD_SIZE, adjacentVoxel, assetOriginGridCoordinate, customEntityOffset, instanceRotationPivot, instanceVoxelPairs, isBundledDefaultSampleProject, isLegacyDefaultSampleProject, makeAssemblyAssetFromSceneParts, makeAssetFromSceneParts, makeDefaultProject, makeEmptyProject, makeStlWithDiagnostics, migrateLegacyDefaultSampleProject, mirrorVoxels, normalizeAssetCategoryPath, normalizeInstanceRotationPivot, normalizeProjectNaming, normalizeVoxelSizeMm, resolveInstanceComponents, resolveInstanceSceneVoxels, resolveInstanceVoxels, rotateVoxels, sceneAssemblyNodeNameForAsset, sceneAssemblies, sceneBoundsForProject, sceneEntityParts, sceneInstanceGeometrySignature, sceneInstanceRenderSignature, sceneNameForAsset, scenePartVoxelAt, scenePartVoxelAtCoordinate, scenePartVoxels, sceneToStoredCustomVoxel, snapAssetOrigin, snapWorld, translateWorldByVoxels, uniqueAssetName, uniqueSceneName, uniqueTemplateAssetName, voxelBounds, voxelCenterToWorld, voxelComponentAt, voxelComponentId, voxelComponents, voxelEntityId, voxelToWorld, worldToVoxel, worldToVoxelCell, worldToVoxelCenter } from './voxel'
import { createSceneFile, MoceSceneFile, restoreProject, sceneContentSignature } from './scene-file'
import { LibraryResponse, LibrarySceneSummary, validateEntityFile } from './persistence'
import { deleteLocalAsset, deleteLocalScene, duplicateLocalScene, initializeLocalLibrary, loadLocalLibrary, loadLocalScene, saveLocalAsset, saveLocalAssetCategories, saveLocalScene } from './local-library'
import { createAssetFile, createEntityFile, MoceAssetFile, MoceEntityFile, parsePortableFileText, PortableFileError } from './portable-files'
import { importModelAsVoxelAssetInWorker, MAX_TARGET_SIZE_VOXELS, ModelImportResult, VoxelizeMode } from './model-import'
import { encodeGlb, encodeVox, importVoxBufferAsVoxelAsset } from './voxel-formats'
import { SceneOccupancyIndex } from './runtime/spatial-index'
import { AssetTransformCache } from './runtime/asset-transform-cache'
import { raycastVoxelDda } from './runtime/voxel-dda'
import { ChunkMeshWorkerClient } from './runtime/chunk-mesh-client'
import { ScenePreviewInputVoxel, ScenePreviewPayload, ScenePreviewWorkerClient } from './runtime/scene-preview-client'
import { MAX_PREVIEW_VOXELS, mergePreviewFaceCells, previewVoxelKey, selectPreviewVoxels } from './preview-voxels'
import { clearLocalSceneDraft, LocalSceneDraft, LocalSceneRef, readLocalSceneDraft, readLocalSceneRef, writeLocalSceneDraft, writeLocalSceneRef } from './local-scene-session'
import { commitNumericDraft, sanitizeNumericDraft } from './numeric-input'
import { DrawingPlane, DrawOperation, EDITOR_GROUND_PLANE, VoxelAxis, VoxelTool, clampPlanePointToGround, exteriorAirKeys, exteriorSurfaceVoxels, makePlaneVoxel, planeAxes, projectVoxelToPlane, rasterizeAnchoredSphere, rasterizeCuboid, rasterizeExtrude, rasterizeLine, rasterizePlanarStroke, selectExtrudeLayer, signedExtrudeDelta, toolCellKey, uniqueVoxels } from './voxel-tools'
import { VoxelFacing, VoxelRotation, VoxelShape, VOXEL_FACE_FRAMES, applyVoxelVariant, faceLocalCoordinates, hasNonCubeVoxels, makeVoxelVariant, oppositeVoxelFacing, rotationFromFaceLocalCoordinates, voxelFacing, voxelRotation, voxelShape, variantKey } from './voxel-variants'
import { buildVariantGeometry, variantGeometryCacheKey } from './voxel-variant-geometry'
import { buildVoxelSurfaceMesh } from './voxel-surface'
import { VoxelToolsGeometryResult, VoxelToolsWorkerClient, VoxelToolsShapeRequest } from './runtime/voxel-tools-client'
import { adjustHexHsl, hexToHsl } from './color-utils'
import { SliceLayer, SlicePlane, SliceVoxel, sliceEntityParts, sliceLayerToAsset, slicePlaneLabel } from './slicing'
import { computeScale, computeShell, GeometryScaleMode, GeometryVoxel, validScaleFactors, VoxelGeometryMesh, VoxelGeometryPreview } from './voxel-geometry'
import { recordHistoryTransition, redoHistoryTransition, undoHistoryTransition } from './history'
import { createZip } from './zip'
import { assetPreviewAsset, withAssetThumbnail } from './asset-thumbnail'
import { CloudAssetSummary, CloudProgress, CloudSceneSummary, CloudUsage, deleteCloudAsset, deleteCloudScene, downloadCloudObject, loadCloudAssetPreview, loadCloudLibrary, loadCloudUsage, uploadCloudAsset, uploadCloudScene } from './cloud-backup'
import { AuthUser, loadAuthUser, loginAuthUser, logoutAuthUser, registerAuthUser, requestPasswordReset, resendVerificationEmail, resetAuthPassword, setCloudAuthRequiredHandler, verifyAuthEmail } from './auth'
import './styles.css'

function useStableEvent<T extends (...args: any[]) => any>(handler: T): T {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  return useMemo(() => ((...args: Parameters<T>) => handlerRef.current(...args)) as T, [])
}

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

type Tool = VoxelTool
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
  /** Three.js world-space height of the horizontal drag plane. */
  horizontalPlaneZ: number
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

type DrawingGesture = {
  pointerId: number
  startClientX: number
  startClientY: number
  depthStartClientX?: number
  depthStartClientY?: number
  start: { u: number; v: number; layer: number }
  current: { u: number; v: number; layer: number }
  footprintEnd?: { u: number; v: number; layer: number }
  /** Storage Y layer on which a sphere must rest. */
  baseHeight: number
  stage: 'footprint' | 'depth'
  moved: boolean
  extrudeAxis?: VoxelAxis
  extrudeSign?: 1 | -1
  extrudeDelta?: number
  extrudeStartLayer?: number
  extrudeSource?: Voxel[]
  extrudeSessionId?: string
  extrudeSourceUploaded?: boolean
  extrudePreviewKey?: string
  extrudeHitVoxel?: Pick<Voxel, 'x' | 'y' | 'z'>
  extrudeDirectionLocked?: boolean
  extrudeStartScreen?: { x: number; y: number }
  extrudeScreenVector?: { x: number; y: number }
  operation?: DrawOperation
  variantFacing?: VoxelFacing
  variantRotation?: VoxelRotation
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

type SceneTransformAxis = 'x' | 'y' | 'z'

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

type DiscreteTransformPreviewState = {
  mode: 'mirror' | 'rotate'
  axis: SceneTransformAxis
  degrees: 90 | 180 | 270
  sourcePartIds: string[]
  sourceInstanceIds: string[]
  sourceCustomIds: string[]
  asset: VoxelAsset
  origin: { x: number; y: number; z: number }
  valid: boolean
  invalidReason?: 'collision' | 'boundary'
}

type DiscreteTransformSelection = {
  sourcePartIds: Set<string>
  instanceIds: Set<string>
  customIds: Set<string>
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
  entityId: string
  x: number
  y: number
} | null

type SceneLibraryEntity = {
  id: string
  name: string
  subtitle: string
  /**
   * Scene-library rows only need tree metadata. Building a VoxelAsset for
   * every row eagerly duplicates every voxel in the selected scene and makes
   * opening a large scene block the main thread. The asset is reconstructed
   * only when the row menu performs an operation that actually needs it.
   */
  partIds: string[]
  memberKeys: string[]
  instanceIds: string[]
  assemblyIds: string[]
}

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

type SceneFileRef = LocalSceneRef

type UnsavedDecision = 'cancel' | 'save' | 'discard'

type SceneTreeItem = {
  id: string
  label: string
  kind: 'assembly' | 'part'
  assemblyId?: string
  part?: SceneEntityPart
  children?: SceneTreeItem[]
}

type PersistenceStatus = 'loading' | 'saved' | 'offline'
const MIN_ZOOM_LEVEL = 50
const MAX_ZOOM_LEVEL = 20000
const WHEEL_ZOOM_INPUT_GAIN = 4
const BUTTON_ZOOM_STEP_FACTOR = 1.25

function clampZoomLevel(value: number): number {
  return Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, value))
}

function zoomTrackProgress(value: number): number {
  const zoom = clampZoomLevel(value)
  const range = Math.log(MAX_ZOOM_LEVEL / MIN_ZOOM_LEVEL)
  if (!Number.isFinite(range) || range <= 0) return 0
  return (Math.log(zoom / MIN_ZOOM_LEVEL) / range) * 100
}

function stepZoomLevel(value: number, direction: 1 | -1): number {
  return clampZoomLevel(value * (direction > 0 ? BUTTON_ZOOM_STEP_FACTOR : 1 / BUTTON_ZOOM_STEP_FACTOR))
}

function formatVoxelSizeMm(value: number): string {
  return normalizeVoxelSizeMm(value).toString()
}

type NumericInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max'> & {
  value: number
  min?: number
  max?: number
  integer?: boolean
  onCommit: (value: number) => void
}

function NumericInput({ value, min, max, integer = false, onCommit, onBlur, onKeyDown, ...props }: NumericInputProps) {
  const [draft, setDraft] = useState(() => String(value))
  const focusedRef = useRef(false)
  const committedValueRef = useRef(value)

  useEffect(() => {
    committedValueRef.current = value
    if (!focusedRef.current) setDraft(String(value))
  }, [value])

  const commit = () => {
    const next = commitNumericDraft(draft, committedValueRef.current, { min, max, integer })
    committedValueRef.current = next
    setDraft(String(next))
    if (next !== value) onCommit(next)
    else onCommit(next)
  }

  return <input
    {...props}
    type="text"
    inputMode="decimal"
    value={draft}
    onFocus={() => { focusedRef.current = true }}
    onChange={(event) => setDraft(sanitizeNumericDraft(event.target.value))}
    onBlur={(event) => { focusedRef.current = false; commit(); onBlur?.(event) }}
    onKeyDown={(event) => {
      if (event.key === 'Enter') event.currentTarget.blur()
      onKeyDown?.(event)
    }}
  />
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
  const firstPart = parts[0]
  const firstVoxel = firstPart ? scenePartVoxelAt(firstPart, 0) : undefined
  return firstPart && firstVoxel
    ? scenePartVoxelDisplayColor(project, firstPart, firstVoxel)
    : asset?.templateColor ?? asset?.color ?? '#6c827d'
}

function scenePartVoxelDisplayColor(project: ProjectState, part: SceneEntityPart, voxel: Voxel): string {
  const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
  const asset = instance ? project.assets.find((item) => item.id === instance.assetId) : undefined
  const variant = asset && !asset.templateColor ? styleMaterialVariants[instance?.style ?? ''] : undefined
  const renderAsset = variant && asset ? { ...asset, color: variant.color, accent: variant.accent } : asset
  const paintedColor = voxel.paintMaterialId
    ? materialColorForVoxel(project, { ...voxel, materialId: voxel.paintMaterialId }, renderAsset)
    : undefined
  return paintedColor ?? part.colorOverride ?? renderAsset?.templateColor ?? materialColorForVoxel(project, voxel, renderAsset)
}

function createScenePartVoxelDisplayColorResolver(project: ProjectState): (voxel: Voxel, part: SceneEntityPart) => string {
  const instanceMap = new Map(project.instances.map((instance) => [instance.id, instance]))
  const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
  const materialMap = new Map([
    ...MATERIALS.map((material) => [material.id, material.color] as const),
    ...(project.materials ?? []).map((material) => [material.id, material.color] as const),
  ])
  return (voxel, part) => {
    const instance = part.instanceId ? instanceMap.get(part.instanceId) : undefined
    const asset = instance ? assetMap.get(instance.assetId) : undefined
    const variant = asset && !asset.templateColor ? styleMaterialVariants[instance?.style ?? ''] : undefined
    const renderColor = variant?.color ?? asset?.color
    const renderAccent = variant?.accent ?? asset?.accent
    const paintedColor = voxel.paintMaterialId
      ? materialMap.get(voxel.paintMaterialId) ?? (voxel.paintMaterialId.startsWith('#') ? voxel.paintMaterialId : undefined)
      : undefined
    if (paintedColor) return typeof paintedColor === 'string' ? paintedColor : paintedColor
    if (part.colorOverride) return part.colorOverride
    if (asset?.templateColor) return asset.templateColor
    if (voxel.materialId.startsWith('#')) return voxel.materialId
    if (voxel.materialId === 'primary') return renderColor ?? '#6c827d'
    if (voxel.materialId === 'accent') return renderAccent ?? '#d2a354'
    return materialMap.get(voxel.materialId) ?? renderColor ?? '#6c827d'
  }
}

// Keep the historical dynamic preview budget. It is derived from the maximum
// supported model dimension rather than an arbitrary fixed count. The scene
// preview is now worker-backed, so the larger budget no longer blocks React.
const SCENE_LIBRARY_PREVIEW_MAX_VOXELS = MAX_PREVIEW_VOXELS

function sceneLibraryPreviewParts(project: ProjectState): SceneEntityPart[] {
  // Do not sample or build preview geometry here. This function is deliberately
  // the complete scene-to-voxel source stage. Sampling, occlusion and face
  // merging happen in ScenePreviewWorkerClient so selecting a scene never
  // blocks React's render thread.
  return sceneEntityParts(project)
}

type NormalizeStoredProjectOptions = {
  normalizeNaming?: boolean
}

/**
 * Materialize an asset instance into scene-owned voxel entities.
 *
 * The asset library is a template catalog. Once an item enters a scene it
 * must not retain the asset-instance transform semantics: those semantics use
 * a centered asset origin, a separate part offset and a lazy scene mapping,
 * while hand-drawn entities use one integer scene grid. Keeping both formats
 * alive is what allowed a rendered drag position and the occupancy position to
 * disagree. This conversion deliberately bakes the complete effective scene
 * coordinate and the displayed color into customVoxels.
 */
function materializeProjectInstances(project: ProjectState): ProjectState {
  if (!project.instances.length) return project

  const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
  const nextCustomVoxels = [...project.customVoxels]
  const nextCustomColors = { ...(project.customColors ?? {}) }
  const nextCustomSources = { ...(project.customEntitySources ?? {}) }
  const nextCustomOffsets = { ...(project.customEntityOffsets ?? {}) }
  const nextAssemblies = (project.assemblies ?? []).map((assembly) => ({ ...assembly, memberKeys: [...assembly.memberKeys] }))
  const usedEntityIds = new Set(nextCustomVoxels.map((voxel) => voxelEntityId(voxel)))
  const consumedNonTemplateAssetIds = new Set<string>()
  const instancePartKeys = new Map<string, Map<string, string[]>>()
  const remappedNames = { ...(project.entityNames ?? {}) }
  const remappedNameModes = { ...(project.entityNameModes ?? {}) }
  const remappedNameSequences = { ...(project.entityNameSequences ?? {}) }
  const remappedNameParents = { ...(project.entityNameParents ?? {}) }
  const remappedLockedKeys = new Set(project.lockedMemberKeys ?? [])
  let generatedIndex = 1

  const uniqueEntityId = (instanceId: string, partId: string) => {
    const base = `voxel-${instanceId}-${partId.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'entity'}`
    let candidate = base
    while (usedEntityIds.has(candidate)) candidate = `${base}-${generatedIndex++}`
    usedEntityIds.add(candidate)
    return candidate
  }

  const colorForInstanceVoxel = (instance: SceneInstance, asset: VoxelAsset, voxel: Voxel) => {
    const variant = !asset.templateColor ? styleMaterialVariants[instance.style] : undefined
    const renderAsset = variant ? { ...asset, color: variant.color, accent: variant.accent } : asset
    const paintedColor = voxel.paintMaterialId
      ? materialColorForVoxel(project, { ...voxel, materialId: voxel.paintMaterialId }, renderAsset)
      : undefined
    return paintedColor
      ?? instance.colorOverride
      ?? renderAsset.templateColor
      ?? materialColorForVoxel(project, voxel, renderAsset)
  }

  const copyNameMetadata = (oldKey: string, newKey: string) => {
    if (project.entityNames?.[oldKey] !== undefined) remappedNames[newKey] = project.entityNames[oldKey]
    if (project.entityNameModes?.[oldKey] !== undefined) remappedNameModes[newKey] = project.entityNameModes[oldKey]
    if (project.entityNameSequences?.[oldKey] !== undefined) remappedNameSequences[newKey] = project.entityNameSequences[oldKey]
    if (project.entityNameParents?.[oldKey] !== undefined) remappedNameParents[newKey] = project.entityNameParents[oldKey]
    if (remappedLockedKeys.has(oldKey)) {
      remappedLockedKeys.delete(oldKey)
      remappedLockedKeys.add(newKey)
    }
  }

  project.instances.forEach((instance) => {
    const asset = assetMap.get(instance.assetId)
    if (!asset) return
    if (asset.isTemplate !== true) consumedNonTemplateAssetIds.add(asset.id)

    const resolvedPairs = instanceVoxelPairs(instance, asset)
    // A non-assembly asset is one scene entity, regardless of how many
    // internal component arrays the source asset used. Keeping those arrays
    // separate here was one of the remaining differences between a hand
    // drawn entity and a dragged template. Assemblies retain their explicit
    // part boundaries below.
    const componentPairs = new Map<string, Array<{ local: Voxel; scene: Voxel }>>()
    if (asset.assembly) {
      resolvedPairs.forEach((pair) => {
        const list = componentPairs.get(pair.partId) ?? []
        list.push(pair)
        componentPairs.set(pair.partId, list)
      })
    } else {
      componentPairs.set('__asset__', resolvedPairs)
    }
    const partKeyMap = new Map<string, string[]>()
    instancePartKeys.set(instance.id, partKeyMap)
    componentPairs.forEach((pairs, partId) => {
      const entityId = uniqueEntityId(instance.id, partId)
      const customVoxels = pairs.map(({ local, scene }) => {
        // Paint is an asset-instance override. Once the instance is
        // materialized, its displayed color is baked into materialId and the
        // lazy override field must not survive into the custom-voxel path.
        const { paintMaterialId: _paintMaterialId, ...sceneVoxel } = scene
        return {
          ...sceneVoxel,
          materialId: colorForInstanceVoxel(instance, asset, local),
          entityId,
        }
      })
      nextCustomVoxels.push(...customVoxels)
      partKeyMap.set(partId, [entityId])

      const sourceAssetId = asset.isTemplate === true
        ? asset.id
        : asset.templateSourceId && project.assets.some((candidate) => candidate.id === asset.templateSourceId && candidate.isTemplate === true)
          ? asset.templateSourceId
          : undefined
      if (sourceAssetId) {
        const sourceAsset = assetMap.get(sourceAssetId)
        nextCustomSources[entityId] = {
          assetId: sourceAssetId,
          ...(sourceAsset?.categoryPath ? { categoryPath: normalizeAssetCategoryPath(sourceAsset.categoryPath) } : {}),
        }
      }

      copyNameMetadata(`asset:${instance.id}:${partId}`, `voxel:${entityId}`)
      const previousRootNameKey = `asset:${instance.id}`
      if (project.entityNames?.[previousRootNameKey] !== undefined && !remappedNames[`voxel:${entityId}`]) {
        remappedNames[`voxel:${entityId}`] = project.entityNames[previousRootNameKey]
      }
      if (project.entityNameModes?.[previousRootNameKey] !== undefined && !remappedNameModes[`voxel:${entityId}`]) {
        remappedNameModes[`voxel:${entityId}`] = project.entityNameModes[previousRootNameKey]
      }
    })

    // Materialize an embedded asset assembly as ordinary scene assemblies and
    // remap its part/child references to voxel:* keys.
    if (asset.assembly) {
      const assemblyMap = new Map<string, string>()
      asset.assembly.nodes.forEach((node) => assemblyMap.set(node.id, `assembly-materialized-${instance.id}-${node.id}`))
      asset.assembly.nodes.forEach((node) => {
        const memberKeys = [...new Set(node.memberKeys.flatMap((memberKey) => {
          if (memberKey.startsWith('assembly:')) {
            const mapped = assemblyMap.get(memberKey.slice('assembly:'.length))
            return mapped ? [`assembly:${mapped}`] : []
          }
          if (memberKey.startsWith('part:')) {
            return (partKeyMap.get(memberKey.slice('part:'.length)) ?? []).map((entityId) => `voxel:${entityId}`)
          }
          return []
        }))]
        if (memberKeys.length >= 2) {
          nextAssemblies.push({
            id: assemblyMap.get(node.id)!,
            name: sceneAssemblyNodeNameForAsset(asset, node),
            memberKeys,
          })
        }
      })
    }
  })

  const remapAssetMemberKey = (memberKey: string): string[] => {
    for (const [instanceId, partMap] of instancePartKeys) {
      const prefix = `asset:${instanceId}:`
      if (memberKey.startsWith(prefix)) {
        const partId = memberKey.slice(prefix.length)
        return (partMap.get(partId) ?? []).map((entityId) => `voxel:${entityId}`)
      }
      if (memberKey === `asset:${instanceId}`) {
        return [...partMap.values()].flat().map((entityId) => `voxel:${entityId}`)
      }
    }
    return [memberKey]
  }
  for (const assembly of nextAssemblies) {
    assembly.memberKeys = [...new Set(assembly.memberKeys.flatMap(remapAssetMemberKey))]
  }
  for (const instanceId of instancePartKeys.keys()) {
    const oldKeys = [`asset:${instanceId}`, ...[...instancePartKeys.get(instanceId)!.keys()].map((partId) => `asset:${instanceId}:${partId}`)]
    oldKeys.forEach((oldKey) => {
      const mapped = remapAssetMemberKey(oldKey)
      if (remappedLockedKeys.has(oldKey)) {
        remappedLockedKeys.delete(oldKey)
        mapped.forEach((key) => remappedLockedKeys.add(key))
      }
    })
  }

  const assets = project.assets.filter((asset) => !consumedNonTemplateAssetIds.has(asset.id))
  return {
    ...project,
    assets,
    instances: [],
    customVoxels: nextCustomVoxels,
    customColors: nextCustomColors,
    customEntitySources: nextCustomSources,
    customEntityOffsets: nextCustomOffsets,
    assemblies: nextAssemblies.filter((assembly) => assembly.memberKeys.length >= 2),
    entityNames: remappedNames,
    entityNameModes: remappedNameModes,
    entityNameSequences: remappedNameSequences,
    entityNameParents: remappedNameParents,
    lockedMemberKeys: [...remappedLockedKeys],
  }
}

function normalizeStoredProject(loaded: ProjectState, options: NormalizeStoredProjectOptions = {}): ProjectState {
  const migrated = isLegacyDefaultSampleProject(loaded) ? migrateLegacyDefaultSampleProject(loaded) : loaded
  const defaultAssets = new Map(makeDefaultProject().assets.map((asset) => [asset.id, asset]))
  const normalized: ProjectState = {
    ...migrated,
    voxelSizeMm: normalizeVoxelSizeMm(migrated.voxelSizeMm),
    sceneBounds: sceneBoundsForProject(migrated),
    assets: (migrated.assets ?? []).map((asset) => ({
      ...asset,
      categoryPath: normalizeAssetCategoryPath(asset.categoryPath),
      partVoxels: asset.partVoxels ?? defaultAssets.get(asset.id)?.partVoxels,
      isTemplate: asset.isTemplate ?? (!asset.source || asset.source === '场景实体保存' || (asset.kind !== 'imported' && !asset.source.includes('拆分子实体'))),
    })),
    customVoxels: (migrated.customVoxels ?? []).map((voxel, index) => ({ ...voxel, entityId: voxel.entityId ?? `legacy-${voxel.x}-${voxel.y}-${voxel.z}-${index}` })),
    customVoxelRenderModes: (() => {
      const renderModes = { ...(migrated.customVoxelRenderModes ?? {}) }
      const migratedCustomVoxels = migrated.customVoxels ?? []
      // Repair projects written by versions that persisted the enlarged
      // voxel payload but not its cell-preserving render mode. The marker is
      // intentionally per voxel, so this remains safe for mixed scenes.
      migratedCustomVoxels.forEach((voxel) => {
        if (!voxel.preserveVoxelCells || !voxel.entityId) return
        renderModes[voxel.entityId] = 'cells'
      })
      return renderModes
    })(),
    customColors: { ...(migrated.customColors ?? {}) },
    customEntitySources: Object.fromEntries(Object.entries(migrated.customEntitySources ?? {}).map(([entityId, source]) => [entityId, {
      assetId: source.assetId,
      ...(source.categoryPath ? { categoryPath: normalizeAssetCategoryPath(source.categoryPath) } : {}),
    }])),
    customEntityOffsets: Object.fromEntries(Object.entries(migrated.customEntityOffsets ?? {}).map(([entityId, offset]) => [entityId, {
      x: Math.round(offset.x),
      y: Math.round(offset.y),
      z: Math.round(offset.z),
    }])),
    entityNames: { ...(migrated.entityNames ?? {}) },
    entityNameModes: { ...(migrated.entityNameModes ?? {}) },
    entityNameSequences: { ...(migrated.entityNameSequences ?? {}) },
    entityNameParents: { ...(migrated.entityNameParents ?? {}) },
    entitySequenceCounters: { ...(migrated.entitySequenceCounters ?? {}) },
    assemblySequence: Math.max(1, migrated.assemblySequence ?? 1),
    assemblyChildSequence: { ...(migrated.assemblyChildSequence ?? {}) },
    childSequenceCounters: { ...(migrated.childSequenceCounters ?? {}) },
    assemblies: (migrated.assemblies ?? []).map((assembly) => ({ ...assembly, memberKeys: [...assembly.memberKeys] })),
    instances: [],
    lockedMemberKeys: [...new Set(migrated.lockedMemberKeys ?? [])],
  }
  const assetMap = new Map(normalized.assets.map((asset) => [asset.id, asset]))
  normalized.instances = (migrated.instances ?? []).map((instance) => {
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
  const materialized = materializeProjectInstances(normalized)
  normalized.assets = materialized.assets
  normalized.instances = materialized.instances
  normalized.customVoxels = materialized.customVoxels
  normalized.customColors = materialized.customColors
  normalized.customEntitySources = materialized.customEntitySources
  normalized.customEntityOffsets = materialized.customEntityOffsets
  normalized.assemblies = materialized.assemblies
  normalized.entityNames = materialized.entityNames
  normalized.entityNameModes = materialized.entityNameModes
  normalized.entityNameSequences = materialized.entityNameSequences
  normalized.entityNameParents = materialized.entityNameParents
  normalized.lockedMemberKeys = materialized.lockedMemberKeys
  // Scene-library previews are read-only. Avoid the expensive deep clone and
  // full naming traversal there; the stored scene already contains its tree
  // names, while the editable project path still keeps the full normalization.
  return options.normalizeNaming === false ? normalized : normalizeProjectNaming(normalized)
}

/**
 * Finalize a project that was edited through the voxel stroke transaction.
 *
 * The transaction starts from an already normalized project and clones its
 * mutable scene collections up front. Running the general storage normalizer
 * here would clone every asset and voxel again on pointer-up. Keep this path
 * deliberately narrow: preserve immutable catalogs and existing voxel
 * objects, repair only legacy IDs that may have been encountered, refresh the
 * cheap derived bounds, and normalize the tree names in-place on the cloned
 * scene collections.
 */
function finalizeVoxelStrokeProject(project: ProjectState): ProjectState {
  // The live editor has one scene-entity representation only. Never publish
  // an obsolete instance payload from a stroke transaction.
  if (project.instances.length) return normalizeStoredProject(project, { normalizeNaming: false })
  if (isLegacyDefaultSampleProject(project)) return normalizeStoredProject(project)
  const customVoxels = project.customVoxels.some((voxel) => !voxel.entityId)
    ? project.customVoxels.map((voxel, index) => ({ ...voxel, entityId: voxel.entityId ?? `legacy-${voxel.x}-${voxel.y}-${voxel.z}-${index}` }))
    : project.customVoxels
  const next: ProjectState = {
    ...project,
    voxelSizeMm: normalizeVoxelSizeMm(project.voxelSizeMm),
    sceneBounds: sceneBoundsForProject(project),
    customVoxels,
    lockedMemberKeys: project.lockedMemberKeys ? [...new Set(project.lockedMemberKeys)] : [],
  }
  return normalizeProjectNaming(next, { clone: false })
}

/**
 * Copy the mutable project shell without cloning the potentially huge voxel
 * arrays inside assets and custom voxels. Current mutation handlers replace
 * voxel objects/arrays rather than editing an existing voxel object in place;
 * instances, materials, asset records, assemblies and lookup maps are copied
 * because those are the fields the handlers may mutate directly.
 */
function cloneProjectForMutation(source: ProjectState, options: { shareCatalogs?: boolean } = {}): ProjectState {
  const shareCatalogs = options.shareCatalogs === true
  return {
    ...source,
    assets: shareCatalogs ? source.assets : source.assets.map((asset) => ({ ...asset })),
    materials: shareCatalogs ? source.materials : source.materials.map((material) => ({ ...material })),
    instances: source.instances.map((instance) => ({
      ...instance,
      overrides: instance.overrides?.map((override) => ({ ...override })),
      partOffsets: instance.partOffsets
        ? Object.fromEntries(Object.entries(instance.partOffsets).map(([partId, offset]) => [partId, { ...offset }]))
        : undefined,
      mirror: instance.mirror ? { ...instance.mirror } : undefined,
    })),
    customVoxels: [...source.customVoxels],
    customVoxelRenderModes: source.customVoxelRenderModes ? { ...source.customVoxelRenderModes } : undefined,
    customColors: source.customColors ? { ...source.customColors } : undefined,
    customEntitySources: source.customEntitySources
      ? Object.fromEntries(Object.entries(source.customEntitySources).map(([entityId, source]) => [entityId, { ...source, categoryPath: source.categoryPath ? [...source.categoryPath] : undefined }]))
      : undefined,
    customEntityOffsets: source.customEntityOffsets
      ? Object.fromEntries(Object.entries(source.customEntityOffsets).map(([entityId, offset]) => [entityId, { ...offset }]))
      : undefined,
    entityNames: source.entityNames ? { ...source.entityNames } : undefined,
    entityNameModes: source.entityNameModes ? { ...source.entityNameModes } : undefined,
    entityNameSequences: source.entityNameSequences ? { ...source.entityNameSequences } : undefined,
    entityNameParents: source.entityNameParents ? { ...source.entityNameParents } : undefined,
    entitySequenceCounters: source.entitySequenceCounters ? { ...source.entitySequenceCounters } : undefined,
    assemblyChildSequence: source.assemblyChildSequence ? { ...source.assemblyChildSequence } : undefined,
    childSequenceCounters: source.childSequenceCounters ? { ...source.childSequenceCounters } : undefined,
    assemblies: source.assemblies?.map((assembly) => ({ ...assembly, memberKeys: [...assembly.memberKeys] })),
    lockedMemberKeys: source.lockedMemberKeys ? [...source.lockedMemberKeys] : undefined,
  }
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

type GridVoxelBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

const gridVoxelBoundsCache = new WeakMap<object, GridVoxelBounds | null>()

function gridVoxelBounds(voxels: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>): GridVoxelBounds | null {
  if (!voxels.length) return null
  const cacheKey = voxels as object
  if (gridVoxelBoundsCache.has(cacheKey)) return gridVoxelBoundsCache.get(cacheKey) ?? null
  const bounds = voxels.reduce((nextBounds, voxel) => ({
    minX: Math.min(nextBounds.minX, voxel.x),
    maxX: Math.max(nextBounds.maxX, voxel.x),
    minY: Math.min(nextBounds.minY, voxel.y),
    maxY: Math.max(nextBounds.maxY, voxel.y),
    minZ: Math.min(nextBounds.minZ, voxel.z),
    maxZ: Math.max(nextBounds.maxZ, voxel.z),
  }), {
    minX: voxels[0].x,
    maxX: voxels[0].x,
    minY: voxels[0].y,
    maxY: voxels[0].y,
    minZ: voxels[0].z,
    maxZ: voxels[0].z,
  })
  gridVoxelBoundsCache.set(cacheKey, bounds)
  return bounds
}

function scenePartGridOffset(part: Pick<SceneEntityPart, 'sceneOffset' | 'partSceneOffset'>): { x: number; y: number; z: number } {
  return {
    x: (part.sceneOffset?.x ?? 0) + (part.partSceneOffset?.x ?? 0),
    y: (part.sceneOffset?.y ?? 0) + (part.partSceneOffset?.y ?? 0),
    z: (part.sceneOffset?.z ?? 0) + (part.partSceneOffset?.z ?? 0),
  }
}

/**
 * The occupancy index is the fast path used during pointer movement. Shape
 * tools, however, commit asynchronously after a Worker result returns. At
 * that boundary an index can still represent the previous published scene
 * snapshot, so use an exact, AABB-pruned check as the final authority.
 */
function shapeBatchCollidesWithScene(
  targets: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>,
  parts: ReadonlyArray<SceneEntityPart>,
  excludedOwnerIds: Iterable<string>,
): boolean {
  if (!targets.length) return false
  const targetBounds = gridVoxelBounds(targets)
  if (!targetBounds) return false
  const targetKeys = new Set(targets.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
  const excluded = new Set(excludedOwnerIds)
  for (const part of parts) {
    if (excluded.has(part.id)) continue
    const localBounds = gridVoxelBounds(part.voxels)
    if (!localBounds) continue
    const offset = scenePartGridOffset(part)
    const bounds = {
      minX: localBounds.minX + offset.x,
      maxX: localBounds.maxX + offset.x,
      minY: localBounds.minY + offset.y,
      maxY: localBounds.maxY + offset.y,
      minZ: localBounds.minZ + offset.z,
      maxZ: localBounds.maxZ + offset.z,
    }
    if (bounds.maxX < targetBounds.minX || bounds.minX > targetBounds.maxX
      || bounds.maxY < targetBounds.minY || bounds.minY > targetBounds.maxY
      || bounds.maxZ < targetBounds.minZ || bounds.minZ > targetBounds.maxZ) continue
    // part.voxels are in the part's canonical coordinates; apply the scene
    // offset exactly once here. Calling scenePartVoxels() and then adding the
    // offset again would move translated entities twice and could both miss a
    // real collision and report a false one.
    for (const voxel of part.voxels) {
      const x = voxel.x + offset.x
      const y = voxel.y + offset.y
      const z = voxel.z + offset.z
      if (targetKeys.has(`${x},${y},${z}`)) return true
    }
  }
  return false
}

function scenePartsGridBounds(parts: ReadonlyArray<SceneEntityPart>, occupancyIndex?: SceneOccupancyIndex | null): GridVoxelBounds | null {
  let combined: GridVoxelBounds | null = null
  parts.forEach((part) => {
    const indexed = occupancyIndex?.getProjectBounds(part.id)
    const translated = indexed ?? (() => {
      const local = gridVoxelBounds(part.voxels)
      if (!local) return null
      const offset = scenePartGridOffset(part)
      return {
        minX: local.minX + offset.x,
        maxX: local.maxX + offset.x,
        minY: local.minY + offset.y,
        maxY: local.maxY + offset.y,
        minZ: local.minZ + offset.z,
        maxZ: local.maxZ + offset.z,
      }
    })()
    if (!translated) return
    combined = combined
      ? {
          minX: Math.min(combined.minX, translated.minX),
          maxX: Math.max(combined.maxX, translated.maxX),
          minY: Math.min(combined.minY, translated.minY),
          maxY: Math.max(combined.maxY, translated.maxY),
          minZ: Math.min(combined.minZ, translated.minZ),
          maxZ: Math.max(combined.maxZ, translated.maxZ),
        }
      : translated
  })
  return combined
}

function translatedVoxelBoundsWithinScene(bounds: GridVoxelBounds, sceneBounds: SceneBounds, deltaX: number, deltaY: number, deltaZ: number): boolean {
  // The scene uses X/Y as the ground plane and Z as height at runtime, while
  // project voxels store X/Z on the ground and Y as height.
  const minX = Math.ceil(-sceneBounds.x / 2 - 0.5)
  const maxX = Math.floor(sceneBounds.x / 2 - 0.5)
  const minZ = Math.ceil(-sceneBounds.y / 2 - 0.5)
  const maxZ = Math.floor(sceneBounds.y / 2 - 0.5)
  return bounds.minX + deltaX >= minX
    && bounds.maxX + deltaX <= maxX
    && bounds.minZ + deltaZ >= minZ
    && bounds.maxZ + deltaZ <= maxZ
    && bounds.minY + deltaY >= 0
    && bounds.maxY + deltaY < sceneBounds.z
}

const sharedVoxelBoxGeometry = new THREE.BoxGeometry(VOXEL_WORLD_SIZE, VOXEL_WORLD_SIZE, VOXEL_WORLD_SIZE)
sharedVoxelBoxGeometry.userData.sharedRuntimeGeometry = true
const sharedVariantGeometryCache = new Map<string, THREE.BufferGeometry>()

function variantMountingFaceCovered(voxel: Pick<Voxel, 'x' | 'y' | 'z' | 'facing'>, occupied: ReadonlyMap<string, Voxel>): boolean {
  const normal = VOXEL_FACE_FRAMES[voxelFacing(voxel)].normal
  const neighbor = occupied.get(`${voxel.x + normal[0]},${voxel.y + normal[1]},${voxel.z + normal[2]}`)
  if (!neighbor) return false
  // A neighboring non-cube does not automatically cover this cell's square
  // mounting face. Only omit the coplanar face when the neighbor is a cube or
  // its own mounting face points exactly back at this voxel. Otherwise the
  // two shapes can be adjacent while their visible surfaces are different,
  // and removing the face produces the missing-texture artifact.
  return voxelShape(neighbor) === 'cube'
    || voxelFacing(neighbor) === oppositeVoxelFacing(voxelFacing(voxel))
}

function sharedVariantThreeGeometry(voxel: Voxel, includeMountingFace = true): THREE.BufferGeometry {
  const shape = voxelShape(voxel)
  const key = variantGeometryCacheKey(shape as Exclude<VoxelShape, 'cube'>, voxelFacing(voxel), voxelRotation(voxel), includeMountingFace)
  const cached = sharedVariantGeometryCache.get(key)
  if (cached) return cached
  const source = buildVariantGeometry(shape as Exclude<VoxelShape, 'cube'>, voxelFacing(voxel), voxelRotation(voxel), includeMountingFace)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions.map((value) => value * VOXEL_WORLD_SIZE), 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(source.normals, 3))
  geometry.setIndex(source.indices)
  geometry.computeBoundingSphere()
  geometry.userData.sharedRuntimeGeometry = true
  sharedVariantGeometryCache.set(key, geometry)
  return geometry
}

function disposeThreeObject(object: THREE.Object3D) {
  const cancelCellBuild = object.userData.cancelCellBuild as (() => void) | undefined
  cancelCellBuild?.()
  const disposedGeometries = new Set<THREE.BufferGeometry>()
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      if (!child.geometry.userData.sharedRuntimeGeometry && !disposedGeometries.has(child.geometry)) {
        disposedGeometries.add(child.geometry)
        child.geometry.dispose()
      }
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

function resolveGridMove(
  deltaX: number,
  deltaY: number,
  deltaZ: number,
  canOccupy: (deltaX: number, deltaY: number, deltaZ: number) => boolean,
  allowAxisSlide = true,
): GridMoveResult {
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

    // Scene dragging must stop at the first blocked requested position. The
    // old fallback below tried an alternate horizontal axis, which made a
    // dragged entity appear to slip sideways through another entity and also
    // caused a small release-time "flight" away from the cursor. Other
    // callers (asset placement/custom movement) retain the legacy slide
    // behavior through the default value.
    if (!allowAxisSlide) break

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

const HISTORY_MAX_ENTRIES = 50

// A drag changes the project root, but usually reuses the same custom-voxel
// array. Cache the history budget by that immutable collection identity so
// pointer-up does not rescan the asset catalogue or rebuild legacy instance
// geometry. Scene instances are a read-only migration input, never part of
// the live scene budget.
const historyLimitCache = new WeakMap<ReadonlyArray<Voxel>, number>()

function historyLimitForProject(project: ProjectState): number {
  const cached = historyLimitCache.get(project.customVoxels)
  if (cached !== undefined) return cached
  const voxelCount = project.customVoxels.length
  const limit = voxelCount >= 500_000
    ? 6
    : voxelCount >= 100_000
      ? 12
      : voxelCount >= 25_000
        ? 24
        : HISTORY_MAX_ENTRIES
  historyLimitCache.set(project.customVoxels, limit)
  return limit
}

const historyProjectSignatureCache = new WeakMap<object, string>()

function sameHistoryProject(left: ProjectState, right: ProjectState): boolean {
  if (left === right) return true
  const signatureFor = (project: ProjectState) => {
    const cached = historyProjectSignatureCache.get(project as object)
    if (cached) return cached
    const signature = sceneContentSignature(project)
    historyProjectSignatureCache.set(project as object, signature)
    return signature
  }
  try {
    return signatureFor(left) === signatureFor(right)
  } catch {
    // A malformed intermediate project must not be silently treated as a
    // no-op. The normalizer/validator will report it at the actual commit
    // boundary, while history remains conservative here.
    return false
  }
}

function sameScenePartOffset(left: { x?: number; y?: number; z?: number } | undefined, right: { x?: number; y?: number; z?: number } | undefined): boolean {
  return (left?.x ?? 0) === (right?.x ?? 0)
    && (left?.y ?? 0) === (right?.y ?? 0)
    && (left?.z ?? 0) === (right?.z ?? 0)
}

function changedOccupancyOwnerIds(currentParts: ReadonlyArray<SceneEntityPart>, targetParts: ReadonlyArray<SceneEntityPart>): Set<string> {
  const currentById = new Map(currentParts.map((part) => [part.id, part]))
  const changed = new Set<string>()
  targetParts.forEach((part) => {
    const current = currentById.get(part.id)
    if (!current
      || current.voxels !== part.voxels
      || !sameScenePartOffset(current.sceneOffset, part.sceneOffset)
      || !sameScenePartOffset(current.partSceneOffset, part.partSceneOffset)) changed.add(part.id)
    currentById.delete(part.id)
  })
  currentById.forEach((part) => changed.add(part.id))
  return changed
}

type VoxelStrokeTransaction = {
  draft: ProjectState
  original: ProjectState
  historyEditEntityId: string | null
  historySelectedId: string
  historyCheckedTreePartIds: string[]
  occupiedCustomSceneKeys: Set<string>
  dirtyOwnerIds: Set<string>
  dirtyOwnerRoots: Set<string>
  touchedOwnerIds: Set<string>
  touchedOwnerRoots: Set<string>
  publishedOwnerIds: Map<string, Set<string>>
  dirty: boolean
}

type ColorPreviewState = {
  partIds: string[]
  hueDelta: number
  saturationTarget: number
}

type GeometryOperation = 'shell' | 'scale'
type GeometryPreviewState = {
  operation: GeometryOperation
  shellThickness: number
  scaleMode: GeometryScaleMode
  scaleFactor: number
  result: VoxelGeometryPreview | null
  mesh?: VoxelGeometryMesh | null
  valid: boolean
  invalidReason?: string
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

function sameSceneRef(left: SceneFileRef | null, right: SceneFileRef | null): boolean {
  if (left?.libraryId || right?.libraryId) return Boolean(left?.libraryId && right?.libraryId && left.libraryId === right.libraryId)
  if (!left || !right) return !left && !right
  return left.name.trim() === right.name.trim()
}

function assetCategoryTreeFromAssetsAndPaths(assets: VoxelAsset[], paths: string[][]): AssetCategoryNode[] {
  return buildAssetCategoryTree([
    ...paths.map((path) => ({ path })),
    ...assets.map((asset) => ({ path: normalizeAssetCategoryPath(asset.categoryPath), asset })),
  ])
}

function App() {
  const [project, setProject] = useState<ProjectState>(() => normalizeStoredProject(makeEmptyProject()))
  const projectRef = useRef(project)
  const historyRef = useRef<{ past: ProjectHistoryEntry[]; future: ProjectHistoryEntry[] }>({ past: [], future: [] })
  // Every committed state publication gets a generation. React transitions
  // and worker callbacks from an older generation must not repaint the editor
  // after an undo/redo has restored another snapshot.
  const historyEpochRef = useRef(0)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [selectedId, setSelectedId] = useState('inst-chinese')
  // Selection is also an imperative Three.js state.  Re-clicking the same
  // entity must be able to re-assert its outline after an async render batch
  // or a stale visibility toggle has replaced/hidden the previous lines.
  const [selectionRefreshKey, setSelectionRefreshKey] = useState(0)
  // Enter the editor in entity placement/selection mode. Drawing remains an
  // explicit choice from the toolbox so a fresh visit cannot accidentally
  // modify the scene with the first viewport gesture.
  const [tool, setTool] = useState<Tool>('select')
  // The UI labels intentionally map the storage XZ plane to the editor's
  // user-facing XY ground plane. Keep the default aligned with that mapping.
  const [drawingPlane, setDrawingPlane] = useState<DrawingPlane>('xz')
  const [voxelBrushShape, setVoxelBrushShape] = useState<VoxelShape>('cube')
  const [drawOperation, setDrawOperation] = useState<DrawOperation>('add')
  const [brushSize, setBrushSize] = useState(1)
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const [referenceImageOpen, setReferenceImageOpen] = useState(false)
  const [referenceImages, setReferenceImages] = useState<Array<{ name: string; url: string }>>([])
  const [referenceImageIndex, setReferenceImageIndex] = useState(0)
  const [activeMaterial, setActiveMaterial] = useState('terracotta')
  const [recentMaterialIds, setRecentMaterialIds] = useState(() => MATERIALS.slice(0, 8).map((material) => material.id))
  const [notice, setNotice] = useState('就绪 · 本地工程未保存')
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<'正交' | '透视'>('正交')
  const [showGrid, setShowGrid] = useState(true)
  const [showBoundary, setShowBoundary] = useState(true)
  const [boundaryOpen, setBoundaryOpen] = useState(false)
  const [boundaryDraft, setBoundaryDraft] = useState<SceneBounds>(() => sceneBoundsForProject(makeEmptyProject()))
  const [voxelSizeOpen, setVoxelSizeOpen] = useState(false)
  const [voxelSizeDraft, setVoxelSizeDraft] = useState<number>(() => makeEmptyProject().voxelSizeMm)
  const [dragAxis, setDragAxis] = useState<'horizontal' | 'vertical'>('horizontal')
  const [editEntityId, setEditEntityId] = useState<string | null>(null)
  const [placementAssetId, setPlacementAssetId] = useState<string | null>(null)
  const [pendingEntityImport, setPendingEntityImport] = useState<PendingEntityImport | null>(null)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [cameraControlApi, setCameraControlApi] = useState<CameraControlApi | null>(null)
  const [copyPreview, setCopyPreview] = useState<CopyPreviewState | null>(null)
  const [transformPreview, setTransformPreview] = useState<DiscreteTransformPreviewState | null>(null)
  const [colorPreview, setColorPreview] = useState<ColorPreviewState | null>(null)
  const [geometryPreview, setGeometryPreview] = useState<GeometryPreviewState | null>(null)
  const [geometryApplying, setGeometryApplying] = useState(false)
  const geometryApplyingRef = useRef(false)
  const geometryApplyRevisionRef = useRef(0)
  const geometryWorkerRef = useRef<VoxelToolsWorkerClient | null>(null)
  const geometryRequestRevisionRef = useRef(0)
  const colorPreviewPendingRef = useRef<ColorPreviewState | null>(null)
  const colorPreviewFrameRef = useRef<number | null>(null)
  const cancelColorPreview = () => {
    if (colorPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(colorPreviewFrameRef.current)
      colorPreviewFrameRef.current = null
    }
    colorPreviewPendingRef.current = null
    setColorPreview(null)
  }
  const cancelGeometryPreview = () => {
    if (geometryApplyingRef.current) return
    geometryRequestRevisionRef.current += 1
    setGeometryPreview(null)
  }
  useEffect(() => () => {
    if (colorPreviewFrameRef.current !== null) window.cancelAnimationFrame(colorPreviewFrameRef.current)
  }, [])
  useEffect(() => {
    const client = new VoxelToolsWorkerClient()
    geometryWorkerRef.current = client
    return () => { client.dispose(); geometryWorkerRef.current = null }
  }, [])
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>('loading')
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [library, setLibrary] = useState<LibraryResponse>({ assets: [], scenes: [], assetCategories: [] })
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [cloudAssets, setCloudAssets] = useState<CloudAssetSummary[]>([])
  const [cloudAssetPreviews, setCloudAssetPreviews] = useState<Record<string, VoxelAsset>>({})
  const [cloudAssetPreviewErrors, setCloudAssetPreviewErrors] = useState<Record<string, string>>({})
  const [cloudScenes, setCloudScenes] = useState<CloudSceneSummary[]>([])
  const [cloudUsage, setCloudUsage] = useState<CloudUsage | null>(null)
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [cloudTransfers, setCloudTransfers] = useState<Record<string, CloudProgress>>({})
  const [cloudTransferErrors, setCloudTransferErrors] = useState<Record<string, string>>({})
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authDialogOpen, setAuthDialogOpen] = useState(false)
  const [authDialogMode, setAuthDialogMode] = useState<'login' | 'register' | 'forgot'>('login')
  const [sceneFileRef, setSceneFileRef] = useState<SceneFileRef | null>(null)
  const [savedSceneSignature, setSavedSceneSignature] = useState<string | null>(null)
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false)
  const [sceneLibraryContextMenu, setSceneLibraryContextMenu] = useState<SceneLibraryContextMenuState>(null)
  const [selectedLibrarySceneId, setSelectedLibrarySceneId] = useState<string | null>(null)
  const [selectedLibrarySceneProject, setSelectedLibrarySceneProject] = useState<ProjectState | null>(null)
  const [selectedLibrarySceneLoading, setSelectedLibrarySceneLoading] = useState(false)
  const [selectedLibrarySceneRevision, setSelectedLibrarySceneRevision] = useState(0)
  const [assetSidebarCollapsed, setAssetSidebarCollapsed] = useState(false)
  const [expandedAssemblies, setExpandedAssemblies] = useState<Record<string, boolean>>({})
  const [checkedTreePartIds, setCheckedTreePartIds] = useState<string[]>([])
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState>(null)
  const [assetContextMenu, setAssetContextMenu] = useState<AssetContextMenuState>(null)
  const [assetCategoryContextMenu, setAssetCategoryContextMenu] = useState<AssetCategoryContextMenuState>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [assetCategoryPaths, setAssetCategoryPaths] = useState<string[][]>(() => collectAssetCategoryPaths(makeEmptyProject().assets))
  const [assetCategorySave, setAssetCategorySave] = useState<AssetCategorySaveState>(null)
  const [sliceDialogOpen, setSliceDialogOpen] = useState(false)
  const persistenceReadyRef = useRef(false)
  const cloudInitialRefreshRef = useRef(false)
  const cloudInitialRefreshCompletedRef = useRef(false)
  const savedSceneSignatureRef = useRef<string | null>(null)
  const sceneFileRefRef = useRef<SceneFileRef | null>(null)
  const exitDraftPersistedAtRef = useRef(0)
  const interactionActiveRef = useRef(false)
  const voxelStrokeEntityRef = useRef<string | null>(null)
  const voxelStrokeTransactionRef = useRef<VoxelStrokeTransaction | null>(null)
  const voxelStrokePublishFrameRef = useRef<number | null>(null)
  const voxelStrokePartsRef = useRef<SceneEntityPart[] | null>(null)
  const voxelStrokeNoticeRef = useRef<string | null>(null)
  const sceneMoveBoundsRef = useRef<{ project: ProjectState; sourceParts: SceneEntityPart[]; parts: SceneEntityPart[]; movingIds: string[]; bounds: GridVoxelBounds | null } | null>(null)
  const sceneMoveValidationRef = useRef<{ project: ProjectState; parts: SceneEntityPart[]; deltaX: number; deltaY: number; deltaZ: number; result: GridMoveResult } | null>(null)
  const sceneLibraryLoadRequestRef = useRef(0)
  const sceneLibraryAbortRef = useRef<AbortController | null>(null)
  const sceneLibraryProjectCacheRef = useRef(new Map<string, ProjectState>())
  const geometrySourceCacheRef = useRef<{ selectionKey: string; selectionEntityKey: string; voxels: GeometryVoxel[] } | null>(null)
  const sceneDirtyRef = useRef(false)
  const entityFileInputRef = useRef<HTMLInputElement>(null)
  const modelImportInputRef = useRef<HTMLInputElement>(null)
  const referenceImageInputRef = useRef<HTMLInputElement>(null)
  const referenceImagesRef = useRef<Array<{ name: string; url: string }>>([])
  const pendingSceneOperationRef = useRef<(() => Promise<void>) | null>(null)
  const [modelImportDialog, setModelImportDialog] = useState<ModelImportDialogState | null>(null)
  const [modelImportTargetVoxels, setModelImportTargetVoxels] = useState(32)
  const [modelImportMode, setModelImportMode] = useState<VoxelizeMode>('solid')

  const openReferenceImagePicker = () => referenceImageInputRef.current?.click()
  const handleReferenceImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.currentTarget.value = ''
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (!imageFiles.length) {
      setNotice('请选择图片文件作为参考图')
      return
    }
    const addedImages = imageFiles.map((file) => ({ name: file.name, url: URL.createObjectURL(file) }))
    const firstAddedIndex = referenceImagesRef.current.length
    const nextImages = [...referenceImagesRef.current, ...addedImages]
    referenceImagesRef.current = nextImages
    setReferenceImages(nextImages)
    setReferenceImageIndex(firstAddedIndex)
    setReferenceImageOpen(true)
    if (imageFiles.length > 1) setNotice(`已添加 ${imageFiles.length} 张参考图`)
  }

  useEffect(() => {
    referenceImagesRef.current = referenceImages
  }, [referenceImages])
  useEffect(() => () => {
    referenceImagesRef.current.forEach((image) => URL.revokeObjectURL(image.url))
  }, [])

  const referenceImage = referenceImages[referenceImageIndex] ?? null

  const currentSceneBounds = sceneBoundsForProject(project)
  const refreshSceneDirty = () => {
    const savedSignature = savedSceneSignatureRef.current
    if (!savedSignature) {
      sceneDirtyRef.current = false
      return false
    }
    let dirty = false
    try {
      dirty = sceneContentSignature(projectRef.current) !== savedSignature
    } catch {
      // An invalid in-memory project must remain conservatively dirty. This
      // prevents a failed signature calculation from allowing a destructive
      // scene replacement without confirmation.
      dirty = true
    }
    sceneDirtyRef.current = dirty
    return dirty
  }

  const markSceneDirty = () => {
    // Dirty state is event-driven rather than derived during every render.
    // We only need the exact signature at a correctness boundary (New/Open,
    // exit recovery, or an explicit save); normal edits can mark the ref in
    // O(1) and return control to the browser immediately.
    if (savedSceneSignatureRef.current) sceneDirtyRef.current = true
  }

  const sceneFitsBounds = (candidate: SceneBounds, source = projectRef.current) => {
    const customSceneVoxels = sceneEntityParts(source).filter((part) => part.kind === 'custom').flatMap((part) => scenePartVoxels(part))
    if (!sceneVoxelsWithinBounds(customSceneVoxels, candidate)) return false
    const assetMap = new Map(source.assets.map((asset) => [asset.id, asset]))
    return source.instances.every((instance) => {
      const asset = assetMap.get(instance.assetId)
      return !asset || sceneVoxelsWithinBounds(resolveInstanceSceneVoxels(instance, asset), candidate)
    })
  }

  const applySceneBounds = () => {
    const next: SceneBounds = {
      x: Math.max(MIN_SCENE_BOUND_VOXELS, Math.min(MAX_SCENE_BOUND_VOXELS, Math.round(boundaryDraft.x))),
      y: Math.max(MIN_SCENE_BOUND_VOXELS, Math.min(MAX_SCENE_BOUND_VOXELS, Math.round(boundaryDraft.y))),
      z: Math.max(MIN_SCENE_BOUND_VOXELS, Math.min(MAX_SCENE_BOUND_VOXELS, Math.round(boundaryDraft.z))),
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

  const applyVoxelSize = (value = voxelSizeDraft) => {
    const next = normalizeVoxelSizeMm(value)
    updateProject((draft) => { draft.voxelSizeMm = next })
    setVoxelSizeDraft(next)
    setVoxelSizeOpen(false)
    setNotice(`已设置体素边长 · ${formatVoxelSizeMm(next)} mm · 将在 STL 导出时生效`)
  }

  const sceneParts = useMemo(() => sceneEntityParts(project), [project])
  const makeHistoryEntry = (historyProject: ProjectState): ProjectHistoryEntry => ({
    project: historyProject,
    editEntityId,
    selectedId,
    checkedTreePartIds: [...checkedTreePartIds],
  })

  const recordHistoryBeforeChange = (before: ProjectState, after: ProjectState) => {
    const afterEntry: ProjectHistoryEntry = {
      project: after,
      editEntityId,
      selectedId,
      checkedTreePartIds: [...checkedTreePartIds],
    }
    const recorded = recordHistoryTransition(
      historyRef.current,
      makeHistoryEntry(before),
      afterEntry,
      (left, right) => sameHistoryProject(left.project, right.project),
      historyLimitForProject(before),
    )
    if (recorded) historyEpochRef.current += 1
    return recorded
  }
  useEffect(() => {
    // Editing is also a tree-selection state. Keep the checkbox invariant in
    // one place so a newly-created custom entity cannot render as selected
    // (highlighted label) while its row remains unchecked after the stroke
    // transaction publishes or normalizes the project.
    if (!editEntityId) return
    const exists = editEntityId.startsWith('assembly:')
      ? Boolean(project.assemblies?.some((assembly) => `assembly:${assembly.id}` === editEntityId))
      : sceneParts.some((part) => part.id === editEntityId)
    if (!exists) return
    setCheckedTreePartIds((current) => current.includes(editEntityId) ? current : [...current, editEntityId])
  }, [editEntityId, project.assemblies, sceneParts])
  const assetTransformCacheRef = useRef<AssetTransformCache | null>(null)
  if (!assetTransformCacheRef.current) assetTransformCacheRef.current = new AssetTransformCache()
  // Placement used to validate against AssetTransformCache while the final
  // commit used instanceVoxelPairs(). Those are different representations:
  // one is centered/render-oriented and the other is scene-grid oriented.
  // Keep one canonical, scene-grid pair list per asset for the whole drag.
  const placementGeometryCacheRef = useRef(new WeakMap<VoxelAsset, {
    originX: number
    originZ: number
    pairs: Array<{ partId: string; local: Voxel; scene: Voxel }>
    sceneVoxels: Voxel[]
    bounds: GridVoxelBounds | null
  }>())
  const sceneOccupancyRef = useRef<SceneOccupancyIndex | null>(null)
  if (!sceneOccupancyRef.current) sceneOccupancyRef.current = SceneOccupancyIndex.fromParts(sceneParts)
  const skipSceneOccupancySyncRef = useRef(false)
  useEffect(() => {
    if (skipSceneOccupancySyncRef.current) {
      skipSceneOccupancySyncRef.current = false
      return
    }
    sceneOccupancyRef.current?.syncParts(sceneParts)
  }, [sceneParts])
  const sceneTreePartsKey = useMemo(() => sceneParts.map((part) => `${part.id}:${part.memberKey}:${part.instanceId ?? ''}:${part.partId}:${part.label ?? ''}:${part.assemblyIds?.join(',') ?? ''}`).join('|'), [sceneParts])
  const lockedPartIds = useMemo(() => new Set(sceneParts.filter((part) => scenePartIsLocked(project, part)).map((part) => part.id)), [sceneTreePartsKey, project.lockedMemberKeys, project.assemblies])
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
  // The inspector is memoized and intentionally ignores callback identity to
  // avoid rerendering during viewport interaction. Keep the semantic
  // transform selection in a ref so a callback retained by the inspector
  // cannot operate on the selection from the render that created it.
  const transformSelectionRef = useRef<{
    parts: SceneEntityPart[]
    selectedId: string
    selectedScenePart?: SceneEntityPart
    checkedTreePartIds: string[]
  }>({ parts: [], selectedId: '', checkedTreePartIds: [] })
  transformSelectionRef.current = { parts: selectedEntityParts, selectedId, selectedScenePart, checkedTreePartIds }
  // Keep selection identity stable across camera/zoom-only App renders. The
  // viewport uses this array as an effect dependency; rebuilding it inline in
  // JSX made every zoom ruler update rerun the scene-wide highlight pass.
  // sceneEntityParts() may refresh lightweight transform metadata after a
  // move release even though the selected entity IDs did not change. Keep the
  // ID array referentially stable in that case; the viewport's selection pass
  // traverses the rendered scene, so rerunning it for an unchanged selection
  // is especially visible with large models.
  const selectedEntityPartsKey = selectedEntityParts.map((part) => part.id).join('|')
  const selectedEntityPartIds = useMemo(() => selectedEntityPartsKey ? selectedEntityPartsKey.split('|') : [], [selectedEntityPartsKey])
  const selectedEntityTransformSignature = useMemo(() => {
    const instancesById = new Map(project.instances.map((instance) => [instance.id, instance]))
    return selectedEntityParts.map((part) => {
      const instance = part.instanceId ? instancesById.get(part.instanceId) : undefined
      return `${part.id}:${instance ? sceneInstanceGeometrySignature(instance) : ''}`
    }).join('|')
  }, [project.instances, selectedEntityParts])
  useEffect(() => {
    // A color preview belongs to the selection it was started on. Changing
    // selection must restore the source materials before showing the next
    // entity, otherwise the old preview delta could leak into it.
    cancelColorPreview()
    cancelGeometryPreview()
  }, [selectedEntityPartsKey])
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
  const selectedCustomSourceAssets = [...new Map(selectedEntityParts
    .filter((part) => part.kind === 'custom')
    .map((part) => project.customEntitySources?.[part.partId]?.assetId)
    .filter((assetId): assetId is string => Boolean(assetId))
    .map((assetId) => [assetId, project.assets.find((asset) => asset.id === assetId && asset.isTemplate === true)])
    .filter((entry): entry is [string, VoxelAsset] => Boolean(entry[1]))).values()]
  const selectedTemplateSources = [...new Map([
    ...(selectedSourceAsset?.isTemplate === true ? [[selectedSourceAsset.id, selectedSourceAsset] as [string, VoxelAsset]] : []),
    ...(selectedSourceAsset?.templateSourceId
      ? [[selectedSourceAsset.templateSourceId, project.assets.find((asset) => asset.id === selectedSourceAsset.templateSourceId && asset.isTemplate === true)] as [string, VoxelAsset]]
      : []),
    ...selectedCustomSourceAssets.map((asset) => [asset.id, asset] as [string, VoxelAsset]),
  ].filter((entry): entry is [string, VoxelAsset] => Boolean(entry[1]))).values()]
  const selectedTemplateSource = selectedTemplateSources.length === 1 ? selectedTemplateSources[0] : undefined
  const selectedSource = multipleSelected
    ? '多个来源'
    : selectedTemplateSource
    ? `资产库 · ${normalizeAssetCategoryPath(selectedTemplateSource.categoryPath).join(' / ')}`
    : '还未保存到资产库'
  // Position-only changes do not affect the available geometry-operation
  // choices. In particular, do not include instance root/part offsets here:
  // validShellThicknesses() performs cavity filling plus repeated erosion, and
  // validScaleFactors() scans the selected voxel set. Re-running either on
  // every move-release made large entities stall the UI even though the user
  // had not started a geometry operation. The actual preview path below still
  // builds a fresh absolute-coordinate batch from projectRef at click time.
  const geometrySourceKey = previewPartsSignature(selectedEntityParts)
  const geometrySourceVoxels = useMemo<GeometryVoxel[]>(() => {
    const cached = geometrySourceCacheRef.current
    // Geometry availability is not needed while a brush transaction is being
    // published. Reusing the last committed source prevents every animation
    // frame from remapping and recoloring a large selected model merely to
    // recompute shell/scale choices that the user did not request.
    if (voxelStrokeTransactionRef.current && cached?.selectionEntityKey === selectedEntityPartsKey) return cached.voxels
    // Geometry availability describes shape, not absolute scene position.
    // Use canonical part voxels and subtract the common world offset so a
    // root-entity move cannot allocate/map the whole selection again.
    const base = selectedEntityParts[0]
      ? {
          x: (selectedEntityParts[0].sceneOffset?.x ?? 0) + (selectedEntityParts[0].partSceneOffset?.x ?? 0),
          y: (selectedEntityParts[0].sceneOffset?.y ?? 0) + (selectedEntityParts[0].partSceneOffset?.y ?? 0),
          z: (selectedEntityParts[0].sceneOffset?.z ?? 0) + (selectedEntityParts[0].partSceneOffset?.z ?? 0),
        }
      : { x: 0, y: 0, z: 0 }
    const next = selectedEntityParts.flatMap((part) => {
      const offset = {
        x: (part.sceneOffset?.x ?? 0) + (part.partSceneOffset?.x ?? 0) - base.x,
        y: (part.sceneOffset?.y ?? 0) + (part.partSceneOffset?.y ?? 0) - base.y,
        z: (part.sceneOffset?.z ?? 0) + (part.partSceneOffset?.z ?? 0) - base.z,
      }
      return part.voxels.map((voxel) => ({
        ...voxel,
        x: voxel.x + offset.x,
        y: voxel.y + offset.y,
        z: voxel.z + offset.z,
        // Geometry operations write back as editable scene voxels. Resolve
        // the display color here so an asset's primary/accent palette cannot
        // collapse to the generic custom-entity material during replacement.
        materialId: scenePartVoxelDisplayColor(project, part, voxel),
        sourcePartId: part.id,
      }))
    })
    geometrySourceCacheRef.current = { selectionKey: geometrySourceKey, selectionEntityKey: selectedEntityPartsKey, voxels: next }
    return next
  }, [geometrySourceKey, project.assets, project.customVoxels, project.customColors, project.materials])
  const currentGeometrySourceVoxels = () => {
    const singleCustomSource = selectedEntityParts.length === 1 && selectedEntityParts[0]?.kind === 'custom'
    return selectedEntityParts.flatMap((part) => scenePartVoxels(part).map((voxel) => ({
      ...voxel,
      materialId: scenePartVoxelDisplayColor(projectRef.current, part, voxel),
      // A single custom entity already carries its stable entityId on every
      // voxel. Do not add a temporary sourcePartId in this hot path: scale
      // operations can then hand their Worker result to commit without a
      // second full per-voxel cleanup loop. Multi-part operations still need
      // sourcePartId for ownership reconstruction.
      ...(singleCustomSource ? {} : { sourcePartId: part.id }),
    })))
  }
  const [geometryShellThicknessOptions, setGeometryShellThicknessOptions] = useState<number[]>([])
  const geometryShellOptionsRevisionRef = useRef(0)
  useEffect(() => {
    const client = geometryWorkerRef.current
    const revision = ++geometryShellOptionsRevisionRef.current
    if (!geometrySourceVoxels.length || !client) {
      setGeometryShellThicknessOptions([])
      return
    }
    // Shell availability performs cavity filling and repeated erosion. It is
    // useful UI metadata, but it must never block App rendering after a large
    // entity is selected or replaced. Calculate it in the same worker as the
    // geometry preview and ignore results for obsolete selections.
    setGeometryShellThicknessOptions([])
    void client.computeShellThicknessesLatest(geometrySourceVoxels).then((options) => {
      if (revision !== geometryShellOptionsRevisionRef.current) return
      setGeometryShellThicknessOptions(options ?? [])
    }).catch(() => {
      if (revision === geometryShellOptionsRevisionRef.current) setGeometryShellThicknessOptions([])
    })
  }, [geometrySourceVoxels])
  const geometryScaleOptions = useMemo(() => validScaleFactors(geometrySourceVoxels), [geometrySourceVoxels])
  // A transform-only move changes scene offsets, but never changes the file
  // tree. Keep the tree calculation keyed to structural fields so releasing a
  // large voxel entity does not rebuild every assembly row.
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
  }, [project.assets, project.entityNames, project.assemblies, sceneTreePartsKey])
  const canUndo = historyRevision >= 0 && historyRef.current.past.length > 0
  const canRedo = historyRevision >= 0 && historyRef.current.future.length > 0
  const recentMaterials = useMemo(() => {
    const materialsById = new Map(project.materials.map((material) => [material.id, material]))
    const ids = [...recentMaterialIds, ...project.materials.map((material) => material.id)]
    return [...new Set(ids)].map((id) => materialsById.get(id)).filter((material): material is Material => Boolean(material)).slice(0, 8)
  }, [project.materials, recentMaterialIds])

  const markVoxelStrokeOwners = (ownerIds: Iterable<string>) => {
    const transaction = voxelStrokeTransactionRef.current
    if (!transaction) return
    for (const ownerId of ownerIds) {
      transaction.dirtyOwnerIds.add(ownerId)
      transaction.touchedOwnerIds.add(ownerId)
    }
  }

  const markVoxelStrokeOwnerRoot = (instanceId: string) => {
    const transaction = voxelStrokeTransactionRef.current
    if (!transaction) return
    transaction.dirtyOwnerRoots.add(instanceId)
    transaction.touchedOwnerRoots.add(instanceId)
  }

  const useMaterial = (materialId: string) => {
    setActiveMaterial(materialId)
    setRecentMaterialIds((ids) => {
      const next = [materialId, ...ids.filter((id) => id !== materialId)].slice(0, 8)
      return next.every((id, index) => id === ids[index]) && next.length === ids.length ? ids : next
    })
  }

  const publishVoxelStroke = () => {
    voxelStrokePublishFrameRef.current = null
    const transaction = voxelStrokeTransactionRef.current
    if (!transaction?.dirty) return
    // Publish at most once per animation frame so the viewport remains
    // responsive while the durable project/history update stays deferred.
    // The transaction draft owns the mutable scene arrays for the duration of
    // the stroke. Publish only a new root object: cloning every asset, model
    // voxel and material on every frame was the largest remaining source of
    // trackpad/brush stutter. The draft is never exposed as the durable state
    // until the pointer is released and commitVoxelStroke finalizes it.
    const visibleProject: ProjectState = { ...transaction.draft }
    const visibleParts = sceneEntityParts(visibleProject)
    const dirtyOwnerIds = new Set(transaction.dirtyOwnerIds)
    const initialParts = voxelStrokePartsRef.current ?? []
    transaction.dirtyOwnerRoots.forEach((root) => {
      const previousIds = transaction.publishedOwnerIds.get(root)
        ?? new Set(initialParts.filter((part) => part.instanceId === root).map((part) => part.id))
      const nextIds = new Set(visibleParts.filter((part) => part.instanceId === root).map((part) => part.id))
      previousIds.forEach((ownerId) => dirtyOwnerIds.add(ownerId))
      nextIds.forEach((ownerId) => dirtyOwnerIds.add(ownerId))
      transaction.publishedOwnerIds.set(root, nextIds)
    })
    sceneOccupancyRef.current?.syncOwnerParts(visibleParts, dirtyOwnerIds)
    transaction.dirtyOwnerIds.clear()
    setProject(visibleProject)
    // Mutations continue against the transaction draft, not the rendered copy.
    projectRef.current = transaction.draft
  }

  const scheduleVoxelStrokePublish = () => {
    if (voxelStrokePublishFrameRef.current !== null) return
    voxelStrokePublishFrameRef.current = requestAnimationFrame(publishVoxelStroke)
  }

  const beginVoxelStroke = () => {
    if (voxelStrokeTransactionRef.current) return
    // The previous implementation deep-cloned the complete project here. That
    // made pointer-down itself proportional to every asset and voxel in the
    // scene, even though a brush stroke only writes a small set of scene
    // collections. Keep the previous root as the immutable history snapshot
    // and structurally share the read-only catalogs; clone only collections
    // that the stroke handlers can replace or mutate.
    const original = projectRef.current
    const draft = cloneProjectForMutation(original, { shareCatalogs: true })
    const initialParts = sceneEntityParts(projectRef.current)
    voxelStrokeTransactionRef.current = {
      draft,
      original,
      historyEditEntityId: editEntityId,
      historySelectedId: selectedId,
      historyCheckedTreePartIds: [...checkedTreePartIds],
      // Build this once at pointer-down. The previous batch path rebuilt a
      // flattened Set of every custom voxel for every animation-frame commit,
      // which made long strokes increasingly expensive as the entity grew.
      occupiedCustomSceneKeys: new Set(initialParts
        .filter((part) => part.kind === 'custom')
        .flatMap((part) => scenePartVoxels(part))
        .map(sceneVoxelKey)),
      dirtyOwnerIds: new Set(),
      dirtyOwnerRoots: new Set(),
      touchedOwnerIds: new Set(),
      touchedOwnerRoots: new Set(),
      publishedOwnerIds: new Map(),
      dirty: false,
    }
    voxelStrokePartsRef.current = initialParts
    voxelStrokeNoticeRef.current = null
  }

  const commitVoxelStroke = () => {
    if (voxelStrokePublishFrameRef.current !== null) {
      cancelAnimationFrame(voxelStrokePublishFrameRef.current)
      voxelStrokePublishFrameRef.current = null
    }
    const transaction = voxelStrokeTransactionRef.current
    const initialParts = voxelStrokePartsRef.current ?? []
    voxelStrokeTransactionRef.current = null
    voxelStrokePartsRef.current = null
    if (!transaction) return
    if (!transaction.dirty) {
      projectRef.current = transaction.original
      voxelStrokeNoticeRef.current = null
      return
    }
    // The draft already starts from a normalized project and owns the scene
    // collections it can mutate. Avoid the general persistence normalizer's
    // full asset/voxel clone on pointer-up.
    const next = finalizeVoxelStrokeProject(transaction.draft)
    recordHistoryTransition(
      historyRef.current,
      {
        ...makeHistoryEntry(transaction.original),
        editEntityId: transaction.historyEditEntityId,
        selectedId: transaction.historySelectedId,
        checkedTreePartIds: [...transaction.historyCheckedTreePartIds],
      },
      { project: next, editEntityId: editEntityId, selectedId, checkedTreePartIds: [...checkedTreePartIds] },
      (left, right) => sameHistoryProject(left.project, right.project),
      historyLimitForProject(transaction.original),
    )
    // The stroke publishes synchronously on pointer-up, but a transition from
    // an earlier operation may still be queued. Advance the same generation
    // used by move/geometry commits so that an old transition cannot repaint
    // over the completed stroke.
    historyEpochRef.current += 1
    const finalParts = sceneEntityParts(next)
    const touchedOwnerIds = new Set(transaction.touchedOwnerIds)
    transaction.touchedOwnerRoots.forEach((instanceId) => {
      initialParts.filter((part) => part.instanceId === instanceId).forEach((part) => touchedOwnerIds.add(part.id))
      finalParts.filter((part) => part.instanceId === instanceId).forEach((part) => touchedOwnerIds.add(part.id))
    })
    // Brush operations already record the owners they touched while the
    // transaction is published. Reconcile only those owners on pointer-up;
    // rebuilding the complete scene index here was the remaining release-time
    // hitch for scenes containing large unrelated entities.
    if (touchedOwnerIds.size) sceneOccupancyRef.current?.syncOwnerParts(finalParts, touchedOwnerIds)
    else sceneOccupancyRef.current?.syncParts(finalParts)
    projectRef.current = next
    markSceneDirty()
    setProject(next)
    setHistoryRevision((value) => value + 1)
    const strokeNotice = voxelStrokeNoticeRef.current
    voxelStrokeNoticeRef.current = null
    if (strokeNotice) setNotice(strokeNotice)
  }

  const notifyEditor = (message: string) => {
    if (voxelStrokeTransactionRef.current) {
      voxelStrokeNoticeRef.current = message
      return
    }
    setNotice(message)
  }

  const commitProject = (next: ProjectState, trackHistory = true) => {
    if (geometryApplyingRef.current) return
    // updateProject()/replaceProject() already provide an isolated next
    // project. The default storage normalizer would deep-clone it again from
    // normalizeProjectNaming(), which is especially costly for large voxel
    // assets. Keep storage-field normalization, then normalize names in-place
    // on this caller-owned next tree. File loading still uses the full clone
    // path above before reaching this commit boundary.
    const normalizedBase = normalizeStoredProject(next, { normalizeNaming: false })
    const normalizedNext = normalizeProjectNaming(normalizedBase, { clone: false })
    if (trackHistory) recordHistoryBeforeChange(projectRef.current, normalizedNext)
    const nextParts = sceneEntityParts(normalizedNext)
    const changedOwnerIds = changedOccupancyOwnerIds(sceneParts, nextParts)
    if (changedOwnerIds.size) sceneOccupancyRef.current?.syncOwnerParts(nextParts, changedOwnerIds)
    // The index was updated above using the exact changed owner set. Prevent
    // the sceneParts effect from repeating a full scene synchronization after
    // React publishes the same project root.
    skipSceneOccupancySyncRef.current = true
    historyEpochRef.current += 1
    projectRef.current = normalizedNext
    markSceneDirty()
    setProject(normalizedNext)
    setHistoryRevision((value) => value + 1)
  }

  const commitScenePartsMoveFast = (nextProject: ProjectState, movableParts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number) => {
    if (geometryApplyingRef.current) return
    // Large custom moves intentionally bypass the normalizer. Keep the
    // materialized-scene invariant explicit for any obsolete caller that
    // might still hand this fast path an instance payload.
    const publishedProject = nextProject.instances.length
      ? normalizeStoredProject(nextProject, { normalizeNaming: false })
      : nextProject
    recordHistoryBeforeChange(projectRef.current, publishedProject)
    if (publishedProject === nextProject) movableParts.forEach((part) => {
      // A move preserves the owner's topology. Let the occupancy index keep
      // its existing chunk data and record only the transform; this removes
      // the release-time O(n) voxel remove/reinsert for large entities.
      sceneOccupancyRef.current?.translateOwner(part.id, { x: deltaX, y: deltaY, z: deltaZ })
    })
    if (publishedProject !== nextProject) sceneOccupancyRef.current?.syncParts(sceneEntityParts(publishedProject))
    // We already updated only the moved owners above. Avoid a second full
    // scene synchronization when the new React project reaches the effect.
    skipSceneOccupancySyncRef.current = true
    const publishEpoch = ++historyEpochRef.current
    projectRef.current = publishedProject
    markSceneDirty()
    // The Three.js drag preview already moved the scene graph imperatively and
    // the occupancy index/history are updated above. Publishing the React
    // snapshot as a transition keeps the pointer-up event responsive when the
    // inspector, tree and other derived panels need to re-render for a very
    // large entity. A normal synchronous update here made release latency grow
    // with the selected model even though no voxel geometry was rebuilt.
    startTransition(() => {
      if (historyEpochRef.current !== publishEpoch) return
      setProject(publishedProject)
      setHistoryRevision((value) => value + 1)
    })
  }

  const commitGeometryProject = async (next: ProjectState, removedPartIds: string[], resultGroups: Array<{ entityId: string; voxels: Voxel[] }>) => {
    const applyRevision = geometryApplyRevisionRef.current
    const occupancy = sceneOccupancyRef.current
    const nextOccupancy = occupancy?.fork()
    // Geometry confirmation is already a validated, integer-grid batch. Do
    // not send it through updateProject(): that path deep-clones the whole
    // project and normalizeStoredProject() then walks every asset and voxel.
    // The project root and mutable scene arrays were prepared by the caller;
    // history can therefore retain the immutable previous root directly.
    recordHistoryBeforeChange(projectRef.current, next)
    // The occupancy index was updated incrementally above. The following
    // sceneParts effect must not sort and rescan the same large result again.
    skipSceneOccupancySyncRef.current = true
    const publishEpoch = ++historyEpochRef.current
    projectRef.current = next
    markSceneDirty()
    startTransition(() => {
      if (historyEpochRef.current !== publishEpoch) return
      setProject(next)
      setHistoryRevision((value) => value + 1)
    })

    // Rebuild an independent occupancy index in bounded batches after
    // publishing the already-validated project. The old index remains the
    // authoritative query source while the fork is incomplete, so camera
    // browsing and read-only viewport work do not observe a half-built index.
    if (!nextOccupancy) return
    // Geometry confirmation has already checked collision/bounds. Larger
    // batches reduce the number of event-loop turns for a large scale-up while
    // still yielding often enough for the browser to paint and remain
    // interruptible. Small edits keep the conservative default batch size.
    const resultVoxelCount = resultGroups.reduce((total, group) => total + group.voxels.length, 0)
    const occupancyBatchSize = resultVoxelCount >= 100_000 ? 16_384 : 4_096
    for (const partId of removedPartIds) {
      if (geometryApplyRevisionRef.current !== applyRevision) return
      await nextOccupancy.removeOwnerChunked(partId, occupancyBatchSize)
    }
    for (const { entityId, voxels } of resultGroups) {
      if (geometryApplyRevisionRef.current !== applyRevision) return
      await nextOccupancy.insertOwnerFromValidatedBatchChunked(`custom:${entityId}`, voxels, voxels, { x: 0, y: 0, z: 0 }, occupancyBatchSize)
    }
    if (geometryApplyRevisionRef.current === applyRevision) sceneOccupancyRef.current = nextOccupancy
  }

  const updateProject = (updater: (draft: ProjectState) => void, trackHistory = true) => {
    if (geometryApplyingRef.current) return
    const transaction = voxelStrokeTransactionRef.current
    if (transaction) {
      updater(transaction.draft)
      transaction.dirty = true
      projectRef.current = transaction.draft
      scheduleVoxelStrokePublish()
      return
    }
    const next = cloneProjectForMutation(projectRef.current)
    updater(next)
    commitProject(next, trackHistory)
  }

  const replaceProject = (next: ProjectState, trackHistory = true) => {
    if (geometryApplyingRef.current) return
    commitProject(structuredClone(next), trackHistory)
  }

  const markSceneSaved = (savedProject: ProjectState, fileRef?: SceneFileRef | null) => {
    const signature = sceneContentSignature(savedProject)
    savedSceneSignatureRef.current = signature
    sceneDirtyRef.current = false
    setSavedSceneSignature(signature)
    if (fileRef !== undefined) {
      sceneFileRefRef.current = fileRef
      // Keep the active-scene pointer synchronous. A refresh/close can happen
      // before React flushes the state effect below.
      writeLocalSceneRef(fileRef)
      setSceneFileRef(fileRef)
    }
    void clearLocalSceneDraft()
  }

  const requestSceneReplace = (operation: () => Promise<void>) => {
    if (geometryApplyingRef.current) {
      setNotice('正在完成几何处理，请稍候再切换场景')
      return
    }
    // Recompute only at the correctness boundary for New/Open/Library
    // actions. Normal editing uses the O(1) dirty hint above and stays off
    // the synchronous signature path.
    if (!refreshSceneDirty()) {
      void operation()
      return
    }
    pendingSceneOperationRef.current = operation
    setUnsavedDialogOpen(true)
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

  const downloadBinaryFile = (data: ArrayBuffer, fileName: string, mimeType: string) => {
    const blob = new Blob([data], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const saveProjectToLibrary = async (forceSaveAs = false): Promise<boolean> => {
    let sceneFile: MoceSceneFile
    try {
      sceneFile = createSceneFile(projectRef.current)
    } catch (error) {
      setNotice(error instanceof Error ? `保存失败 · ${error.message}` : '保存失败 · 场景文件生成失败')
      return false
    }

    let availableScenes = library.scenes
    try {
      const latest = await loadLocalLibrary()
      availableScenes = latest.scenes
      setLibrary(latest)
      setAssetCategoryPaths(normalizeAssetCategoryPaths(latest.assetCategories ?? [], projectRef.current.assets))
    } catch {
      // Keep the last known list; the save request below will still report a
      // useful error if the service is unavailable.
    }
    let savedName = sceneFile.scene.name?.trim() || '未命名场景'
    const requestedName = window.prompt(
      forceSaveAs ? '请输入另存后的场景名称' : '请输入保存后的场景名称',
      savedName,
    )
    if (!requestedName?.trim()) {
      setNotice('已取消保存场景')
      return false
    }
    savedName = requestedName.trim()
    sceneFile.scene.name = savedName
    const sameNameScene = availableScenes.find((scene) => scene.name.trim() === savedName)
    let targetSceneId = !forceSaveAs
      ? (sceneFileRefRef.current?.libraryId?.startsWith('local-scene-') ? sceneFileRefRef.current.libraryId : sameNameScene?.id)
      : undefined
    let savedSceneSummary: LibrarySceneSummary | undefined

    try {
      if (forceSaveAs || !targetSceneId) {
        const result = await saveLocalScene(sceneFile)
        targetSceneId = result.id
        savedName = result.scene.name
        savedSceneSummary = result.scene
      } else {
        const result = await saveLocalScene(sceneFile, targetSceneId)
        savedSceneSummary = result.scene
      }
      setPersistenceStatus('saved')
    } catch (error) {
      setPersistenceStatus('offline')
      setNotice(`保存场景失败 · ${error instanceof Error ? error.message : '请检查场景库连接'}`)
      return false
    }

    // createSceneFile already produced an isolated snapshot of the scene. For
    // the saved baseline, retain the current assets' template metadata (the
    // portable scene intentionally marks embedded assets as non-template), but
    // only keep the assets actually referenced by this scene. This avoids a
    // second full-project clone without changing dirty-state semantics.
    sceneFile.scene.name = savedName
    const savedAssetIds = new Set(Object.values(sceneFile.scene.customEntitySources ?? {}).map((source) => source.assetId))
    // The fallback keeps a legacy project baseline correct if it reaches this
    // function before normalization has completed.
    sceneFile.scene.instances.forEach((instance) => savedAssetIds.add(instance.assetId))
    const savedSnapshot = {
      ...sceneFile.scene,
      assets: projectRef.current.assets.filter((asset) => savedAssetIds.has(asset.id)),
    } as ProjectState
    if (projectRef.current.name !== savedName) {
      projectRef.current = { ...projectRef.current, name: savedName }
      setProject(projectRef.current)
    }
    markSceneSaved(savedSnapshot, { name: savedName, libraryId: targetSceneId })
    if (savedSceneSummary) {
      setLibrary((current) => ({
        ...current,
        scenes: [savedSceneSummary!, ...current.scenes.filter((scene) => scene.id !== savedSceneSummary!.id)],
      }))
    }
    try {
      const loaded = await loadLocalLibrary()
      const hasSavedScene = targetSceneId ? loaded.scenes.some((scene) => scene.id === targetSceneId) : false
      setLibrary(hasSavedScene || !savedSceneSummary
        ? loaded
        : { ...loaded, scenes: [savedSceneSummary, ...loaded.scenes.filter((scene) => scene.id !== savedSceneSummary!.id)] })
      setAssetCategoryPaths(normalizeAssetCategoryPaths(loaded.assetCategories ?? [], projectRef.current.assets))
    } catch {
      // The scene is already saved; a failed list refresh should not turn it
      // into a failed save.
    }
    setNotice(forceSaveAs ? `场景已另存到场景库 · ${savedName}` : `场景已保存到场景库 · ${savedName}`)
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
      const saved = await saveProjectToLibrary(false)
      if (!saved) return
    }
    pendingSceneOperationRef.current = null
    setUnsavedDialogOpen(false)
    await operation()
  }

  useEffect(() => {
    let cancelled = false
    const restoreSession = async () => {
      // Remove only the untouched bundled sample left by older builds. This
      // is a one-time local cleanup: user-created scenes/assets and all cloud
      // data are intentionally left alone.
      const bundledAssetIds = makeDefaultProject().assets
        .filter((asset) => asset.isTemplate !== false)
        .map((asset) => asset.id)
      try {
        await Promise.all(bundledAssetIds.map((assetId) => deleteLocalAsset(assetId)))
      } catch {
        // Local cleanup is best-effort; it must never prevent the editor from
        // opening an otherwise valid empty project.
      }
      const defaultProject = normalizeStoredProject(makeEmptyProject())
      const localWorkspace = await initializeLocalLibrary(defaultProject.assets)
      const localBaseProject = { ...defaultProject, assets: localWorkspace.assets }
      const storedRef = readLocalSceneRef()
      let resolvedRef = storedRef
      let loaded: ProjectState | null = null
      if (storedRef?.libraryId?.startsWith('local-scene-')) {
        try {
          const restoredScene = restoreProject(await loadLocalScene(storedRef.libraryId))
          if (isBundledDefaultSampleProject(restoredScene) || isLegacyDefaultSampleProject(restoredScene)) {
            await deleteLocalScene(storedRef.libraryId)
            writeLocalSceneRef(null)
          } else {
            const embeddedIds = new Set(restoredScene.assets.map((asset) => asset.id))
            loaded = {
              ...restoredScene,
              assets: [...restoredScene.assets, ...localWorkspace.assets.filter((asset) => asset.isTemplate !== false && !embeddedIds.has(asset.id))],
            }
          }
        } catch {
          writeLocalSceneRef(null)
        }
      }
      if (!loaded) {
        resolvedRef = null
      }
      if (cancelled) return

      const normalized = normalizeStoredProject(loaded ?? localBaseProject)
      const activeRef: SceneFileRef | null = loaded
        ? resolvedRef?.libraryId ? { ...resolvedRef, name: normalized.name } : null
        : null
      const draft = await readLocalSceneDraft()
      let restored = normalized
      let recoveredDraft = false
      const draftRef = storedRef ?? activeRef
      if (draft && sameSceneRef(draft.ref, draftRef)) {
        try {
          const draftProject = normalizeStoredProject(restoreProject(draft.sceneFile))
          if (isBundledDefaultSampleProject(draftProject)) {
            await clearLocalSceneDraft()
          } else {
            const draftIds = new Set(draftProject.assets.map((asset) => asset.id))
            const templateAssets = normalized.assets.filter((asset) => asset.isTemplate !== false && !draftIds.has(asset.id))
            restored = { ...draftProject, assets: [...draftProject.assets, ...structuredClone(templateAssets)] }
            recoveredDraft = true
          }
        } catch {
          await clearLocalSceneDraft()
        }
      }
      if (cancelled) return
      replaceProject(restored, false)
      setRecentMaterialIds(restored.materials.slice(0, 8).map((material) => material.id))
      setSelectedId(sceneEntityParts(restored)[0]?.id ?? '')
      persistenceReadyRef.current = true
      setPersistenceStatus(loaded ? 'saved' : 'offline')
      const savedSignature = sceneContentSignature(normalized)
      savedSceneSignatureRef.current = savedSignature
      setSavedSceneSignature(savedSignature)
      sceneFileRefRef.current = activeRef
      setSceneFileRef(activeRef)
      if (recoveredDraft) setNotice(`已恢复上次未保存编辑 · ${restored.name}`)
      else if (loaded) setNotice(`已加载场景 · ${normalized.name}`)
      else setNotice('已加载空白场景 · 尚未保存到场景库')
    }
    void restoreSession().catch(async () => {
      if (cancelled) return
      // IndexedDB can be temporarily unavailable during browser startup or
      // after storage eviction, while the synchronous draft fallback is still
      // readable. Recover that draft before falling back to the current React
      // bootstrap project so a refresh does not silently reset the workspace.
      try {
        const draft = await readLocalSceneDraft()
        if (draft && !cancelled) {
          const restored = normalizeStoredProject(restoreProject(draft.sceneFile))
          replaceProject(restored, false)
          setRecentMaterialIds(restored.materials.slice(0, 8).map((material) => material.id))
          setSelectedId(sceneEntityParts(restored)[0]?.id ?? '')
          persistenceReadyRef.current = true
          setPersistenceStatus('offline')
          // There is no reliable saved baseline if the local scene store is
          // unavailable. Keep the recovered draft dirty so it is persisted
          // again on the next pagehide/visibilitychange.
          savedSceneSignatureRef.current = null
          setSavedSceneSignature(null)
          sceneFileRefRef.current = draft.ref
          setSceneFileRef(draft.ref)
          setNotice(`已从本地恢复上次编辑 · ${restored.name}`)
          return
        }
      } catch {
        // Continue with the empty/offline bootstrap below.
      }
      persistenceReadyRef.current = true
      setPersistenceStatus('offline')
      const savedSignature = sceneContentSignature(projectRef.current)
      savedSceneSignatureRef.current = savedSignature
      setSavedSceneSignature(savedSignature)
      sceneFileRefRef.current = null
      setSceneFileRef(null)
      setNotice('后端连接失败 · 当前使用本地草稿')
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadLocalLibrary().then((loaded) => {
      if (cancelled) return
      setLibrary(loaded)
      setLibraryError(null)
      setAssetCategoryPaths(normalizeAssetCategoryPaths(loaded.assetCategories ?? [], projectRef.current.assets))
    }).catch((error) => {
      if (cancelled) return
      setLibraryError(error instanceof Error ? error.message : '场景库加载失败')
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    writeLocalSceneRef(sceneFileRef)
    sceneFileRefRef.current = sceneFileRef
  }, [sceneFileRef?.libraryId, sceneFileRef?.name])

  useEffect(() => {
    savedSceneSignatureRef.current = savedSceneSignature
  }, [savedSceneSignature])

  useEffect(() => {
    const persistDraftBeforeExit = () => {
      if (!persistenceReadyRef.current) return
      const now = Date.now()
      if (now - exitDraftPersistedAtRef.current < 250) return
      exitDraftPersistedAtRef.current = now
      try {
        const snapshot = projectRef.current
        const sceneFile = createSceneFile(snapshot)
        if (savedSceneSignatureRef.current && sceneContentSignature(snapshot) === savedSceneSignatureRef.current) {
          void clearLocalSceneDraft()
          return
        }
        const draft: LocalSceneDraft = {
          ref: sceneFileRefRef.current,
          sceneFile,
          updatedAt: now,
        }
        void writeLocalSceneDraft(draft)
      } catch {
        // Exit-time recovery is best-effort and must never block page closing.
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persistDraftBeforeExit()
    }
    window.addEventListener('pagehide', persistDraftBeforeExit)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', persistDraftBeforeExit)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const cancelPendingHistoryInteractions = () => {
    // Invalidate every callback that can publish a project after this point.
    // This is the missing boundary in the old implementation: a queued React
    // transition or a stroke RAF could repaint the pre-undo project after the
    // history snapshot had already been restored.
    historyEpochRef.current += 1
    interactionActiveRef.current = false
    sceneMoveValidationRef.current = null
    sceneMoveBoundsRef.current = null
    if (voxelStrokePublishFrameRef.current !== null) {
      cancelAnimationFrame(voxelStrokePublishFrameRef.current)
      voxelStrokePublishFrameRef.current = null
    }
    const transaction = voxelStrokeTransactionRef.current
    voxelStrokeTransactionRef.current = null
    voxelStrokePartsRef.current = null
    voxelStrokeEntityRef.current = null
    voxelStrokeNoticeRef.current = null
    if (transaction) {
      const restoredParts = sceneEntityParts(transaction.original)
      sceneOccupancyRef.current?.syncParts(restoredParts)
      skipSceneOccupancySyncRef.current = true
      projectRef.current = transaction.original
      setProject(transaction.original)
    }
    geometryRequestRevisionRef.current += 1
    geometryApplyRevisionRef.current += 1
    setCopyPreview(null)
    setTransformPreview(null)
    cancelColorPreview()
    if (!geometryApplyingRef.current) cancelGeometryPreview()
  }

  const restoreHistoryEntry = (entry: ProjectHistoryEntry, notice: string) => {
    const currentProject = projectRef.current
    const currentParts = sceneEntityParts(currentProject)
    // Derived SceneEntityPart arrays are runtime caches. They can be mutated
    // in place by append-only voxel publishing or by lazy transform refreshes,
    // so never retain them in a history entry. Rebuild from the immutable
    // ProjectState snapshot that is actually being restored.
    const targetParts = sceneEntityParts(entry.project)
    const changedOwnerIds = changedOccupancyOwnerIds(currentParts, targetParts)
    if (changedOwnerIds.size) sceneOccupancyRef.current?.syncOwnerParts(targetParts, changedOwnerIds)
    skipSceneOccupancySyncRef.current = true
    projectRef.current = entry.project
    markSceneDirty()
    // History restoration is deliberately synchronous. It must win over any
    // pending transition and make the viewport/inspector agree in the same
    // React update batch.
    setProject(entry.project)
    setEditEntityId(entry.editEntityId)
    setSelectedId(entry.selectedId)
    setCheckedTreePartIds([...entry.checkedTreePartIds])
    setHistoryRevision((value) => value + 1)
    setNotice(notice)
  }

  const undoProject = () => {
    if (geometryApplyingRef.current) return
    cancelPendingHistoryInteractions()
    const currentProject = projectRef.current
    const currentEntry = makeHistoryEntry(currentProject)
    const previous = undoHistoryTransition(historyRef.current, currentEntry, historyLimitForProject(currentProject))
    if (!previous) {
      setNotice('没有可撤销的操作')
      return
    }
    restoreHistoryEntry(previous, '已撤销')
  }

  const redoProject = () => {
    if (geometryApplyingRef.current) return
    cancelPendingHistoryInteractions()
    const currentProject = projectRef.current
    const currentEntry = makeHistoryEntry(currentProject)
    const next = redoHistoryTransition(historyRef.current, currentEntry, historyLimitForProject(currentProject))
    if (!next) {
      setNotice('没有可重做的操作')
      return
    }
    restoreHistoryEntry(next, '已重做')
  }

  const addVoxel = (voxel: Voxel) => {
    useMaterial(voxel.materialId)
    const currentProject = projectRef.current
    const currentParts = voxelStrokePartsRef.current ?? sceneEntityParts(currentProject)
    const activeEditEntityId = editEntityId ?? (voxelStrokeEntityRef.current ? `custom:${voxelStrokeEntityRef.current}` : null)
    const editAssemblyId = activeEditEntityId?.startsWith('assembly:') ? activeEditEntityId.slice('assembly:'.length) : undefined
    const editingCustomId = activeEditEntityId?.startsWith('custom:')
      ? activeEditEntityId.slice('custom:'.length)
      : currentParts.find((part) => part.kind === 'custom' && (part.id === activeEditEntityId || (editAssemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editAssemblyId))))?.partId
    if (activeEditEntityId && !editingCustomId) {
      const editingAssetPart = currentParts.find((part) => part.kind === 'asset' && (part.id === activeEditEntityId || part.instanceId === activeEditEntityId || partBelongsToEditTarget(part, activeEditEntityId)))
      if (editingAssetPart?.instanceId) {
        const instance = currentProject.instances.find((item) => item.id === editingAssetPart.instanceId)
        const asset = instance ? currentProject.assets.find((item) => item.id === instance.assetId) : undefined
        const localTarget = instance && asset
          ? assetTransformCacheRef.current!.localCoordinateAtSceneVoxel(instance, asset, voxel, editingAssetPart.partId)
          : undefined
        if (instance && asset && localTarget) {
          markVoxelStrokeOwnerRoot(instance.id)
          editInstanceVoxel(instance.id, { ...localTarget, materialId: voxel.materialId }, 'add')
          notifyEditor(`已在当前编辑实体上添加体素 · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
          return
        }
        notifyEditor('当前编辑实体无法解析该体素位置 · 未创建新实体')
        return
      }
      notifyEditor('当前处于实体编辑模式 · 未找到可修改的原实体')
      return
    }
    // Outside edit mode every brush stroke starts a new user entity, even if
    // the new voxel touches an existing custom entity. Only an explicit edit
    // target is allowed to reuse an existing entity id.
    const entityId = editingCustomId ?? voxelStrokeEntityRef.current ?? `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (!editingCustomId) voxelStrokeEntityRef.current = entityId
    markVoxelStrokeOwners([`custom:${entityId}`])
    const alreadyOccupied = currentParts.some((part) => part.kind === 'custom' && scenePartVoxels(part).some((candidate) => sceneVoxelKey(candidate) === sceneVoxelKey(voxel)))
    updateProject((draft) => {
      if (alreadyOccupied) return
      draft.customVoxels.push(sceneToStoredCustomVoxel(draft, { ...voxel, materialId: voxel.materialId }, entityId))
    })
    const customEntitySelectionId = `custom:${entityId}`
    setSelectedId(customEntitySelectionId)
    if (!editingCustomId) setEditEntityId(customEntitySelectionId)
    notifyEditor(editingCustomId ? `已在当前用户实体上添加体素 · ${voxel.x}, ${voxel.y}, ${voxel.z}` : `已新建用户实体并进入编辑模式 · ${voxel.x}, ${voxel.y}, ${voxel.z}`)
  }

  const removeVoxels = (voxels: Voxel[]) => {
    const targets = new Set(voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
    if (!targets.size) return
    const parts = voxelStrokePartsRef.current ?? sceneEntityParts(projectRef.current)
    const storedTargetKeys = new Set<string>()
    const customParts = parts.filter((part) => part.kind === 'custom')
    const customPartsById = new Map(customParts.map((part) => [part.partId, part]))
    const unresolvedTargets = new Set<string>()
    // Quick erase supplies the owning entity id with each target voxel. Use
    // that metadata to convert scene coordinates back to canonical storage
    // coordinates directly; the previous fallback scanned every custom voxel
    // for every erase sample, which made large hand-drawn entities expensive.
    voxels.forEach((voxel) => {
      const entityId = voxel.entityId
      const part = entityId ? customPartsById.get(entityId) : undefined
      if (!entityId || !part) {
        unresolvedTargets.add(sceneVoxelKey(voxel))
        return
      }
      markVoxelStrokeOwners([part.id])
      const offset = part.sceneOffset ?? { x: 0, y: 0, z: 0 }
      storedTargetKeys.add(`${entityId}:${sceneVoxelKey({ x: voxel.x - offset.x, y: voxel.y - offset.y, z: voxel.z - offset.z })}`)
    })
    if (unresolvedTargets.size) customParts.forEach((part) => {
      const sceneVoxels = scenePartVoxels(part)
      sceneVoxels.forEach((sceneVoxel, index) => {
        if (unresolvedTargets.has(sceneVoxelKey(sceneVoxel))) {
          markVoxelStrokeOwners([part.id])
          storedTargetKeys.add(`${part.partId}:${sceneVoxelKey(part.voxels[index])}`)
        }
      })
    })
    updateProject((draft) => {
      const removedEntityIds = new Set(draft.customVoxels
        .filter((item) => storedTargetKeys.has(`${voxelEntityId(item)}:${sceneVoxelKey(item)}`))
        .map((item) => voxelEntityId(item)))
      const remaining = draft.customVoxels.filter((item) => !storedTargetKeys.has(`${voxelEntityId(item)}:${sceneVoxelKey(item)}`))
      // Shape variants are determined at placement time from the clicked face.
      // Erasing a neighbour must not recalculate or mirror the remaining
      // shapes: topology-derived corner/tee variants are intentionally gone.
      draft.customVoxels = remaining
      // A manually drawn entity keeps its identity after an erasure, even if
      // removing a junction leaves disconnected voxel islands. Splitting the
      // entity here makes only the first island match editEntityId, so the
      // other islands become dimmed as external entities. Preset asset
      // instances use resolveInstanceComponents separately when their parts
      // are edited and therefore remain the only path that splits identities.
      if (removedEntityIds.size) {
        const remainingEntityIds = new Set(remaining.map((item) => voxelEntityId(item)))
        if (draft.customEntityOffsets) {
          draft.customEntityOffsets = Object.fromEntries(Object.entries(draft.customEntityOffsets).filter(([entityId]) => remainingEntityIds.has(entityId)))
        }
        if (draft.customEntitySources) {
          draft.customEntitySources = Object.fromEntries(Object.entries(draft.customEntitySources).filter(([entityId]) => remainingEntityIds.has(entityId)))
        }
        // Removing one child must not remove the whole assembly. The previous
        // implementation filtered an assembly out whenever the erased child
        // no longer had voxels, even when the assembly still contained its
        // other members. That left editEntityId pointing at a deleted
        // assembly, which made the current editor dim and broke its preview.
        draft.assemblies = (draft.assemblies ?? []).map((assembly) => {
          const memberKeys = assembly.memberKeys.filter((memberKey) => {
            if (!memberKey.startsWith('voxel:')) return true
            const entityId = memberKey.slice('voxel:'.length)
            if (!removedEntityIds.has(entityId)) return true
            return remaining.some((item) => voxelEntityId(item) === entityId)
          })
          return { ...assembly, memberKeys }
        }).filter((assembly) => assembly.memberKeys.length > 0)
      }
    })
    // A newly drawn child can be the selected row while the enclosing
    // assembly is the edit target. If that child is erased completely, keep
    // the edit mode attached to the surviving assembly instead of leaving a
    // stale custom:* selection that renders as an unrelated fragment.
    if (editEntityId?.startsWith('assembly:')) {
      const assemblyId = editEntityId.slice('assembly:'.length)
      const latestProject = voxelStrokeTransactionRef.current?.draft ?? projectRef.current
      const latestParts = sceneEntityParts(latestProject)
      const assemblyStillExists = latestProject.assemblies?.some((assembly) => assembly.id === assemblyId)
        && latestParts.some((part) => part.assemblyIds?.includes(assemblyId))
      if (assemblyStillExists && !latestParts.some((part) => part.id === selectedId)) {
        setSelectedId(editEntityId)
        setCheckedTreePartIds([editEntityId])
      }
    }
    const first = voxels[0]
    notifyEditor(voxels.length === 1
      ? `已擦除体素 · ${first.x}, ${first.y}, ${first.z} · 已重新计算实体边界`
      : `快速擦除完成 · ${voxels.length} 个体素`)
  }

  const removeVoxel = (voxel: Voxel) => removeVoxels([voxel])

  const partBelongsToEditTarget = (part: SceneEntityPart, targetId: string) => {
    if (part.id === targetId) return true
    if (!targetId.startsWith('assembly:')) return false
    const assemblyId = targetId.slice('assembly:'.length)
    return (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(assemblyId)
  }

  /** One logical tool operation enters the existing stroke transaction once. */
  const applyVoxelBatch = (voxels: Voxel[], operation: DrawOperation) => {
    // Storage Y=0 is the immutable scene datum. Keep this invariant at the
    // final mutation boundary as well as in the pointer/shape algorithms, so
    // a future tool or a stale preview cannot resurrect below-ground voxels.
    const targets = uniqueVoxels(voxels).filter((voxel) => voxel.y >= 0)
    if (!targets.length) return
    if (operation !== 'subtract') useMaterial(activeMaterial)
    if (operation === 'add' && tool !== 'brush') {
      const bounds = sceneBoundsForProject(projectRef.current)
      if (!sceneVoxelsWithinBounds(targets, bounds)) {
        notifyEditor('绘制结果超出场景边界')
        return
      }
      const assemblyId = editEntityId?.startsWith('assembly:') ? editEntityId.slice('assembly:'.length) : null
      const excluded = editEntityId
        ? (voxelStrokePartsRef.current ?? sceneEntityParts(projectRef.current))
          .filter((part) => part.id === editEntityId || Boolean(assemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(assemblyId)))
          .map((part) => part.id)
        : []
      const collisionParts = voxelStrokePartsRef.current ?? sceneEntityParts(projectRef.current)
      if (sceneOccupancyRef.current?.collidesProjectVoxels(targets, excluded)
        || shapeBatchCollidesWithScene(targets, collisionParts, excluded)) {
        notifyEditor('绘制结果会与其他实体重叠，已取消')
        return
      }
    }
    if (operation === 'add') {
      const inBoundsTargets = targets.filter((voxel) => sceneVoxelWithinBounds(voxel, sceneBoundsForProject(projectRef.current)))
      if (!inBoundsTargets.length) return
      if (tool !== 'brush' && inBoundsTargets.length !== targets.length) {
        notifyEditor('绘制结果超出场景边界，已取消本次操作')
        return
      }
      // Freehand strokes may cross the boundary while the pointer is moving;
      // keep the valid cells instead of allowing an out-of-bounds cell to
      // poison the entire stroke. Shape tools remain atomic below.
      const addTargets = tool === 'brush' ? inBoundsTargets : targets
      const currentProject = projectRef.current
      const currentParts = voxelStrokePartsRef.current ?? sceneEntityParts(currentProject)
      // A shape gesture is an atomic operation. Outside edit mode it must
      // always create a fresh entity, never reuse the entity id left by a
      // previous brush stroke. Reusing that id made the new cuboid/sphere
      // inherit the old entity's whole-color override and also made collision
      // ownership ambiguous.
      const createsNewShapeEntity = tool !== 'brush' && !editEntityId && operation === 'add'
      const activeEditEntityId = editEntityId
        ?? (createsNewShapeEntity ? null : (voxelStrokeEntityRef.current ? `custom:${voxelStrokeEntityRef.current}` : null))
      const editAssemblyId = activeEditEntityId?.startsWith('assembly:') ? activeEditEntityId.slice('assembly:'.length) : undefined
      const editingAsset = activeEditEntityId && currentParts.some((part) => part.kind === 'asset' && partBelongsToEditTarget(part, activeEditEntityId))
      // Custom entities and assembly children can be committed as one draft
      // mutation. Asset instances keep the established local-coordinate path.
      if (!editingAsset) {
        const entityId = activeEditEntityId?.startsWith('custom:')
          ? activeEditEntityId.slice('custom:'.length)
          : createsNewShapeEntity
            ? `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            : voxelStrokeEntityRef.current ?? `voxel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        voxelStrokeEntityRef.current = entityId
        markVoxelStrokeOwners([`custom:${entityId}`])
        const excluded = currentParts.filter((part) => activeEditEntityId && partBelongsToEditTarget(part, activeEditEntityId)).map((part) => part.id)
        const insertable = addTargets.filter((voxel) => {
          const owners = sceneOccupancyRef.current?.queryProjectVoxel(voxel).ownerIds ?? []
          return owners.every((ownerId) => excluded.includes(ownerId))
        })
        const transaction = voxelStrokeTransactionRef.current
        const occupiedCustomSceneKeys = transaction?.occupiedCustomSceneKeys
          ?? new Set(currentParts.filter((part) => part.kind === 'custom').flatMap((part) => scenePartVoxels(part)).map(sceneVoxelKey))
        const filteredInsertable = insertable.filter((voxel) => !occupiedCustomSceneKeys.has(sceneVoxelKey(voxel)))
        if (filteredInsertable.length) updateProject((draft) => {
          filteredInsertable.forEach((voxel) => {
            // Shape previews, especially extrusion, carry the source voxel's
            // own material. Do not replace it with the currently selected
            // palette swatch: a multicolour source layer must remain
            // multicolour at the exact same coordinates.
            draft.customVoxels.push(sceneToStoredCustomVoxel(draft, { ...voxel, entityId }, entityId))
            occupiedCustomSceneKeys.add(sceneVoxelKey(voxel))
          })
          if (editAssemblyId) {
            const assembly = (draft.assemblies ?? []).find((item) => item.id === editAssemblyId)
            if (assembly && !assembly.memberKeys.includes(`voxel:${entityId}`)) assembly.memberKeys.push(`voxel:${entityId}`)
          }
        })
        if (!activeEditEntityId) {
          setSelectedId(`custom:${entityId}`)
          setEditEntityId(`custom:${entityId}`)
          setCheckedTreePartIds([`custom:${entityId}`])
        } else setSelectedId(`custom:${entityId}`)
        notifyEditor(activeEditEntityId ? `已在当前编辑实体中添加 ${filteredInsertable.length} 个体素` : `已新建用户实体并进入编辑模式 · ${filteredInsertable.length} 个体素`)
        return
      }
      // Asset edits used to call addVoxel once per sampled cell. That caused a
      // full override-array replacement and notification for every voxel in a
      // brush frame. Resolve the local coordinates first, then commit one
      // grouped override batch per affected instance.
      const excludedOwnerIds = currentParts
        .filter((part) => partBelongsToEditTarget(part, activeEditEntityId!))
        .map((part) => part.id)
      const editableAssetParts = currentParts.filter((part) => part.kind === 'asset' && part.instanceId && partBelongsToEditTarget(part, activeEditEntityId!))
      const assetTargets = new Map<string, Voxel[]>()
      addTargets.forEach((voxel) => {
        const owners = sceneOccupancyRef.current?.queryProjectVoxel(voxel).ownerIds ?? []
        if (owners.some((ownerId) => !excludedOwnerIds.includes(ownerId))) return
        for (const part of editableAssetParts) {
          const instance = currentProject.instances.find((item) => item.id === part.instanceId)
          const asset = instance ? currentProject.assets.find((item) => item.id === instance.assetId) : undefined
          if (!instance || !asset || !part.instanceId) continue
          const local = assetTransformCacheRef.current!.localCoordinateAtSceneVoxel(instance, asset, voxel, part.partId)
          if (!local) continue
          const targets = assetTargets.get(part.instanceId) ?? []
          // Keep the material carried by the scene-space candidate. For a
          // brush/shape this is the active swatch; for extrusion it is the
          // corresponding source-layer material.
          targets.push({
            ...local,
            materialId: voxel.materialId,
            ...(voxel.paintMaterialId ? { paintMaterialId: voxel.paintMaterialId } : {}),
            ...(voxel.shape ? {
              shape: voxel.shape,
              facing: voxel.facing,
              rotation: voxel.rotation,
            } : {}),
          })
          assetTargets.set(part.instanceId, targets)
          break
        }
      })
      assetTargets.forEach((voxels, instanceId) => editInstanceVoxels(instanceId, uniqueVoxels(voxels), 'add'))
      return
    }
    if (operation === 'subtract') {
      const assetTargets = new Map<string, Voxel[]>()
      const parts = voxelStrokePartsRef.current ?? sceneEntityParts(projectRef.current)
      const partsById = new Map(parts.map((part) => [part.id, part]))
      const customTargets: Voxel[] = []
      // Resolve owners through the chunk-backed occupancy index instead of
      // searching every part's voxel array for every target in the batch.
      // This matters most for a large brush/shape applied to an imported
      // model, where the old nested find/some loop was O(targets * model).
      targets.forEach((target) => {
        const ownerIds = sceneOccupancyRef.current?.queryProjectVoxel(target).ownerIds ?? []
        ownerIds.forEach((ownerId) => {
          const part = partsById.get(ownerId)
          if (!part || (editEntityId && !partBelongsToEditTarget(part, editEntityId))) return
          if (part.kind === 'custom') {
            markVoxelStrokeOwners([part.id])
            customTargets.push({ ...target, entityId: part.partId })
            return
          }
          if (!part.instanceId) return
          markVoxelStrokeOwnerRoot(part.instanceId)
          const instance = projectRef.current.instances.find((item) => item.id === part.instanceId)
          const asset = instance ? projectRef.current.assets.find((item) => item.id === instance.assetId) : undefined
          const local = instance && asset
            ? assetTransformCacheRef.current!.localVoxelAtSceneVoxel(instance, asset, target)
            : undefined
          if (local) assetTargets.set(part.instanceId, [...(assetTargets.get(part.instanceId) ?? []), local])
        })
      })
      if (customTargets.length) removeVoxels(customTargets)
      assetTargets.forEach((items, instanceId) => editInstanceVoxels(instanceId, items, 'remove'))
      return
    }
    if (!editEntityId) {
      notifyEditor('改色需要先进入实体编辑模式')
      return
    }
    const parts = voxelStrokePartsRef.current ?? sceneEntityParts(projectRef.current)
    updateProject((draft) => {
      const currentCustomIds = new Set(parts.filter((part) => part.kind === 'custom' && partBelongsToEditTarget(part, editEntityId)).map((part) => part.partId))
      const targetKeys = new Set(targets.map(sceneVoxelKey))
      draft.customVoxels = draft.customVoxels.map((voxel) => {
        if (!currentCustomIds.has(voxelEntityId(voxel))) return voxel
        const offset = customEntityOffset(draft, voxelEntityId(voxel))
        const sceneKey = sceneVoxelKey({ x: voxel.x + offset.x, y: voxel.y + offset.y, z: voxel.z + offset.z })
        return targetKeys.has(sceneKey)
          ? { ...voxel, paintMaterialId: activeMaterial }
          : voxel
      })
      const assetTargets = new Map<string, Voxel[]>()
      const partsById = new Map(parts.map((part) => [part.id, part]))
      targets.forEach((target) => {
        const ownerIds = sceneOccupancyRef.current?.queryProjectVoxel(target).ownerIds ?? []
        ownerIds.forEach((ownerId) => {
          const part = partsById.get(ownerId)
          if (part?.kind !== 'asset' || !part.instanceId || !partBelongsToEditTarget(part, editEntityId)) return
          markVoxelStrokeOwnerRoot(part.instanceId)
          const instance = draft.instances.find((item) => item.id === part.instanceId)
          const asset = instance ? draft.assets.find((item) => item.id === instance.assetId) : undefined
          const local = instance && asset
            ? assetTransformCacheRef.current!.localVoxelAtSceneVoxel(instance, asset, target)
            : undefined
          if (local) assetTargets.set(part.instanceId, [...(assetTargets.get(part.instanceId) ?? []), local])
        })
      })
      assetTargets.forEach((items, instanceId) => {
        const instance = draft.instances.find((item) => item.id === instanceId)
        if (!instance) return
        const keys = new Set(items.map((item) => `${item.x},${item.y},${item.z}`))
        instance.overrides = (instance.overrides ?? []).filter((item) => !keys.has(`${item.x},${item.y},${item.z}`))
        instance.overrides.push(...items.map((item) => ({ ...item, materialId: activeMaterial, mode: 'paint' as const })))
      })
    })
    notifyEditor(`已改色 ${targets.length} 个体素`)
  }

  const editInstanceVoxels = (instanceId: string, voxels: Voxel[], mode: VoxelOverride['mode']) => {
    if (!voxels.length) return
    if (mode === 'add') useMaterial(voxels[0].materialId)
    if (mode !== 'paint') markVoxelStrokeOwnerRoot(instanceId)
    updateProject((draft) => {
      const instance = draft.instances.find((item) => item.id === instanceId)
      if (!instance) return
      const overrides = instance.overrides ?? []
      const targets = new Set(voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
      instance.overrides = overrides.filter((item) => !targets.has(`${item.x},${item.y},${item.z}`))
      instance.overrides.push(...voxels.map((voxel) => ({ ...voxel, mode })))
    })
    notifyEditor(mode === 'remove' ? `已擦除资产体素 · ${voxels.length} 个` : `已在资产上添加 ${voxels.length} 个体素`)
  }

  const editInstanceVoxel = (instanceId: string, voxel: Voxel, mode: VoxelOverride['mode']) => editInstanceVoxels(instanceId, [voxel], mode)

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

  const placementGeometryFor = (asset: VoxelAsset) => {
    const cached = placementGeometryCacheRef.current.get(asset)
    if (cached) return cached
    const originX = snapAssetOrigin(0, asset.width)
    const originZ = snapAssetOrigin(0, asset.depth)
    const canonicalInstance: SceneInstance = {
      id: 'placement-canonical',
      assetId: asset.id,
      x: originX,
      y: 0,
      z: originZ,
      rotation: 0,
      style: asset.style,
      visible: true,
      overrides: [],
    }
    const pairs = instanceVoxelPairs(canonicalInstance, asset)
    const sceneVoxels = pairs.map((pair) => pair.scene)
    const next = {
      originX,
      originZ,
      pairs,
      sceneVoxels,
      bounds: gridVoxelBounds(sceneVoxels),
    }
    placementGeometryCacheRef.current.set(asset, next)
    return next
  }

  const placementDeltaFor = (asset: VoxelAsset, x: number, y: number, z: number) => {
    const geometry = placementGeometryFor(asset)
    return {
      x: assetOriginGridCoordinate(x, asset.width) - assetOriginGridCoordinate(geometry.originX, asset.width),
      y: worldToVoxel(y),
      z: assetOriginGridCoordinate(z, asset.depth) - assetOriginGridCoordinate(geometry.originZ, asset.depth),
    }
  }

  const placementPairsAt = (asset: VoxelAsset, x: number, y: number, z: number) => {
    const geometry = placementGeometryFor(asset)
    const delta = placementDeltaFor(asset, x, y, z)
    return geometry.pairs.map((pair) => ({
      ...pair,
      scene: {
        ...pair.scene,
        x: pair.scene.x + delta.x,
        y: pair.scene.y + delta.y,
        z: pair.scene.z + delta.z,
      },
    }))
  }

  const placementAssetWithinSceneBoundary = (asset: VoxelAsset, x: number, y: number, z: number) => {
    const geometry = placementGeometryFor(asset)
    const bounds = sceneBoundsForProject(projectRef.current)
    if (!geometry.bounds) return true
    const delta = placementDeltaFor(asset, x, y, z)
    return translatedVoxelBoundsWithinScene(geometry.bounds, bounds, delta.x, delta.y, delta.z)
  }

  const hasPlacementAssetCollisionAt = (asset: VoxelAsset, x: number, y: number, z: number) => {
    const geometry = placementGeometryFor(asset)
    const delta = placementDeltaFor(asset, x, y, z)
    return sceneOccupancyRef.current!.collidesTranslatedProjectVoxels(
      geometry.sceneVoxels,
      delta,
    )
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
    const bounds = sceneBoundsForProject(projectRef.current)
    const runtimeBounds = {
      minGx: Math.ceil(-bounds.x / 2 - 0.5),
      maxGx: Math.floor(bounds.x / 2 - 0.5),
      minGy: Math.ceil(-bounds.y / 2 - 0.5),
      maxGy: Math.floor(bounds.y / 2 - 0.5),
      minGz: 0,
      maxGz: Math.max(0, bounds.z - 1),
    }
    const hit = raycastVoxelDda(
      { x: origin.x / VOXEL_WORLD_SIZE, y: origin.y / VOXEL_WORLD_SIZE, z: origin.z / VOXEL_WORLD_SIZE },
      direction,
      (voxel) => sceneOccupancyRef.current!.queryRuntimeVoxel(voxel),
      Math.max(4000, Math.hypot(bounds.x, bounds.y, bounds.z) * 2 + 64),
      runtimeBounds,
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
    setModelImportTargetVoxels(32)
    setModelImportMode('solid')
    setModelImportDialog({ file, result: null, error: '', progress: 0, progressLabel: '等待开始', busy: false })
  }

  const runModelImport = async () => {
    const current = modelImportDialog
    if (!current || current.busy) return
    setModelImportDialog((state) => state ? { ...state, result: null, error: '', busy: true, progress: 0, progressLabel: '准备体素化' } : state)
    try {
      const isVox = current.file.name.toLowerCase().endsWith('.vox')
      const result = isVox
        ? await (async () => {
          setModelImportDialog((state) => state ? { ...state, progress: 0.35, progressLabel: '正在读取 VOX 体素数据' } : state)
          const imported = importVoxBufferAsVoxelAsset(current.file.name, await current.file.arrayBuffer())
          const maxDimension = Math.max(imported.asset.width, imported.asset.depth, imported.asset.height)
          setModelImportTargetVoxels(maxDimension)
          return {
            asset: imported.asset,
            diagnostics: {
              sourceFormat: 'vox' as const,
              mode: 'surface' as const,
              targetSizeVoxels: maxDimension,
              triangleCount: 0,
              partCount: imported.modelCount,
              closedMesh: false,
              voxelCount: imported.asset.voxels.length,
              warnings: ['VOX 已经是体素格式，未进行网格采样；每个 VOX 体素直接转换为莫测造境标准体素。', ...imported.warnings],
            },
          }
        })()
        : await importModelAsVoxelAssetInWorker(current.file, {
          targetSizeVoxels: Math.max(1, Math.min(MAX_TARGET_SIZE_VOXELS, Math.round(modelImportTargetVoxels || 1))),
          mode: modelImportMode,
          materialId: activeMaterial,
          palette: projectRef.current.materials,
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
    setNotice(`${result.diagnostics.sourceFormat === 'vox' ? 'VOX 已转换为' : '模型已转为'} ${asset.voxels.length} 个标准体素 · 请拖动放置`)
  }

  const endPlacement = () => {
    interactionActiveRef.current = false
    setPlacementAssetId(null)
    setPendingEntityImport(null)
  }

  const previewPlacementAt = (assetId: string, x: number, z: number): PlacementPreview | null => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId) ?? (pendingEntityImport?.asset.id === assetId ? pendingEntityImport.asset : undefined)
    if (!asset) return null
    const position = { assetId, x: snapAssetOrigin(x, asset.width), y: 0, z: snapAssetOrigin(z, asset.depth) }
    return { ...position, valid: placementAssetWithinSceneBoundary(asset, position.x, position.y, position.z) && !hasPlacementAssetCollisionAt(asset, position.x, position.y, position.z) }
  }

  const sceneNameForPlacement = (asset: VoxelAsset): string => {
    // New templates carry an immutable scene-facing snapshot. Never consult
    // the editable library label when that snapshot exists.
    if (asset.sceneName?.trim() || asset.assembly?.sceneName?.trim()) return sceneNameForAsset(asset)

    // Older ordinary templates cannot be retroactively reconstructed from
    // the asset itself. If one is still represented in the current scene,
    // however, its source link gives us the authored file-tree name. This
    // makes old local records behave like new records without changing their
    // library label or topology.
    const sourceEntityIds = new Set(Object.entries(projectRef.current.customEntitySources ?? {})
      .filter(([, source]) => source.assetId === asset.id)
      .map(([entityId]) => entityId))
    if (sourceEntityIds.size) {
      const sourcePart = sceneEntityParts(projectRef.current).find((part) => sourceEntityIds.has(part.partId))
      if (sourcePart) return sceneEntityTreeName(projectRef.current, sourcePart)
    }
    return sceneNameForAsset(asset)
  }

  const placeAssetAt = (assetId: string, x: number, z: number) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId) ?? (pendingEntityImport?.asset.id === assetId ? pendingEntityImport.asset : undefined)
    if (!asset) return
    const position = { x: snapAssetOrigin(x, asset.width), y: 0, z: snapAssetOrigin(z, asset.depth) }
    const outsideBoundary = !placementAssetWithinSceneBoundary(asset, position.x, position.y, position.z)
    if (outsideBoundary || hasPlacementAssetCollisionAt(asset, position.x, position.y, position.z)) {
      setNotice(outsideBoundary ? `无法放置资产 · ${asset.name} 超出场景边界` : `无法放置资产 · ${asset.name} 与已有实体重叠`)
      endPlacement()
      return
    }
    const instanceId = `instance-${asset.id}-${Date.now()}`
    // Do not create a SceneInstance here. Resolve the asset once at placement
    // time and store the effective scene cells as ordinary custom voxels. This
    // makes a dragged template, a model import and a hand-drawn entity share
    // exactly the same render, hit-test, move and collision representation.
    const placementInstance: SceneInstance = { id: instanceId, assetId: asset.id, ...position, rotation: 0, style: asset.style, visible: true, overrides: [] }
    // Use the exact pair list that powered the placement boundary and
    // collision checks. This removes the last preview/commit coordinate split.
    const allPairs = placementPairsAt(asset, position.x, position.y, position.z)
    const groupedPairs = asset.assembly
      ? [...allPairs.reduce((groups, pair) => {
        const list = groups.get(pair.partId) ?? []
        list.push(pair)
        groups.set(pair.partId, list)
        return groups
      }, new Map<string, Array<{ local: Voxel; scene: Voxel }>>()).entries()]
      : [['__asset__', allPairs] as const]
    const usedEntityIds = new Set(projectRef.current.customVoxels.map((voxel) => voxelEntityId(voxel)))
    const materializedParts = groupedPairs.map(([partId, pairs], index) => {
      const baseId = `voxel-${instanceId}-${index + 1}`
      let entityId = baseId
      let suffix = 2
      while (usedEntityIds.has(entityId)) entityId = `${baseId}-${suffix++}`
      usedEntityIds.add(entityId)
      const voxels = pairs.map(({ local, scene }) => {
        const variant = !asset.templateColor ? styleMaterialVariants[placementInstance.style] : undefined
        const renderAsset = variant ? { ...asset, color: variant.color, accent: variant.accent } : asset
        const paintedColor = local.paintMaterialId
          ? materialColorForVoxel(projectRef.current, { ...local, materialId: local.paintMaterialId }, renderAsset)
          : undefined
        const { paintMaterialId: _paintMaterialId, ...sceneVoxel } = scene
        return {
          ...sceneVoxel,
          materialId: paintedColor
            ?? asset.templateColor
            ?? materialColorForVoxel(projectRef.current, local, renderAsset),
          entityId,
        }
      })
      return { partId, entityId, voxels }
    })
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
      draft.customVoxels.push(...materializedParts.flatMap((part) => part.voxels))
      // The scene representation is intentionally the same ordinary voxel
      // representation used by hand-drawn entities, but that must not erase
      // the source asset's identity. Imported models carry their filename in
      // VoxelAsset.name; persist it on the new scene entity before the naming
      // normalizer runs so it survives later edits, save/open, and reload.
      // Assembly children keep the assembly naming scheme below, while a
      // non-assembly asset is one scene entity and uses the asset name as its
      // initial display name.
      if (!asset.assembly && materializedParts.length === 1) {
        const memberKey = `voxel:${materializedParts[0].entityId}`
        // `asset.name` is the editable asset-library label. The scene-facing
        // name is captured separately when the template is saved, so changing
        // a template's library name cannot rename an entity that is placed
        // back into a scene.
        const existingNames = Object.values(draft.entityNames ?? {})
        const sceneName = uniqueSceneName(existingNames, sceneNameForPlacement(asset), '实体')
        draft.entityNames = { ...(draft.entityNames ?? {}), [memberKey]: sceneName }
        // Imported model assets may be added while another entity is being
        // edited, which places the new part under an assembly. Mark only this
        // model-derived name as explicit so the hierarchical auto-namer does
        // not turn it back into “手动体素实体 …”. Hand-drawn entities and
        // ordinary template entities keep the established auto-name rules.
        const importedModel = asset.kind === 'imported'
          && asset.isTemplate !== true
          && asset.source !== undefined
          && asset.source !== '场景实体保存'
          && !asset.source.includes('拆分子实体')
        if (importedModel) draft.entityNameModes = { ...(draft.entityNameModes ?? {}), [memberKey]: 'custom' }
      }
      // Portable entity batches carry one name per materialized part. Write
      // standalone names before the normalizer runs; assembly members are
      // deliberately left to the same hierarchical naming path used by
      // assets dragged from the asset library. Otherwise an imported
      // assembly can keep the source member names as custom names and two
      // assemblies end up with identical children in the file tree.
      if (asset.assembly?.partNames) {
        const usedNames = new Set(
          Object.values(draft.entityNames ?? {})
            .map((name) => name.trim())
            .filter(Boolean),
        )
        materializedParts.forEach((part) => {
          const importedName = asset.assembly?.partNames?.[part.partId]
          const baseName = importedName?.trim()
          if (!baseName) return
          const nextName = uniqueSceneName(usedNames, baseName, '子实体')
          usedNames.add(nextName)
          const memberKey = `voxel:${part.entityId}`
          draft.entityNames = { ...(draft.entityNames ?? {}), [memberKey]: nextName }
          draft.entityNameModes = { ...(draft.entityNameModes ?? {}), [memberKey]: 'custom' }
        })
      }
      if (draft.customEntitySources) {
        const sourceAsset = asset.isTemplate === true
          ? asset
          : asset.templateSourceId
            ? draft.assets.find((candidate) => candidate.id === asset.templateSourceId && candidate.isTemplate === true)
            : undefined
        if (sourceAsset) {
          materializedParts.forEach((part) => {
            draft.customEntitySources![part.entityId] = {
              assetId: sourceAsset.id,
              categoryPath: normalizeAssetCategoryPath(sourceAsset.categoryPath),
            }
          })
        }
      } else if (asset.isTemplate === true) {
        draft.customEntitySources = Object.fromEntries(materializedParts.map((part) => [part.entityId, {
          assetId: asset.id,
          categoryPath: normalizeAssetCategoryPath(asset.categoryPath),
        }]))
      }
      // Imported model assets are transient placement sources. Remove them
      // after materialization; template assets remain in the library.
      if (asset.isTemplate !== true) draft.assets = draft.assets.filter((candidate) => candidate.id !== asset.id)
      if (asset.assembly) {
        const nodeIds = new Map(asset.assembly.nodes.map((node) => [node.id, `assembly-${instanceId}-${node.id}`]))
        const partIds = new Map(materializedParts.map((part) => [part.partId, part.entityId]))
        const usedAssemblyNames = new Set(
          (draft.assemblies ?? [])
            .map((assembly) => assembly.name?.trim())
            .filter((name): name is string => Boolean(name)),
        )
        asset.assembly.nodes.forEach((node) => {
          const memberKeys = [...new Set(node.memberKeys.flatMap((memberKey) => {
            if (memberKey.startsWith('assembly:')) {
              const mapped = nodeIds.get(memberKey.slice('assembly:'.length))
              return mapped ? [`assembly:${mapped}`] : []
            }
            if (memberKey.startsWith('part:')) {
              const entityId = partIds.get(memberKey.slice('part:'.length))
              return entityId ? [`voxel:${entityId}`] : []
            }
            return []
          }))]
          if (memberKeys.length < 2) return
          const sceneAssemblyId = nodeIds.get(node.id)!
          const parentAssemblyId = node.parentAssemblyId ? nodeIds.get(node.parentAssemblyId) : undefined
          const baseName = sceneAssemblyNodeNameForAsset(asset, node)
          const sceneAssemblyName = uniqueSceneName(usedAssemblyNames, baseName, '装配体')
          usedAssemblyNames.add(sceneAssemblyName)
          draft.assemblies = [...(draft.assemblies ?? []), {
            id: sceneAssemblyId,
            // Asset-library naming is intentionally not used here. Preserve
            // the authored scene/tree name and only suffix a real collision
            // with an assembly already present in the destination scene.
            name: sceneAssemblyName,
            memberKeys,
            nameMode: 'custom',
            ...(parentAssemblyId ? { parentAssemblyId } : {}),
          }]
        })
        const rootAssemblyIds = (asset.assembly.rootIds?.length ? asset.assembly.rootIds : [asset.assembly.rootId])
          .map((rootId) => nodeIds.get(rootId))
          .filter((rootId): rootId is string => Boolean(rootId))
        placedRootAssemblyId = rootAssemblyIds[0] ?? ''
        placedMemberKeys = rootAssemblyIds.length
          ? rootAssemblyIds.map((rootId) => `assembly:${rootId}`)
          : materializedParts.map((part) => `voxel:${part.entityId}`)
      } else {
        placedMemberKeys = materializedParts.map((part) => `voxel:${part.entityId}`)
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
    } else setSelectedId(placedRootAssemblyId ? `assembly:${placedRootAssemblyId}` : materializedParts.length === 1 ? `custom:${materializedParts[0].entityId}` : `custom:${materializedParts[0]?.entityId ?? ''}`)
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
      const candidate = { ...instance, x: translateWorldByVoxels(instance.x, deltaX), y: voxelToWorld(currentY + deltaY), z: translateWorldByVoxels(instance.z, deltaZ) }
      return (!asset || sceneVoxelsWithinBounds(resolveInstanceSceneVoxels(candidate, asset), bounds)) && !hasInstanceCollisionAt(instanceId, candidate.x, candidate.y ?? 0, candidate.z)
    })
    if (!result.moved) {
      if (result.blocked) setNotice('资产已抵达碰撞边界 · 该方向无法继续')
      return false
    }
    const nextX = translateWorldByVoxels(instance.x, result.deltaX)
    const nextY = voxelToWorld(currentY + result.deltaY)
    const nextZ = translateWorldByVoxels(instance.z, result.deltaZ)
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

  const resolveCurrentSceneParts = (parts: SceneEntityPart[]): SceneEntityPart[] => {
    // A move is committed through a transition so a large model does not
    // block pointer-up. Before that transition paints, the viewport may send
    // another pointer event with the previous render's part objects. Resolve
    // the same IDs against the current project snapshot so the occupancy
    // index, collision math and persisted transforms all use one coordinate
    // frame.
    const currentParts = sceneEntityParts(projectRef.current)
    const byId = new Map(currentParts.map((part) => [part.id, part]))
    return parts.map((part) => byId.get(part.id) ?? part)
  }

  const previewScenePartsMove = (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number): GridMoveResult => {
    const currentProject = projectRef.current
    if (!deltaX && !deltaY && !deltaZ) {
      const result = { moved: false, blocked: false, deltaX: 0, deltaY: 0, deltaZ: 0 }
      sceneMoveValidationRef.current = { project: currentProject, parts, deltaX, deltaY, deltaZ, result }
      return result
    }
    // A pointer gesture may outlive a React transition. Only reuse the
    // expensive bounds snapshot when it belongs to the same published project
    // root; otherwise the previous transform could be used for collision
    // testing after an undo, edit, or another scene mutation.
    const cachedMove = sceneMoveBoundsRef.current?.project === currentProject
      && sceneMoveBoundsRef.current.sourceParts === parts
      ? sceneMoveBoundsRef.current
      : null
    const currentSceneParts = sceneEntityParts(currentProject)
    const currentParts = resolveCurrentSceneParts(parts)
    // The index keeps pure moves as lazy owner translations. Reconcile those
    // translations against the latest project offsets before every drag
    // validation so a transition/undo cannot leave collision coordinates one
    // move behind the rendered scene.
    sceneOccupancyRef.current?.syncOwnerTransforms(currentSceneParts)
    const movableParts = currentParts.filter((part) => !scenePartIsLocked(currentProject, part))
    if (!movableParts.length) {
      const result = { moved: false, blocked: true, deltaX: 0, deltaY: 0, deltaZ: 0 }
      sceneMoveValidationRef.current = { project: currentProject, parts, deltaX, deltaY, deltaZ, result }
      return result
    }
    const bounds = sceneBoundsForProject(currentProject)
    // Capture the moving selection's scene-space bounds once per pointer
    // gesture.  Drag rendering is imperative, so the authoritative project
    // does not move until pointer-up; using this stable box keeps every
    // pointer sample in the same coordinate frame.
    const cachedBounds = cachedMove?.bounds ?? scenePartsGridBounds(movableParts, sceneOccupancyRef.current)
    const movingIds = cachedMove?.movingIds ?? movableParts.map((part) => part.id)
    sceneMoveBoundsRef.current = { project: currentProject, sourceParts: parts, parts: currentParts, movingIds, bounds: cachedBounds }
    if (!cachedBounds) {
      const result = { moved: false, blocked: true, deltaX: 0, deltaY: 0, deltaZ: 0 }
      sceneMoveValidationRef.current = { project: currentProject, parts, deltaX, deltaY, deltaZ, result }
      return result
    }
    const result = resolveGridMove(deltaX, deltaY, deltaZ, (stepX, stepY, stepZ) => {
      return translatedVoxelBoundsWithinScene(cachedBounds, bounds, stepX, stepY, stepZ)
        && !sceneOccupancyRef.current!.collidesTranslatedSceneParts(movableParts, { x: stepX, y: stepY, z: stepZ }, movingIds)
    }, false)
    sceneMoveValidationRef.current = { project: currentProject, parts, deltaX, deltaY, deltaZ, result }
    return result
  }

  const commitScenePartsMove = (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number): GridMoveResult => {
    const cachedValidation = sceneMoveValidationRef.current
    const matchingValidation = cachedValidation
      && cachedValidation.project === projectRef.current
      && cachedValidation.parts === parts
      && cachedValidation.deltaX === deltaX
      && cachedValidation.deltaY === deltaY
      && cachedValidation.deltaZ === deltaZ
      ? cachedValidation
      : null
    const hasCachedValidation = Boolean(matchingValidation)
    const result = matchingValidation
      ? matchingValidation.result
      : previewScenePartsMove(parts, deltaX, deltaY, deltaZ)
    sceneMoveValidationRef.current = null
    if (!result.moved) {
      // This snapshot can contain every voxel of a large moved entity. It is
      // valid only for the current pointer gesture, so release it immediately
      // when the move is blocked or otherwise has no effect.
      sceneMoveBoundsRef.current = null
      if (result.blocked) setNotice('实体已抵达碰撞边界 · 该方向无法继续')
      return result
    }
    const effectiveParts = sceneMoveBoundsRef.current?.project === projectRef.current
      && sceneMoveBoundsRef.current.sourceParts === parts
      ? sceneMoveBoundsRef.current.parts
      : resolveCurrentSceneParts(parts)
    const movableParts = effectiveParts.filter((part) => !scenePartIsLocked(projectRef.current, part))
    let finalResult = result
    if (!hasCachedValidation) {
      sceneOccupancyRef.current?.syncOwnerTransforms(sceneEntityParts(projectRef.current))
      // There was no matching pointermove validation, so this non-gesture
      // caller still needs a final collision and boundary check. A normal
      // drag release does have a matching cached result and deliberately
      // skips this second decision path.
      const freshBounds = scenePartsGridBounds(movableParts, null)
      const movingIdsForCommit = movableParts.map((part) => part.id)
      const isMoveValid = (candidate: GridMoveResult) => Boolean(freshBounds)
        && translatedVoxelBoundsWithinScene(freshBounds!, sceneBoundsForProject(projectRef.current), candidate.deltaX, candidate.deltaY, candidate.deltaZ)
        && !sceneOccupancyRef.current!.collidesTranslatedSceneParts(
          movableParts,
          { x: candidate.deltaX, y: candidate.deltaY, z: candidate.deltaZ },
          movingIdsForCommit,
        )
      // Keep the same hard boundary/collision rules for callers without a
      // cached preview, but do not reject the position already shown during a
      // drag merely because a second snapshot disagrees at pointer-up.
      finalResult = isMoveValid(result)
        ? result
        : resolveGridMove(deltaX, deltaY, deltaZ, (stepX, stepY, stepZ) => isMoveValid({ moved: true, blocked: false, deltaX: stepX, deltaY: stepY, deltaZ: stepZ }), false)
    }
    if (!finalResult.moved) {
      sceneMoveBoundsRef.current = null
      setNotice('实体已抵达场景边界或碰撞边界 · 该方向无法继续')
      return finalResult
    }
    const currentParts = sceneEntityParts(projectRef.current)
    const movingCustomIds = new Set(movableParts.filter((part) => part.kind === 'custom').map((part) => part.partId))
    const movingAssetParts = movableParts.filter((part) => part.kind === 'asset' && part.instanceId)
    const hasMovingAssets = movingAssetParts.length > 0
    const movingIds = hasMovingAssets ? new Set(movableParts.map((part) => part.id)) : undefined
    const assetPartsByInstance = new Map<string, SceneEntityPart[]>()
    if (hasMovingAssets) {
      movingAssetParts.forEach((part) => {
        const list = assetPartsByInstance.get(part.instanceId!) ?? []
        list.push(part)
        assetPartsByInstance.set(part.instanceId!, list)
      })
    }
    // Pure custom-entity moves do not need asset membership analysis. This
    // avoids scanning every rendered part at release time, which is wasted
    // work for scenes containing large imported assets elsewhere.
    const currentPartsByInstance = hasMovingAssets
      ? currentParts.reduce((groups, part) => {
        if (part.kind !== 'asset' || !part.instanceId) return groups
        const list = groups.get(part.instanceId) ?? []
        list.push(part)
        groups.set(part.instanceId, list)
        return groups
      }, new Map<string, SceneEntityPart[]>())
      : new Map<string, SceneEntityPart[]>()
    // A move changes transforms, not the asset/material catalogs. Keep those
    // large immutable collections shared instead of cloning every voxel in
    // the project on pointer release.
    // Keep the immutable catalogs and untouched instances shared. The old
    // path cloned every instance (including every part-offset map) on release;
    // this is unnecessary for a move and becomes visible in scenes with many
    // instances. Only instances that actually receive a new transform are
    // cloned below.
    const nextProject: ProjectState = { ...projectRef.current }
    // Custom voxel offsets are stored separately and do not mutate any asset
    // instance. Avoid copying the complete instances array for that common
    // path; doing so needlessly invalidated file-tree and derived panel work
    // on every large custom-entity release.
    if (hasMovingAssets) {
      nextProject.instances = [...projectRef.current.instances]
    }
    const mutableInstances = new Map<string, SceneInstance>()
    const mutableInstance = (instanceId: string): SceneInstance | undefined => {
      const cached = mutableInstances.get(instanceId)
      if (cached) return cached
      const index = nextProject.instances.findIndex((instance) => instance.id === instanceId)
      const source = index >= 0 ? nextProject.instances[index] : undefined
      if (!source || index < 0) return undefined
      // Keep partOffsets shared for a root-instance move. Partial part moves
      // replace this field below, so the transform effect can distinguish a
      // root translation from a real child-offset change and skip walking a
      // large imported asset's part tree on every release.
      const clone = { ...source }
      nextProject.instances[index] = clone
      mutableInstances.set(instanceId, clone)
      return clone
    }
    if (movingCustomIds.size) {
      const nextOffsets = { ...(nextProject.customEntityOffsets ?? {}) }
      movingCustomIds.forEach((entityId) => {
        const current = nextOffsets[entityId] ?? { x: 0, y: 0, z: 0 }
        nextOffsets[entityId] = {
          x: current.x + finalResult.deltaX,
          y: current.y + finalResult.deltaY,
          z: current.z + finalResult.deltaZ,
        }
      })
      nextProject.customEntityOffsets = nextOffsets
    }
    assetPartsByInstance.forEach((selectedParts, instanceId) => {
      const instance = mutableInstance(instanceId)
      if (!instance) return
      const allParts = currentPartsByInstance.get(instanceId) ?? []
      const movesWholeInstance = allParts.length > 0 && selectedParts.length === allParts.length && allParts.every((part) => movingIds?.has(part.id))
      if (movesWholeInstance) {
        const asset = nextProject.assets.find((item) => item.id === instance.assetId)
        instance.x = translateWorldByVoxels(instance.x, finalResult.deltaX)
        instance.y = voxelToWorld(worldToVoxel(instance.y ?? 0) + finalResult.deltaY)
        instance.z = translateWorldByVoxels(instance.z, finalResult.deltaZ)
        return
      }
      const offsets = { ...(instance.partOffsets ?? {}) }
      selectedParts.forEach((part) => {
        const current = offsets[part.partId] ?? { x: 0, y: 0, z: 0 }
        offsets[part.partId] = {
          x: snapWorld(current.x + voxelToWorld(finalResult.deltaX)),
          y: snapWorld(current.y + voxelToWorld(finalResult.deltaY)),
          z: snapWorld(current.z + voxelToWorld(finalResult.deltaZ)),
        }
      })
      instance.partOffsets = offsets
    })
    commitScenePartsMoveFast(nextProject, movableParts, finalResult.deltaX, finalResult.deltaY, finalResult.deltaZ)
    // The occupancy index now owns the lightweight lazy translation. Keeping
    // the temporary scene-coordinate voxel array would retain the whole model
    // until the next drag and increase GC pressure after repeated moves.
    sceneMoveBoundsRef.current = null
    if (finalResult.blocked) setNotice('已抵达场景或碰撞边界 · 该方向无法继续')
    return finalResult
  }

  const cancelScenePartsMove = () => {
    // Pointer cancellation/blur can happen without pointerup. Never let a
    // gesture-local validation or bounds snapshot leak into the next drag.
    sceneMoveValidationRef.current = null
    sceneMoveBoundsRef.current = null
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
      const confirmed = window.confirm('您正在编辑装配体。体素添加、擦除和改色会写回当前装配体成员，不会新建装配体。确定要继续吗？')
      if (!confirmed) return
    }
    setEditEntityId(entityId)
    setSelectedId(entityId)
    setCheckedTreePartIds([entityId])
    if (!entityId.startsWith('assembly:')) revealScenePartPath(entityId)
    setTreeContextMenu(null)
    setNotice(entityId.startsWith('assembly:')
      ? '已进入编辑修改模式 · 修改将写回当前装配体成员，不新建实体'
      : '已进入编辑修改模式 · 当前实体的修改将保留在场景实例上')
  }

  const exitEditMode = () => {
    voxelStrokeEntityRef.current = null
    setCopyPreview(null)
    setTransformPreview(null)
    cancelGeometryPreview()
    setEditEntityId(null)
    setNotice('已退出编辑修改模式')
  }

  const changeTool = (nextTool: Tool) => {
    cancelGeometryPreview()
    setCopyPreview(null)
    setTransformPreview(null)
    setTool(nextTool)
    if (!editEntityId) {
      setSelectedId('')
      setCheckedTreePartIds([])
    }
    setTreeContextMenu(null)
  }

  const saveProject = () => saveProjectToLibrary(false)

  const saveProjectAs = () => saveProjectToLibrary(true)

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
    const partNames: Record<string, string> = {}
    const usedSceneNames = new Set(sceneEntityParts(projectRef.current)
      .map((part) => projectRef.current.entityNames?.[part.memberKey] ?? part.displayLabel ?? part.label ?? '')
      .map((value) => value.trim())
      .filter(Boolean))
    const uniqueImportedName = (requestedName: string) => {
      const base = requestedName.trim() || '导入实体'
      let candidate = base
      let suffix = 2
      while (usedSceneNames.has(candidate)) candidate = `${base} ${suffix++}`
      usedSceneNames.add(candidate)
      return candidate
    }
    const minGrid = {
      x: Math.min(...portable.entities.map((entity) => entity.gridPosition.x)),
      y: Math.min(...portable.entities.map((entity) => entity.gridPosition.y)),
      z: Math.min(...portable.entities.map((entity) => entity.gridPosition.z)),
    }
    const sourceVoxels: Voxel[] = []
    const partVoxels: Record<string, Voxel[]> = {}
    const assemblyEntityIds = new Set(
      portable.assemblies.flatMap((assembly) => assembly.memberKeys
        .filter((memberKey) => memberKey.startsWith('entity:'))
        .map((memberKey) => memberKey.slice('entity:'.length))),
    )
    portable.entities.forEach((entity, index) => {
      const sourceName = entity.name || entity.asset.name || '导入实体'
      // Assembly members are named by the newly created assembly hierarchy at
      // placement time. Only standalone imported entities consume the normal
      // scene-level duplicate-name allocator here.
      const uniqueName = assemblyEntityIds.has(entity.id) ? sourceName.trim() || '子实体' : uniqueImportedName(sourceName)
      importedNames.push({ ...structuredClone(entity.asset), id: `entity-name-${index}`, name: uniqueName })
      // Names are presentation data. Use the portable entity ID for topology
      // references so duplicate names can never merge or redirect a part.
      const partId = `portable-part-${batchId}-${entity.id}`
      entityPartIds.set(entity.id, partId)
      if (!assemblyEntityIds.has(entity.id)) partNames[partId] = uniqueName
      const entityColor = entity.asset.templateColor ?? entity.asset.color
      const voxels = entity.asset.voxels.map((voxel) => ({
        x: voxel.x + entity.gridPosition.x - minGrid.x,
        y: voxel.y + entity.gridPosition.y - minGrid.y,
        z: voxel.z + entity.gridPosition.z - minGrid.z,
        // Keep the source material key, but preserve the final displayed
        // color when the file contains it. Older files without a per-voxel
        // color field use templateColor as a whole-entity fallback.
        materialId: voxel.materialId,
        ...(voxel.paintMaterialId
          ? { paintMaterialId: voxel.paintMaterialId }
          : entity.asset.templateColor
            ? { paintMaterialId: entityColor }
            : {}),
      }))
      partVoxels[partId] = voxels
      sourceVoxels.push(...voxels)
    })
    const importedBounds = voxelBounds(sourceVoxels)!
    // The portable file stores each entity in its own local coordinates plus
    // a scene-grid origin. Normalize the combined batch once, after all
    // offsets have been applied. This gives the placement asset a true common
    // origin while preserving every pairwise delta between entities.
    const batchOrigin = importedBounds.min
    Object.keys(partVoxels).forEach((partId) => {
      partVoxels[partId] = partVoxels[partId].map((voxel) => ({
        ...voxel,
        x: voxel.x - batchOrigin.x,
        y: voxel.y - batchOrigin.y,
        z: voxel.z - batchOrigin.z,
      }))
    })
    const normalizedSourceVoxels = sourceVoxels.map((voxel) => ({
      ...voxel,
      x: voxel.x - batchOrigin.x,
      y: voxel.y - batchOrigin.y,
      z: voxel.z - batchOrigin.z,
    }))
    const maxX = importedBounds.max.x - importedBounds.min.x
    const maxY = importedBounds.max.y - importedBounds.min.y
    const maxZ = importedBounds.max.z - importedBounds.min.z
    const assemblyIdMap = new Map(portable.assemblies.map((assembly) => [assembly.id, `import-assembly-${batchId}-${assembly.id}`]))
    const assemblyNodes: AssetAssembly['nodes'] = portable.assemblies.map((assembly) => ({
      id: assemblyIdMap.get(assembly.id)!,
      // Use the same automatic hierarchy naming as the asset-library drag
      // path. The source name is retained only as a fallback label until the
      // project naming normalizer assigns the new persistent sequence.
      name: assembly.name ?? '装配体',
      parentAssemblyId: assembly.parentAssemblyId ? assemblyIdMap.get(assembly.parentAssemblyId) : undefined,
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
    const childAssemblyIds = new Set(portable.assemblies.flatMap((assembly) => [
      ...(assembly.parentAssemblyId ? [assembly.id] : []),
      ...assembly.memberKeys.filter((key) => key.startsWith('assembly:')).map((key) => key.slice('assembly:'.length)),
    ]))
    const rootAssemblies = portable.assemblies.filter((assembly) => !childAssemblyIds.has(assembly.id))
    const rootIds = rootAssemblies.map((assembly) => assemblyIdMap.get(assembly.id)).filter((id): id is string => Boolean(id))
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
      voxels: normalizedSourceVoxels,
      source: '普通实体文件导入预览',
      isTemplate: false,
      // Keep this metadata even for a batch without assemblies. The placement
      // path then materializes every portable entity as its own ordinary part
      // instead of falling back to one merged __asset__ part.
      assembly: {
        name: rootAssemblies[0]?.name ?? portable.name ?? '导入实体',
        rootId: rootIds[0] ?? '',
        rootIds,
        partNames,
        nodes: assemblyNodes,
      },
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
      // A new scene has no scene instances, but it still shares the user's
      // local template catalog. Reload IndexedDB here instead of taking the
      // empty project's asset array, otherwise New appears to erase all
      // downloaded local assets until the next full application restore.
      const emptyProject = makeEmptyProject()
      const localWorkspace = await initializeLocalLibrary(emptyProject.assets)
      const next = normalizeStoredProject({ ...emptyProject, assets: localWorkspace.assets })
      setAssetCategoryPaths(normalizeAssetCategoryPaths(localWorkspace.categories, next.assets))
      replaceProject(next)
      const firstPart = sceneEntityParts(next)[0]
      setSelectedId(firstPart?.id ?? '')
      setEditEntityId(null)
      setCheckedTreePartIds([])
      markSceneSaved(next, null)
      setNotice('已新建街区工程')
    })
  }

  const createVoxelExportAsset = (id: string, name: string, parts: SceneEntityPart[]) => makeAssetFromSceneParts(
    id,
    name,
    parts,
    '#6c827d',
    '#d2a354',
    (voxel, part) => scenePartVoxelDisplayColor(projectRef.current, part, voxel),
  )

  const exportSelectedPart = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要导出的实体')
      return
    }
    const exportName = selectedAsset?.name ?? selectedEntityParts[0]?.label ?? '选中实体'
    const exportAsset = makeAssetFromSceneParts(`export-${Date.now()}`, exportName, selectedEntityParts, selectedAsset?.color ?? '#6c827d', selectedAsset?.accent ?? '#d2a354')
    const { stl, diagnostics } = makeStlWithDiagnostics(exportAsset, projectRef.current.voxelSizeMm)
    const blob = new Blob([stl], { type: 'model/stl' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${exportName}-选中实体.stl`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice(`已导出选中实体 · ${exportName} · ${selectedEntityParts.length} 个实体${diagnostics.bridgeVoxelCount ? ` · 已补连接 ${diagnostics.bridgeVoxelCount} 个体素` : ''}${diagnostics.nonManifoldEdgesAfter ? ` · 仍有 ${diagnostics.nonManifoldEdgesAfter} 条非流形边` : ''}`)
  }

  const exportSceneStl = () => {
    const allParts = sceneEntityParts(projectRef.current)
    if (!allParts.length) {
      setNotice('当前场景没有可导出的实体')
      return
    }
    const sceneAsset = makeAssetFromSceneParts(`scene-export-${Date.now()}`, projectRef.current.name || '莫测造境场景', allParts, '#6c827d', '#d2a354')
    const { stl, diagnostics } = makeStlWithDiagnostics(sceneAsset, projectRef.current.voxelSizeMm)
    const blob = new Blob([stl], { type: 'model/stl' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${projectRef.current.name || '莫测造境场景'}-完整场景.stl`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice(`已导出完整场景 STL · ${allParts.length} 个实体${diagnostics.bridgeVoxelCount ? ` · 已补连接 ${diagnostics.bridgeVoxelCount} 个体素` : ''}${diagnostics.nonManifoldEdgesAfter ? ` · 仍有 ${diagnostics.nonManifoldEdgesAfter} 条非流形边` : ''}`)
  }

  const exportSelectedPartGlb = async () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要导出的实体')
      return
    }
    const exportName = selectedAsset?.name ?? selectedEntityParts[0]?.label ?? '选中实体'
    try {
      const exportAsset = createVoxelExportAsset(`glb-export-${Date.now()}`, exportName, selectedEntityParts)
      const glb = await encodeGlb(exportAsset, (voxel) => voxel.paintMaterialId ?? voxel.materialId, projectRef.current.voxelSizeMm)
      downloadBinaryFile(glb, `${exportName}-选中实体.glb`, 'model/gltf-binary')
      setNotice(`已导出选中实体 GLB · ${selectedEntityParts.length} 个实体`)
    } catch (error) {
      setNotice(`GLB 导出失败 · ${error instanceof Error ? error.message : '无法生成文件'}`)
    }
  }

  const exportSelectedPartVox = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要导出的实体')
      return
    }
    const exportName = selectedAsset?.name ?? selectedEntityParts[0]?.label ?? '选中实体'
    try {
      const exportAsset = createVoxelExportAsset(`vox-export-${Date.now()}`, exportName, selectedEntityParts)
      const vox = encodeVox(exportAsset, (voxel) => voxel.paintMaterialId ?? voxel.materialId)
      downloadBinaryFile(vox, `${exportName}-选中实体.vox`, 'application/octet-stream')
      setNotice(`${hasNonCubeVoxels(exportAsset.voxels) ? '提示：VOX 不支持非立方体几何，已按逻辑立方体体素降级导出 · ' : ''}已导出选中实体 VOX · ${selectedEntityParts.length} 个实体`)
    } catch (error) {
      setNotice(`VOX 导出失败 · ${error instanceof Error ? error.message : '无法生成文件'}`)
    }
  }

  const exportSceneGlb = async () => {
    const allParts = sceneEntityParts(projectRef.current)
    if (!allParts.length) {
      setNotice('当前场景没有可导出的实体')
      return
    }
    try {
      const name = projectRef.current.name || '莫测造境场景'
      const exportAsset = createVoxelExportAsset(`scene-glb-export-${Date.now()}`, name, allParts)
      const glb = await encodeGlb(exportAsset, (voxel) => voxel.paintMaterialId ?? voxel.materialId, projectRef.current.voxelSizeMm)
      downloadBinaryFile(glb, `${name}-完整场景.glb`, 'model/gltf-binary')
      setNotice(`已导出完整场景 GLB · ${allParts.length} 个实体`)
    } catch (error) {
      setNotice(`场景 GLB 导出失败 · ${error instanceof Error ? error.message : '无法生成文件'}`)
    }
  }

  const exportSceneVox = () => {
    const allParts = sceneEntityParts(projectRef.current)
    if (!allParts.length) {
      setNotice('当前场景没有可导出的实体')
      return
    }
    try {
      const name = projectRef.current.name || '莫测造境场景'
      const exportAsset = createVoxelExportAsset(`scene-vox-export-${Date.now()}`, name, allParts)
      const vox = encodeVox(exportAsset, (voxel) => voxel.paintMaterialId ?? voxel.materialId)
      downloadBinaryFile(vox, `${name}-完整场景.vox`, 'application/octet-stream')
      setNotice(`${hasNonCubeVoxels(exportAsset.voxels) ? '提示：VOX 不支持非立方体几何，已按逻辑立方体体素降级导出 · ' : ''}已导出完整场景 VOX · ${allParts.length} 个实体`)
    } catch (error) {
      setNotice(`场景 VOX 导出失败 · ${error instanceof Error ? error.message : '无法生成文件'}`)
    }
  }

  const exportSelectedEntityFile = () => {
    if (!selectedEntityParts.length) {
      setNotice('请先选择要导出的实体')
      return
    }
    const exportParts = selectedEntityParts.map((part) => ({ ...part, displayLabel: sceneEntityTreeName(projectRef.current, part) }))
    const file = createEntityFile(
      projectRef.current,
      exportParts,
      selectedDisplayName || '莫测造境实体',
      (voxel, part) => scenePartVoxelDisplayColor(projectRef.current, part, voxel),
    )
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
      const loaded = await loadLocalLibrary()
      setLibrary(loaded)
      setLibraryError(null)
      // Scene contents may have changed after a save, duplicate, import, or
      // delete. A refreshed library starts a fresh preview-cache generation.
      sceneLibraryProjectCacheRef.current.clear()
      setAssetCategoryPaths(normalizeAssetCategoryPaths(loaded.assetCategories ?? [], projectRef.current.assets))

      // The scene list and the entity list have separate state.  When a scene
      // is removed (or disappears through another client), the scene list can
      // become empty while the last loaded project snapshot is still present.
      // Keep the selected-scene state consistent with the library response so
      // the entity pane never shows entities from a deleted scene.
      const selectedSceneExists = selectedLibrarySceneId
        ? loaded.scenes.some((scene) => scene.id === selectedLibrarySceneId)
        : false
      if (!selectedSceneExists && (selectedLibrarySceneId || selectedLibrarySceneProject)) {
        setSelectedLibrarySceneId(null)
        setSelectedLibrarySceneProject(null)
        setSelectedLibrarySceneLoading(false)
        setSelectedLibrarySceneRevision((revision) => revision + 1)
        setSceneLibraryContextMenu(null)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '场景库加载失败'
      setLibraryError(message)
      setNotice(`场景库加载失败 · ${message}`)
    } finally {
      setLibraryBusy(false)
    }
  }

  const refreshCloudLibrary = async () => {
    try {
      const [remote, usage] = await Promise.all([loadCloudLibrary(), loadCloudUsage()])
      setCloudAssets(remote.assets)
      setCloudScenes(remote.scenes)
      setCloudUsage(usage)
      setCloudError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : '云端库暂时无法访问'
      setCloudError(message)
    } finally {
      cloudInitialRefreshCompletedRef.current = true
    }
  }

  useEffect(() => {
    void loadAuthUser()
      .then(({ user }) => { setAuthUser(user); setAuthChecked(true) })
      .catch(() => { setAuthUser(null); setAuthChecked(true) })
    setCloudAuthRequiredHandler(() => {
      if (!cloudInitialRefreshCompletedRef.current) return
      setAuthDialogMode('login')
      setAuthDialogOpen(true)
    })
    return () => setCloudAuthRequiredHandler(null)
  }, [])

  // The cloud catalog is independent from the local IndexedDB restore. Load
  // it once after the local session is ready so a page refresh immediately
  // restores the cloud badges and local/cloud pairing in the asset sidebar.
  // Opening the Scene Library also refreshes this catalog, but it must not be
  // the only entry point that does so.
  useEffect(() => {
    if (persistenceStatus === 'loading' || cloudInitialRefreshRef.current) return
    cloudInitialRefreshRef.current = true
    void refreshCloudLibrary()
  }, [persistenceStatus])

  // Cloud-only cards use the same VoxelThumbnail as local cards. Fetching the
  // full asset is deliberately lazy from the catalog perspective: it is kept
  // in memory only and never enters the local asset library until the user
  // explicitly downloads it.
  useEffect(() => {
    const localAssetIds = new Set(project.assets.filter((asset) => asset.isTemplate !== false).map((asset) => asset.id))
    const pending = cloudAssets.filter((summary) => !localAssetIds.has(summary.id) && !cloudAssetPreviews[summary.id] && !cloudAssetPreviewErrors[summary.id])
    if (!pending.length) return
    let cancelled = false
    pending.forEach((summary) => {
      void loadCloudAssetPreview(summary.id).then((asset) => {
        if (cancelled) return
        const previewAsset = withAssetThumbnail(asset)
        setCloudAssetPreviews((current) => current[summary.id] ? current : { ...current, [summary.id]: previewAsset })
      }).catch((error) => {
        if (cancelled) return
        setCloudAssetPreviewErrors((current) => ({ ...current, [summary.id]: error instanceof Error ? error.message : '预览加载失败' }))
      })
    })
    return () => { cancelled = true }
  }, [cloudAssets, cloudAssetPreviewErrors, cloudAssetPreviews, project.assets])

  const setCloudTransferProgress = (progress: CloudProgress) => {
    const key = `${progress.transfer.direction}:${progress.transfer.objectKind}:${progress.transfer.objectId}`
    setCloudTransfers((current) => ({ ...current, [key]: progress }))
    if (progress.status === 'failed') {
      setCloudTransferErrors((current) => ({ ...current, [key]: progress.error ?? '传输失败，请重试' }))
    } else {
      setCloudTransferErrors((current) => {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      })
    }
  }

  const clearCloudTransfer = (key: string) => {
    setCloudTransfers((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setCloudTransferErrors((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const clearCompletedCloudTransfers = (objectKind: 'asset' | 'scene', direction: 'upload' | 'download') => {
    setCloudTransfers((current) => {
      const next = { ...current }
      Object.entries(next).forEach(([key, progress]) => {
        if (progress.transfer.objectKind === objectKind && progress.transfer.direction === direction && progress.status === 'completed') delete next[key]
      })
      return next
    })
  }

  const cloudConflictChoice = (label: string): 'replace' | 'copy' | 'cancel' => {
    const choice = window.prompt(`${label}\n请输入：覆盖 / 副本 / 取消`, '覆盖')?.trim().toLowerCase()
    if (choice === '覆盖' || choice === 'replace' || choice === '1') return 'replace'
    if (choice === '副本' || choice === 'copy' || choice === '2') return 'copy'
    return 'cancel'
  }

  const backupAssetToCloud = async (assetId: string, conflictMode?: 'replace' | 'copy', conflictId?: string) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId && item.isTemplate !== false)
    if (!asset) return
    setNotice(`正在准备云端实体备份 · ${asset.name}`)
    try {
      await uploadCloudAsset(withAssetThumbnail(asset), normalizeAssetCategoryPath(asset.categoryPath), conflictMode, conflictId, setCloudTransferProgress)
      clearCompletedCloudTransfers('asset', 'upload')
      await refreshCloudLibrary()
      setNotice(`已备份实体到云端 · ${asset.name}`)
    } catch (error) {
      const typed = error as Error & { code?: string; conflicts?: Array<{ id: string; name: string }> }
      if (typed.code === 'CLOUD_CONFLICT' && typed.conflicts?.[0]) {
        const conflict = typed.conflicts[0]
        const next = cloudConflictChoice(`云端已有同名或同 ID 实体“${conflict.name}”`)
        if (next !== 'cancel') return backupAssetToCloud(assetId, next, next === 'replace' ? conflict.id : undefined)
        setNotice('已取消云端实体备份')
        return
      }
      setNotice(`云端实体备份失败 · ${typed.message || '请检查网络连接'}`)
    }
  }

  const backupSceneProjectToCloud = async (sourceProject: ProjectState, defaultName: string, requestedName?: string, conflictMode?: 'replace' | 'copy', conflictId?: string) => {
    setNotice('正在准备云端场景备份…')
    // Give the notice a chance to paint before createSceneFile walks a large
    // scene and serializes its embedded asset snapshots on the main thread.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    let sceneFile: MoceSceneFile
    try { sceneFile = createSceneFile(sourceProject) } catch (error) { setNotice(`云端场景备份失败 · ${error instanceof Error ? error.message : '场景数据无效'}`); return }
    const cloudName = requestedName ?? window.prompt('请输入云端场景名称', defaultName.trim() || sceneFile.scene.name)?.trim()
    if (!cloudName) {
      setNotice('已取消云端场景备份')
      return
    }
    // Cloud naming is intentionally independent from the local scene name. The
    // first backup must be explicitly named, while a later backup can choose a
    // different cloud copy without mutating the current local scene.
    const cloudSceneFile = structuredClone(sceneFile)
    cloudSceneFile.scene.name = cloudName
    try {
      const result = await uploadCloudScene(cloudSceneFile, conflictMode, conflictId, setCloudTransferProgress)
      clearCompletedCloudTransfers('scene', 'upload')
      await refreshCloudLibrary()
      setNotice(`已备份场景到云端 · ${result.effectiveName}`)
    } catch (error) {
      const typed = error as Error & { code?: string; conflicts?: Array<{ id: string; name: string }> }
      if (typed.code === 'CLOUD_CONFLICT' && typed.conflicts?.[0]) {
        const conflict = typed.conflicts[0]
        const next = cloudConflictChoice(`云端已有同名或同 ID 场景“${conflict.name}”`)
        if (next !== 'cancel') return backupSceneProjectToCloud(sourceProject, defaultName, cloudName, next, next === 'replace' ? conflict.id : undefined)
        setNotice('已取消云端场景备份')
        return
      }
      setNotice(`云端场景备份失败 · ${typed.message || '请检查网络连接'}`)
    }
  }

  const backupCurrentSceneToCloud = (requestedName?: string, conflictMode?: 'replace' | 'copy', conflictId?: string) =>
    backupSceneProjectToCloud(projectRef.current, projectRef.current.name, requestedName, conflictMode, conflictId)

  const backupStoredSceneToCloud = async (sceneId: string, name: string) => {
    try {
      const source = selectedLibrarySceneId === sceneId && selectedLibrarySceneProject
        ? selectedLibrarySceneProject
        : normalizeStoredProject(restoreProject(await loadLocalScene(sceneId)), { normalizeNaming: false })
      await backupSceneProjectToCloud(source, name)
    } catch (error) {
      setNotice(`云端场景备份失败 · ${error instanceof Error ? error.message : '本地场景读取失败'}`)
    }
  }

  const downloadCloudAssetToLocal = async (summary: CloudAssetSummary) => {
    const key = `download:asset:${summary.id}`
    clearCloudTransfer(key)
    let saved = false
    try {
      const result = await downloadCloudObject('asset', summary.id, undefined, setCloudTransferProgress)
      const asset = JSON.parse(new TextDecoder().decode(result.bytes)) as VoxelAsset
      const existing = projectRef.current.assets.find((item) => item.id === asset.id || item.name === asset.name)
      let nextAsset = structuredClone(asset)
      if (existing) {
        const choice = window.prompt(`本地已有实体“${existing.name}”\n请输入：覆盖 / 副本 / 取消`, '覆盖')?.trim()
        if (choice === '副本' || choice === 'copy' || choice === '2') {
          nextAsset.id = `asset-cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          nextAsset.name = uniqueTemplateAssetName(projectRef.current.assets, nextAsset.name)
        } else if (choice !== '覆盖' && choice !== 'replace' && choice !== '1') {
          setNotice('已取消下载云端实体')
          clearCloudTransfer(key)
          return
        } else nextAsset.id = existing.id
      }
      nextAsset.isTemplate = true
      const storedAsset = await saveLocalAsset(nextAsset)
      updateProject((draft) => {
        const index = draft.assets.findIndex((item) => item.id === storedAsset.id)
        if (index >= 0) draft.assets[index] = storedAsset
        else draft.assets.push(storedAsset)
      })
      await refreshLibrary()
      setNotice(`已下载云端实体 · ${storedAsset.name}`)
      saved = true
    } catch (error) {
      const message = error instanceof Error ? error.message : '请检查网络连接'
      setCloudTransferErrors((current) => ({ ...current, [key]: message }))
      setNotice(`下载云端实体失败 · ${message}`)
    } finally {
      if (saved) clearCloudTransfer(key)
    }
  }

  const downloadCloudSceneToLocal = async (summary: CloudSceneSummary) => {
    const key = `download:scene:${summary.id}`
    clearCloudTransfer(key)
    let saved = false
    try {
      const result = await downloadCloudObject('scene', summary.id, summary.currentVersionId, setCloudTransferProgress)
      const sceneFile = JSON.parse(new TextDecoder().decode(result.bytes)) as MoceSceneFile
      const existing = library.scenes.find((scene) => scene.name === sceneFile.scene.name)
      let name = sceneFile.scene.name
      if (existing) {
        const choice = window.prompt(`本地已有场景“${existing.name}”\n请输入：覆盖 / 副本 / 取消`, '覆盖')?.trim()
        if (choice === '副本' || choice === 'copy' || choice === '2') {
          const names = new Set(library.scenes.map((scene) => scene.name))
          const base = name
          let index = 1
          while (names.has(name)) name = `${base} (${index++})`
        } else if (choice !== '覆盖' && choice !== 'replace' && choice !== '1') {
          setNotice('已取消下载云端场景')
          clearCloudTransfer(key)
          return
        }
      }
      sceneFile.scene.name = name
      await saveLocalScene(sceneFile)
      await refreshLibrary()
      setNotice(`已下载云端场景 · ${name}`)
      saved = true
    } catch (error) {
      const message = error instanceof Error ? error.message : '请检查网络连接'
      setCloudTransferErrors((current) => ({ ...current, [key]: message }))
      setNotice(`下载云端场景失败 · ${message}`)
    } finally {
      if (saved) clearCloudTransfer(key)
    }
  }

  const removeCloudAsset = async (asset: CloudAssetSummary) => {
    if (!window.confirm(`确定删除云端实体“${asset.name}”？本地实体不会受影响。`)) return
    try { await deleteCloudAsset(asset.id); await refreshCloudLibrary(); setNotice(`已删除云端实体 · ${asset.name}`) } catch (error) { setNotice(`删除云端实体失败 · ${error instanceof Error ? error.message : '请检查网络连接'}`) }
  }

  const removeCloudScene = async (scene: CloudSceneSummary) => {
    if (!window.confirm(`确定删除云端场景“${scene.name}”？本地场景不会受影响。`)) return
    try { await deleteCloudScene(scene.id); await refreshCloudLibrary(); setNotice(`已删除云端场景 · ${scene.name}`) } catch (error) { setNotice(`删除云端场景失败 · ${error instanceof Error ? error.message : '请检查网络连接'}`) }
  }

  const openLibrary = async () => {
    sceneLibraryAbortRef.current?.abort()
    sceneLibraryAbortRef.current = null
    setLibraryOpen(true)
    setSelectedLibrarySceneId(null)
    setSelectedLibrarySceneProject(null)
    setSelectedLibrarySceneLoading(false)
    setSelectedLibrarySceneRevision((revision) => revision + 1)
    setSceneLibraryContextMenu(null)
    await Promise.all([refreshLibrary(), refreshCloudLibrary()])
  }

  const applyStoredProject = async (loaded: ProjectState, fileRef: SceneFileRef | null, message: string) => {
    // A scene file contains only the embedded asset snapshots required to
    // rebuild that scene. Reload the local catalog at this boundary as well:
    // this makes switching scenes self-healing even if an older editor build
    // previously replaced the in-memory project assets with scene-only data.
    const localWorkspace = await initializeLocalLibrary(makeEmptyProject().assets)
    const embeddedIds = new Set(loaded.assets.map((asset) => asset.id))
    const withLocalTemplates = {
      ...loaded,
      assets: [...loaded.assets, ...localWorkspace.assets.filter((asset) => asset.isTemplate !== false && !embeddedIds.has(asset.id))],
    }
    const normalized = normalizeStoredProject(withLocalTemplates)
    replaceProject(normalized, false)
    setRecentMaterialIds(normalized.materials.slice(0, 8).map((material) => material.id))
    setSelectedId(sceneEntityParts(normalized)[0]?.id ?? '')
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
        await applyStoredProject(restoreProject(await loadLocalScene(sceneId)), { name: `${name}.moceworld`, libraryId: sceneId }, `已加载场景 · ${name}`)
        setLibraryOpen(false)
      } catch {
        setNotice('场景加载失败 · 数据库中不存在该场景')
      } finally {
        setLibraryBusy(false)
      }
    })
  }

  const selectLibraryScene = async (sceneId: string, name: string, x: number, y: number) => {
    const requestId = ++sceneLibraryLoadRequestRef.current
    setSelectedLibrarySceneRevision((revision) => revision + 1)
    sceneLibraryAbortRef.current?.abort()
    const abortController = new AbortController()
    sceneLibraryAbortRef.current = abortController
    setSelectedLibrarySceneId(sceneId)
    setSceneLibraryContextMenu({ sceneId, x, y })
    setSelectedLibrarySceneLoading(true)
    const cachedProject = sceneLibraryProjectCacheRef.current.get(sceneId)
    if (cachedProject) {
      setSelectedLibrarySceneProject(structuredClone(cachedProject))
      sceneLibraryAbortRef.current = null
      setSelectedLibrarySceneLoading(false)
      return
    }
    setSelectedLibrarySceneProject(null)
    try {
      const loaded = normalizeStoredProject(restoreProject(await loadLocalScene(sceneId)), { normalizeNaming: false })
      // A user can click several scene rows before a remote scene finishes
      // loading. Only the latest request is allowed to update the selected
      // scene preview; an older response must not replace it or clear it on
      // a late error.
      sceneLibraryProjectCacheRef.current.set(sceneId, structuredClone(loaded))
      if (requestId !== sceneLibraryLoadRequestRef.current) return
      setSelectedLibrarySceneProject(structuredClone(loaded))
    } catch (error) {
      if (abortController.signal.aborted) return
      if (requestId !== sceneLibraryLoadRequestRef.current) return
      setSelectedLibrarySceneProject(null)
      setNotice(`场景实体加载失败 · ${name}${error instanceof Error ? ` · ${error.message}` : ''}`)
    } finally {
      if (requestId === sceneLibraryLoadRequestRef.current) {
        sceneLibraryAbortRef.current = null
        setSelectedLibrarySceneLoading(false)
      }
    }
  }

  const requestSaveAssetToLibrary = (sourceAsset: VoxelAsset) => {
    const localAsset: VoxelAsset = {
      ...structuredClone(sourceAsset),
      id: `asset-library-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: sourceAsset.name?.trim() || '未命名实体',
      // Keep a durable scene-facing snapshot even when this source asset came
      // from the scene library or from an older template record. The dialog's
      // later rename only changes `name`, never this field.
      sceneName: sceneNameForAsset(sourceAsset),
      source: '场景库实体保存',
      isTemplate: true,
      templateSourceId: undefined,
    }
    setAssetCategorySave({ asset: localAsset })
  }

  const saveAssetToLibrary = async (requestedName: string, categoryPath: string[]) => {
    if (!assetCategorySave) return
    const name = uniqueTemplateAssetName(projectRef.current.assets, requestedName.trim() || assetCategorySave.asset.name || '未命名实体')
    const asset: VoxelAsset = {
      ...structuredClone(assetCategorySave.asset),
      name,
      // The dialog name belongs only to the asset-library namespace. Always
      // persist the authored scene name separately at the final write
      // boundary as well, so both inspector-save and scene-library-save use
      // the same invariant even for assembly templates.
      sceneName: sceneNameForAsset(assetCategorySave.asset),
      ...(assetCategorySave.asset.assembly ? {
        assembly: {
          ...assetCategorySave.asset.assembly,
          sceneName: sceneNameForAsset(assetCategorySave.asset),
        },
      } : {}),
      categoryPath: normalizeAssetCategoryPath(categoryPath),
      isTemplate: true,
    }
    try {
      // Confirm the durable remote write before presenting the asset as saved.
      // This prevents a refresh racing an unfinished R2/D1 request from
      // making a just-created template appear to have disappeared.
      const storedAsset = await saveLocalAsset(asset)
      updateProject((draft) => { draft.assets.push(storedAsset) })
    } catch (error) {
      setPersistenceStatus('offline')
      setNotice(`保存实体到资产库失败 · ${error instanceof Error ? error.message : '请检查线上连接'}`)
      return
    }
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

  const deleteLibrarySceneEntity = async (sceneId: string, entity: SceneLibraryEntity) => {
    const { name } = entity
    const sceneName = library.scenes.find((scene) => scene.id === sceneId)?.name ?? '当前场景'
    if (!window.confirm(`确定从场景“${sceneName}”删除实体“${name}”？该实体的场景实例也会被删除。`)) return
    try {
      const source = selectedLibrarySceneProject ?? normalizeStoredProject(restoreProject(await loadLocalScene(sceneId)))
      const removedMemberKeys = new Set(entity.memberKeys)
      const removedInstanceIds = new Set(entity.instanceIds)
      const removedAssemblyIds = new Set(entity.assemblyIds)
      const removedVoxelEntityIds = new Set(entity.memberKeys
        .filter((key) => key.startsWith('voxel:'))
        .map((key) => key.slice('voxel:'.length)))
      const next: ProjectState = {
        ...source,
        instances: source.instances.filter((instance) => !removedInstanceIds.has(instance.id)),
        customVoxels: source.customVoxels.filter((voxel) => !removedVoxelEntityIds.has(voxelEntityId(voxel))),
        customEntityOffsets: Object.fromEntries(Object.entries(source.customEntityOffsets ?? {}).filter(([entityId]) => !removedVoxelEntityIds.has(entityId))),
        customEntitySources: Object.fromEntries(Object.entries(source.customEntitySources ?? {}).filter(([entityId]) => !removedVoxelEntityIds.has(entityId))),
        assemblies: (source.assemblies ?? [])
          .filter((assembly) => !removedAssemblyIds.has(assembly.id))
          .map((assembly) => ({
            ...assembly,
            memberKeys: assembly.memberKeys.filter((memberKey) => {
              if (removedMemberKeys.has(memberKey)) return false
              if (memberKey.startsWith('assembly:')) return !removedAssemblyIds.has(memberKey.slice('assembly:'.length))
              if (memberKey.startsWith('asset:')) return ![...removedInstanceIds].some((instanceId) => memberKey.startsWith(`asset:${instanceId}:`))
              if (memberKey.startsWith('voxel:')) return !removedVoxelEntityIds.has(memberKey.slice('voxel:'.length))
              return true
            }),
          }))
          .filter((assembly) => assembly.memberKeys.length > 0),
      }
      const removedKeys = new Set([...removedMemberKeys, ...[...removedInstanceIds].map((instanceId) => `asset:${instanceId}`)])
      next.entityNames = Object.fromEntries(Object.entries(next.entityNames ?? {}).filter(([key]) => !removedKeys.has(key) && ![...removedInstanceIds].some((instanceId) => key.startsWith(`asset:${instanceId}:`))))
      next.entityNameModes = Object.fromEntries(Object.entries(next.entityNameModes ?? {}).filter(([key]) => next.entityNames?.[key]))
      next.entityNameSequences = Object.fromEntries(Object.entries(next.entityNameSequences ?? {}).filter(([key]) => next.entityNames?.[key]))
      next.entityNameParents = Object.fromEntries(Object.entries(next.entityNameParents ?? {}).filter(([key]) => next.entityNames?.[key]))
      await saveLocalScene(createSceneFile(next), sceneId)
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
    void Promise.all([nextAsset, ...detachedAssets].map((item) => saveLocalAsset(item))).catch(() => setPersistenceStatus('offline'))
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
    void saveLocalAsset(copy).catch(() => setPersistenceStatus('offline'))
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
    void Promise.all([nextAsset, ...detachedAssets].map((item) => saveLocalAsset(item))).catch(() => setPersistenceStatus('offline'))
    setAssetContextMenu(null)
    setNotice(`已更新模板实体颜色 · ${normalizedColor.toUpperCase()}`)
  }

  const deleteTemplateAsset = (assetId: string, localOnly = false) => {
    const asset = projectRef.current.assets.find((item) => item.id === assetId)
    if (!asset) return
    const usedByScene = projectRef.current.instances.some((instance) => instance.assetId === assetId)
    const confirmMessage = localOnly
      ? `仅会删除本地资产“${asset.name}”，云端副本不会被删除。确认要删除吗？`
      : usedByScene ? `模板“${asset.name}”仍被场景实例使用。删除资产库记录但保留场景实例？` : `确定删除模板“${asset.name}”？`
    if (!window.confirm(confirmMessage)) return
    if (usedByScene) {
      const nextAsset = { ...asset, isTemplate: false }
      updateProject((draft) => {
        const target = draft.assets.find((item) => item.id === assetId)
        if (target) target.isTemplate = false
      })
      void saveLocalAsset(nextAsset).catch(() => setPersistenceStatus('offline'))
      setNotice(`已从资产库移除 · 场景实例仍保留 · ${asset.name}`)
    } else {
      updateProject((draft) => { draft.assets = draft.assets.filter((item) => item.id !== assetId) })
      void deleteLocalAsset(assetId).catch(() => setPersistenceStatus('offline'))
      setNotice(`已删除模板实体 · ${asset.name}`)
    }
    setAssetContextMenu(null)
  }

  const persistAssetCategoryPaths = (paths: string[][]) => {
    const normalized = normalizeAssetCategoryPaths(paths, projectRef.current.assets)
    setAssetCategoryPaths(normalized)
    void saveLocalAssetCategories(normalized).catch(() => setPersistenceStatus('offline'))
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
        for (const asset of removedAssets) await deleteLocalAsset(asset.id)
        for (const asset of affectedAssets.filter((item) => usedIds.has(item.id))) await saveLocalAsset({ ...asset, isTemplate: false })
        await saveLocalAssetCategories(nextCategoryPaths)
      } catch {
        setPersistenceStatus('offline')
      }
    })()
    setAssetCategoryContextMenu(null)
    setAssetContextMenu(null)
    setNotice(`已删除类别 · ${categoryPath.join(' / ')} · ${affectedAssets.length} 个模板实体`)
  }

  const duplicateStoredScene = async (sceneId: string, name: string) => {
    const requestedName = window.prompt('副本名称', `${name}·副本`)
    if (!requestedName?.trim()) return
    try {
      await duplicateLocalScene(sceneId, requestedName.trim())
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
      await deleteLocalScene(sceneId)
      if (sceneFileRef?.libraryId === sceneId) setSceneFileRef(null)
      setLibrary((current) => ({ ...current, scenes: current.scenes.filter((scene) => scene.id !== sceneId) }))
      if (selectedLibrarySceneId === sceneId) {
        setSelectedLibrarySceneId(null)
        setSelectedLibrarySceneProject(null)
        setSceneLibraryContextMenu(null)
      }
      await refreshLibrary()
      setNotice(`已删除场景 · ${name}`)
    } catch {
      setNotice('场景删除失败 · 请检查后端服务')
    }
    setSceneLibraryContextMenu(null)
  }

  const makeAssemblyTemplateAsset = (sourceProject: ProjectState, sourceParts: SceneEntityPart[], rootAssemblyId: string): VoxelAsset | null => {
    const rootName = sourceProject.assemblies?.find((assembly) => assembly.id === rootAssemblyId)?.name?.trim() || '装配体'
    return makeAssemblyAssetFromSceneParts(
      `asset-assembly-${Date.now()}`,
      rootName,
      sourceProject,
      sourceParts,
      rootAssemblyId,
      selectedAsset?.color ?? '#6c827d',
      selectedAsset?.accent ?? '#d2a354',
      '装配体模板保存',
    )
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
      sceneOffset: undefined,
      voxels: scenePartVoxels(part).map((voxel) => ({
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
      createdAssets.forEach((asset) => { void saveLocalAsset(asset).catch(() => setPersistenceStatus('offline')) })
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
    const sourceVoxels = sourceParts.flatMap((part) => scenePartVoxels(part))
    if (!sourceVoxels.length) return null
    const sourceBounds = voxelBounds(sourceVoxels)!
    const minX = sourceBounds.min.x
    const minY = sourceBounds.min.y
    const minZ = sourceBounds.min.z
    const maxX = sourceBounds.max.x
    const maxY = sourceBounds.max.y
    const maxZ = sourceBounds.max.z
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
    const previewBounds = voxelBounds(previewAsset.voxels)!
    const previewMinX = previewBounds.min.x
    const previewMinY = previewBounds.min.y
    const previewMinZ = previewBounds.min.z
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
    if (geometryApplyingRef.current) return
    const sourceProject = projectRef.current
    if (!selectedEntityParts.length) {
      setNotice('请先选择要复制的实体')
      return
    }
    const count = Math.max(1, Math.min(99, Math.round(requestedCount) || 1))
    setTransformPreview(null)
    cancelGeometryPreview()
    // Preview is read-only. Cloning every selected voxel part here made the
    // first click scale with the entire selected model before any copy existed.
    const preview = createCopyPreview(sourceProject, selectedEntityParts, count, 1, 'x', 1)
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
    const nextInstances = [...sourceProject.instances]
    const nextCustomVoxels = [...sourceProject.customVoxels]
    const nextCustomColors = { ...(sourceProject.customColors ?? {}) }
    const nextCustomVoxelRenderModes = { ...(sourceProject.customVoxelRenderModes ?? {}) }
    const nextCustomEntitySources = { ...(sourceProject.customEntitySources ?? {}) }
    const nextAssemblies = [...(sourceProject.assemblies ?? [])]
    let nextAssemblySequence = sourceProject.assemblySequence ?? 1
    const createdInstanceIds = new Set<string>()
    const createdCustomIds = new Set<string>()
    const translateWorld = (value: number, delta: number) => Number((value + voxelToWorld(delta)).toFixed(3))
    // Build a structurally shared project. The generic updateProject path
    // cloned every asset and voxel before appending copies, so confirming a
    // large copy stalled even though only the selected owners changed.
    for (let copyIndex = 0; copyIndex < currentPreview.count; copyIndex += 1) {
      const offset = currentPreview.offsets[copyIndex]
      const instanceMap = new Map<string, string>()
      const customMap = new Map<string, string>()
      const clonedInstanceIds: string[] = []
        currentPreview.sourceInstanceIds.forEach((oldId) => {
          const current = sourceProject.instances.find((instance) => instance.id === oldId)
          if (!current) return
          const newId = `${oldId}-copy-${copyBatchId}-${copyIndex + 1}`
          instanceMap.set(oldId, newId); clonedInstanceIds.push(newId)
          createdInstanceIds.add(newId)
          const clonedInstance: SceneInstance = {
            ...current,
            id: newId,
            overrides: (current.overrides ?? []).map((override) => ({ ...override })),
            partOffsets: Object.fromEntries(Object.entries(current.partOffsets ?? {}).map(([partId, partOffset]) => [partId, { ...partOffset }])),
            mirror: current.mirror ? { ...current.mirror } : undefined,
          }
          // Horizontal copies must preserve the source elevation exactly. Only
          // a user-selected editor Z offset is allowed to change instance.y.
          clonedInstance.x = translateWorld(current.x, offset.x)
          clonedInstance.z = translateWorld(current.z, offset.z)
          if (offset.y !== 0) clonedInstance.y = translateWorld(current.y ?? 0, offset.y)
          nextInstances.push(clonedInstance)
        })
        currentPreview.sourceCustomIds.forEach((oldId) => {
          const newId = `${oldId}-copy-${copyBatchId}-${copyIndex + 1}`
          customMap.set(oldId, newId)
          createdCustomIds.add(newId)
          const sourcePart = sourceParts.find((part) => part.kind === 'custom' && part.partId === oldId)
          scenePartVoxels(sourcePart ?? { id: `custom:${oldId}`, kind: 'custom', partId: oldId, memberKey: `voxel:${oldId}`, voxels: sourceProject.customVoxels.filter((voxel) => voxelEntityId(voxel) === oldId) })
            .forEach((voxel) => nextCustomVoxels.push({ ...voxel, x: voxel.x + offset.x, y: voxel.y + offset.y, z: voxel.z + offset.z, entityId: newId }))
          if (sourceProject.customColors?.[oldId]) nextCustomColors[newId] = sourceProject.customColors[oldId]
          const renderMode = sourceProject.customVoxelRenderModes?.[oldId]
          if (renderMode) nextCustomVoxelRenderModes[newId] = renderMode
          const source = sourceProject.customEntitySources?.[oldId]
          if (source) nextCustomEntitySources[newId] = { ...source, categoryPath: source.categoryPath ? [...source.categoryPath] : undefined }
        })
        const assemblyMapForCopy = new Map<string, string>(); [...assemblyTreeIds].forEach((oldId) => assemblyMapForCopy.set(oldId, `assembly-${copyBatchId}-${copyIndex + 1}-${oldId}`))
        const mapLeafKey = (memberKey: string) => { for (const [oldId, newId] of instanceMap) if (memberKey === `asset:${oldId}` || memberKey.startsWith(`asset:${oldId}:`)) return memberKey.replace(`asset:${oldId}`, `asset:${newId}`); for (const [oldId, newId] of customMap) if (memberKey === `voxel:${oldId}`) return `voxel:${newId}`; return memberKey }
        const mapMemberKey = (memberKey: string) => memberKey.startsWith('assembly:') ? `assembly:${assemblyMapForCopy.get(memberKey.slice('assembly:'.length)) ?? memberKey.slice('assembly:'.length)}` : mapLeafKey(memberKey)
        ;[...assemblyTreeIds].forEach((oldId) => { const sourceAssembly = assemblyMap.get(oldId); if (!sourceAssembly) return; const number = Math.max(1, nextAssemblySequence++); nextAssemblies.push({ ...sourceAssembly, id: assemblyMapForCopy.get(oldId)!, nameMode: 'auto', sequence: undefined, parentAssemblyId: undefined, name: `装配体 ${number}`, memberKeys: sourceAssembly.memberKeys.map(mapMemberKey) }) })
        if (!firstSelection) firstSelection = rootAssemblyIds[0] ? `assembly:${assemblyMapForCopy.get(rootAssemblyIds[0])}` : clonedInstanceIds[0] ? clonedInstanceIds[0] : currentPreview.sourceCustomIds[0] ? `custom:${customMap.get(currentPreview.sourceCustomIds[0])}` : ''
    }
    const unnormalizedNext: ProjectState = { ...sourceProject, instances: nextInstances, customVoxels: nextCustomVoxels, customColors: nextCustomColors, customVoxelRenderModes: nextCustomVoxelRenderModes, customEntitySources: nextCustomEntitySources, assemblies: nextAssemblies, assemblySequence: nextAssemblySequence }
    const normalizedNext = normalizeProjectNaming(normalizeStoredProject(unnormalizedNext, { normalizeNaming: false }), { clone: false })
    const newOwnerIds = new Set<string>([...createdCustomIds].map((entityId) => `custom:${entityId}`))
    sceneEntityParts(normalizedNext).filter((part) => part.instanceId && createdInstanceIds.has(part.instanceId)).forEach((part) => newOwnerIds.add(part.id))
    recordHistoryBeforeChange(sourceProject, normalizedNext)
    sceneOccupancyRef.current?.syncOwnerParts(sceneEntityParts(normalizedNext), newOwnerIds)
    skipSceneOccupancySyncRef.current = true
    const publishEpoch = ++historyEpochRef.current
    projectRef.current = normalizedNext
    markSceneDirty()
    startTransition(() => {
      if (historyEpochRef.current !== publishEpoch) return
      setProject(normalizedNext)
      setHistoryRevision((value) => value + 1)
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
      if (draft.customVoxelRenderModes) draft.customVoxelRenderModes = Object.fromEntries(Object.entries(draft.customVoxelRenderModes).filter(([entityId]) => !removedCustomIds.has(entityId)))
      if (draft.customEntityOffsets) {
        draft.customEntityOffsets = Object.fromEntries(Object.entries(draft.customEntityOffsets).filter(([entityId]) => !removedCustomIds.has(entityId)))
      }
      if (draft.customEntitySources) {
        draft.customEntitySources = Object.fromEntries(Object.entries(draft.customEntitySources).filter(([entityId]) => !removedCustomIds.has(entityId)))
      }
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

  const validateGeometryResult = (candidate: VoxelGeometryPreview): { valid: boolean; reason?: string } => {
    if (!candidate.voxels.length) return { valid: false, reason: '结果为空，无法应用' }
    if (!sceneVoxelsWithinBounds(candidate.voxels, sceneBoundsForProject(projectRef.current))) return { valid: false, reason: '结果超出场景边界' }
    if (sceneOccupancyRef.current?.collidesProjectVoxels(candidate.voxels, selectedEntityParts.map((part) => part.id))) return { valid: false, reason: '结果与未选中实体碰撞' }
    if (selectedContainsLockedEntity()) return { valid: false, reason: '选中实体中包含已固定实体' }
    return { valid: true }
  }

  const requestGeometryPreview = (operation: GeometryOperation, shellThickness: number, scaleMode: GeometryScaleMode, scaleFactor: number) => {
    if (!selectedEntityParts.length) { setNotice('请先选择要处理的实体'); return }
    if (selectedContainsLockedEntity()) { setNotice('选中的实体中包含已固定实体 · 请先取消固定'); return }
    setCopyPreview(null)
    setTransformPreview(null)
    const sourceVoxels = currentGeometrySourceVoxels()
    const requestRevision = ++geometryRequestRevisionRef.current
    setGeometryPreview({ operation, shellThickness, scaleMode, scaleFactor, result: null, valid: false, invalidReason: '正在生成预览…' })
    const client = geometryWorkerRef.current
    const task = operation === 'shell'
      ? client?.computeGeometryLatest({ kind: 'shell', voxels: sourceVoxels, thickness: shellThickness }) ?? Promise.resolve<VoxelToolsGeometryResult>({ geometry: computeShell(sourceVoxels, shellThickness), mesh: null })
      : client?.computeGeometryLatest({ kind: 'scale', voxels: sourceVoxels, mode: scaleMode, factor: scaleFactor }) ?? Promise.resolve<VoxelToolsGeometryResult>({ geometry: computeScale(sourceVoxels, scaleMode, scaleFactor), mesh: null })
    void task.then((payload) => {
      if (!payload) return
      const candidate = payload.geometry
      if (requestRevision !== geometryRequestRevisionRef.current) return
      const validation = validateGeometryResult(candidate)
      setGeometryPreview({ operation, shellThickness, scaleMode, scaleFactor, result: candidate, mesh: payload.mesh, valid: validation.valid && candidate.valid, invalidReason: validation.reason ?? candidate.warnings[0] })
    }).catch((error) => {
      if (requestRevision !== geometryRequestRevisionRef.current) return
      setGeometryPreview({ operation, shellThickness, scaleMode, scaleFactor, result: null, valid: false, invalidReason: error instanceof Error ? error.message : '预览生成失败' })
    })
  }

  const startShellPreview = () => {
    const thickness = geometryShellThicknessOptions[0] ?? 1
    requestGeometryPreview('shell', thickness, 'up', 2)
  }
  const startScalePreview = (mode: GeometryScaleMode) => {
    const factor = geometryScaleOptions[mode][0]
    if (!factor) { setNotice(mode === 'down' ? '当前实体没有满足整除条件的缩小倍率' : '当前实体无法生成放大预览'); return }
    requestGeometryPreview('scale', 1, mode, factor)
  }

  const changeGeometryShellThickness = (thickness: number) => {
    if (!geometryPreview || geometryPreview.operation !== 'shell') return
    requestGeometryPreview('shell', thickness, geometryPreview.scaleMode, geometryPreview.scaleFactor)
  }
  const changeGeometryScale = (mode: GeometryScaleMode, factor: number) => {
    if (!geometryPreview || geometryPreview.operation !== 'scale') return
    requestGeometryPreview('scale', geometryPreview.shellThickness, mode, factor)
  }

  const confirmGeometryPreview = () => {
    if (geometryApplyingRef.current) return
    if (!geometryPreview?.result || !geometryPreview.valid) { setNotice(geometryPreview?.invalidReason ?? '当前几何预览不可应用'); return }
    const sourceProject = projectRef.current
    const selectedIds = new Set(selectedEntityParts.map((part) => part.id))
    const selectedCustomIds = new Set(selectedEntityParts.filter((part) => part.kind === 'custom').map((part) => part.partId))
    const selectedInstanceIds = new Set(selectedEntityParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))
    const allInstancePartCounts = new Map<string, number>()
    const selectedInstancePartCounts = new Map<string, number>()
    sceneParts.forEach((part) => {
      if (!part.instanceId || !selectedInstanceIds.has(part.instanceId)) return
      allInstancePartCounts.set(part.instanceId, (allInstancePartCounts.get(part.instanceId) ?? 0) + 1)
      if (selectedIds.has(part.id)) selectedInstancePartCounts.set(part.instanceId, (selectedInstancePartCounts.get(part.instanceId) ?? 0) + 1)
    })
    for (const instanceId of selectedInstanceIds) {
      if ((selectedInstancePartCounts.get(instanceId) ?? 0) < (allInstancePartCounts.get(instanceId) ?? 0)) {
        setNotice('请先选中完整资产实体，再进行整体几何处理')
        return
      }
    }
    const operationBatchId = `voxel-geometry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const firstSourcePartId = selectedEntityParts[0]?.id ?? ''
    const sourcePartById = new Map(selectedEntityParts.map((part) => [part.id, part]))
    const singleCustomEntityId = selectedCustomIds.size === 1 && selectedInstanceIds.size === 0 && selectedEntityParts.length === 1
      ? [...selectedCustomIds][0]
      : undefined
    let groupEntries: Array<{ sourcePartId: string; entityId: string; sourcePart?: SceneEntityPart; voxels: Voxel[] }>
    let transformed: Voxel[]
    if (singleCustomEntityId) {
      // The common large-model case has one custom entity. Do not build a
      // per-source grouping map and then flatten it again: the worker result
      // is already one contiguous batch, so a single pass is sufficient.
      // computeScale preserves entityId/source ownership for a single custom
      // entity. The Worker result is already validated before this handler,
      // so do not scan every generated voxel again just to prove the invariant
      // we established at request time. That extra O(n) pass was noticeable
      // when confirming a large scale-up operation.
      const canReuseScaleResult = geometryPreview.operation === 'scale'
      const voxels = canReuseScaleResult
        ? geometryPreview.result.voxels as Voxel[]
        : new Array<Voxel>(geometryPreview.result.voxels.length)
      if (!canReuseScaleResult) for (let index = 0; index < geometryPreview.result.voxels.length; index += 1) {
        // The Worker result is detached from the preview as soon as this
        // transaction is committed. Reuse each object in place instead of
        // allocating a second object for every generated cell.
        const voxel = geometryPreview.result.voxels[index]
        voxel.entityId = singleCustomEntityId
        delete voxel.sourcePartId
        voxels[index] = voxel
      }
      groupEntries = [{ sourcePartId: firstSourcePartId, entityId: singleCustomEntityId, sourcePart: selectedEntityParts[0], voxels }]
      transformed = voxels
    } else {
      const resultGroups = new Map<string, GeometryVoxel[]>()
      geometryPreview.result.voxels.forEach((voxel) => {
        const sourcePartId = voxel.sourcePartId && selectedIds.has(voxel.sourcePartId) ? voxel.sourcePartId : firstSourcePartId
        const group = resultGroups.get(sourcePartId)
        if (group) group.push(voxel)
        else resultGroups.set(sourcePartId, [voxel])
      })
      transformed = []
      groupEntries = [...resultGroups.entries()].filter(([, voxels]) => voxels.length > 0).map(([sourcePartId, voxels], index) => {
        const sourcePart = sourcePartById.get(sourcePartId)
        const entityId = `${operationBatchId}-${index + 1}`
        const transformedVoxels = voxels.map((voxel) => {
          voxel.entityId = entityId
          delete voxel.sourcePartId
          return voxel
        })
        transformed.push(...transformedVoxels)
        return { sourcePartId, entityId, sourcePart, voxels: transformedVoxels }
      })
    }
    const transformedGroups = groupEntries.map(({ entityId, voxels }) => ({ entityId, voxels }))
    if (geometryPreview.result.bounds && transformed.length) {
      // The geometry Worker already computed the result bounds. Seed the
      // render-origin cache so the first post-confirm scene build does not
      // scan the entire enlarged array a second time just to find its minimum
      // coordinate.
      voxelRenderOriginCache.set(transformed, {
        x: geometryPreview.result.bounds.minX,
        y: geometryPreview.result.bounds.minY,
        z: geometryPreview.result.bounds.minZ,
      })
    }
    // A single custom entity is the only geometry-operation path where the
    // Worker mesh and the committed voxel result have exactly the same owner
    // and coordinates. Keep that mesh for the next render pass so confirming
    // a large shell/reduction operation does not immediately rebuild the same
    // greedy surface on the main thread/mesh worker a second time.
    if (singleCustomEntityId && geometryPreview.mesh && transformed.length === geometryPreview.result.voxelCount) {
      pendingGeometryMeshCache.set(singleCustomEntityId, {
        mesh: geometryPreview.mesh,
        voxelCount: transformed.length,
      })
    }
    const selectedReplacementKeys = new Map<string, string[]>()
    groupEntries.forEach(({ sourcePartId, entityId, sourcePart }) => {
      if (!sourcePart) return
      const replacementKey = `voxel:${entityId}`
      selectedReplacementKeys.set(sourcePart.memberKey, [...(selectedReplacementKeys.get(sourcePart.memberKey) ?? []), replacementKey])
      if (sourcePart.instanceId) selectedReplacementKeys.set(`asset:${sourcePart.instanceId}`, [...(selectedReplacementKeys.get(`asset:${sourcePart.instanceId}`) ?? []), replacementKey])
    })
    const selectedResultEntityIds = groupEntries.map(({ entityId }) => entityId)
    const firstResultEntityId = selectedResultEntityIds[0]
    const remainingCustomVoxels = sourceProject.customVoxels.filter((voxel) => !selectedCustomIds.has(voxelEntityId(voxel)))
    const nextCustomColors = { ...(sourceProject.customColors ?? {}) }
    const nextCustomVoxelRenderModes = { ...(sourceProject.customVoxelRenderModes ?? {}) }
    const nextCustomEntitySources = { ...(sourceProject.customEntitySources ?? {}) }
    selectedCustomIds.forEach((entityId) => { delete nextCustomColors[entityId] })
    selectedCustomIds.forEach((entityId) => { delete nextCustomVoxelRenderModes[entityId] })
    selectedCustomIds.forEach((entityId) => { delete nextCustomEntitySources[entityId] })
    const preservedCustomColor = selectedCustomIds.size === 1 && firstResultEntityId === [...selectedCustomIds][0]
      ? sourceProject.customColors?.[[...selectedCustomIds][0]]
      : undefined
    if (preservedCustomColor && firstResultEntityId) nextCustomColors[firstResultEntityId] = preservedCustomColor
    groupEntries.forEach(({ entityId, sourcePart }) => {
      const sourceEntityId = sourcePart?.partId
      const source = sourceEntityId ? sourceProject.customEntitySources?.[sourceEntityId] : undefined
      if (source) nextCustomEntitySources[entityId] = { ...source, categoryPath: source.categoryPath ? [...source.categoryPath] : undefined }
    })
    const nextProject: ProjectState = {
      ...sourceProject,
      // Geometry result data is already normalized by the worker. Reuse all
      // unrelated catalogs and instance objects instead of cloning the whole
      // project before the history/React commit.
      instances: sourceProject.instances.filter((instance) => !selectedInstanceIds.has(instance.id)),
      customVoxels: [...remainingCustomVoxels, ...transformed],
      customVoxelRenderModes: nextCustomVoxelRenderModes,
      customColors: nextCustomColors,
      customEntitySources: nextCustomEntitySources,
      customEntityOffsets: Object.fromEntries(Object.entries(sourceProject.customEntityOffsets ?? {}).filter(([entityId]) => !selectedCustomIds.has(entityId))),
      assemblies: (sourceProject.assemblies ?? []).map((assembly) => {
        const memberKeys = assembly.memberKeys.flatMap((memberKey) => selectedReplacementKeys.get(memberKey) ?? [memberKey])
        return { ...assembly, memberKeys: [...new Set(memberKeys)] }
      }).filter((assembly) => assembly.memberKeys.length >= 2),
    }
    // A single custom entity keeps its stable entity id and tree membership;
    // running the full naming pass here would rescan the entire enlarged voxel
    // array even though no name or parent can change. Multi-part and asset
    // replacements still use the complete naming normalization path.
    const namedNextProject = singleCustomEntityId
      ? nextProject
      : normalizeProjectNaming(nextProject, { clone: false })
    if (geometryPreview.operation === 'scale' && geometryPreview.scaleMode === 'up') {
      const renderModes = { ...(namedNextProject.customVoxelRenderModes ?? {}) }
      selectedResultEntityIds.forEach((entityId) => { renderModes[entityId] = 'cells' })
      namedNextProject.customVoxelRenderModes = renderModes
    }
    const applyRevision = geometryApplyRevisionRef.current + 1
    geometryApplyRevisionRef.current = applyRevision
    geometryApplyingRef.current = true
    setGeometryApplying(true)
    const completionNotice = `已应用${geometryPreview.operation === 'shell' ? '外壳' : geometryPreview.scaleMode === 'up' ? '放大' : '缩小'}处理 · ${transformed.length} 个体素 · ${groupEntries.length} 个零件`
    setNotice('正在应用几何处理…')
    const applyTask = commitGeometryProject(namedNextProject, [...selectedIds], transformedGroups)
    setSelectedId(firstResultEntityId ? `custom:${firstResultEntityId}` : '')
    setCheckedTreePartIds(firstResultEntityId ? [`custom:${firstResultEntityId}`] : [])
    setEditEntityId(null)
    setGeometryPreview(null)
    void applyTask.then(() => {
      if (geometryApplyRevisionRef.current !== applyRevision) return
      geometryApplyingRef.current = false
      setGeometryApplying(false)
      setNotice(completionNotice)
    }).catch((error) => {
      if (geometryApplyRevisionRef.current !== applyRevision) return
      geometryApplyingRef.current = false
      setGeometryApplying(false)
      setNotice(error instanceof Error ? `几何处理应用失败：${error.message}` : '几何处理应用失败')
    })
  }

  const selectedColor = scenePartsDisplayColor(project, selectedEntityParts, selectedAsset)
  const previewColorSignature = useMemo(() => {
    const base = selectedEntityParts[0]
      ? {
          x: (selectedEntityParts[0].sceneOffset?.x ?? 0) + (selectedEntityParts[0].partSceneOffset?.x ?? 0),
          y: (selectedEntityParts[0].sceneOffset?.y ?? 0) + (selectedEntityParts[0].partSceneOffset?.y ?? 0),
          z: (selectedEntityParts[0].sceneOffset?.z ?? 0) + (selectedEntityParts[0].partSceneOffset?.z ?? 0),
        }
      : { x: 0, y: 0, z: 0 }
    const materialSignature = project.materials.map((material) => `${material.id}:${material.color}`).join(';')
    const partSignature = selectedEntityParts.map((part) => {
      const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
      const asset = instance ? project.assets.find((item) => item.id === instance.assetId) : undefined
      const offset = {
        x: (part.sceneOffset?.x ?? 0) + (part.partSceneOffset?.x ?? 0) - base.x,
        y: (part.sceneOffset?.y ?? 0) + (part.partSceneOffset?.y ?? 0) - base.y,
        z: (part.sceneOffset?.z ?? 0) + (part.partSceneOffset?.z ?? 0) - base.z,
      }
      return [
        part.id,
        previewVoxelArrayId(part.voxels),
        part.voxels.length,
        offset.x,
        offset.y,
        offset.z,
        part.colorOverride ?? '',
        part.kind === 'custom' ? project.customColors?.[part.partId] ?? '' : '',
        instance?.colorOverride ?? '',
        instance?.overrides?.length ?? 0,
        asset?.id ?? '',
        asset?.templateColor ?? '',
        asset?.color ?? '',
        asset?.accent ?? '',
      ].join(':')
    }).join('|')
    return `${materialSignature}|${partSignature}`
  }, [project.assets, project.customColors, project.instances, project.materials, selectedEntityParts])
  const previewVoxelColors = useMemo(() => {
    // A single selected entity already carries its color/material fallback in
    // the preview props. Building a coordinate -> color entry for every voxel
    // here was an avoidable O(n) pass on every selection. Keep this map only
    // for multi-entity previews, where source assets need independent colors.
    // Keep the empty map referentially stable. A transform-only project
    // update must not make the large single-entity thumbnail render again;
    // changing this object used to defeat VoxelMiniPreview's React.memo and
    // rerun the full face/occupancy pass on every move release.
    if (selectedEntityParts.length <= 1) return EMPTY_PREVIEW_COLORS
    const colors: Record<string, string> = {}
    const base = selectedEntityParts[0]
      ? {
          x: (selectedEntityParts[0].sceneOffset?.x ?? 0) + (selectedEntityParts[0].partSceneOffset?.x ?? 0),
          y: (selectedEntityParts[0].sceneOffset?.y ?? 0) + (selectedEntityParts[0].partSceneOffset?.y ?? 0),
          z: (selectedEntityParts[0].sceneOffset?.z ?? 0) + (selectedEntityParts[0].partSceneOffset?.z ?? 0),
        }
      : { x: 0, y: 0, z: 0 }
    selectedEntityParts.forEach((part) => {
      const instance = part.instanceId ? project.instances.find((item) => item.id === part.instanceId) : undefined
      const asset = instance ? project.assets.find((item) => item.id === instance.assetId) : undefined
      const offset = {
        x: (part.sceneOffset?.x ?? 0) + (part.partSceneOffset?.x ?? 0) - base.x,
        y: (part.sceneOffset?.y ?? 0) + (part.partSceneOffset?.y ?? 0) - base.y,
        z: (part.sceneOffset?.z ?? 0) + (part.partSceneOffset?.z ?? 0) - base.z,
      }
      // Match buildAssetGroup's precedence: an instance override, template
      // color, or custom-entity color is applied to every voxel, including
      // voxels whose materialId is ivory/gold/etc. Only an ordinary asset with
      // no whole-entity color uses its material colors below.
      const wholeEntityColor = part.colorOverride ?? asset?.templateColor ?? (part.kind === 'custom' ? project.customColors?.[part.partId] : undefined)
      const primaryColor = wholeEntityColor ?? asset?.color
      part.voxels.forEach((voxel) => {
        const previewVoxel = offset.x || offset.y || offset.z
          ? { ...voxel, x: voxel.x + offset.x, y: voxel.y + offset.y, z: voxel.z + offset.z }
          : voxel
        const key = `${previewVoxel.x},${previewVoxel.y},${previewVoxel.z}`
        const paintedColor = previewVoxel.paintMaterialId
          ? materialColorForVoxel(project, { ...previewVoxel, materialId: previewVoxel.paintMaterialId }, asset)
          : undefined
        if (paintedColor) colors[key] = paintedColor
        else if (wholeEntityColor) colors[key] = wholeEntityColor
        else if (voxel.materialId === 'primary' && primaryColor) colors[key] = primaryColor
        else if (voxel.materialId === 'accent') colors[key] = asset?.accent ?? '#d2a354'
        else if (voxel.materialId.startsWith('#')) colors[key] = voxel.materialId
        else colors[key] = materialColorForVoxel(project, voxel, asset)
      })
    })
    return colors
  }, [previewColorSignature])
  const previewMaterialColors = useMemo(() => Object.fromEntries(project.materials.map((material) => [material.id, material.color])), [project.materials])
  const changeSelectedColor = (color: string) => {
    cancelColorPreview()
    if (!selectedEntityParts.length) return
    const instanceIds = new Set(selectedEntityParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))
    const customIds = new Set(selectedEntityParts.filter((part) => part.kind === 'custom').map((part) => part.partId))
    updateProject((draft) => {
      draft.instances.forEach((instance) => {
        if (!instanceIds.has(instance.id)) return
        instance.colorOverride = color
        // A direct palette choice means "make the whole entity this color".
        // Remove any per-voxel paint overrides left by the HSL sliders first.
        instance.overrides = (instance.overrides ?? []).filter((override) => override.mode !== 'paint').map((override) => {
          const { paintMaterialId: _paintMaterialId, ...withoutPaint } = override
          return withoutPaint
        })
      })
      draft.customColors = { ...(draft.customColors ?? {}) }
      customIds.forEach((entityId) => { draft.customColors![entityId] = color })
      if (customIds.size) {
        draft.customVoxels = draft.customVoxels.map((voxel) => {
          if (!customIds.has(voxelEntityId(voxel))) return voxel
          const { paintMaterialId: _paintMaterialId, ...withoutPaint } = voxel
          return withoutPaint
        })
      }
    })
    setNotice(`已更新选中实体颜色 · ${color.toUpperCase()}`)
  }

  const previewSelectedHsl = (hueDelta: number, saturationTarget: number) => {
    if (!selectedEntityParts.length) return
    colorPreviewPendingRef.current = { partIds: selectedEntityParts.map((part) => part.id), hueDelta, saturationTarget }
    if (colorPreviewFrameRef.current !== null) return
    colorPreviewFrameRef.current = window.requestAnimationFrame(() => {
      colorPreviewFrameRef.current = null
      const next = colorPreviewPendingRef.current
      colorPreviewPendingRef.current = null
      if (next) setColorPreview(next)
    })
  }

  const commitSelectedHsl = (hueDelta: number, saturationTarget: number) => {
    if (geometryApplyingRef.current) return
    cancelColorPreview()
    if (!selectedEntityParts.length) return
    const sourceProject = projectRef.current
    const selectedPartsById = new Map(selectedEntityParts.map((part) => [part.id, part]))
    const selectedPartsByInstance = new Map<string, SceneEntityPart[]>()
    selectedEntityParts.forEach((part) => {
      if (!part.instanceId) return
      selectedPartsByInstance.set(part.instanceId, [...(selectedPartsByInstance.get(part.instanceId) ?? []), part])
    })
    const selectedCustomParts = new Map(selectedEntityParts.filter((part) => part.kind === 'custom').map((part) => [part.partId, part]))

    const sourceAssetById = new Map(sourceProject.assets.map((asset) => [asset.id, asset]))
    const nextInstances = sourceProject.instances.map((sourceInstance) => {
      const parts = selectedPartsByInstance.get(sourceInstance.id)
      if (!parts?.length) return sourceInstance
      const sourceAsset = sourceAssetById.get(sourceInstance.assetId)
      if (!sourceAsset) return sourceInstance
      const overrides = (sourceInstance.overrides ?? []).map((override) => ({ ...override }))
      const overrideIndex = new Map<string, number>()
      overrides.forEach((override, index) => overrideIndex.set(sceneVoxelKey(override), index))
      const localBySceneKey = new Map<string, Voxel>()
      instanceVoxelPairs(sourceInstance, sourceAsset).forEach(({ scene, local }) => localBySceneKey.set(sceneVoxelKey(scene), local))
      const upsertPaint = (localVoxel: Voxel, color: string) => {
        const key = sceneVoxelKey(localVoxel)
        const index = overrideIndex.get(key)
        if (index === undefined) {
          overrides.push({ ...localVoxel, materialId: color, mode: 'paint' })
          overrideIndex.set(key, overrides.length - 1)
          return
        }
        const existing = overrides[index]
        overrides[index] = existing.mode === 'add' || !existing.mode
          ? { ...existing, paintMaterialId: color }
          : { ...existing, materialId: color, mode: 'paint' }
      }
      parts.forEach((part) => scenePartVoxels(part).forEach((voxel) => {
        const localVoxel = localBySceneKey.get(sceneVoxelKey(voxel))
        if (!localVoxel) return
        upsertPaint(localVoxel, adjustHexHsl(scenePartVoxelDisplayColor(sourceProject, part, voxel), hueDelta, saturationTarget))
      }))
      const nextInstance: SceneInstance = { ...sourceInstance, overrides }
      // Whole-entity overrides also need to move so future unpainted voxels
      // follow the same adjustment. Editing one sub-part must not recolor
      // siblings in a multi-part asset.
      const allInstanceParts = sceneParts.filter((part) => part.instanceId === sourceInstance.id)
      const coversInstance = allInstanceParts.length > 0 && allInstanceParts.every((part) => selectedPartsById.has(part.id))
      if (coversInstance) {
        const baseColor = sourceInstance.colorOverride ?? sourceAsset.templateColor
        if (baseColor) nextInstance.colorOverride = adjustHexHsl(baseColor, hueDelta, saturationTarget)
      }
      return nextInstance
    })

    const selectedCustomVoxelByKey = new Map<string, { part: SceneEntityPart; voxel: Voxel }>()
    selectedCustomParts.forEach((part) => scenePartVoxels(part).forEach((voxel) => {
      selectedCustomVoxelByKey.set(`${part.partId}:${sceneVoxelKey(voxel)}`, { part, voxel })
    }))
    const sourceOffsets = sourceProject.customEntityOffsets ?? {}
    const nextCustomVoxels = selectedCustomParts.size
      ? sourceProject.customVoxels.map((voxel) => {
        const entityId = voxelEntityId(voxel)
        const offset = sourceOffsets[entityId] ?? { x: 0, y: 0, z: 0 }
        const sceneKey = sceneVoxelKey({ x: voxel.x + offset.x, y: voxel.y + offset.y, z: voxel.z + offset.z })
        const match = selectedCustomVoxelByKey.get(`${entityId}:${sceneKey}`)
        if (!match) return voxel
        return { ...voxel, paintMaterialId: adjustHexHsl(scenePartVoxelDisplayColor(sourceProject, match.part, match.voxel), hueDelta, saturationTarget) }
      })
      : sourceProject.customVoxels
    const nextCustomColors = { ...(sourceProject.customColors ?? {}) }
    selectedCustomParts.forEach((part, entityId) => {
      const baseColor = sourceProject.customColors?.[entityId]
      if (baseColor) nextCustomColors[entityId] = adjustHexHsl(baseColor, hueDelta, saturationTarget)
    })
    const nextProject: ProjectState = { ...sourceProject, instances: nextInstances, customVoxels: nextCustomVoxels, customColors: nextCustomColors }
    recordHistoryBeforeChange(sourceProject, nextProject)
    // Color changes do not alter occupancy. Avoid rehashing every scene voxel
    // while the inspector publishes the new material state.
    skipSceneOccupancySyncRef.current = true
    const publishEpoch = ++historyEpochRef.current
    projectRef.current = nextProject
    markSceneDirty()
    startTransition(() => {
      if (historyEpochRef.current !== publishEpoch) return
      setProject(nextProject)
      setHistoryRevision((value) => value + 1)
    })
  }

  const sceneAxisToVoxelAxis = (axis: SceneTransformAxis): 'x' | 'y' | 'z' => axis === 'x' ? 'x' : axis === 'y' ? 'z' : 'y'

  const resolveDiscreteTransformSelection = (sourceProject: ProjectState, parts: SceneEntityPart[]): DiscreteTransformSelection => {
    const requestedPartIds = new Set(parts.map((part) => part.id))
    const requestedInstanceIds = new Set(parts.map((part) => part.instanceId).filter((id): id is string => Boolean(id)))
    const resolvedParts = sceneEntityParts(sourceProject).filter((part) =>
      requestedPartIds.has(part.id) || Boolean(part.instanceId && requestedInstanceIds.has(part.instanceId)),
    )
    return {
      sourcePartIds: new Set(resolvedParts.map((part) => part.id)),
      instanceIds: new Set(resolvedParts.map((part) => part.instanceId).filter((id): id is string => Boolean(id))),
      customIds: new Set(resolvedParts.filter((part) => part.kind === 'custom').map((part) => part.partId)),
    }
  }

  const transformPartsForSelection = (sourceProject: ProjectState, selection: DiscreteTransformSelection): SceneEntityPart[] => {
    return sceneEntityParts(sourceProject).filter((part) =>
      selection.sourcePartIds.has(part.id)
      || Boolean(part.instanceId && selection.instanceIds.has(part.instanceId))
      || (part.kind === 'custom' && selection.customIds.has(part.partId)),
    )
  }

  const transformSourcePartIds = (sourceProject: ProjectState, parts: SceneEntityPart[]): Set<string> =>
    resolveDiscreteTransformSelection(sourceProject, parts).sourcePartIds

  const buildSceneDiscreteTransformProject = (sourceProject: ProjectState, parts: SceneEntityPart[], mode: 'mirror' | 'rotate', axis: SceneTransformAxis, degrees: 90 | 180 | 270 = 90): ProjectState | null => {
    // A scene instance is the editable unit even when the tree selection only
    // contains one of its child parts. Transforming the instance while
    // leaving sibling parts out of the source set desynchronizes the cache and
    // occupancy index, which makes the next transform appear to do nothing.
    const selection = resolveDiscreteTransformSelection(sourceProject, parts)
    const currentParts = transformPartsForSelection(sourceProject, selection)
    const selectedCustomIds = selection.customIds
    const selectedInstanceIds = selection.instanceIds
    if (!selectedCustomIds.size && !selectedInstanceIds.size) return null
    const assetMap = new Map(sourceProject.assets.map((asset) => [asset.id, asset]))
    const voxelAxis = sceneAxisToVoxelAxis(axis)
    // Keep a direct identity mapping from each canonical voxel to its result.
    // Reconstructing the source key from scene coordinates is fragile for
    // moved entities: a lazy customEntityOffset, legacy entity id, or a
    // fractional scene translation can make a valid source voxel miss the
    // lookup. A missed lookup leaves that voxel at its old position, which is
    // exactly the "half stayed behind" rotation failure.
    //
    // Transform all selected custom parts as one voxel set. This preserves
    // the relative placement of assembly members and multi-selection parts;
    // each result is still written back to its original canonical owner.
    const selectedCustomParts = currentParts.filter((part): part is SceneEntityPart & { kind: 'custom' } => part.kind === 'custom' && selectedCustomIds.has(part.partId))
    const sourceEntries = selectedCustomParts.flatMap((part) => scenePartVoxels(part).map((voxel, index) => ({
      part,
      voxel,
      canonical: part.voxels[index],
    })))
    // Keep the canonical voxel object as the write-back key. Scene parts are
    // grouped directly from `sourceProject.customVoxels`, so this identity is
    // stable for the complete transform transaction. Reconstructing a key
    // from the canonical entity id and coordinates is unsafe here: legacy
    // voxels can have synthesized ids, and a moved entity can carry a lazy
    // scene offset. In those cases a valid transformed cell misses the map
    // and silently remains at its old position, which looks like lost voxels
    // and makes the next rotation use a stale shape.
    const transformedBySource = new Map<Voxel, Voxel>()
    if (sourceEntries.length) {
      const transformed = mode === 'mirror'
        ? mirrorVoxels(sourceEntries.map(({ voxel }) => voxel), voxelAxis)
        : rotateVoxels(sourceEntries.map(({ voxel }) => voxel), voxelAxis, degrees)
      sourceEntries.forEach(({ part, canonical }, index) => {
        if (!canonical) return
        const storedResult = sceneToStoredCustomVoxel(sourceProject, transformed[index], part.partId)
        transformedBySource.set(canonical, storedResult)
      })
    }
    const nextCustomVoxels = transformedBySource.size
      ? sourceProject.customVoxels.map((voxel) => {
        return transformedBySource.get(voxel) ?? voxel
      })
      : sourceProject.customVoxels
    const nextInstances = selectedInstanceIds.size
      ? sourceProject.instances.map((instance) => {
        if (!selectedInstanceIds.has(instance.id)) return instance
        if (mode === 'mirror') {
          const mirror = { x: instance.mirror?.x ?? false, y: instance.mirror?.y ?? false, z: instance.mirror?.z ?? false, [axis]: !(instance.mirror?.[axis] ?? false) }
          const mirrored = { ...instance, mirror }
          const asset = assetMap.get(instance.assetId)
          // The pivot is the selected instance's own geometric center. Keep
          // that pivot stable after the first initialization: recomputing it
          // from the already transformed/mirrored geometry changes the
          // rotation frame on every operation and causes center drift and
          // quarter-turns that appear to lose cells.
          return asset
            ? { ...mirrored, rotationPivot: instance.rotationPivot ?? instanceRotationPivot(instance, asset) }
            : mirrored
        }
        const key = axis === 'x' ? 'rotationX' : axis === 'y' ? 'rotationZ' : 'rotationY'
        const asset = assetMap.get(instance.assetId)
        const rotated = { ...instance, [key]: ((instance[key] ?? 0) + degrees) % 360 }
        return asset
          ? { ...rotated, rotationPivot: instance.rotationPivot ?? instanceRotationPivot(instance, asset) }
          : rotated
      })
      : sourceProject.instances
    return { ...sourceProject, customVoxels: nextCustomVoxels, instances: nextInstances }
  }

  const createDiscreteTransformPreview = (sourceProject: ProjectState, parts: SceneEntityPart[], mode: 'mirror' | 'rotate', axis: SceneTransformAxis, degrees: 90 | 180 | 270 = 90): DiscreteTransformPreviewState | null => {
    const candidateProject = buildSceneDiscreteTransformProject(sourceProject, parts, mode, axis, degrees)
    if (!candidateProject) return null
    const selection = resolveDiscreteTransformSelection(sourceProject, parts)
    const sourcePartIds = selection.sourcePartIds
    const candidateParts = transformPartsForSelection(candidateProject, selection)
    const candidateVoxels = candidateParts.flatMap((part) => scenePartVoxels(part))
    if (!candidateVoxels.length) return null
    const bounds = sceneBoundsForProject(sourceProject)
    let invalidReason: DiscreteTransformPreviewState['invalidReason']
    if (!sceneVoxelsWithinBounds(candidateVoxels, bounds)) invalidReason = 'boundary'
    // This is an explicit, post-transform operation rather than a pointer
    // move. The occupancy index is deliberately not authoritative here: it
    // can still contain the previous lazy transform while React is publishing
    // the first result. Using it in addition to the exact scene snapshot made
    // a valid second mirror/rotation look like a collision with the object
    // itself. The exact snapshot check is cheap enough at button/preview
    // cadence and is the single source of truth for this operation.
    else if (shapeBatchCollidesWithScene(candidateVoxels, sceneEntityParts(sourceProject), sourcePartIds)) invalidReason = 'collision'
    const previewAsset = makeAssetFromSceneParts('transform-preview', mode === 'mirror' ? '镜像预览' : '旋转预览', candidateParts, '#6c827d', '#d2a354', (voxel, part) => scenePartVoxelDisplayColor(candidateProject, part, voxel))
    const previewBounds = voxelBounds(previewAsset.voxels)!
    const origin = {
      x: (Math.min(...candidateVoxels.map((voxel) => voxel.x)) - previewBounds.min.x + previewAsset.width / 2) * VOXEL_WORLD_SIZE,
      y: (Math.min(...candidateVoxels.map((voxel) => voxel.y)) - previewBounds.min.y) * VOXEL_WORLD_SIZE,
      z: (Math.min(...candidateVoxels.map((voxel) => voxel.z)) - previewBounds.min.z + previewAsset.depth / 2) * VOXEL_WORLD_SIZE,
    }
    return {
      mode,
      axis,
      degrees,
      sourcePartIds: [...sourcePartIds],
      sourceInstanceIds: [...selection.instanceIds],
      sourceCustomIds: [...selection.customIds],
      asset: previewAsset,
      origin,
      valid: !invalidReason,
      invalidReason,
    }
  }

  const commitSceneDiscreteTransform = (parts: SceneEntityPart[], mode: 'mirror' | 'rotate', axis: SceneTransformAxis, degrees: 90 | 180 | 270 = 90) => {
    if (geometryApplyingRef.current) return false
    const sourceProject = projectRef.current
    const nextProject = buildSceneDiscreteTransformProject(sourceProject, parts, mode, axis, degrees)
    if (!nextProject) return false
    const selection = resolveDiscreteTransformSelection(sourceProject, parts)
    recordHistoryBeforeChange(sourceProject, nextProject)
    // A discrete transform changes the absolute coordinates of every voxel in
    // the selected object. Reconcile the complete index atomically instead of
    // trying to maintain a partial owner list while component IDs and lazy
    // offsets are changing. This prevents stale pre-transform occupancy from
    // rejecting the next operation.
    sceneOccupancyRef.current?.syncParts(sceneEntityParts(nextProject))
    skipSceneOccupancySyncRef.current = true
    const publishEpoch = ++historyEpochRef.current
    projectRef.current = nextProject
    markSceneDirty()
    if (historyEpochRef.current === publishEpoch) setProject(nextProject)
    setHistoryRevision((value) => value + 1)
    return true
  }

  const selectedContainsLockedEntity = () => transformSelectionRef.current.parts.some((part) => scenePartIsLocked(projectRef.current, part))

  const startDiscreteTransformPreview = (mode: 'mirror' | 'rotate', axis: SceneTransformAxis, degrees: 90 | 180 | 270 = 90) => {
    const currentSelection = transformSelectionRef.current.parts
    if (!currentSelection.length) {
      setNotice(`请先选择要${mode === 'mirror' ? '镜像' : '旋转'}的实体`)
      return
    }
    if (selectedContainsLockedEntity()) {
      setNotice(`选中的实体中包含已固定实体 · 请先取消固定后再${mode === 'mirror' ? '镜像' : '旋转'}`)
      return
    }
    setCopyPreview(null)
    cancelGeometryPreview()
    const preview = createDiscreteTransformPreview(projectRef.current, currentSelection, mode, axis, degrees)
    setTransformPreview(preview)
    setNotice(!preview ? '无法生成变换预览' : preview.valid ? '预览有效 · 请确认应用' : preview.invalidReason === 'collision' ? '预览与已有实体重叠，无法应用' : '预览超出场景边界，无法应用')
  }

  const mirrorSelectedEntities = (axis: SceneTransformAxis) => startDiscreteTransformPreview('mirror', axis)
  const rotateSelectedEntities = (axis: SceneTransformAxis, degrees: 90 | 180 | 270) => startDiscreteTransformPreview('rotate', axis, degrees)

  const confirmDiscreteTransform = () => {
    if (!transformPreview) return
    const selection: DiscreteTransformSelection = {
      sourcePartIds: new Set(transformPreview.sourcePartIds),
      instanceIds: new Set(transformPreview.sourceInstanceIds),
      customIds: new Set(transformPreview.sourceCustomIds),
    }
    const currentParts = transformPartsForSelection(projectRef.current, selection)
    const currentPreview = createDiscreteTransformPreview(projectRef.current, currentParts, transformPreview.mode, transformPreview.axis, transformPreview.degrees)
    if (!currentPreview?.valid) {
      setTransformPreview(currentPreview)
      setNotice(currentPreview?.invalidReason === 'collision' ? '变换被拒绝：会与已有实体重叠' : '变换被拒绝：会超出场景边界')
      return
    }
    const { selectedId: selectedIdBefore, selectedScenePart: selectedPartBefore, checkedTreePartIds: checkedIdsBefore } = transformSelectionRef.current
    const selectedAssemblyIdBefore = selectedIdBefore.startsWith('assembly:')
      ? selectedIdBefore.slice('assembly:'.length)
      : selectedPartBefore?.assemblyId
    if (!commitSceneDiscreteTransform(currentParts, transformPreview.mode, transformPreview.axis, transformPreview.degrees)) {
      setNotice('变换失败：场景状态已变化，请重新预览')
      setTransformPreview(null)
      return
    }
    // Transforming an asset can rebuild its component IDs. Rebind the tree
    // selection to the semantic owner/part instead of retaining a stale
    // generated ID, otherwise the next click looks like a no-op because the
    // inspector has no selected parts.
    const nextParts = transformPartsForSelection(projectRef.current, selection)
    const nextPartFor = (before: SceneEntityPart) => nextParts.find((part) =>
      part.kind === before.kind
      && part.instanceId === before.instanceId
      && part.partId === before.partId,
    ) ?? nextParts.find((part) => part.instanceId && part.instanceId === before.instanceId)
    const nextCheckedIds = checkedIdsBefore.map((id) => {
      if (id.startsWith('assembly:')) return id
      const before = sceneParts.find((part) => part.id === id)
      return before ? nextPartFor(before)?.id : id
    }).filter((id): id is string => Boolean(id))
    const nextSelectedPart = selectedPartBefore ? nextPartFor(selectedPartBefore) : undefined
    let clearCheckedSelection = false
    if (selectedAssemblyIdBefore) {
      setSelectedId(`assembly:${selectedAssemblyIdBefore}`)
    } else if (selection.instanceIds.size === 1 && selection.customIds.size === 0) {
      // The instance id is stable across component regeneration. Keeping a
      // generated child id here is what made the next operation lose its
      // effective selection after the first transform.
      setSelectedId([...selection.instanceIds][0])
      clearCheckedSelection = true
    } else if (selection.customIds.size === 1 && selection.instanceIds.size === 0) {
      const entityId = [...selection.customIds][0]
      setSelectedId(`custom:${entityId}`)
      clearCheckedSelection = true
    } else if (nextSelectedPart) {
      setSelectedId(nextSelectedPart.id)
    } else if (nextParts[0]) {
      setSelectedId(nextParts[0].id)
    }
    if (clearCheckedSelection) setCheckedTreePartIds([])
    else if (checkedIdsBefore.length) setCheckedTreePartIds(nextCheckedIds.length ? nextCheckedIds : nextParts.map((part) => part.id))
    setTransformPreview(null)
    setNotice(transformPreview.mode === 'mirror' ? `已镜像选中实体 · ${transformPreview.axis.toUpperCase()} 轴` : `已旋转选中实体 · ${transformPreview.axis.toUpperCase()} 轴 ${transformPreview.degrees}°`)
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
    setTransformPreview(null)
    setSelectionRefreshKey((value) => value + 1)
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
    setTransformPreview(null)
    setSelectionRefreshKey((value) => value + 1)
    const removing = checkedTreePartIds.includes(id)
    setCheckedTreePartIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
    setSelectedId(removing && selectedId === id ? '' : id)
    if (!removing && !id.startsWith('assembly:')) revealScenePartPath(id)
    setTreeContextMenu(null)
  }

  const selectScenePart = (id: string) => {
    setCopyPreview(null)
    setTransformPreview(null)
    setSelectionRefreshKey((value) => value + 1)
    setSelectedId(id)
    setCheckedTreePartIds([id])
    revealScenePartPath(id)
    setTreeContextMenu(null)
  }

  const updateSceneCheckedSelection = (partIds: string[], additive = false) => {
    setCopyPreview(null)
    setTransformPreview(null)
    setSelectionRefreshKey((value) => value + 1)
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

  // These handlers are event-backed rather than render-data props. Keeping
  // their identities stable lets the memoized side panels skip renders during
  // camera/drag updates while still dispatching to the latest App state.
  const assetToggleSelection = useStableEvent((assetId: string) => setSelectedAssetIds((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]))
  const assetClearSelection = useStableEvent(() => setSelectedAssetIds([]))
  const assetToggleCollapsed = useStableEvent(() => setAssetSidebarCollapsed((value) => !value))
  const assetContextMenuHandler = useStableEvent((assetId: string, x: number, y: number) => { setAssetContextMenu({ assetId, x, y }); setAssetCategoryContextMenu(null) })
  const assetCategoryContextMenuHandler = useStableEvent((path: string[], x: number, y: number) => { setAssetCategoryContextMenu({ path, x, y }); setAssetContextMenu(null) })
  const treeToggleExpanded = useStableEvent((assemblyId: string) => setExpandedAssemblies((current) => ({ ...current, [assemblyId]: !(current[assemblyId] ?? true) })))
  const treeContextMenuHandler = useStableEvent((targetId: string, x: number, y: number, assemblyId?: string) => { if (!editEntityId || targetId === editEntityId) setTreeContextMenu({ targetId, assemblyId, x, y }) })
  const stableAssetExport = useStableEvent(exportTemplateAssets)
  const stableAssetNotice = useStableEvent(setNotice)
  const stableAssetBeginPlacement = useStableEvent(beginPlacement)
  const stableAssetEndPlacement = useStableEvent(endPlacement)
  const stableAssetCreateCategory = useStableEvent(createAssetCategory)
  const stableAssetDeleteCategory = useStableEvent(deleteAssetCategory)
  const stableAssetRename = useStableEvent(renameTemplateAsset)
  const stableAssetDuplicate = useStableEvent(duplicateTemplateAsset)
  const stableAssetDelete = useStableEvent(deleteTemplateAsset)
  const stableAssetChangeColor = useStableEvent(changeTemplateAssetColor)
  const stableTreeSelect = useStableEvent(selectTreeItem)
  const stableTreeToggleChecked = useStableEvent(toggleTreeChecked)
  const stableTreeAssemble = useStableEvent(assembleCheckedTreeParts)
  const stableTreeDissolve = useStableEvent(dissolveSceneAssembly)
  const stableTreeEnterEdit = useStableEvent(enterEditMode)
  const stableTreeRename = useStableEvent(renameSceneEntity)
  const stableTreeDelete = useStableEvent(deleteSceneTreeEntity)
  const stableTreeToggleLock = useStableEvent(toggleTreeLock)
  const stableViewportZoomChange = useStableEvent((value: number) => setZoomLevel(clampZoomLevel(value)))
  const stableViewportInteractionChange = useStableEvent((active: boolean) => {
    interactionActiveRef.current = active
    if (active && tool !== 'select') beginVoxelStroke()
    if (!active) {
      commitVoxelStroke()
      voxelStrokeEntityRef.current = null
    }
  })
  const stableViewportRaycast = useStableEvent(raycastSceneVoxel)
  const stableViewportSyncOccupancyTransforms = useStableEvent(() => {
    sceneOccupancyRef.current?.syncOwnerTransforms(sceneEntityParts(projectRef.current))
  })
  const stableViewportSelect = useStableEvent(selectScenePart)
  const stableViewportSelectMultiple = useStableEvent(updateSceneCheckedSelection)
  const stableViewportCancelPending = useStableEvent(() => {
    setCopyPreview(null)
    setTransformPreview(null)
    cancelGeometryPreview()
  })
  const stableViewportSelectMaterial = useStableEvent(useMaterial)
  const stableViewportReplaceMaterial = useStableEvent(replaceMaterialColor)
  const stableViewportAddVoxel = useStableEvent(addVoxel)
  const stableViewportRemoveVoxel = useStableEvent(removeVoxel)
  const stableViewportRemoveVoxels = useStableEvent(removeVoxels)
  const stableViewportEditInstanceVoxel = useStableEvent(editInstanceVoxel)
  const stableViewportEditInstanceVoxels = useStableEvent(editInstanceVoxels)
  const stableViewportApplyVoxelBatch = useStableEvent(applyVoxelBatch)
  const stableViewportPreviewMove = useStableEvent(previewScenePartsMove)
  const stableViewportCommitMove = useStableEvent(commitScenePartsMove)
  const stableViewportCancelMove = useStableEvent(cancelScenePartsMove)
  const stableViewportPreviewPlacement = useStableEvent(previewPlacementAt)
  const stableViewportPlaceAsset = useStableEvent(placeAssetAt)
  const stableViewportNotice = useStableEvent(notifyEditor)
  const stableViewportExitEdit = useStableEvent(exitEditMode)
  const stableViewportEnterEdit = useStableEvent(enterEditMode)
  const stableViewportRename = useStableEvent(renameSceneEntity)
  const stableViewportBatchOperation = useStableEvent(operateOnSceneSelection)
  const sceneTreeOverlay = useMemo(() => <MemoizedSceneTreePanel items={sceneTreeItems} selectedId={selectedId} selectedPartIds={selectedEntityPartIds} checkedPartIds={checkedTreePartIds} lockedPartIds={lockedPartIds} expandedAssemblies={expandedAssemblies} contextMenu={treeContextMenu} onToggleExpanded={treeToggleExpanded} onSelect={stableTreeSelect} onToggleChecked={stableTreeToggleChecked} onAssemble={stableTreeAssemble} onDissolve={stableTreeDissolve} onEnterEdit={stableTreeEnterEdit} onRename={stableTreeRename} onDelete={stableTreeDelete} onToggleLock={stableTreeToggleLock} onContextMenu={treeContextMenuHandler} />, [sceneTreeItems, selectedId, selectedEntityPartIds, checkedTreePartIds, lockedPartIds, expandedAssemblies, treeContextMenu, treeToggleExpanded, stableTreeSelect, stableTreeToggleChecked, stableTreeAssemble, stableTreeDissolve, stableTreeEnterEdit, stableTreeRename, stableTreeDelete, stableTreeToggleLock, treeContextMenuHandler])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Box size={19} strokeWidth={1.7} /></div>
          <div><div className="brand-name">莫测造境</div><div className="brand-subtitle">体素世界编辑器</div></div>
        </div>
        <div className="top-actions">
          <ActionButton icon={<FilePlus2 size={17} />} label="新建" onClick={createNewProject} />
          <ActionButton icon={<Database size={17} />} label="场景库" onClick={openLibrary} />
          <ActionButton icon={<Save size={17} />} label="保存" onClick={saveProject} />
          <ActionButton icon={<Save size={17} />} label="另存" onClick={saveProjectAs} />
          <div className="top-divider" />
          <ActionButton icon={<WandSparkles size={17} />} label="模型转体素" onClick={() => modelImportInputRef.current?.click()} />
          <ActionButton icon={<Upload size={17} />} label="导入实体" onClick={() => entityFileInputRef.current?.click()} />
          <ExportMenu label="导出场景" strong onExportStl={exportSceneStl} onExportGlb={exportSceneGlb} onExportVox={exportSceneVox} />
          <button className="icon-button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={undoProject}><Undo2 size={17} /></button>
          <button className="icon-button" title="重做" aria-label="重做" disabled={!canRedo} onClick={redoProject}><Redo2 size={17} /></button>
          <div className="top-spacer" />
          <div className="header-account-tools">
            <button className="action-button header-account-button" title={authUser ? `已登录：${authUser.email}` : '登录或注册'} onClick={() => { setAuthDialogMode('login'); setAuthDialogOpen(true) }}>
              {authUser ? <UserRound size={17} /> : <LogIn size={17} />}
              <span>{authUser ? authUser.email : '登录/注册'}</span>
            </button>
            <button className="icon-button" title="设置" aria-label="设置" onClick={() => setNotice('设置面板将在下一阶段接入')}><Settings size={17} /></button>
          </div>
        </div>
        <input ref={modelImportInputRef} className="hidden-input" type="file" accept=".glb,.gltf,.obj,.stl,.vox" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) openModelImportDialog(file) }} />
        <input ref={entityFileInputRef} className="hidden-input" type="file" accept=".moceentity" onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void importEntityFileFromDisk(file) }} />
        <input ref={referenceImageInputRef} className="hidden-input" type="file" accept="image/*" multiple onChange={handleReferenceImageChange} />
      </header>

      <main className={`workspace ${assetSidebarCollapsed ? 'asset-sidebar-collapsed' : ''}`} onClick={() => { if (treeContextMenu) setTreeContextMenu(null); if (assetContextMenu) setAssetContextMenu(null); if (assetCategoryContextMenu) setAssetCategoryContextMenu(null); if (sceneLibraryContextMenu) setSceneLibraryContextMenu(null); if (voxelSizeOpen) setVoxelSizeOpen(false) }}>
        <MemoizedAssetSidebar assets={filteredAssets} categoryPaths={assetCategoryPaths} query={query} setQuery={setQuery} selectedAssetIds={selectedAssetIds} onToggleAssetSelection={assetToggleSelection} onClearAssetSelection={assetClearSelection} onExportAssets={stableAssetExport} collapsed={assetSidebarCollapsed} onToggleCollapsed={assetToggleCollapsed} onNotice={stableAssetNotice} onBeginPlacement={stableAssetBeginPlacement} onEndPlacement={stableAssetEndPlacement} onContextMenu={assetContextMenuHandler} contextMenu={assetContextMenu} categoryContextMenu={assetCategoryContextMenu} onCategoryContextMenu={assetCategoryContextMenuHandler} onCreateCategory={stableAssetCreateCategory} onDeleteCategory={stableAssetDeleteCategory} onRenameAsset={stableAssetRename} onDuplicateAsset={stableAssetDuplicate} onDeleteAsset={stableAssetDelete} onChangeAssetColor={stableAssetChangeColor} onBackupAsset={backupAssetToCloud} cloudAssets={cloudAssets} cloudAssetPreviews={cloudAssetPreviews} cloudAssetPreviewErrors={cloudAssetPreviewErrors} cloudTransfers={cloudTransfers} cloudTransferErrors={cloudTransferErrors} onDownloadCloudAsset={downloadCloudAssetToLocal} onDeleteCloudAsset={removeCloudAsset} />
        <section className="viewport-panel">
          <div className="viewport-toolbar">
            <div className="view-toggle">{(['正交', '透视'] as const).map((mode) => <button key={mode} className={viewMode === mode ? 'active' : ''} onClick={() => { setViewMode(mode); setNotice(`已切换视图 · ${mode}`) }}>{mode}</button>)}</div>
            <div className="toolbar-spacer" />
            <div className="voxel-size-control-wrap" onClick={(event) => event.stopPropagation()}>
              <button className={`micro-control ${voxelSizeOpen ? 'active' : ''}`} onClick={() => { setVoxelSizeDraft(project.voxelSizeMm); setVoxelSizeOpen((value) => !value); setBoundaryOpen(false) }}><Grid3X3 size={14} /> {formatVoxelSizeMm(project.voxelSizeMm)} mm体素 <ChevronDown size={13} /></button>
              {voxelSizeOpen && <div className="voxel-size-popover" onClick={(event) => event.stopPropagation()}>
                <div className="boundary-popover-title">体素边长</div>
                <div className="boundary-popover-subtitle">每个体素导出 STL 后代表的实际边长</div>
                <div className="voxel-size-options">{[0.25, 0.5, 1, 2, 3, 5].map((value) => <button key={value} className={voxelSizeDraft === value ? 'active' : ''} onClick={() => { setVoxelSizeDraft(value); applyVoxelSize(value) }}>{formatVoxelSizeMm(value)} mm</button>)}</div>
                <label className="boundary-field voxel-size-field"><span>自定义</span><NumericInput min={0.1} max={100} step={0.1} value={voxelSizeDraft} onCommit={setVoxelSizeDraft} /><em>mm</em></label>
                <div className="boundary-limit">允许范围：0.1–100 mm</div>
                <div className="boundary-actions"><button onClick={() => { setVoxelSizeDraft(project.voxelSizeMm); setVoxelSizeOpen(false) }}>取消</button><button className="primary" onClick={() => applyVoxelSize()}>应用</button></div>
              </div>}
            </div>
            <div className="boundary-control-wrap">
              <button className={`micro-control ${boundaryOpen ? 'active' : ''}`} onClick={() => { setBoundaryDraft(currentSceneBounds); setBoundaryOpen((value) => !value); setVoxelSizeOpen(false) }}><SlidersHorizontal size={14} /> 边界 <ChevronDown size={13} /></button>
              {boundaryOpen && <div className="boundary-popover" onClick={(event) => event.stopPropagation()}>
                <div className="boundary-popover-title">场景边界</div>
                <div className="boundary-popover-subtitle">按体素设置地面尺寸与 Z 轴限高</div>
                <div className="boundary-fields">
                  {([['x', 'X 宽度'], ['y', 'Y 深度'], ['z', 'Z 高度']] as const).map(([axis, label]) => <label key={axis} className="boundary-field"><span>{label}</span><NumericInput min={MIN_SCENE_BOUND_VOXELS} max={MAX_SCENE_BOUND_VOXELS} integer value={boundaryDraft[axis]} onCommit={(value) => setBoundaryDraft((current) => ({ ...current, [axis]: value }))} /><em>体素</em></label>)}
                </div>
                <div className="boundary-limit">最小尺寸：{MIN_SCENE_BOUND_VOXELS} × {MIN_SCENE_BOUND_VOXELS} × {MIN_SCENE_BOUND_VOXELS} 体素 · 最大尺寸：{MAX_SCENE_BOUND_VOXELS} × {MAX_SCENE_BOUND_VOXELS} × {MAX_SCENE_BOUND_VOXELS} 体素</div>
                <div className="boundary-actions"><button onClick={() => { setBoundaryDraft(currentSceneBounds); setBoundaryOpen(false) }}>取消</button><button className="primary" onClick={applySceneBounds}>应用</button></div>
              </div>}
            </div>
          </div>
          <MemoizedVoxelViewport project={project} authoritativeProjectRef={projectRef} sceneParts={sceneParts} occupancyIndex={sceneOccupancyRef.current} assetTransformCache={assetTransformCacheRef.current!} selectedId={selectedId} selectionRefreshKey={selectionRefreshKey} selectedPartIds={selectedEntityPartIds} checkedPartIds={checkedTreePartIds} lockedPartIds={lockedPartIds} editEntityId={editEntityId} colorPreview={colorPreview} geometryPreview={geometryPreview} geometryApplying={geometryApplying} historyResetKey={historyRevision} tool={tool} toolboxOpen={toolboxOpen} drawingPlane={drawingPlane} drawOperation={drawOperation} brushSize={brushSize} voxelBrushShape={voxelBrushShape} activeMaterial={activeMaterial} materials={recentMaterials} dragAxis={dragAxis} placementAsset={pendingEntityImport?.asset ?? project.assets.find((asset) => asset.id === placementAssetId) ?? null} copyPreview={copyPreview} transformPreview={transformPreview} viewMode={viewMode} showGrid={showGrid} showBoundary={showBoundary} zoomLevel={zoomLevel} onZoomChange={stableViewportZoomChange} onCameraApiChange={setCameraControlApi} onInteractionChange={stableViewportInteractionChange} onRaycastVoxel={stableViewportRaycast} onSyncSceneOccupancyTransforms={stableViewportSyncOccupancyTransforms} onSelect={stableViewportSelect} onSelectMultiple={stableViewportSelectMultiple} onCancelPendingEntityOperation={stableViewportCancelPending} onSelectMaterial={stableViewportSelectMaterial} onReplaceMaterial={stableViewportReplaceMaterial} onAddVoxel={stableViewportAddVoxel} onRemoveVoxel={stableViewportRemoveVoxel} onRemoveVoxels={stableViewportRemoveVoxels} onEditInstanceVoxel={stableViewportEditInstanceVoxel} onEditInstanceVoxels={stableViewportEditInstanceVoxels} onApplyVoxelBatch={stableViewportApplyVoxelBatch} onPreviewScenePartsMove={stableViewportPreviewMove} onCommitScenePartsMove={stableViewportCommitMove} onCancelScenePartsMove={stableViewportCancelMove} onPreviewPlacement={stableViewportPreviewPlacement} onPlaceAsset={stableViewportPlaceAsset} onNotice={stableViewportNotice} onExitEditMode={stableViewportExitEdit} onEnterEditMode={stableViewportEnterEdit} onRename={stableViewportRename} onBatchOperation={stableViewportBatchOperation}>{sceneTreeOverlay}</MemoizedVoxelViewport>
          <ToolboxPopover open={toolboxOpen} onClose={() => setToolboxOpen(false)} tool={tool} drawingPlane={drawingPlane} drawOperation={drawOperation} brushSize={brushSize} voxelBrushShape={voxelBrushShape} onToolChange={changeTool} onPlaneChange={setDrawingPlane} onOperationChange={setDrawOperation} onBrushSizeChange={setBrushSize} onBrushShapeChange={setVoxelBrushShape} />
          <ReferenceImagePopover open={referenceImageOpen} image={referenceImage} index={referenceImageIndex} count={referenceImages.length} onPrevious={() => setReferenceImageIndex((current) => (current - 1 + referenceImages.length) % referenceImages.length)} onNext={() => setReferenceImageIndex((current) => (current + 1) % referenceImages.length)} onClose={() => setReferenceImageOpen(false)} onOpen={openReferenceImagePicker} />
          <div className="viewport-footer">
            <div className="tool-group">
              <ToolButton icon={<SquareDashedMousePointer size={17} />} label="选择" description="实体移动" active={tool === 'select'} onClick={() => changeTool('select')} />
              <div className="tool-button-popover-wrap" onClick={(event) => event.stopPropagation()}>
                <ToolButton icon={<ToolCase size={17} />} label="工具箱" description="打开工具箱" active={toolboxOpen} onClick={() => setToolboxOpen((value) => !value)} />
              </div>
              <div className="tool-button-popover-wrap" onClick={(event) => event.stopPropagation()}>
                <ToolButton icon={<ImageIcon size={17} />} label="参考图" description={referenceImage ? '显示参考图' : '打开参考图'} active={referenceImageOpen} onClick={() => { if (referenceImage) setReferenceImageOpen((value) => !value); else openReferenceImagePicker() }} />
              </div>
            </div>
            <div className="footer-separator" />
            <button className={`footer-control ${showGrid ? 'active' : ''}`} onClick={() => { setShowGrid((value) => !value); setNotice(showGrid ? '已隐藏网格' : '已显示网格') }}><Grid3X3 size={16} /> 网格</button>
            <button className={`footer-control ${showBoundary ? 'active' : ''}`} onClick={() => { setShowBoundary((value) => !value); setNotice(showBoundary ? '已隐藏场景边框' : '已显示场景边框') }}><Square size={16} /> 边框</button>
            <div className="drag-axis-control" aria-label="拖动方向"><Move3d size={14} /><span>拖动</span><button className={dragAxis === 'horizontal' ? 'active' : ''} onClick={() => { setDragAxis('horizontal'); setNotice('拖动方向 · 水平（X/Y）') }}>水平 X/Y</button><button className={dragAxis === 'vertical' ? 'active' : ''} onClick={() => { setDragAxis('vertical'); setNotice('拖动方向 · 竖直（Z）') }}>竖直 Z</button></div>
            {!(['cuboid', 'sphere', 'extrude'] as Tool[]).includes(tool) && <div className="drawing-plane-control" aria-label="绘制平面"><span>绘制平面</span>{(['xy', 'xz', 'yz'] as const).map((plane) => <button key={plane} className={drawingPlane === plane ? 'active' : ''} onClick={() => setDrawingPlane(plane)}>{plane === 'xy' ? 'XZ' : plane === 'xz' ? 'XY' : 'YZ'}</button>)}</div>}
            {cameraControlApi && <ViewportCameraControls showJoystick={false} onRotate={cameraControlApi.rotate} onView={(view) => { cameraControlApi.view(view); setNotice(`已切换视角 · ${cameraViewLabel(view)}`) }} onReset={() => { cameraControlApi.reset(); setNotice('视角已回中 · 缩放已恢复 100%') }} />}
            <div className="zoom-control"><button className="zoom-step" title="缩小" onClick={() => { if (cameraControlApi) cameraControlApi.zoomOut(); else setZoomLevel((value) => stepZoomLevel(value, -1)); setNotice('已缩小视图') }}><Minus size={14} /></button><div className="zoom-track"><div className="zoom-value" style={{ width: `${zoomTrackProgress(zoomLevel)}%` }} /></div><button className="zoom-step" title="放大" onClick={() => { if (cameraControlApi) cameraControlApi.zoomIn(); else setZoomLevel((value) => stepZoomLevel(value, 1)); setNotice('已放大视图') }}><Plus size={14} /></button><span className="zoom-percent">{Math.round(zoomLevel)}%</span></div>
          </div>
        </section>
        <MemoizedInspector entityName={selectedDisplayName} source={selectedSource} selectedAsset={selectedAsset} selectedPart={selectedScenePart} selectedParts={selectedEntityParts} selectedTransformSignature={selectedEntityTransformSignature} editEntityId={editEntityId} canEnterEditMode={canEnterSelectedEditMode} editTargetId={selectedId} selectedColor={selectedColor} previewColor={selectedEntityParts.length === 1 ? (selectedEntityParts[0]?.colorOverride ?? (selectedEntityParts[0]?.kind === 'custom' ? project.customColors?.[selectedEntityParts[0]?.partId] : undefined)) : undefined} previewVoxelColors={previewVoxelColors} previewMaterialColors={previewMaterialColors} copyPreview={copyPreview} transformPreview={transformPreview} geometryPreview={geometryPreview} shellThicknessOptions={geometryShellThicknessOptions} scaleOptions={geometryScaleOptions} onChangeColor={changeSelectedColor} onPreviewHsl={previewSelectedHsl} onCommitHsl={commitSelectedHsl} onMirror={mirrorSelectedEntities} onRotate={rotateSelectedEntities} onConfirmTransform={confirmDiscreteTransform} onCancelTransform={() => setTransformPreview(null)} onExport={exportSelectedPart} onExportGlb={exportSelectedPartGlb} onExportVox={exportSelectedPartVox} onExportEntityFile={exportSelectedEntityFile} onOpenSlicer={() => setSliceDialogOpen(true)} onDuplicate={startDuplicatePreview} onChangeCopyDirection={changeCopyPreviewDirection} onChangeCopyGap={changeCopyPreviewGap} onConfirmDuplicate={confirmDuplicate} onCancelDuplicate={() => { setCopyPreview(null); setTransformPreview(null) }} onStartShell={startShellPreview} onStartScale={startScalePreview} onChangeShellThickness={changeGeometryShellThickness} onChangeScale={changeGeometryScale} onConfirmGeometry={confirmGeometryPreview} onCancelGeometry={cancelGeometryPreview} onDelete={deleteSelected} onSaveAsAsset={saveSelectedEntityAsAsset} onEnterEditMode={enterEditMode} />
      </main>
      {libraryOpen && <SceneLibraryDialog library={library} busy={libraryBusy} selectedSceneLoading={selectedLibrarySceneLoading} selectionRevision={selectedLibrarySceneRevision} error={libraryError} selectedSceneId={selectedLibrarySceneId} selectedSceneProject={selectedLibrarySceneProject} cloudAssets={cloudAssets} cloudScenes={cloudScenes} cloudUsage={cloudUsage} cloudError={cloudError} cloudTransfers={cloudTransfers} cloudTransferErrors={cloudTransferErrors} onBackupCurrentScene={() => backupCurrentSceneToCloud()} onDownloadCloudScene={downloadCloudSceneToLocal} onDeleteCloudScene={removeCloudScene} onClose={() => { setLibraryOpen(false); setSceneLibraryContextMenu(null); setSelectedLibrarySceneId(null); setSelectedLibrarySceneProject(null); setSelectedLibrarySceneLoading(false) }} onLoadScene={loadStoredScene} onSelectScene={selectLibraryScene} onSaveSceneEntity={requestSaveAssetToLibrary} onAddSceneEntityToCurrentScene={addLibrarySceneEntityToCurrentScene} onDeleteSceneEntity={deleteLibrarySceneEntity} contextMenu={sceneLibraryContextMenu} onContextMenu={(sceneId, x, y) => setSceneLibraryContextMenu({ sceneId, x, y })} onCloseContextMenu={() => setSceneLibraryContextMenu(null)} onDuplicateScene={duplicateStoredScene} onDeleteScene={deleteStoredScene} onBackupScene={backupStoredSceneToCloud} />}
      {assetCategorySave && <AssetCategorySaveDialog asset={assetCategorySave.asset} assets={project.assets.filter((item) => item.isTemplate !== false)} onCancel={() => setAssetCategorySave(null)} onSave={saveAssetToLibrary} />}
      {modelImportDialog && <ModelImportDialog state={modelImportDialog} targetSizeVoxels={modelImportTargetVoxels} mode={modelImportMode} onTargetSizeChange={setModelImportTargetVoxels} onModeChange={setModelImportMode} onStart={runModelImport} onConfirm={confirmModelImport} onCancel={() => setModelImportDialog(null)} />}
      {sliceDialogOpen && selectedEntityParts.length > 0 && <SliceDialog parts={selectedEntityParts} project={project} name={selectedDisplayName || '选中实体'} onClose={() => setSliceDialogOpen(false)} onNotice={setNotice} />}
      {unsavedDialogOpen && <UnsavedChangesDialog onDecision={handleUnsavedDecision} />}
      {(!authChecked || authDialogOpen || !authUser) && <AuthDialog required={!authChecked || !authUser} mode={authDialogMode} user={authUser} onModeChange={setAuthDialogMode} onClose={() => { if (authUser) setAuthDialogOpen(false) }} onAuthenticated={(user) => { setAuthUser(user); setAuthChecked(true); setAuthDialogOpen(false); void refreshCloudLibrary(); setNotice(`已登录 · ${user.email}`) }} onLogout={async () => { await logoutAuthUser(); setAuthUser(null); setAuthDialogOpen(false); setNotice('已退出登录') }} />}
    </div>
  )
}

function AuthDialog({ required, mode, user, onModeChange, onClose, onAuthenticated, onLogout }: { required: boolean; mode: 'login' | 'register' | 'forgot'; user: AuthUser | null; onModeChange: (mode: 'login' | 'register' | 'forgot') => void; onClose: () => void; onAuthenticated: (user: AuthUser) => void; onLogout: () => Promise<void> }) {
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(() => new URLSearchParams(window.location.search).get('verified') === '1' ? '邮箱验证成功，请登录' : '')
  const [verificationUrl, setVerificationUrl] = useState('')
  const [verificationPendingEmail, setVerificationPendingEmail] = useState('')
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('reset') ?? '')
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('verify')
    if (!token) return
    setBusy(true)
    void verifyAuthEmail(token)
      .then((result) => {
        setMessage(result.message ?? '邮箱验证成功，请登录')
        const url = new URL(window.location.href)
        url.searchParams.delete('verify')
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : '邮箱验证失败，请重新发送验证邮件'))
      .finally(() => setBusy(false))
  }, [])
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setMessage(''); setVerificationUrl('')
    try {
      if (resetToken) {
        if (password !== confirmPassword) throw new Error('两次输入的密码不一致')
        const result = await resetAuthPassword(resetToken, password)
        setResetToken('')
        setPassword(''); setConfirmPassword('')
        setMessage(result.message ?? '密码已重置，请使用新密码登录')
        onModeChange('login')
        const url = new URL(window.location.href)
        url.searchParams.delete('reset')
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      } else if (mode === 'forgot') {
        const result = await requestPasswordReset(email)
        setMessage(result.message ?? '如果该邮箱对应账号存在，密码重置邮件已发送，请检查收件箱')
        if (result.devVerificationUrl) setVerificationUrl(result.devVerificationUrl)
      } else if (mode === 'login') {
        const result = await loginAuthUser(email, password)
        if (!result.user) throw new Error('登录响应缺少用户信息')
        onAuthenticated(result.user)
      } else {
        const result = await registerAuthUser(email, password)
        setVerificationPendingEmail(email.trim())
        setMessage(result.message ?? '注册成功，请检查邮箱完成验证')
        if (result.devVerificationUrl) setVerificationUrl(result.devVerificationUrl)
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : '认证失败'
      if (mode === 'login' && text.includes('尚未验证')) setVerificationPendingEmail(email.trim())
      setMessage(text)
    } finally { setBusy(false) }
  }
  const resend = async () => {
    if (!verificationPendingEmail) return
    setBusy(true); setMessage(''); setVerificationUrl('')
    try {
      const result = await resendVerificationEmail(verificationPendingEmail)
      setMessage(result.message ?? '最新验证邮件已发送，请检查邮箱')
      if (result.devVerificationUrl) setVerificationUrl(result.devVerificationUrl)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '验证邮件发送失败')
    } finally { setBusy(false) }
  }
  const resetMode = Boolean(resetToken)
  const title = resetMode ? '设置新密码' : user ? '账号' : mode === 'login' ? '登录莫测造境' : mode === 'register' ? '注册莫测造境' : '忘记密码'
  return <div className={`auth-backdrop ${required ? 'auth-gate' : ''}`} onPointerDown={(event) => { if (!required && event.target === event.currentTarget) onClose() }}>
    <section className="auth-dialog" role="dialog" aria-modal="true">
      {!required && <button className="auth-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>}
      <div className="auth-mark"><Box size={20} /></div>
      <h2>{title}</h2>
      {user && !resetMode ? <><p className="auth-subtitle">当前账号：{user.email}</p><button className="auth-submit" onClick={() => void onLogout()}>退出登录</button></> : <form onSubmit={submit}>
        {!resetMode && <label>邮箱<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
        {(!resetMode && mode !== 'forgot') && <label>密码<input type="password" required minLength={12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 个字符" /></label>}
        {resetMode && <><label>新密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 12 个字符" /></label><label>确认新密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label></>}
        <button className="auth-submit" disabled={busy}>{busy ? '处理中…' : resetMode ? '设置新密码' : mode === 'login' ? '登录' : mode === 'register' ? '注册' : '发送重置邮件'}</button>
        {!resetMode && <button type="button" className="auth-switch" onClick={() => { onModeChange(mode === 'login' ? 'register' : 'login'); setMessage(''); setVerificationUrl('') }}>{mode === 'login' ? '还没有账号？注册' : mode === 'register' ? '已有账号？登录' : '返回登录'}</button>}
        {mode === 'login' && !resetMode && <button type="button" className="auth-switch" onClick={() => { onModeChange('forgot'); setMessage(''); setVerificationUrl('') }}>忘记密码？</button>}
        {verificationPendingEmail && mode === 'login' && <button type="button" className="auth-switch" disabled={busy} onClick={() => void resend()}>{busy ? '正在发送…' : '没有收到邮件？重新发送验证邮件'}</button>}
        {message && <p className="auth-message">{message}</p>}
        {verificationUrl && <a className="auth-dev-link" href={verificationUrl} target="_blank" rel="noreferrer">打开本地验证链接</a>}
      </form>}
    </section>
  </div>
}

function ActionButton({ icon, label, onClick, strong = false }: { icon: React.ReactNode; label: string; onClick: () => void; strong?: boolean }) {
  return <button className={`action-button ${strong ? 'action-strong' : ''}`} onClick={onClick}>{icon}<span>{label}</span></button>
}

function ExportMenu({ label, strong = false, onExportStl, onExportGlb, onExportVox, onExportEntityFile }: { label: string; strong?: boolean; onExportStl: () => void; onExportGlb: () => void | Promise<void>; onExportVox: () => void; onExportEntityFile?: () => void }) {
  const [open, setOpen] = useState(false)
  const run = (action: () => void | Promise<void>) => {
    setOpen(false)
    void action()
  }
  return <div className="export-menu">
    <button aria-label={label} className={`action-button ${strong ? 'action-strong' : ''}`} onClick={() => setOpen((value) => !value)}><Download size={17} /><span>{label}</span><ChevronDown size={13} /></button>
    {open && <div className="export-menu-popover" onPointerDown={(event) => event.stopPropagation()}>
      <button onClick={() => run(onExportStl)}>导出 STL</button>
      <button onClick={() => run(onExportGlb)}>导出 GLB</button>
      <button onClick={() => run(onExportVox)}>导出 VOX</button>
      {onExportEntityFile && <button onClick={() => run(onExportEntityFile)}>导出普通实体文件</button>}
    </div>}
  </div>
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

const MemoizedSceneTreePanel = React.memo(SceneTreePanel)

function formatBytesUi(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function AssetSidebar({ assets, categoryPaths, query, setQuery, selectedAssetIds, onToggleAssetSelection, onClearAssetSelection, onExportAssets, collapsed, onToggleCollapsed, onNotice, onBeginPlacement, onEndPlacement, contextMenu, onContextMenu, categoryContextMenu, onCategoryContextMenu, onCreateCategory, onDeleteCategory, onRenameAsset, onDuplicateAsset, onDeleteAsset, onChangeAssetColor, onBackupAsset, cloudAssets, cloudAssetPreviews, cloudAssetPreviewErrors, cloudTransfers, cloudTransferErrors, onDownloadCloudAsset, onDeleteCloudAsset }: { assets: VoxelAsset[]; categoryPaths: string[][]; query: string; setQuery: (value: string) => void; selectedAssetIds: string[]; onToggleAssetSelection: (assetId: string) => void; onClearAssetSelection: () => void; onExportAssets: (assetIds: string[]) => void; collapsed: boolean; onToggleCollapsed: () => void; onNotice: (value: string) => void; onBeginPlacement: (asset: VoxelAsset) => void; onEndPlacement: () => void; contextMenu: AssetContextMenuState; onContextMenu: (assetId: string, x: number, y: number) => void; categoryContextMenu: AssetCategoryContextMenuState; onCategoryContextMenu: (path: string[], x: number, y: number) => void; onCreateCategory: (parentPath: string[] | null) => void; onDeleteCategory: (path: string[]) => void; onRenameAsset: (assetId: string) => void; onDuplicateAsset: (assetId: string) => void; onDeleteAsset: (assetId: string, localOnly?: boolean) => void; onChangeAssetColor: (assetId: string, color: string) => void; onBackupAsset: (assetId: string) => void; cloudAssets: CloudAssetSummary[]; cloudAssetPreviews: Record<string, VoxelAsset>; cloudAssetPreviewErrors: Record<string, string>; cloudTransfers: Record<string, CloudProgress>; cloudTransferErrors: Record<string, string>; onDownloadCloudAsset: (asset: CloudAssetSummary) => void; onDeleteCloudAsset: (asset: CloudAssetSummary) => void }) {
  const categoryTree = assetCategoryTreeFromAssetsAndPaths(assets, categoryPaths)
  const [expandedCategoryKeys, setExpandedCategoryKeys] = useState<Record<string, boolean>>({})
  const draggedAssetRef = useRef(false)
  const cloudById = new Map(cloudAssets.map((asset) => [asset.id, asset]))
  const localAssetIds = new Set(assets.map((asset) => asset.id))
  const renderThumbnailShell = (content: React.ReactNode, cloudAsset: CloudAssetSummary | undefined, progressPercent = 100) => <div className={`asset-thumbnail-shell ${cloudAsset ? 'has-cloud-state' : ''}`}>
    {content}
    {cloudAsset && <><Cloud size={12} className="asset-cloud-badge" aria-label="云端实体" /><span className="asset-cloud-dim" style={{ left: `${Math.max(0, Math.min(100, progressPercent))}%` }} /></>}
  </div>
  const renderAssetCard = (asset: VoxelAsset) => {
    const cloudAsset = cloudById.get(asset.id)
    const cloudProgress = cloudTransfers[`upload:asset:${asset.id}`]
    const cloudError = cloudTransferErrors[`upload:asset:${asset.id}`] ?? cloudProgress?.error
    const progressText = cloudError || cloudProgress?.status === 'failed'
      ? `失败 · ${cloudError ?? '上传失败'}`
      : cloudProgress?.status === 'reconnecting'
      ? '正在重连…'
      : cloudProgress
        ? `${Math.round((cloudProgress.transferredBytes / Math.max(1, cloudProgress.transfer.totalBytes)) * 100)}%`
        : null
    return <div className={`asset-card ${cloudAsset ? 'cloud-present' : ''} ${selectedAssetIds.includes(asset.id) ? 'selected' : ''} ${cloudProgress ? 'cloud-uploading' : ''} ${cloudError || cloudProgress?.status === 'failed' ? 'cloud-upload-failed' : ''}`} key={asset.id} role="button" tabIndex={0} onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); draggedAssetRef.current = true; onBeginPlacement(asset) }} onPointerUp={(event) => { if (event.button !== 0) return; event.preventDefault(); draggedAssetRef.current = false; onEndPlacement() }} onPointerCancel={() => { draggedAssetRef.current = false; onEndPlacement() }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(asset.id, event.clientX, event.clientY) }} onClick={() => { if (draggedAssetRef.current) { draggedAssetRef.current = false; return } onNotice('请按住组件拖动到三维场地后放置') }} title="按住拖动到场地放置">
      <label className="asset-select-box" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedAssetIds.includes(asset.id)} onChange={() => onToggleAssetSelection(asset.id)} aria-label={`选择${asset.name}`} /></label>
      {renderThumbnailShell(<VoxelThumbnail asset={asset} />, cloudAsset)}
      <span>{asset.name.replace('·主屋', '')}</span>
      {cloudAsset && <small className="asset-cloud-status"><Cloud size={10} /> 本地 · 云端</small>}
      {progressText && <small className="asset-cloud-progress"><Cloud size={10} /> {progressText}</small>}
    </div>
  }
  const renderCloudAssetCard = (asset: CloudAssetSummary) => {
    const key = `download:asset:${asset.id}`
    const progress = cloudTransfers[key]
    const error = cloudTransferErrors[key] ?? progress?.error
    const active = Boolean(progress && ['queued', 'transferring', 'reconnecting'].includes(progress.status))
    const percent = active && progress ? Math.round((progress.transferredBytes / Math.max(1, progress.transfer.totalBytes)) * 100) : 0
    const failed = Boolean(error) || progress?.status === 'failed'
    const label = failed ? `失败 · ${error ?? '下载失败'}` : progress?.status === 'reconnecting' ? '正在重连…' : progress ? `${percent}%` : '仅云端'
    const preview = cloudAssetPreviews[asset.id]
    const previewContent = preview
      ? <VoxelThumbnail asset={preview} />
      : <div className="thumbnail-scene cloud-thumbnail-placeholder">{cloudAssetPreviewErrors[asset.id] ? '预览加载失败' : '预览加载中…'}</div>
    return <div className={`asset-card cloud-only ${active ? 'cloud-downloading' : ''} ${failed ? 'cloud-download-failed' : ''}`} key={asset.id} role="button" tabIndex={0} onClick={() => { if (!active) onDownloadCloudAsset(asset) }} title={failed ? '点击重试下载' : '点击下载到本地'}>
      <label className="asset-select-box cloud-disabled-select" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><input type="checkbox" disabled aria-label={`云端实体${asset.name}下载后可选择`} /></label>
      {renderThumbnailShell(previewContent, asset, percent)}
      <span>{asset.name.replace('·主屋', '')}</span>
      <small className={`asset-cloud-status ${failed ? 'failed' : ''}`}><Cloud size={10} /> {label}</small>
      <small className="asset-cloud-category">{asset.categoryPath.join(' / ') || '未命名类别'} · {formatBytesUi(asset.sizeBytes)}</small>
      <div className="asset-cloud-actions"><button onClick={(event) => { event.stopPropagation(); onDownloadCloudAsset(asset) }} title={failed ? '重试下载' : '下载云端实体'}><Download size={12} /></button><button className="cloud-delete-button" onClick={(event) => { event.stopPropagation(); onDeleteCloudAsset(asset) }} title="删除云端副本"><Trash2 size={12} /></button></div>
    </div>
  }
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
    <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索组件" /></label>
    {selectedAssetIds.length > 0 && <div className="asset-selection-actions"><span>已选 {selectedAssetIds.length} 个模板实体</span><button onClick={() => onExportAssets(selectedAssetIds)} title="导出选中模板实体"><Download size={12} /></button><button onClick={onClearAssetSelection} title="清除选择"><X size={12} /></button></div>}
    <div className="asset-scroll">
      {categoryTree.length ? categoryTree.map((node) => renderCategoryNode(node)) : <div className="asset-category-empty">资产库暂无类别</div>}
      {cloudAssets.filter((asset) => !localAssetIds.has(asset.id)).length > 0 && <div className="cloud-asset-section"><div className="asset-cloud-heading"><span>云端实体</span><small>{cloudAssets.filter((asset) => !localAssetIds.has(asset.id)).length}</small></div><div className="asset-grid">{cloudAssets.filter((asset) => !localAssetIds.has(asset.id)).map(renderCloudAssetCard)}</div></div>}
    </div>
    </>}
    {categoryContextMenu && <div className="asset-context-menu" style={{ left: categoryContextMenu.x, top: categoryContextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><button onClick={() => onCreateCategory(categoryContextMenu.path)}>新建子类别</button><button onClick={() => onCreateCategory(null)}>新建根类别</button><button className="danger" onClick={() => onDeleteCategory(categoryContextMenu.path)}>删除类别</button></div>}
    {contextMenu && (() => {
      const asset = assets.find((item) => item.id === contextMenu.assetId)
      if (!asset) return null
      const color = /^#[0-9a-f]{6}$/i.test(asset.templateColor ?? asset.color) ? (asset.templateColor ?? asset.color) : '#6c827d'
      return <div className="asset-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}>
        <button onClick={() => onRenameAsset(asset.id)}>重命名</button>
        <button onClick={() => onDuplicateAsset(asset.id)}>创建副本</button>
        <button onClick={() => onExportAssets([asset.id])}>导出实体文件</button>
        {(() => { const pairedCloudAsset = cloudById.get(asset.id); return <button onClick={() => pairedCloudAsset ? onDeleteCloudAsset(pairedCloudAsset) : onBackupAsset(asset.id)}>{pairedCloudAsset ? '从云端删除' : '备份到云端'}</button> })()}
        <label className="asset-context-color"><span>修改颜色</span><input type="color" aria-label="选择资产颜色" value={color} onChange={(event) => onChangeAssetColor(asset.id, event.target.value)} /></label>
        <button className="danger" onClick={() => onDeleteAsset(asset.id, Boolean(cloudById.get(asset.id)))}>删除资产</button>
      </div>
    })()}
  </aside>
}

const MemoizedAssetSidebar = React.memo(AssetSidebar)

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

function ModelImportDialog({ state, targetSizeVoxels, mode, onTargetSizeChange, onModeChange, onStart, onConfirm, onCancel }: { state: ModelImportDialogState; targetSizeVoxels: number; mode: VoxelizeMode; onTargetSizeChange: (value: number) => void; onModeChange: (value: VoxelizeMode) => void; onStart: () => void; onConfirm: () => void; onCancel: () => void }) {
  const result = state.result
  const diagnostics = result?.diagnostics
  const nativeVox = state.file.name.toLowerCase().endsWith('.vox')
  const sizeLabel = result ? `${result.asset.width} × ${result.asset.height} × ${result.asset.depth} 体素` : '尚未生成'
  return <div className="modal-backdrop model-import-dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && !state.busy && onCancel()}>
    <section className="model-import-dialog" role="dialog" aria-modal="true" aria-label="模型转体素">
      <div className="model-import-heading"><div><h2>模型转体素</h2><p>{state.file.name} · 体素网格</p></div><button className="icon-button" aria-label="关闭模型转体素" disabled={state.busy} onClick={onCancel}><X size={17} /></button></div>
      <div className="model-import-body">
        <div className="model-import-settings">
          <label className="model-import-field"><span>目标最大尺寸</span><div><NumericInput min={1} max={MAX_TARGET_SIZE_VOXELS} integer value={targetSizeVoxels} disabled={state.busy || nativeVox} onCommit={onTargetSizeChange} /><em>体素</em></div></label>
          <div className="model-import-field"><span>体素化方式</span><div className="model-import-mode"><button className={mode === 'solid' ? 'active' : ''} disabled={state.busy || nativeVox} onClick={() => onModeChange('solid')}>实体填充</button><button className={mode === 'surface' ? 'active' : ''} disabled={state.busy || nativeVox} onClick={() => onModeChange('surface')}>仅表面</button></div></div>
          <p className="model-import-hint">{nativeVox ? 'VOX 已经是体素格式，将直接读取其体素坐标和颜色，不进行网格采样。' : '模型导入后会作为一个完整实体保存，内部保留全部体素与材质信息；目标最大尺寸指模型包围盒最长边的体素数量。实体填充适合封闭模型；开放模型会提示可能需要手工修补。'}</p>
        </div>
        <div className="model-import-preview"><div className="model-import-preview-title"><span>体素预览</span><span>{sizeLabel}</span></div>{result ? <VoxelMiniPreview voxels={result.asset.voxels} asset={result.asset} exteriorOnly /> : <div className="model-import-empty">设置参数后点击“开始体素化”</div>}</div>
        <div className="model-import-status"><div className="model-import-progress"><span style={{ width: `${Math.round(state.progress * 100)}%` }} /></div><span>{state.progressLabel}{state.busy ? ` · ${Math.round(state.progress * 100)}%` : ''}</span></div>
        {state.error && <div className="model-import-error">{state.error}</div>}
        {diagnostics && <div className="model-import-diagnostics">{diagnostics.sourceFormat === 'vox' ? <span>{diagnostics.voxelCount ?? result?.asset.voxels.length ?? 0} 个体素</span> : <span>{diagnostics.triangleCount} 个三角面</span>}<span>{diagnostics.partCount} 个部件</span>{diagnostics.sourceFormat !== 'vox' && <span>{diagnostics.closedMesh ? '封闭网格' : '开放网格'}</span>}{diagnostics.warnings.map((warning) => <p key={warning}>提示：{warning}</p>)}</div>}
      </div>
      <div className="model-import-actions"><button onClick={onCancel} disabled={state.busy}>取消</button><button onClick={onStart} disabled={state.busy}>{state.busy ? '读取中…' : result ? (nativeVox ? '重新读取' : '重新体素化') : (nativeVox ? '读取 VOX' : '开始体素化')}</button><button className="primary" onClick={onConfirm} disabled={!result || state.busy}>确认并放置</button></div>
    </section>
  </div>
}

const VoxelThumbnail = React.memo(function VoxelThumbnail({ asset }: { asset: VoxelAsset }) {
  const previewAsset = assetPreviewAsset(asset)
  return <div className="thumbnail-scene" aria-label={`${asset.name} 3D 预览`}><VoxelMiniPreview voxels={previewAsset.voxels} asset={previewAsset} exteriorOnly /></div>
})

const previewVoxelArrayIds = new WeakMap<object, number>()
let nextPreviewVoxelArrayId = 1
const EMPTY_PREVIEW_COLORS: Record<string, string> = {}
function previewVoxelArrayId(voxels: Voxel[]): number {
  const existing = previewVoxelArrayIds.get(voxels)
  if (existing) return existing
  const id = nextPreviewVoxelArrayId++
  previewVoxelArrayIds.set(voxels, id)
  return id
}

function previewPartsSignature(parts: SceneEntityPart[]): string {
  const base = parts[0]
    ? {
        x: (parts[0].sceneOffset?.x ?? 0) + (parts[0].partSceneOffset?.x ?? 0),
        y: (parts[0].sceneOffset?.y ?? 0) + (parts[0].partSceneOffset?.y ?? 0),
        z: (parts[0].sceneOffset?.z ?? 0) + (parts[0].partSceneOffset?.z ?? 0),
      }
    : { x: 0, y: 0, z: 0 }
  return parts.map((part) => {
    const offset = {
      x: (part.sceneOffset?.x ?? 0) + (part.partSceneOffset?.x ?? 0) - base.x,
      y: (part.sceneOffset?.y ?? 0) + (part.partSceneOffset?.y ?? 0) - base.y,
      z: (part.sceneOffset?.z ?? 0) + (part.partSceneOffset?.z ?? 0) - base.z,
    }
    return `${part.id}:${previewVoxelArrayId(part.voxels)}:${part.voxels.length}:${offset.x},${offset.y},${offset.z}`
  }).join('|')
}

function previewVoxelsForParts(parts: SceneEntityPart[]): Voxel[] {
  if (!parts.length) return []
  // Inspector previews describe shape, not world position. Remove the
  // common scene translation so moving a large multi-part entity does not
  // allocate/map every voxel again merely because its position changed.
  const base = {
    x: (parts[0].sceneOffset?.x ?? 0) + (parts[0].partSceneOffset?.x ?? 0),
    y: (parts[0].sceneOffset?.y ?? 0) + (parts[0].partSceneOffset?.y ?? 0),
    z: (parts[0].sceneOffset?.z ?? 0) + (parts[0].partSceneOffset?.z ?? 0),
  }
  return parts.flatMap((part) => {
    const offset = {
      x: (part.sceneOffset?.x ?? 0) + (part.partSceneOffset?.x ?? 0) - base.x,
      y: (part.sceneOffset?.y ?? 0) + (part.partSceneOffset?.y ?? 0) - base.y,
      z: (part.sceneOffset?.z ?? 0) + (part.partSceneOffset?.z ?? 0) - base.z,
    }
    if (!offset.x && !offset.y && !offset.z) return part.voxels
    return part.voxels.map((voxel) => ({
      ...voxel,
      x: voxel.x + offset.x,
      y: voxel.y + offset.y,
      z: voxel.z + offset.z,
    }))
  })
}

function SceneLibraryDialog({ library, busy, selectedSceneLoading, selectionRevision, error, selectedSceneId, selectedSceneProject, cloudAssets, cloudScenes, cloudUsage, cloudError, cloudTransfers, cloudTransferErrors, onBackupCurrentScene, onBackupScene, onDownloadCloudScene, onDeleteCloudScene, onClose, onLoadScene, onSelectScene, onSaveSceneEntity, onAddSceneEntityToCurrentScene, onDeleteSceneEntity, contextMenu, onContextMenu, onCloseContextMenu, onDuplicateScene, onDeleteScene }: { library: LibraryResponse; busy: boolean; selectedSceneLoading: boolean; selectionRevision: number; error: string | null; selectedSceneId: string | null; selectedSceneProject: ProjectState | null; cloudAssets: CloudAssetSummary[]; cloudScenes: CloudSceneSummary[]; cloudUsage: CloudUsage | null; cloudError: string | null; cloudTransfers: Record<string, CloudProgress>; cloudTransferErrors: Record<string, string>; onBackupCurrentScene: () => void; onBackupScene: (sceneId: string, name: string) => void | Promise<void>; onDownloadCloudScene: (scene: CloudSceneSummary) => void; onDeleteCloudScene: (scene: CloudSceneSummary) => void; onClose: () => void; onLoadScene: (id: string, name: string) => void; onSelectScene: (id: string, name: string, x: number, y: number) => void; onSaveSceneEntity: (asset: VoxelAsset) => void; onAddSceneEntityToCurrentScene: (asset: VoxelAsset) => void; onDeleteSceneEntity: (sceneId: string, entity: SceneLibraryEntity) => void | Promise<void>; contextMenu: SceneLibraryContextMenuState; onContextMenu: (sceneId: string, x: number, y: number) => void; onCloseContextMenu: () => void; onDuplicateScene: (sceneId: string, name: string) => void; onDeleteScene: (sceneId: string, name: string) => void }) {
  const [entityContextMenu, setEntityContextMenu] = useState<SceneEntityContextMenuState>(null)
  const menuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedSceneParts = useMemo(
    () => {
      if (!selectedSceneProject) return []
      const parts = sceneLibraryPreviewParts(selectedSceneProject)
      return parts
    },
    [selectedSceneProject, selectionRevision],
  )
  const scenePartVoxelDisplayColorResolver = useMemo(
    () => selectedSceneProject ? createScenePartVoxelDisplayColorResolver(selectedSceneProject) : null,
    [selectedSceneProject, selectionRevision],
  )
  const scenePreviewVoxels = useMemo<ScenePreviewInputVoxel[]>(() => {
    if (!selectedSceneProject || !scenePartVoxelDisplayColorResolver) return []
    return selectedSceneParts.flatMap((part) => scenePartVoxels(part).map((voxel) => ({
      x: voxel.x,
      y: voxel.y,
      z: voxel.z,
      color: scenePartVoxelDisplayColorResolver(voxel, part),
      ...(voxelShape(voxel) !== 'cube' ? {
        shape: voxelShape(voxel),
        facing: voxel.facing,
        rotation: voxel.rotation,
      } : {}),
    })))
  }, [selectedSceneProject, selectedSceneParts, scenePartVoxelDisplayColorResolver, selectionRevision])
  const sceneEntityAssetCacheRef = useRef(new Map<string, VoxelAsset>())
  useEffect(() => {
    sceneEntityAssetCacheRef.current.clear()
  }, [selectedSceneId, selectedSceneProject, selectionRevision])
  const contextScene = contextMenu ? library.scenes.find((scene) => scene.id === contextMenu.sceneId) : undefined
  const selectedSceneEntities = useMemo<SceneLibraryEntity[]>(() => {
    if (!selectedSceneProject) return []
    const parts = selectedSceneParts
    const assemblies = selectedSceneProject.assemblies ?? []
    const childAssemblyIds = new Set(assemblies.flatMap((assembly) => assembly.memberKeys
      .filter((memberKey) => memberKey.startsWith('assembly:'))
      .map((memberKey) => memberKey.slice('assembly:'.length))))
    const assemblyMap = new Map(assemblies.map((assembly) => [assembly.id, assembly]))
    const collectAssemblyIds = (assemblyId: string, collected = new Set<string>()) => {
      if (collected.has(assemblyId)) return collected
      collected.add(assemblyId)
      assemblyMap.get(assemblyId)?.memberKeys
        .filter((memberKey) => memberKey.startsWith('assembly:'))
        .forEach((memberKey) => collectAssemblyIds(memberKey.slice('assembly:'.length), collected))
      return collected
    }
    const makeEntity = (id: string, name: string, subtitle: string, entityParts: SceneEntityPart[], assemblyIds: string[]): SceneLibraryEntity | null => {
      if (!entityParts.length) return null
      return {
        id,
        name,
        subtitle,
        partIds: entityParts.map((part) => part.id),
        memberKeys: entityParts.map((part) => part.memberKey),
        instanceIds: [...new Set(entityParts.map((part) => part.instanceId).filter((value): value is string => Boolean(value)))],
        assemblyIds,
      }
    }
    const entities: SceneLibraryEntity[] = []
    assemblies.filter((assembly) => !childAssemblyIds.has(assembly.id)).forEach((assembly) => {
      const assemblyIds = [...collectAssemblyIds(assembly.id)]
      const entityParts = parts.filter((part) => (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).some((assemblyId) => assemblyIds.includes(assemblyId)))
      const entity = makeEntity(`assembly:${assembly.id}`, assembly.name?.trim() || '装配体', `装配体 · ${entityParts.length} 个子实体`, entityParts, assemblyIds)
      if (entity) entities.push(entity)
    })
    parts.filter((part) => !(part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).length).forEach((part) => {
      const name = sceneEntityTreeName(selectedSceneProject, part)
      const entity = makeEntity(part.id, name, `${part.kind === 'custom' ? '手动体素' : '场景实体'} · ${part.sourceVoxelCount ?? part.voxels.length} 个体素`, [part], [])
      if (entity) entities.push(entity)
    })
    return entities
  }, [selectedSceneProject, selectedSceneParts])
  const getSceneEntityAsset = (entity: SceneLibraryEntity): VoxelAsset | null => {
    if (!selectedSceneProject) return null
    const cacheKey = `${selectedSceneId ?? 'none'}:${entity.id}`
    const cached = sceneEntityAssetCacheRef.current.get(cacheKey)
    if (cached) return cached
    const entityPartIds = new Set(entity.partIds)
    const entityParts = sceneEntityParts(selectedSceneProject).filter((part) => entityPartIds.has(part.id) || (part.instanceId && entity.instanceIds.includes(part.instanceId)))
    if (!entityParts.length) return null
    // Only the first voxel is needed to choose the fallback preview color.
    // Avoid materializing the complete scene-coordinate voxel array here;
    // imported models can contain hundreds of thousands of voxels.
    const firstVoxel = scenePartVoxelAt(entityParts[0], 0)
    const color = entityParts.map((part) => part.colorOverride).find(Boolean)
      ?? (firstVoxel ? materialColorForVoxel(selectedSceneProject, firstVoxel) : '#6c827d')
    // Scene-library assembly rows are saved through a different path from
    // the inspector's “保存为模板实体” action.  The old path flattened all
    // selected parts into one VoxelAsset and dropped ProjectState.assemblies,
    // so dragging the saved asset back produced the right voxels but no file
    // tree children.  Store the selected assembly tree in the same portable
    // asset format used by the inspector path.
    const rootAssemblyId = entity.id.startsWith('assembly:')
      ? entity.id.slice('assembly:'.length)
      : undefined
    const colorizedParts = entityParts.map((part) => ({
      ...part,
      sceneOffset: undefined,
      partSceneOffset: undefined,
      voxels: scenePartVoxels(part).map((voxel) => ({
        ...voxel,
        materialId: scenePartVoxelDisplayColorResolver?.(voxel, part) ?? voxel.materialId,
      })),
    }))
    const makeAssemblyAsset = (rootId: string): VoxelAsset | null => makeAssemblyAssetFromSceneParts(
      `scene-library-assembly-${rootId}`,
      entity.name,
      selectedSceneProject,
      colorizedParts,
      rootId,
      color,
      '#d2a354',
      '场景库装配体保存',
    )
    const asset = rootAssemblyId
      ? (makeAssemblyAsset(rootAssemblyId) ?? makeAssetFromSceneParts(
        `scene-library-${entity.id}`,
        entity.name,
        colorizedParts,
        color,
        '#d2a354',
        scenePartVoxelDisplayColorResolver ?? undefined,
      ))
      : makeAssetFromSceneParts(
        `scene-library-${entity.id}`,
        entity.name,
        colorizedParts,
        color,
        '#d2a354',
        scenePartVoxelDisplayColorResolver ?? undefined,
      )
    sceneEntityAssetCacheRef.current.set(cacheKey, asset)
    return asset
  }
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
  const openEntityMenu = (event: React.MouseEvent<HTMLButtonElement>, entityId: string) => {
    event.preventDefault()
    event.stopPropagation()
    cancelMenuClose()
    onCloseContextMenu()
    setEntityContextMenu({ entityId, x: event.clientX + 8, y: event.clientY + 8 })
  }
  const closeMenus = () => {
    cancelMenuClose()
    onCloseContextMenu()
    setEntityContextMenu(null)
  }
  useEffect(() => () => cancelMenuClose(), [])
  const sceneUploadProgress = Object.values(cloudTransfers).find((progress) => progress.transfer.direction === 'upload' && progress.transfer.objectKind === 'scene' && ['queued', 'transferring', 'reconnecting', 'failed'].includes(progress.status))
  const sceneUploadActive = sceneUploadProgress && ['queued', 'transferring', 'reconnecting'].includes(sceneUploadProgress.status)
  const sceneUploadError = sceneUploadProgress?.status === 'failed' ? (cloudTransferErrors[`upload:scene:${sceneUploadProgress.transfer.objectId}`] ?? sceneUploadProgress.error) : undefined
  return <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="library-dialog" role="dialog" aria-modal="true" aria-label="场景库" onPointerDown={(event) => { const target = event.target as HTMLElement; if (!target.closest('button, input, .scene-library-context-menu')) closeMenus() }}>
      <div className="library-dialog-heading"><div><h2>场景库</h2><p>场景文件与场景实体由当前工程自动管理</p></div><button className="icon-button" aria-label="关闭场景库" onClick={onClose}><X size={17} /></button></div>
      <div className="library-dialog-toolbar"><span>{error ? '场景库暂时无法访问' : `${library.scenes.length} 个本地场景 · ${cloudScenes.length} 个云端场景 · ${selectedSceneId ? `${selectedSceneProject ? selectedSceneParts.length : '…'} 个实体` : '未选择场景'}`}</span><div className="library-toolbar-actions"><button className="tiny-button" onClick={onBackupCurrentScene} disabled={Boolean(sceneUploadActive)}><Cloud size={13} /> {sceneUploadError ? `备份失败 · ${sceneUploadError}` : sceneUploadProgress?.status === 'reconnecting' ? '正在重连…' : sceneUploadActive ? `备份 ${Math.round((sceneUploadProgress.transferredBytes / Math.max(1, sceneUploadProgress.transfer.totalBytes)) * 100)}%` : '备份当前场景'}</button></div></div>
      {cloudUsage && <div className="cloud-usage-strip"><span>云端资产 {formatBytesUi(cloudUsage.assetBytes)} / {formatBytesUi(cloudUsage.assetQuotaBytes)}</span><span>云端场景 {formatBytesUi(cloudUsage.sceneBytes)} / {formatBytesUi(cloudUsage.sceneQuotaBytes)}</span></div>}
      {cloudError && <div className="cloud-error-strip"><Cloud size={13} /> 云端暂不可用：{cloudError}</div>}
      {error && <div className="library-error" role="alert"><span>加载失败：{error}</span><button className="tiny-button" onClick={() => window.location.reload()}>刷新页面重试</button></div>}
      <div className="library-columns">
        <div className="library-column library-scene-column">
          <div className="library-column-title">场景</div>
          <div className="library-scene-list">{library.scenes.length ? library.scenes.map((scene) => {
            // A selected scene has already gone through the same full scene
            // entity builder used by the right-hand list. Prefer that live
            // count over a legacy D1 summary, so old records immediately show
            // the corrected count without requiring a re-save.
            // The right pane intentionally shows one row per top-level
            // assembly, but the scene summary must count its leaf entities.
            // Using selectedSceneEntities.length here turns an assembly with
            // five children into “one entity” (or two root assemblies into
            // “two entities”) after the scene is opened.
            const entityCount = selectedSceneId === scene.id && selectedSceneProject ? selectedSceneParts.length : scene.entityCount
            return <button className={`library-row ${selectedSceneId === scene.id ? 'selected' : ''}`} data-scene-id={scene.id} key={scene.id} onClick={openSceneMenu} onContextMenu={openSceneMenu}><div><strong>{scene.name}</strong><span>{scene.assemblyCount} 个装配体 · {entityCount} 个实体</span></div><div className="library-row-actions"><ChevronRight size={15} /></div></button>
          }) : null}
          {cloudScenes.length > 0 && <div className="cloud-scene-list"><div className="cloud-list-title"><Cloud size={13} /> 云端场景</div>{cloudScenes.map((scene) => {
            const key = `download:scene:${scene.id}`
            const progress = cloudTransfers[key]
            const error = cloudTransferErrors[key] ?? progress?.error
            const active = progress && ['queued', 'transferring', 'reconnecting'].includes(progress.status)
            const failed = Boolean(error) || progress?.status === 'failed'
            const label = failed ? `失败 · ${error ?? '下载失败'}` : progress?.status === 'reconnecting' ? '正在重连…' : progress ? `${Math.round((progress.transferredBytes / Math.max(1, progress.transfer.totalBytes)) * 100)}%` : null
            return <div className={`library-row cloud-row ${active ? 'transferring' : ''} ${failed ? 'failed' : ''}`} key={`cloud:${scene.id}`}><div><strong><Cloud size={13} /> {scene.name}</strong><span>{scene.assemblyCount ?? 0} 个装配体 · {scene.entityCount ?? scene.instanceCount ?? 0} 个实体 · {formatBytesUi(scene.sizeBytes)}</span>{label && <em className={failed ? 'cloud-transfer-error' : ''}>{label}</em>}</div><div className="library-row-actions">{active ? <span className="cloud-progress-label">{label}</span> : <><button onClick={() => onDownloadCloudScene(scene)} title={failed ? '重试下载' : '下载云端场景'}><Download size={13} /></button><button onClick={() => onDeleteCloudScene(scene)} title="删除云端副本"><Trash2 size={13} /></button></>}</div></div>
          })}</div>}
          {!library.scenes.length && !cloudScenes.length && <div className="empty-panel">尚无本地或云端场景</div>}
          </div>
          <div className="library-scene-preview" aria-label="选中场景完整预览">
            {selectedSceneProject && scenePreviewVoxels.length ? <SceneLibraryPreview key={`${selectedSceneId ?? selectedSceneProject.name}:${selectionRevision}`} cacheKey={`${selectedSceneId ?? selectedSceneProject.name}:${selectionRevision}`} voxels={scenePreviewVoxels} maxVoxels={SCENE_LIBRARY_PREVIEW_MAX_VOXELS} /> : selectedSceneId && selectedSceneLoading ? <div className="empty-panel">正在加载场景预览…</div> : <div className="empty-panel">请选择场景查看完整预览</div>}
          </div>
        </div>
        <div className="library-column"><div className="library-column-title">实体</div>{!selectedSceneId ? <div className="empty-panel">请选择场景查看实体</div> : selectedSceneLoading && !selectedSceneProject ? <div className="empty-panel">正在加载场景实体…</div> : selectedSceneEntities.length ? selectedSceneEntities.map((entity) => <button className="library-row" key={entity.id} onClick={(event) => openEntityMenu(event, entity.id)} onContextMenu={(event) => openEntityMenu(event, entity.id)}><div><strong>{entity.name}</strong><span>{entity.subtitle}</span></div><ChevronRight size={15} /></button>) : <div className="empty-panel">当前场景没有可显示的实体</div>}</div>
      </div>
      {contextScene && contextMenu && <div className="scene-library-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerEnter={cancelMenuClose} onPointerLeave={scheduleMenuClose} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><button onClick={() => { closeMenus(); onLoadScene(contextScene.id, contextScene.name) }}>打开场景</button><button onClick={() => { closeMenus(); void onBackupScene(contextScene.id, contextScene.name) }}>备份到云端</button><button onClick={() => { closeMenus(); onDuplicateScene(contextScene.id, contextScene.name) }}>创建副本</button><button className="danger" onClick={() => { closeMenus(); onDeleteScene(contextScene.id, contextScene.name) }}>删除场景</button></div>}
      {entityContextMenu && selectedSceneId && (() => {
        const entity = selectedSceneEntities.find((item) => item.id === entityContextMenu.entityId)
        if (!entity) return null
        return <div className="scene-library-context-menu" style={{ left: entityContextMenu.x, top: entityContextMenu.y }} onPointerEnter={cancelMenuClose} onPointerLeave={scheduleMenuClose} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><button onClick={() => { const asset = getSceneEntityAsset(entity); closeMenus(); if (asset) onSaveSceneEntity(asset) }}>保存到当前资产库</button><button onClick={() => { const asset = getSceneEntityAsset(entity); closeMenus(); if (asset) onAddSceneEntityToCurrentScene(asset) }}>添加到当前场景</button><button className="danger" onClick={() => { closeMenus(); onDeleteSceneEntity(selectedSceneId, entity) }}>删除该实体</button></div>
      })()}
      {busy && <div className="library-loading">正在访问场景库…</div>}
    </section>
  </div>
}

function UnsavedChangesDialog({ onDecision }: { onDecision: (decision: UnsavedDecision) => void | Promise<void> }) {
  return <div className="modal-backdrop unsaved-modal-backdrop"><section className="unsaved-dialog" role="dialog" aria-modal="true" aria-label="保存当前场景"><h2>当前场景有未保存改动</h2><p>继续操作前，是否先保存当前场景？</p><div className="unsaved-dialog-actions"><button onClick={() => onDecision('cancel')}>取消</button><button onClick={() => onDecision('discard')}>否</button><button className="primary" onClick={() => onDecision('save')}>是</button></div></section></div>
}

function LineToolIcon() {
  return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 18.5 17.5 5" />
    <path d="m14.5 4.5 5 5" />
    <path d="m16 3 5 5-2 2-5-5z" />
  </svg>
}

function SphereToolIcon() {
  return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round">
    <circle cx="12" cy="12" r="8.2" />
    <path d="M3.9 12h16.2" />
    <path d="M12 3.8c2.5 2.1 3.8 4.8 3.8 8.2s-1.3 6.1-3.8 8.2c-2.5-2.1-3.8-4.8-3.8-8.2s1.3-6.1 3.8-8.2Z" />
  </svg>
}

function ExtrudeToolIcon() {
  return <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="7.5" width="9.5" height="9.5" />
    <rect x="10.5" y="4" width="10" height="10" strokeDasharray="2.2 2.2" />
    <path d="M13.4 12h4" strokeDasharray="2.2 2.2" />
  </svg>
}

function ReferenceImagePopover({ open, image, index, count, onPrevious, onNext, onClose, onOpen }: { open: boolean; image: { name: string; url: string } | null; index: number; count: number; onPrevious: () => void; onNext: () => void; onClose: () => void; onOpen: () => void }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: 360, height: 430 })
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const resizeRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number } | null>(null)

  if (!open || !image) return null

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const deltaX = event.clientX - drag.x
    const deltaY = event.clientY - drag.y
    if (deltaX || deltaY) setOffset((current) => ({ x: current.x + deltaX, y: current.y + deltaY }))
    drag.x = event.clientX
    drag.y = event.clientY
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: size.width, height: size.height }
  }
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    setSize({
      width: Math.max(240, Math.min(760, resize.width + event.clientX - resize.x)),
      height: Math.max(180, Math.min(760, resize.height + event.clientY - resize.y)),
    })
  }
  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    resizeRef.current = null
  }

  return <section className="reference-image-popover" style={{ width: `${size.width}px`, height: `${size.height}px`, transform: `translate(${offset.x}px, ${offset.y}px)` }} aria-label="参考图" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <div className="reference-image-header">
      <div className="reference-image-drag-handle" role="button" tabIndex={0} aria-label="拖动参考图" title="按住拖动参考图" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { dragRef.current = null }}>
        <span className="reference-image-grip" aria-hidden="true"><i /><i /><i /></span>
        <strong>参考图</strong>
        <span className="reference-image-name" title={image.name}>{image.name}</span>
      </div>
      <div className="reference-image-nav" aria-label="切换参考图">
        <button type="button" aria-label="上一张参考图" title="上一张参考图" disabled={count < 2} onPointerDown={(event) => event.stopPropagation()} onClick={onPrevious}><ChevronLeft size={14} /></button>
        <span>{index + 1}/{count}</span>
        <button type="button" aria-label="下一张参考图" title="下一张参考图" disabled={count < 2} onPointerDown={(event) => event.stopPropagation()} onClick={onNext}><ChevronRight size={14} /></button>
      </div>
      <div className="reference-image-actions">
        <button type="button" aria-label="添加或更换参考图" title="添加或更换参考图" onPointerDown={(event) => event.stopPropagation()} onClick={onOpen}><Repeat2 size={14} /></button>
        <button type="button" aria-label="关闭参考图" title="关闭参考图" onPointerDown={(event) => event.stopPropagation()} onClick={onClose}><X size={14} /></button>
      </div>
    </div>
    <div className="reference-image-canvas">
      <img src={image.url} alt={`参考图：${image.name}`} draggable={false} />
    </div>
    <div className="reference-image-resize-handle" role="button" tabIndex={0} aria-label="调整参考图窗口大小" title="拖动调整窗口大小" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={() => { resizeRef.current = null }} />
  </section>
}

function ToolboxPopover({ open, onClose, tool, drawingPlane, drawOperation, brushSize, voxelBrushShape, onToolChange, onPlaneChange, onOperationChange, onBrushSizeChange, onBrushShapeChange }: { open: boolean; onClose: () => void; tool: Tool; drawingPlane: DrawingPlane; drawOperation: DrawOperation; brushSize: number; voxelBrushShape: VoxelShape; onToolChange: (tool: Tool) => void; onPlaneChange: (plane: DrawingPlane) => void; onOperationChange: (operation: DrawOperation) => void; onBrushSizeChange: (size: number) => void; onBrushShapeChange: (shape: VoxelShape) => void }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const dragHandleRef = useRef<HTMLDivElement | null>(null)
  if (!open) return null
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragHandleRef.current = event.currentTarget
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const deltaX = event.clientX - drag.x
    const deltaY = event.clientY - drag.y
    if (deltaX || deltaY) setOffset((current) => ({ x: current.x + deltaX, y: current.y + deltaY }))
    drag.x = event.clientX
    drag.y = event.clientY
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
  }
  return <section className="toolbox-popover" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }} aria-label="工具箱" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <div className="toolbox-header">
      <div ref={dragHandleRef} className="toolbox-drag-handle" role="button" tabIndex={0} aria-label="拖动工具箱" title="按住拖动工具箱" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { dragRef.current = null }}>
        <span className="toolbox-grip-dots" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</span>
      </div>
      <strong>工具箱</strong>
      <button className="toolbox-close" aria-label="关闭工具箱" title="关闭工具箱" onPointerDown={(event) => event.stopPropagation()} onClick={onClose}><X size={14} /></button>
    </div>
    <div className="toolbox-grid">
      {([
        ['brush', <Paintbrush size={15} />, '手动绘制'],
        ['erase', <Trash2 size={15} />, '快速擦除'],
        ['line', <LineToolIcon />, '直线绘制'],
        ['cuboid', <Square size={15} />, '长方体'],
        ['sphere', <SphereToolIcon />, '球体'],
        ['extrude', <ExtrudeToolIcon />, '实体拉伸'],
      ] as Array<[Tool, React.ReactNode, string]>).map(([id, icon, label]) => <button key={id} className={`toolbox-tool ${tool === id ? 'active' : ''}`} onClick={() => onToolChange(id)}>{icon}<span>{label}</span></button>)}
    </div>
    <div className="toolbox-options">
      {(['brush', 'erase', 'line'] as Tool[]).includes(tool) && <label>绘制平面 <select value={drawingPlane} onChange={(event) => onPlaneChange(event.target.value as DrawingPlane)}><option value="xy">XZ</option><option value="xz">XY</option><option value="yz">YZ</option></select></label>}
      {(tool === 'brush' || tool === 'erase' || tool === 'line') && <label>笔刷大小 <input type="range" min="1" max="100" value={brushSize} onChange={(event) => onBrushSizeChange(Number(event.target.value))} /><output>{brushSize}</output></label>}
      {(['brush', 'line', 'cuboid', 'sphere'] as Tool[]).includes(tool) && <label>体素形状 <select value={voxelBrushShape} onChange={(event) => onBrushShapeChange(event.target.value as VoxelShape)}><option value="cube">立方体</option><option value="tri-prism">三棱柱</option><option value="quarter-cylinder">1/4 圆柱</option><option value="stair">阶梯</option></select></label>}
      {(['brush', 'line', 'cuboid', 'sphere', 'extrude'] as Tool[]).includes(tool) && <div className="toolbox-mode"><span>绘制模式</span>{(['add', 'subtract', 'paint'] as DrawOperation[]).map((mode) => <button key={mode} className={drawOperation === mode ? 'active' : ''} onClick={() => onOperationChange(mode)}>{mode === 'add' ? '加' : mode === 'subtract' ? '减' : '改色'}</button>)}</div>}
    </div>
  </section>
}

function ToolButton({ icon, label, description, active, onClick }: { icon: React.ReactNode; label: string; description: string; active: boolean; onClick: () => void }) {
  return <button className={`tool-button ${active ? 'active' : ''}`} data-tooltip={description} aria-label={label} onClick={onClick} title={description}>{icon}</button>
}

function Inspector({ entityName, source, selectedAsset, selectedPart, selectedParts, selectedTransformSignature, editEntityId, canEnterEditMode, editTargetId, selectedColor, previewColor, previewVoxelColors, previewMaterialColors, copyPreview, transformPreview, geometryPreview, shellThicknessOptions, scaleOptions, onChangeColor, onPreviewHsl, onCommitHsl, onMirror, onRotate, onConfirmTransform, onCancelTransform, onExport, onExportGlb, onExportVox, onExportEntityFile, onOpenSlicer, onDuplicate, onChangeCopyDirection, onChangeCopyGap, onConfirmDuplicate, onCancelDuplicate, onStartShell, onStartScale, onChangeShellThickness, onChangeScale, onConfirmGeometry, onCancelGeometry, onDelete, onSaveAsAsset, onEnterEditMode }: { entityName: string; source: string; selectedAsset?: VoxelAsset; selectedPart?: SceneEntityPart; selectedParts: SceneEntityPart[]; selectedTransformSignature: string; editEntityId: string | null; canEnterEditMode: boolean; editTargetId: string; selectedColor: string; previewColor?: string; previewVoxelColors: Record<string, string>; previewMaterialColors: Record<string, string>; copyPreview: CopyPreviewState | null; transformPreview: DiscreteTransformPreviewState | null; geometryPreview: GeometryPreviewState | null; shellThicknessOptions: number[]; scaleOptions: { up: number[]; down: number[] }; onChangeColor: (color: string) => void; onPreviewHsl: (hueDelta: number, saturationTarget: number) => void; onCommitHsl: (hueDelta: number, saturationTarget: number) => void; onMirror: (axis: 'x' | 'y' | 'z') => void; onRotate: (axis: 'x' | 'y' | 'z', degrees: 90 | 180 | 270) => void; onConfirmTransform: () => void; onCancelTransform: () => void; onExport: () => void; onExportGlb: () => void | Promise<void>; onExportVox: () => void; onExportEntityFile: () => void; onOpenSlicer: () => void; onDuplicate: (count: number) => void; onChangeCopyDirection: (axis: CopyDirectionAxis, sign: 1 | -1) => void; onChangeCopyGap: (gap: number) => void; onConfirmDuplicate: () => void; onCancelDuplicate: () => void; onStartShell: () => void; onStartScale: (mode: GeometryScaleMode) => void; onChangeShellThickness: (value: number) => void; onChangeScale: (mode: GeometryScaleMode, value: number) => void; onConfirmGeometry: () => void; onCancelGeometry: () => void; onDelete: () => void; onSaveAsAsset: () => void; onEnterEditMode: (entityId: string) => void }) {
  const [copyCount, setCopyCount] = useState(1)
  const [mirrorAxis, setMirrorAxis] = useState<'x' | 'y' | 'z'>('x')
  const [rotateAxis, setRotateAxis] = useState<'x' | 'y' | 'z'>('z')
  const [rotateDegrees, setRotateDegrees] = useState<90 | 180 | 270>(90)
  const selectedPartsKey = selectedParts.map((part) => part.id).join('|')
  const mirrorPreviewActive = transformPreview?.mode === 'mirror'
  const rotatePreviewActive = transformPreview?.mode === 'rotate'
  const chooseMirrorAxis = (axis: 'x' | 'y' | 'z') => {
    setMirrorAxis(axis)
    if (transformPreview) onCancelTransform()
  }
  const chooseRotateAxis = (axis: 'x' | 'y' | 'z') => {
    setRotateAxis(axis)
    if (transformPreview) onCancelTransform()
  }
  const chooseRotateDegrees = (degrees: 90 | 180 | 270) => {
    setRotateDegrees(degrees)
    if (transformPreview) onCancelTransform()
  }
  useEffect(() => {
    // Axis/angle choices are operation-local. Selecting another entity or
    // clearing the scene selection must leave no pending transform choice
    // attached to the next entity.
    setMirrorAxis('x')
    setRotateAxis('z')
    setRotateDegrees(90)
  }, [selectedPartsKey, selectedTransformSignature])
  const previewKey = previewPartsSignature(selectedParts)
  const geometryResultVoxels = geometryPreview?.result?.voxels
  const previewVoxels = useMemo(
    () => geometryResultVoxels?.length ? geometryResultVoxels : previewVoxelsForParts(selectedParts),
    [geometryResultVoxels, previewKey],
  )
  // Geometry results already contain resolved per-voxel display colors. Do
  // not let the old asset/template color override recolor a shell/scale
  // preview or make a hollow result look like the source model.
  const previewAsset = geometryResultVoxels?.length ? undefined : selectedAsset
  const previewColorOverride = geometryResultVoxels?.length ? undefined : previewColor
  const previewVoxelColorMap = geometryResultVoxels?.length ? EMPTY_PREVIEW_COLORS : previewVoxelColors
  return <aside className="inspector">
    <div className="inspector-section entity-summary-section">
      <div className="inspector-inline-field"><span className="inspector-inline-label">选中实体</span><div className="select-field entity-name-field">{entityName}</div></div>
      <div className="inspector-inline-field"><span className="inspector-inline-label">来源</span><div className="input-field muted-field">{source}</div></div>
      <div className="entity-preview"><VoxelMiniPreview voxels={previewVoxels} asset={previewAsset} colorOverride={previewColorOverride} voxelColors={previewVoxelColorMap} materialColors={previewMaterialColors} exteriorOnly /></div>
      {canEnterEditMode && <button className="enter-edit-button" onClick={() => onEnterEditMode(editTargetId)}>进入编辑模式</button>}
    </div>
    {selectedParts.length > 0 && <>
      <div className="inspector-section color-section">
        <div className="section-heading"><span>颜色</span><span className="instance-label">实体覆盖色</span></div>
        <ColorEditor color={selectedColor} disabled={false} onChange={onChangeColor} onPreviewHsl={onPreviewHsl} onCommitHsl={onCommitHsl} />
      </div>
      <div className="inspector-section entity-actions-section">
      <div className="section-heading"><span>实体操作</span><span className="instance-label">{selectedParts.length} 个实体</span></div>
      <div className="entity-actions">
        <div className="entity-transform-operation copy-entity-row"><span className="copy-entity-label">复制实体</span><div className="copy-count-choice"><button disabled={Boolean(copyPreview)} onClick={() => setCopyCount((value) => Math.max(1, value - 1))} title="减少复制数量">−</button><span className="copy-entity-count">{copyPreview?.count ?? copyCount}</span><button disabled={Boolean(copyPreview)} onClick={() => setCopyCount((value) => Math.min(99, value + 1))} title="增加复制数量">＋</button></div>{copyPreview ? <button className="operation-confirm copy-confirm" onClick={onCancelDuplicate}>取消</button> : <button className="operation-confirm copy-confirm" onClick={() => onDuplicate(copyCount)}>预览</button>}</div>
        {copyPreview && <div className="copy-preview-panel"><div className="copy-preview-title">复制方向</div><div className="copy-preview-axis">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={copyPreview.axis === axis ? 'active' : ''} onClick={() => onChangeCopyDirection(axis, copyPreview.sign)}>{axis.toUpperCase()}</button>)}<button className={copyPreview.sign === 1 ? 'active' : ''} onClick={() => onChangeCopyDirection(copyPreview.axis, 1)}>正向 +</button><button className={copyPreview.sign === -1 ? 'active' : ''} onClick={() => onChangeCopyDirection(copyPreview.axis, -1)}>负向 −</button></div><div className="copy-preview-gap"><span>实体间隔</span><button disabled={copyPreview.gap <= 0} onClick={() => onChangeCopyGap(copyPreview.gap - 1)}>−</button><strong>{copyPreview.gap}</strong><button disabled={copyPreview.gap >= 99} onClick={() => onChangeCopyGap(copyPreview.gap + 1)}>＋</button><em>体素</em></div><div className={`copy-preview-status ${copyPreview.valid ? 'valid' : 'invalid'}`}>{copyPreview.valid ? `预览有效 · 将生成 ${copyPreview.count} 个复制实体` : copyPreview.invalidReason === 'collision' ? '预览与已有实体重叠，无法生成' : '预览超出场景边界，无法生成'}</div><button className="operation-confirm copy-preview-generate" onClick={onConfirmDuplicate}>生成复制实体</button></div>}
        <div className="entity-transform-operation"><span>镜像实体</span><div className="axis-choice">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={mirrorAxis === axis ? 'active' : ''} onClick={() => chooseMirrorAxis(axis)}>{axis.toUpperCase()}</button>)}</div><button className="operation-confirm" disabled={mirrorPreviewActive} onClick={() => onMirror(mirrorAxis)}>{mirrorPreviewActive ? '预览中' : '预览'}</button></div>
        <div className="entity-transform-operation"><span>旋转实体</span><div className="axis-choice">{(['x', 'y', 'z'] as const).map((axis) => <button key={axis} className={rotateAxis === axis ? 'active' : ''} onClick={() => chooseRotateAxis(axis)}>{axis.toUpperCase()}</button>)}</div><div className="degree-choice">{([90, 180, 270] as const).map((degrees) => <button key={degrees} className={rotateDegrees === degrees ? 'active' : ''} onClick={() => chooseRotateDegrees(degrees)}>{degrees}°</button>)}</div><button className="operation-confirm" disabled={rotatePreviewActive} onClick={() => onRotate(rotateAxis, rotateDegrees)}>{rotatePreviewActive ? '预览中' : '预览'}</button></div>
        {transformPreview && <div className="copy-preview-panel transform-preview-panel"><div className="copy-preview-title">{transformPreview.mode === 'mirror' ? '镜像预览' : '旋转预览'}</div><div className={`copy-preview-status ${transformPreview.valid ? 'valid' : 'invalid'}`}>{transformPreview.valid ? '预览有效 · 可以应用' : transformPreview.invalidReason === 'collision' ? '预览与已有实体重叠，无法应用' : '预览超出场景边界，无法应用'}</div><div className="geometry-preview-actions"><button onClick={onCancelTransform}>取消</button><button className="operation-confirm" disabled={!transformPreview.valid} onClick={onConfirmTransform}>确认应用</button></div></div>}
        {!geometryPreview && !transformPreview && <>
          <div className="entity-transform-operation"><span>去除内部</span><button className="operation-confirm" disabled={!selectedParts.length} onClick={onStartShell}>预览</button></div>
          <div className="entity-transform-operation"><span>整体放大</span><button className="operation-confirm" disabled={!selectedParts.length || !scaleOptions.up.length} onClick={() => onStartScale('up')}>预览</button></div>
          <div className="entity-transform-operation"><span>整体缩小</span><button className="operation-confirm" disabled={!selectedParts.length || !scaleOptions.down.length} onClick={() => onStartScale('down')}>预览</button></div>
        </>}
        {geometryPreview && <div className="geometry-preview-panel">
            {geometryPreview.operation === 'shell' && <><label className="geometry-field"><span>壳厚度</span><div className="geometry-number-field"><NumericInput aria-label="壳厚度" min={1} max={Math.max(1, shellThicknessOptions.at(-1) ?? 1)} integer value={geometryPreview.shellThickness} onCommit={onChangeShellThickness} /><em>体素层</em></div></label><div className="geometry-range">有效范围：1–{Math.max(1, shellThicknessOptions.at(-1) ?? 1)} 层</div></>}
            {geometryPreview.operation === 'scale' && <><div className="geometry-choice-row"><button className={geometryPreview.scaleMode === 'up' ? 'active' : ''} onClick={() => onStartScale('up')}>放大 ×</button><button className={geometryPreview.scaleMode === 'down' ? 'active' : ''} onClick={() => onStartScale('down')}>缩小 ÷</button></div><label className="geometry-field"><span>倍率</span><select value={geometryPreview.scaleFactor} onChange={(event) => onChangeScale(geometryPreview.scaleMode, Number(event.target.value))}>{scaleOptions[geometryPreview.scaleMode].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><div className="geometry-range">可用放大：{scaleOptions.up.length ? scaleOptions.up.map((value) => `${value}×`).join('、') : '无'} · 可用缩小：{scaleOptions.down.length ? scaleOptions.down.map((value) => `1/${value}`).join('、') : '无'}</div></>}
            <div className={`geometry-preview-status ${geometryPreview.valid ? 'valid' : 'invalid'}`}>{geometryPreview.result ? `${geometryPreview.valid ? '预览有效' : '不可应用'} · ${geometryPreview.result.voxelCount} 个体素${geometryPreview.result.bounds ? ` · ${geometryPreview.result.bounds.width} × ${geometryPreview.result.bounds.height} × ${geometryPreview.result.bounds.depth}` : ''}` : geometryPreview.invalidReason}</div>
            {geometryPreview.result && !geometryPreview.valid && geometryPreview.invalidReason && <div className="geometry-warning">{geometryPreview.invalidReason}</div>}
            {geometryPreview.result?.warnings.map((warning) => <div className="geometry-warning" key={warning}>{warning}</div>)}
            <div className="geometry-preview-actions"><button onClick={onCancelGeometry}>取消</button><button className="operation-confirm" disabled={!geometryPreview.valid} onClick={onConfirmGeometry}>确认应用</button></div>
          </div>}
        <button onClick={onSaveAsAsset}><Save size={14} /> 保存为模板实体</button>
        <button className="danger-action" onClick={onDelete}><Trash2 size={14} /> 删除实体</button>
        <ExportMenu label="导出实体" onExportStl={onExport} onExportGlb={onExportGlb} onExportVox={onExportVox} onExportEntityFile={onExportEntityFile} />
        <button className="slice-action" disabled={!selectedParts.length} onClick={onOpenSlicer}><Layers3 size={14} /> 模型实体模型切片</button>
      </div>
      </div>
    </>}
  </aside>
}

type InspectorProps = Parameters<typeof Inspector>[0]

function inspectorPartsSignature(parts: SceneEntityPart[]): string {
  return parts.map((part) => {
    const root = part.sceneOffset ?? { x: 0, y: 0, z: 0 }
    const local = part.partSceneOffset ?? { x: 0, y: 0, z: 0 }
    return [
      part.id,
      part.kind,
      part.instanceId ?? '',
      part.partId,
      previewVoxelArrayId(part.voxels),
      part.voxels.length,
      root.x + local.x,
      root.y + local.y,
      root.z + local.z,
      part.colorOverride ?? '',
    ].join(':')
  }).join('|')
}

function inspectorAssetSignature(asset?: VoxelAsset): string {
  if (!asset) return ''
  return [asset.id, previewVoxelArrayId(asset.voxels), asset.voxels.length, asset.color, asset.accent, asset.templateColor ?? ''].join(':')
}

function sameNumberArray(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameScaleOptions(left: InspectorProps['scaleOptions'], right: InspectorProps['scaleOptions']): boolean {
  return sameNumberArray(left.up, right.up) && sameNumberArray(left.down, right.down)
}

function inspectorPropsEqual(previous: InspectorProps, next: InspectorProps): boolean {
  // Pointer movement updates the viewport imperatively. The inspector only
  // needs to publish the committed position once the gesture is released.
  // Ignore callback identity: these callbacks are event handlers owned by App
  // and the rendered inspector state below is compared explicitly, avoiding
  // stale visual state without forcing a panel render on every parent update.
  return previous.entityName === next.entityName
    && previous.source === next.source
    && inspectorAssetSignature(previous.selectedAsset) === inspectorAssetSignature(next.selectedAsset)
    && inspectorPartsSignature(previous.selectedParts) === inspectorPartsSignature(next.selectedParts)
    && previous.selectedTransformSignature === next.selectedTransformSignature
    && previous.editEntityId === next.editEntityId
    && previous.canEnterEditMode === next.canEnterEditMode
    && previous.editTargetId === next.editTargetId
    && previous.selectedColor === next.selectedColor
    && previous.previewColor === next.previewColor
    && previous.previewVoxelColors === next.previewVoxelColors
    && previous.previewMaterialColors === next.previewMaterialColors
    && previous.copyPreview === next.copyPreview
    && previous.transformPreview === next.transformPreview
    && previous.geometryPreview === next.geometryPreview
    && sameNumberArray(previous.shellThicknessOptions, next.shellThicknessOptions)
    && sameScaleOptions(previous.scaleOptions, next.scaleOptions)
}

const MemoizedInspector = React.memo(Inspector, inspectorPropsEqual)

function sliceCoordinates(plane: SlicePlane, voxel: SliceVoxel): { u: number; v: number } {
  if (plane === 'xy') return { u: voxel.x, v: voxel.y }
  if (plane === 'xz') return { u: voxel.x, v: voxel.z }
  return { u: voxel.y, v: voxel.z }
}

type SliceCanvasOptions = {
  maxPixels?: number
  cellSize?: number
  includeLabel?: boolean
}

function drawSliceCanvas(layer: SliceLayer, options: SliceCanvasOptions = {}): HTMLCanvasElement {
  const padding = 24
  const maxDimension = Math.max(layer.width, layer.height)
  const maxPixels = options.maxPixels ?? 1100
  const cellSize = options.cellSize ?? Math.max(1, Math.min(16, Math.floor((maxPixels - padding * 2) / maxDimension)))
  const labelHeight = options.includeLabel === false ? 0 : 24
  const canvas = document.createElement('canvas')
  canvas.width = padding * 2 + layer.width * cellSize
  canvas.height = padding * 2 + labelHeight + layer.height * cellSize
  const context = canvas.getContext('2d')
  if (!context) return canvas
  context.imageSmoothingEnabled = false
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const pixels = new Map(layer.voxels.map((voxel) => {
    const point = sliceCoordinates(layer.plane, voxel)
    return [`${point.u},${point.v}`, voxel] as const
  }))
  for (let row = 0; row < layer.height; row += 1) {
    for (let column = 0; column < layer.width; column += 1) {
      const voxel = pixels.get(`${layer.minU + column},${layer.maxV - row}`)
      const x = padding + column * cellSize
      const y = padding + labelHeight + row * cellSize
      context.fillStyle = voxel?.color ?? '#ffffff'
      context.fillRect(x, y, cellSize, cellSize)
      context.strokeStyle = voxel ? 'rgba(40,48,48,.28)' : 'rgba(120,130,130,.18)'
      context.lineWidth = 1
      context.strokeRect(x + .5, y + .5, Math.max(0, cellSize - 1), Math.max(0, cellSize - 1))
    }
  }
  if (options.includeLabel !== false) {
    context.fillStyle = '#283033'
    context.font = '12px sans-serif'
    context.fillText(`${slicePlaneLabel(layer.plane)} · 层 ${layer.index + 1} · 坐标 ${layer.coordinate}`, 8, 16)
  }
  return canvas
}

function SliceLayerCanvas({ layer }: { layer: SliceLayer }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const source = drawSliceCanvas(layer, { maxPixels: 260 })
    const target = ref.current
    if (!target) return
    target.width = source.width
    target.height = source.height
    const context = target.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = false
    context.drawImage(source, 0, 0)
  }, [layer])
  return <canvas ref={ref} className="slice-layer-canvas" aria-label={`第 ${layer.index + 1} 层二维图纸`} />
}

function canvasToBlob(canvas: HTMLCanvasElement, format: 'png' | 'jpg'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片编码失败')), format === 'png' ? 'image/png' : 'image/jpeg', 1)
  })
}

function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function joinBinary(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
  let offset = 0
  chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length })
  return output
}

function canvasToPdf(canvas: HTMLCanvasElement): ArrayBuffer {
  const dataUrl = canvas.toDataURL('image/jpeg', 1)
  const encoded = dataUrl.split(',')[1] ?? ''
  const binary = atob(encoded)
  const jpeg = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) jpeg[index] = binary.charCodeAt(index)
  const width = canvas.width
  const height = canvas.height
  const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`
  const objects = [
    asciiBytes('<< /Type /Catalog /Pages 2 0 R >>'),
    asciiBytes('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    asciiBytes(`<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /MediaBox [0 0 ${width} ${height}] /Contents 5 0 R >>`),
    joinBinary([asciiBytes(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, asciiBytes('\nendstream')]),
    joinBinary([asciiBytes(`<< /Length ${asciiBytes(content).length} >>\nstream\n`), asciiBytes(content), asciiBytes('endstream')]),
  ]
  const chunks: Uint8Array[] = [asciiBytes('%PDF-1.4\n%\xff\xff\xff\xff\n')]
  const offsets: number[] = [0]
  let offset = chunks[0].length
  objects.forEach((object, index) => {
    offsets.push(offset)
    const chunk = joinBinary([asciiBytes(`${index + 1} 0 obj\n`), object, asciiBytes('\nendobj\n')])
    chunks.push(chunk)
    offset += chunk.length
  })
  const xrefOffset = offset
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.slice(1).map((value) => `${value.toString().padStart(10, '0')} 00000 n \n`)].join('')
  chunks.push(asciiBytes(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`))
  const output = joinBinary(chunks)
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function asArrayBuffer(value: string | ArrayBuffer | Uint8Array): ArrayBuffer {
  if (typeof value === 'string') return new TextEncoder().encode(value).buffer as ArrayBuffer
  if (value instanceof ArrayBuffer) return value
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function renderSliceContactSheet(layers: SliceLayer[]): HTMLCanvasElement {
  const firstLayer = layers[0]
  if (!firstLayer) return document.createElement('canvas')
  // The merged export is a deliverable image, not the compact on-screen
  // preview. Draw every grid cell at an integer pixel size and never resample
  // a layer canvas into a smaller tile. This preserves crisp grid edges and
  // avoids the blur caused by the former 280x248 contact sheet.
  const maxDimension = Math.max(firstLayer.width, firstLayer.height)
  const cellSize = Math.max(2, Math.min(20, Math.floor(2400 / Math.max(1, maxDimension))))
  const tile = drawSliceCanvas(firstLayer, { cellSize })
  const tileWidth = tile.width
  const tileHeight = tile.height
  const columns = Math.min(4, Math.max(1, layers.length))
  const rows = Math.ceil(layers.length / columns)
  const canvas = document.createElement('canvas')
  canvas.width = columns * tileWidth
  canvas.height = rows * tileHeight
  const context = canvas.getContext('2d')
  if (!context) return canvas
  context.imageSmoothingEnabled = false
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  layers.forEach((layer, index) => {
    const layerTile = drawSliceCanvas(layer, { cellSize })
    const x = (index % columns) * tileWidth
    const y = Math.floor(index / columns) * tileHeight
    context.drawImage(layerTile, x, y)
  })
  return canvas
}

function SliceDialog({ parts, project, name, onClose, onNotice }: { parts: SceneEntityPart[]; project: ProjectState; name: string; onClose: () => void; onNotice: (message: string) => void }) {
  const [plane, setPlane] = useState<SlicePlane>('xy')
  const [imageFormat, setImageFormat] = useState<'png' | 'jpg' | 'pdf'>('png')
  const [imageMode, setImageMode] = useState<'separate' | 'merged'>('separate')
  const [modelFormat, setModelFormat] = useState<'stl' | 'glb' | 'vox'>('stl')
  const [activeLayerIndex, setActiveLayerIndex] = useState(0)
  const layers = useMemo(() => sliceEntityParts(parts, plane, (voxel, part) => scenePartVoxelDisplayColor(project, part, voxel)), [parts, plane, project])
  useEffect(() => { setActiveLayerIndex(Math.max(0, Math.min(activeLayerIndex, layers.length - 1))) }, [layers.length])

  const exportImages = async () => {
    if (!layers.length) return onNotice('当前选中实体没有可切片的体素')
    try {
      if (imageMode === 'merged') {
        const canvas = renderSliceContactSheet(layers)
        const data = imageFormat === 'pdf' ? canvasToPdf(canvas) : await canvasToBlob(canvas, imageFormat)
        downloadBlob(data instanceof Blob ? data : new Blob([data], { type: 'application/pdf' }), `${name}-${slicePlaneLabel(plane)}-切面.${imageFormat}`)
      } else {
        const entries = []
        for (const layer of layers) {
          const canvas = drawSliceCanvas(layer)
          const data = imageFormat === 'pdf' ? canvasToPdf(canvas) : await canvasToBlob(canvas, imageFormat)
          entries.push({ name: `${name}-${slicePlaneLabel(plane)}-层${layer.index + 1}.${imageFormat}`, data: data instanceof Blob ? await data.arrayBuffer() : data })
        }
        downloadBlob(new Blob([createZip(entries)], { type: 'application/zip' }), `${name}-${slicePlaneLabel(plane)}-切面图纸.zip`)
      }
      onNotice(`已导出 ${layers.length} 层 ${slicePlaneLabel(plane)} 二维切面图纸`)
    } catch (error) {
      onNotice(`二维图纸导出失败 · ${error instanceof Error ? error.message : '无法生成文件'}`)
    }
  }

  const exportModels = async () => {
    if (!layers.length) return onNotice('当前选中实体没有可切片的体素')
    try {
      const entries = []
      for (const layer of layers) {
        const asset = sliceLayerToAsset(layer, `${name}-${slicePlaneLabel(plane)}-层${layer.index + 1}`)
        const data = modelFormat === 'stl'
          ? makeStlWithDiagnostics(asset, project.voxelSizeMm).stl
          : modelFormat === 'glb'
            ? await encodeGlb(asset, (voxel) => voxel.paintMaterialId ?? voxel.materialId, project.voxelSizeMm)
            : encodeVox(asset, (voxel) => voxel.paintMaterialId ?? voxel.materialId)
        entries.push({ name: `${asset.name}.${modelFormat}`, data: asArrayBuffer(data) })
      }
      downloadBlob(new Blob([createZip(entries)], { type: 'application/zip' }), `${name}-${slicePlaneLabel(plane)}-模型切片.zip`)
      onNotice(`${modelFormat === 'vox' && layers.some((layer) => hasNonCubeVoxels(layer.voxels)) ? '提示：VOX 不支持非立方体几何，已按逻辑立方体体素降级导出 · ' : ''}已导出 ${layers.length} 个 ${modelFormat.toUpperCase()} 模型切片`)
    } catch (error) {
      onNotice(`模型切片导出失败 · ${error instanceof Error ? error.message : '无法生成文件'}`)
    }
  }

  return <div className="modal-backdrop slicer-backdrop"><section className="slicer-dialog" role="dialog" aria-modal="true" aria-label="模型实体模型切片">
    <header className="slicer-header"><div><h2>模型实体模型切片</h2><p>{name} · {layers.length} 个非空切片层</p></div><button className="icon-button" aria-label="关闭切片" onClick={onClose}><X size={17} /></button></header>
    <div className="slicer-toolbar"><label>切片平面<select value={plane} onChange={(event) => setPlane(event.target.value as SlicePlane)}><option value="xy">XZ</option><option value="xz">XY</option><option value="yz">YZ</option></select></label><label>图纸格式<select value={imageFormat} onChange={(event) => setImageFormat(event.target.value as 'png' | 'jpg' | 'pdf')}><option value="png">PNG</option><option value="jpg">JPG</option><option value="pdf">PDF</option></select></label><label>图纸方式<select value={imageMode} onChange={(event) => setImageMode(event.target.value as 'separate' | 'merged')}><option value="separate">分开导出 ZIP</option><option value="merged">合并为一张图片</option></select></label><button className="primary slicer-export-button" disabled={!layers.length} onClick={() => void exportImages()}>导出二维图纸</button></div>
    <div className="slicer-content"><div className="slicer-layer-list">{layers.length ? layers.map((layer) => <button key={`${layer.coordinate}-${layer.index}`} className={`slicer-layer-card ${activeLayerIndex === layer.index ? 'active' : ''}`} onClick={() => setActiveLayerIndex(layer.index)}><SliceLayerCanvas layer={layer} /><span>第 {layer.index + 1} 层 · 坐标 {layer.coordinate} · {layer.voxels.length} 体素</span></button>) : <div className="empty-panel">当前实体没有可切片的体素</div>}</div><div className="slicer-main-preview">{layers[activeLayerIndex] ? <><SliceLayerCanvas layer={layers[activeLayerIndex]} /><div className="slicer-layer-meta">{slicePlaneLabel(plane)} · 第 {activeLayerIndex + 1} 层 · {layers[activeLayerIndex].width} × {layers[activeLayerIndex].height} 格</div></> : <div className="empty-panel">暂无切片预览</div>}</div></div>
    <footer className="slicer-footer"><label>模型格式<select value={modelFormat} onChange={(event) => setModelFormat(event.target.value as 'stl' | 'glb' | 'vox')}><option value="stl">多个 STL</option><option value="glb">多个 GLB</option><option value="vox">多个 VOX</option></select></label><button className="primary slicer-export-button" disabled={!layers.length} onClick={() => void exportModels()}>导出模型切片 ZIP</button></footer>
  </section></div>
}

const SceneLibraryPreview = React.memo(function SceneLibraryPreview({ cacheKey, voxels, maxVoxels, exteriorOnly = false }: { cacheKey: string; voxels: ScenePreviewInputVoxel[]; maxVoxels: number; exteriorOnly?: boolean }) {
  const hasVariantVoxels = useMemo(() => voxels.some((voxel) => voxel.shape && voxel.shape !== 'cube'), [voxels])
  const variantVoxels = useMemo<Voxel[]>(() => voxels.map((voxel) => ({
    x: voxel.x,
    y: voxel.y,
    z: voxel.z,
    materialId: voxel.color,
    shape: voxel.shape,
    facing: voxel.facing,
    rotation: voxel.rotation,
  })), [voxels])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [payload, setPayload] = useState<ScenePreviewPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const workerRef = useRef<ScenePreviewWorkerClient | null>(null)
  const requestRef = useRef(0)
  const resultCacheRef = useRef(new Map<string, ScenePreviewPayload>())

  useEffect(() => {
    const worker = new ScenePreviewWorkerClient()
    workerRef.current = worker
    return () => {
      worker.dispose()
      workerRef.current = null
    }
  }, [])

  useEffect(() => {
    const worker = workerRef.current
    if (!worker || !voxels.length || hasVariantVoxels) {
      requestRef.current += 1
      setLoading(false)
      setFailed(false)
      setPayload(null)
      return
    }
    const requestId = ++requestRef.current
    const resolvedCacheKey = `${cacheKey}:${exteriorOnly ? 'exterior' : 'all-faces'}`
    const cached = resultCacheRef.current.get(resolvedCacheKey)
    if (cached) {
      setLoading(false)
      setFailed(false)
      setPayload(cached)
      return
    }
    setLoading(true)
    setFailed(false)
    setPayload(null)
    worker.build(voxels, maxVoxels, exteriorOnly).then((nextPayload) => {
      if (requestId !== requestRef.current) return
      setLoading(false)
      if (!nextPayload) {
        setFailed(true)
        return
      }
      resultCacheRef.current.set(resolvedCacheKey, nextPayload)
      setPayload(nextPayload)
    })
  }, [cacheKey, hasVariantVoxels, voxels, maxVoxels, exteriorOnly])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !payload) return
    const draw = () => {
      const width = Math.max(1, canvas.clientWidth || 320)
      const height = Math.max(1, canvas.clientHeight || 260)
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const nextWidth = Math.round(width * pixelRatio)
      const nextHeight = Math.round(height * pixelRatio)
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth
        canvas.height = nextHeight
      }
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, width, height)
      const [minX, minY, minZ, maxX, maxY, maxZ] = payload.bounds
      // Keep the established thumbnail convention: persisted X/Z form the
      // ground plane and persisted Y is vertical. The previous regression was
      // caused by missing bounds normalization, not by this axis convention.
      const spanX = Math.max(1, maxX - minX + 1)
      const spanGroundZ = Math.max(1, maxZ - minZ + 1)
      const spanVerticalY = Math.max(1, maxY - minY + 1)
      const tileX = 8
      const tileZ = 4.5
      // Keep the three voxel axes at the same projected scale. The previous
      // fixed value (7) made tall models visibly shorter than their footprint.
      const tileY = Math.hypot(tileX, tileZ)
      const rawProject = (x: number, y: number, z: number): [number, number] => [(z - x) * tileX, (x + z) * tileZ - y * tileY]
      const projectedCorners = [
        [0, 0, 0], [spanX, 0, 0], [0, 0, spanGroundZ], [spanX, 0, spanGroundZ],
        [0, spanVerticalY, 0], [spanX, spanVerticalY, 0], [0, spanVerticalY, spanGroundZ], [spanX, spanVerticalY, spanGroundZ],
      ].map(([x, y, z]) => rawProject(x, y, z))
      const projectedBounds = projectedCorners.reduce((result, [x, y]) => ({
        minX: Math.min(result.minX, x),
        minY: Math.min(result.minY, y),
        maxX: Math.max(result.maxX, x),
        maxY: Math.max(result.maxY, y),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
      const rawWidth = projectedBounds.maxX - projectedBounds.minX
      const rawHeight = projectedBounds.maxY - projectedBounds.minY
      const scale = Math.min((width - 24) / Math.max(rawWidth, 1), (height - 24) / Math.max(rawHeight, 1))
      const offsetX = (width - rawWidth * scale) / 2 - projectedBounds.minX * scale
      const offsetY = (height - rawHeight * scale) / 2 - projectedBounds.minY * scale
      const project = (x: number, y: number, z: number): [number, number] => {
        const point = rawProject(x - minX, y - minY, z - minZ)
        return [offsetX + point[0] * scale, offsetY + point[1] * scale]
      }
      const shade = (color: number, amount: number) => {
        const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 0xff) * amount)))
        const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 0xff) * amount)))
        const b = Math.max(0, Math.min(255, Math.round((color & 0xff) * amount)))
        return `rgb(${r}, ${g}, ${b})`
      }
      context.lineJoin = 'round'
      payload.faces.forEach((face) => {
        let points: Array<[number, number]>
        if (face.orientation === 0 || face.orientation === 3) points = [project(face.a, face.plane, face.b), project(face.a + face.width, face.plane, face.b), project(face.a + face.width, face.plane, face.b + face.height), project(face.a, face.plane, face.b + face.height)]
        else if (face.orientation === 1 || face.orientation === 4) points = [project(face.plane, face.b, face.a), project(face.plane, face.b + face.height, face.a), project(face.plane, face.b + face.height, face.a + face.width), project(face.plane, face.b, face.a + face.width)]
        else points = [project(face.a, face.b, face.plane), project(face.a + face.width, face.b, face.plane), project(face.a + face.width, face.b + face.height, face.plane), project(face.a, face.b + face.height, face.plane)]
        context.beginPath()
        context.moveTo(points[0][0], points[0][1])
        points.slice(1).forEach(([x, y]) => context.lineTo(x, y))
        context.closePath()
        context.fillStyle = shade(face.color,
          face.orientation === 0 ? 1
            : face.orientation === 3 ? 0.38
              : face.orientation === 1 ? 0.72
                : face.orientation === 4 ? 0.62
                  : face.orientation === 2 ? 0.54
                    : 0.46)
        context.fill()
      })
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [payload])

  if (hasVariantVoxels) return <VariantSurfaceMiniPreview voxels={variantVoxels} maxPreviewVoxels={maxVoxels} exteriorOnly={exteriorOnly} />
  if (loading && !payload) return <div className="empty-panel preview-loading">正在生成场景预览…</div>
  if (failed) return <div className="empty-panel">场景预览生成失败</div>
  if (!payload) return <div className="empty-panel">正在准备场景预览…</div>
  return <canvas ref={canvasRef} className="scene-preview-canvas" aria-label={`场景预览，显示 ${payload.sampledVoxelCount} 个预览体素`} />
})

function VariantSurfaceMiniPreview({ voxels, asset, colorOverride, voxelColors = {}, materialColors = {}, maxPreviewVoxels, exteriorOnly = false }: { voxels: Voxel[]; asset?: VoxelAsset; colorOverride?: string; voxelColors?: Record<string, string>; materialColors?: Record<string, string>; maxPreviewVoxels?: number; exteriorOnly?: boolean }) {
  if (!voxels.length) return <div className="mini-preview-empty">暂无预览</div>
  const source = exteriorOnly ? exteriorSurfaceVoxels(voxels) : voxels
  const previewVoxels = selectPreviewVoxels(source, maxPreviewVoxels ?? MAX_PREVIEW_VOXELS).voxels
  const colorFor = (voxel: Voxel) => {
    const key = `${voxel.x},${voxel.y},${voxel.z}`
    return voxelColors[key]
      ?? (voxel.paintMaterialId ? materialColors[voxel.paintMaterialId] ?? (voxel.paintMaterialId.startsWith('#') ? voxel.paintMaterialId : undefined) : undefined)
      ?? colorOverride
      ?? asset?.templateColor
      ?? (voxel.materialId.startsWith('#') ? voxel.materialId : materialColors[voxel.materialId] ?? MATERIALS.find((material) => material.id === voxel.materialId)?.color ?? '#6c827d')
  }
  const surface = buildVoxelSurfaceMesh(previewVoxels, colorFor)
  if (!surface.positions.length) return <div className="mini-preview-empty">暂无预览</div>
  const points: Array<[number, number, number]> = []
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  for (let index = 0; index < surface.positions.length; index += 3) {
    const point: [number, number, number] = [surface.positions[index], surface.positions[index + 1], surface.positions[index + 2]]
    points.push(point)
    minX = Math.min(minX, point[0])
    minY = Math.min(minY, point[1])
    minZ = Math.min(minZ, point[2])
  }
  const tileX = 8
  const tileZ = 4.5
  const tileY = Math.hypot(tileX, tileZ)
  const rawProject = (x: number, y: number, z: number): [number, number] => [(z - x) * tileX, (x + z) * tileZ - y * tileY]
  const projected = points.map((point) => rawProject(point[0] - minX, point[1] - minY, point[2] - minZ))
  const projectedBounds = projected.reduce((result, point) => ({ minX: Math.min(result.minX, point[0]), minY: Math.min(result.minY, point[1]), maxX: Math.max(result.maxX, point[0]), maxY: Math.max(result.maxY, point[1]) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
  const width = Math.max(28, projectedBounds.maxX - projectedBounds.minX + 28)
  const height = Math.max(28, projectedBounds.maxY - projectedBounds.minY + 28)
  const project = (point: [number, number, number]): [number, number] => [14 + (rawProject(point[0] - minX, point[1] - minY, point[2] - minZ)[0] - projectedBounds.minX), 14 + (rawProject(point[0] - minX, point[1] - minY, point[2] - minZ)[1] - projectedBounds.minY)]
  const rgb = (index: number) => [surface.colors[index * 3], surface.colors[index * 3 + 1], surface.colors[index * 3 + 2]]
  const triangles = Array.from({ length: surface.indices.length / 3 }, (_, triangleIndex) => {
    const indices = [surface.indices[triangleIndex * 3], surface.indices[triangleIndex * 3 + 1], surface.indices[triangleIndex * 3 + 2]]
    const trianglePoints = indices.map((index) => points[index])
    const color = indices.map(rgb).reduce((sum, value) => sum.map((channel, index) => channel + value[index]), [0, 0, 0]).map((value) => Math.round(value / 3 * 255))
    const normal = indices.map((index) => [surface.normals[index * 3], surface.normals[index * 3 + 1], surface.normals[index * 3 + 2]]).reduce((sum, value) => sum.map((channel, index) => channel + value[index]), [0, 0, 0])
    const light = Math.max(0.42, Math.min(1, 0.68 + normal[0] * 0.12 + normal[1] * 0.16 + normal[2] * 0.08))
    const ao = indices.reduce((sum, index) => sum + surface.ao[index], 0) / 3
    const fill = `rgb(${color.map((channel) => Math.round(channel * light * ao)).join(', ')})`
    const depth = trianglePoints.reduce((sum, point) => sum + point[0] + point[2] + point[1] * 0.02, 0)
    return { points: trianglePoints.map(project), fill, depth }
  }).sort((left, right) => left.depth - right.depth)
  return <div className="mini-preview" aria-label="固定斜前方实体预览"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="统一表面体素预览">{triangles.map((triangle, index) => <polygon key={index} points={triangle.points.map(([x, y]) => `${x},${y}`).join(' ')} fill={triangle.fill} />)}</svg></div>
}

const SynchronousVoxelMiniPreview = React.memo(function SynchronousVoxelMiniPreview({ voxels, asset, colorOverride, voxelColors = {}, materialColors = {}, maxPreviewVoxels, exteriorOnly = false }: { voxels: Voxel[]; asset?: VoxelAsset; colorOverride?: string; voxelColors?: Record<string, string>; materialColors?: Record<string, string>; maxPreviewVoxels?: number; exteriorOnly?: boolean }) {
  if (!voxels.length) return <div className="mini-preview-empty">暂无预览</div>
  // A preview is a visual LOD, not the source model. The source can contain
  // hundreds of thousands of cells (for example an imported robot), while
  // rendering tens of thousands of SVG faces synchronously blocks all input.
  // Keep the caller override for scene-specific previews, but cap the default
  // used by inspector, asset-library and model-import thumbnails.
  // Keep external-surface selection independent from the internal voxel set.
  // The inspector asks for an outside-only thumbnail, so shell extraction must
  // not change the visible silhouette merely because hidden cells were removed.
  // Occupancy and exterior-air queries below still use the complete source so
  // sampled faces are occluded exactly like the worker-backed preview.
  const fullOccupancyKeys = new Set(voxels.map((voxel) => previewVoxelKey(voxel)))
  const exteriorAir = exteriorOnly ? exteriorAirKeys(voxels) : null
  const surfaceVoxels = exteriorOnly ? exteriorSurfaceVoxels(voxels) : voxels
  const previewSelection = selectPreviewVoxels(surfaceVoxels, maxPreviewVoxels ?? MAX_PREVIEW_VOXELS)
  const previewVoxels = previewSelection.voxels
  const bounds = voxels.slice(1).reduce((result, voxel) => ({
    minX: Math.min(result.minX, voxel.x),
    minY: Math.min(result.minY, voxel.y),
    minZ: Math.min(result.minZ, voxel.z),
    maxX: Math.max(result.maxX, voxel.x),
    maxY: Math.max(result.maxY, voxel.y),
    maxZ: Math.max(result.maxZ, voxel.z),
  }), { minX: voxels[0].x, minY: voxels[0].y, minZ: voxels[0].z, maxX: voxels[0].x, maxY: voxels[0].y, maxZ: voxels[0].z })
  const { minX, minY, minZ, maxX, maxY, maxZ } = bounds
  const spanX = Math.max(1, maxX - minX + 1)
  const spanY = Math.max(1, maxY - minY + 1)
  const spanZ = Math.max(1, maxZ - minZ + 1)
  const tileX = 8
  const tileZ = 4.5
  // Match the worker-backed preview's orthographic basis. A fixed 7 here
  // compressed the persisted vertical axis relative to an X/Z voxel edge.
  const tileY = Math.hypot(tileX, tileZ)
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
    return voxelColors[originalKey] ?? (voxel.paintMaterialId ? (materialColors[voxel.paintMaterialId] ?? MATERIALS.find((material) => material.id === voxel.paintMaterialId)?.color ?? voxel.paintMaterialId) : undefined) ?? colorOverride ?? asset?.templateColor ?? (voxel.materialId === 'primary' ? asset?.color ?? '#6c827d' : voxel.materialId === 'accent' ? asset?.accent ?? '#d2a354' : voxel.materialId.startsWith('#') ? voxel.materialId : materialColors[voxel.materialId] ?? MATERIALS.find((material) => material.id === voxel.materialId)?.color ?? '#6c827d')
  }
  const shadeColor = (color: string, amount: number) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return color
    const channels = [0, 2, 4].map((offset) => Math.max(0, Math.min(255, Math.round(parseInt(color.slice(offset + 1, offset + 3), 16) * amount))))
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  }
  const hasVoxel = (x: number, y: number, z: number) => fullOccupancyKeys.has(previewVoxelKey({ x: x + minX, y: y + minY, z: z + minZ }))
  const exteriorPreviewVoxels = previewVoxels
  const visibleFace = (x: number, y: number, z: number) => !hasVoxel(x, y, z) && (!exteriorOnly || exteriorAir === null || exteriorAir.has(toolCellKey({ x: x + minX, y: y + minY, z: z + minZ })))
  const faceCells = exteriorPreviewVoxels.flatMap((sourceVoxel) => {
    const voxel = { ...sourceVoxel, x: sourceVoxel.x - minX, y: sourceVoxel.y - minY, z: sourceVoxel.z - minZ, sourceVoxel }
    const cells = []
    const color = materialColor(voxel)
    if (visibleFace(voxel.x, voxel.y + 1, voxel.z)) cells.push({ orientation: 'top' as const, plane: voxel.y + 1, a: voxel.x, b: voxel.z, color, sortKey: voxel.x + voxel.z + voxel.y * 0.02 })
    if (!exteriorOnly && visibleFace(voxel.x, voxel.y - 1, voxel.z)) cells.push({ orientation: 'bottom' as const, plane: voxel.y, a: voxel.x, b: voxel.z, color, sortKey: voxel.x + voxel.z + voxel.y * 0.02 - 0.04 })
    if (visibleFace(voxel.x + 1, voxel.y, voxel.z)) cells.push({ orientation: 'x' as const, plane: voxel.x + 1, a: voxel.z, b: voxel.y, color, sortKey: voxel.x + voxel.z + voxel.y * 0.02 })
    if (!exteriorOnly && visibleFace(voxel.x - 1, voxel.y, voxel.z)) cells.push({ orientation: 'x-negative' as const, plane: voxel.x, a: voxel.z, b: voxel.y, color, sortKey: voxel.x + voxel.z + voxel.y * 0.02 - 0.02 })
    if (visibleFace(voxel.x, voxel.y, voxel.z + 1)) cells.push({ orientation: 'z' as const, plane: voxel.z + 1, a: voxel.x, b: voxel.y, color, sortKey: voxel.x + voxel.z + voxel.y * 0.02 })
    if (!exteriorOnly && visibleFace(voxel.x, voxel.y, voxel.z - 1)) cells.push({ orientation: 'z-negative' as const, plane: voxel.z, a: voxel.x, b: voxel.y, color, sortKey: voxel.x + voxel.z + voxel.y * 0.02 - 0.01 })
    return cells
  })
  const faceRects = mergePreviewFaceCells(faceCells)
  const facePoints = (face: typeof faceRects[number]): Array<[number, number]> => {
    if (face.orientation === 'top' || face.orientation === 'bottom') return [project(face.a, face.plane, face.b), project(face.a + face.width, face.plane, face.b), project(face.a + face.width, face.plane, face.b + face.height), project(face.a, face.plane, face.b + face.height)]
    if (face.orientation === 'x' || face.orientation === 'x-negative') return [project(face.plane, face.b, face.a), project(face.plane, face.b + face.height, face.a), project(face.plane, face.b + face.height, face.a + face.width), project(face.plane, face.b, face.a + face.width)]
    return [project(face.a, face.b, face.plane), project(face.a + face.width, face.b, face.plane), project(face.a + face.width, face.b + face.height, face.plane), project(face.a, face.b + face.height, face.plane)]
  }
  const points = (values: Array<[number, number]>) => values.map(([x, y]) => `${x},${y}`).join(' ')
  // One SVG polygon per visible face is still expensive for imported models.
  // Group faces by final shaded color into compound paths: the browser parses
  // a handful of paths instead of thousands of React/SVG elements, while the
  // greedy rectangles above preserve the exact visible silhouette.
  const facePaths = new Map<string, string>()
  faceRects.forEach((face) => {
    const fill = shadeColor(face.color,
      face.orientation === 'top' ? 1
        : face.orientation === 'bottom' ? 0.38
          : face.orientation === 'x' ? 0.72
            : face.orientation === 'x-negative' ? 0.62
              : face.orientation === 'z' ? 0.54
                : 0.46)
    const path = `M ${points(facePoints(face)).replaceAll(' ', ' L ')} Z `
    facePaths.set(fill, `${facePaths.get(fill) ?? ''}${path}`)
  })
  return <div className="mini-preview" aria-label="固定斜前方实体预览"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="组合式 3D 体素预览">
    {[...facePaths].map(([fill, d]) => <path key={fill} d={d} fill={fill} />)}
  </svg></div>
})

const LARGE_MINI_PREVIEW_THRESHOLD = 20_000
const previewInputArrayIds = new WeakMap<object, number>()
let nextPreviewInputArrayId = 1

function previewInputArrayId(voxels: ScenePreviewInputVoxel[]): number {
  const existing = previewInputArrayIds.get(voxels)
  if (existing) return existing
  const id = nextPreviewInputArrayId++
  previewInputArrayIds.set(voxels, id)
  return id
}

function miniPreviewVoxelColor(voxel: Voxel, asset: VoxelAsset | undefined, colorOverride: string | undefined, voxelColors: Record<string, string>, materialColors: Record<string, string>): string {
  const key = `${voxel.x},${voxel.y},${voxel.z}`
  const materialColor = (materialId: string) => materialColors[materialId] ?? MATERIALS.find((material) => material.id === materialId)?.color
  return voxelColors[key]
    ?? (voxel.paintMaterialId ? materialColor(voxel.paintMaterialId) ?? (voxel.paintMaterialId.startsWith('#') ? voxel.paintMaterialId : undefined) : undefined)
    ?? colorOverride
    ?? asset?.templateColor
    ?? (voxel.materialId === 'primary'
      ? asset?.color ?? '#6c827d'
      : voxel.materialId === 'accent'
        ? asset?.accent ?? '#d2a354'
        : voxel.materialId.startsWith('#') ? voxel.materialId : materialColor(voxel.materialId) ?? '#6c827d')
}

const WorkerVoxelMiniPreview = React.memo(function WorkerVoxelMiniPreview({ voxels, asset, colorOverride, voxelColors = {}, materialColors = {}, maxPreviewVoxels, exteriorOnly = false }: { voxels: Voxel[]; asset?: VoxelAsset; colorOverride?: string; voxelColors?: Record<string, string>; materialColors?: Record<string, string>; maxPreviewVoxels?: number; exteriorOnly?: boolean }) {
  const inputVoxels = useMemo<ScenePreviewInputVoxel[]>(() => voxels.map((voxel) => ({
    x: voxel.x,
    y: voxel.y,
    z: voxel.z,
    color: miniPreviewVoxelColor(voxel, asset, colorOverride, voxelColors, materialColors),
  })), [asset, colorOverride, materialColors, voxelColors, voxels])
  const cacheKey = `entity-mini:${previewInputArrayId(inputVoxels)}:${maxPreviewVoxels ?? MAX_PREVIEW_VOXELS}:${exteriorOnly ? 'exterior' : 'all-faces'}`
  return <div className="mini-preview" aria-label="固定斜前方实体预览"><SceneLibraryPreview cacheKey={cacheKey} voxels={inputVoxels} maxVoxels={maxPreviewVoxels ?? MAX_PREVIEW_VOXELS} exteriorOnly={exteriorOnly} /></div>
})

/**
 * Keep the exact SVG path for small assets. Large imported entities use the
 * worker-backed canvas path so the expensive occupancy and face generation do
 * not block selection, camera movement, or the inspector itself.
 */
const VoxelMiniPreview = React.memo(function VoxelMiniPreview(props: { voxels: Voxel[]; asset?: VoxelAsset; colorOverride?: string; voxelColors?: Record<string, string>; materialColors?: Record<string, string>; maxPreviewVoxels?: number; exteriorOnly?: boolean }) {
  if (props.voxels.some((voxel) => voxelShape(voxel) !== 'cube')) return <VariantSurfaceMiniPreview {...props} />
  return props.voxels.length > LARGE_MINI_PREVIEW_THRESHOLD
    ? <WorkerVoxelMiniPreview {...props} />
    : <SynchronousVoxelMiniPreview {...props} />
})

function ColorEditor({ color, disabled, onChange, onPreviewHsl, onCommitHsl }: { color: string; disabled: boolean; onChange: (color: string) => void; onPreviewHsl: (hueDelta: number, saturationTarget: number) => void; onCommitHsl: (hueDelta: number, saturationTarget: number) => void }) {
  const colorInputRef = useRef<HTMLInputElement>(null)
  const [hue, setHue] = useState(() => hexToHsl(color).h)
  const [saturation, setSaturation] = useState(() => hexToHsl(color).s)
  const hueRef = useRef(hue)
  const saturationRef = useRef(saturation)
  const hslSessionRef = useRef<{ hue: number; saturation: number } | null>(null)
  useEffect(() => {
    const next = hexToHsl(color)
    setHue(next.h)
    setSaturation(next.s)
    hueRef.current = next.h
    saturationRef.current = next.s
    hslSessionRef.current = null
  }, [color])
  const beginHslSession = () => {
    if (!hslSessionRef.current) hslSessionRef.current = { hue: hueRef.current, saturation: saturationRef.current }
  }
  const previewHsl = (nextHue: number, nextSaturation: number) => {
    beginHslSession()
    const base = hslSessionRef.current!
    onPreviewHsl(nextHue - base.hue, nextSaturation)
  }
  const commitHsl = () => {
    const base = hslSessionRef.current
    if (!base) return
    if (hueRef.current === base.hue && saturationRef.current === base.saturation) {
      hslSessionRef.current = null
      return
    }
    onCommitHsl(hueRef.current - base.hue, saturationRef.current)
    hslSessionRef.current = null
  }
  return <div className="color-editor">
    <button className="inspector-color-button" aria-label="打开颜色选择器" title="选择实体颜色" disabled={disabled} style={{ background: color }} onClick={() => colorInputRef.current?.click()}><Palette size={14} /></button>
    <input ref={colorInputRef} className="hidden-color-input" type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#6c827d'} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    <div className="color-sliders">
      <label><span>色调</span><input aria-label="色调" type="range" min="0" max="360" value={hue} disabled={disabled} onPointerDown={beginHslSession} onPointerUp={commitHsl} onPointerCancel={commitHsl} onBlur={commitHsl} onChange={(event) => { const next = Number(event.target.value); hueRef.current = next; setHue(next); previewHsl(next, saturationRef.current) }} /></label>
      <label><span>饱和度</span><input aria-label="饱和度" type="range" min="0" max="100" value={saturation} disabled={disabled} onPointerDown={beginHslSession} onPointerUp={commitHsl} onPointerCancel={commitHsl} onBlur={commitHsl} onChange={(event) => { const next = Number(event.target.value); saturationRef.current = next; setSaturation(next); previewHsl(hueRef.current, next) }} /></label>
    </div>
  </div>
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

const greedyColorCache = new Map<string, THREE.Color>()

function cachedGreedyColor(value: string): THREE.Color {
  const cached = greedyColorCache.get(value)
  if (cached) return cached
  const color = new THREE.Color(value)
  greedyColorCache.set(value, color)
  if (greedyColorCache.size > 128) {
    const oldest = greedyColorCache.keys().next().value as string | undefined
    if (oldest) greedyColorCache.delete(oldest)
  }
  return color
}

function exposedVoxelFaces(voxel: Pick<Voxel, 'x' | 'y' | 'z'>, occupied: Set<string>): VoxelFaceKey[] {
  return voxelFaceDirections.filter(({ neighbor: [dx, dy, dz] }) => !occupied.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)).map(({ key }) => key)
}

function configureHslPreviewMaterial(material: THREE.MeshStandardMaterial, cacheKey: string, enableVoxelAo = false) {
  const state = { hueDelta: 0, saturationTarget: 100, enabled: false }
  material.userData.moceHslPreviewState = state
  material.onBeforeCompile = (shader) => {
    shader.uniforms.moceHueDelta = { value: state.hueDelta / 360 }
    shader.uniforms.moceSaturationTarget = { value: state.saturationTarget / 100 }
    shader.uniforms.moceHslPreviewEnabled = { value: state.enabled ? 1 : 0 }
    material.userData.moceHslPreviewUniforms = shader.uniforms
    const helpers = `
      float moceLinearToSrgb(float value) {
        return value <= 0.0031308 ? value * 12.92 : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
      }
      float moceSrgbToLinear(float value) {
        return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4);
      }
      vec3 moceRgbToHsl(vec3 color) {
        float maxValue = max(max(color.r, color.g), color.b);
        float minValue = min(min(color.r, color.g), color.b);
        float delta = maxValue - minValue;
        float lightness = (maxValue + minValue) * 0.5;
        if (delta < 0.00001) return vec3(0.0, 0.0, lightness);
        float saturation = delta / (1.0 - abs(2.0 * lightness - 1.0));
        float hue;
        if (maxValue == color.r) hue = mod((color.g - color.b) / delta, 6.0);
        else if (maxValue == color.g) hue = (color.b - color.r) / delta + 2.0;
        else hue = (color.r - color.g) / delta + 4.0;
        return vec3(hue / 6.0, saturation, lightness);
      }
      vec3 moceHslToRgb(vec3 hsl) {
        vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        float chroma = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
        return hsl.z + (rgb - 0.5) * chroma;
      }
    `
    if (enableVoxelAo) {
      shader.vertexShader = `attribute float moceAo;\nvarying float vMoceAo;\n${shader.vertexShader}`
        .replace('#include <project_vertex>', '#include <project_vertex>\n      vMoceAo = moceAo;')
      shader.fragmentShader = `varying float vMoceAo;\n${shader.fragmentShader}`
    }
    const colorFragment = `#include <color_fragment>
      if (moceHslPreviewEnabled > 0.5) {
        vec3 moceSrgb = vec3(moceLinearToSrgb(diffuseColor.r), moceLinearToSrgb(diffuseColor.g), moceLinearToSrgb(diffuseColor.b));
        vec3 moceHsl = moceRgbToHsl(moceSrgb);
        moceHsl.x = fract(moceHsl.x + moceHueDelta);
        moceHsl.y = clamp(moceSaturationTarget, 0.0, 1.0);
        vec3 moceRgb = moceHslToRgb(moceHsl);
        diffuseColor.rgb = vec3(moceSrgbToLinear(moceRgb.r), moceSrgbToLinear(moceRgb.g), moceSrgbToLinear(moceRgb.b));
      }
      ${enableVoxelAo ? 'diffuseColor.rgb *= mix(0.74, 1.0, clamp(vMoceAo, 0.0, 1.0));' : ''}`
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', `uniform float moceHueDelta;
      uniform float moceSaturationTarget;
      uniform float moceHslPreviewEnabled;
      ${helpers}
void main() {`).replace('#include <color_fragment>', colorFragment)
  }
  material.customProgramCacheKey = () => cacheKey
}

function configureGreedyPreviewMaterial(material: THREE.MeshStandardMaterial) {
  configureHslPreviewMaterial(material, 'moce-greedy-hsl-preview-v3-ao', true)
}

function configureInstancedVoxelPreviewMaterial(material: THREE.MeshStandardMaterial) {
  configureHslPreviewMaterial(material, 'moce-instanced-voxel-hsl-preview-v1')
}

function attachVoxelAoAttribute(geometry: THREE.BufferGeometry, ao: Float32Array | undefined, vertexCount: number) {
  if (ao && ao.length === vertexCount) geometry.setAttribute('moceAo', new THREE.BufferAttribute(ao, 1))
}

/**
 * Render a mixed cube/variant component through the same exterior-surface
 * path used by GLB/STL. The logical cells remain on the mesh userData for
 * selection and editing; only the render representation changes.
 */
function createVoxelSurfaceRenderMesh(
  voxels: Voxel[],
  origin: { x: number; y: number; z: number },
  colorResolver: (voxel: Voxel) => string,
  scenePartId: string,
): THREE.Mesh {
  const surface = buildVoxelSurfaceMesh(voxels, colorResolver)
  const positions = new Float32Array(surface.positions.length)
  const normals = new Float32Array(surface.normals.length)
  for (let index = 0; index < surface.positions.length; index += 3) {
    // Surface data uses storage X/Y/Z; Three's editor scene uses X/Z/Y.
    positions[index] = (surface.positions[index] - origin.x) * VOXEL_WORLD_SIZE
    positions[index + 1] = (surface.positions[index + 2] - origin.z) * VOXEL_WORLD_SIZE
    positions[index + 2] = (surface.positions[index + 1] - origin.y) * VOXEL_WORLD_SIZE
    normals[index] = surface.normals[index]
    normals[index + 1] = surface.normals[index + 2]
    normals[index + 2] = surface.normals[index + 1]
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true))
  geometry.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3))
  attachVoxelAoAttribute(geometry, surface.ao, positions.length / 3)
  geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1))
  geometry.computeBoundingSphere()
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 })
  configureHslPreviewMaterial(material, 'moce-surface-hsl-v1', true)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.userData.surfaceMesh = true
  mesh.userData.customVoxels = voxels
  mesh.userData.customComponentVoxels = voxels
  mesh.userData.renderSurfaceOrigin = origin
  mesh.userData.scenePartId = scenePartId
  mesh.userData.outerVoxel = true
  mesh.userData.baseRenderColor = 0xffffff
  mesh.castShadow = false
  mesh.receiveShadow = false
  return mesh
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

type OutlineVoxel = { x: number; y: number; z: number }

/**
 * Build only the feature edges of the union of voxel cells.
 *
 * A complete wireframe for every outer cell also contains edges between two
 * coplanar cells on the same outside face. Those edges are not part of the
 * entity's external shape and make the selection overlay look as if it is
 * visible through the model. We first emit the four edges of every exposed
 * face, then cancel an edge shared by two coplanar faces. Creases and the
 * silhouette remain. The resulting lines still use the normal depth buffer,
 * so faces on the far side are occluded by the solid mesh.
 */
function createExposedVoxelEdgeGeometry(
  voxels: ReadonlyArray<OutlineVoxel>,
  centerForVoxel: (voxel: OutlineVoxel) => [number, number, number],
  cellSize: number,
  renderedFaceNormals: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  if (!voxels.length) return geometry

  const occupied = new Set(voxels.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
  type Edge = {
    start: [number, number, number]
    end: [number, number, number]
    normal: [number, number, number]
  }
  type EdgeState = {
    start: [number, number, number]
    end: [number, number, number]
    normals: Map<string, { count: number; edge: Edge }>
  }
  const edges = new Map<string, EdgeState>()
  const half = cellSize / 2
  const neighborOffsets: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const faceCorners = (normal: [number, number, number]): Array<[number, number, number]> => {
    if (normal[0] === 1) return [[half, -half, -half], [half, half, -half], [half, half, half], [half, -half, half]]
    if (normal[0] === -1) return [[-half, -half, half], [-half, half, half], [-half, half, -half], [-half, -half, -half]]
    if (normal[1] === 1) return [[-half, half, -half], [-half, half, half], [half, half, half], [half, half, -half]]
    if (normal[1] === -1) return [[-half, -half, half], [-half, -half, -half], [half, -half, -half], [half, -half, half]]
    if (normal[2] === 1) return [[-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half]]
    return [[-half, half, -half], [half, half, -half], [half, -half, -half], [-half, -half, -half]]
  }
  const directions = neighborOffsets.map((offset, index) => ({
    offset,
    normal: renderedFaceNormals[index],
    corners: faceCorners(renderedFaceNormals[index]),
  }))
  const pointKey = (point: [number, number, number]) => point.map((value) => Math.round(value * 1_000_000)).join(',')
  const edgeKey = (start: [number, number, number], end: [number, number, number]) => {
    const startKey = pointKey(start)
    const endKey = pointKey(end)
    return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`
  }

  voxels.forEach((voxel) => {
    const center = centerForVoxel(voxel)
    directions.forEach((face, faceIndex) => {
      const [dx, dy, dz] = face.offset
      if (occupied.has(`${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`)) return
      const facePoints = face.corners.map(([x, y, z]) => [center[0] + x, center[1] + y, center[2] + z] as [number, number, number])
      for (let index = 0; index < facePoints.length; index += 1) {
        const start = facePoints[index]
        const end = facePoints[(index + 1) % facePoints.length]
        const key = edgeKey(start, end)
        const previous = edges.get(key)
        if (!previous) {
          edges.set(key, {
            start,
            end,
            normals: new Map([[face.normal.join(','), {
              count: 1,
              edge: { start, end, normal: face.normal },
            }]]),
          })
        } else {
          const normalId = face.normal.join(',')
          const sameNormal = previous.normals.get(normalId)
          if (sameNormal) {
            sameNormal.count += 1
          } else {
            previous.normals.set(normalId, { count: 1, edge: { start, end, normal: face.normal } })
          }
        }
      }
    })
  })

  const positions: number[] = []
  edges.forEach((state) => {
    const edge = [...state.normals.values()].find((entry) => entry.count === 1)?.edge
    if (edge) positions.push(...edge.start, ...edge.end)
  })
  if (positions.length) geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

/**
 * Selection lines are deliberately rendered with depth testing enabled so
 * hidden edges do not show through the model.  Their vertices still sit on
 * the voxel surface, though, which makes them fight the solid mesh in the
 * depth buffer at oblique camera angles.  A tiny clip-space bias breaks that
 * tie without moving the outline in world space or disabling occlusion.
 */
function configureSelectionOutlineMaterial(material: THREE.LineBasicMaterial, cacheKey: string) {
  material.depthTest = true
  material.depthWrite = false
  material.depthFunc = THREE.LessEqualDepth
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n      gl_Position.z -= 0.00003 * gl_Position.w;'
    )
  }
  material.customProgramCacheKey = () => cacheKey
}

function isVisibleInObjectHierarchy(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object
  while (current) {
    if (!current.visible) return false
    current = current.parent
  }
  return true
}

/**
 * Render batches are not required to carry the logical part id themselves.
 * Greedy/surface replacements and some instanced asset batches keep that
 * metadata on their component group instead. Selection must resolve the
 * logical owner from the same object hierarchy that Three.js renders, rather
 * than relying on whichever batch happened to be built first.
 */
function scenePartIdForRenderObject(object: THREE.Object3D): string | undefined {
  let current: THREE.Object3D | null = object
  while (current) {
    const scenePartId = current.userData.scenePartId
    if (typeof scenePartId === 'string' && scenePartId.length > 0) return scenePartId
    current = current.parent
  }
  return undefined
}

function hasRenderableSelectionSource(mesh: THREE.Mesh): boolean {
  if (mesh instanceof THREE.InstancedMesh && mesh.count === 0) return false
  const position = mesh.geometry?.getAttribute('position')
  return Boolean(position && position.count > 0)
}

function hideSelectionHighlightsForPart(root: THREE.Object3D, scenePartId: string, except?: THREE.Mesh): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object === except || object.userData.selectionGlow) return
    if (scenePartIdForRenderObject(object) !== scenePartId) return
    const highlights = object.userData.selectionGlowParts as THREE.Object3D[] | undefined
    highlights?.forEach((highlight) => { highlight.visible = false })
  })
}

function addVoxelHighlight(mesh: THREE.Mesh) {
  // Deferred large cell meshes start with count=0 while their matrices and
  // colors are uploaded over animation frames. Do not cache an empty outline
  // here; the completion callback will create it after the instances exist.
  if (mesh instanceof THREE.InstancedMesh && mesh.count === 0) {
    return []
  }
  const existing = mesh.userData.selectionGlowParts as THREE.Object3D[] | undefined
  if (existing) {
    const hasGeometry = existing.some((part) => {
      const line = part as THREE.LineSegments
      const position = line.geometry?.getAttribute('position')
      return Boolean(position && position.count > 0)
    })
    if (hasGeometry) return existing
    // A worker payload can legitimately arrive with an empty outline buffer
    // while the solid mesh is already visible. Do not cache that empty result
    // forever: the next selection pass must be allowed to rebuild it from the
    // source voxel data or from a later replacement mesh.
    existing.forEach((part) => {
      part.parent?.remove(part)
      if (part instanceof THREE.LineSegments) {
        part.geometry.dispose()
        const material = part.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material.dispose()
      }
    })
    delete mesh.userData.selectionGlowParts
  }
  // A single logical part can be split into several InstancedMesh batches by
  // material, shape, or variant. The outline belongs to the part, not to one
  // batch: otherwise every batch would redraw the same silhouette and expose
  // internal material boundaries as if they were external edges.
  let edgeGeometry: THREE.BufferGeometry
  if (mesh instanceof THREE.InstancedMesh) {
    // Instanced meshes used to expand every cell into 24 transformed line
    // vertices here. That is needlessly expensive for large imported models:
    // most cells are internal and cannot contribute a visible outer frame.
    // Build only the exposed cells in local coordinates instead. The complete
    // component occupancy is shared on the parent part group, so different
    // material batches do not create outlines along their internal color
    // boundaries.
    edgeGeometry = mesh.userData.customVoxels
      ? createCustomVoxelOutlineGeometry(mesh)
      : createInstancedVoxelOutlineGeometry(mesh)
  } else if (mesh.userData.surfaceMesh) {
    edgeGeometry = createSurfaceVoxelOutlineGeometry(mesh)
  } else if (mesh.userData.greedyMesh) {
    const workerOutlinePositions = mesh.userData.greedyOutlinePositions as Float32Array | undefined
    const greedyVoxels = mesh.userData.greedyVoxels as Array<{ gx: number; gy: number; gz: number }> | undefined
    // A per-voxel outline is useful for small editable entities, but becomes
    // the dominant main-thread cost after enlargement: one 500k-voxel model
    // can otherwise allocate millions of line vertices just to highlight it.
    // The merged greedy surface already contains the visible silhouette, so
    // use its feature edges for large selections.
    // Editable custom components must retain per-voxel frames even when the
    // visible surface is rendered through the greedy worker mesh. The worker
    // outline intentionally merges coplanar edges, which makes a connected
    // hand-drawn stroke appear as one large highlighted island.
    // The worker outline is built from the merged visible surface and already
    // removes coplanar partition edges. Use it for every greedy mesh,
    // including editable/imported voxel entities. Rebuilding a complete frame
    // for every exposed source cell is what caused hidden grid lines to leak
    // through the selected model.
    edgeGeometry = workerOutlinePositions && workerOutlinePositions.length > 0
      ? (() => {
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(workerOutlinePositions, 3))
          return geometry
        })()
      : createGreedyVoxelOutlineGeometry(greedyVoxels)
  } else {
    edgeGeometry = createVoxelOutlineGeometry()
  }
  const glowMaterial = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.2 })
  configureSelectionOutlineMaterial(glowMaterial, 'moce-selection-outline-glow-v2')
  const glow = new THREE.LineSegments(edgeGeometry, glowMaterial)
  if (!(mesh instanceof THREE.InstancedMesh) && !mesh.userData.greedyMesh && !mesh.userData.surfaceMesh) glow.scale.setScalar(1.055)
  glow.renderOrder = 20
  glow.userData.selectionGlow = true
  glow.raycast = () => {}
  // Both passes use the same immutable edge positions. Cloning a large
  // EdgesGeometry doubled the allocation/copy cost exactly when a high
  // resolution model first became selected; the materials still provide the
  // soft underlay and crisp line as separate render passes.
  const edgeMaterial = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 })
  configureSelectionOutlineMaterial(edgeMaterial, 'moce-selection-outline-edge-v2')
  const edge = new THREE.LineSegments(edgeGeometry, edgeMaterial)
  if (!(mesh instanceof THREE.InstancedMesh) && !mesh.userData.greedyMesh && !mesh.userData.surfaceMesh) edge.scale.setScalar(1.012)
  edge.renderOrder = 21
  edge.userData.selectionGlow = true
  edge.raycast = () => {}
  mesh.add(glow, edge)
  const parts = [glow, edge]
  mesh.userData.selectionGlowParts = parts
  return parts
}

function createSurfaceVoxelOutlineGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const voxels = mesh.userData.customVoxels as Array<{ x: number; y: number; z: number }> | undefined
  const origin = mesh.userData.renderSurfaceOrigin as { x: number; y: number; z: number } | undefined
  const scale = VOXEL_WORLD_SIZE
  if (!voxels?.length || !origin) return new THREE.BufferGeometry()
  return createExposedVoxelEdgeGeometry(
    voxels,
    (voxel) => [
      (voxel.x - origin.x + 0.5) * scale,
      (voxel.z - origin.z + 0.5) * scale,
      (voxel.y - origin.y + 0.5) * scale,
    ],
    scale,
    [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]],
  )
}

function createCustomVoxelOutlineGeometry(mesh: THREE.InstancedMesh): THREE.BufferGeometry {
  const voxels = mesh.userData.customVoxels as Array<{ x: number; y: number; z: number }> | undefined
  const partGroup = mesh.parent
  const componentVoxels = partGroup?.userData.customComponentVoxels as Array<{ x: number; y: number; z: number }> | undefined
  const origin = partGroup?.userData.renderOrigin as { x: number; y: number; z: number } | undefined
  if (!voxels?.length || !componentVoxels?.length || !origin) return new THREE.BufferGeometry()

  const scale = VOXEL_WORLD_SIZE
  // Use the complete component occupancy, not one material batch, so a
  // color boundary inside the same solid does not create a fake outline.
  return createExposedVoxelEdgeGeometry(
    componentVoxels,
    (voxel) => [
      (voxel.x - origin.x + 0.5) * scale,
      (voxel.z - origin.z + 0.5) * scale,
      (voxel.y - origin.y + 0.5) * scale,
    ],
    scale,
    [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]],
  )
}

function createInstancedVoxelOutlineGeometry(mesh: THREE.InstancedMesh): THREE.BufferGeometry {
  const voxels = mesh.userData.instanceVoxels as Array<{ x: number; y: number; z: number }> | undefined
  if (!voxels?.length) return new THREE.BufferGeometry()
  const partGroup = mesh.parent
  const completeVoxels = partGroup?.userData.instanceVoxelAll as Array<{ x: number; y: number; z: number }> | undefined
  const occupied = partGroup?.userData.instanceVoxelOccupancy as Set<string> | undefined
  const dimensions = partGroup?.userData.instanceVoxelDimensions as { width: number; depth: number; height: number } | undefined
  const mirror = partGroup?.userData.instanceVoxelMirror as { x?: boolean; y?: boolean; z?: boolean } | undefined
  // The rendered instanced matrices are expressed around the same local
  // rotation pivot as buildAssetGroup(). Keep the outline in that exact
  // coordinate frame; omitting this offset leaves the white frame at the
  // unrotated origin while the model rotates around its persisted center.
  const pivot = partGroup?.userData.instanceVoxelPivot as { x?: number; y?: number; z?: number } | undefined
  if (!occupied || !dimensions) return createInstancedVoxelOutlineGeometryFallback(mesh)
  const outlineVoxels = completeVoxels?.length ? completeVoxels : voxels

  const scale = VOXEL_WORLD_SIZE
  return createExposedVoxelEdgeGeometry(
    outlineVoxels,
    (voxel) => {
      const localX = mirror?.x ? dimensions.width - 1 - voxel.x : voxel.x
      const localY = mirror?.z ? dimensions.height - 1 - voxel.y : voxel.y
      const localZ = mirror?.y ? dimensions.depth - 1 - voxel.z : voxel.z
      return [
        (localX + 0.5 - dimensions.width / 2) * scale - (pivot?.x ?? 0),
        (localZ + 0.5 - dimensions.depth / 2) * scale - (pivot?.y ?? 0),
        (localY + 0.5) * scale - (pivot?.z ?? 0),
      ]
    },
    scale,
    [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]],
  )
}

function createInstancedVoxelOutlineGeometryFallback(mesh: THREE.InstancedMesh): THREE.BufferGeometry {
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
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geometry
}

/**
 * Build the same per-voxel selection frame used by InstancedMesh for the
 * worker-generated greedy mesh.  Greedy rendering replaces the visible box
 * instances, so using one generic cube here would make large hand-drawn
 * entities appear to lose their selection outline.  Only voxels on the
 * outside surface need frames; depth testing still hides the back side.
 */
function createGreedyVoxelOutlineGeometry(voxels: Array<{ gx: number; gy: number; gz: number }> | undefined) {
  if (!voxels?.length) return new THREE.BufferGeometry()
  // Greedy meshes are rendered in voxel units and receive
  // `mesh.scale.setScalar(VOXEL_WORLD_SIZE)` in attachGreedyMesh().  Keep the
  // outline in that same unit space.  Multiplying these coordinates here as
  // well makes the outline inherit VOXEL_WORLD_SIZE a second time, which is
  // why a selected hand-drawn entity could show a tiny, displaced white copy
  // beside the real model.
  return createExposedVoxelEdgeGeometry(
    voxels.map((voxel) => ({ x: voxel.gx, y: voxel.gy, z: voxel.gz })),
    (voxel) => [voxel.x + 0.5, voxel.y + 0.5, voxel.z + 0.5],
    1,
  )
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

function VoxelViewport({ project, authoritativeProjectRef, sceneParts, occupancyIndex, assetTransformCache, selectedId, selectionRefreshKey, selectedPartIds, checkedPartIds, lockedPartIds, editEntityId, colorPreview, geometryPreview, geometryApplying, historyResetKey, tool, toolboxOpen, drawingPlane, drawOperation, brushSize, voxelBrushShape, activeMaterial, materials, dragAxis, placementAsset, copyPreview, transformPreview, viewMode, showGrid, showBoundary, zoomLevel, onZoomChange, onCameraApiChange, onInteractionChange, onRaycastVoxel, onSyncSceneOccupancyTransforms, onSelect, onSelectMultiple, onCancelPendingEntityOperation, onSelectMaterial, onReplaceMaterial, onAddVoxel, onRemoveVoxel, onRemoveVoxels, onEditInstanceVoxel, onEditInstanceVoxels, onApplyVoxelBatch, onPreviewScenePartsMove, onCommitScenePartsMove, onCancelScenePartsMove, onPreviewPlacement, onPlaceAsset, onNotice, onExitEditMode, onEnterEditMode, onRename, onBatchOperation, children }: { project: ProjectState; authoritativeProjectRef: React.MutableRefObject<ProjectState>; sceneParts: SceneEntityPart[]; occupancyIndex: SceneOccupancyIndex | null; assetTransformCache: AssetTransformCache; selectedId: string; selectionRefreshKey: number; selectedPartIds: string[]; checkedPartIds: string[]; lockedPartIds: Set<string>; editEntityId: string | null; colorPreview: ColorPreviewState | null; geometryPreview: GeometryPreviewState | null; geometryApplying: boolean; historyResetKey: number; tool: Tool; toolboxOpen: boolean; drawingPlane: DrawingPlane; drawOperation: DrawOperation; brushSize: number; voxelBrushShape: VoxelShape; activeMaterial: string; materials: Material[]; dragAxis: 'horizontal' | 'vertical'; placementAsset: VoxelAsset | null; copyPreview: CopyPreviewState | null; transformPreview: DiscreteTransformPreviewState | null; viewMode: '正交' | '透视'; showGrid: boolean; showBoundary: boolean; zoomLevel: number; onZoomChange: (value: number) => void; onCameraApiChange: (api: CameraControlApi | null) => void; onInteractionChange: (active: boolean) => void; onRaycastVoxel: (origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }) => SceneVoxelRayHit | null; onSyncSceneOccupancyTransforms: () => void; onSelect: (id: string) => void; onSelectMultiple: (partIds: string[], additive?: boolean) => void; onCancelPendingEntityOperation: () => void; onSelectMaterial: (id: string) => void; onReplaceMaterial: (id: string, color: string) => void; onAddVoxel: (voxel: Voxel) => void; onRemoveVoxel: (voxel: Voxel) => void; onRemoveVoxels: (voxels: Voxel[]) => void; onEditInstanceVoxel: (instanceId: string, voxel: Voxel, mode: VoxelOverride['mode']) => void; onEditInstanceVoxels: (instanceId: string, voxels: Voxel[], mode: VoxelOverride['mode']) => void; onApplyVoxelBatch: (voxels: Voxel[], operation: DrawOperation) => void; onPreviewScenePartsMove: (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number) => GridMoveResult; onCommitScenePartsMove: (parts: SceneEntityPart[], deltaX: number, deltaY: number, deltaZ: number) => GridMoveResult; onCancelScenePartsMove: () => void; onPreviewPlacement: (assetId: string, x: number, z: number) => PlacementPreview | null; onPlaceAsset: (assetId: string, x: number, z: number) => void; onNotice: (message: string) => void; onExitEditMode: () => void; onEnterEditMode: (entityId: string) => void; onRename: (targetId: string, assemblyId?: string) => void; onBatchOperation: (partIds: string[], operation: 'delete' | 'lock' | 'assemble') => void; children?: React.ReactNode }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const camerasRef = useRef<{ orthographic: THREE.OrthographicCamera; perspective: THREE.PerspectiveCamera } | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const groupRef = useRef<THREE.Group | null>(null)
  const placementGroupRef = useRef<THREE.Group | null>(null)
  const copyPreviewGroupRef = useRef<THREE.Group | null>(null)
  const transformPreviewGroupRef = useRef<THREE.Group | null>(null)
  const toolPreviewGroupRef = useRef<THREE.Group | null>(null)
  const geometryPreviewGroupRef = useRef<THREE.Group | null>(null)
  const placementPreviewRef = useRef<PlacementPreview | null>(null)
  const chunkMeshWorkerRef = useRef<ChunkMeshWorkerClient | null>(null)
  const voxelToolsWorkerRef = useRef<VoxelToolsWorkerClient | null>(null)
  const chunkMeshRevisionRef = useRef(0)
  const axisGizmoRef = useRef<SVGSVGElement | null>(null)
  const raycasterRef = useRef(new THREE.Raycaster())
  const pointerRef = useRef(new THREE.Vector2())
  const controlsRef = useRef<OrbitControls | null>(null)
  const onZoomChangeRef = useRef(onZoomChange)
  const zoomReportTimerRef = useRef<number | null>(null)
  const cameraZoomLevelRef = useRef(100)
  const cameraFitZoomRef = useRef(1)
  const invalidateRenderRef = useRef<(durationMs?: number) => void>(() => {})
  // Rendering a large greedy mesh is GPU-bound during pointer interactions.
  // Keep the interaction-quality switch imperative so it does not add a React
  // render to every pointer event.
  const interactionQualityRef = useRef<(active: boolean) => void>(() => {})
  const perspectiveBaseDistanceRef = useRef(Math.sqrt(16 ** 2 + 18 ** 2 + 18 ** 2))
  // Perspective zoom is expressed with the same visual scale as the
  // orthographic ruler. Moving the perspective camera closer for very large
  // values (for example 20,000%) puts it inside the scene and also makes
  // OrbitControls' pan delta proportional to an extremely small distance.
  // Keep the camera at the fitted distance and change the field of view
  // instead. This preserves the zoom scale without near-plane clipping or a
  // sluggish drag response.
  const perspectiveBaseFovRef = useRef(38)
  const editRenderStateRef = useRef<{ active: boolean; partIds: Set<string> }>({ active: false, partIds: new Set() })
  const drawingGestureRef = useRef<DrawingGesture | null>(null)
  const drawingMoveFrameRef = useRef<number | null>(null)
  const pendingDrawingPointRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null)
  // Kept for the compatibility helpers below. The active drawing path uses
  // drawingGestureRef and onApplyVoxelBatch; these legacy refs are never
  // populated by current pointer handlers.
  const editGestureRef = useRef<{ pointerId: number; x: number; y: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  const editStrokeVisitedRef = useRef(new Set<string>())
  const editMoveFrameRef = useRef<number | null>(null)
  const pendingEditPointRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null)
  const scenePartsRef = useRef(sceneParts)
  const selectedPartIdsRef = useRef(selectedPartIds)
  // Keep the imperative hit-test/highlight source current during render.
  // React effects may otherwise briefly expose the previous scene-part graph
  // after an erase mutation.
  scenePartsRef.current = sceneParts
  selectedPartIdsRef.current = selectedPartIds
  // Selection outlines are attached to the currently visible render batch,
  // while scene parts can be replaced asynchronously after a scene open,
  // asset download, or voxel edit. Keep a cheap logical-part signature so
  // the outline pass runs again when that render source changes, even when
  // the selection itself did not change.
  const selectionScenePartKey = sceneParts.map((part) => (
    `${part.id}:${part.memberKey}:${part.instanceId ?? ''}:${part.partId}:${part.voxels.length}:${part.assemblyIds?.join(',') ?? ''}`
  )).join('|')
  const selectGestureRef = useRef<SelectGesture | null>(null)
  const boxSelectGestureRef = useRef<BoxSelectGesture | null>(null)
  const cameraGestureRef = useRef<{ pointerId: number; button: 'right'; lastX: number; lastY: number; moved: boolean; contextPartIds?: string[] } | null>(null)
  // The drag gesture already places the Three.js roots at their final
  // position before React receives the committed project snapshot. The
  // transform effect still reconciles state, but its extra render is
  // redundant for this path and can make a large model pause after mouse-up.
  const skipNextTransformRenderRef = useRef(false)
  // A transition can publish one render of the pre-drag project after the
  // imperative drag preview has already reached its destination. Keep the
  // final object positions until the render whose projectRef is authoritative
  // has run; this prevents the visible flash-back/flash-forward on release.
  const pendingDragVisualRootsRef = useRef(new Map<THREE.Object3D, THREE.Vector3>())
  const finishDragRenderBurstRef = useRef<() => void>(() => {})
  const previewTouchPointersRef = useRef(new Set<number>())
  const previewTouchGestureRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null)
  const previewMultiTouchRef = useRef(false)
  const [sceneSelectionBox, setSceneSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [sceneContextMenu, setSceneContextMenu] = useState<{ partIds: string[]; x: number; y: number } | null>(null)
  const [toolPreviewVoxels, setToolPreviewVoxels] = useState<Voxel[]>([])
  const [toolPreviewMesh, setToolPreviewMesh] = useState<VoxelGeometryMesh | null>(null)
  const toolPreviewRevisionRef = useRef(0)
  const latestToolPreviewVoxelsRef = useRef<Voxel[]>([])
  const toolPreviewMeshRef = useRef<THREE.InstancedMesh | null>(null)
  const toolPreviewSurfaceMeshRef = useRef<THREE.Mesh | null>(null)
  const toolPreviewMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null)
  const toolPreviewCapacityRef = useRef(0)
  const [ready, setReady] = useState(false)
  // OrbitControls keeps its active pointer/state internally. A drawing tool
  // can be selected from the floating toolbox while the previous viewport
  // gesture never reached the canvas' pointer-up handler (the pointer may be
  // captured by the overlay instead). Reset that state explicitly so the
  // next selection-mode drag cannot replay the stale rotation in one burst.
  const resetOrbitControlsGesture = () => {
    const controls = controlsRef.current
    if (!controls) return
    const runtimeControls = controls as OrbitControls & {
      state?: number
      _pointers?: number[]
      _pointerPositions?: Record<string, unknown>
    }
    runtimeControls.state = -1
    if (runtimeControls._pointers) runtimeControls._pointers.length = 0
    if (runtimeControls._pointerPositions) {
      Object.keys(runtimeControls._pointerPositions).forEach((pointerId) => delete runtimeControls._pointerPositions?.[pointerId])
    }
    const dampingEnabled = controls.enableDamping
    controls.enableDamping = false
    controls.update()
    controls.enableDamping = dampingEnabled
    controls.enabled = true
  }
  const setViewportInteraction = useStableEvent((active: boolean) => {
    interactionQualityRef.current(active)
    onInteractionChange(active)
  })
  useEffect(() => {
    onZoomChangeRef.current = onZoomChange
  }, [onZoomChange])
  useEffect(() => {
    scenePartsRef.current = sceneParts
  }, [sceneParts])
  useEffect(() => {
    // Geometry confirmation rebuilds the occupancy index in the background.
    // Keep camera browsing available while the scene-editing handlers remain
    // locked; users should not have to wait for a large model's index to finish
    // just to rotate, pan, or zoom the viewport.
    if (controlsRef.current) controlsRef.current.enabled = true
  }, [geometryApplying])
  useEffect(() => {
    if (drawingMoveFrameRef.current !== null) cancelAnimationFrame(drawingMoveFrameRef.current)
    drawingMoveFrameRef.current = null
    pendingDrawingPointRef.current = null
    const previousGesture = drawingGestureRef.current
    if (previousGesture?.extrudeSessionId) voxelToolsWorkerRef.current?.disposeExtrudeSession(previousGesture.extrudeSessionId)
    drawingGestureRef.current = null
    editStrokeVisitedRef.current.clear()
    latestToolPreviewVoxelsRef.current = []
    toolPreviewRevisionRef.current += 1
    setToolPreviewVoxels([])
    setToolPreviewMesh(null)
    // Changing tools, planes, or closing the toolbox is also a gesture
    // boundary. Finalize any already-published brush transaction and clear
    // OrbitControls' private pointer state before the next tool receives a
    // pointer event.
    setViewportInteraction(false)
    resetOrbitControlsGesture()
  }, [tool, drawingPlane, toolboxOpen, editEntityId, setViewportInteraction])
  useEffect(() => {
    // Undo/redo is a hard interaction boundary. OrbitControls, pointer
    // capture, queued drawing frames and drag previews are imperative state;
    // changing the React project alone leaves those old gestures alive and
    // lets the next pointer event publish a stale transform or rotate the
    // camera in one burst.
    if (drawingMoveFrameRef.current !== null) cancelAnimationFrame(drawingMoveFrameRef.current)
    drawingMoveFrameRef.current = null
    pendingDrawingPointRef.current = null
    if (editMoveFrameRef.current !== null) cancelAnimationFrame(editMoveFrameRef.current)
    editMoveFrameRef.current = null
    pendingEditPointRef.current = null
    const previousDrawingGesture = drawingGestureRef.current
    if (previousDrawingGesture?.extrudeSessionId) voxelToolsWorkerRef.current?.disposeExtrudeSession(previousDrawingGesture.extrudeSessionId)
    drawingGestureRef.current = null
    editGestureRef.current = null
    editStrokeVisitedRef.current.clear()
    cameraGestureRef.current = null
    boxSelectGestureRef.current = null
    setSceneSelectionBox(null)
    if (selectGestureRef.current) resetDragVisuals(selectGestureRef.current)
    selectGestureRef.current = null
    latestToolPreviewVoxelsRef.current = []
    toolPreviewRevisionRef.current += 1
    setToolPreviewVoxels([])
    setToolPreviewMesh(null)
    onCancelScenePartsMove()
    setViewportInteraction(false)
    if (controlsRef.current) controlsRef.current.enabled = true
    resetOrbitControlsGesture()
  }, [historyResetKey, onCancelScenePartsMove, setViewportInteraction])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const previousGesture = drawingGestureRef.current
      if (previousGesture?.extrudeSessionId) voxelToolsWorkerRef.current?.disposeExtrudeSession(previousGesture.extrudeSessionId)
      drawingGestureRef.current = null
      latestToolPreviewVoxelsRef.current = []
      toolPreviewRevisionRef.current += 1
      setToolPreviewVoxels([])
      setToolPreviewMesh(null)
      onCancelPendingEntityOperation()
      setViewportInteraction(false)
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onCancelPendingEntityOperation, onInteractionChange])
  useEffect(() => () => {
    previewTouchPointersRef.current.clear()
    previewTouchGestureRef.current = null
    previewMultiTouchRef.current = false
  }, [])
  useEffect(() => {
    const client = new ChunkMeshWorkerClient()
    chunkMeshWorkerRef.current = client
    const voxelToolsClient = new VoxelToolsWorkerClient()
    voxelToolsWorkerRef.current = voxelToolsClient
    return () => {
      client.dispose()
      chunkMeshWorkerRef.current = null
      voxelToolsClient.dispose()
      voxelToolsWorkerRef.current = null
    }
  }, [])
  // Keep persisted asset coordinates backward-compatible while presenting the scene
  // in the editor's conventional XY ground plane with Z as the vertical axis.
  const toSceneWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, y)

  // Orbiting a selection must use the effective scene-space geometry, not the
  // asset's canonical origin. sceneParts already expands an assembly into its
  // member parts, so this also covers nested assemblies and multi-select.
  // Reuse gridVoxelBoundsCache through scenePartsGridBounds(). Do not call
  // voxelBounds() here: after a box selection that would rescan every voxel of
  // every selected imported model on the main thread, which can make the
  // release of a multi-selection look like a deadlock.
  const selectedOrbitCenter = useMemo(() => {
    if (!selectedPartIds.length) return null
    const selectedIds = new Set(selectedPartIds)
    const selectedParts = sceneParts.filter((part) => selectedIds.has(part.id))
    // The occupancy index already owns project-space bounds for every part.
    // Use it as the O(1) path; the helper falls back to the cached canonical
    // bounds for a part that has not reached the index yet.
    const bounds = scenePartsGridBounds(selectedParts, occupancyIndex)
    if (!bounds) return null
    // Voxel bounds are inclusive. Add half a cell on each side so the pivot
    // is the geometric center of the occupied cell volume, not the center of
    // the corner coordinates.
    return toSceneWorld(
      ((bounds.minX + bounds.maxX + 1) / 2) * VOXEL_WORLD_SIZE,
      ((bounds.minY + bounds.maxY + 1) / 2) * VOXEL_WORLD_SIZE,
      ((bounds.minZ + bounds.maxZ + 1) / 2) * VOXEL_WORLD_SIZE,
    )
  }, [sceneParts, selectedPartIds, occupancyIndex])
  const selectedOrbitCenterRef = useRef<THREE.Vector3 | null>(null)
  selectedOrbitCenterRef.current = selectedOrbitCenter
  // The orbit pivot belongs to the selection identity, not to the current
  // voxel bounds. During edit mode the bounds can change on every brush
  // transaction; following that moving AABB would translate the camera and
  // make the edited entity drift in the viewport.
  const orbitSelectionKey = selectedPartIds.join('|')
  const orbitPivotRef = useRef<THREE.Vector3 | null>(null)
  const orbitPivotSelectionKeyRef = useRef<string | null>(null)

  const scheduleZoomReport = () => {
    if (zoomReportTimerRef.current !== null) window.clearTimeout(zoomReportTimerRef.current)
    zoomReportTimerRef.current = window.setTimeout(() => {
      zoomReportTimerRef.current = null
      onZoomChangeRef.current(cameraZoomLevelRef.current)
    }, 120)
  }

  const reportZoomImmediately = () => {
    if (zoomReportTimerRef.current !== null) window.clearTimeout(zoomReportTimerRef.current)
    zoomReportTimerRef.current = null
    onZoomChangeRef.current(cameraZoomLevelRef.current)
  }

  // This is the single imperative zoom path. Wheel/trackpad input and the
  // footer buttons both call it; React only receives the coalesced value for
  // the percentage ruler and never drives the camera during a gesture.
  const sceneViewTarget = (bounds: SceneBounds) => new THREE.Vector3(0, 0, bounds.z * VOXEL_WORLD_SIZE / 2)

  const desiredOrbitTarget = () => orbitPivotRef.current?.clone()
    ?? sceneViewTarget(sceneBoundsForProject(authoritativeProjectRef.current))

  // OrbitControls rotates around controls.target.  When selection changes,
  // translate both cameras by the same delta before replacing the target so
  // changing the pivot does not visually jump the current view.  The inactive
  // camera is translated too, otherwise switching between orthographic and
  // perspective would resurrect the old scene-centered pivot.
  const syncOrbitTarget = (targetOverride?: THREE.Vector3) => {
    const cameras = camerasRef.current
    const controls = controlsRef.current
    if (!cameras || !controls) return
    const nextTarget = targetOverride?.clone() ?? desiredOrbitTarget()
    const delta = nextTarget.clone().sub(controls.target)
    if (delta.lengthSq() < 0.00000001) return
    cameras.orthographic.position.add(delta)
    cameras.perspective.position.add(delta)
    controls.target.copy(nextTarget)
    controls.update()
    invalidateRenderRef.current(220)
  }

  // Keep the orthographic camera outside the scene volume. Orthographic
  // projection does not need a distance for framing, but it still has a near
  // clipping plane. A fixed camera position therefore enters a large scene
  // (for example a 1000 mm boundary) and clips the ground plane into a
  // diagonal polygon even when the projected corners fit the viewport.
  const cameraDistanceForBounds = (bounds: SceneBounds) => {
    const width = bounds.x * VOXEL_WORLD_SIZE
    const depth = bounds.y * VOXEL_WORLD_SIZE
    const height = bounds.z * VOXEL_WORLD_SIZE
    return Math.max(28, Math.hypot(width, depth, height) * 1.2 + 2)
  }

  const calculateCameraFit = (position: THREE.Vector3, up: THREE.Vector3, bounds: SceneBounds, target = sceneViewTarget(bounds)) => {
    const cameras = camerasRef.current
    if (!cameras) return { orthographicZoom: 1, perspectiveDistance: perspectiveBaseDistanceRef.current }

    const width = bounds.x * VOXEL_WORLD_SIZE
    const depth = bounds.y * VOXEL_WORLD_SIZE
    const height = bounds.z * VOXEL_WORLD_SIZE
    const corners = [
      new THREE.Vector3(-width / 2, -depth / 2, 0),
      new THREE.Vector3(width / 2, -depth / 2, 0),
      new THREE.Vector3(width / 2, depth / 2, 0),
      new THREE.Vector3(-width / 2, depth / 2, 0),
      new THREE.Vector3(-width / 2, -depth / 2, height),
      new THREE.Vector3(width / 2, -depth / 2, height),
      new THREE.Vector3(width / 2, depth / 2, height),
      new THREE.Vector3(-width / 2, depth / 2, height),
    ]

    // Use a probe camera so calculating the fit never changes the live camera
    // during a gesture. The projected rectangle is evaluated in camera space,
    // which keeps the fit correct for the oblique default view and all view-cube
    // orientations.
    const orthographicProbe = cameras.orthographic.clone()
    orthographicProbe.position.copy(position)
    orthographicProbe.up.copy(up)
    orthographicProbe.lookAt(target)
    orthographicProbe.updateMatrixWorld(true)
    let maxCameraX = 0
    let maxCameraY = 0
    for (const corner of corners) {
      const cameraPoint = corner.clone().applyMatrix4(orthographicProbe.matrixWorldInverse)
      maxCameraX = Math.max(maxCameraX, Math.abs(cameraPoint.x))
      maxCameraY = Math.max(maxCameraY, Math.abs(cameraPoint.y))
    }
    const halfWidth = Math.abs(orthographicProbe.right - orthographicProbe.left) / 2
    const halfHeight = Math.abs(orthographicProbe.top - orthographicProbe.bottom) / 2
    const orthographicZoom = Math.max(0.02, Math.min(1, (halfWidth / Math.max(maxCameraX, 0.0001)) * 0.9, (halfHeight / Math.max(maxCameraY, 0.0001)) * 0.9))

    const perspectiveProbe = cameras.perspective.clone()
    perspectiveProbe.position.copy(position)
    perspectiveProbe.up.copy(up)
    perspectiveProbe.lookAt(target)
    perspectiveProbe.updateMatrixWorld(true)
    maxCameraX = 0
    maxCameraY = 0
    for (const corner of corners) {
      const cameraPoint = corner.clone().applyMatrix4(perspectiveProbe.matrixWorldInverse)
      maxCameraX = Math.max(maxCameraX, Math.abs(cameraPoint.x))
      maxCameraY = Math.max(maxCameraY, Math.abs(cameraPoint.y))
    }
    const halfFov = THREE.MathUtils.degToRad(perspectiveProbe.fov / 2)
    const perspectiveDistance = Math.max(28, maxCameraY / Math.tan(halfFov) * 1.12, maxCameraX / (Math.tan(halfFov) * Math.max(perspectiveProbe.aspect, 0.0001)) * 1.12)
    return { orthographicZoom, perspectiveDistance }
  }

  const refreshCameraFit = () => {
    const cameras = camerasRef.current
    const camera = cameraRef.current
    if (!cameras || !camera) return
    const bounds = sceneBoundsForProject(project)
    const controls = controlsRef.current
    const target = controls?.target.clone() ?? sceneViewTarget(bounds)
    const fit = calculateCameraFit(camera.position.clone(), camera.up.clone(), bounds, target)
    cameraFitZoomRef.current = fit.orthographicZoom
    perspectiveBaseDistanceRef.current = fit.perspectiveDistance
    cameras.orthographic.far = Math.max(1000, Math.hypot(bounds.x, bounds.y, bounds.z) * VOXEL_WORLD_SIZE * 4)
    cameras.perspective.far = cameras.orthographic.far
    cameras.orthographic.updateProjectionMatrix()
    cameras.perspective.updateProjectionMatrix()
  }

  const setCameraZoomLevel = (requestedZoom: number, force = false, reportImmediately = false) => {
    const cameras = camerasRef.current
    const controls = controlsRef.current
    const nextZoom = clampZoomLevel(requestedZoom)
    if (!cameras || !controls) {
      onZoomChangeRef.current(nextZoom)
      return
    }
    if (!force && Math.abs(cameraZoomLevelRef.current - nextZoom) < 0.001) return
    cameraZoomLevelRef.current = nextZoom
    const zoomFactor = nextZoom / 100
    cameras.orthographic.zoom = cameraFitZoomRef.current * zoomFactor
    cameras.orthographic.updateProjectionMatrix()
    const direction = cameras.perspective.position.clone().sub(controls.target)
    if (direction.lengthSq() > 0.000001) {
      // Keep the perspective camera outside the scene. FOV scaling gives the
      // same apparent magnification as distance scaling at the fitted camera
      // position, while keeping OrbitControls pan sensitivity stable.
      cameras.perspective.position.copy(controls.target).add(direction.normalize().multiplyScalar(perspectiveBaseDistanceRef.current))
    }
    cameras.perspective.zoom = 1
    cameras.perspective.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(perspectiveBaseFovRef.current / 2)) / zoomFactor),
    )
    cameras.perspective.updateProjectionMatrix()
    controls.update()
    if (reportImmediately) reportZoomImmediately()
    else scheduleZoomReport()
    invalidateRenderRef.current(220)
  }

  const materialMap = useMemo(() => new Map(project.materials.map((material) => [material.id, new THREE.MeshStandardMaterial({ color: material.color, roughness: 0.9, metalness: 0 })])), [project.materials])
  // Keep transform-only commits off the expensive geometry effects below.
  // Position, custom-entity offsets and partial part offsets are applied by a
  // small transform pass; this key changes only when a mesh must be rebuilt.
  const sceneGeometryRenderKey = useMemo(
    () => `${project.instances.map((instance) => `${instance.id}:${sceneInstanceGeometrySignature(instance)}`).join('\u001e')}\u001fcustom:${project.customVoxels.length}`,
    [project.instances, project.customVoxels, project.customVoxels.length],
  )

  useEffect(() => {
    const root = toolPreviewGroupRef.current
    if (!root) return
    const oldSurface = toolPreviewSurfaceMeshRef.current
    if (oldSurface) {
      root.remove(oldSurface)
      oldSurface.geometry.dispose()
      if (Array.isArray(oldSurface.material)) oldSurface.material.forEach((material) => material.dispose())
      else oldSurface.material.dispose()
      toolPreviewSurfaceMeshRef.current = null
    }
    if (toolPreviewMesh) {
      if (toolPreviewMeshRef.current) {
        toolPreviewMeshRef.current.count = 0
        toolPreviewMeshRef.current.visible = false
      }
      const positions = toolPreviewMesh.positions.slice()
      for (let index = 0; index < positions.length; index += 1) positions[index] *= VOXEL_WORLD_SIZE
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(toolPreviewMesh.normals, 3, true))
      attachVoxelAoAttribute(geometry, toolPreviewMesh.ao, positions.length / 3)
      geometry.setIndex(new THREE.BufferAttribute(toolPreviewMesh.indices, 1))
      const subtractPreview = drawOperation === 'subtract'
      if (!subtractPreview) {
        const vertexColors = new Float32Array(toolPreviewMesh.materialIds.length * 3)
        toolPreviewMesh.materialIds.forEach((materialId, index) => {
          const materialKey = toolPreviewMesh.materialKeys[materialId] ?? activeMaterial
          const color = materialKey.startsWith('#')
            ? new THREE.Color(materialKey)
            : (materialMap.get(materialKey)?.color ?? materialMap.get(activeMaterial)?.color ?? new THREE.Color('#d16a4c'))
          vertexColors[index * 3] = color.r
          vertexColors[index * 3 + 1] = color.g
          vertexColors[index * 3 + 2] = color.b
        })
        geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3))
      }
      geometry.computeBoundingSphere()
      const material = new THREE.MeshStandardMaterial({ color: subtractPreview ? '#e06b5b' : '#ffffff', vertexColors: !subtractPreview, transparent: true, opacity: 0.34, depthWrite: false, roughness: 0.9, metalness: 0 })
      const surface = new THREE.Mesh(geometry, material)
      surface.position.copy(toSceneWorld(voxelToWorld(toolPreviewMesh.minX), voxelToWorld(toolPreviewMesh.minY), voxelToWorld(toolPreviewMesh.minZ)))
      surface.userData.toolPreview = true
      toolPreviewSurfaceMeshRef.current = surface
      root.add(surface)
      invalidateRenderRef.current(120)
      return
    }
    const previewColor = drawOperation === 'subtract' ? '#e06b5b' : (materialMap.get(activeMaterial)?.color ?? new THREE.Color('#d16a4c'))
    if (!toolPreviewVoxels.length) {
      if (toolPreviewMeshRef.current) {
        toolPreviewMeshRef.current.count = 0
        toolPreviewMeshRef.current.visible = false
      }
      invalidateRenderRef.current()
      return
    }
    let material = toolPreviewMaterialRef.current
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: previewColor,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        roughness: 0.9,
        metalness: 0,
      })
      toolPreviewMaterialRef.current = material
    } else material.color.set(previewColor instanceof THREE.Color ? previewColor : previewColor)
    let mesh = toolPreviewMeshRef.current
    if (!mesh || toolPreviewCapacityRef.current < toolPreviewVoxels.length) {
      if (mesh) {
        root.remove(mesh)
      }
      mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, material, toolPreviewVoxels.length)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.frustumCulled = false
      mesh.userData.toolPreview = true
      toolPreviewMeshRef.current = mesh
      toolPreviewCapacityRef.current = toolPreviewVoxels.length
      root.add(mesh)
    }
    mesh.visible = true
    mesh.count = toolPreviewVoxels.length
    const matrix = new THREE.Matrix4()
    toolPreviewVoxels.forEach((voxel, index) => {
      matrix.makeTranslation(voxelCenterToWorld(voxel.x), voxelCenterToWorld(voxel.z), voxelCenterToWorld(voxel.y))
      mesh!.setMatrixAt(index, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    invalidateRenderRef.current(120)
  }, [toolPreviewVoxels, toolPreviewMesh, materialMap, activeMaterial, drawOperation])

  useEffect(() => () => {
    const mesh = toolPreviewMeshRef.current
    if (mesh) mesh.removeFromParent()
    const surface = toolPreviewSurfaceMeshRef.current
    if (surface) {
      surface.removeFromParent()
      surface.geometry.dispose()
      if (Array.isArray(surface.material)) surface.material.forEach((material) => material.dispose())
      else surface.material.dispose()
    }
    toolPreviewSurfaceMeshRef.current = null
    toolPreviewMaterialRef.current?.dispose()
    toolPreviewMeshRef.current = null
    toolPreviewMaterialRef.current = null
    toolPreviewCapacityRef.current = 0
  }, [])

  useEffect(() => {
    const root = geometryPreviewGroupRef.current
    if (!root) return
    disposeThreeObject(root)
    root.clear()
    const previewState = geometryPreview
    const preview = previewState?.result?.voxels ?? []
    if (!previewState || !preview.length) { invalidateRenderRef.current(); return }

    // Large geometry previews are rendered from the worker's greedy surface
    // mesh. The full voxel list remains in previewState for confirmation, but
    // Three.js no longer receives one InstancedMesh entry per voxel (or one
    // temporary array copy per color bucket).
    // An enlargement is a discrete cell operation: its preview must show the
    // same unit-cell representation that will be committed, rather than the
    // worker's greedy surface mesh which visually merges adjacent cells into
    // large blocks. Shell/reduction previews can still use the compact mesh.
    const preserveScaleCells = previewState?.operation === 'scale' && previewState.scaleMode === 'up'
    const previewMesh = preserveScaleCells ? null : previewState?.mesh
    if (previewMesh) {
      const positions = previewMesh.positions.slice()
      for (let index = 0; index < positions.length; index += 1) positions[index] *= VOXEL_WORLD_SIZE
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(previewMesh.normals, 3, true))
      attachVoxelAoAttribute(geometry, previewMesh.ao, positions.length / 3)
      geometry.setIndex(new THREE.BufferAttribute(previewMesh.indices, 1))
      const invalid = !previewState.valid
      if (!invalid) {
        const vertexColors = new Float32Array(previewMesh.materialIds.length * 3)
        previewMesh.materialIds.forEach((materialId, index) => {
          const materialKey = previewMesh.materialKeys[materialId] ?? 'terracotta'
          const color = materialKey.startsWith('#')
            ? new THREE.Color(materialKey)
            : (materialMap.get(materialKey)?.color ?? materialMap.get('terracotta')?.color ?? new THREE.Color('#d16a4c'))
          vertexColors[index * 3] = color.r
          vertexColors[index * 3 + 1] = color.g
          vertexColors[index * 3 + 2] = color.b
        })
        geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3))
      }
      geometry.computeBoundingSphere()
      const material = new THREE.MeshStandardMaterial({
        color: invalid ? '#d45445' : '#ffffff',
        vertexColors: !invalid,
        transparent: true,
        opacity: invalid ? 0.18 : 0.34,
        depthWrite: false,
        roughness: 0.9,
        metalness: 0,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.copy(toSceneWorld(voxelToWorld(previewMesh.minX), voxelToWorld(previewMesh.minY), voxelToWorld(previewMesh.minZ)))
      mesh.userData.geometryPreview = true
      root.add(mesh)
      invalidateRenderRef.current(160)
      return
    }

    const byColor = new Map<string, Voxel[]>()
    preview.forEach((voxel) => {
      const color = previewState && !previewState.valid
        ? '#d45445'
        : voxel.paintMaterialId?.startsWith('#') ? voxel.paintMaterialId : voxel.materialId.startsWith('#') ? voxel.materialId : (materialMap.get(voxel.paintMaterialId ?? voxel.materialId)?.color.getStyle() ?? '#d16a4c')
      const bucket = byColor.get(color)
      if (bucket) bucket.push(voxel)
      else byColor.set(color, [voxel])
    })
    byColor.forEach((voxels, color) => {
      const mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: previewState?.valid ? 0.34 : 0.18, depthWrite: false, roughness: 0.9, metalness: 0 }), voxels.length)
      const matrix = new THREE.Matrix4()
      voxels.forEach((voxel, index) => { matrix.makeTranslation(voxelCenterToWorld(voxel.x), voxelCenterToWorld(voxel.z), voxelCenterToWorld(voxel.y)); mesh.setMatrixAt(index, matrix) })
      mesh.instanceMatrix.needsUpdate = true
      mesh.userData.geometryPreview = true
      root.add(mesh)
    })
    invalidateRenderRef.current(160)
  }, [geometryPreview, materialMap])
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
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
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
    const ambient = new THREE.HemisphereLight('#fff7ec', '#34434a', 1.25)
    scene.add(ambient)
    const key = new THREE.DirectionalLight('#fff0d8', 1.45)
    key.position.set(14, 18, 22)
    key.castShadow = true
    scene.add(key)
    const fill = new THREE.DirectionalLight('#b9d5ff', 0.62)
    fill.position.set(-18, 10, -14)
    scene.add(fill)
    const rim = new THREE.DirectionalLight('#ffd8bc', 0.28)
    rim.position.set(2, 8, -24)
    scene.add(rim)
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
    const transformPreviewGroup = new THREE.Group()
    const toolPreviewGroup = new THREE.Group()
    const geometryPreviewGroup = new THREE.Group()
    placementGroup.name = 'placement-preview-root'
    copyPreviewGroup.name = 'copy-preview-root'
    transformPreviewGroup.name = 'transform-preview-root'
    toolPreviewGroup.name = 'tool-preview-root'
    geometryPreviewGroup.name = 'geometry-preview-root'
    scene.add(group)
    scene.add(placementGroup)
    scene.add(copyPreviewGroup)
    scene.add(transformPreviewGroup)
    scene.add(toolPreviewGroup)
    scene.add(geometryPreviewGroup)
    sceneRef.current = scene
    cameraRef.current = camera
    camerasRef.current = { orthographic, perspective }
    rendererRef.current = renderer
    groupRef.current = group
    placementGroupRef.current = placementGroup
    copyPreviewGroupRef.current = copyPreviewGroup
    transformPreviewGroupRef.current = transformPreviewGroup
    toolPreviewGroupRef.current = toolPreviewGroup
    geometryPreviewGroupRef.current = geometryPreviewGroup
    controlsRef.current = controls
    let frame = 0
    let renderUntil = 0
    let restoreShadowTimer: number | null = null
    let animate = () => {}
    const invalidateRender = (durationMs = 0) => {
      renderUntil = Math.max(renderUntil, performance.now() + durationMs)
      if (!frame) frame = requestAnimationFrame(animate)
    }
    invalidateRenderRef.current = invalidateRender
    const finishDragRenderBurst = () => {
      // Keep the already queued frame so the committed transform is visible,
      // but discard the render tail accumulated by pointer-move invalidations.
      renderUntil = performance.now()
      if (!frame) frame = requestAnimationFrame(animate)
    }
    finishDragRenderBurstRef.current = finishDragRenderBurst
    const cancelShadowRestore = () => {
      if (restoreShadowTimer === null) return
      window.clearTimeout(restoreShadowTimer)
      restoreShadowTimer = null
    }
    const restoreShadows = () => {
      restoreShadowTimer = null
      renderer.shadowMap.enabled = true
      renderer.shadowMap.autoUpdate = true
      renderer.shadowMap.needsUpdate = true
      key.castShadow = true
      floor.receiveShadow = true
      invalidateRender()
    }
    const setInteractionQuality = (active: boolean) => {
      // Do not pay the toggle cost for small scenes. The quality fallback is
      // only useful once the current frame is large enough to be GPU-bound.
      if (active && renderer.info.render.triangles < 100_000) return
      if (active) cancelShadowRestore()
      const shouldRenderShadows = !active && restoreShadowTimer === null
      if (!active && renderer.shadowMap.enabled && key.castShadow && floor.receiveShadow) return
      if (active && !renderer.shadowMap.enabled && !key.castShadow && !floor.receiveShadow) return
      // Voxel meshes do not cast shadows; the expensive shadow pass only
      // exists for the key light/floor pair. Disable that pass while the user
      // is dragging, drawing, or placing, then rebuild it once on release.
      renderer.shadowMap.enabled = false
      renderer.shadowMap.autoUpdate = false
      renderer.shadowMap.needsUpdate = false
      key.castShadow = false
      floor.receiveShadow = false
      invalidateRender()
      if (!active && shouldRenderShadows) restoreShadowTimer = window.setTimeout(restoreShadows, 120)
    }
    interactionQualityRef.current = setInteractionQuality
    const handleControlsStart = () => interactionQualityRef.current(true)
    const handleControlsEnd = () => interactionQualityRef.current(false)
    controls.addEventListener('start', handleControlsStart)
    controls.addEventListener('end', handleControlsEnd)
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
      refreshCameraFit()
      setCameraZoomLevel(cameraZoomLevelRef.current, true)
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
      if (zoomReportTimerRef.current !== null) window.clearTimeout(zoomReportTimerRef.current)
      cancelShadowRestore()
      invalidateRenderRef.current = () => {}
      finishDragRenderBurstRef.current = () => {}
      interactionQualityRef.current = () => {}
      observer.disconnect()
      renderer.domElement.removeEventListener('wheel', applyWheelZoom)
      controls.removeEventListener('start', handleControlsStart)
      controls.removeEventListener('end', handleControlsEnd)
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
    // Re-apply the shared ruler value after changing camera type. The
    // perspective camera uses FOV-based zoom, so merely swapping the camera
    // would otherwise expose its previous/default framing.
    setCameraZoomLevel(cameraZoomLevelRef.current, true)
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

  useEffect(() => {
    // A boundary change changes the meaning of the 100% ruler. Recenter and
    // refit the camera so a newly enlarged ground plane is not left showing
    // only its diagonal edge in the viewport.
    if (!camerasRef.current || !controlsRef.current) return
    applyCameraView('default', cameraZoomLevelRef.current)
  }, [project.sceneBounds?.x, project.sceneBounds?.y, project.sceneBounds?.z, project.sceneSizeCm])

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
    const sceneBounds = sceneBoundsForProject(project)
    const target = selectedOrbitCenterRef.current?.clone() ?? sceneViewTarget(sceneBounds)
    let direction = new THREE.Vector3(16, 18, 18).normalize()
    let up = new THREE.Vector3(0, 0, 1)
    if (view !== 'default') {
      const option = cameraViewOptions.find((item) => item.id === view)
      if (option) direction = new THREE.Vector3(...option.direction).normalize()
    }
    const nextZoom = clampZoomLevel(requestedZoom)
    cameraZoomLevelRef.current = nextZoom
    if (view === 'top') {
      up = new THREE.Vector3(0, 1, 0)
    } else if (view === 'bottom') {
      up = new THREE.Vector3(0, -1, 0)
    }
    const probePosition = target.clone().add(direction.clone().multiplyScalar(cameraDistanceForBounds(sceneBounds)))
    const fit = calculateCameraFit(probePosition, up, sceneBounds, target)
    cameraFitZoomRef.current = fit.orthographicZoom
    perspectiveBaseDistanceRef.current = fit.perspectiveDistance
    const zoomFactor = nextZoom / 100
    const cameraFar = Math.max(1000, Math.hypot(sceneBounds.x, sceneBounds.y, sceneBounds.z) * VOXEL_WORLD_SIZE * 4)
    cameras.orthographic.far = cameraFar
    cameras.perspective.far = cameraFar
    cameras.orthographic.zoom = fit.orthographicZoom * zoomFactor
    cameras.orthographic.position.copy(probePosition)
    cameras.perspective.position.copy(target.clone().add(direction.clone().multiplyScalar(fit.perspectiveDistance)))
    cameras.orthographic.up.copy(up)
    cameras.perspective.up.copy(up)
    cameras.perspective.fov = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(perspectiveBaseFovRef.current / 2)) / zoomFactor),
    )
    cameras.orthographic.lookAt(target)
    cameras.perspective.lookAt(target)
    cameras.orthographic.updateProjectionMatrix()
    cameras.perspective.updateProjectionMatrix()
    controls.target.copy(target)
    controls.update()
    reportZoomImmediately()
    invalidateRenderRef.current(220)
  }

  const rotateCameraByInput = (deltaX: number, deltaY: number) => {
    const controls = controlsRef.current
    if (!controls) return
    // A camera pan or a previous view command can leave OrbitControls' target
    // away from the selected geometry. Re-anchor immediately before each
    // joystick gesture so the rotation is always selection-relative.
    syncOrbitTarget()
    controls.rotateLeft(deltaX * 0.008)
    controls.rotateUp(deltaY * 0.008)
    controls.update()
    invalidateRenderRef.current(220)
  }

  // Keep the pivot aligned as soon as selection changes, including selection
  // from the file tree. This makes the first joystick movement feel anchored
  // instead of requiring a hidden preparatory drag.
  useEffect(() => {
    // Change the pivot only when the selected entity IDs change. A voxel edit
    // changes selectedOrbitCenter because the AABB changes, but it must not
    // move the camera or the entity on screen. Clearing the selection also
    // deliberately leaves the current camera/target untouched; the fallback
    // scene pivot is used lazily by the next explicit camera rotation.
    if (orbitSelectionKey && !selectedOrbitCenter) return
    if (orbitPivotSelectionKeyRef.current === orbitSelectionKey) return
    orbitPivotSelectionKeyRef.current = orbitSelectionKey
    orbitPivotRef.current = selectedOrbitCenter?.clone() ?? null
    if (selectedOrbitCenter) syncOrbitTarget(selectedOrbitCenter)
  }, [orbitSelectionKey, selectedOrbitCenter])

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
      zoomIn: () => setCameraZoomLevel(stepZoomLevel(cameraZoomLevelRef.current, 1), false, true),
      zoomOut: () => setCameraZoomLevel(stepZoomLevel(cameraZoomLevelRef.current, -1), false, true),
    })
    return () => onCameraApiChange(null)
  }, [onCameraApiChange, project.sceneBounds?.x, project.sceneBounds?.y, project.sceneBounds?.z, project.sceneSizeCm])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
    const existingAssetGroups = new Map<string, THREE.Group>()
    group.children.filter((child): child is THREE.Group => child instanceof THREE.Group && typeof child.userData.instanceId === 'string' && !child.userData.assetRebuildPending)
      .forEach((child) => existingAssetGroups.set(child.userData.instanceId as string, child))
    const retainedAssetIds = new Set<string>()
    for (const instance of project.instances) {
      if (!instance.visible) continue
      const asset = assetMap.get(instance.assetId)
      if (!asset) continue
      const variant = asset.templateColor ? undefined : styleMaterialVariants[instance.style]
      const renderAsset = variant ? { ...asset, color: variant.color, accent: variant.accent } : asset
      const incrementalAdds = asset.kind === 'imported' && asset.voxels.length > CUSTOM_INSTANCE_RENDER_LIMIT
        ? addOnlyAssetOverrides(instance.overrides)
        : null
      // Large imported models keep their original mesh as a stable base while
      // additive edits are rendered by a small overlay. The full override
      // array is still used by sceneEntityParts() for hit testing and export;
      // this split only changes the viewport's render path.
      const baseInstance: SceneInstance = incrementalAdds ? { ...instance, overrides: [] } : instance
      const renderSignature = sceneInstanceRenderSignature(baseInstance)
      const geometrySignature = sceneInstanceGeometrySignature(baseInstance)
      const normalizedPivot = normalizeInstanceRotationPivot(instance)
      const existing = existingAssetGroups.get(instance.id)
      const canReuseGeometry = existing
        && existing.userData.assetRef === asset
        && existing.userData.geometrySignature === geometrySignature
      const instanceGroup = canReuseGeometry
        ? existing
        : existing && existing.userData.renderSignature === renderSignature && existing.userData.assetRef === asset
          ? existing
          : buildAssetGroup(renderAsset, materialMap, incrementalAdds ? [] : instance.overrides, instance.partOffsets, instance.rotation, instance.colorOverride, instance.mirror, instance.rotationX, instance.rotationY, instance.rotationZ, true, `asset:${assetGreedyCacheToken(asset)}:${renderSignature}`, normalizedPivot)
      if (instanceGroup !== existing) {
        // A large imported asset is built by the chunk worker. Keep the old
        // group visible until every replacement mesh is ready; removing it
        // first caused the characteristic disappear/reappear flash after
        // every edit. Small/cell-rendered assets can still swap immediately.
        const pendingGreedyGroups: THREE.Group[] = []
        instanceGroup.traverse((object) => {
          if (object instanceof THREE.Group && object.userData.greedyVoxels && !object.userData.prebuiltGreedyMesh) pendingGreedyGroups.push(object)
        })
        if (existing && pendingGreedyGroups.length) {
          const pendingSignature = `${geometrySignature}|${incrementalAdds ? assetOverrideSignature(incrementalAdds) : ''}`
          const alreadyPending = group.children.find((child): child is THREE.Group => child instanceof THREE.Group
            && child.userData.assetRebuildPending
            && child.userData.instanceId === instance.id
            && child.userData.assetRebuildSignature === pendingSignature)
          if (alreadyPending) {
            // The previous frame already scheduled this exact rebuild.
            disposeThreeObject(instanceGroup)
          } else {
            instanceGroup.visible = false
            instanceGroup.userData.assetRebuildPending = true
            instanceGroup.userData.assetRebuildSignature = pendingSignature
            instanceGroup.userData.assetRebuildPrevious = existing
            instanceGroup.userData.assetRebuildPendingCount = pendingGreedyGroups.length
            group.add(instanceGroup)
          }
        } else {
          if (existing) {
            group.remove(existing)
            disposeThreeObject(existing)
          }
          group.add(instanceGroup)
        }
      }
      retainedAssetIds.add(instance.id)
      const pivot = normalizedPivot
      instanceGroup.position.copy(toSceneWorld(instance.x + pivot.x, (instance.y ?? 0) + pivot.y, instance.z + pivot.z))
      instanceGroup.userData.instanceId = instance.id
      instanceGroup.userData.renderSignature = renderSignature
      instanceGroup.userData.geometrySignature = geometrySignature
      instanceGroup.userData.assetRef = asset
      syncAssetAdditionsOverlay(instanceGroup, renderAsset, materialMap, incrementalAdds ?? [], instance.partOffsets, instance.rotation, instance.colorOverride, instance.mirror, instance.rotationX, instance.rotationY, instance.rotationZ, pivot)
      syncAssetPartOffsets(instanceGroup, instance.partOffsets, instance.mirror)
      instanceGroup.traverse((object) => {
        object.userData.instanceId = instance.id
        if (object.userData.instancePartId) object.userData.scenePartId = `asset:${instance.id}:${object.userData.instancePartId}`
      })
      instanceGroup.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object.userData.selectionGlow) return
        const meshMaterial = object.material as THREE.MeshStandardMaterial
        // This is the unmasked source color. Never overwrite it with the
        // current dimmed color during a stroke publish; doing so compounded
        // the mask on every animation frame.
        if (object.userData.baseRenderColor === undefined) object.userData.baseRenderColor = meshMaterial.color.getHex()
      })
    }
    existingAssetGroups.forEach((existing, instanceId) => {
      if (retainedAssetIds.has(instanceId)) return
      group.remove(existing)
      disposeThreeObject(existing)
    })

    const existingCustom = group.children.find((child) => child.name === 'custom-voxels') as THREE.Group | undefined
    // sceneEntityParts already maintains per-entity voxel groups for hit tests
    // and occupancy. Reuse those groups here instead of rebuilding a second
    // Map with an allocating `[...old, voxel]` operation for every voxel.
    const customParts = sceneParts.filter((part) => part.kind === 'custom')
    if (customParts.length) {
      const custom = existingCustom ?? new THREE.Group()
      custom.name = 'custom-voxels'
      if (!existingCustom) group.add(custom)
      const existingComponents = new Map<string, THREE.Group>()
      const componentCandidates = new Map<string, THREE.Group[]>()
      custom.children.filter((child): child is THREE.Group => child instanceof THREE.Group && typeof child.userData.scenePartId === 'string')
        .forEach((child) => {
          const scenePartId = child.userData.scenePartId as string
          componentCandidates.set(scenePartId, [...(componentCandidates.get(scenePartId) ?? []), child])
        })
      // A large component can have one visible, stable group and one hidden
      // replacement group uploading unit cells over several animation frames.
      // Always use the stable visible group as the replacement source; using
      // the hidden group here would make every brush sample chain another
      // rebuild and could leave the entity invisible for a long time.
      componentCandidates.forEach((candidates, scenePartId) => {
        const stable = candidates.find((candidate) => candidate.visible && !candidate.userData.pendingReplacementFor)
          ?? candidates.find((candidate) => candidate.visible)
          ?? candidates[0]
        if (stable) existingComponents.set(scenePartId, stable)
      })
      const retainedComponents = new Set<string>()
      for (const part of customParts) {
        const entityId = part.partId
        // Keep the mesh in canonical entity coordinates. A pure move is
        // represented by the group transform below, so this path does not
        // rebuild or remap every voxel on pointer release.
        const component = part.voxels
        const scenePartId = `custom:${entityId}`
        // Read the policy from the resolved scene part first. This keeps the
        // render choice coupled to the entity that was actually produced by
        // the geometry operation, even while naming/cache normalization is
        // rebuilding the project maps. Enlarged entities must never fall back
        // to greedy meshing, or adjacent unit voxels look like one large block.
        const forceCellRender = part.renderMode === 'cells' || project.customVoxelRenderModes?.[entityId] === 'cells'
        const renderSignature = voxelRenderSignature(component, project.customColors?.[entityId], forceCellRender)
        const existingComponent = existingComponents.get(scenePartId)
        // A newer edit supersedes any still-uploading replacement. Cancel and
        // dispose those stale hidden groups before starting the next one, but
        // never remove the visible stable group that is keeping the entity on
        // screen during the rebuild.
        const candidates = componentCandidates.get(scenePartId) ?? []
        candidates.forEach((candidate) => {
          if (candidate === existingComponent || !candidate.userData.pendingReplacementFor) return
          const cancel = candidate.userData.cancelCellBuild as (() => void) | undefined
          cancel?.()
          custom.remove(candidate)
          disposeThreeObject(candidate)
        })
        const componentGroup = existingComponent && existingComponent.userData.renderSignature === renderSignature
          ? existingComponent
          : buildCustomComponentGroup(component, entityId, materialMap, project.customColors?.[entityId], forceCellRender)
        const isProgressiveCellBuild = Boolean(componentGroup.userData.cellBuildPending)
        const isWorkerGreedyBuild = Boolean(componentGroup.userData.greedyBuildPending)
        const isAsyncRenderBuild = isProgressiveCellBuild || isWorkerGreedyBuild
        if (componentGroup !== existingComponent) {
          if (existingComponent && isAsyncRenderBuild) {
            // Keep the previous complete render visible while the replacement
            // uploads/builds. The completion callback removes it atomically,
            // so a brush update never exposes an empty render group.
            componentGroup.visible = false
            componentGroup.userData.pendingReplacementFor = existingComponent
            custom.add(componentGroup)
          } else {
            if (existingComponent) {
              custom.remove(existingComponent)
              disposeThreeObject(existingComponent)
            }
            custom.add(componentGroup)
          }
        }
        componentGroup.userData.onRenderBuildComplete = () => {
          componentGroup.userData.cellBuildPending = false
          componentGroup.userData.greedyBuildPending = false
          const previous = componentGroup.userData.pendingReplacementFor as THREE.Group | undefined
          if (previous?.parent) {
            previous.parent.remove(previous)
            disposeThreeObject(previous)
          }
          delete componentGroup.userData.pendingReplacementFor
          componentGroup.visible = true
          const shouldHighlight = selectedPartIdsRef.current.includes(scenePartId)
            || editRenderStateRef.current.partIds.has(scenePartId)
          if (shouldHighlight) {
            // A replacement group can finish after the selection effect has
            // already run. Pick one current visible render batch instead of
            // letting traversal order decide which child owns the outline.
            let candidate: THREE.Mesh | undefined
            componentGroup.traverse((object) => {
              if (!(object instanceof THREE.Mesh) || object.userData.selectionGlow) return
              if (object.userData.skipVoxelHighlight) return
              if (!isVisibleInObjectHierarchy(object) || !hasRenderableSelectionSource(object)) return
              if (!candidate || object.userData.greedyMesh || object.userData.surfaceMesh) candidate = object
            })
            if (candidate) {
              hideSelectionHighlightsForPart(componentGroup, scenePartId, candidate)
              const highlights = addVoxelHighlight(candidate)
              highlights.forEach((highlight) => { highlight.visible = true })
            }
          }
          invalidateRenderRef.current()
        }
        componentGroup.userData.onRenderBuildFailed = () => {
          const previous = componentGroup.userData.pendingReplacementFor as THREE.Group | undefined
          if (previous?.parent) previous.visible = true
          if (componentGroup.parent) componentGroup.parent.remove(componentGroup)
          disposeThreeObject(componentGroup)
        }
        const renderOrigin = customComponentRenderOrigin(component)
        const sceneOffset = part.sceneOffset ?? { x: 0, y: 0, z: 0 }
        componentGroup.position.set(
          voxelToWorld(renderOrigin.x + sceneOffset.x),
          voxelToWorld(renderOrigin.z + sceneOffset.z),
          voxelToWorld(renderOrigin.y + sceneOffset.y),
        )
        componentGroup.userData.renderOrigin = renderOrigin
        componentGroup.userData.renderSignature = renderSignature
        componentGroup.userData.greedyMeshCacheKey = `custom:${renderSignature}`
        retainedComponents.add(scenePartId)
      }
      existingComponents.forEach((existingComponent, scenePartId) => {
        if (retainedComponents.has(scenePartId)) return
        custom.remove(existingComponent)
        disposeThreeObject(existingComponent)
      })
      componentCandidates.forEach((candidates, scenePartId) => {
        if (retainedComponents.has(scenePartId)) return
        candidates.forEach((candidate) => {
          if (candidate === existingComponents.get(scenePartId)) return
          custom.remove(candidate)
          disposeThreeObject(candidate)
        })
      })
    } else if (existingCustom) {
      group.remove(existingCustom)
      disposeThreeObject(existingCustom)
    }
    invalidateRenderRef.current()
  // Brush transactions append to the private draft array in place so a long
  // stroke does not copy the whole voxel list on every animation frame. The
  // array reference therefore stays stable while its length grows. Include
  // the length as a cheap content revision; otherwise React publishes the
  // new project root but this imperative Three.js geometry effect skips the
  // update until the next stroke replaces the array reference.
  }, [project.assets, project.customVoxels, project.customVoxels.length, project.customColors, project.customVoxelRenderModes, sceneGeometryRenderKey, materialMap])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
    const existingAssetGroups = new Map<string, THREE.Group>()
    group.children.filter((child): child is THREE.Group => child instanceof THREE.Group && typeof child.userData.instanceId === 'string')
      .forEach((child) => existingAssetGroups.set(child.userData.instanceId as string, child))
    project.instances.forEach((instance) => {
      if (!instance.visible) return
      const instanceGroup = existingAssetGroups.get(instance.id)
      if (!instanceGroup) return
      // Keep the lightweight transform pass on the same pivot convention as
      // the geometry pass above. Omitting the persisted rotation pivot here
      // moves the rendered model by half of its height/ground extent after a
      // rotation, while the cached selection outline still uses the pivoted
      // coordinates and appears to remain in the old position.
      const pivot = normalizeInstanceRotationPivot(instance)
      instanceGroup.position.copy(toSceneWorld(instance.x + pivot.x, (instance.y ?? 0) + pivot.y, instance.z + pivot.z))
      syncAssetPartOffsets(instanceGroup, instance.partOffsets, instance.mirror)
    })

    const custom = group.children.find((child) => child.name === 'custom-voxels') as THREE.Group | undefined
    if (custom) {
      const existingComponents = new Map<string, THREE.Group>()
      custom.children.filter((child): child is THREE.Group => child instanceof THREE.Group && typeof child.userData.scenePartId === 'string')
        .forEach((child) => existingComponents.set(child.userData.scenePartId as string, child))
      sceneParts.filter((part) => part.kind === 'custom').forEach((part) => {
        const componentGroup = existingComponents.get(`custom:${part.partId}`)
        if (!componentGroup) return
        const origin = customComponentRenderOrigin(part.voxels)
        const sceneOffset = part.sceneOffset ?? { x: 0, y: 0, z: 0 }
        componentGroup.position.set(
          voxelToWorld(origin.x + sceneOffset.x),
          voxelToWorld(origin.z + sceneOffset.z),
          voxelToWorld(origin.y + sceneOffset.y),
        )
        componentGroup.userData.renderOrigin = origin
      })
    }
    if (skipNextTransformRenderRef.current) skipNextTransformRenderRef.current = false
    const pendingDragVisualRoots = pendingDragVisualRootsRef.current
    pendingDragVisualRoots.forEach((position, object) => {
      if (object.parent) object.position.copy(position)
    })
    // `project` can be one stale transition render behind projectRef. Only
    // release the guard once the effect is processing the committed snapshot.
    if (pendingDragVisualRoots.size && project === authoritativeProjectRef.current) pendingDragVisualRoots.clear()
    invalidateRenderRef.current()
  }, [project.instances, project.customEntityOffsets, sceneParts])

  useEffect(() => {
    const group = groupRef.current
    const client = chunkMeshWorkerRef.current
    if (!group || !client) return
    const revision = ++chunkMeshRevisionRef.current
    let cancelled = false
    const attachGreedyMesh = (
      object: THREE.Group,
      payload: GreedyRenderMeshPayload,
      materialKeys: string[],
      scenePartId: string,
      renderSignature?: string,
      materialIdsAreOneBased = false,
    ) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3, true))
      attachVoxelAoAttribute(geometry, payload.ao, payload.positions.length / 3)
      const hasMultipleColors = materialIdsAreOneBased ? materialKeys.length > 2 : materialKeys.length > 1
      if (hasMultipleColors) {
        const parsedColors = materialKeys.map((key) => {
          if (key.startsWith('#')) return cachedGreedyColor(key)
          return materialMap.get(key)?.color ?? materialMap.get('terracotta')?.color ?? cachedGreedyColor('#d16a4c')
        })
        const vertexColors = new Float32Array(payload.materialIds.length * 3)
        payload.materialIds.forEach((materialId, index) => {
          const color = parsedColors[materialId] ?? parsedColors[materialIdsAreOneBased ? 1 : 0]
          vertexColors[index * 3] = color.r
          vertexColors[index * 3 + 1] = color.g
          vertexColors[index * 3 + 2] = color.b
        })
        geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3))
      }
      geometry.setIndex(new THREE.BufferAttribute(payload.indices, 1))
      geometry.computeBoundingSphere()
      const solidColorKey = materialKeys[materialIdsAreOneBased ? 1 : 0]
      const material = new THREE.MeshStandardMaterial({
        color: hasMultipleColors ? '#ffffff' : (solidColorKey?.startsWith('#') ? solidColorKey : (materialMap.get(solidColorKey)?.color ?? materialMap.get('terracotta')?.color ?? '#6c827d')),
        vertexColors: hasMultipleColors,
        roughness: 0.9,
        metalness: 0,
      })
      configureGreedyPreviewMaterial(material)
      const greedyMesh = new THREE.Mesh(geometry, material)
      greedyMesh.scale.setScalar(VOXEL_WORLD_SIZE)
      greedyMesh.userData.scenePartId = scenePartId
      // Preserve the source voxel coordinates on the rendered mesh. The
      // worker's merged outline is appropriate for ordinary assets, but
      // editable custom components need the source cells to rebuild their
      // per-voxel selection frames.
      greedyMesh.userData.greedyVoxels = object.userData.greedyVoxels
      greedyMesh.userData.greedyOutlinePositions = payload.outlinePositions
      // Selection/edit refresh restores this unmasked base color.  Using a
      // hard-coded white here made single-color shape entities turn white as
      // soon as they were selected, while their inspector preview still used
      // the correct active material. Multi-color meshes intentionally use
      // white because their visible color comes from vertex colors.
      greedyMesh.userData.baseRenderColor = material.color.getHex()
      greedyMesh.userData.greedyMesh = true
      object.children.forEach((child) => {
        if (child instanceof THREE.InstancedMesh) {
          child.userData.renderInstanceCount = child.count
          child.count = 0
        }
      })
      object.add(greedyMesh)
      if (selectedPartIdsRef.current.includes(scenePartId) || editRenderStateRef.current.partIds.has(scenePartId)) {
        hideSelectionHighlightsForPart(object, scenePartId, greedyMesh)
        const highlights = addVoxelHighlight(greedyMesh)
        highlights.forEach((highlight) => { highlight.visible = true })
      }
      if (object.userData.greedyBuildPending) {
        object.userData.greedyBuildPending = false
        const onComplete = object.userData.onRenderBuildComplete as (() => void) | undefined
        onComplete?.()
      }
      if (renderSignature) object.userData.greedyMeshBuiltSignature = renderSignature
      const replacementRoot = object.parent?.userData.assetRebuildPending ? object.parent as THREE.Group : undefined
      if (replacementRoot) {
        const remaining = Math.max(0, Number(replacementRoot.userData.assetRebuildPendingCount ?? 1) - 1)
        replacementRoot.userData.assetRebuildPendingCount = remaining
        if (remaining === 0) {
          const previous = replacementRoot.userData.assetRebuildPrevious as THREE.Group | undefined
          replacementRoot.visible = true
          replacementRoot.userData.assetRebuildPending = false
          delete replacementRoot.userData.assetRebuildPrevious
          delete replacementRoot.userData.assetRebuildSignature
          if (previous?.parent) {
            previous.parent.remove(previous)
            disposeThreeObject(previous)
          }
        }
      }
      invalidateRenderRef.current()
    }
    group.traverse((object) => {
      if (!(object instanceof THREE.Group)) return
      const prebuilt = object.userData.prebuiltGreedyMesh as VoxelGeometryMesh | undefined
      const prebuiltColors = object.userData.prebuiltGreedyColors as string[] | undefined
      const prebuiltScenePartId = object.userData.scenePartId as string | undefined
      if (prebuilt && prebuiltColors && prebuiltScenePartId) {
        delete object.userData.prebuiltGreedyMesh
        delete object.userData.prebuiltGreedyColors
        attachGreedyMesh(object, prebuilt, prebuiltColors, prebuiltScenePartId, object.userData.renderSignature as string | undefined)
        return
      }
      const voxels = object.userData.greedyVoxels as Array<{ gx: number; gy: number; gz: number; materialId: number }> | undefined
      const colors = object.userData.greedyColors as string[] | undefined
      const scenePartId = scenePartIdForRenderObject(object)
      if (object.userData.greedyDisabled || !voxels || voxels.length < 64 || !colors || !scenePartId) return
      const renderSignature = object.userData.renderSignature as string | undefined
      if (renderSignature && object.userData.greedyMeshBuiltSignature === renderSignature) return
      void client.build(scenePartId, revision, voxels, object.userData.greedyMeshCacheKey as string | undefined).then((payload) => {
        if (cancelled || !object.parent) return
        if (!payload) {
          const pendingRoot = object.parent.userData.assetRebuildPending ? object.parent as THREE.Group : undefined
          if (pendingRoot) {
            const previous = pendingRoot.userData.assetRebuildPrevious as THREE.Group | undefined
            pendingRoot.visible = true
            pendingRoot.userData.assetRebuildPending = false
            if (pendingRoot.parent) pendingRoot.parent.remove(pendingRoot)
            disposeThreeObject(pendingRoot)
            if (previous?.parent) previous.visible = true
          }
          const onFailed = object.userData.onRenderBuildFailed as (() => void) | undefined
          onFailed?.()
          return
        }
        // The worker emits coordinates in voxel units. Keep the transferable
        // buffers intact and let the shared attach path install the result.
        attachGreedyMesh(object, payload, colors, scenePartId, renderSignature, true)
      })
    })
    return () => {
      cancelled = true
    }
  // Keep the worker-backed greedy surface in sync with append-only brush
  // publishes as well. The geometry effect above installs the updated voxel
  // payload, while this effect schedules the corresponding worker mesh.
  }, [project.assets, project.customVoxels, project.customVoxels.length, project.customColors, project.customVoxelRenderModes, sceneGeometryRenderKey, materialMap])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    // The parent publishes a lightweight project snapshot on every brush frame.
    // Rebuilding the full scene-part graph here would undo much of the stroke
    // batching benefit, so consume the already computed scene parts instead.
    const currentSceneParts = sceneParts
    const selectedScenePartIds = new Set(selectedPartIds)
    const editAssemblyId = editEntityId?.startsWith('assembly:') ? editEntityId.slice('assembly:'.length) : undefined
    const editScenePartIds = new Set(currentSceneParts.filter((part) => editEntityId === part.id || (editAssemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editAssemblyId))).map((part) => part.id))
    editRenderStateRef.current = { active: Boolean(editEntityId), partIds: editScenePartIds }
    const activeScenePartIds = new Set([...selectedScenePartIds, ...editScenePartIds])
    const candidatesByPart = new Map<string, THREE.Mesh[]>()
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData.selectionGlow) return
      const oldHighlights = object.userData.selectionGlowParts as THREE.Object3D[] | undefined
      const scenePartId = scenePartIdForRenderObject(object)
      const meshMaterial = object.material as THREE.MeshStandardMaterial
      const baseColor = object.userData.baseRenderColor as number | undefined
      if (baseColor !== undefined) meshMaterial.color.setHex(baseColor)
      meshMaterial.transparent = false
      meshMaterial.opacity = 1
      meshMaterial.depthWrite = true
      if (!scenePartId) return
      oldHighlights?.forEach((highlight) => { highlight.visible = false })
      if (object.userData.skipVoxelHighlight) return
      if (!isVisibleInObjectHierarchy(object) || !hasRenderableSelectionSource(object)) return
      const candidates = candidatesByPart.get(scenePartId)
      if (candidates) candidates.push(object)
      else candidatesByPart.set(scenePartId, [object])
    })
    candidatesByPart.forEach((candidates, scenePartId) => {
      // Prefer a merged/surface render when one exists. It gives the outline
      // the same visible geometry as the solid object instead of a stale cell
      // batch left over from the previous render signature.
      const candidate = candidates.find((mesh) => mesh.userData.greedyMesh || mesh.userData.surfaceMesh) ?? candidates[0]
      if (!activeScenePartIds.has(scenePartId)) return
      hideSelectionHighlightsForPart(group, scenePartId, candidate)
      const highlights = addVoxelHighlight(candidate)
      highlights.forEach((highlight) => { highlight.visible = true })
    })
    invalidateRenderRef.current()
    // Geometry batches can be replaced by an async worker immediately after
    // this pass. A second frame catches that replacement before the user sees
    // a selected entity without its outline, while keeping the normal click
    // path synchronous.
    const frame = requestAnimationFrame(() => {
      const currentGroup = groupRef.current
      if (!currentGroup) return
      const currentActiveIds = new Set([...selectedPartIds, ...editScenePartIds])
      const currentCandidates = new Map<string, THREE.Mesh[]>()
      currentGroup.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object.userData.selectionGlow) return
        const scenePartId = scenePartIdForRenderObject(object)
        if (!scenePartId || object.userData.skipVoxelHighlight || !isVisibleInObjectHierarchy(object) || !hasRenderableSelectionSource(object)) return
        const list = currentCandidates.get(scenePartId)
        if (list) list.push(object)
        else currentCandidates.set(scenePartId, [object])
      })
      currentCandidates.forEach((candidates, scenePartId) => {
        if (!currentActiveIds.has(scenePartId)) return
        const candidate = candidates.find((mesh) => mesh.userData.greedyMesh || mesh.userData.surfaceMesh) ?? candidates[0]
        hideSelectionHighlightsForPart(currentGroup, scenePartId, candidate)
        addVoxelHighlight(candidate).forEach((highlight) => { highlight.visible = true })
      })
      invalidateRenderRef.current()
    })
    return () => cancelAnimationFrame(frame)
  }, [sceneGeometryRenderKey, selectionScenePartKey, selectionRefreshKey, project.assets, project.customVoxels, project.customVoxels.length, project.customColors, project.customVoxelRenderModes, project.assemblies, selectedPartIds, checkedPartIds, editEntityId, selectedId])

  // HSL dragging is a render-only transaction. Instanced batches can update
  // their material color directly; worker-generated greedy meshes use the GPU
  // shader uniform above so the browser never walks their vertex-color buffer
  // for every slider event. The project/history transaction is committed only
  // when the slider is released by ColorEditor.
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const selected = new Set(colorPreview?.partIds ?? [])
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData.selectionGlow) return
      const scenePartId = object.userData.scenePartId as string | undefined
      const isPreviewed = Boolean(colorPreview && scenePartId && selected.has(scenePartId))
      const meshMaterial = object.material as THREE.MeshStandardMaterial
      if (object.userData.greedyMesh || object.userData.instancedVoxelColors || object.userData.surfaceMesh) {
        const state = meshMaterial.userData.moceHslPreviewState as { hueDelta: number; saturationTarget: number; enabled: boolean } | undefined
        const uniforms = meshMaterial.userData.moceHslPreviewUniforms as { moceHueDelta?: { value: number }; moceSaturationTarget?: { value: number }; moceHslPreviewEnabled?: { value: number } } | undefined
        if (state) {
          state.hueDelta = isPreviewed ? colorPreview!.hueDelta : 0
          state.saturationTarget = isPreviewed ? colorPreview!.saturationTarget : 100
          state.enabled = isPreviewed
        }
        if (uniforms?.moceHueDelta && uniforms.moceSaturationTarget && uniforms.moceHslPreviewEnabled) {
          uniforms.moceHueDelta.value = (isPreviewed ? colorPreview!.hueDelta : 0) / 360
          uniforms.moceSaturationTarget.value = (isPreviewed ? colorPreview!.saturationTarget : 100) / 100
          uniforms.moceHslPreviewEnabled.value = isPreviewed ? 1 : 0
        } else if (isPreviewed) {
          // If the first user interaction races the initial shader compile,
          // request one compile and let the uniform path take over after it.
          meshMaterial.needsUpdate = true
        }
        return
      }
      const baseColor = object.userData.baseRenderColor as number | undefined
      if (baseColor === undefined) return
      const nextColor = isPreviewed
        ? adjustHexHsl(`#${baseColor.toString(16).padStart(6, '0')}`, colorPreview!.hueDelta, colorPreview!.saturationTarget)
        : undefined
      if (nextColor) meshMaterial.color.set(nextColor)
      else meshMaterial.color.setHex(baseColor)
    })
    invalidateRenderRef.current(120)
  }, [colorPreview])

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
      if (editEntityId && object.userData.outerVoxel) {
        const highlights = addVoxelHighlight(object)
        highlights.forEach((highlight) => { highlight.visible = true })
      }
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

  useEffect(() => {
    const root = transformPreviewGroupRef.current
    if (!root) return
    disposeThreeObject(root)
    root.clear()
    if (!transformPreview) {
      invalidateRenderRef.current()
      return
    }
    const preview = buildAssetGroup(transformPreview.asset, materialMap)
    preview.position.copy(toSceneWorld(transformPreview.origin.x, transformPreview.origin.y, transformPreview.origin.z))
    preview.userData.transformPreview = true
    preview.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return
      object.material.transparent = true
      object.material.opacity = transformPreview.valid ? 0.42 : 0.22
      object.material.depthWrite = false
      if (!transformPreview.valid) object.material.color.set('#e06b5b')
    })
    root.add(preview)
    invalidateRenderRef.current(160)
  }, [transformPreview, materialMap])

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

  const setPointerRay = (event: { clientX: number; clientY: number }) => {
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera) return false
    const rect = renderer.domElement.getBoundingClientRect()
    pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycasterRef.current.setFromCamera(pointerRef.current, camera)
    return true
  }

  const pointerFloorPoint = (event: { clientX: number; clientY: number }) => {
    if (!setPointerRay(event)) return null
    // The editing floor is the z=0 plane in Three.js world coordinates. A
    // selection drag only needs this projection; raycasting the voxel meshes
    // again on every pointermove makes a large InstancedMesh stall the main
    // thread even though the selected object was already known on pointerdown.
    return raycasterRef.current.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.Vector3(),
    )
  }

  const pointerHorizontalPoint = (event: { clientX: number; clientY: number }, worldZ: number) => {
    if (!setPointerRay(event)) return null
    // Horizontal dragging must be measured on a plane through the selected
    // object, not on the ground. Projecting a floating object onto z=0 makes
    // the delta depend on other geometry and can flip or snap the drag when
    // the ray crosses another object's projected bounds.
    // A nearly parallel ray has no stable intersection with this plane. Do
    // not fall back to the ground plane in that case: that changes coordinate
    // frames mid-gesture and is the source of the occasional release flash.
    if (Math.abs(raycasterRef.current.ray.direction.z) < 1e-5) return null
    return raycasterRef.current.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -worldZ),
      new THREE.Vector3(),
    )
  }

  const getPointerContext = (event: { clientX: number; clientY: number }) => {
    const camera = cameraRef.current
    const mount = mountRef.current
    if (!camera || !mount || !setPointerRay(event)) return null
    // The occupancy DDA is the authoritative voxel hit test. Raycasting an
    // InstancedMesh here makes Three.js iterate every instance at pointer-down
    // time; for a 100k+ voxel model that turns a simple click into a long task.
    // Keep the scene graph raycaster out of the interaction path and derive the
    // owning part from the spatial index instead.
    const voxelHit = onRaycastVoxel(raycasterRef.current.ray.origin, raycasterRef.current.ray.direction)
    // The visible floor is a rendering aid, not an interaction surface. It
    // can be hidden in edit mode and its finite rectangle can be missed after
    // panning, which made identical clicks randomly fail. Always resolve the
    // ground against the mathematical project ground plane instead.
    const floorPoint = raycasterRef.current.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.Vector3(),
    )
    return { voxelHit, floorPoint: floorPoint ?? null }
  }

  const drawingToolIds = new Set<Tool>(['brush', 'erase', 'line', 'cuboid', 'sphere', 'extrude'])
  // Shape tools always use the editor's XY ground plane. The selectable
  // drawing plane remains reserved for brush, erase and line tools.
  const shapeDrawingPlane = EDITOR_GROUND_PLANE
  const facingFromHitNormal = (normal?: Pick<Voxel, 'x' | 'y' | 'z'>): VoxelFacing => {
    // The hit normal points away from the existing voxel.  A newly placed
    // variant is adjacent in that direction, so its full square mounting
    // face must point back toward the hit voxel (the opposite normal).
    // A ground placement is supported from below: the new shape's complete
    // square mounting face rests on the floor, so its mounting normal is -Y
    // in project coordinates. The old -Z fallback was a storage/render-axis
    // mix-up and also made floor rotation use the wrong face basis.
    if (!normal) return '-y'
    const axis = (['x', 'y', 'z'] as const).reduce((best, candidate) => Math.abs(normal[candidate]) > Math.abs(normal[best]) ? candidate : best, 'y' as 'x' | 'y' | 'z')
    return oppositeVoxelFacing(`${normal[axis] < 0 ? '-' : '+'}${axis}` as VoxelFacing)
  }
  const decorateVariantVoxels = (voxels: Voxel[], gesture: DrawingGesture, operation: DrawOperation): Voxel[] => {
    if (operation !== 'add' || voxelBrushShape === 'cube' || !['brush', 'line', 'cuboid', 'sphere'].includes(tool)) return voxels
    const variant = makeVoxelVariant(voxelBrushShape, gesture.variantFacing ?? '+y', gesture.variantRotation ?? 0)
    return voxels.map((voxel) => applyVoxelVariant(voxel, variant))
  }
  const drawingPlaneWorld = (plane: DrawingPlane, layer: number) => {
    const [, , layerAxis] = planeAxes(plane)
    const normal = layerAxis === 'x'
      ? new THREE.Vector3(1, 0, 0)
      : layerAxis === 'y'
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0)
    // Intersect through voxel centres. Using the lower cell boundary made a
    // floor stroke ambiguous and could place a shape one layer underground.
    return new THREE.Plane(normal, -voxelCenterToWorld(layer))
  }

  const worldToProjectVoxel = (world: THREE.Vector3) => ({ x: worldToVoxelCell(world.x), y: worldToVoxelCell(world.z), z: worldToVoxelCell(world.y) })

  const worldToContinuousProject = (world: THREE.Vector3) => ({
    x: world.x / VOXEL_WORLD_SIZE - 0.5,
    y: world.z / VOXEL_WORLD_SIZE - 0.5,
    z: world.y / VOXEL_WORLD_SIZE - 0.5,
  })

  /**
   * Resolve the four-way variant rotation from the point clicked on the
   * logical voxel face. The face is split by its two diagonals into four
   * triangles; dragging is deliberately not involved in this decision.
   */
  const rotationFromPointerFace = (
    context: { voxelHit: SceneVoxelRayHit | null; floorPoint: THREE.Vector3 | null },
    facing: VoxelFacing,
  ): VoxelRotation => {
    const hit = context.voxelHit
    if (hit) {
      const frame = VOXEL_FACE_FRAMES[facing]
      // The mounting face belongs to the newly placed adjacent voxel.  Its
      // center is one cell along the hit normal; using the hit voxel center
      // here would sample the opposite face and make the orientation appear
      // mirrored/disconnected.
      const target = adjacentVoxel(hit.voxel, hit.normal)
      const center = toSceneWorld(
        voxelCenterToWorld(target.x),
        voxelCenterToWorld(target.y),
        voxelCenterToWorld(target.z),
      )
      const normal = new THREE.Vector3(frame.normal[0], frame.normal[2], frame.normal[1])
      const facePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        normal,
        center.clone().addScaledVector(normal, VOXEL_WORLD_SIZE / 2),
      )
      const point = raycasterRef.current.ray.intersectPlane(facePlane, new THREE.Vector3())
      if (point) {
        const continuous = worldToContinuousProject(point)
        const local = faceLocalCoordinates(facing, continuous, target)
        return rotationFromFaceLocalCoordinates(local.u, local.v)
      }
      return 0
    }
    if (!context.floorPoint) return 0
    const continuous = worldToContinuousProject(context.floorPoint)
    // The floor is the top surface of the virtual support cell. Its two
    // meaningful coordinates are project X/Z, not project X/Y. Using the
    // -Z frame here made v permanently equal to -0.5 because project Y is
    // the height axis, so every click fell into the same rotation sector.
    const center = { x: Math.round(continuous.x), y: 0, z: Math.round(continuous.z) }
    const local = faceLocalCoordinates('-y', continuous, center)
    return rotationFromFaceLocalCoordinates(local.u, local.v)
  }

  const pointerDrawingPoint = (event: { clientX: number; clientY: number }, operation: DrawOperation | 'extrude', fixedLayer?: number, plane: DrawingPlane = drawingPlane) => {
    // Once a gesture has a fixed layer, the pointer is no longer allowed to
    // jump to another surface. Avoid running the occupancy DDA and floor mesh
    // raycast for every move sample; the plane intersection is both cheaper and
    // the authoritative coordinate for a locked planar stroke.
    const context = fixedLayer === undefined
      ? getPointerContext(event)
      : (setPointerRay(event) ? { voxelHit: null, floorPoint: null } : null)
    if (!context) return null
    const hit = context.voxelHit
    let anchor = hit?.voxel
    // The first sample may use the hit normal to place an added cell beside
    // the surface. During the same gesture the drawing plane is already
    // locked, so re-applying the current hit normal would let a raycast on a
    // different surface move the stroke to another layer.
    if (anchor && operation === 'add' && fixedLayer === undefined) anchor = { ...anchor, x: anchor.x + (hit?.normal.x ?? 0), y: anchor.y + (hit?.normal.y ?? 0), z: anchor.z + (hit?.normal.z ?? 0) }
    const layer = fixedLayer ?? (anchor ? projectVoxelToPlane(plane, anchor).layer : 0)
    // When a stroke starts on an occupied cell, the DDA hit plus its face
    // normal is already the exact grid answer. Re-projecting the same pointer
    // onto the plane can land in a neighbouring cell (especially in orthographic
    // view or near a voxel edge), which made the first brush sample silently
    // miss or appear far from the cursor. Only project pointer movement after
    // the gesture has locked its layer.
    if (anchor && fixedLayer === undefined) {
      const projected = projectVoxelToPlane(plane, anchor)
      return { point: clampPlanePointToGround(plane, { u: projected.u, v: projected.v, layer }), anchor, context }
    }
    const worldPlane = drawingPlaneWorld(plane, layer)
    const worldPoint = raycasterRef.current.ray.intersectPlane(worldPlane, new THREE.Vector3())
    if (worldPoint) {
      const projectPoint = worldToProjectVoxel(worldPoint)
      const projected = projectVoxelToPlane(plane, projectPoint)
      return { point: clampPlanePointToGround(plane, { u: projected.u, v: projected.v, layer }), anchor, context }
    }
    if (anchor) {
      const projected = projectVoxelToPlane(plane, anchor)
      const point = clampPlanePointToGround(plane, { u: projected.u, v: projected.v, layer })
      return { point, anchor, context }
    }
    if (context.floorPoint) {
      const projectPoint = worldToProjectVoxel(context.floorPoint)
      const projected = projectVoxelToPlane(plane, { ...projectPoint, [planeAxes(plane)[2]]: layer })
      const point = clampPlanePointToGround(plane, { u: projected.u, v: projected.v, layer })
      return { point, context }
    }
    return null
  }

  const pointerShapeGroundPoint = (event: { clientX: number; clientY: number }, operation: DrawOperation, layer?: number, attachToHitFace = false, liftAboveHit = false) => {
    // Shape tools always use the fixed editor ground orientation (storage X/Z
    // plane), but their first point may be on any existing voxel layer. The
    // old default of layer 0 made every cuboid/sphere start on the floor even
    // when the pointer was over a voxel high above it.
    if (layer !== undefined) return pointerDrawingPoint(event, operation, layer, shapeDrawingPlane)
    const context = getPointerContext(event)
    const hit = context?.voxelHit
    if (hit) {
      // A cuboid is created adjacent to the face that was clicked.  Using the
      // hit voxel itself here made the first footprint layer overlap that
      // voxel; the normal is the authoritative one-cell attachment direction
      // from the same DDA hit path used by the brush tool.
      const anchor = attachToHitFace && operation === 'add'
        ? adjacentVoxel(hit.voxel, hit.normal)
        : liftAboveHit && operation === 'add'
          ? { ...hit.voxel, y: hit.voxel.y + 1 }
          : hit.voxel
      const point = projectVoxelToPlane(shapeDrawingPlane, anchor)
      return { point: clampPlanePointToGround(shapeDrawingPlane, point), anchor, context }
    }
    // Keep the exact floor point in the gesture context. The fixed-layer
    // fast path intentionally avoids a second occupancy query and therefore
    // cannot provide it by itself, but shape orientation needs the sub-cell
    // click position for its four-way rotation.
    if (context?.floorPoint) {
      const projectPoint = worldToProjectVoxel(context.floorPoint)
      const projected = projectVoxelToPlane(shapeDrawingPlane, { ...projectPoint, y: 0 })
      return { point: clampPlanePointToGround(shapeDrawingPlane, projected), context }
    }
    return pointerDrawingPoint(event, operation, 0, shapeDrawingPlane)
  }

  // Extrusion is view-driven rather than plane-driven.  Keep its initial
  // point in a stable coordinate projection only for the gesture bookkeeping;
  // the actual source slice and direction are determined from the hit voxel.
  const pointerExtrudePoint = (event: { clientX: number; clientY: number }) => {
    const context = getPointerContext(event)
    const hit = context?.voxelHit
    if (!context || !hit) return null
    return { point: projectVoxelToPlane(shapeDrawingPlane, hit.voxel), anchor: hit.voxel, context }
  }

  const projectWorldToClient = (world: THREE.Vector3) => {
    const camera = cameraRef.current
    const renderer = rendererRef.current
    if (!camera || !renderer) return null
    const rect = renderer.domElement.getBoundingClientRect()
    const projected = world.clone().project(camera)
    return {
      x: rect.left + (projected.x + 1) * 0.5 * rect.width,
      y: rect.top + (1 - projected.y) * 0.5 * rect.height,
    }
  }

  const voxelAxisWorldVector = (axis: VoxelAxis) => {
    // Project storage axes are rendered as X, Z, Y respectively.
    if (axis === 'x') return new THREE.Vector3(1, 0, 0)
    if (axis === 'y') return new THREE.Vector3(0, 0, 1)
    return new THREE.Vector3(0, 1, 0)
  }

  const dominantNormalAxis = (normal: Pick<Voxel, 'x' | 'y' | 'z'>): VoxelAxis => {
    const candidates: Array<[VoxelAxis, number]> = [['x', Math.abs(normal.x)], ['y', Math.abs(normal.y)], ['z', Math.abs(normal.z)]]
    return candidates.sort((left, right) => right[1] - left[1])[0][0]
  }

  const extrudeParts = () => {
    const editAssemblyId = editEntityId?.startsWith('assembly:') ? editEntityId.slice('assembly:'.length) : null
    return scenePartsRef.current.filter((part) => !editEntityId || part.id === editEntityId || Boolean(editAssemblyId && (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(editAssemblyId)))
  }

  const extrudeSourceFor = (axis: VoxelAxis, layer: number) => {
    // Use the same effective scene-space voxel path as hit testing and
    // collision detection.  The old canonical-array scan selected the
    // clicked coordinate layer, which is the intended extrusion behavior for
    // stepped models. The effective scene-space conversion remains important
    // for moved asset instances and editable sub-parts.
    const effectiveVoxels = extrudeParts().flatMap((part) => scenePartVoxels(part))
    const source = selectExtrudeLayer(effectiveVoxels, axis, layer)
    return {
      source,
      startLayer: source.length ? source[0][axis] : undefined,
    }
  }

  const chooseExtrudeDirection = (startVoxel: Pick<Voxel, 'x' | 'y' | 'z'>, startClient: { x: number; y: number }, event: { clientX: number; clientY: number }, fallbackAxis: VoxelAxis, fallbackSign: 1 | -1) => {
    const deltaX = event.clientX - startClient.x
    const deltaY = event.clientY - startClient.y
    const distance = Math.hypot(deltaX, deltaY)
    const mouse = distance > 0 ? new THREE.Vector2(deltaX / distance, deltaY / distance) : new THREE.Vector2(0, 0)
    const startWorld = toSceneWorld(voxelCenterToWorld(startVoxel.x), voxelCenterToWorld(startVoxel.y), voxelCenterToWorld(startVoxel.z))
    let best: { axis: VoxelAxis; sign: 1 | -1; screenVector: { x: number; y: number }; score: number } | null = null
    for (const axis of ['x', 'y', 'z'] as VoxelAxis[]) {
      for (const sign of [1, -1] as const) {
        const start = projectWorldToClient(startWorld)
        const end = projectWorldToClient(startWorld.clone().addScaledVector(voxelAxisWorldVector(axis), sign * VOXEL_WORLD_SIZE))
        if (!start || !end) continue
        const screenX = end.x - start.x
        const screenY = end.y - start.y
        const screenLength = Math.hypot(screenX, screenY)
        if (screenLength < 1) continue
        const score = mouse.x * screenX / screenLength + mouse.y * screenY / screenLength
        if (!best || score > best.score) best = { axis, sign, screenVector: { x: screenX, y: screenY }, score }
      }
    }
    if (best && (distance >= 6 || best.score > 0.72)) return best
    const fallbackStart = projectWorldToClient(startWorld)
    const fallbackEnd = projectWorldToClient(startWorld.clone().addScaledVector(voxelAxisWorldVector(fallbackAxis), fallbackSign * VOXEL_WORLD_SIZE))
    const fallbackVector = fallbackStart && fallbackEnd
      ? { x: fallbackEnd.x - fallbackStart.x, y: fallbackEnd.y - fallbackStart.y }
      : { x: 0, y: 0 }
    return { axis: fallbackAxis, sign: fallbackSign, screenVector: fallbackVector, score: 0 }
  }

  const createExtrudeGestureState = (drawing: NonNullable<ReturnType<typeof pointerDrawingPoint>>, event: { clientX: number; clientY: number }) => {
    const hit = drawing.context.voxelHit
    if (!hit) return null
    const fallbackAxis = dominantNormalAxis(hit.normal)
    const fallbackSign = (hit.normal[fallbackAxis] < 0 ? -1 : 1) as 1 | -1
    const startWorld = toSceneWorld(voxelCenterToWorld(hit.voxel.x), voxelCenterToWorld(hit.voxel.y), voxelCenterToWorld(hit.voxel.z))
    const fallbackStart = projectWorldToClient(startWorld)
    const fallbackEnd = projectWorldToClient(startWorld.clone().addScaledVector(voxelAxisWorldVector(fallbackAxis), fallbackSign * VOXEL_WORLD_SIZE))
    return {
      axis: fallbackAxis,
      sign: fallbackSign,
      ...extrudeSourceFor(fallbackAxis, hit.voxel[fallbackAxis]),
      hitVoxel: hit.voxel,
      screenVector: fallbackStart && fallbackEnd
        ? { x: fallbackEnd.x - fallbackStart.x, y: fallbackEnd.y - fallbackStart.y }
        : { x: 0, y: 0 },
    }
  }

  const updateExtrudeGesture = (gesture: DrawingGesture, event: { clientX: number; clientY: number }) => {
    const hitVoxel = gesture.extrudeHitVoxel
    const startScreen = gesture.extrudeStartScreen ?? { x: gesture.startClientX, y: gesture.startClientY }
    const deltaX = event.clientX - startScreen.x
    const deltaY = event.clientY - startScreen.y
    const distance = Math.hypot(deltaX, deltaY)

    // Direction is chosen once, after the pointer has moved enough to reveal
    // intent. Re-evaluating the axis on every sample was the source of both
    // accidental cuts and large one-frame jumps.
    if (!gesture.extrudeDirectionLocked && hitVoxel && distance >= 6) {
      const direction = chooseExtrudeDirection(
        hitVoxel,
        startScreen,
        event,
        gesture.extrudeAxis ?? 'x',
        gesture.extrudeSign ?? 1,
      )
      gesture.extrudeAxis = direction.axis
      gesture.extrudeSign = direction.sign
      gesture.extrudeScreenVector = direction.screenVector
      const layer = hitVoxel[direction.axis]
      const selectedLayer = extrudeSourceFor(direction.axis, layer)
      gesture.extrudeStartLayer = selectedLayer.startLayer
      gesture.extrudeSource = selectedLayer.source
      // The fallback normal is only used before the drag direction is known.
      // Replace the worker session source when the actual direction locks;
      // otherwise the worker can keep extruding the initial thin/incorrect
      // slice even though the UI has switched to the complete face.
      gesture.extrudeSourceUploaded = false
      gesture.extrudePreviewKey = undefined
      gesture.extrudeDirectionLocked = true
    }

    const vector = gesture.extrudeScreenVector ?? { x: 0, y: 0 }
    const screenLength = Math.hypot(vector.x, vector.y)
    const projectedPixels = screenLength > 1
      ? (deltaX * vector.x + deltaY * vector.y) / screenLength
      : Math.sign(deltaX || -deltaY) * distance
    // One cell is represented by the projected length of one world voxel.
    // The minimum avoids explosive deltas when an axis is almost edge-on.
    const pixelsPerCell = Math.max(screenLength, 8)
    const projectedCellDelta = projectedPixels / pixelsPerCell
    const axis = gesture.extrudeAxis ?? 'x'
    const bounds = sceneBoundsForProject(project)
    const maxDelta = axis === 'x' ? bounds.x : axis === 'y' ? bounds.y : bounds.z
    gesture.extrudeDelta = signedExtrudeDelta(projectedCellDelta, gesture.extrudeSign ?? 1, maxDelta)
    gesture.moved = gesture.moved || distance > 4
  }

  const previewShapeVoxels = (gesture: DrawingGesture) => {
    const materialId = activeMaterial
    if (tool === 'line') return rasterizeLine(drawingPlane, gesture.start, gesture.current, brushSize, materialId)
    if (tool === 'cuboid') {
      const footprintEnd = gesture.footprintEnd ?? gesture.current
      return rasterizeCuboid(shapeDrawingPlane, gesture.start, footprintEnd, gesture.start.layer, gesture.stage === 'depth' ? gesture.current.layer : gesture.start.layer, materialId)
    }
    if (tool === 'sphere') {
      return rasterizeAnchoredSphere(shapeDrawingPlane, gesture.start, gesture.current, gesture.baseHeight, materialId)
    }
    if (tool === 'extrude') {
      return rasterizeExtrude(shapeDrawingPlane, gesture.extrudeSource ?? [], gesture.extrudeStartLayer ?? gesture.start.layer, gesture.extrudeDelta ?? 0, gesture.extrudeAxis, activeMaterial, gesture.operation ?? drawOperation)
    }
    return []
  }

  const commitDrawingPreview = (voxels: Voxel[], operation = drawOperation) => {
    const bounds = sceneBoundsForProject(project)
    const inBounds = sceneVoxelsWithinBounds(voxels, bounds)
    if (!inBounds) { onNotice('绘制结果超出场景边界'); return false }
    onApplyVoxelBatch(voxels, operation)
    return true
  }

  const applyPlanarStrokeAt = (
    from: { u: number; v: number; layer: number },
    to: { u: number; v: number; layer: number },
    operation: DrawOperation,
  ) => {
    // Draw and erase deliberately share this exact candidate set. The only
    // difference is the batch operation applied to it. This keeps pointer
    // interpolation, plane locking and brush-size semantics symmetrical.
    const gesture = drawingGestureRef.current
    const candidates = decorateVariantVoxels(
      rasterizePlanarStroke(drawingPlane, from, to, brushSize, activeMaterial),
      gesture ?? ({ variantFacing: '+y', variantRotation: 0 } as DrawingGesture),
      operation,
    )
    const fresh = uniqueVoxels(candidates).filter((voxel) => {
      const key = toolCellKey(voxel)
      if (editStrokeVisitedRef.current.has(key)) return false
      editStrokeVisitedRef.current.add(key)
      return true
    })
    if (fresh.length) onApplyVoxelBatch(fresh, operation)
  }

  const shapeRequestForGesture = (gesture: DrawingGesture, previewOnly = false): VoxelToolsShapeRequest | null => {
    if (!['line', 'cuboid', 'sphere', 'extrude'].includes(tool)) return null
    // The first request uploads the immutable source slice. Once it has
    // reached the worker, later requests omit it and only carry the session
    // id, axis and delta.
    const source = tool === 'extrude' && !gesture.extrudeSourceUploaded ? gesture.extrudeSource ?? [] : undefined
    return {
      kind: tool as VoxelToolsShapeRequest['kind'],
      plane: tool === 'line' ? drawingPlane : shapeDrawingPlane,
      start: gesture.start,
      current: gesture.current,
      footprintEnd: gesture.footprintEnd,
      baseHeight: gesture.baseHeight,
      brushSize,
      materialId: activeMaterial,
      operation: gesture.operation ?? drawOperation,
      source,
      extrudeSessionId: gesture.extrudeSessionId,
      extrudeAxis: gesture.extrudeAxis,
      extrudeStartLayer: gesture.extrudeStartLayer,
      extrudeDelta: gesture.extrudeDelta,
      includeVoxels: !previewOnly || tool !== 'extrude',
    }
  }

  const computeShapeVoxels = (gesture: DrawingGesture) => {
    const request = shapeRequestForGesture(gesture)
    if (!request) return Promise.resolve([] as Voxel[])
    const client = voxelToolsWorkerRef.current
    if (!client) return Promise.resolve(decorateVariantVoxels(previewShapeVoxels(gesture), gesture, gesture.operation ?? drawOperation))
    return client.compute(request)
      .then((result) => decorateVariantVoxels(result, gesture, gesture.operation ?? drawOperation))
      .catch(() => decorateVariantVoxels(previewShapeVoxels(gesture), gesture, gesture.operation ?? drawOperation))
  }

  const requestShapePreview = (gesture: DrawingGesture) => {
    const client = voxelToolsWorkerRef.current
    if (tool === 'extrude' && client && !gesture.extrudeSessionId) gesture.extrudeSessionId = client.createExtrudeSession()
    const request = shapeRequestForGesture(gesture, true)
    if (!request) return
    if (tool === 'extrude') {
      const previewKey = `${gesture.extrudeSessionId ?? 'local'}:${gesture.extrudeAxis ?? 'x'}:${gesture.extrudeSign ?? 1}:${gesture.extrudeDelta ?? 0}:${gesture.operation ?? drawOperation}`
      if (gesture.extrudePreviewKey === previewKey) return
      gesture.extrudePreviewKey = previewKey
      gesture.extrudeSourceUploaded = true
    }
    const revision = ++toolPreviewRevisionRef.current
    const previewPromise = client
      ? client.computeLatest(request).catch(() => ({ voxels: previewShapeVoxels(gesture), mesh: null }))
      : computeShapeVoxels(gesture).then((voxels) => ({ voxels, mesh: null }))
    void previewPromise.then((result) => {
      if (revision !== toolPreviewRevisionRef.current || drawingGestureRef.current !== gesture) return
      const voxels = decorateVariantVoxels(result.voxels, gesture, gesture.operation ?? drawOperation)
      latestToolPreviewVoxelsRef.current = voxels
      setToolPreviewVoxels(voxels)
      setToolPreviewMesh(result.mesh)
    })
  }

  const drawingLayerFromPointer = (gesture: DrawingGesture, event: { clientX: number; clientY: number }) => {
    const camera = cameraRef.current
    const renderer = rendererRef.current
    if (!camera || !renderer) return gesture.start.layer
    const [, , layerAxis] = planeAxes(shapeDrawingPlane)
    const startCell = makePlaneVoxel(shapeDrawingPlane, gesture.start.u, gesture.start.v, gesture.start.layer)
    const nextCell = { ...startCell, [layerAxis]: startCell[layerAxis] + 1 }
    const startWorld = toSceneWorld(voxelCenterToWorld(startCell.x), voxelCenterToWorld(startCell.y), voxelCenterToWorld(startCell.z))
    const nextWorld = toSceneWorld(voxelCenterToWorld(nextCell.x), voxelCenterToWorld(nextCell.y), voxelCenterToWorld(nextCell.z))
    const rect = renderer.domElement.getBoundingClientRect()
    const toClient = (world: THREE.Vector3) => {
      const projected = world.clone().project(camera)
      return {
        x: rect.left + (projected.x + 1) * 0.5 * rect.width,
        y: rect.top + (1 - projected.y) * 0.5 * rect.height,
      }
    }
    const startScreen = toClient(startWorld)
    const nextScreen = toClient(nextWorld)
    const axisX = nextScreen.x - startScreen.x
    const axisY = nextScreen.y - startScreen.y
    const axisLengthSquared = axisX * axisX + axisY * axisY
    const startClientX = gesture.depthStartClientX ?? event.clientX
    const startClientY = gesture.depthStartClientY ?? event.clientY
    if (axisLengthSquared < 1) {
      // If the active layer points almost directly into the camera, its
      // projected axis has no useful screen direction. A vertical fallback is
      // still deterministic and lets the second cuboid gesture succeed.
      const nextLayer = gesture.start.layer + Math.round((startClientY - event.clientY) / 8)
      return planeAxes(shapeDrawingPlane)[2] === 'y' ? Math.max(0, nextLayer) : nextLayer
    }
    const deltaX = event.clientX - startClientX
    const deltaY = event.clientY - startClientY
    const projectedDelta = (deltaX * axisX + deltaY * axisY) / axisLengthSquared
    const nextLayer = gesture.start.layer + Math.round(projectedDelta)
    return planeAxes(shapeDrawingPlane)[2] === 'y' ? Math.max(0, nextLayer) : nextLayer
  }

  const processDrawingGestureMove = (event: { pointerId: number; clientX: number; clientY: number }) => {
    const drawingGesture = drawingGestureRef.current
    if (!drawingGesture || drawingGesture.pointerId !== event.pointerId) return
    if (tool === 'cuboid' && drawingGesture.stage === 'depth') {
      const layer = drawingLayerFromPointer(drawingGesture, event)
      drawingGesture.current = { ...(drawingGesture.footprintEnd ?? drawingGesture.start), layer }
      drawingGesture.moved = drawingGesture.moved || Math.hypot(event.clientX - (drawingGesture.depthStartClientX ?? event.clientX), event.clientY - (drawingGesture.depthStartClientY ?? event.clientY)) > 4
      requestShapePreview(drawingGesture)
      return
    }
    if (tool === 'extrude') {
      updateExtrudeGesture(drawingGesture, event)
      requestShapePreview(drawingGesture)
      return
    }
    const previousPoint = drawingGesture.current
    if (tool === 'erase') {
      drawingGesture.moved = drawingGesture.moved || Math.hypot(event.clientX - drawingGesture.startClientX, event.clientY - drawingGesture.startClientY) > 4
      const drawing = pointerDrawingPoint(event, 'subtract', drawingGesture.start.layer)
      if (!drawing) return
      drawingGesture.current = drawing.point
      applyPlanarStrokeAt(previousPoint, drawing.point, 'subtract')
      return
    }
    const drawing = (tool === 'cuboid' || tool === 'sphere')
      ? pointerShapeGroundPoint(event, drawOperation, drawingGesture.start.layer)
      : pointerDrawingPoint(event, drawOperation, drawingGesture.start.layer)
    if (!drawing) return
    if (drawingGesture.stage !== 'depth') drawing.point.layer = drawingGesture.start.layer
    else if (tool === 'cuboid' && drawingGesture.footprintEnd) drawing.point = { ...drawing.point, u: drawingGesture.footprintEnd.u, v: drawingGesture.footprintEnd.v }
    drawingGesture.current = drawing.point
    drawingGesture.moved = drawingGesture.moved || Math.hypot(event.clientX - drawingGesture.startClientX, event.clientY - drawingGesture.startClientY) > 4
    if (tool === 'brush') applyPlanarStrokeAt(previousPoint, drawing.point, drawOperation)
    else requestShapePreview(drawingGesture)
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
    const hitPartId = context?.voxelHit?.ownerIds[0]
    const hitPart = hitPartId ? sceneEntityParts(authoritativeProjectRef.current).find((part) => part.id === hitPartId) : undefined
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
    // For large imported parts, projecting every voxel on mouse-up creates a
    // noticeable release hitch. A projected voxel AABB is conservative and
    // gives the same entity-level selection behavior while reducing the work
    // to eight projections. Keep exact voxel-center testing for small parts so
    // narrow, sparse hand-authored entities retain the previous precision.
    const LARGE_PART_BOX_SELECTION_LIMIT = 4096
    const projectGridBounds = (bounds: GridVoxelBounds) => {
      const points: Array<[number, number, number]> = [
        [bounds.minX, bounds.minY, bounds.minZ], [bounds.minX, bounds.minY, bounds.maxZ],
        [bounds.minX, bounds.maxY, bounds.minZ], [bounds.minX, bounds.maxY, bounds.maxZ],
        [bounds.maxX, bounds.minY, bounds.minZ], [bounds.maxX, bounds.minY, bounds.maxZ],
        [bounds.maxX, bounds.maxY, bounds.minZ], [bounds.maxX, bounds.maxY, bounds.maxZ],
      ]
      const projected = points.map(([x, y, z]) => {
        const point = toSceneWorld(voxelCenterToWorld(x), voxelCenterToWorld(y), voxelCenterToWorld(z)).project(camera)
        return {
          x: rect.left + (point.x + 1) * 0.5 * rect.width,
          y: rect.top + (1 - point.y) * 0.5 * rect.height,
        }
      })
      return projected.reduce((result, point) => ({
        minX: Math.min(result.minX, point.x),
        maxX: Math.max(result.maxX, point.x),
        minY: Math.min(result.minY, point.y),
        maxY: Math.max(result.maxY, point.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
    }
    for (const part of sceneEntityParts(authoritativeProjectRef.current)) {
      const bounds = gridVoxelBounds(part.voxels)
      if (!bounds) continue
      const offset = scenePartGridOffset(part)
      const sceneBounds = {
        minX: bounds.minX + offset.x,
        maxX: bounds.maxX + offset.x,
        minY: bounds.minY + offset.y,
        maxY: bounds.maxY + offset.y,
        minZ: bounds.minZ + offset.z,
        maxZ: bounds.maxZ + offset.z,
      }
      const projectedBounds = projectGridBounds(sceneBounds)
      const boundsOverlap = projectedBounds.maxX >= minX && projectedBounds.minX <= maxX
        && projectedBounds.maxY >= minY && projectedBounds.minY <= maxY
      if (!boundsOverlap) continue
      if (part.voxels.length > LARGE_PART_BOX_SELECTION_LIMIT) {
        selected.add(part.id)
        continue
      }
      if (scenePartVoxels(part).some((voxel) => {
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
    const allPartRoots = new Map<string, THREE.Object3D>()
    group.traverse((object) => {
      const scenePartId = object.userData.scenePartId as string | undefined
      const parentPartId = object.parent?.userData.scenePartId as string | undefined
      if (!scenePartId || parentPartId === scenePartId || object.userData.selectionGlow) return
      allPartRoots.set(scenePartId, object)
    })
    const partRoots = [...allPartRoots.entries()].filter(([scenePartId]) => requestedIds.has(scenePartId))
    const findInstanceRoot = (partRoot: THREE.Object3D) => {
      let current: THREE.Object3D | null = partRoot
      while (current) {
        if (typeof current.userData.instanceId === 'string') return current
        current = current.parent
      }
      return undefined
    }
    const roots: SelectGesture['visualRoots'] = []
    const seenRoots = new Set<THREE.Object3D>()
    partRoots.forEach(([scenePartId, partRoot]) => {
      const instanceRoot = findInstanceRoot(partRoot)
      // A complete asset instance is committed by changing its root
      // transform. Move that same root during the preview; moving a child
      // part here and the instance root on pointer-up applies the delta twice.
      // Partial part moves still use the part group because their commit is
      // stored in instance.partOffsets.
      const instancePartIds = instanceRoot
        ? [...allPartRoots.entries()]
          .filter(([, root]) => findInstanceRoot(root) === instanceRoot)
          .map(([id]) => id)
        : []
      const visualRoot = instanceRoot && instancePartIds.every((id) => requestedIds.has(id))
        ? instanceRoot
        : partRoot
      if (seenRoots.has(visualRoot)) return
      seenRoots.add(visualRoot)
      roots.push({ object: visualRoot, startPosition: visualRoot.position.clone() })
    })
    return roots
  }

  const updateSelectGestureAtPointer = (gesture: SelectGesture, event: { clientX: number; clientY: number }) => {
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 5) gesture.moved = true
    if (!gesture.moved) return
    if (dragAxis === 'vertical') {
      if (!setPointerRay(event)) return
      const verticalPoint = getVerticalPoint(gesture.verticalPlane)
      if (!verticalPoint) return
      const deltaY = worldToVoxel(verticalPoint.z - gesture.startVerticalZ)
      if (deltaY === gesture.lastDeltaY) return
      const moveResult = onPreviewScenePartsMove(gesture.parts, 0, deltaY, 0)
      // A blocked request means the pointer has moved beyond the last valid
      // grid position. Keep that last valid position on screen; applying the
      // result's zero delta here would snap the model back to the gesture
      // origin for one or more frames. This is especially visible when the
      // moving model crosses another entity's projected surface.
      if (!moveResult.moved && moveResult.blocked && (gesture.lastDeltaX || gesture.lastDeltaY || gesture.lastDeltaZ)) {
        setDragVisualOffset(gesture, gesture.lastDeltaX, gesture.lastDeltaY, gesture.lastDeltaZ)
        return
      }
      gesture.lastDeltaX = moveResult.deltaX
      gesture.lastDeltaY = moveResult.deltaY
      gesture.lastDeltaZ = moveResult.deltaZ
      setDragVisualOffset(gesture, moveResult.deltaX, moveResult.deltaY, moveResult.deltaZ)
      return
    }
    // During a horizontal drag, keep the gesture on the plane selected at
    // pointer-down. If the ray is temporarily parallel to that plane, retain
    // the last validated position instead of projecting onto a different
    // plane and producing a large, reversed delta.
    const floorPoint = pointerHorizontalPoint(event, gesture.horizontalPlaneZ)
    if (!floorPoint) return
    const deltaX = worldToVoxel(floorPoint.x - gesture.startGroundX)
    const deltaZ = worldToVoxel(floorPoint.y - gesture.startGroundY)
    if (deltaX === gesture.lastDeltaX && deltaZ === gesture.lastDeltaZ) return
    const moveResult = onPreviewScenePartsMove(gesture.parts, deltaX, 0, deltaZ)
    if (!moveResult.moved && moveResult.blocked && (gesture.lastDeltaX || gesture.lastDeltaY || gesture.lastDeltaZ)) {
      setDragVisualOffset(gesture, gesture.lastDeltaX, gesture.lastDeltaY, gesture.lastDeltaZ)
      return
    }
    gesture.lastDeltaX = moveResult.deltaX
    gesture.lastDeltaY = moveResult.deltaY
    gesture.lastDeltaZ = moveResult.deltaZ
    setDragVisualOffset(gesture, moveResult.deltaX, moveResult.deltaY, moveResult.deltaZ)
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
    pendingDragVisualRootsRef.current.clear()
    if (!gesture.moved || (!gesture.lastDeltaX && !gesture.lastDeltaY && !gesture.lastDeltaZ)) {
      skipNextTransformRenderRef.current = false
      resetDragVisuals(gesture)
      onCancelScenePartsMove()
      return
    }
    // Publish the visual destination before asking the parent to commit the
    // project.  The parent intentionally commits large moves inside a React
    // transition; an effect from the transition can therefore run between
    // the callback and the next paint.  If the guard is installed only after
    // the callback returns, that effect briefly applies the old scene offset
    // and the dragged entity flashes back (the next frame then moves it out
    // again).  The same grid delta is used by validation, rendering and the
    // persisted customEntityOffsets, so this is a safe optimistic guard.
    const applyPendingDestination = (deltaX: number, deltaY: number, deltaZ: number) => {
      const worldOffset = new THREE.Vector3(
        voxelToWorld(deltaX),
        voxelToWorld(deltaZ),
        voxelToWorld(deltaY),
      )
      gesture.visualRoots.forEach(({ object, startPosition }) => {
        const destination = startPosition.clone().add(worldOffset)
        object.position.copy(destination)
        pendingDragVisualRootsRef.current.set(object, destination)
      })
    }
    applyPendingDestination(gesture.lastDeltaX, gesture.lastDeltaY, gesture.lastDeltaZ)
    // Keep the imperative preview at the final position while the authoritative
    // project snapshot is committed. Resetting it first makes the released
    // entity visibly jump back to its start position; the following React
    // render then moves it to the destination again. The preview and the
    // project use the same grid delta, so there is no double-translation here.
    skipNextTransformRenderRef.current = true
    const result = onCommitScenePartsMove(gesture.parts, gesture.lastDeltaX, gesture.lastDeltaY, gesture.lastDeltaZ)
    if (!result.moved) {
      skipNextTransformRenderRef.current = false
      pendingDragVisualRootsRef.current.clear()
      resetDragVisuals(gesture)
    } else {
      // The final commit can clamp a stale pointer-up proposal to a newer
      // collision/boundary-safe grid position. Keep the imperative render
      // exactly in sync with the authoritative result so a concurrent scene
      // update cannot make the model flash to the origin or drift away from
      // the cursor after release.
      applyPendingDestination(result.deltaX, result.deltaY, result.deltaZ)
    }
    finishDragRenderBurstRef.current()
  }

  const partBelongsToEditEntity = (part: SceneEntityPart | undefined) => {
    if (!part || !editEntityId) return Boolean(part)
    if (part.id === editEntityId) return true
    if (!editEntityId.startsWith('assembly:')) return false
    const assemblyId = editEntityId.slice('assembly:'.length)
    return (part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])).includes(assemblyId)
  }

  const strokeVoxelKey = (voxel: Pick<Voxel, 'x' | 'y' | 'z'>) => `${voxel.x},${voxel.y},${voxel.z}`
  const applyStrokeAdd = (voxel: Voxel, key = `scene:${strokeVoxelKey(voxel)}`) => {
    const operationKey = `add:${key}`
    if (editStrokeVisitedRef.current.has(operationKey)) return
    editStrokeVisitedRef.current.add(operationKey)
    onAddVoxel(voxel)
  }
  const applyStrokeRemove = (voxel: Voxel, key = `scene:${strokeVoxelKey(voxel)}`) => {
    const operationKey = `remove:${key}`
    if (editStrokeVisitedRef.current.has(operationKey)) return
    editStrokeVisitedRef.current.add(operationKey)
    onRemoveVoxel(voxel)
  }
  const applyStrokeInstance = (instanceId: string, voxel: Voxel, mode: VoxelOverride['mode']) => {
    const operationKey = `instance:${mode}:${instanceId}:${strokeVoxelKey(voxel)}`
    if (editStrokeVisitedRef.current.has(operationKey)) return
    editStrokeVisitedRef.current.add(operationKey)
    onEditInstanceVoxel(instanceId, voxel, mode)
  }

  const applyEditAtPointer = (event: { clientX: number; clientY: number }, options: { allowFloorFallback?: boolean } = {}) => {
    const context = getPointerContext(event)
    if (!context) return
    const { voxelHit, floorPoint } = context
    const hitPartId = voxelHit?.ownerIds[0]
    const hitPart = hitPartId ? scenePartsRef.current.find((part) => part.id === hitPartId) : undefined
    if (tool === 'select' && editEntityId) return
    if (tool === 'select' && partBelongsToEditEntity(hitPart)) {
      onSelect(hitPart!.id)
      return
    }
    if (tool !== 'brush' && tool !== 'erase') return
    // DDA gives the nearest occupied cell and its project-space surface
    // normal. It replaces the old Three.js intersection path, which had to
    // test every instance in a large InstancedMesh and could block for seconds.
    if (voxelHit && hitPart) {
      const hitVoxel = scenePartVoxelAtCoordinate(hitPart, voxelHit.voxel.x, voxelHit.voxel.y, voxelHit.voxel.z)
      if (!hitVoxel) return
      if (!partBelongsToEditEntity(hitPart)) {
        if (tool === 'brush') applyStrokeAdd(adjacentVoxel(voxelHit.voxel, voxelHit.normal, activeMaterial))
        else onNotice('擦除模式只能作用于当前编辑实体 · 其他实体仍会阻挡穿透')
        return
      }
      if (hitPart.kind === 'asset' && hitPart.instanceId) {
        const instance = project.instances.find((candidate) => candidate.id === hitPart.instanceId)
        const asset = instance ? project.assets.find((candidate) => candidate.id === instance.assetId) : undefined
        if (!instance || !asset) return
        const localHitVoxel = assetTransformCache.localVoxelAtSceneVoxel(instance, asset, hitVoxel)
        if (!localHitVoxel) return
        if (!editEntityId) {
          if (tool === 'brush') applyStrokeAdd(adjacentVoxel(voxelHit.voxel, voxelHit.normal, activeMaterial))
          else onNotice('非编辑模式下不能擦除资产实体 · 请先进入编辑模式')
        } else if (tool === 'brush') {
          const targetSceneVoxel = adjacentVoxel(voxelHit.voxel, voxelHit.normal, activeMaterial)
          const localTarget = assetTransformCache.localVoxelAtSceneVoxel(instance, asset, targetSceneVoxel)
          if (localTarget) applyStrokeInstance(instance.id, { ...localTarget, materialId: activeMaterial }, 'add')
        } else {
          applyStrokeInstance(instance.id, localHitVoxel, 'remove')
        }
        return
      }
      if (hitPart.kind === 'custom') {
        if (tool === 'brush') applyStrokeAdd(adjacentVoxel(hitVoxel, voxelHit.normal, activeMaterial))
        else applyStrokeRemove(hitVoxel)
        return
      }
      return
    }
    if (!floorPoint || options.allowFloorFallback === false) return
    const x = worldToVoxelCell(floorPoint.x)
    const z = worldToVoxelCell(floorPoint.y)
    const sceneVoxel = { x, y: 0, z, materialId: activeMaterial }
    const assetMap = new Map(project.assets.map((asset) => [asset.id, asset]))
    const occupiedAsset = project.instances.find((instance) => {
      if (!instance.visible) return false
      const asset = assetMap.get(instance.assetId)
      return asset ? Boolean(assetTransformCache.localVoxelAtSceneVoxel(instance, asset, sceneVoxel)) : false
    })
    if (occupiedAsset) {
      const asset = assetMap.get(occupiedAsset.assetId)
      const localVoxel = asset
        ? assetTransformCache.localVoxelAtSceneVoxel(occupiedAsset, asset, sceneVoxel)
        : undefined
      if (editEntityId && tool === 'erase' && localVoxel) applyStrokeInstance(occupiedAsset.id, localVoxel, 'remove')
      else onNotice('目标网格已有资产体素 · 请点击资产表面编辑')
      return
    }
    if (tool === 'brush') {
      const floorOwners = occupancyIndex?.queryProjectVoxel(sceneVoxel).ownerIds ?? []
      if (floorOwners.some((ownerId) => ownerId.startsWith('custom:'))) onNotice('目标网格已有体素 · 请点击体素表面添加')
      else applyStrokeAdd(sceneVoxel)
    } else {
      const bounds = sceneBoundsForProject(project)
      const highestHit = occupancyIndex?.highestProjectVoxelAt(x, z, 0, bounds.z - 1, 'custom:')
      if (!highestHit) return
      const part = scenePartsRef.current.find((candidate) => candidate.id === highestHit.ownerId)
      const highest = part
        ? scenePartVoxelAtCoordinate(part, highestHit.voxel.x, highestHit.voxel.y, highestHit.voxel.z)
        : undefined
      if (highest) applyStrokeRemove(highest)
    }
  }

  // Erase is intentionally a one-cell operation. The old implementation was
  // named quick erase but scanned a radius-2 region, so every pointer sample
  // deleted a disk of cells. Continuous erasing is still smooth because the
  // caller interpolates pointer samples and deduplicates them per stroke; the
  // hit itself must remain the exact DDA cell under the cursor.
  const applyPreciseEraseAtPointer = (point: { clientX: number; clientY: number }) => {
    applyEditAtPointer(point, { allowFloorFallback: false })
  }

  const processEditPointerMove = (point: { pointerId: number; clientX: number; clientY: number }) => {
    const gesture = editGestureRef.current
    if (!gesture || gesture.pointerId !== point.pointerId) return
    const distance = Math.hypot(point.clientX - gesture.lastX, point.clientY - gesture.lastY)
    if (distance < 1) return
    if (Math.hypot(point.clientX - gesture.x, point.clientY - gesture.y) > 5) gesture.moved = true
    // Pointer events can arrive much faster than a frame. Sampling once per
    // animation frame and interpolating at a slightly coarser screen spacing
    // prevents a fast trackpad gesture from issuing dozens of full raycasts.
    const steps = Math.max(1, Math.ceil(distance / 6))
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps
      const sample = {
        clientX: gesture.lastX + (point.clientX - gesture.lastX) * progress,
        clientY: gesture.lastY + (point.clientY - gesture.lastY) * progress,
      }
      if (tool === 'erase') applyPreciseEraseAtPointer(sample)
      else applyEditAtPointer(sample)
    }
    gesture.lastX = point.clientX
    gesture.lastY = point.clientY
  }

  const flushPendingEditMove = (point?: { pointerId: number; clientX: number; clientY: number }) => {
    if (point) pendingEditPointRef.current = point
    if (editMoveFrameRef.current !== null) {
      cancelAnimationFrame(editMoveFrameRef.current)
      editMoveFrameRef.current = null
    }
    const pending = pendingEditPointRef.current
    pendingEditPointRef.current = null
    if (pending) processEditPointerMove(pending)
  }

  const isPreviewTouch = (event: { pointerType?: string; pointerId?: number }) => event.pointerType === 'touch' && (Boolean(event.pointerId !== undefined && previewTouchPointersRef.current.has(event.pointerId)) || Boolean(geometryPreview || copyPreview))

  const beginPreviewTouch = (event: { pointerId: number; clientX: number; clientY: number }) => {
    previewTouchPointersRef.current.add(event.pointerId)
    if (previewTouchPointersRef.current.size >= 2) {
      // OrbitControls owns the two-finger pan/pinch. Do not let the first
      // touch pointer be interpreted as a scene click that cancels a pending
      // geometry/copy preview.
      previewMultiTouchRef.current = true
      previewTouchGestureRef.current = null
      return
    }
    previewTouchGestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false }
  }

  const movePreviewTouch = (event: { pointerId: number; clientX: number; clientY: number }) => {
    const gesture = previewTouchGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gesture.moved = gesture.moved || Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 6
  }

  const endPreviewTouch = (event: { pointerId: number }) => {
    previewTouchPointersRef.current.delete(event.pointerId)
    if (previewTouchPointersRef.current.size > 0) return
    const gesture = previewTouchGestureRef.current
    const wasMultiTouch = previewMultiTouchRef.current
    previewTouchGestureRef.current = null
    previewMultiTouchRef.current = false
    // Preserve the established single-tap behavior, but never treat the
    // release of a two-finger camera gesture as a click on the scene.
    if (gesture && !gesture.moved && !wasMultiTouch) onCancelPendingEntityOperation()
  }

  const handleEditPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isPreviewTouch(event)) {
      beginPreviewTouch(event)
      return
    }
    // A right-button gesture is camera panning and does not query occupancy;
    // left-button scene edits stay locked until the background index is ready.
    if (geometryApplying && event.button === 0) return
    // Hit testing must use the same absolute owner transforms as rendering.
    // This is a metadata-only reconciliation for ordinary custom entities;
    // it prevents an old lazy drag offset from making a visible asset miss the
    // next click or from making collision appear before visual contact.
    onSyncSceneOccupancyTransforms()
    if (event.button === 0 || event.button === 2) setSceneContextMenu(null)
    if (event.button === 0 || event.button === 2) event.currentTarget.setPointerCapture(event.pointerId)
    if (event.button === 2) {
      if (placementAsset) return
      if (tool === 'select') onCancelPendingEntityOperation()
      const context = geometryApplying ? null : getPointerContext(event)
      const hitPartId = context?.voxelHit?.ownerIds[0]
      const hitPart = hitPartId ? sceneEntityParts(authoritativeProjectRef.current).find((part) => part.id === hitPartId) : undefined
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
      const floorPoint = context?.floorPoint
      const hitPartId = context?.voxelHit?.ownerIds[0]
      const currentProject = authoritativeProjectRef.current
      const currentSceneParts = sceneEntityParts(currentProject)
      const hitPart = hitPartId ? currentSceneParts.find((part) => part.id === hitPartId) : undefined
      if (hitPart) {
        const explicitMultiSelection = selectedPartIds.length > 1 && (checkedPartIds.length > 1 || (checkedPartIds.length === 1 && !checkedPartIds[0].startsWith('assembly:')))
        const selectedParts = explicitMultiSelection && selectedPartIds.includes(hitPart.id)
          ? currentSceneParts.filter((part) => selectedPartIds.includes(part.id))
          : [hitPart]
        const instanceId = hitPart.instanceId
        const instance = instanceId ? currentProject.instances.find((item) => item.id === instanceId) : undefined

        const hitAssemblyIds = hitPart.assemblyIds ?? (hitPart.assemblyId ? [hitPart.assemblyId] : [])
        const selectedAssemblyRootIds = new Set(selectedParts.flatMap((part) => {
          const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
          return assemblyIds.length ? [assemblyIds[assemblyIds.length - 1]] : []
        }))
        if (hitAssemblyIds.length && !selectedAssemblyRootIds.size) {
          selectedAssemblyRootIds.add(hitAssemblyIds[hitAssemblyIds.length - 1])
        }
        // A scene drag always operates on an assembly as a single rigid body.
        // The file tree may select one child, and a scene hit may land on only
        // one voxel, but moving just that part would split the assembly and
        // make its own remaining members look like collision obstacles. Use
        // the outermost assembly id so nested assemblies move with their
        // parent as well.
        const dragParts = selectedAssemblyRootIds.size
            ? currentSceneParts.filter((part) => {
                const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
                return selectedParts.some((selected) => selected.id === part.id)
                  || assemblyIds.some((assemblyId) => selectedAssemblyRootIds.has(assemblyId))
              })
            : !explicitMultiSelection
              && hitPart.kind === 'asset'
              && instanceId
              ? currentSceneParts.filter((part) => part.kind === 'asset' && part.instanceId === instanceId)
              : selectedParts
        const dragContainsAssembly = dragParts.some((part) => {
          const assemblyIds = part.assemblyIds ?? (part.assemblyId ? [part.assemblyId] : [])
          return assemblyIds.length > 0
        })
        if (event.metaKey || event.shiftKey) {
          onSelectMultiple(hitSelectionPartIds(hitPart), true)
          onNotice('已加入复选 · 可继续选择多个实体')
          return
        }
        onSelect(hitPart.id)
        const dragAssemblyLocked = dragContainsAssembly && dragParts.some((part) => lockedPartIds.has(part.id))
        const movableParts = dragAssemblyLocked ? [] : dragParts.filter((part) => !lockedPartIds.has(part.id))
        if (!movableParts.length) {
          onNotice('当前实体已固定 · 请先在右键菜单中取消固定')
          return
        }
        // Dragging needs only an anchor point. Do not expand the whole part
        // into scene coordinates on pointer-down, otherwise large imported
        // models stall before the gesture even begins.
        const anchorVoxel = scenePartVoxelAt(hitPart, 0)
        const anchor = instance
          ? toSceneWorld(instance.x, instance.y ?? 0, instance.z)
          : toSceneWorld(voxelCenterToWorld(anchorVoxel?.x ?? 0), voxelCenterToWorld(anchorVoxel?.y ?? 0), voxelCenterToWorld(anchorVoxel?.z ?? 0))
        const horizontalPlaneZ = anchor.z
        const dragGroundPoint = pointerHorizontalPoint(event, horizontalPlaneZ) ?? pointerFloorPoint(event) ?? floorPoint
        const selectionLabel = dragContainsAssembly ? '已选中装配体' : '已选中实体'
        onNotice(`${selectionLabel} · ${movableParts.length} 个零件`)
        selectGestureRef.current = {
          pointerId: event.pointerId,
          kind: 'parts',
          parts: movableParts,
          startX: event.clientX,
          startY: event.clientY,
          // The finite editing-floor mesh can miss when the ray through a
          // tall entity intersects the mathematical ground outside its
          // rectangle. Use the unbounded ground-plane projection as the drag
          // anchor; otherwise the first delta is measured from (0, 0) and a
          // normal click can jump the entity through another object.
          startGroundX: dragGroundPoint?.x ?? 0,
          startGroundY: dragGroundPoint?.y ?? 0,
          horizontalPlaneZ,
          startVerticalZ: getVerticalPoint(makeVerticalPlane(anchor))?.z ?? anchor.z,
          verticalPlane: makeVerticalPlane(anchor),
          lastDeltaX: 0,
          lastDeltaY: 0,
          lastDeltaZ: 0,
          visualRoots: collectDragVisualRoots(movableParts.map((part) => part.id)),
          moved: false,
        }
        setViewportInteraction(true)
      } else {
        boxSelectGestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY, additive: event.metaKey || event.shiftKey, moved: false }
        setSceneSelectionBox(null)
        if (controlsRef.current) controlsRef.current.enabled = false
      }
      if (controlsRef.current) controlsRef.current.enabled = false
      return
    }
    if (!drawingToolIds.has(tool)) return
    if ((drawOperation !== 'add' || tool === 'erase' || tool === 'extrude') && !editEntityId) {
      // These tools are intentionally inert outside entity edit mode. Stop
      // OrbitControls as well as the voxel path: otherwise its pointer-down
      // listener can enter ROTATE before this bubbling React handler rejects
      // the drawing, leaving a stale gesture that rotates the scene when the
      // user later switches back to selection mode.
      event.preventDefault()
      event.stopPropagation()
      resetOrbitControlsGesture()
      if (controlsRef.current) controlsRef.current.enabled = false
      onNotice('该工具需要先进入实体编辑模式')
      return
    }
    const existingCuboid = drawingGestureRef.current?.stage === 'depth' && tool === 'cuboid' ? drawingGestureRef.current : null
    const drawing = existingCuboid
      ? null
      : tool === 'extrude'
        ? pointerExtrudePoint(event)
        : tool === 'cuboid'
          ? pointerShapeGroundPoint(event, drawOperation, undefined, true)
          : tool === 'sphere'
            ? pointerShapeGroundPoint(event, drawOperation, undefined, false, true)
            : pointerDrawingPoint(event, tool === 'erase' ? 'subtract' : drawOperation)
    if (!existingCuboid && !drawing) return
    const extrudeState = tool === 'extrude' && drawing ? createExtrudeGestureState(drawing, event) : null
    if (tool === 'extrude' && (!extrudeState || !extrudeState.source.length)) {
      onNotice('当前编辑实体在点击位置没有可拉伸体素')
      return
    }
    const start = existingCuboid?.start ?? drawing!.point
    const baseVoxel = makePlaneVoxel(tool === 'line' ? drawingPlane : shapeDrawingPlane, start.u, start.v, start.layer)
    drawingGestureRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      depthStartClientX: existingCuboid ? event.clientX : undefined,
      depthStartClientY: existingCuboid ? event.clientY : undefined,
      start,
      current: existingCuboid ? { ...(existingCuboid.footprintEnd ?? start), layer: start.layer } : drawing!.point,
      footprintEnd: existingCuboid?.footprintEnd,
      baseHeight: existingCuboid?.baseHeight ?? (tool === 'sphere' ? Math.max(0, drawing?.point.layer ?? baseVoxel.y) : Math.max(0, drawing?.anchor?.y ?? baseVoxel.y)),
      stage: existingCuboid ? 'depth' : 'footprint',
      moved: false,
      extrudeAxis: extrudeState?.axis,
      extrudeSign: extrudeState?.sign,
      extrudeDelta: tool === 'extrude' ? 0 : undefined,
      extrudeStartLayer: extrudeState?.startLayer,
      extrudeSource: extrudeState?.source,
      extrudeHitVoxel: extrudeState?.hitVoxel,
      extrudeDirectionLocked: false,
      extrudeStartScreen: tool === 'extrude' ? { x: event.clientX, y: event.clientY } : undefined,
      extrudeScreenVector: extrudeState?.screenVector,
      operation: drawOperation,
      // The second pointer-down of a cuboid is only the height phase. Keep
      // the face and quarter-turn selected by its footprint click instead of
      // resetting the variant because that phase has no new ray hit.
      variantFacing: existingCuboid?.variantFacing ?? facingFromHitNormal(drawing?.context.voxelHit?.normal),
      variantRotation: existingCuboid?.variantRotation ?? (drawing
        ? rotationFromPointerFace(drawing.context, facingFromHitNormal(drawing.context.voxelHit?.normal))
        : 0),
    }
    const activeGesture = drawingGestureRef.current
    editStrokeVisitedRef.current.clear()
    if (controlsRef.current) controlsRef.current.enabled = false
    setViewportInteraction(true)
    if (tool === 'brush') applyPlanarStrokeAt(activeGesture.current, activeGesture.current, drawOperation)
    else if (tool === 'erase') applyPlanarStrokeAt(activeGesture.current, activeGesture.current, 'subtract')
    else requestShapePreview(activeGesture)
  }

  const handleEditPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isPreviewTouch(event)) {
      movePreviewTouch(event)
      return
    }
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
      updateSelectGestureAtPointer(selectGesture, event)
      return
    }
    const drawingGesture = drawingGestureRef.current
    if (drawingGesture?.pointerId === event.pointerId) {
      pendingDrawingPointRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }
      if (drawingMoveFrameRef.current === null) {
        drawingMoveFrameRef.current = requestAnimationFrame(() => {
          drawingMoveFrameRef.current = null
          const pending = pendingDrawingPointRef.current
          pendingDrawingPointRef.current = null
          if (pending) processDrawingGestureMove(pending)
        })
      }
      return
    }
    const gesture = editGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    pendingEditPointRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY }
    if (editMoveFrameRef.current === null) {
      editMoveFrameRef.current = requestAnimationFrame(() => {
        editMoveFrameRef.current = null
        const pending = pendingEditPointRef.current
        pendingEditPointRef.current = null
        if (pending) processEditPointerMove(pending)
      })
    }
  }

  const handleEditPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isPreviewTouch(event)) {
      endPreviewTouch(event)
      return
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (placementAsset) {
      const context = getPointerContext(event)
      const preview = context?.floorPoint ? onPreviewPlacement(placementAsset.id, context.floorPoint.x, context.floorPoint.y) : placementPreviewRef.current
      if (preview) onPlaceAsset(placementAsset.id, preview.x, preview.z)
      else onNotice('请将资产放置在三维场地内')
      return
    }
    const drawingGesture = drawingGestureRef.current
    if (drawingGesture && drawingGesture.pointerId === event.pointerId) {
      if (drawingMoveFrameRef.current !== null) {
        cancelAnimationFrame(drawingMoveFrameRef.current)
        drawingMoveFrameRef.current = null
      }
      const pending = pendingDrawingPointRef.current
      pendingDrawingPointRef.current = null
      if (pending) processDrawingGestureMove(pending)
      if (tool === 'cuboid' && drawingGesture.stage === 'footprint') {
        drawingGesture.footprintEnd = { ...drawingGesture.current }
        drawingGesture.stage = 'depth'
        drawingGesture.pointerId = -1
        drawingGesture.depthStartClientX = undefined
        drawingGesture.depthStartClientY = undefined
        drawingGesture.current = drawingGesture.start
        requestShapePreview(drawingGesture)
        setViewportInteraction(false)
        onNotice('长方体底面已确定 · 再拖动确定厚度')
        return
      }
      if (tool !== 'brush' && tool !== 'erase') {
        const finalGesture = drawingGesture
        const operation = finalGesture.operation ?? drawOperation
        const revision = ++toolPreviewRevisionRef.current
        void computeShapeVoxels(finalGesture).then((preview) => {
          if (revision !== toolPreviewRevisionRef.current) return
          commitDrawingPreview(preview, operation)
          // Keep the shape gesture and its voxel transaction alive until the
          // Worker result has been committed. Ending the interaction before
          // this promise resolves used to split one shape into two updates:
          // the stroke transaction closed first and the shape was then applied
          // against a stale render snapshot. That was the source of the
          // intermittent line/cuboid "released but disappeared" behaviour.
          if (drawingGestureRef.current === finalGesture) {
            if (finalGesture.extrudeSessionId) voxelToolsWorkerRef.current?.disposeExtrudeSession(finalGesture.extrudeSessionId)
            drawingGestureRef.current = null
            latestToolPreviewVoxelsRef.current = []
            setToolPreviewVoxels([])
            setToolPreviewMesh(null)
            setViewportInteraction(false)
            if (controlsRef.current) controlsRef.current.enabled = true
          }
        })
        // Do not clear the gesture or re-enable controls here. The async
        // completion above owns the end of the shape transaction.
        return
      }
      drawingGestureRef.current = null
      latestToolPreviewVoxelsRef.current = []
      setToolPreviewVoxels([])
      setToolPreviewMesh(null)
      setViewportInteraction(false)
      if (controlsRef.current) controlsRef.current.enabled = true
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
      // The last pointermove is already the authoritative, collision- and
      // boundary-validated position. Re-projecting the release coordinate
      // here can switch planes or observe a different occupancy snapshot and
      // make the entity flash back before the commit is painted.
      commitDragGesture(selectGesture)
      setViewportInteraction(false)
      if (controlsRef.current) controlsRef.current.enabled = true
      return
    }
    const gesture = editGestureRef.current
    flushPendingEditMove({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY })
    editGestureRef.current = null
    if (!gesture || gesture.pointerId !== event.pointerId) return
    editStrokeVisitedRef.current.clear()
    setViewportInteraction(false)
    if (controlsRef.current) controlsRef.current.enabled = true
  }

  const handleEditPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isPreviewTouch(event)) {
      endPreviewTouch(event)
      return
    }
    if (placementAsset) return
    const drawingGesture = drawingGestureRef.current
    if (drawingGesture?.pointerId === event.pointerId || drawingGesture?.pointerId === -1) {
      if (drawingGesture.extrudeSessionId) voxelToolsWorkerRef.current?.disposeExtrudeSession(drawingGesture.extrudeSessionId)
      drawingGestureRef.current = null
      latestToolPreviewVoxelsRef.current = []
      toolPreviewRevisionRef.current += 1
      setToolPreviewVoxels([])
      setToolPreviewMesh(null)
    }
    cameraGestureRef.current = null
    boxSelectGestureRef.current = null
    setSceneSelectionBox(null)
    editGestureRef.current = null
    editStrokeVisitedRef.current.clear()
    if (selectGestureRef.current) resetDragVisuals(selectGestureRef.current)
    onCancelScenePartsMove()
    selectGestureRef.current = null
    setViewportInteraction(false)
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
        // Keep the last validated drag position. Pointer-up is only a commit
        // signal; it must not introduce a second projection/validation path.
        commitDragGesture(selectGesture)
        setViewportInteraction(false)
        if (controlsRef.current) controlsRef.current.enabled = true
        return
      }
      flushPendingEditMove({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY })
      editGestureRef.current = null
      editStrokeVisitedRef.current.clear()
      setViewportInteraction(false)
    }
    const cancelWindowPointer = () => {
      const drawingGesture = drawingGestureRef.current
      if (drawingGesture?.extrudeSessionId) voxelToolsWorkerRef.current?.disposeExtrudeSession(drawingGesture.extrudeSessionId)
      drawingGestureRef.current = null
      latestToolPreviewVoxelsRef.current = []
      toolPreviewRevisionRef.current += 1
      setToolPreviewVoxels([])
      setToolPreviewMesh(null)
      cameraGestureRef.current = null
      boxSelectGestureRef.current = null
      setSceneSelectionBox(null)
      if (editMoveFrameRef.current !== null) {
        cancelAnimationFrame(editMoveFrameRef.current)
        editMoveFrameRef.current = null
      }
      pendingEditPointRef.current = null
      editGestureRef.current = null
      editStrokeVisitedRef.current.clear()
      if (selectGestureRef.current) resetDragVisuals(selectGestureRef.current)
      onCancelScenePartsMove()
      selectGestureRef.current = null
      setViewportInteraction(false)
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
  }, [flushPendingEditMove, onNotice, onSelectMultiple, onCancelScenePartsMove])

  const handlePlacementDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (geometryApplying) return
    const assetId = placementAsset?.id ?? event.dataTransfer.getData('application/x-moce-asset')
    if (!assetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const context = getPointerContext(event)
    showPlacementPreview(context?.floorPoint ? onPreviewPlacement(assetId, context.floorPoint.x, context.floorPoint.y) : null)
  }

  const handlePlacementDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (geometryApplying) return
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

// The canvas scene is driven imperatively after mount. Stable event wrappers
// and the memoized tree child allow unrelated App updates (notices, library
// state, or other sidebar changes) to skip re-running the large viewport
// component body and its effect dependency checks.
const MemoizedVoxelViewport = React.memo(VoxelViewport)

const voxelRenderSignatureCache = new WeakMap<Voxel[], Map<string, { length: number; token: number }>>()
const voxelRenderOriginCache = new WeakMap<ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>, { x: number; y: number; z: number }>()
const pendingGeometryMeshCache = new Map<string, { mesh: VoxelGeometryMesh; voxelCount: number }>()
type GreedyRenderMeshPayload = Pick<VoxelGeometryMesh, 'positions' | 'normals' | 'ao' | 'materialIds' | 'indices' | 'outlinePositions'>
let nextVoxelRenderSignatureToken = 1

function voxelRenderSignature(component: Voxel[], componentColor?: string, forceCellRender = false): string {
  // A scene move changes only the component group's transform. The canonical
  // voxel array is shared by sceneEntityParts across transform-only project
  // commits, so cache the expensive content hash by array identity and color.
  // Voxel arrays are treated as immutable ProjectState data; edits publish a
  // new array and therefore naturally receive a new cache entry.
  const colorKey = `${componentColor ?? ''}|${forceCellRender ? 'cells' : 'auto'}`
  const cachedVariants = voxelRenderSignatureCache.get(component)
  const cached = cachedVariants?.get(colorKey)
  // Scene voxel arrays are immutable for replacement/paint operations. The
  // only intentional in-place mutation is append-only brush publishing, for
  // which the component length changes. Therefore array identity + length is
  // a complete invalidation key and avoids hashing hundreds of thousands of
  // coordinates on the main thread after geometry confirmation.
  if (cached && cached.length === component.length) return `${component.length}|${cached.token}`
  const token = nextVoxelRenderSignatureToken++
  const signature = `${component.length}|${token}`
  const variants = cachedVariants ?? new Map<string, { length: number; token: number }>()
  variants.set(colorKey, { length: component.length, token })
  if (!cachedVariants) voxelRenderSignatureCache.set(component, variants)
  return signature
}

function customComponentRenderOrigin(component: ReadonlyArray<Pick<Voxel, 'x' | 'y' | 'z'>>): { x: number; y: number; z: number } {
  if (!component.length) return { x: 0, y: 0, z: 0 }
  const cached = voxelRenderOriginCache.get(component)
  if (cached) return cached
  const origin = component.reduce((origin, voxel) => ({
    x: Math.min(origin.x, voxel.x),
    y: Math.min(origin.y, voxel.y),
    z: Math.min(origin.z, voxel.z),
  }), { x: component[0].x, y: component[0].y, z: component[0].z })
  voxelRenderOriginCache.set(component, origin)
  return origin
}

// Diagnostic baseline: keep every practical scene component on the ordinary
// per-voxel path while we measure whether the deferred large-entity renderer
// is still necessary. This is intentionally beyond any usable browser scene;
// it can be lowered again after the real interaction limit is established.
const CUSTOM_INSTANCE_RENDER_LIMIT = 1_000_000_000
const assetBaseComponentsCache = new WeakMap<VoxelAsset, Array<{ partId: string; voxels: Voxel[] }>>()
const assetGreedyCacheTokens = new WeakMap<VoxelAsset, number>()
const assetOverrideSignatureCache = new WeakMap<ReadonlyArray<VoxelOverride>, number>()
let nextAssetOverrideSignatureToken = 1

function addOnlyAssetOverrides(overrides: VoxelOverride[] | undefined): VoxelOverride[] | null {
  if (!overrides?.length || overrides.some((override) => (override.mode ?? 'add') !== 'add')) return null
  return overrides
}

function assetOverrideSignature(overrides: VoxelOverride[]): string {
  const cached = assetOverrideSignatureCache.get(overrides)
  if (cached !== undefined) return `@${cached}`
  // Brush edits replace the override array when its contents change. Use its
  // identity as the overlay invalidation key instead of serializing the full
  // imported-model delta on every animation frame.
  const token = nextAssetOverrideSignatureToken++
  assetOverrideSignatureCache.set(overrides, token)
  return `@${token}`
}
let nextAssetGreedyCacheToken = 1

function assetGreedyCacheToken(asset: VoxelAsset): number {
  const cached = assetGreedyCacheTokens.get(asset)
  if (cached !== undefined) return cached
  const next = nextAssetGreedyCacheToken++
  assetGreedyCacheTokens.set(asset, next)
  return next
}

function scheduleInstancedVoxelMatrices(
  componentGroup: THREE.Group,
  batches: Array<{ mesh: THREE.InstancedMesh; voxels: Voxel[]; start?: number; end?: number }>,
  origin: { x: number; y: number; z: number },
  resolveColor?: (voxel: Voxel, target: THREE.Color) => void,
): void {
  let batchIndex = 0
  let voxelIndex = batches[0]?.start ?? 0
  let frameId: number | null = null
  let cancelled = false
  const matrix = new THREE.Matrix4()
  const color = new THREE.Color()
  const fillFrame = () => {
    frameId = null
    if (cancelled) return
    // Keep each frame bounded. A large enlarged entity can contain hundreds
    // of thousands of unit cells; spreading matrix writes over frames keeps
    // confirmation responsive while preserving the exact unit-cell render.
    let budget = 1200
    while (budget > 0 && batchIndex < batches.length) {
      const batch = batches[batchIndex]
      const start = batch.start ?? 0
      const end = batch.end ?? batch.voxels.length
      while (budget > 0 && voxelIndex < end) {
        const voxel = batch.voxels[voxelIndex]
        const meshIndex = voxelIndex - start
        matrix.makeTranslation(
          voxelCenterToWorld(voxel.x - origin.x),
          voxelCenterToWorld(voxel.z - origin.z),
          voxelCenterToWorld(voxel.y - origin.y),
        )
        batch.mesh.setMatrixAt(meshIndex, matrix)
        if (resolveColor) {
          resolveColor(voxel, color)
          batch.mesh.setColorAt(meshIndex, color)
        }
        voxelIndex += 1
        batch.mesh.count = meshIndex + 1
        budget -= 1
      }
      batch.mesh.instanceMatrix.needsUpdate = true
      if (resolveColor && batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true
      if (voxelIndex >= end) {
        batchIndex += 1
        voxelIndex = batches[batchIndex]?.start ?? 0
      }
    }
    if (batchIndex < batches.length) {
      frameId = requestAnimationFrame(fillFrame)
      return
    }
    // InstancedMesh caches its bounds after the first render. During the
    // progressive upload the instance count grows from zero, so allowing
    // Three.js to compute a bounding sphere in an intermediate frame would
    // permanently cache a sphere around only the first uploaded slice. A
    // later camera zoom/rotation could then frustum-cull the body while the
    // independent selection outline remained visible. Recompute bounds only
    // after every matrix has been written, then re-enable culling.
    batches.forEach(({ mesh }) => {
      mesh.computeBoundingBox()
      mesh.computeBoundingSphere()
      mesh.frustumCulled = true
    })
    delete componentGroup.userData.cancelCellBuild
    componentGroup.userData.cellBuildPending = false
    const onComplete = componentGroup.userData.onRenderBuildComplete as (() => void) | undefined
    onComplete?.()
  }
  const cancel = () => {
    cancelled = true
    if (frameId !== null) cancelAnimationFrame(frameId)
    frameId = null
  }
  componentGroup.userData.cancelCellBuild = cancel
  frameId = requestAnimationFrame(fillFrame)
}

function renderAssetVoxelColor(
  voxel: Voxel,
  asset: VoxelAsset,
  materialMap: Map<string, THREE.MeshStandardMaterial>,
  colorOverride?: string,
): THREE.Color {
  const paintedColor = voxel.paintMaterialId
    ? (materialMap.get(voxel.paintMaterialId)?.color.getStyle() ?? (voxel.paintMaterialId.startsWith('#') ? voxel.paintMaterialId : undefined))
    : undefined
  return new THREE.Color(
    paintedColor
    ?? colorOverride
    ?? asset.templateColor
    ?? (voxel.materialId === 'primary'
      ? asset.color
      : voxel.materialId === 'accent'
        ? asset.accent
        : materialMap.get(voxel.materialId)?.color.getStyle()
          ?? (voxel.materialId.startsWith('#') ? voxel.materialId : asset.color)),
  )
}

function customVoxelRenderColorKey(
  voxel: Voxel,
  materialMap: Map<string, THREE.MeshStandardMaterial>,
  componentColor?: string,
): string {
  // HSL/palette edits may be stored as a literal hex paint value rather than
  // a material id. Keep that value on the greedy path too; otherwise the
  // fallback material can disagree with the inspector/preview color.
  if (voxel.paintMaterialId?.startsWith('#')) return voxel.paintMaterialId
  const paintedMaterial = voxel.paintMaterialId ? materialMap.get(voxel.paintMaterialId) : undefined
  if (paintedMaterial) return `#${paintedMaterial.color.getHexString()}`
  if (componentColor) return componentColor
  if (voxel.materialId.startsWith('#')) return voxel.materialId
  return `#${(materialMap.get(voxel.materialId) ?? materialMap.get('terracotta')!).color.getHexString()}`
}

function buildCustomComponentGroup(component: Voxel[], entityId: string, materialMap: Map<string, THREE.MeshStandardMaterial>, componentColor?: string, forceCellRender = false) {
  const componentGroup = new THREE.Group()
  const componentScenePartId = `custom:${entityId}`
  const origin = customComponentRenderOrigin(component)
  const preserveVoxelCells = forceCellRender || component.some((voxel) => voxel.preserveVoxelCells)
  // Greedy mesh vertices are cell boundaries, so the component origin is the
  // lower corner of the minimum voxel. Instanced voxel centers add their own
  // half-cell offset below.
  componentGroup.position.set(voxelToWorld(origin.x), voxelToWorld(origin.z), voxelToWorld(origin.y))
  componentGroup.userData.renderOrigin = origin
  componentGroup.userData.scenePartId = componentScenePartId
  componentGroup.userData.greedyDisabled = preserveVoxelCells
  // Keep the complete component available to the selection-outline builder.
  // Color-batched InstancedMeshes only carry their own subset, but adjacency
  // must be tested against every voxel in the editable component.
  componentGroup.userData.customComponentVoxels = component
  if (component.some((voxel) => voxelShape(voxel) !== 'cube')) {
    // Variant cells and cubes must share one external-surface representation.
    // Keeping them as independent closed meshes creates coplanar mounting
    // faces, which show up as flicker/cracks and can become non-manifold on
    // export. The surface builder removes covered faces, welds compatible
    // vertices, and preserves hard normals and per-voxel colors.
    const surfaceMesh = createVoxelSurfaceRenderMesh(
      component,
      origin,
      (voxel) => customVoxelRenderColorKey(voxel, materialMap, componentColor),
      componentScenePartId,
    )
    surfaceMesh.userData.customComponentId = voxelComponentId(component)
    surfaceMesh.userData.customComponentVoxels = component
    componentGroup.add(surfaceMesh)
    componentGroup.userData.variantRendered = true
    componentGroup.userData.greedyDisabled = true
    return componentGroup
  }
  // Cell-preserving results (notably enlargement) never enter the greedy
  // worker path. Do not allocate and scan a second full voxel array for data
  // that this component will not use.
  if (!preserveVoxelCells) {
    const prebuiltGeometry = pendingGeometryMeshCache.get(entityId)
    if (prebuiltGeometry?.voxelCount === component.length) {
      // Geometry confirmation already produced this exact surface mesh in the
      // Worker. Hand it to the normal greedy-mesh attachment effect once,
      // rather than rebuilding the same large component after commit.
      componentGroup.userData.prebuiltGreedyMesh = prebuiltGeometry.mesh
      componentGroup.userData.prebuiltGreedyColors = prebuiltGeometry.mesh.materialKeys
      // The prebuilt branch used to return before recording canonical local
      // voxel coordinates. That left the selection pass without source cells,
      // so a shell entity could render correctly but lose its outline after
      // the preview mesh was attached.
      componentGroup.userData.greedyVoxels = component.map((voxel) => ({
        gx: voxel.x - origin.x,
        gy: voxel.z - origin.z,
        gz: voxel.y - origin.y,
        materialId: 0,
      }))
      componentGroup.userData.greedyColors = prebuiltGeometry.mesh.materialKeys
      componentGroup.userData.greedyDisabled = false
      pendingGeometryMeshCache.delete(entityId)
      return componentGroup
    }
    const greedyColorIds = new Map<string, number>()
    const greedyColors: string[] = ['#ffffff']
    const greedyVoxels = component.map((voxel) => {
      const material = voxel.paintMaterialId ? materialMap.get(voxel.paintMaterialId) : undefined
      const colorKey = voxel.paintMaterialId?.startsWith('#')
        ? voxel.paintMaterialId
        : material
        ? `#${material.color.getHexString()}`
        : componentColor
          ? componentColor
          : voxel.materialId.startsWith('#')
            ? voxel.materialId
            : `#${(materialMap.get(voxel.materialId) ?? materialMap.get('terracotta')!).color.getHexString()}`
      let materialId = greedyColorIds.get(colorKey)
      if (materialId === undefined) {
        materialId = greedyColors.length
        greedyColorIds.set(colorKey, materialId)
        greedyColors.push(colorKey)
      }
      return { gx: voxel.x - origin.x, gy: voxel.z - origin.z, gz: voxel.y - origin.y, materialId }
    })
    componentGroup.userData.greedyVoxels = greedyVoxels
    componentGroup.userData.greedyColors = greedyColors
  }
  // Large results go straight to the worker-backed greedy mesh. Building one
  // Matrix4 and one InstancedMesh entry per voxel here would block the main
  // thread again immediately after the fast geometry commit.
  // Geometry enlargement deliberately produces more unit cells, not larger
  // cells. Keep those results on the exact InstancedMesh path even when they
  // cross the normal greedy-mesh threshold; otherwise the worker replaces the
  // small cubes with merged coplanar faces and the model appears block-scaled.
  if (component.length > CUSTOM_INSTANCE_RENDER_LIMIT && !preserveVoxelCells) {
    // The worker will attach the merged surface asynchronously. Mark this
    // group explicitly so the scene effect can keep the previous complete
    // group visible until that surface has finished building.
    componentGroup.userData.greedyBuildPending = true
    return componentGroup
  }

  const deferCellBuild = preserveVoxelCells && component.length > CUSTOM_INSTANCE_RENDER_LIMIT
  if (deferCellBuild) {
    // Enlarged geometry must remain a collection of unit cells. Previously we
    // still synchronously walked the entire enlarged component here to group
    // every voxel by color before scheduling the matrix writes. That made the
    // geometry confirmation hitch scale with the final voxel count even though
    // the expensive matrix upload was already deferred. Keep the exact unit
    // cell representation, but split GPU instance buffers into bounded chunks
    // so one large allocation cannot monopolize the main thread or create a
    // single oversized buffer update after confirmation.
    const cellBatches: Array<{ mesh: THREE.InstancedMesh; voxels: Voxel[]; start: number; end: number }> = []
    // The entity id is already stable for this whole component. Re-sorting
    // hundreds of thousands of coordinates just to derive a debug id would
    // reintroduce a synchronous O(n log n) confirmation hitch.
    const componentId = entityId
    const cellChunkSize = 16_384
    // Resolve one real source color before the progressive upload starts.
    // The instance color buffer must never begin with zeroes: a large entity
    // can be rendered before its first animation-frame upload, and zero
    // instance colors multiply the material to black.
    const initialColorKey = customVoxelRenderColorKey(component[0], materialMap, componentColor)
    const initialColor = new THREE.Color(initialColorKey)
    for (let start = 0; start < component.length; start += cellChunkSize) {
      const end = Math.min(component.length, start + cellChunkSize)
      const meshMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.9, metalness: 0 })
      configureInstancedVoxelPreviewMaterial(meshMaterial)
      const mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, meshMaterial, end - start)
      mesh.count = 0
      // The large-cell path uploads matrices and colors over several animation
      // frames. Allocate the instance-color attribute before the first render
      // so the material program is compiled with USE_INSTANCING_COLOR from
      // the start. Initialize it to a real source color; an uninitialized
      // attribute otherwise presents as black or makes the result depend on
      // which frame first compiled the material.
      const initialColors = new Float32Array((end - start) * 3)
      for (let index = 0; index < end - start; index += 1) {
        initialColors[index * 3] = initialColor.r
        initialColors[index * 3 + 1] = initialColor.g
        initialColors[index * 3 + 2] = initialColor.b
      }
      mesh.instanceColor = new THREE.InstancedBufferAttribute(initialColors, 3)
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor.needsUpdate = true
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // Bounds are invalid until the final instance is uploaded. Keep the
      // batch visible during progressive construction and let the completion
      // callback compute a correct sphere before restoring frustum culling.
      mesh.frustumCulled = false
      mesh.userData.customVoxels = component
      mesh.userData.customVoxelStart = start
      mesh.userData.customVoxelEnd = end
      mesh.userData.customComponentId = componentId
      mesh.userData.scenePartId = componentScenePartId
      mesh.userData.outerVoxel = true
      mesh.userData.baseRenderColor = 0xffffff
      mesh.userData.instancedVoxelColors = true
      componentGroup.add(mesh)
      cellBatches.push({ mesh, voxels: component, start, end })
    }

    const colorCache = new Map<string, THREE.Color>()
    const resolveColor = (voxel: Voxel, target: THREE.Color) => {
      const key = customVoxelRenderColorKey(voxel, materialMap, componentColor)
      const cached = colorCache.get(key)
      if (cached) {
        target.copy(cached)
        return
      }
      const next = new THREE.Color(key)
      colorCache.set(key, next)
      target.copy(next)
    }
    scheduleInstancedVoxelMatrices(componentGroup, cellBatches, origin, resolveColor)
    componentGroup.userData.cellBuildPending = true
    return componentGroup
  }

  const occupied = new Set(component.map((candidate) => `${candidate.x},${candidate.y},${candidate.z}`))
  const batches = new Map<string, { color: THREE.Color; voxels: Voxel[] }>()
  const batchColors = new Map<string, THREE.Color>()
  const stringColorKeys = new Map<string, string>()
  component.forEach((voxel) => {
    const material = voxel.paintMaterialId ? materialMap.get(voxel.paintMaterialId) : undefined
    const sourceColor = voxel.paintMaterialId?.startsWith('#')
      ? voxel.paintMaterialId
      : material?.color
      ?? (componentColor ? componentColor : voxel.materialId.startsWith('#') ? voxel.materialId : undefined)
      ?? (materialMap.get(voxel.materialId) ?? materialMap.get('terracotta')!).color
    const key = typeof sourceColor === 'string'
      ? stringColorKeys.get(sourceColor) ?? (() => {
        const next = new THREE.Color(sourceColor).getHexString()
        stringColorKeys.set(sourceColor, next)
        return next
      })()
      : sourceColor.getHexString()
    const color = batchColors.get(key) ?? (typeof sourceColor === 'string' ? new THREE.Color(sourceColor) : sourceColor.clone())
    batchColors.set(key, color)
    const batch = batches.get(key) ?? { color, voxels: [] }
    batch.voxels.push(voxel)
    batches.set(key, batch)
  })
  batches.forEach(({ color, voxels }) => {
    const meshMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 })
    const mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, meshMaterial, voxels.length)
    const matrix = new THREE.Matrix4()
    voxels.forEach((voxel, index) => {
      matrix.makeTranslation(voxelCenterToWorld(voxel.x - origin.x), voxelCenterToWorld(voxel.z - origin.z), voxelCenterToWorld(voxel.y - origin.y))
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
  return componentGroup
}

function updateAssetPartOffsets(group: THREE.Group, partOffsets: SceneInstance['partOffsets'], mirror: SceneInstance['mirror']): void {
  group.children.forEach((child) => {
    if (!(child instanceof THREE.Group) || typeof child.userData.instancePartId !== 'string') return
    const offset = partOffsets?.[child.userData.instancePartId as string] ?? { x: 0, y: 0, z: 0 }
    const base = child.userData.baseRenderOffset as { x: number; y: number; z: number } | undefined
    child.position.set(
      (base?.x ?? 0) + (mirror?.x ? -offset.x : offset.x),
      (base?.y ?? 0) + (mirror?.y ? -offset.z : offset.z),
      (base?.z ?? 0) + (mirror?.z ? -offset.y : offset.y),
    )
  })
}

function syncAssetPartOffsets(group: THREE.Group, partOffsets: SceneInstance['partOffsets'], mirror: SceneInstance['mirror']): void {
  // Root instance movement changes only group.position. Avoid traversing every
  // component group unless the child-offset or mirror object was replaced by
  // an actual partial transform operation.
  if (group.userData.partOffsetsRef === partOffsets && group.userData.mirrorRef === mirror) return
  updateAssetPartOffsets(group, partOffsets, mirror)
  group.userData.partOffsetsRef = partOffsets
  group.userData.mirrorRef = mirror
}

function buildAssetGroup(asset: VoxelAsset, materialMap: Map<string, THREE.MeshStandardMaterial>, overrides: VoxelOverride[] = [], partOffsets: SceneInstance['partOffsets'] = {}, rotation = 0, colorOverride?: string, mirror: SceneInstance['mirror'] = undefined, rotationX = 0, rotationY = 0, rotationZ = 0, allowGreedyMesh = false, greedyCacheKey?: string, rotationPivot: SceneInstance['rotationPivot'] = undefined) {
  const group = new THREE.Group()
  const scale = VOXEL_WORLD_SIZE
  const pivot = rotationPivot ?? { x: 0, y: 0, z: 0 }
  // Three.js uses X/Y/Z = project X/ground Z/vertical Y.
  const pivotWorld = { x: pivot.x, y: pivot.z, z: pivot.y }
  const resolvedComponents = overrides.length
    ? resolveInstanceComponents(asset, overrides)
    : assetBaseComponentsCache.get(asset) ?? (() => {
      const next = resolveInstanceComponents(asset, [])
      assetBaseComponentsCache.set(asset, next)
      return next
    })()
  group.rotation.set(rotationX * Math.PI / 180, rotationY * Math.PI / 180, -(rotation + rotationZ) * Math.PI / 180)
  if (!resolvedComponents.length) {
    const placeholder = new THREE.Mesh(new THREE.BoxGeometry(asset.width * scale, asset.depth * scale, asset.height * scale), new THREE.MeshStandardMaterial({ color: asset.color, roughness: 0.9, metalness: 0 }))
    placeholder.position.set(-pivotWorld.x, -pivotWorld.y, asset.height * scale / 2 - pivotWorld.z)
    placeholder.userData.instanceId = asset.id
    group.add(placeholder)
    return group
  }
  for (const { partId, voxels: component } of resolvedComponents) {
    const partGroup = new THREE.Group()
    const offset = partOffsets?.[partId] ?? { x: 0, y: 0, z: 0 }
    partGroup.position.set(mirror?.x ? -offset.x : offset.x, mirror?.y ? -offset.z : offset.z, mirror?.z ? -offset.y : offset.y)
    partGroup.userData.instancePartId = partId
    partGroup.userData.instanceVoxelPivot = pivotWorld
    const preserveVoxelCells = component.some((voxel) => voxel.preserveVoxelCells)
    if (component.some((voxel) => voxelShape(voxel) !== 'cube')) {
      const occupied = new Set(component.map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`))
      const occupiedVoxels = new Map(component.map((voxel) => [`${voxel.x},${voxel.y},${voxel.z}`, voxel] as const))
      const cubeBatches = new Map<string, { color: THREE.Color; voxels: Voxel[] }>()
      const variantBatches = new Map<string, { color: THREE.Color; voxel: Voxel; voxels: Voxel[]; includeMountingFace: boolean }>()
      component.forEach((voxel) => {
        const color = renderAssetVoxelColor(voxel, asset, materialMap, colorOverride)
        if (voxelShape(voxel) === 'cube') {
          const key = color.getHexString()
          const batch = cubeBatches.get(key) ?? { color, voxels: [] }
          batch.voxels.push(voxel)
          cubeBatches.set(key, batch)
          return
        }
        const includeMountingFace = !variantMountingFaceCovered(voxel, occupiedVoxels)
        const key = `${variantKey(voxel)}:${color.getHexString()}:${includeMountingFace ? 'closed' : 'open'}`
        const batch = variantBatches.get(key) ?? { color, voxel, voxels: [], includeMountingFace }
        batch.voxels.push(voxel)
        variantBatches.set(key, batch)
      })
      const matrix = new THREE.Matrix4()
      const setLocalMatrix = (cell: Voxel, target: THREE.Matrix4) => {
        const localXIndex = mirror?.x ? asset.width - 1 - cell.x : cell.x
        const localYIndex = mirror?.z ? asset.height - 1 - cell.y : cell.y
        const localZIndex = mirror?.y ? asset.depth - 1 - cell.z : cell.z
        target.makeTranslation(
          localXIndex * scale - (asset.width / 2) * scale - pivotWorld.x,
          localZIndex * scale - (asset.depth / 2) * scale - pivotWorld.y,
          localYIndex * scale - pivotWorld.z,
        )
      }
      cubeBatches.forEach(({ color, voxels }) => {
        const mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 }), voxels.length)
        voxels.forEach((cell, index) => {
          setLocalMatrix(cell, matrix)
          matrix.elements[12] += scale / 2
          matrix.elements[13] += scale / 2
          matrix.elements[14] += scale / 2
          mesh.setMatrixAt(index, matrix)
        })
        mesh.instanceMatrix.needsUpdate = true
        mesh.userData.instanceVoxels = voxels.map((voxel) => ({ ...voxel }))
        mesh.userData.instancePartId = partId
        mesh.userData.outerVoxel = voxels.some((voxel) => exposedVoxelFaces(voxel, occupied).length > 0)
        partGroup.add(mesh)
      })
      variantBatches.forEach(({ color, voxel, voxels, includeMountingFace }) => {
        const mesh = new THREE.InstancedMesh(sharedVariantThreeGeometry(voxel, includeMountingFace), new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 }), voxels.length)
        voxels.forEach((cell, index) => {
          setLocalMatrix(cell, matrix)
          mesh.setMatrixAt(index, matrix)
        })
        mesh.instanceMatrix.needsUpdate = true
        mesh.userData.instanceVoxels = voxels.map((item) => ({ ...item }))
        mesh.userData.instancePartId = partId
        mesh.userData.outerVoxel = true
        partGroup.add(mesh)
      })
      partGroup.userData.instanceVoxelOccupancy = occupied
      partGroup.userData.instanceVoxelAll = component.map((voxel) => ({ ...voxel }))
      partGroup.userData.instanceVoxelDimensions = { width: asset.width, depth: asset.depth, height: asset.height }
      partGroup.userData.instanceVoxelMirror = mirror
      group.add(partGroup)
      continue
    }
    if (allowGreedyMesh && component.length > CUSTOM_INSTANCE_RENDER_LIMIT && !preserveVoxelCells) {
      const greedyColorIds = new Map<string, number>()
      const greedyColors: string[] = ['#ffffff']
      const greedyVoxels = component.map((voxel) => {
        const localXIndex = mirror?.x ? asset.width - 1 - voxel.x : voxel.x
        const localYIndex = mirror?.z ? asset.height - 1 - voxel.y : voxel.y
        const localZIndex = mirror?.y ? asset.depth - 1 - voxel.z : voxel.z
        const colorKey = `#${renderAssetVoxelColor(voxel, asset, materialMap, colorOverride).getHexString()}`
        let materialId = greedyColorIds.get(colorKey)
        if (materialId === undefined) {
          materialId = greedyColors.length
          greedyColorIds.set(colorKey, materialId)
          greedyColors.push(colorKey)
        }
        return { gx: localXIndex, gy: localZIndex, gz: localYIndex, materialId }
      })
      // The worker returns vertices at cell boundaries. Offset the part to the
      // same local origin used by the old per-cell matrices, so the physical
      // voxel size and the asset's centered X/Y placement remain unchanged.
      partGroup.position.set(
        (mirror?.x ? -offset.x : offset.x) - (asset.width / 2) * scale - pivotWorld.x,
        (mirror?.y ? -offset.z : offset.z) - (asset.depth / 2) * scale - pivotWorld.y,
        (mirror?.z ? -offset.y : offset.y) - pivotWorld.z,
      )
      partGroup.userData.greedyVoxels = greedyVoxels
      partGroup.userData.greedyColors = greedyColors
      partGroup.userData.greedyMeshCacheKey = greedyCacheKey ? `${greedyCacheKey}:${partId}` : undefined
      partGroup.userData.greedyDisabled = false
      partGroup.userData.baseRenderOffset = {
        x: -(asset.width / 2) * scale - pivotWorld.x,
        y: -(asset.depth / 2) * scale - pivotWorld.y,
        z: -pivotWorld.z,
      }
      group.add(partGroup)
      continue
    }
    const occupied = new Set(component.map((candidate) => `${candidate.x},${candidate.y},${candidate.z}`))
    partGroup.userData.instanceVoxelOccupancy = occupied
    partGroup.userData.instanceVoxelAll = component.map((voxel) => ({ ...voxel }))
    partGroup.userData.instanceVoxelDimensions = { width: asset.width, depth: asset.depth, height: asset.height }
    partGroup.userData.instanceVoxelMirror = mirror
    const batches = new Map<string, { color: THREE.Color; voxels: Voxel[] }>()
    component.forEach((voxel) => {
      const color = renderAssetVoxelColor(voxel, asset, materialMap, colorOverride)
      const key = color.getHexString()
      const batch = batches.get(key) ?? { color, voxels: [] }
      batch.voxels.push(voxel)
      batches.set(key, batch)
    })
    batches.forEach(({ color, voxels }) => {
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 })
      const mesh = new THREE.InstancedMesh(sharedVoxelBoxGeometry, material, voxels.length)
      const matrix = new THREE.Matrix4()
      voxels.forEach((voxel, index) => {
        const localXIndex = mirror?.x ? asset.width - 1 - voxel.x : voxel.x
        const localYIndex = mirror?.z ? asset.height - 1 - voxel.y : voxel.y
        const localZIndex = mirror?.y ? asset.depth - 1 - voxel.z : voxel.z
        matrix.makeTranslation(
          (localXIndex + 0.5 - asset.width / 2) * scale - pivotWorld.x,
          (localZIndex + 0.5 - asset.depth / 2) * scale - pivotWorld.y,
          (localYIndex + 0.5) * scale - pivotWorld.z,
        )
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

function syncAssetAdditionsOverlay(
  instanceGroup: THREE.Group,
  asset: VoxelAsset,
  materialMap: Map<string, THREE.MeshStandardMaterial>,
  additions: VoxelOverride[],
  partOffsets: SceneInstance['partOffsets'],
  rotation: number,
  colorOverride: string | undefined,
  mirror: SceneInstance['mirror'],
  rotationX: number | undefined,
  rotationY: number | undefined,
  rotationZ: number | undefined,
  rotationPivot: SceneInstance['rotationPivot'],
): void {
  const existing = instanceGroup.children.find((child) => child.name === 'asset-edit-additions')
  if (!additions.length) {
    if (existing) {
      instanceGroup.remove(existing)
      disposeThreeObject(existing)
    }
    instanceGroup.userData.assetAdditionsSignature = ''
    return
  }
  const signature = assetOverrideSignature(additions)
  if (existing && instanceGroup.userData.assetAdditionsSignature === signature) return
  if (existing) {
    instanceGroup.remove(existing)
    disposeThreeObject(existing)
  }
  const partId = asset.parts[0] ?? '导入模型'
  // Use the normal asset renderer for the small delta, but provide a
  // synthetic asset containing only the newly added cells. It deliberately
  // keeps the original dimensions and transform rules, so mirror, rotation,
  // pivot and part offsets match the unchanged base mesh exactly.
  const overlayAsset: VoxelAsset = {
    ...asset,
    id: `${asset.id}:edit-additions`,
    source: 'moce-edit-additions',
    parts: [partId],
    partVoxels: undefined,
    assembly: undefined,
    voxels: additions.map((voxel) => ({ ...voxel, mode: undefined })),
  }
  const overlay = buildAssetGroup(overlayAsset, materialMap, [], partOffsets, rotation, colorOverride, mirror, rotationX, rotationY, rotationZ, false, undefined, rotationPivot)
  overlay.name = 'asset-edit-additions'
  overlay.userData.assetEditOverlay = true
  overlay.userData.assetAdditionsSignature = signature
  instanceGroup.add(overlay)
  instanceGroup.userData.assetAdditionsSignature = signature
}

const rootElement = document.getElementById('root')!
const globalWithRoot = globalThis as typeof globalThis & { __moceRoot?: ReturnType<typeof createRoot> }
const appRoot = globalWithRoot.__moceRoot ?? createRoot(rootElement)
globalWithRoot.__moceRoot = appRoot
appRoot.render(<React.StrictMode><App /></React.StrictMode>)
