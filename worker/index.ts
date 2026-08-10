import { parseSceneFile } from '../src/scene-file'
import { parseAssetFile, parseEntityFile } from '../src/portable-files'

type JsonRecord = Record<string, unknown>

interface Env {
  DB?: D1Database
  BLOBS?: R2Bucket
  ASSETS?: Fetcher
  MOCE_AUTH_REQUIRED?: string
  DEPLOYMENT_ENV?: string
  ALLOWED_ORIGIN?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUDIENCE?: string
}

type StoredObjectKind = 'asset' | 'scene'

type StoredObject = {
  owner_id: string
  kind: StoredObjectKind
  id: string
  name: string
  blob_key: string
  summary_json: string
  updated_at: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const MAX_BODY_BYTES = 25 * 1024 * 1024
const MAX_TRANSFER_PART_BYTES = 8 * 1024 * 1024
const ASSET_CLOUD_QUOTA_BYTES = 100 * 1024 * 1024
const SCENE_CLOUD_QUOTA_BYTES = 300 * 1024 * 1024
const ACCOUNT_CLOUD_QUOTA_BYTES = 8 * 1024 * 1024 * 1024
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000
type AccessJwk = JsonWebKey & { kid?: string }
let accessJwksCache: { issuer: string; expiresAt: number; keys: AccessJwk[] } | null = null

function json(data: unknown, status = 200, request?: Request, env?: Env) {
  const headers = new Headers(JSON_HEADERS)
  const origin = env?.ALLOWED_ORIGIN ?? request?.headers.get('Origin')
  if (origin && origin !== 'null') {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-credentials', 'true')
  }
  return new Response(JSON.stringify(data), { status, headers })
}

function errorResponse(error: unknown, status = 500, request?: Request, env?: Env) {
  return json({ error: error instanceof Error ? error.message : '持久化服务失败' }, status, request, env)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function voxelKey(value: unknown): string {
  if (!isRecord(value)) return ''
  return `${String(value.x)},${String(value.y)},${String(value.z)}`
}

function connectedComponentCount(voxels: JsonRecord[]): number {
  const remaining = new Set(voxels.map(voxelKey))
  let count = 0
  while (remaining.size) {
    count += 1
    const first = remaining.values().next().value as string
    remaining.delete(first)
    const queue = [first.split(',').map(Number)]
    for (let index = 0; index < queue.length; index += 1) {
      const [x, y, z] = queue[index]
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nextKey = `${x + dx},${y + dy},${z + dz}`
        if (!remaining.has(nextKey)) continue
        remaining.delete(nextKey)
        queue.push(nextKey.split(',').map(Number))
      }
    }
  }
  return count
}

/** Count the same editable parts that the scene tree exposes. */
function sceneEntityCount(state: JsonRecord, sceneAssets: JsonRecord[]): number {
  const assetMap = new Map(sceneAssets.filter((asset) => typeof asset.id === 'string').map((asset) => [asset.id as string, asset]))
  const instances = Array.isArray(state.instances) ? state.instances : []
  const instanceCount = instances.reduce((total, instance) => {
    if (!isRecord(instance)) return total
    if (instance.visible === false) return total
    const asset = assetMap.get(typeof instance.assetId === 'string' ? instance.assetId : '')
    if (!asset || !Array.isArray(asset.voxels)) return total + 1
    const resolved = new Map<string, JsonRecord>()
    asset.voxels.filter(isRecord).forEach((voxel) => resolved.set(voxelKey(voxel), voxel))
    if (Array.isArray(instance.overrides)) {
      instance.overrides.filter(isRecord).forEach((override) => {
        const key = voxelKey(override)
        if (override.mode === 'remove') resolved.delete(key)
        else resolved.set(key, { x: override.x, y: override.y, z: override.z, materialId: override.materialId })
      })
    }
    const partVoxels = isRecord(asset.partVoxels) ? asset.partVoxels : undefined
    const isImportedModel = asset.kind === 'imported'
      && /\.(?:glb|gltf|obj|stl)$/i.test(String(asset.source ?? ''))
      && !asset.assembly
    if (isImportedModel || (asset.kind === 'imported' && !partVoxels && !asset.assembly)) return total + (resolved.size ? 1 : 0)
    if (!partVoxels || !Object.keys(partVoxels).length) return total + connectedComponentCount([...resolved.values()])
    const claimed = new Set<string>()
    let parts = 0
    Object.values(partVoxels).forEach((part) => {
      if (!Array.isArray(part)) return
      const present: JsonRecord[] = []
      part.filter(isRecord).forEach((voxel) => {
        const key = voxelKey(voxel)
        if (resolved.has(key)) present.push(resolved.get(key)!)
        claimed.add(key)
      })
      parts += connectedComponentCount(present)
    })
    const additions = [...resolved.values()].filter((voxel) => !claimed.has(voxelKey(voxel)))
    if (additions.length) parts += 1
    return total + (parts || (resolved.size ? 1 : 0))
  }, 0)
  const customVoxels = Array.isArray(state.customVoxels) ? state.customVoxels : []
  const customEntityIds = new Set(customVoxels.map((voxel, index) => isRecord(voxel) && typeof voxel.entityId === 'string'
    ? voxel.entityId
    : `legacy-${voxelKey(voxel)}-${index}`))
  return instanceCount + customEntityIds.size
}

function normalizeCategories(categories: unknown): string[][] {
  const paths = new Map<string, string[]>()
  for (const value of Array.isArray(categories) ? categories : []) {
    if (!Array.isArray(value)) continue
    const path = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    for (let index = 1; index <= path.length; index += 1) {
      const prefix = path.slice(0, index)
      paths.set(prefix.join('\u001f'), prefix)
    }
  }
  return [...paths.values()]
}

function sceneSummary(scene: JsonRecord, id: string, updatedAt: string) {
  const state = isRecord(scene.scene) ? scene.scene : scene
  const sceneAssets = Array.isArray(scene.sceneAssets) ? scene.sceneAssets : []
  const instances = Array.isArray(state.instances) ? state.instances : []
  const customVoxels = Array.isArray(state.customVoxels) ? state.customVoxels : []
  const assemblies = Array.isArray(state.assemblies) ? state.assemblies : []
  return {
    id,
    name: typeof state.name === 'string' ? state.name : '未命名场景',
    // /api/library reads summary_json from D1, while import/save responses
    // pass the complete scene file. Support both shapes; treating a summary
    // as a full scene was the reason every scene was displayed as 0 entities.
    assetCount: Array.isArray(scene.sceneAssets) ? sceneAssets.length : typeof scene.assetCount === 'number' ? scene.assetCount : 0,
    instanceCount: Array.isArray(state.instances) ? instances.length : typeof scene.instanceCount === 'number' ? scene.instanceCount : 0,
    customVoxelCount: Array.isArray(state.customVoxels) ? customVoxels.length : typeof scene.customVoxelCount === 'number' ? scene.customVoxelCount : 0,
    assemblyCount: Array.isArray(state.assemblies) ? assemblies.length : typeof scene.assemblyCount === 'number' ? scene.assemblyCount : 0,
    entityCount: Array.isArray(state.instances) || Array.isArray(state.customVoxels)
      ? sceneEntityCount(state, sceneAssets)
      : typeof scene.entityCount === 'number' ? scene.entityCount : (typeof scene.instanceCount === 'number' ? scene.instanceCount : 0) + (typeof scene.customVoxelCount === 'number' && scene.customVoxelCount > 0 ? 1 : 0),
    updatedAt,
  }
}

function assetSummary(asset: JsonRecord, updatedAt?: string) {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    style: asset.style,
    width: asset.width,
    depth: asset.depth,
    height: asset.height,
    voxelCount: Array.isArray(asset.voxels) ? asset.voxels.length : 0,
    updatedAt: updatedAt ?? asset.updatedAt ?? null,
  }
}

