import fs from 'node:fs'
import path from 'node:path'

const dataDirectory = path.resolve(process.cwd(), 'data')
const databaseFile = path.join(dataDirectory, 'moce-world-db.json')

const emptyDatabase = () => ({
  version: 1,
  assets: {},
  scenes: {},
  assetCategories: [],
})

function readDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(databaseFile, 'utf8'))
    return {
      version: parsed.version ?? 1,
      assets: parsed.assets ?? {},
      scenes: parsed.scenes ?? {},
      assetCategories: parsed.assetCategories ?? [],
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

function normalizeAssetCategories(categories) {
  const paths = new Map()
  for (const pathValue of Array.isArray(categories) ? categories : []) {
    if (!Array.isArray(pathValue)) continue
    const path = pathValue.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    for (let index = 1; index <= path.length; index += 1) {
      const prefix = path.slice(0, index)
      paths.set(prefix.join('\u001f'), prefix)
    }
  }
  return [...paths.values()]
}

function assetCategoriesFromDatabase(database) {
  return normalizeAssetCategories([
    ...(database.assetCategories ?? []),
    ...Object.values(database.assets).map((asset) => asset.categoryPath ?? []),
  ])
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

function sceneFileFromProject(project) {
  const usedAssetIds = new Set((project.instances ?? []).map((instance) => instance.assetId))
  const assets = project.assets ?? []
  const missingAssetId = [...usedAssetIds].find((assetId) => !assets.some((asset) => asset.id === assetId))
  if (missingAssetId) throw new Error(`场景引用了不存在的资产：${missingAssetId}`)
  const { assets: _assets, ...scene } = project
  return {
    format: 'moce-scene',
    formatVersion: 1,
    scene,
    sceneAssets: assets.filter((asset) => usedAssetIds.has(asset.id)).map((asset) => ({ ...asset, isTemplate: false })),
  }
}

function sceneFileFromPayload(payload) {
  if (payload?.format === 'moce-scene' && payload.formatVersion === 1 && payload.scene && Array.isArray(payload.sceneAssets)) {
    const assetIds = new Set(payload.sceneAssets.map((asset) => asset?.id).filter(Boolean))
    if (payload.scene.version !== 1 || !Array.isArray(payload.scene.instances) || !Array.isArray(payload.scene.customVoxels)) throw new Error('场景文件结构不完整')
    const missingAssetId = payload.scene.instances.find((instance) => !assetIds.has(instance.assetId))?.assetId
    if (missingAssetId) throw new Error(`场景引用了未包含的资产：${missingAssetId}`)
    return {
      format: 'moce-scene',
      formatVersion: 1,
      scene: structuredClone(payload.scene),
      sceneAssets: structuredClone(payload.sceneAssets).map((asset) => ({ ...asset, isTemplate: false })),
    }
  }
  if (payload?.version === 1 && Array.isArray(payload.assets) && Array.isArray(payload.instances) && Array.isArray(payload.customVoxels)) return sceneFileFromProject(payload)
  throw new Error('不是有效的莫测造境场景文件')
}

function assetFileFromPayload(payload) {
  if (payload?.format !== 'moce-asset' || payload.formatVersion !== 1 || !Array.isArray(payload.assets) || !Array.isArray(payload.categories)) {
    throw new Error('不是有效的莫测造境资产库实体文件')
  }
  const ids = new Set()
  const assets = payload.assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object' || !asset.id || !asset.name || !Array.isArray(asset.voxels)) throw new Error(`资产文件实体 ${index + 1} 数据不完整`)
    if (ids.has(asset.id)) throw new Error(`资产文件存在重复实体ID：${asset.id}`)
    ids.add(asset.id)
    return structuredClone(asset)
  })
  return { format: 'moce-asset', formatVersion: 1, assets, categories: normalizeAssetCategories(payload.categories) }
}

