#!/usr/bin/env node
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { WebSocketServer } from 'ws'

if (process.argv[2] === 'install-local-3d') {
  const script = fileURLToPath(new URL('../scripts/install-local-3d.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, ...process.argv.slice(3)], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const port = 32123
const pairCode = process.argv.includes('--pair-code') ? process.argv[process.argv.indexOf('--pair-code') + 1] : ''
const wss = new WebSocketServer({ host: '127.0.0.1', port })
let browser = null
let nextId = 1

const tools = [
  { name: 'moce_status', description: '读取当前编辑器状态。', properties: {} },
  { name: 'moce_get_scene', description: '读取当前场景摘要、边界和体素统计。', properties: {} },
  { name: 'moce_get_entities', description: '读取当前场景实体、文件树关系和包围盒。', properties: {} },
  { name: 'moce_get_selection', description: '读取当前选中实体和编辑对象。', properties: {} },
  { name: 'moce_render_views', description: '获取当前视口 PNG 预览。', properties: {} },
  { name: 'moce_execute_voxel_program', description: '以一个原子事务执行体素创建、编辑、变换、复制、删除或装配。', properties: { transactionId: { type: 'string' }, label: { type: 'string' }, operations: { type: 'array' } }, required: ['transactionId', 'label', 'operations'] },
  { name: 'moce_recolor_entities', description: '将指定普通实体的指定体素改为一种材质颜色。', properties: { entityIds: { type: 'array', items: { type: 'string' } }, materialId: { type: 'string' } }, required: ['entityIds', 'materialId'] },
  { name: 'moce_assemble_entities', description: '把至少两个普通实体加入一个装配体。', properties: { entityIds: { type: 'array', items: { type: 'string' } }, assemblyId: { type: 'string' }, name: { type: 'string' } }, required: ['entityIds'] },
  { name: 'moce_undo', description: '撤销最近一次编辑事务。', properties: {} },
  { name: 'moce_redo', description: '重做最近一次被撤销的编辑事务。', properties: {} },
  { name: 'moce_local3d_status', description: '检查本机图生 3D 服务和可选后端状态。', properties: {} },
  { name: 'moce_generate_from_image', description: '提交一张本地参考图到本机图生 3D 服务。', properties: { imagePath: { type: 'string' }, maxVoxels: { type: 'integer', minimum: 1, maximum: 256 } }, required: ['imagePath'] },
  { name: 'moce_cancel_generation', description: '取消本机图生 3D 任务。', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  { name: 'moce_confirm_generated_model', description: '确认本机图生 3D 任务，并将生成的彩色体素导入当前场景。', properties: { jobId: { type: 'string' }, name: { type: 'string' }, origin: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' } }, required: ['x', 'y', 'z'] } }, required: ['jobId'] },
]

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`) }
function browserRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!browser || browser.readyState !== 1) return reject(new Error('尚未配对浏览器标签页'))
    const id = `bridge-${nextId++}`
    const handler = (raw) => {
      let message
      try { message = JSON.parse(String(raw)) } catch { return }
      if (message.type !== 'rpc_response' || message.id !== id) return
      browser.off('message', handler)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
    browser.on('message', handler)
    browser.send(JSON.stringify({ type: 'rpc_request', id, method, params }))
  })
}

wss.on('connection', (socket) => {
  socket.once('message', (raw) => {
    let hello
    try { hello = JSON.parse(String(raw)) } catch { socket.close(); return }
    if (hello.type !== 'browser_hello' || !pairCode || hello.pairCode !== pairCode || browser) {
      socket.send(JSON.stringify({ type: 'bridge_error', message: '配对码错误或已有其他客户端连接' }))
      socket.close(); return
    }
    browser = socket
    socket.send(JSON.stringify({ type: 'bridge_ready' }))
    socket.on('close', () => { if (browser === socket) browser = null })
  })
})

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  let request
  try { request = JSON.parse(line) } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }) }
  if (request.method === 'initialize') return send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'moce-worldmaker-mcp', version: '0.1.0' } } })
  if (request.method === 'notifications/initialized') return
  if (request.method === 'tools/list') return send({ jsonrpc: '2.0', id: request.id, result: { tools: tools.map(({ name, description, properties, required }) => ({ name, description, inputSchema: { type: 'object', properties, additionalProperties: false, ...(required?.length ? { required } : {}) } })) } })
  if (request.method !== 'tools/call') return send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  try {
    const result = await browserRequest(request.params?.name, request.params?.arguments ?? {})
    send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Bridge request failed' } })
  }
})

process.stderr.write(`莫测造境 MCP Bridge listening on 127.0.0.1:${port}; waiting for browser pairing\n`)

const shutdown = () => {
  try { browser?.close() } catch {}
  wss.close()
  rl.close()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