function ownerFromRequest(request: Request, env: Env): string {
  const accessEmail = request.headers.get('Cf-Access-Authenticated-User-Email')
    ?? request.headers.get('cf-access-authenticated-user-email')
  if (accessEmail?.trim()) return accessEmail.trim().toLowerCase()
  const localHost = ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname)
  const authRequired = env.MOCE_AUTH_REQUIRED === 'true' && !localHost
  if (authRequired) throw new Response('需要通过 Cloudflare Access 登录', { status: 401 })
  return localHost ? 'local-dev' : 'anonymous'
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4)
  const binary = atob(normalized)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeJwtPart(value: string): JsonRecord {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as JsonRecord
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer
}

async function verifyAccessJwt(request: Request, env: Env, expectedEmail: string): Promise<void> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  const issuer = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, '')
  const audience = env.ACCESS_AUDIENCE
  if (!token || !issuer || !audience) throw new Response('Cloudflare Access JWT 尚未配置完整', { status: 503 })
  const pieces = token.split('.')
  if (pieces.length !== 3) throw new Response('Cloudflare Access 登录凭证无效', { status: 401 })
  const header = decodeJwtPart(pieces[0])
  const payload = decodeJwtPart(pieces[1])
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Response('Cloudflare Access JWT 算法不受支持', { status: 401 })
  if (payload.iss !== issuer || payload.email !== expectedEmail || (typeof payload.exp === 'number' && payload.exp <= Math.floor(Date.now() / 1000))) throw new Response('Cloudflare Access 登录凭证已失效', { status: 401 })
  const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!tokenAudiences.includes(audience)) throw new Response('Cloudflare Access 应用不匹配', { status: 401 })

  let keys: AccessJwk[]
  if (accessJwksCache?.issuer === issuer && accessJwksCache.expiresAt > Date.now()) {
    keys = accessJwksCache.keys
  } else {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`)
    if (!response.ok) throw new Response('无法读取 Cloudflare Access 公钥', { status: 503 })
    const body = await response.json() as { keys?: AccessJwk[] }
    keys = body.keys ?? []
    accessJwksCache = { issuer, expiresAt: Date.now() + 10 * 60 * 1000, keys }
  }
  const jwk = keys.find((key) => key.kid === header.kid)
  if (!jwk) throw new Response('Cloudflare Access 公钥不存在', { status: 401 })
  const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, publicKey, arrayBuffer(decodeBase64Url(pieces[2])), arrayBuffer(new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`)))
  if (!valid) throw new Response('Cloudflare Access 登录凭证签名无效', { status: 401 })
}

async function authenticatedOwner(request: Request, env: Env): Promise<string> {
  const url = new URL(request.url)
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname)
  if (localHost && !request.headers.get('Cf-Access-Authenticated-User-Email')) return 'local-dev'
  const email = request.headers.get('Cf-Access-Authenticated-User-Email')?.trim().toLowerCase()
  const authRequired = env.MOCE_AUTH_REQUIRED === 'true' && !localHost
  if (authRequired) {
    if (!email) throw new Response('需要通过 Cloudflare Access 登录', { status: 401 })
    await verifyAccessJwt(request, env, email)
    return email
  }
  return email || ownerFromRequest(request, env)
}

async function readBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) throw new Error('请求体超过 25 MB')
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new Error('请求体超过 25 MB')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是有效 JSON')
  }
}

function requireBindings(env: Env): asserts env is Env & { DB: D1Database; BLOBS: R2Bucket } {
  if (!env.DB || !env.BLOBS) throw new Error('Cloudflare D1/R2 尚未配置，请先执行部署初始化')
}

function blobKey(owner: string, kind: StoredObjectKind, id: string) {
  return `${kind}/${encodeURIComponent(owner)}/${encodeURIComponent(id)}.json`
}

async function getJsonBlob<T>(env: Env & { BLOBS: R2Bucket }, key: string): Promise<T> {
  const object = await env.BLOBS.get(key)
  if (!object) throw new Error(`数据对象不存在：${key}`)
  return JSON.parse(await object.text()) as T
}

async function putJsonBlob(env: Env & { BLOBS: R2Bucket }, key: string, value: unknown) {
  await env.BLOBS.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  })
}

async function listObjects(env: Env & { DB: D1Database }, owner: string, kind: StoredObjectKind): Promise<StoredObject[]> {
  const result = await env.DB.prepare('SELECT owner_id, kind, id, name, blob_key, summary_json, updated_at FROM objects WHERE owner_id = ?1 AND kind = ?2 ORDER BY updated_at DESC')
    .bind(owner, kind).all<StoredObject>()
  return result.results ?? []
}

async function getObject(env: Env & { DB: D1Database }, owner: string, kind: StoredObjectKind, id: string) {
  return env.DB.prepare('SELECT owner_id, kind, id, name, blob_key, summary_json, updated_at FROM objects WHERE owner_id = ?1 AND kind = ?2 AND id = ?3')
    .bind(owner, kind, id).first<StoredObject>()
}

async function saveObject(env: Env & { DB: D1Database; BLOBS: R2Bucket }, owner: string, kind: StoredObjectKind, id: string, name: string, value: unknown, summary: unknown, updatedAt = new Date().toISOString()) {
  const key = blobKey(owner, kind, id)
  await putJsonBlob(env, key, value)
  await env.DB.prepare('INSERT INTO objects (owner_id, kind, id, name, blob_key, summary_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(owner_id, kind, id) DO UPDATE SET name = excluded.name, blob_key = excluded.blob_key, summary_json = excluded.summary_json, updated_at = excluded.updated_at')
    .bind(owner, kind, id, name, key, JSON.stringify(summary), updatedAt).run()
  return { key, updatedAt }
}

async function uniqueName(env: Env & { DB: D1Database }, owner: string, kind: StoredObjectKind, requested: unknown, excludedId?: string) {
  const base = String(requested ?? '').trim() || (kind === 'scene' ? '未命名场景' : '未命名实体')
  const rows = await env.DB.prepare('SELECT name FROM objects WHERE owner_id = ?1 AND kind = ?2 AND id != ?3').bind(owner, kind, excludedId ?? '').all<{ name: string }>()
  const names = new Set((rows.results ?? []).map((row) => row.name.trim()))
  if (!names.has(base)) return base
  let index = 1
  while (names.has(`${base} (${index})`)) index += 1
  return `${base} (${index})`
}

async function categoryPaths(env: Env & { DB: D1Database }, owner: string) {
  const rows = await env.DB.prepare('SELECT path_json FROM asset_categories WHERE owner_id = ?1 ORDER BY path_key').bind(owner).all<{ path_json: string }>()
  return (rows.results ?? []).flatMap((row) => {
    try { return [JSON.parse(row.path_json) as string[]] } catch { return [] }
  })
}

