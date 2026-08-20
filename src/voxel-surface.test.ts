import { describe, expect, it } from 'vitest'
import { buildVoxelSurfaceMesh } from './voxel-surface'
import { makeStlWithDiagnostics } from './voxel'

describe('shared voxel surface mesh', () => {
  it('removes the coplanar internal face between adjacent cubes', () => {
    const one = buildVoxelSurfaceMesh([{ x: 0, y: 0, z: 0, materialId: '#ff0000' }])
    const two = buildVoxelSurfaceMesh([
      { x: 0, y: 0, z: 0, materialId: '#ff0000' },
      { x: 1, y: 0, z: 0, materialId: '#ff0000' },
    ])
    expect(one.indices.length / 3).toBe(12)
    expect(two.indices.length / 3).toBe(20)
    expect(two.diagnostics.nonManifoldEdges).toBe(0)
  })

  it('keeps variant geometry on the shared surface path', () => {
    const mesh = buildVoxelSurfaceMesh([
      { x: 0, y: 0, z: 0, materialId: '#00ff00', shape: 'stair', facing: '+y', rotation: 0 },
      { x: 0, y: 1, z: 0, materialId: '#0000ff' },
    ])
    expect(mesh.positions.length).toBeGreaterThan(0)
    expect(mesh.colors.length).toBe(mesh.positions.length)
    expect(mesh.diagnostics.duplicateFaces).toBe(0)
    expect(mesh.ao.length).toBe(mesh.positions.length / 3)
  })

  it('welds hard-normal splits before variant STL diagnostics', () => {
    const result = makeStlWithDiagnostics({
      id: 'variant-test',
      name: 'variant-test',
      style: 'test',
      kind: 'imported',
      width: 2,
      depth: 1,
      height: 2,
      color: '#6c827d',
      accent: '#d2a354',
      parts: ['main'],
      voxels: [
        { x: 0, y: 0, z: 0, materialId: '#00ff00', shape: 'stair', facing: '+y', rotation: 0 },
        { x: 1, y: 0, z: 0, materialId: '#0000ff' },
      ],
    })
    expect(result.diagnostics.nonManifoldEdgesAfter).toBe(0)
  })
})
