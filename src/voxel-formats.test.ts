import { describe, expect, it } from 'vitest'
import { encodeGlb, encodeVox, importVoxBufferAsVoxelAsset, parseVox } from './voxel-formats'
import { makeDefaultProject, VoxelAsset } from './voxel'

// GLTFExporter uses FileReader in browsers. Vitest runs this format test in
// Node, so provide the smallest asynchronous ArrayBuffer implementation.
if (typeof globalThis.FileReader === 'undefined') {
  class TestFileReader {
    result: ArrayBuffer | null = null
    onloadend: (() => void) | null = null
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then((buffer) => {
        this.result = buffer
        this.onloadend?.()
      })
    }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: TestFileReader })
}

function glbPositionBounds(buffer: ArrayBuffer): { min: number[]; max: number[] } {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF')
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
    accessors: Array<{ bufferView: number; min?: number[]; max?: number[] }>
    meshes: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>
  }
  const positionAccessorIndex = json.meshes[0].primitives[0].attributes.POSITION
  const accessor = json.accessors[positionAccessorIndex]
  expect(accessor.min).toBeDefined()
  expect(accessor.max).toBeDefined()
  return { min: accessor.min!, max: accessor.max! }
}

describe('莫测造境体素格式', () => {
  it('can round-trip a colored asset through MagicaVoxel VOX', () => {
    const base = makeDefaultProject().assets[0]
    const asset: VoxelAsset = {
      ...base,
      name: 'VOX 测试实体',
      width: 2,
      depth: 1,
      height: 2,
      parts: ['main'],
      voxels: [
        { x: 0, y: 0, z: 0, materialId: '#ff0000' },
        { x: 1, y: 1, z: 0, materialId: '#00ff00' },
      ],
    }
    const encoded = encodeVox(asset)
    const parsed = parseVox(encoded)
    expect(parsed.models).toHaveLength(1)
    expect(parsed.models[0].voxels).toHaveLength(2)
    const imported = importVoxBufferAsVoxelAsset('roundtrip.vox', encoded)
    expect(imported.asset.voxels).toEqual(expect.arrayContaining([
      { x: 0, y: 0, z: 0, materialId: '#ff0000' },
      { x: 1, y: 1, z: 0, materialId: '#00ff00' },
    ]))
  })

  it('converts MagicaVoxel Z-up into the editor Y-up axis', () => {
    const base = makeDefaultProject().assets[0]
    const encoded = encodeVox({
      ...base,
      width: 1,
      depth: 1,
      height: 3,
      voxels: [
        { x: 0, y: 0, z: 0, materialId: '#336699' },
        { x: 0, y: 2, z: 0, materialId: '#336699' },
      ],
    })
    const imported = importVoxBufferAsVoxelAsset('axis.vox', encoded)
    expect(imported.asset.voxels).toContainEqual({ x: 0, y: 2, z: 0, materialId: '#336699' })
  })

  it('applies the configured voxel edge length to GLB coordinates', async () => {
    const base = makeDefaultProject().assets[0]
    const asset: VoxelAsset = { ...base, voxels: [{ x: 0, y: 0, z: 0, materialId: '#336699' }] }
    const oneMillimeter = glbPositionBounds(await encodeGlb(asset, undefined, 1))
    const fourMillimeters = glbPositionBounds(await encodeGlb(asset, undefined, 4))
    expect(oneMillimeter.min).toEqual([0, 0, 0])
    expect(oneMillimeter.max[0]).toBeCloseTo(0.001, 6)
    expect(oneMillimeter.max[1]).toBeCloseTo(0.001, 6)
    expect(oneMillimeter.max[2]).toBeCloseTo(0.001, 6)
    expect(fourMillimeters.min).toEqual([0, 0, 0])
    expect(fourMillimeters.max[0]).toBeCloseTo(0.004, 6)
    expect(fourMillimeters.max[1]).toBeCloseTo(0.004, 6)
    expect(fourMillimeters.max[2]).toBeCloseTo(0.004, 6)
  })
})