async function replaceCategories(env: Env & { DB: D1Database }, owner: string, categories: string[][]) {
  const normalized = normalizeCategories(categories)
  await env.DB.prepare('DELETE FROM asset_categories WHERE owner_id = ?1').bind(owner).run()
  if (normalized.length) {
    await env.DB.batch(normalized.map((path) => env.DB.prepare('INSERT INTO asset_categories (owner_id, path_key, path_json) VALUES (?1, ?2, ?3)')
      .bind(owner, path.join('\u001f'), JSON.stringify(path))))
  }
  return normalized
}

async function sceneFileFromPayload(payload: unknown) {
  return parseSceneFile(payload)
}

async function projectFromScene(env: Env & { DB: D1Database; BLOBS: R2Bucket }, owner: string, sceneFile: JsonRecord, previewOnly = false) {
  // Older records stored the complete ProjectState directly. Normalize both
  // shapes here so the scene library entity pane receives instances/assets
  // instead of an empty project when a legacy scene is selected.
  const portable = parseSceneFile(sceneFile) as unknown as JsonRecord
  const embeddedAssets = Array.isArray(portable.sceneAssets) ? structuredClone(portable.sceneAssets) as JsonRecord[] : []
  const embeddedIds = new Set(embeddedAssets.map((asset) => asset.id))
  const templateRows = previewOnly
    ? []
    : await listObjects(env, owner, 'asset')
  // A historical D1 migration can leave a summary row whose R2 blob is
  // missing. Such a template must not prevent embedded scene entities from
  // loading; skip only the unavailable template and keep the scene usable.
  const templateAssets = (await Promise.allSettled(templateRows
    .filter((row) => !embeddedIds.has(row.id))
    .map((row) => getJsonBlob<JsonRecord>(env, row.blob_key))))
    .flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  const scene = structuredClone(portable.scene) as JsonRecord
  return {
    ...scene,
    assets: [...embeddedAssets.map((asset) => ({ ...asset, isTemplate: false })), ...templateAssets.map((asset) => ({ ...asset, isTemplate: true }))],
  }
}

type CloudAssetRow = {
  owner_id: string
  asset_id: string
  name: string
  blob_hash: string
  size_bytes: number
  category_path_json: string
  updated_at: string
}

type CloudSceneRow = {
  owner_id: string
  scene_id: string
  name: string
  current_version_id: string
  updated_at: string
}

type CloudSceneVersionRow = {
  owner_id: string
  scene_id: string
  version_id: string
  name: string
  blob_hash: string
  size_bytes: number
  summary_json: string
  created_at: string
}

type CloudBlobRow = {
  blob_hash: string
  r2_key: string
  size_bytes: number
  ref_count: number
  created_at: string
}

type CloudTransferRow = {
  transfer_id: string
  owner_id: string
  direction: 'upload' | 'download'
  object_kind: 'asset' | 'scene'
  object_id: string
  version_id: string | null
  name: string
  blob_hash: string
  total_bytes: number
  total_parts: number
  completed_parts_json: string
  multipart_upload_id: string | null
  temp_key: string
  metadata_json: string
  status: string
  expires_at: string
  created_at: string
  updated_at: string
}

function bytesHash(value: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest('SHA-256', value).then((digest) => [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join(''))
}

function cloudBlobKey(hash: string) {
  return `cloud/blobs/${hash}.json`
}

function transferTempKey(owner: string, transferId: string) {
  return `cloud/transfers/${encodeURIComponent(owner)}/${transferId}`
}

async function cloudUsage(env: Env & { DB: D1Database }, owner: string) {
  const [asset, scene, account] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cloud_assets WHERE owner_id = ?1').bind(owner).first<{ bytes: number }>(),
    env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cloud_scene_versions WHERE owner_id = ?1').bind(owner).first<{ bytes: number }>(),
    env.DB.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cloud_blobs WHERE ref_count > 0').first<{ bytes: number }>(),
  ])
  const assetBytes = Number(asset?.bytes ?? 0)
  const sceneBytes = Number(scene?.bytes ?? 0)
  const accountBytes = Number(account?.bytes ?? 0)
  return {
    assetBytes,
    sceneBytes,
    totalBytes: assetBytes + sceneBytes,
    accountBytes,
    assetQuotaBytes: ASSET_CLOUD_QUOTA_BYTES,
    sceneQuotaBytes: SCENE_CLOUD_QUOTA_BYTES,
    accountQuotaBytes: ACCOUNT_CLOUD_QUOTA_BYTES,
    assetRemainingBytes: Math.max(0, ASSET_CLOUD_QUOTA_BYTES - assetBytes),
    sceneRemainingBytes: Math.max(0, SCENE_CLOUD_QUOTA_BYTES - sceneBytes),
    accountRemainingBytes: Math.max(0, ACCOUNT_CLOUD_QUOTA_BYTES - accountBytes),
  }
}

function quotaError(message: string) {
  return new Error(`云端配额不足 · ${message}`)
}

async function assertCloudQuota(env: Env & { DB: D1Database }, owner: string, kind: 'asset' | 'scene', incomingBytes: number, replacingBytes = 0) {
  const usage = await cloudUsage(env, owner)
  const next = kind === 'asset'
    ? usage.assetBytes - replacingBytes + incomingBytes
    : usage.sceneBytes - replacingBytes + incomingBytes
  const limit = kind === 'asset' ? ASSET_CLOUD_QUOTA_BYTES : SCENE_CLOUD_QUOTA_BYTES
  if (next > limit) throw quotaError(`${kind === 'asset' ? '资产库' : '场景库'}剩余空间不足`)
  const accountDelta = Math.max(0, incomingBytes - replacingBytes)
  if (usage.accountBytes + accountDelta > ACCOUNT_CLOUD_QUOTA_BYTES) throw quotaError('账户云端总空间已满')
  return { usage, next }
}

async function decrementBlobRef(env: Env & { DB: D1Database; BLOBS: R2Bucket }, hash: string) {
  const row = await env.DB.prepare('SELECT blob_hash, r2_key, ref_count FROM cloud_blobs WHERE blob_hash = ?1').bind(hash).first<CloudBlobRow>()
  if (!row) return
  const next = Number(row.ref_count) - 1
  if (next > 0) {
    await env.DB.prepare('UPDATE cloud_blobs SET ref_count = ?1 WHERE blob_hash = ?2').bind(next, hash).run()
    return
  }
  await env.DB.prepare('DELETE FROM cloud_blobs WHERE blob_hash = ?1').bind(hash).run()
  await env.BLOBS.delete(row.r2_key)
}

async function incrementBlobRef(env: Env & { DB: D1Database }, hash: string, sizeBytes: number, r2Key: string, now: string) {
  await env.DB.prepare('INSERT INTO cloud_blobs (blob_hash, r2_key, size_bytes, ref_count, created_at) VALUES (?1, ?2, ?3, 1, ?4) ON CONFLICT(blob_hash) DO UPDATE SET ref_count = cloud_blobs.ref_count + 1')
    .bind(hash, r2Key, sizeBytes, now).run()
}

