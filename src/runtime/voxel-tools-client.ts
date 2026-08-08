import type { DrawingPlane, DrawOperation, PlanePoint, VoxelAxis } from '../voxel-tools'
import type { Voxel } from '../voxel'
import { computeScale, computeShell, GeometryScaleMode, GeometryVoxel, VoxelGeometryMesh, VoxelGeometryPreview } from '../voxel-geometry'

export type VoxelToolsShapeRequest = {
  kind: 'line' | 'cuboid' | 'sphere' | 'extrude'
  plane: DrawingPlane
  start: PlanePoint
  current: PlanePoint
  footprintEnd?: PlanePoint
  baseHeight: number
  brushSize: number
  materialId: string
  operation?: DrawOperation
  source?: Voxel[]
  /**
   * Extrusion keeps its source slice in the worker for the duration of one
   * pointer gesture.  Subsequent samples only send this id and the new delta,
   * instead of structured-cloning the whole source slice again.
   */
  extrudeSessionId?: string
  extrudeAxis?: VoxelAxis
  extrudeStartLayer?: number
  extrudeDelta?: number
  /** Preview requests may return only a compact surface mesh. */
  includeVoxels?: boolean
}

export type VoxelToolsGeometryRequest =
  | { kind: 'shell'; voxels: GeometryVoxel[]; thickness: number }
  | { kind: 'scale'; voxels: GeometryVoxel[]; mode: GeometryScaleMode; factor: number }

export type VoxelToolsShellOptionsRequest = { kind: 'shell-options'; voxels: GeometryVoxel[] }

export type VoxelToolsShapeResult = {
  voxels: Voxel[]
  mesh: VoxelGeometryMesh | null
}

type WorkerResponse = {
  id: number
  voxels?: Voxel[]
  geometry?: VoxelGeometryPreview
  mesh?: VoxelGeometryMesh | null
  shellThicknesses?: number[]
  error?: string
}

