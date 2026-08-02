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

/** Count the same editable parts that the scene tree exposes. */
function sceneEntityCount(state: JsonRecord, sceneAssets: JsonRecord[]): number {
  const assetMap = new Map(sceneAssets.filter((asset) => typeof asset.id === 'string').map((asset) => [asset.id as string, asset]))
  const instances = Array.isArray(state.instances) ? state.instances : []
  const instanceCount = instances.reduce((total, instance) => {
    if (!isRecord(instance)) return total
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
    if (!partVoxels) return total + (resolved.size ? 1 : 0)
    const claimed = new Set<string>()
    let parts = 0
    Object.values(partVoxels).forEach((part) => {
      if (!Array.isArray(part)) return
      let hasVoxel = false
      part.filter(isRecord).forEach((voxel) => {
        const key = voxelKey(voxel)
        if (resolved.has(key)) hasVoxel = true
        claimed.add(key)
      })
      if (hasVoxel) parts += 1
    })
    if ([...resolved.keys()].some((key) => !claimed.has(key))) parts += 1
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

function sceneFileFromProjectPayload(payload: unknown) {
  return parseSceneFile(payload)
}

async function handleApi(request: Request, env: Env, owner: string): Promise<Response> {
  requireBindings(env)
  const url = new URL(request.url)
  const route = url.pathname.replace(/\/$/, '')

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
      return errorResponse(error, error instanceof Error && /不是有效|结构|必须|不支持|未包含|资产文件|普通实体/.test(error.message) ? 400 : 500, request, env)
    }
  },
}