async function cleanupExpiredTransfers(env: Env & { DB: D1Database; BLOBS: R2Bucket }, owner: string) {
  const rows = await env.DB.prepare('SELECT transfer_id, temp_key, multipart_upload_id FROM cloud_transfers WHERE owner_id = ?1 AND expires_at < ?2 AND status NOT IN (\'completed\', \'cancelled\')')
    .bind(owner, new Date().toISOString()).all<Pick<CloudTransferRow, 'transfer_id' | 'temp_key' | 'multipart_upload_id'>>()
  for (const row of rows.results ?? []) {
    if (row.multipart_upload_id) {
      try { await env.BLOBS.resumeMultipartUpload(row.temp_key, row.multipart_upload_id).abort() } catch { /* expired upload may already be gone */ }
    }
    await env.BLOBS.delete(row.temp_key)
    await env.DB.prepare('DELETE FROM cloud_transfers WHERE transfer_id = ?1 AND owner_id = ?2').bind(row.transfer_id, owner).run()
  }
}

function transferResponse(row: CloudTransferRow) {
  const rawParts = JSON.parse(row.completed_parts_json) as Array<number | { partNumber: number; etag: string }>
  return {
    transferId: row.transfer_id,
    direction: row.direction,
    objectKind: row.object_kind,
    objectId: row.object_id,
    versionId: row.version_id,
    name: row.name,
    blobHash: row.blob_hash,
    totalBytes: row.total_bytes,
    totalParts: row.total_parts,
    completedParts: rawParts.map((part) => typeof part === 'number' ? part : part.partNumber),
    status: row.status,
    expiresAt: row.expires_at,
  }
}

function transferParts(row: CloudTransferRow): Array<{ partNumber: number; etag: string }> {
  const raw = JSON.parse(row.completed_parts_json) as Array<number | { partNumber: number; etag: string }>
  return raw.flatMap((part) => typeof part === 'number' ? [] : [part])
}

