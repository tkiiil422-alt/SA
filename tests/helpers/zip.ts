/**
 * A minimal ZIP writer for tests.
 *
 * It writes stored or raw-deflated entries, a proper central directory, and lets a test set the Unix mode in the
 * external attributes (regular file, directory, symbolic link or device) and the raw name bytes (UTF-8 or CP437).
 * Keeping this tiny avoids fixtures and lets tests build malicious names and compression bombs on the spot.
 */
import { writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

export interface ZipEntryInput {
  /** Raw name bytes when a `Buffer` is given; a UTF-8 name otherwise. */
  name: string | Buffer
  data?: Buffer | string
  /** Full Unix st_mode (type bits included). Defaults to 0o100644. */
  mode?: number
  /** 0 = stored, 8 = deflate. Defaults to 0. */
  method?: 0 | 8
  /** Set false to omit the UTF-8 general purpose flag. Defaults to true. */
  utf8?: boolean
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Prepared {
  name: Buffer
  flags: number
  method: number
  crc: number
  compressed: Buffer
  uncompressedSize: number
  mode: number
  offset: number
}

/** Write the given entries to `path`, returning the file size. */
export function writeZip(path: string, entries: readonly ZipEntryInput[]): number {
  const locals: Buffer[] = []
  const prepared: Prepared[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const method = entry.method ?? 0
    const compressed = method === 8 ? deflateRawSync(data) : data
    const flags = entry.utf8 === false ? 0 : 0x800
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0x21, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    locals.push(header, name, compressed)
    prepared.push({
      name,
      flags,
      method,
      crc,
      compressed,
      uncompressedSize: data.length,
      mode: entry.mode ?? 0o100644,
      offset,
    })
    offset += header.length + name.length + compressed.length
  }

  const centralParts: Buffer[] = []
  let centralSize = 0
  for (const entry of prepared) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, so externalFileAttributes carries st_mode
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(entry.flags, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.compressed.length, 20)
    header.writeUInt32LE(entry.uncompressedSize, 24)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE((entry.mode << 16) >>> 0, 38)
    header.writeUInt32LE(entry.offset, 42)
    centralParts.push(header, entry.name)
    centralSize += header.length + entry.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(prepared.length, 8)
  end.writeUInt16LE(prepared.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  const body = Buffer.concat([...locals, ...centralParts, end])
  writeFileSync(path, body)
  return body.length
}
