#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const python = process.platform === 'win32' ? 'python' : 'python3'
const root = join(fileURLToPath(new URL('../..', import.meta.url)), 'local-3d-service')
const venv = join(root, '.venv')
const createVenv = process.argv.includes('--create-venv')
const installPointE = process.argv.includes('--install-pointe')
try {
  execFileSync(python, ['--version'], { stdio: 'inherit' })
  if (createVenv && !existsSync(venv)) {
    mkdirSync(root, { recursive: true })
    execFileSync(python, ['-m', 'venv', venv], { stdio: 'inherit' })
    process.stderr.write(`已创建隔离 Python 环境：${venv}\n`)
  }
  const venvPython = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  if (installPointE) {
    if (!existsSync(venvPython)) throw new Error('请先使用 --create-venv 创建隔离环境')
    process.stderr.write('即将安装 Point-E 及其深度学习依赖，可能占用较多磁盘空间。\n')
    execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'git+https://github.com/openai/point-e.git'], { stdio: 'inherit' })
  }
  process.stderr.write('本地 3D 服务安装检查完成。请启动：python3 packages/local-3d-service/server.py\n')
  if (!installPointE) process.stderr.write('提示：默认不下载模型权重；需要 Point-E 时使用 --create-venv --install-pointe。\n')
} catch {
  process.stderr.write('本地 3D 后端安装失败：请确认 Python 3、虚拟环境和 Point-E 依赖可用。\n')
  process.exitCode = 1
}
