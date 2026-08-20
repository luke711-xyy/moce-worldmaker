import { describe, expect, it } from 'vitest'
import { SceneEntityPart, Voxel } from '../voxel'
import { buildGreedyMesh } from './greedy-mesher'
import { SceneOccupancyIndex } from './spatial-index'

const makePart = (id: string, voxels: Voxel[]): SceneEntityPart => ({
  id,
  kind: 'custom',
  partId: id,
  memberKey: `voxel:${id}`,
  voxels,
})

describe('runtime performance budgets', () => {
  it('indexes and queries a contiguous 100k voxel scene within a desktop budget', () => {
    const voxels: Voxel[] = []
    for (let y = 0; y < 10; y += 1) {
      for (let z = 0; z < 100; z += 1) {
        for (let x = 0; x < 100; x += 1) voxels.push({ x, y, z, materialId: 'stone' })
      }
    }
    const buildStarted = performance.now()
    const index = SceneOccupancyIndex.fromParts([makePart('stress', voxels)])
    const buildDuration = performance.now() - buildStarted
    const queryStarted = performance.now()
    for (let indexValue = 0; indexValue < 2000; indexValue += 1) {
      const x = indexValue % 100
      const z = Math.floor(indexValue / 100) % 100
      expect(index.queryProjectVoxel({ x, y: 5, z }).occupied).toBe(true)
    }
    const queryDuration = performance.now() - queryStarted
    expect(buildDuration).toBeLessThan(2500)
    expect(queryDuration).toBeLessThan(250)
    expect(index.chunks.size).toBeLessThanOrEqual(64)
  })

  it('greedy-meshes a 10k solid volume into six exterior quads', () => {
    const voxels = []
    for (let gz = 0; gz < 10; gz += 1) {
      for (let gy = 0; gy < 10; gy += 1) {
        for (let gx = 0; gx < 100; gx += 1) voxels.push({ gx, gy, gz, materialId: 1 })
      }
    }
    const started = performance.now()
    const mesh = buildGreedyMesh(voxels)
    expect(mesh.quadCount).toBe(6)
    expect(mesh.indices.length).toBe(36)
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('greedy-meshes a 100k solid volume without spreading into the call stack', () => {
    const voxels = []
    for (let gz = 0; gz < 100; gz += 1) {
      for (let gy = 0; gy < 10; gy += 1) {
        for (let gx = 0; gx < 100; gx += 1) voxels.push({ gx, gy, gz, materialId: 1 })
      }
    }
    const mesh = buildGreedyMesh(voxels)
    expect(mesh.quadCount).toBe(6)
  })
})
