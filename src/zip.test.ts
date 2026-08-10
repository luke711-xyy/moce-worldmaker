import { describe, expect, it } from 'vitest'
import { createZip } from './zip'

describe('createZip', () => {
  it('writes a readable store-only archive with every entry', () => {
    const archive = new Uint8Array(createZip([
      { name: 'layer-1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      { name: '层-2.stl', data: new TextEncoder().encode('solid slice\nendsolid slice') },
    ]))
    const text = new TextDecoder().decode(archive)
    const archiveView = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    const view = new DataView(archive.buffer, archive.byteOffset + archive.byteLength - 22, 22)

    expect(Array.from(archive.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(archiveView.getUint16(6, true)).toBe(0x0800)
    expect(text).toContain('layer-1.png')
    expect(text).toContain('层-2.stl')
    expect(Array.from(archive.slice(archive.length - 22, archive.length - 18))).toEqual([0x50, 0x4b, 0x05, 0x06])
    expect(view.getUint16(4, true)).toBe(0)
    expect(view.getUint16(6, true)).toBe(0)
    expect(view.getUint16(10, true)).toBe(2)
  })
})
