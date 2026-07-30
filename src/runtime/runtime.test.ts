import { describe, expect, it } from 'vitest'
import { SceneEntityPart, Voxel } from '../voxel'
import {
  projectVoxelToRuntime,
  runtimeChunkCoord,
  runtimeLocalCoord,
  runtimeLocalIndex,
  runtimeVoxelToProject,
} from './runtime-coordinates'
import { SceneOccupancyIndex } from './spatial-index'

const voxel = (x: number, y: number, z: number, materialId = 'stone'): Voxel => ({ x, y, z, materialId })

const part = (id: string, voxels: Voxel[]): SceneEntityPart => ({
  id,
  kind: 'custom',
  partId: id,
  memberKey: `voxel:${id}`,
  voxels,
})

describe('runtime coordinates', () => {
  it('maps project X/Z ground coordinates to runtime X/Y and project Y to runtime Z', () => {
    const runtime = projectVoxelToRuntime(voxel(3, 7, -4))
    expect(runtime).toEqual({ gx: 3, gy: -4, gz: 7 })
    expect(runtimeVoxelToProject(runtime, 'stone')).toEqual(voxel(3, 7, -4))
  })

  it('addresses negative coordinates into stable chunks and positive local cells', () => {
    const runtime = { gx: -1, gy: -33, gz: 32 }
    expect(runtimeChunkCoord(runtime)).toEqual({ cx: -1, cy: -2, cz: 1 })
    expect(runtimeLocalCoord(runtime)).toEqual({ lx: 31, ly: 31, lz: 0 })
    expect(runtimeLocalIndex(runtimeLocalCoord(runtime))).toBe(31 | (31 << 5))
  })
})

describe('SceneOccupancyIndex', () => {
  it('indexes owners and supports exclusions for moving entities', () => {
    const index = SceneOccupancyIndex.fromParts([
      part('left', [voxel(0, 0, 0), voxel(1, 0, 0)]),
      part('right', [voxel(3, 0, 0)]),
    ])
    expect(index.queryProjectVoxel(voxel(0, 0, 0)).ownerIds).toEqual(['left'])
    expect(index.collidesTranslatedProjectVoxels([voxel(0, 0, 0)], { x: 1, y: 0, z: 0 }, ['left'])).toBe(false)
    expect(index.collidesTranslatedProjectVoxels([voxel(1, 0, 0)], { x: 2, y: 0, z: 0 }, ['left'])).toBe(true)
  })

  it('removes and replaces owners incrementally', () => {
    const index = SceneOccupancyIndex.fromParts([part('entity', [voxel(-1, 0, -1)])])
    index.replaceOwner('entity', [voxel(33, 2, 0)])
    expect(index.queryProjectVoxel(voxel(-1, 0, -1)).occupied).toBe(false)
    expect(index.queryProjectVoxel(voxel(33, 2, 0)).ownerIds).toEqual(['entity'])
    index.removeOwner('entity')
    expect(index.queryProjectVoxel(voxel(33, 2, 0)).occupied).toBe(false)
  })

  it('tracks overlapping legacy occupants without hiding non-excluded owners', () => {
    const index = SceneOccupancyIndex.fromParts([
      part('first', [voxel(4, 1, 2)]),
      part('second', [voxel(4, 1, 2)]),
    ])
    expect(index.queryProjectVoxel(voxel(4, 1, 2)).ownerIds).toEqual(['first', 'second'])
    expect(index.collidesProjectVoxels([voxel(4, 1, 2)], ['first'])).toBe(true)
    index.removeOwner('first')
    expect(index.queryProjectVoxel(voxel(4, 1, 2)).ownerIds).toEqual(['second'])
  })
})
