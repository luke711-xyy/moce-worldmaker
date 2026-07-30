import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const databaseName = valueAfter('--database', 'moce-worldmaker-staging')
const bucketName = valueAfter('--bucket', 'moce-worldmaker-staging')
const envName = valueAfter('--env', '')
const owner = (valueAfter('--owner', process.env.MOCE_BOOTSTRAP_OWNER ?? 'xuyiyang038@gmail.com')).trim().toLowerCase()
const inputPath = path.resolve(valueAfter('--input', 'data/moce-world-db.json'))

if (!fs.existsSync(inputPath)) throw new Error(`找不到本地数据库：${inputPath}`)
const database = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'moce-worldmaker-migrate-'))
const sqlPath = path.join(temporaryDirectory, 'bootstrap.sql')
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const keyFor = (kind, id) => `${kind}/${encodeURIComponent(owner)}/${encodeURIComponent(id)}.json`
const isoNow = () => new Date().toISOString()

const objects = []
const categories = new Map()
const assets = Object.values(database.assets ?? {})
for (const asset of assets) {
  const id = String(asset.id)
  const updatedAt = asset.updatedAt ?? isoNow()
  const key = keyFor('asset', id)
  const summary = { ...asset, isTemplate: asset.isTemplate !== false }
  objects.push({ kind: 'asset', id, name: String(asset.name ?? '未命名实体'), key, summary, value: summary, updatedAt })
  const category = Array.isArray(asset.categoryPath) ? asset.categoryPath.filter(Boolean) : []
  for (let index = 1; index <= category.length; index += 1) {
    const prefix = category.slice(0, index)
    categories.set(prefix.join('\u001f'), prefix)
  }
}

for (const [id, rawScene] of Object.entries(database.scenes ?? {})) {
  const scene = rawScene?.format === 'moce-scene'
    ? rawScene
    : {
        format: 'moce-scene',
        formatVersion: 1,
        scene: rawScene,
        sceneAssets: [],
      }
  const name = String(scene.scene?.name ?? scene.name ?? '未命名场景')
  const updatedAt = scene.updatedAt ?? isoNow()
  const key = keyFor('scene', id)
  const summary = {
    format: 'moce-scene',
    formatVersion: 1,
    scene: scene.scene,
    sceneAssets: scene.sceneAssets ?? [],
  }
  objects.push({ kind: 'scene', id, name, key, summary: { scene: summary.scene, sceneAssets: summary.sceneAssets }, value: summary, updatedAt })
}

let sql = 'BEGIN TRANSACTION;\n'
for (const item of objects) {
  sql += `INSERT INTO objects (owner_id, kind, id, name, blob_key, summary_json, updated_at) VALUES (${quote(owner)}, ${quote(item.kind)}, ${quote(item.id)}, ${quote(item.name)}, ${quote(item.key)}, ${quote(JSON.stringify(item.summary))}, ${quote(item.updatedAt)}) ON CONFLICT(owner_id, kind, id) DO UPDATE SET name = excluded.name, blob_key = excluded.blob_key, summary_json = excluded.summary_json, updated_at = excluded.updated_at;\n`
}
for (const category of categories.values()) {
  sql += `INSERT INTO asset_categories (owner_id, path_key, path_json) VALUES (${quote(owner)}, ${quote(category.join('\u001f'))}, ${quote(JSON.stringify(category))}) ON CONFLICT(owner_id, path_key) DO UPDATE SET path_json = excluded.path_json;\n`
}
sql += 'COMMIT;\n'
fs.writeFileSync(sqlPath, sql)

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} 执行失败`)
}

const migrationArgs = ['d1', 'execute', databaseName, '--remote', '--file', sqlPath]
if (envName) migrationArgs.push('--env', envName)
run('npx', ['wrangler', ...migrationArgs])

for (const item of objects) {
  const filePath = path.join(temporaryDirectory, `${item.kind}-${item.id.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  fs.writeFileSync(filePath, JSON.stringify(item.value))
  run('npx', ['wrangler', 'r2', 'object', 'put', `${bucketName}/${item.key}`, '--remote', '--file', filePath, '--content-type', 'application/json'])
}

fs.rmSync(temporaryDirectory, { recursive: true, force: true })
console.log(`迁移完成：${objects.filter((item) => item.kind === 'asset').length} 个资产、${objects.filter((item) => item.kind === 'scene').length} 个场景、${categories.size} 个类别，所有数据归属 ${owner}`)
