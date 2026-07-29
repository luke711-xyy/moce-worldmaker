import fs from 'node:fs'
import path from 'node:path'

const dataDirectory = path.resolve(process.cwd(), 'data')
const databaseFile = path.join(dataDirectory, 'moce-world-db.json')

const emptyDatabase = () => ({
  version: 1,
  assets: {},
  scenes: {},
})

function readDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(databaseFile, 'utf8'))
    return {
      version: parsed.version ?? 1,
      assets: parsed.assets ?? {},
      scenes: parsed.scenes ?? {},
    }
  } catch {
    return emptyDatabase()
  }
}

function writeDatabase(database) {
  fs.mkdirSync(dataDirectory, { recursive: true })
  const temporaryFile = `${databaseFile}.tmp`
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2))
  fs.renameSync(temporaryFile, databaseFile)
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 25 * 1024 * 1024) reject(new Error('请求体超过 25 MB'))
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('请求体不是有效 JSON'))
      }
    })
    request.on('error', reject)
  })
}

function sceneFromProject(project, id) {
  return {
    id,
    name: project.name,
    version: project.version ?? 1,
    voxelSizeMm: project.voxelSizeMm ?? 1,
    sceneSizeCm: project.sceneSizeCm ?? 20,
    materials: project.materials ?? [],
    assetIds: (project.assets ?? []).map((asset) => asset.id),
    instances: project.instances ?? [],
    customVoxels: project.customVoxels ?? [],
    customColors: project.customColors ?? {},
    entityNames: project.entityNames ?? {},
    entityNameModes: project.entityNameModes ?? {},
    entityNameSequences: project.entityNameSequences ?? {},
    entityNameParents: project.entityNameParents ?? {},
    entitySequenceCounters: project.entitySequenceCounters ?? {},
    assemblySequence: project.assemblySequence ?? 1,
    assemblyChildSequence: project.assemblyChildSequence ?? {},
    childSequenceCounters: project.childSequenceCounters ?? {},
    assemblies: project.assemblies ?? [],
    lockedMemberKeys: project.lockedMemberKeys ?? [],
    updatedAt: new Date().toISOString(),
  }
}

function projectFromScene(database, scene) {
  const assets = scene.assetIds
    .map((assetId) => database.assets[assetId])
    .filter(Boolean)
  return {
    version: scene.version ?? 1,
    name: scene.name,
    voxelSizeMm: scene.voxelSizeMm ?? 1,
    sceneSizeCm: scene.sceneSizeCm ?? 20,
    materials: scene.materials ?? [],
    assets,
    instances: scene.instances ?? [],
    customVoxels: scene.customVoxels ?? [],
    customColors: scene.customColors ?? {},
    entityNames: scene.entityNames ?? {},
    entityNameModes: scene.entityNameModes ?? {},
    entityNameSequences: scene.entityNameSequences ?? {},
    entityNameParents: scene.entityNameParents ?? {},
    entitySequenceCounters: scene.entitySequenceCounters ?? {},
    assemblySequence: scene.assemblySequence ?? 1,
    assemblyChildSequence: scene.assemblyChildSequence ?? {},
    childSequenceCounters: scene.childSequenceCounters ?? {},
    assemblies: scene.assemblies ?? [],
    lockedMemberKeys: scene.lockedMemberKeys ?? [],
  }
}

function assetSummary(asset) {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    style: asset.style,
    width: asset.width,
    depth: asset.depth,
    height: asset.height,
    voxelCount: asset.voxels?.length ?? 0,
    updatedAt: asset.updatedAt ?? null,
  }
}

function sceneSummary(scene) {
  return {
    id: scene.id,
    name: scene.name,
    assetCount: scene.assetIds?.length ?? 0,
    instanceCount: scene.instances?.length ?? 0,
    customVoxelCount: scene.customVoxels?.length ?? 0,
    updatedAt: scene.updatedAt,
  }
}

export function createPersistenceMiddleware() {
  return async (request, response, next) => {
    if (!request.url?.startsWith('/api/')) return next()
    const url = new URL(request.url, 'http://127.0.0.1')
    const route = url.pathname.replace(/\/$/, '')
    const database = readDatabase()

    try {
      if (request.method === 'GET' && route === '/api/library') {
        return sendJson(response, 200, {
          assets: Object.values(database.assets).map(assetSummary),
          scenes: Object.values(database.scenes).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))).map(sceneSummary),
        })
      }

      const sceneMatch = route.match(/^\/api\/scenes\/([^/]+)$/)
      if (sceneMatch && request.method === 'GET') {
        const scene = database.scenes[decodeURIComponent(sceneMatch[1])]
        return scene ? sendJson(response, 200, projectFromScene(database, scene)) : sendJson(response, 404, { error: '场景不存在' })
      }

      if (sceneMatch && (request.method === 'PUT' || request.method === 'POST')) {
        const project = await requestBody(request)
        const sceneId = decodeURIComponent(sceneMatch[1])
        for (const asset of project.assets ?? []) database.assets[asset.id] = { ...asset, updatedAt: new Date().toISOString() }
        database.scenes[sceneId] = sceneFromProject(project, sceneId)
        writeDatabase(database)
        return sendJson(response, 200, { ok: true, scene: sceneSummary(database.scenes[sceneId]), assetCount: Object.keys(database.assets).length })
      }

      const assetMatch = route.match(/^\/api\/assets\/([^/]+)$/)
      if (assetMatch && request.method === 'GET') {
        const asset = database.assets[decodeURIComponent(assetMatch[1])]
        return asset ? sendJson(response, 200, asset) : sendJson(response, 404, { error: '资产不存在' })
      }

      if (assetMatch && (request.method === 'PUT' || request.method === 'POST')) {
        const asset = await requestBody(request)
        if (!asset.id || !asset.name || !Array.isArray(asset.voxels)) return sendJson(response, 400, { error: '资产数据不完整' })
        database.assets[asset.id] = { ...asset, updatedAt: new Date().toISOString() }
        writeDatabase(database)
        return sendJson(response, 200, { ok: true, asset: assetSummary(database.assets[asset.id]) })
      }

      return sendJson(response, 404, { error: '未知持久化接口' })
    } catch (error) {
      return sendJson(response, 500, { error: error instanceof Error ? error.message : '持久化服务失败' })
    }
  }
}
