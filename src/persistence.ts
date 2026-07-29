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

export function saveScene(sceneId: string, project: ProjectState): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/scenes/${encodeURIComponent(sceneId)}`, { method: 'PUT', body: JSON.stringify(project) })
}

export function loadAsset(assetId: string): Promise<VoxelAsset> {
  return request<VoxelAsset>(`/api/assets/${encodeURIComponent(assetId)}`)
}

export function saveAsset(asset: VoxelAsset): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/assets/${encodeURIComponent(asset.id)}`, { method: 'PUT', body: JSON.stringify(asset) })
}