function transferMetadata(row: CloudTransferRow): JsonRecord {
  try {
    const value = JSON.parse(row.metadata_json)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function cloudJsonResponse(data: unknown, status: number, request: Request, env: Env) {
  return json(data, status, request, env)
}

function transferConflict(kind: 'asset' | 'scene', existing: { id: string; name: string }, requestedName: string) {
  return {
    code: 'CLOUD_CONFLICT',
    objectKind: kind,
    requestedName,
    conflicts: [{ id: existing.id, name: existing.name, reason: existing.name === requestedName ? 'name' : 'id' }],
  }
}

async function findCloudTarget(env: Env & { DB: D1Database }, owner: string, kind: 'asset' | 'scene', id: string, name: string) {
  if (kind === 'asset') {
    const byId = await env.DB.prepare('SELECT asset_id AS id, name FROM cloud_assets WHERE owner_id = ?1 AND asset_id = ?2').bind(owner, id).first<{ id: string; name: string }>()
    if (byId) return byId
    return env.DB.prepare('SELECT asset_id AS id, name FROM cloud_assets WHERE owner_id = ?1 AND name = ?2').bind(owner, name).first<{ id: string; name: string }>()
  }
  const byId = await env.DB.prepare('SELECT scene_id AS id, name FROM cloud_scenes WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, id).first<{ id: string; name: string }>()
  if (byId) return byId
  return env.DB.prepare('SELECT scene_id AS id, name FROM cloud_scenes WHERE owner_id = ?1 AND name = ?2').bind(owner, name).first<{ id: string; name: string }>()
}

async function cloudAssetRows(env: Env & { DB: D1Database }, owner: string) {
  const result = await env.DB.prepare('SELECT owner_id, asset_id, name, blob_hash, size_bytes, category_path_json, updated_at FROM cloud_assets WHERE owner_id = ?1 ORDER BY updated_at DESC').bind(owner).all<CloudAssetRow>()
  return result.results ?? []
}

async function cloudSceneRows(env: Env & { DB: D1Database }, owner: string) {
  const result = await env.DB.prepare('SELECT owner_id, scene_id, name, current_version_id, updated_at FROM cloud_scenes WHERE owner_id = ?1 ORDER BY updated_at DESC').bind(owner).all<CloudSceneRow>()
  return result.results ?? []
}

async function completeCloudUpload(env: Env & { DB: D1Database; BLOBS: R2Bucket }, owner: string, row: CloudTransferRow) {
  if (row.direction !== 'upload') throw new Error('该传输不是上传会话')
  const existingBlob = await env.BLOBS.head(cloudBlobKey(row.blob_hash))
  if (!existingBlob) {
    const parts = transferParts(row).sort((left, right) => left.partNumber - right.partNumber)
    if (parts.length !== row.total_parts) throw new Error('上传分块尚未完成')
    if (!row.multipart_upload_id) throw new Error('上传会话缺少 R2 分块会话')
    const upload = env.BLOBS.resumeMultipartUpload(row.temp_key, row.multipart_upload_id)
    await upload.complete(parts)
    const temporary = await env.BLOBS.get(row.temp_key)
    if (!temporary) throw new Error('上传临时对象不存在')
    await env.BLOBS.put(cloudBlobKey(row.blob_hash), temporary.body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } })
    await env.BLOBS.delete(row.temp_key)
  }
  const metadata = transferMetadata(row)
  const now = new Date().toISOString()
  const objectId = row.object_id
  if (row.object_kind === 'asset') {
    const old = await env.DB.prepare('SELECT blob_hash FROM cloud_assets WHERE owner_id = ?1 AND asset_id = ?2').bind(owner, objectId).first<{ blob_hash: string }>()
    if (old?.blob_hash !== row.blob_hash) {
      if (old) await decrementBlobRef(env, old.blob_hash)
      await incrementBlobRef(env, row.blob_hash, row.total_bytes, cloudBlobKey(row.blob_hash), now)
    }
    await env.DB.prepare('INSERT INTO cloud_assets (owner_id, asset_id, name, blob_hash, size_bytes, category_path_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(owner_id, asset_id) DO UPDATE SET name = excluded.name, blob_hash = excluded.blob_hash, size_bytes = excluded.size_bytes, category_path_json = excluded.category_path_json, updated_at = excluded.updated_at')
      .bind(owner, objectId, row.name, row.blob_hash, row.total_bytes, JSON.stringify(Array.isArray(metadata.categoryPath) ? metadata.categoryPath : []), now).run()
  } else {
    const versionId = row.version_id ?? `scene-version-${crypto.randomUUID()}`
    await incrementBlobRef(env, row.blob_hash, row.total_bytes, cloudBlobKey(row.blob_hash), now)
    await env.DB.prepare('INSERT INTO cloud_scene_versions (owner_id, scene_id, version_id, name, blob_hash, size_bytes, summary_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(owner, objectId, versionId, row.name, row.blob_hash, row.total_bytes, JSON.stringify(isRecord(metadata.summary) ? metadata.summary : {}), now).run()
    await env.DB.prepare('INSERT INTO cloud_scenes (owner_id, scene_id, name, current_version_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(owner_id, scene_id) DO UPDATE SET name = excluded.name, current_version_id = excluded.current_version_id, updated_at = excluded.updated_at')
      .bind(owner, objectId, row.name, versionId, now).run()
  }
  await env.DB.prepare("UPDATE cloud_transfers SET status = 'completed', updated_at = ?1 WHERE transfer_id = ?2 AND owner_id = ?3")
    .bind(now, row.transfer_id, owner).run()
  return { ...transferResponse({ ...row, status: 'completed' }), objectId, versionId: row.version_id }
}

async function handleCloudApi(request: Request, env: Env & { DB: D1Database; BLOBS: R2Bucket }, owner: string): Promise<Response | null> {
  const url = new URL(request.url)
  const route = url.pathname.replace(/\/$/, '')
  await cleanupExpiredTransfers(env, owner)

  if (request.method === 'GET' && route === '/api/cloud/usage') {
    return cloudJsonResponse({ usage: await cloudUsage(env, owner) }, 200, request, env)
  }
  if (request.method === 'GET' && route === '/api/cloud/assets') {
    const rows = await cloudAssetRows(env, owner)
    return cloudJsonResponse({ assets: rows.map((row) => ({ id: row.asset_id, name: row.name, blobHash: row.blob_hash, sizeBytes: row.size_bytes, categoryPath: JSON.parse(row.category_path_json) as string[], updatedAt: row.updated_at, cloudOnly: true })) }, 200, request, env)
  }
  if (request.method === 'GET' && route === '/api/cloud/scenes') {
    const rows = await cloudSceneRows(env, owner)
    const scenes = await Promise.all(rows.map(async (row) => {
      const version = await env.DB.prepare('SELECT version_id, blob_hash, size_bytes, summary_json, created_at FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2 AND version_id = ?3').bind(owner, row.scene_id, row.current_version_id).first<CloudSceneVersionRow>()
      const history = await env.DB.prepare('SELECT COUNT(*) AS count FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, row.scene_id).first<{ count: number }>()
      let summary: JsonRecord = {}
      try { summary = version?.summary_json ? JSON.parse(version.summary_json) as JsonRecord : {} } catch { /* keep empty summary */ }
      return { id: row.scene_id, name: row.name, currentVersionId: row.current_version_id, blobHash: version?.blob_hash ?? null, sizeBytes: version?.size_bytes ?? 0, versionCount: Number(history?.count ?? 0), updatedAt: row.updated_at, ...summary, cloudOnly: true }
    }))
    return cloudJsonResponse({ scenes }, 200, request, env)
  }

  const versionsMatch = route.match(/^\/api\/cloud\/scenes\/([^/]+)\/versions$/)
  if (versionsMatch && request.method === 'GET') {
    const sceneId = decodeURIComponent(versionsMatch[1])
    const rows = await env.DB.prepare('SELECT version_id, name, blob_hash, size_bytes, summary_json, created_at FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2 ORDER BY created_at DESC').bind(owner, sceneId).all<CloudSceneVersionRow>()
    return cloudJsonResponse({ versions: (rows.results ?? []).map((row) => {
      let summary: JsonRecord = {}
      try { summary = JSON.parse(row.summary_json) as JsonRecord } catch { /* tolerate an old malformed summary */ }
      return { id: row.version_id, sceneId, name: row.name, blobHash: row.blob_hash, sizeBytes: row.size_bytes, createdAt: row.created_at, summary }
    }) }, 200, request, env)
  }

  if (request.method === 'POST' && route === '/api/cloud/transfers') {
    const payload = await readBody(request)
    if (!isRecord(payload)) return errorResponse(new Error('传输参数不完整'), 400, request, env)
    const direction = payload.direction
    const objectKind = payload.objectKind
    if ((direction !== 'upload' && direction !== 'download') || (objectKind !== 'asset' && objectKind !== 'scene')) return errorResponse(new Error('传输类型不受支持'), 400, request, env)
    const objectId = String(payload.objectId ?? '')
    const requestedName = String(payload.name ?? '').trim()
    const blobHash = String(payload.blobHash ?? '')
    const totalBytes = Number(payload.totalBytes ?? 0)
    const totalParts = Number(payload.totalParts ?? Math.ceil(totalBytes / MAX_TRANSFER_PART_BYTES))
    if (!objectId || !requestedName || !/^[a-f0-9]{64}$/.test(blobHash) || !Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(totalParts) || totalParts < 1 || totalParts !== Math.ceil(totalBytes / MAX_TRANSFER_PART_BYTES)) return errorResponse(new Error('传输参数不合法'), 400, request, env)
    if (direction === 'download') {
      let source: { id: string; name: string; blob_hash: string; size_bytes: number; version_id?: string } | null = null
      if (objectKind === 'asset') source = await env.DB.prepare('SELECT asset_id AS id, name, blob_hash, size_bytes FROM cloud_assets WHERE owner_id = ?1 AND asset_id = ?2').bind(owner, objectId).first()
      else {
        const scene = await env.DB.prepare('SELECT scene_id AS id, name, current_version_id FROM cloud_scenes WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, objectId).first<{ id: string; name: string; current_version_id: string }>()
        const versionId = String(payload.versionId ?? scene?.current_version_id ?? '')
        if (scene && versionId) {
          const version = await env.DB.prepare('SELECT blob_hash, size_bytes FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2 AND version_id = ?3').bind(owner, objectId, versionId).first<{ blob_hash: string; size_bytes: number }>()
          if (version) source = { id: scene.id, name: scene.name, blob_hash: version.blob_hash, size_bytes: version.size_bytes, version_id: versionId }
        }
      }
      if (!source) return errorResponse(new Error('云端对象不存在'), 404, request, env)
      const transferId = `transfer-${crypto.randomUUID()}`
      const now = new Date().toISOString()
      const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS).toISOString()
      const transfer: CloudTransferRow = { transfer_id: transferId, owner_id: owner, direction: 'download', object_kind: objectKind, object_id: source.id, version_id: source.version_id ?? null, name: source.name, blob_hash: source.blob_hash, total_bytes: source.size_bytes, total_parts: Math.ceil(source.size_bytes / MAX_TRANSFER_PART_BYTES), completed_parts_json: '[]', multipart_upload_id: null, temp_key: cloudBlobKey(source.blob_hash), metadata_json: '{}', status: 'transferring', expires_at: expiresAt, created_at: now, updated_at: now }
      await env.DB.prepare('INSERT INTO cloud_transfers (transfer_id, owner_id, direction, object_kind, object_id, version_id, name, blob_hash, total_bytes, total_parts, completed_parts_json, multipart_upload_id, temp_key, metadata_json, status, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)').bind(transfer.transfer_id, owner, transfer.direction, transfer.object_kind, transfer.object_id, transfer.version_id, transfer.name, transfer.blob_hash, transfer.total_bytes, transfer.total_parts, transfer.completed_parts_json, null, transfer.temp_key, transfer.metadata_json, transfer.status, transfer.expires_at, transfer.created_at, transfer.updated_at).run()
      return cloudJsonResponse({ transfer: transferResponse(transfer) }, 201, request, env)
    }
    const conflict = await findCloudTarget(env, owner, objectKind, objectId, requestedName)
    const conflictMode = payload.conflictMode === 'replace' || payload.conflictMode === 'copy' ? payload.conflictMode : null
    const conflictId = typeof payload.conflictId === 'string' ? payload.conflictId : undefined
    let finalId = objectId
    let finalName = requestedName
    if (conflict && !conflictMode) return cloudJsonResponse(transferConflict(objectKind, conflict, requestedName), 409, request, env)
    if (conflict && conflictMode === 'replace') finalId = conflictId || conflict.id
    if (conflict && conflictMode === 'copy') {
      finalId = `${objectKind}-cloud-${crypto.randomUUID()}`
      finalName = await cloudUniqueName(env, owner, objectKind, requestedName)
    }
    const replacingBytes = objectKind === 'asset' && conflict && conflictMode === 'replace'
      ? Number((await env.DB.prepare('SELECT size_bytes FROM cloud_assets WHERE owner_id = ?1 AND asset_id = ?2').bind(owner, finalId).first<{ size_bytes: number }>())?.size_bytes ?? 0)
      : 0
    await assertCloudQuota(env, owner, objectKind, totalBytes, replacingBytes)
    const transferId = `transfer-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + TRANSFER_TTL_MS).toISOString()
    const tempKey = transferTempKey(owner, transferId)
    const existingBlob = await env.BLOBS.head(cloudBlobKey(blobHash))
    let multipartUploadId: string | null = null
    const alreadyUploadedParts = existingBlob ? Array.from({ length: totalParts }, (_, index) => index + 1) : []
    if (!existingBlob) multipartUploadId = (await env.BLOBS.createMultipartUpload(tempKey, { httpMetadata: { contentType: 'application/json; charset=utf-8' } })).uploadId
    const versionId = objectKind === 'scene' ? `scene-version-${crypto.randomUUID()}` : null
    const metadata = isRecord(payload.metadata) ? payload.metadata : {}
    const transfer: CloudTransferRow = { transfer_id: transferId, owner_id: owner, direction: 'upload', object_kind: objectKind, object_id: finalId, version_id: versionId, name: finalName, blob_hash: blobHash, total_bytes: totalBytes, total_parts: totalParts, completed_parts_json: JSON.stringify(alreadyUploadedParts), multipart_upload_id: multipartUploadId, temp_key: tempKey, metadata_json: JSON.stringify(metadata), status: 'transferring', expires_at: expiresAt, created_at: now, updated_at: now }
    await env.DB.prepare('INSERT INTO cloud_transfers (transfer_id, owner_id, direction, object_kind, object_id, version_id, name, blob_hash, total_bytes, total_parts, completed_parts_json, multipart_upload_id, temp_key, metadata_json, status, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)').bind(transfer.transfer_id, owner, transfer.direction, transfer.object_kind, transfer.object_id, transfer.version_id, transfer.name, transfer.blob_hash, transfer.total_bytes, transfer.total_parts, transfer.completed_parts_json, transfer.multipart_upload_id, transfer.temp_key, transfer.metadata_json, transfer.status, transfer.expires_at, transfer.created_at, transfer.updated_at).run()
    return cloudJsonResponse({ transfer: transferResponse(transfer), effectiveId: finalId, effectiveName: finalName }, 201, request, env)
  }

  const transferPartMatch = route.match(/^\/api\/cloud\/transfers\/([^/]+)\/parts\/([0-9]+)$/)
  if (transferPartMatch) {
    const transferId = decodeURIComponent(transferPartMatch[1])
    const partNumber = Number(transferPartMatch[2])
    const row = await env.DB.prepare('SELECT * FROM cloud_transfers WHERE transfer_id = ?1 AND owner_id = ?2').bind(transferId, owner).first<CloudTransferRow>()
    if (!row) return errorResponse(new Error('传输会话不存在'), 404, request, env)
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > row.total_parts) return errorResponse(new Error('传输分块编号不合法'), 400, request, env)
    if (request.method === 'GET') {
      if (row.direction !== 'download') return errorResponse(new Error('该传输不是下载会话'), 400, request, env)
      const offset = (partNumber - 1) * MAX_TRANSFER_PART_BYTES
      const length = Math.min(MAX_TRANSFER_PART_BYTES, row.total_bytes - offset)
      const object = await env.BLOBS.get(row.temp_key, { range: { offset, length } })
      if (!object) return errorResponse(new Error('云端对象内容不存在'), 404, request, env)
      const headers = new Headers({ 'content-type': 'application/octet-stream', 'content-length': String(length), 'x-transfer-part': String(partNumber), 'content-range': `bytes ${offset}-${offset + length - 1}/${row.total_bytes}` })
      return new Response(object.body, { status: 200, headers })
    }
    if (request.method === 'PUT') {
      if (row.direction !== 'upload') return errorResponse(new Error('该传输不是上传会话'), 400, request, env)
      if (transferParts(row).some((part) => part.partNumber === partNumber)) return cloudJsonResponse({ transfer: transferResponse(row) }, 200, request, env)
      const value = await readTransferPart(request)
      const expectedSize = partNumber === row.total_parts ? row.total_bytes - (partNumber - 1) * MAX_TRANSFER_PART_BYTES : MAX_TRANSFER_PART_BYTES
      if (value.byteLength !== expectedSize) return errorResponse(new Error('上传分块大小不正确'), 400, request, env)
      const expectedHash = request.headers.get('x-part-sha256')
      if (expectedHash && expectedHash !== await bytesHash(value)) return errorResponse(new Error('上传分块校验失败'), 400, request, env)
      if (!row.multipart_upload_id) return errorResponse(new Error('该对象已存在或上传会话已失效'), 409, request, env)
      const upload = env.BLOBS.resumeMultipartUpload(row.temp_key, row.multipart_upload_id)
      const uploaded = await upload.uploadPart(partNumber, value)
      const parts = [...transferParts(row), { partNumber, etag: uploaded.etag }].sort((left, right) => left.partNumber - right.partNumber)
      const now = new Date().toISOString()
      await env.DB.prepare("UPDATE cloud_transfers SET completed_parts_json = ?1, status = 'transferring', updated_at = ?2 WHERE transfer_id = ?3 AND owner_id = ?4")
        .bind(JSON.stringify(parts), now, transferId, owner).run()
      return cloudJsonResponse({ transfer: transferResponse({ ...row, completed_parts_json: JSON.stringify(parts), status: 'transferring', updated_at: now }) }, 200, request, env)
    }
  }

  const transferActionMatch = route.match(/^\/api\/cloud\/transfers\/([^/]+)\/(resume|complete)$/)
  if (transferActionMatch && request.method === 'POST') {
    const transferId = decodeURIComponent(transferActionMatch[1])
    const row = await env.DB.prepare('SELECT * FROM cloud_transfers WHERE transfer_id = ?1 AND owner_id = ?2').bind(transferId, owner).first<CloudTransferRow>()
    if (!row) return errorResponse(new Error('传输会话不存在'), 404, request, env)
    if (transferActionMatch[2] === 'resume') return cloudJsonResponse({ transfer: transferResponse(row) }, 200, request, env)
    return cloudJsonResponse({ transfer: await completeCloudUpload(env, owner, row) }, 200, request, env)
  }
  const transferMatch = route.match(/^\/api\/cloud\/transfers\/([^/]+)$/)
  if (transferMatch) {
    const transferId = decodeURIComponent(transferMatch[1])
    const row = await env.DB.prepare('SELECT * FROM cloud_transfers WHERE transfer_id = ?1 AND owner_id = ?2').bind(transferId, owner).first<CloudTransferRow>()
    if (!row) return errorResponse(new Error('传输会话不存在'), 404, request, env)
    if (request.method === 'DELETE') {
      if (row.multipart_upload_id) {
        try { await env.BLOBS.resumeMultipartUpload(row.temp_key, row.multipart_upload_id).abort() } catch { /* idempotent cleanup */ }
      }
      await env.BLOBS.delete(row.temp_key)
      await env.DB.prepare('DELETE FROM cloud_transfers WHERE transfer_id = ?1 AND owner_id = ?2').bind(transferId, owner).run()
      return cloudJsonResponse({ ok: true }, 200, request, env)
    }
  }

  const cloudAssetMatch = route.match(/^\/api\/cloud\/assets\/([^/]+)$/)
  if (cloudAssetMatch && request.method === 'GET') {
    const id = decodeURIComponent(cloudAssetMatch[1])
    const row = await env.DB.prepare('SELECT blob_hash FROM cloud_assets WHERE owner_id = ?1 AND asset_id = ?2').bind(owner, id).first<{ blob_hash: string }>()
    if (!row) return errorResponse(new Error('云端实体不存在'), 404, request, env)
    const object = await env.BLOBS.get(cloudBlobKey(row.blob_hash))
    if (!object) return errorResponse(new Error('云端实体内容不存在'), 404, request, env)
    return new Response(object.body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
  }
  if (cloudAssetMatch && request.method === 'DELETE') {
    const id = decodeURIComponent(cloudAssetMatch[1])
    const row = await env.DB.prepare('SELECT blob_hash FROM cloud_assets WHERE owner_id = ?1 AND asset_id = ?2').bind(owner, id).first<{ blob_hash: string }>()
    if (!row) return errorResponse(new Error('云端实体不存在'), 404, request, env)
    await env.DB.prepare('DELETE FROM cloud_assets WHERE owner_id = ?1 AND asset_id = ?2').bind(owner, id).run()
    await decrementBlobRef(env, row.blob_hash)
    return cloudJsonResponse({ ok: true }, 200, request, env)
  }

  const cloudSceneVersionMatch = route.match(/^\/api\/cloud\/scenes\/([^/]+)\/versions\/([^/]+)$/)
  if (cloudSceneVersionMatch && request.method === 'GET') {
    const sceneId = decodeURIComponent(cloudSceneVersionMatch[1])
    const versionId = decodeURIComponent(cloudSceneVersionMatch[2])
    const version = await env.DB.prepare('SELECT blob_hash FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2 AND version_id = ?3').bind(owner, sceneId, versionId).first<{ blob_hash: string }>()
    if (!version) return errorResponse(new Error('云端场景版本不存在'), 404, request, env)
    const object = await env.BLOBS.get(cloudBlobKey(version.blob_hash))
    if (!object) return errorResponse(new Error('云端场景内容不存在'), 404, request, env)
    return new Response(object.body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
  }
  if (cloudSceneVersionMatch && request.method === 'DELETE') {
    const sceneId = decodeURIComponent(cloudSceneVersionMatch[1])
    const versionId = decodeURIComponent(cloudSceneVersionMatch[2])
    const version = await env.DB.prepare('SELECT blob_hash FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2 AND version_id = ?3').bind(owner, sceneId, versionId).first<{ blob_hash: string }>()
    if (!version) return errorResponse(new Error('云端场景版本不存在'), 404, request, env)
    await env.DB.prepare('DELETE FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2 AND version_id = ?3').bind(owner, sceneId, versionId).run()
    await decrementBlobRef(env, version.blob_hash)
    const current = await env.DB.prepare('SELECT current_version_id FROM cloud_scenes WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, sceneId).first<{ current_version_id: string }>()
    if (current?.current_version_id === versionId) {
      const next = await env.DB.prepare('SELECT version_id, name, created_at FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2 ORDER BY created_at DESC LIMIT 1').bind(owner, sceneId).first<{ version_id: string; name: string; created_at: string }>()
      if (next) await env.DB.prepare('UPDATE cloud_scenes SET current_version_id = ?1, name = ?2, updated_at = ?3 WHERE owner_id = ?4 AND scene_id = ?5').bind(next.version_id, next.name, next.created_at, owner, sceneId).run()
      else await env.DB.prepare('DELETE FROM cloud_scenes WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, sceneId).run()
    }
    return cloudJsonResponse({ ok: true }, 200, request, env)
  }

  const cloudSceneMatch = route.match(/^\/api\/cloud\/scenes\/([^/]+)$/)
  if (cloudSceneMatch && request.method === 'DELETE') {
    const sceneId = decodeURIComponent(cloudSceneMatch[1])
    const versions = await env.DB.prepare('SELECT blob_hash FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, sceneId).all<{ blob_hash: string }>()
    await env.DB.batch([env.DB.prepare('DELETE FROM cloud_scene_versions WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, sceneId), env.DB.prepare('DELETE FROM cloud_scenes WHERE owner_id = ?1 AND scene_id = ?2').bind(owner, sceneId)])
    for (const version of versions.results ?? []) await decrementBlobRef(env, version.blob_hash)
    return cloudJsonResponse({ ok: true }, 200, request, env)
  }
  return null
}

async function readTransferPart(request: Request): Promise<ArrayBuffer> {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_TRANSFER_PART_BYTES) throw new Error('传输分块超过 8 MB')
  const value = await request.arrayBuffer()
  if (value.byteLength > MAX_TRANSFER_PART_BYTES) throw new Error('传输分块超过 8 MB')
  return value
}

async function cloudUniqueName(env: Env & { DB: D1Database }, owner: string, kind: 'asset' | 'scene', requested: string, excludedId?: string) {
  const base = requested.trim() || (kind === 'asset' ? '未命名实体' : '未命名场景')
  const rows = kind === 'asset'
    ? await env.DB.prepare('SELECT name FROM cloud_assets WHERE owner_id = ?1 AND asset_id != ?2').bind(owner, excludedId ?? '').all<{ name: string }>()
    : await env.DB.prepare('SELECT name FROM cloud_scenes WHERE owner_id = ?1 AND scene_id != ?2').bind(owner, excludedId ?? '').all<{ name: string }>()
  const names = new Set((rows.results ?? []).map((row) => row.name.trim()))
  if (!names.has(base)) return base
  let index = 1
  while (names.has(`${base} (${index})`)) index += 1
  return `${base} (${index})`
}

function sceneFileFromProjectPayload(payload: unknown) {
  return parseSceneFile(payload)
}

async function handleApi(request: Request, env: Env, owner: string): Promise<Response> {
  requireBindings(env)
  const url = new URL(request.url)
  const route = url.pathname.replace(/\/$/, '')

  const cloudResponse = await handleCloudApi(request, env, owner)
  if (cloudResponse) return cloudResponse

  if (request.method === 'GET' && route === '/api/library') {
    const [assets, sceneRows, assetCategories] = await Promise.all([
      listObjects(env, owner, 'asset'),
      listObjects(env, owner, 'scene'),
      categoryPaths(env, owner),
    ])
    // The library endpoint is a list/summary endpoint.  Do not read every
    // complete scene blob from R2 here: a scene may contain hundreds of
    // thousands of voxels, and rebuilding its entity count on every library
    // open can exceed the Worker CPU limit.  The D1 row already contains the
    // summary produced when the scene was saved, so use that as the source of
    // truth and leave full scene loading to GET /api/scenes/:id.
    const scenes = sceneRows.map((row) => {
      try {
        return sceneSummary(JSON.parse(row.summary_json) as JsonRecord, row.id, row.updated_at)
      } catch {
        // A malformed summary must not make the whole library disappear.
        return sceneSummary({ name: row.name }, row.id, row.updated_at)
      }
    })
    return json({
      assets: assets.map((row) => assetSummary(JSON.parse(row.summary_json) as JsonRecord, row.updated_at)),
      scenes,
      assetCategories,
    }, 200, request, env)
  }

  if (request.method === 'PUT' && route === '/api/asset-categories') {
    const payload = await readBody(request)
    const categories = await replaceCategories(env, owner, isRecord(payload) ? payload.categories as string[][] : [])
    return json({ ok: true, assetCategories: categories }, 200, request, env)
  }

  if (request.method === 'POST' && route === '/api/assets/import') {
    const file = parseAssetFile(await readBody(request))
    const existing = new Set((await listObjects(env, owner, 'asset')).map((row) => row.id))
    const storedAssets: JsonRecord[] = []
    for (const asset of file.assets) {
      let id = asset.id
      let suffix = 1
      while (existing.has(id)) id = `${asset.id}-import-${suffix++}`
      existing.add(id)
      const name = await uniqueName(env, owner, 'asset', asset.name)
      const stored = { ...structuredClone(asset), id, name, isTemplate: true, updatedAt: new Date().toISOString() } as unknown as JsonRecord
      await saveObject(env, owner, 'asset', id, name, stored, assetSummary(stored, stored.updatedAt as string))
      storedAssets.push(stored)
    }
    const categories = await replaceCategories(env, owner, [...await categoryPaths(env, owner), ...file.categories, ...storedAssets.map((asset) => asset.categoryPath as string[] ?? [])])
    return json({ ok: true, assets: storedAssets, assetCategories: categories }, 201, request, env)
  }

  if (request.method === 'POST' && route === '/api/entities/validate') {
    const file = parseEntityFile(await readBody(request))
    return json({ ok: true, entityCount: file.entities.length, assemblyCount: file.assemblies.length }, 200, request, env)
  }

  if (request.method === 'POST' && route === '/api/scenes/import') {
    const file = await sceneFileFromPayload(await readBody(request))
    const id = `scene-${crypto.randomUUID()}`
    file.scene.name = await uniqueName(env, owner, 'scene', file.scene.name)
    const updatedAt = new Date().toISOString()
    await saveObject(env, owner, 'scene', id, file.scene.name, file, sceneSummary(file, id, updatedAt), updatedAt)
    return json({ ok: true, sceneId: id, scene: sceneSummary(file, id, updatedAt) }, 201, request, env)
  }

  const sceneMatch = route.match(/^\/api\/scenes\/([^/]+)$/)
  if (sceneMatch) {
    const id = decodeURIComponent(sceneMatch[1])
    const row = await getObject(env, owner, 'scene', id)
    if (request.method === 'GET') {
      if (!row) return errorResponse(new Error('场景不存在'), 404, request, env)
      return json(await projectFromScene(env, owner, await getJsonBlob<JsonRecord>(env, row.blob_key), url.searchParams.get('preview') === '1'), 200, request, env)
    }
    if (request.method === 'DELETE') {
      if (!row) return errorResponse(new Error('场景不存在'), 404, request, env)
      await env.DB.prepare('DELETE FROM objects WHERE owner_id = ?1 AND kind = ?2 AND id = ?3').bind(owner, 'scene', id).run()
      await env.BLOBS.delete(row.blob_key)
      return json({ ok: true }, 200, request, env)
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      const file = sceneFileFromProjectPayload(await readBody(request))
      const updatedAt = new Date().toISOString()
      await saveObject(env, owner, 'scene', id, file.scene.name, file, sceneSummary(file, id, updatedAt), updatedAt)
      return json({ ok: true, scene: sceneSummary(file, id, updatedAt) }, 200, request, env)
    }
  }

  const duplicateMatch = route.match(/^\/api\/scenes\/([^/]+)\/duplicate$/)
  if (duplicateMatch && request.method === 'POST') {
    const sourceId = decodeURIComponent(duplicateMatch[1])
    const sourceRow = await getObject(env, owner, 'scene', sourceId)
    if (!sourceRow) return errorResponse(new Error('场景不存在'), 404, request, env)
    const source = await getJsonBlob<JsonRecord>(env, sourceRow.blob_key)
    const body = await readBody(request)
    const requestedName = isRecord(body) ? body.name : undefined
    const file = structuredClone(source) as JsonRecord
    const name = await uniqueName(env, owner, 'scene', requestedName ?? `${(file.scene as JsonRecord).name}·副本`)
    ;(file.scene as JsonRecord).name = name
    const id = `scene-${crypto.randomUUID()}`
    const updatedAt = new Date().toISOString()
    await saveObject(env, owner, 'scene', id, name, file, sceneSummary(file, id, updatedAt), updatedAt)
    return json({ ok: true, sceneId: id, scene: sceneSummary(file, id, updatedAt) }, 201, request, env)
  }

  const assetMatch = route.match(/^\/api\/assets\/([^/]+)$/)
  if (assetMatch) {
    const id = decodeURIComponent(assetMatch[1])
    const row = await getObject(env, owner, 'asset', id)
    if (request.method === 'GET') {
      if (!row) return errorResponse(new Error('资产不存在'), 404, request, env)
      return json(await getJsonBlob<JsonRecord>(env, row.blob_key), 200, request, env)
    }
    if (request.method === 'DELETE') {
      if (!row) return errorResponse(new Error('资产不存在'), 404, request, env)
      await env.DB.prepare('DELETE FROM objects WHERE owner_id = ?1 AND kind = ?2 AND id = ?3').bind(owner, 'asset', id).run()
      await env.BLOBS.delete(row.blob_key)
      return json({ ok: true }, 200, request, env)
    }
    if (request.method === 'PUT' || request.method === 'POST') {
      const payload = await readBody(request)
      if (!isRecord(payload) || !payload.id || !payload.name || !Array.isArray(payload.voxels)) return errorResponse(new Error('资产数据不完整'), 400, request, env)
      const name = await uniqueName(env, owner, 'asset', payload.name, id)
      const stored = { ...structuredClone(payload), id, name, isTemplate: true, updatedAt: new Date().toISOString() } as JsonRecord
      const updatedAt = new Date().toISOString()
      await saveObject(env, owner, 'asset', id, name, stored, assetSummary(stored, updatedAt), updatedAt)
      const categories = await replaceCategories(env, owner, [...await categoryPaths(env, owner), ...((stored.categoryPath as string[] | undefined) ? [stored.categoryPath as string[]] : [])])
      return json({ ok: true, asset: assetSummary(stored, updatedAt), assetCategories: categories }, 200, request, env)
    }
  }

  return errorResponse(new Error('未知持久化接口'), 404, request, env)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': env.ALLOWED_ORIGIN ?? request.headers.get('Origin') ?? '*',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-max-age': '86400',
      } })
    }
    try {
      const owner = await authenticatedOwner(request, env)
      if (new URL(request.url).pathname.startsWith('/api/')) return await handleApi(request, env, owner)
      if (env.ASSETS) return env.ASSETS.fetch(request)
      return new Response('莫测造境 Worker 已启动，但尚未配置静态资源绑定', { status: 503 })
    } catch (error) {
      if (error instanceof Response) return error
      return errorResponse(error, error instanceof Error && /云端配额不足/.test(error.message) ? 413 : error instanceof Error && /不是有效|结构|必须|不支持|未包含|资产文件|普通实体/.test(error.message) ? 400 : 500, request, env)
    }
  },
}