export type VoxelToolsGeometryResult = {
  geometry: VoxelGeometryPreview
  mesh: VoxelGeometryMesh | null
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class VoxelToolsWorkerClient {
  private readonly worker: Worker
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private latestInFlightId: number | null = null
  private latestQueued: { request: VoxelToolsShapeRequest; resolve: (result: VoxelToolsShapeResult) => void; reject: (error: Error) => void } | null = null
  private latestGeometryInFlightId: number | null = null
  private latestGeometryQueued: { request: VoxelToolsGeometryRequest; resolve: (result: VoxelToolsGeometryResult | null) => void; reject: (error: Error) => void } | null = null
  private latestShellOptionsInFlightId: number | null = null
  private latestShellOptionsQueued: { request: VoxelToolsShellOptionsRequest; resolve: (result: number[] | null) => void; reject: (error: Error) => void } | null = null
  private nextExtrudeSessionId = 1

  constructor() {
    this.worker = new Worker(new URL('../workers/voxel-tools.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      const request = this.pending.get(response.id)
      if (!request) return
      this.pending.delete(response.id)
      if (this.latestInFlightId === response.id) this.latestInFlightId = null
      if (this.latestGeometryInFlightId === response.id) this.latestGeometryInFlightId = null
      if (this.latestShellOptionsInFlightId === response.id) this.latestShellOptionsInFlightId = null
      if (response.error) request.reject(new Error(response.error))
      else if (response.geometry) request.resolve(response.geometry ? { geometry: response.geometry, mesh: response.mesh ?? null } : [])
      else if (response.shellThicknesses) request.resolve(response.shellThicknesses)
      else request.resolve({ voxels: response.voxels ?? [], mesh: response.mesh ?? null })
      this.flushLatest()
      this.flushLatestGeometry()
      this.flushLatestShellOptions()
    }
    this.worker.onerror = (event) => {
      const error = new Error(event.message || '体素工具 Worker 执行失败')
      this.pending.forEach(({ reject }) => reject(error))
      this.pending.clear()
      this.latestInFlightId = null
      this.latestQueued?.reject(error)
      this.latestQueued = null
      this.latestGeometryInFlightId = null
      this.latestGeometryQueued?.reject(error)
      this.latestGeometryQueued = null
      this.latestShellOptionsInFlightId = null
      this.latestShellOptionsQueued?.reject(error)
      this.latestShellOptionsQueued = null
    }
  }

  compute(request: VoxelToolsShapeRequest): Promise<Voxel[]> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve((value as VoxelToolsShapeResult).voxels), reject })
      this.worker.postMessage({ id, request })
    })
  }

  computeGeometry(request: VoxelToolsGeometryRequest): Promise<VoxelGeometryPreview> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve((value as VoxelToolsGeometryResult).geometry), reject })
      this.worker.postMessage({ id, request })
    })
  }

  /**
   * Geometry previews are also ephemeral. Keep only one queued request and
   * discard obsolete parameter changes instead of making the worker calculate
   * every intermediate enlargement factor selected by the user.
   */
  computeGeometryLatest(request: VoxelToolsGeometryRequest): Promise<VoxelToolsGeometryResult | null> {
    return new Promise((resolve, reject) => {
      this.latestGeometryQueued?.resolve(null)
      this.latestGeometryQueued = { request, resolve, reject }
      this.flushLatestGeometry()
    })
  }

  /**
   * Shell thickness availability performs cavity filling and repeated
   * morphology passes. Keep it off the React render path and only calculate
   * the newest selection, just like geometry previews.
   */
  computeShellThicknessesLatest(voxels: GeometryVoxel[]): Promise<number[] | null> {
    return new Promise((resolve, reject) => {
      this.latestShellOptionsQueued?.resolve(null)
      this.latestShellOptionsQueued = { request: { kind: 'shell-options', voxels }, resolve, reject }
      this.flushLatestShellOptions()
    })
  }

  /**
   * Shape previews are ephemeral. Keep at most one request waiting behind the
   * currently running calculation and replace that waiting request whenever a
   * newer pointer sample arrives. This prevents a long cuboid/sphere preview
   * from rendering a queue of obsolete intermediate shapes.
   */
  computeLatest(request: VoxelToolsShapeRequest): Promise<VoxelToolsShapeResult> {
    return new Promise((resolve, reject) => {
      this.latestQueued?.resolve({ voxels: [], mesh: null })
      this.latestQueued = { request, resolve, reject }
      this.flushLatest()
    })
  }

  /** Allocate a worker-side source id for one extrusion gesture. */
  createExtrudeSession(): string {
    return `extrude-${this.nextExtrudeSessionId++}`
  }

  /** Release a source slice once the gesture has been committed or cancelled. */
  disposeExtrudeSession(sessionId: string) {
    this.worker.postMessage({ type: 'dispose-extrude-source', sessionId })
  }

  private flushLatest() {
    if (this.latestInFlightId !== null || !this.latestQueued) return
    const queued = this.latestQueued
    this.latestQueued = null
    const id = this.nextId++
    this.latestInFlightId = id
    this.pending.set(id, { resolve: (value) => queued.resolve(value as VoxelToolsShapeResult), reject: queued.reject })
    this.worker.postMessage({ id, request: queued.request })
  }

  private flushLatestGeometry() {
    if (this.latestGeometryInFlightId !== null || !this.latestGeometryQueued) return
    const queued = this.latestGeometryQueued
    this.latestGeometryQueued = null
    const id = this.nextId++
    this.latestGeometryInFlightId = id
    this.pending.set(id, { resolve: (value) => queued.resolve(value as VoxelToolsGeometryResult), reject: queued.reject })
    this.worker.postMessage({ id, request: queued.request })
  }

  private flushLatestShellOptions() {
    if (this.latestShellOptionsInFlightId !== null || !this.latestShellOptionsQueued) return
    const queued = this.latestShellOptionsQueued
    this.latestShellOptionsQueued = null
    const id = this.nextId++
    this.latestShellOptionsInFlightId = id
    this.pending.set(id, { resolve: (value) => queued.resolve(value as number[]), reject: queued.reject })
    this.worker.postMessage({ id, request: queued.request })
  }

  dispose() {
    this.worker.terminate()
    const error = new Error('体素工具 Worker 已关闭')
    this.pending.forEach(({ reject }) => reject(error))
    this.pending.clear()
    this.latestInFlightId = null
    this.latestQueued?.reject(error)
    this.latestQueued = null
    this.latestGeometryInFlightId = null
    this.latestGeometryQueued?.reject(error)
    this.latestGeometryQueued = null
    this.latestShellOptionsInFlightId = null
    this.latestShellOptionsQueued?.reject(error)
    this.latestShellOptionsQueued = null
  }
}
