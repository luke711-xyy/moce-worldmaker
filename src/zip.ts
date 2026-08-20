export type ZipEntry = { name: string; data: ArrayBuffer | Uint8Array }

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff])
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])
}

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function join(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
  let offset = 0
  chunks.forEach((chunk) => { result.set(chunk, offset); offset += chunk.length })
  return result
}

export function createZip(entries: ZipEntry[]): ArrayBuffer {
  const encoder = new TextEncoder()
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  entries.forEach((entry) => {
    const name = encoder.encode(entry.name)
    const data = bytes(entry.data)
    const checksum = crc32(data)
    // Bit 11 marks the filename as UTF-8. Slice exports commonly contain
    // Chinese entity names, so leaving this flag unset makes Finder/unzip
    // decode otherwise valid filenames with the wrong legacy code page.
    const utf8Flag = 0x0800
    const header = join([new Uint8Array([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(utf8Flag), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name])
    local.push(header, data)
    const centralHeader = join([new Uint8Array([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(utf8Flag), u16(0), u16(0), u16(0), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name])
    central.push(centralHeader)
    offset += header.length + data.length
  })
  const centralData = join(central)
  const localData = join(local)
  const end = join([new Uint8Array([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralData.length), u32(localData.length), u16(0)])
  const output = join([localData, centralData, end])
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer
}