function entityFileFromPayload(payload) {
  if (payload?.format !== 'moce-entity' || payload.formatVersion !== 1 || typeof payload.name !== 'string' || !Array.isArray(payload.entities) || !Array.isArray(payload.assemblies)) {
    throw new Error('不是有效的莫测造境普通实体文件')
  }
  const entityIds = new Set()
  for (const [index, entity] of payload.entities.entries()) {
    if (!entity || typeof entity !== 'object' || !entity.id || !entity.name || !entity.asset || !Array.isArray(entity.asset.voxels)) throw new Error(`普通实体文件实体 ${index + 1} 数据不完整`)
    if (entityIds.has(entity.id)) throw new Error(`普通实体文件存在重复实体ID：${entity.id}`)
    entityIds.add(entity.id)
    if (!entity.gridPosition || !Number.isInteger(entity.gridPosition.x) || !Number.isInteger(entity.gridPosition.y) || !Number.isInteger(entity.gridPosition.z)) throw new Error(`普通实体文件实体 ${index + 1} 的位置无效`)
  }
  const assemblyIds = new Set()
  for (const [index, assembly] of payload.assemblies.entries()) {
    if (!assembly || typeof assembly !== 'object' || !assembly.id || !Array.isArray(assembly.memberKeys)) throw new Error(`普通实体文件装配体 ${index + 1} 数据不完整`)
    if (assemblyIds.has(assembly.id)) throw new Error(`普通实体文件存在重复装配体ID：${assembly.id}`)
    assemblyIds.add(assembly.id)
  }
  for (const assembly of payload.assemblies) {
    for (const memberKey of assembly.memberKeys) {
      if (typeof memberKey !== 'string') throw new Error('普通实体文件装配关系无效')
      if (memberKey.startsWith('entity:') && !entityIds.has(memberKey.slice('entity:'.length))) throw new Error(`装配体引用了不存在的实体：${memberKey}`)
      if (memberKey.startsWith('assembly:') && !assemblyIds.has(memberKey.slice('assembly:'.length))) throw new Error(`装配体引用了不存在的子装配体：${memberKey}`)
    }
  }
  return structuredClone(payload)
}

function sceneRecordFromFile(sceneFile, id) {
  return { ...sceneFile, id, updatedAt: new Date().toISOString() }
}

