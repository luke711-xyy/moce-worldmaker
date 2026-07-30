import { MoceSceneFile } from './scene-file'
import { MoceAssetFile, MoceEntityFile } from './portable-files'
import { ProjectState, VoxelAsset } from './voxel'

export type LibraryAssetSummary = Pick<VoxelAsset, 'id' | 'name' | 'kind' | 'style' | 'width' | 'depth' | 'height'> & { voxelCount: number; updatedAt: string | null }

export type LibrarySceneSummary = {
  id: string
  name: string
  assetCount: number
  instanceCount: number
  customVoxelCount: number
  updatedAt: string
}

export type LibraryResponse = {
  assets: LibraryAssetSummary[]
  scenes: LibrarySceneSummary[]
  assetCategories: string[][]
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `请求失败 · ${response.status}`)
  }
  return response.json() as Promise<T>
}

export function loadLibrary(): Promise<LibraryResponse> {
  return request<LibraryResponse>('/api/library')
}

export function loadScene(sceneId: string): Promise<ProjectState> {
  return request<ProjectState>(`/api/scenes/${encodeURIComponent(sceneId)}`)
}

export function saveScene(sceneId: string, sceneFile: MoceSceneFile | ProjectState): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/scenes/${encodeURIComponent(sceneId)}`, { method: 'PUT', body: JSON.stringify(sceneFile) })
}

export function importScene(sceneFile: MoceSceneFile): Promise<{ ok: boolean; sceneId: string; scene: LibrarySceneSummary }> {
  return request<{ ok: boolean; sceneId: string; scene: LibrarySceneSummary }>('/api/scenes/import', { method: 'POST', body: JSON.stringify(sceneFile) })
}

export function duplicateScene(sceneId: string, name?: string): Promise<{ ok: boolean; sceneId: string; scene: LibrarySceneSummary }> {
  return request<{ ok: boolean; sceneId: string; scene: LibrarySceneSummary }>(`/api/scenes/${encodeURIComponent(sceneId)}/duplicate`, { method: 'POST', body: JSON.stringify(name ? { name } : {}) })
}

export function deleteScene(sceneId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/scenes/${encodeURIComponent(sceneId)}`, { method: 'DELETE' })
}

export function loadAsset(assetId: string): Promise<VoxelAsset> {
  return request<VoxelAsset>(`/api/assets/${encodeURIComponent(assetId)}`)
}

export function saveAsset(asset: VoxelAsset): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/assets/${encodeURIComponent(asset.id)}`, { method: 'PUT', body: JSON.stringify(asset) })
}

export function deleteAsset(assetId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' })
}

export function saveAssetCategories(categories: string[][]): Promise<{ ok: boolean; assetCategories: string[][] }> {
  return request<{ ok: boolean; assetCategories: string[][] }>('/api/asset-categories', { method: 'PUT', body: JSON.stringify({ categories }) })
}

export function importAssetFile(assetFile: MoceAssetFile): Promise<{ ok: boolean; assets: VoxelAsset[]; assetCategories: string[][] }> {
  return request<{ ok: boolean; assets: VoxelAsset[]; assetCategories: string[][] }>('/api/assets/import', { method: 'POST', body: JSON.stringify(assetFile) })
}

export function validateEntityFile(entityFile: MoceEntityFile): Promise<{ ok: boolean; entityCount: number; assemblyCount: number }> {
  return request<{ ok: boolean; entityCount: number; assemblyCount: number }>('/api/entities/validate', { method: 'POST', body: JSON.stringify(entityFile) })
}