function projectFromScene(database, scene) {
  // Keep legacy direct ProjectState records readable by the scene library.
  // They must be converted to the embedded scene shape before rebuilding the
  // project, otherwise the entity pane receives no instances.
  if (scene.format !== 'moce-scene' && Array.isArray(scene.assets) && Array.isArray(scene.instances)) {
    scene = sceneFileFromPayload(scene)
  }
  if (scene.format === 'moce-scene') {
    const sceneAssets = structuredClone(scene.sceneAssets ?? []).map((asset) => {
      const libraryAsset = database.assets[asset.id]
      return {
        ...asset,
        categoryPath: libraryAsset?.categoryPath ?? asset.categoryPath,
        isTemplate: libraryAsset ? libraryAsset.isTemplate !== false : false,
      }
    })
    const sceneAssetIds = new Set(sceneAssets.map((asset) => asset.id))
    const libraryAssets = Object.values(database.assets).filter((asset) => !sceneAssetIds.has(asset.id)).map((asset) => ({ ...structuredClone(asset), isTemplate: asset.isTemplate !== false }))
    return {
      ...structuredClone(scene.scene),
      assets: [...sceneAssets, ...libraryAssets],
    }
  }
  // Backward compatibility with records created before scene assets were embedded.
  const assets = Object.values(database.assets).map((asset) => ({ ...structuredClone(asset), isTemplate: asset.isTemplate !== false }))
  return {
    version: scene.version ?? 1,
    name: scene.name,
    voxelSizeMm: scene.voxelSizeMm ?? 1,
    sceneSizeCm: scene.sceneSizeCm ?? 20,
    sceneBounds: scene.sceneBounds ?? { x: 200, y: 200, z: 200 },
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

function uniqueStoredAssetName(database, asset) {
  const baseName = String(asset.name ?? '').trim() || '未命名实体'
  const existing = new Set(Object.values(database.assets)
    .filter((candidate) => candidate.id !== asset.id)
    .map((candidate) => String(candidate.name ?? '').trim()))
  if (!existing.has(baseName)) return baseName
  let index = 1
  while (existing.has(`${baseName} (${index})`)) index += 1
  return `${baseName} (${index})`
}

function sceneSummary(scene) {
  const state = scene.scene && typeof scene.scene === 'object' ? scene.scene : scene
  const sceneAssets = Array.isArray(scene.sceneAssets) ? scene.sceneAssets : []
  const instances = Array.isArray(state.instances) ? state.instances : []
  const customVoxels = Array.isArray(state.customVoxels) ? state.customVoxels : []
  const assemblies = Array.isArray(state.assemblies) ? state.assemblies : []
  const customEntityIds = new Set(customVoxels.map((voxel) => typeof voxel?.entityId === 'string' ? voxel.entityId : '__legacy_custom_entity__'))
  return {
    id: scene.id,
    name: state.name ?? scene.name,
    assetCount: Array.isArray(scene.sceneAssets) ? sceneAssets.length : typeof scene.assetCount === 'number' ? scene.assetCount : scene.assetIds?.length ?? 0,
    instanceCount: Array.isArray(state.instances) ? instances.length : typeof scene.instanceCount === 'number' ? scene.instanceCount : 0,
    customVoxelCount: Array.isArray(state.customVoxels) ? customVoxels.length : typeof scene.customVoxelCount === 'number' ? scene.customVoxelCount : 0,
    assemblyCount: Array.isArray(state.assemblies) ? assemblies.length : typeof scene.assemblyCount === 'number' ? scene.assemblyCount : 0,
    entityCount: Array.isArray(state.instances) || Array.isArray(state.customVoxels)
      ? instances.length + customEntityIds.size
      : typeof scene.entityCount === 'number' ? scene.entityCount : (typeof scene.instanceCount === 'number' ? scene.instanceCount : 0) + (typeof scene.customVoxelCount === 'number' && scene.customVoxelCount > 0 ? 1 : 0),
    updatedAt: scene.updatedAt,
  }
}

function newSceneId(database) {
  let id = `scene-${Date.now()}`
  let index = 1
  while (database.scenes[id]) id = `scene-${Date.now()}-${index++}`
  return id
}

function uniqueSceneName(database, requestedName, excludedSceneId) {
  const baseName = String(requestedName ?? '').trim() || '未命名场景'
  const existing = new Set(Object.values(database.scenes)
    .filter((scene) => scene.id !== excludedSceneId)
    .map((scene) => String(scene.scene?.name ?? scene.name ?? '').trim()))
  if (!existing.has(baseName)) return baseName
  let index = 1
  while (existing.has(`${baseName}（${index}）`)) index += 1
  return `${baseName}（${index}）`
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
          assetCategories: assetCategoriesFromDatabase(database),
        })
      }

      if (request.method === 'PUT' && route === '/api/asset-categories') {
        const payload = await requestBody(request)
        database.assetCategories = normalizeAssetCategories(payload.categories)
        writeDatabase(database)
        return sendJson(response, 200, { ok: true, assetCategories: database.assetCategories })
      }

      if (route === '/api/assets/import' && request.method === 'POST') {
        const payload = await requestBody(request)
        const assetFile = assetFileFromPayload(payload)
        const importedAssets = assetFile.assets.map((asset) => {
          let id = String(asset.id)
          let suffix = 1
          while (database.assets[id]) id = `${asset.id}-import-${suffix++}`
          const stored = { ...structuredClone(asset), id, name: uniqueStoredAssetName(database, asset), isTemplate: true, updatedAt: new Date().toISOString() }
          database.assets[id] = stored
          return stored
        })
        database.assetCategories = normalizeAssetCategories([...(database.assetCategories ?? []), ...assetFile.categories, ...importedAssets.map((asset) => asset.categoryPath ?? [])])
        writeDatabase(database)
        return sendJson(response, 201, { ok: true, assets: importedAssets, assetCategories: database.assetCategories })
      }

      if (route === '/api/entities/validate' && request.method === 'POST') {
        const payload = await requestBody(request)
        const entityFile = entityFileFromPayload(payload)
        return sendJson(response, 200, { ok: true, entityCount: entityFile.entities.length, assemblyCount: entityFile.assemblies.length })
      }

      if (route === '/api/scenes/import' && request.method === 'POST') {
        const payload = await requestBody(request)
        const sceneFile = sceneFileFromPayload(payload)
        sceneFile.scene.name = uniqueSceneName(database, sceneFile.scene.name)
        const sceneId = newSceneId(database)
        database.scenes[sceneId] = sceneRecordFromFile(sceneFile, sceneId)
        writeDatabase(database)
        return sendJson(response, 201, { ok: true, sceneId, scene: sceneSummary(database.scenes[sceneId]) })
      }

      const sceneMatch = route.match(/^\/api\/scenes\/([^/]+)$/)
      if (sceneMatch && request.method === 'GET') {
        const scene = database.scenes[decodeURIComponent(sceneMatch[1])]
        return scene ? sendJson(response, 200, projectFromScene(database, scene)) : sendJson(response, 404, { error: '场景不存在' })
      }

      if (sceneMatch && (request.method === 'PUT' || request.method === 'POST')) {
        const payload = await requestBody(request)
        const sceneId = decodeURIComponent(sceneMatch[1])
        const sceneFile = sceneFileFromPayload(payload)
        database.scenes[sceneId] = sceneRecordFromFile(sceneFile, sceneId)
        writeDatabase(database)
        return sendJson(response, 200, { ok: true, scene: sceneSummary(database.scenes[sceneId]), assetCount: Object.keys(database.assets).length })
      }

      const sceneActionMatch = route.match(/^\/api\/scenes\/([^/]+)\/(duplicate)$/)
      if (sceneActionMatch && request.method === 'POST') {
        const sourceId = decodeURIComponent(sceneActionMatch[1])
        const source = database.scenes[sourceId]
        if (!source) return sendJson(response, 404, { error: '场景不存在' })
        const body = await requestBody(request)
        const sourceFile = source.format === 'moce-scene'
          ? { format: source.format, formatVersion: source.formatVersion, scene: source.scene, sceneAssets: source.sceneAssets }
          : sceneFileFromPayload(projectFromScene(database, source))
        const sceneId = newSceneId(database)
        const sceneFile = structuredClone(sourceFile)
        sceneFile.scene.name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `${sceneFile.scene.name}·副本`
        database.scenes[sceneId] = sceneRecordFromFile(sceneFile, sceneId)
        writeDatabase(database)
        return sendJson(response, 201, { ok: true, sceneId, scene: sceneSummary(database.scenes[sceneId]) })
      }

      if (sceneMatch && request.method === 'DELETE') {
        const sceneId = decodeURIComponent(sceneMatch[1])
        if (!database.scenes[sceneId]) return sendJson(response, 404, { error: '场景不存在' })
        delete database.scenes[sceneId]
        writeDatabase(database)
        return sendJson(response, 200, { ok: true })
      }

      const assetMatch = route.match(/^\/api\/assets\/([^/]+)$/)
      if (assetMatch && request.method === 'GET') {
        const asset = database.assets[decodeURIComponent(assetMatch[1])]
        return asset ? sendJson(response, 200, asset) : sendJson(response, 404, { error: '资产不存在' })
      }

      if (assetMatch && request.method === 'DELETE') {
        const assetId = decodeURIComponent(assetMatch[1])
        if (!database.assets[assetId]) return sendJson(response, 404, { error: '资产不存在' })
        delete database.assets[assetId]
        writeDatabase(database)
        return sendJson(response, 200, { ok: true })
      }

      if (assetMatch && (request.method === 'PUT' || request.method === 'POST')) {
        const asset = await requestBody(request)
        if (!asset.id || !asset.name || !Array.isArray(asset.voxels)) return sendJson(response, 400, { error: '资产数据不完整' })
        database.assets[asset.id] = { ...asset, name: uniqueStoredAssetName(database, asset), updatedAt: new Date().toISOString() }
        database.assetCategories = normalizeAssetCategories([...(database.assetCategories ?? []), asset.categoryPath ?? []])
        writeDatabase(database)
        return sendJson(response, 200, { ok: true, asset: assetSummary(database.assets[asset.id]) })
      }

      return sendJson(response, 404, { error: '未知持久化接口' })
    } catch (error) {
      return sendJson(response, 500, { error: error instanceof Error ? error.message : '持久化服务失败' })
    }
  }
}
