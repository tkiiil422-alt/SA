/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder (UTF-8 8-bit byte mode, versions 1–20) producing SVG, Data URLs, and
 * compact UTF-8 terminal half-block art.
 *
 * Reed-Solomon & mask tables adapted from qrcode-generator by Kazuhiko Arase (MIT License).
 */

export type QrEcLevel = 'L' | 'M'

const EC_BITS: Record<QrEcLevel, number> = { L: 1, M: 0 }

const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
]

/** [count, totalCount, dataCount, ...] per version (1..20) for [L, M]. */
const RS_BLOCKS: readonly (readonly [readonly number[], readonly number[]])[] = [
  [[1, 26, 19], [1, 26, 16]],
  [[1, 44, 34], [1, 44, 28]],
  [[1, 70, 55], [1, 70, 44]],
  [[1, 100, 80], [2, 50, 32]],
  [[1, 134, 108], [2, 67, 43]],
  [[2, 86, 68], [4, 43, 27]],
  [[2, 98, 78], [4, 49, 31]],
  [[2, 121, 97], [2, 60, 38, 2, 61, 39]],
  [[2, 146, 116], [3, 58, 36, 2, 59, 37]],
  [[2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44]],
  [[4, 101, 81], [1, 80, 50, 4, 81, 51]],
  [[2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37]],
  [[4, 133, 107], [8, 59, 37, 1, 60, 38]],
  [[3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41]],
  [[5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42]],
  [[5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46]],
  [[1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47]],
  [[5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44]],
  [[3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45]],
  [[3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42]],
]

const EXP_TABLE = new Uint8Array(256)
const LOG_TABLE = new Uint8Array(256)
for (let i = 0; i < 8; i += 1) EXP_TABLE[i] = 1 << i
for (let i = 8; i < 256; i += 1) {
  EXP_TABLE[i] = EXP_TABLE[i - 4]! ^ EXP_TABLE[i - 5]! ^ EXP_TABLE[i - 6]! ^ EXP_TABLE[i - 8]!
}
for (let i = 0; i < 255; i += 1) LOG_TABLE[EXP_TABLE[i]!] = i

function glog(n: number): number {
  if (n < 1) throw new Error(`glog(${n})`)
  return LOG_TABLE[n]!
}

function gexp(n: number): number {
  let k = n % 255
  if (k < 0) k += 255
  return EXP_TABLE[k]!
}

function polyNormalize(num: readonly number[], shift = 0): number[] {
  let offset = 0
  while (offset < num.length && num[offset] === 0) offset += 1
  const out = new Array<number>(num.length - offset + shift).fill(0)
  for (let i = 0; i < num.length - offset; i += 1) out[i] = num[i + offset]!
  return out
}

function polyMultiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0)
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === 0) continue
    for (let j = 0; j < b.length; j += 1) {
      if (b[j] === 0) continue
      out[i + j] = out[i + j]! ^ gexp(glog(a[i]!) + glog(b[j]!))
    }
  }
  return polyNormalize(out)
}

function polyMod(a: readonly number[], b: readonly number[]): number[] {
  let cur = polyNormalize(a)
  while (cur.length >= b.length && cur.length > 0) {
    const ratio = glog(cur[0]!) - glog(b[0]!)
    const next = [...cur]
    for (let i = 0; i < b.length; i += 1) {
      if (b[i] !== 0) next[i] = next[i]! ^ gexp(glog(b[i]!) + ratio)
    }
    cur = polyNormalize(next)
  }
  return cur
}

function errorCorrectPoly(ecLen: number): number[] {
  let poly = [1]
  for (let i = 0; i < ecLen; i += 1) poly = polyMultiply(poly, [1, gexp(i)])
  return poly
}

interface RsBlock { totalCount: number; dataCount: number }

function getRsBlocks(version: number, level: QrEcLevel): RsBlock[] {
  const row = RS_BLOCKS[version - 1]?.[level === 'L' ? 0 : 1]
  if (!row) throw new Error(`不支持的二维码版本: ${version}`)
  const out: RsBlock[] = []
  for (let i = 0; i < row.length; i += 3) {
    const count = row[i]!
    const totalCount = row[i + 1]!
    const dataCount = row[i + 2]!
    for (let c = 0; c < count; c += 1) out.push({ totalCount, dataCount })
  }
  return out
}

function bchDigit(n: number): number {
  let d = 0
  let v = n
  while (v !== 0) {
    d += 1
    v >>>= 1
  }
  return d
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)

function bchTypeInfo(data: number): number {
  let d = data << 10
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15))
  return ((data << 10) | d) ^ G15_MASK
}

function bchTypeNumber(data: number): number {
  let d = data << 12
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18))
  return (data << 12) | d
}

function maskBit(pattern: number, r: number, c: number): boolean {
  switch (pattern) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    case 7: return (((r * c) % 3) + ((r + c) % 2)) % 2 === 0
    default: return false
  }
}

class BitBuf {
  readonly bytes: number[] = []
  bitLen = 0
  putBit(bit: boolean): void {
    const idx = Math.floor(this.bitLen / 8)
    if (this.bytes.length <= idx) this.bytes.push(0)
    if (bit) this.bytes[idx] = this.bytes[idx]! | (0x80 >>> (this.bitLen % 8))
    this.bitLen += 1
  }
  put(num: number, length: number): void {
    for (let i = 0; i < length; i += 1) this.putBit(((num >>> (length - i - 1)) & 1) === 1)
  }
}

function chooseVersion(byteLen: number, level: QrEcLevel): number {
  for (let v = 1; v <= RS_BLOCKS.length; v += 1) {
    const blocks = getRsBlocks(v, level)
    const totalData = blocks.reduce((sum, b) => sum + b.dataCount, 0)
    const lenBits = v < 10 ? 8 : 16
    if (4 + lenBits + byteLen * 8 <= totalData * 8) return v
  }
  throw new Error('二维码内容过长')
}

function encodeCodewords(utf8: Uint8Array, version: number, level: QrEcLevel): number[] {
  const rsBlocks = getRsBlocks(version, level)
  const totalDataCount = rsBlocks.reduce((sum, b) => sum + b.dataCount, 0)
  const buf = new BitBuf()
  buf.put(0b0100, 4) // MODE_8BIT_BYTE
  buf.put(utf8.length, version < 10 ? 8 : 16)
  for (const byte of utf8) buf.put(byte, 8)
  if (buf.bitLen + 4 <= totalDataCount * 8) buf.put(0, 4)
  while (buf.bitLen % 8 !== 0) buf.putBit(false)
  let padIdx = 0
  while (buf.bitLen < totalDataCount * 8) {
    buf.put(padIdx % 2 === 0 ? 0xec : 0x11, 8)
    padIdx += 1
  }

  let offset = 0
  let maxDc = 0
  let maxEc = 0
  const dcData: number[][] = []
  const ecData: number[][] = []

  for (const block of rsBlocks) {
    const dcCount = block.dataCount
    const ecCount = block.totalCount - dcCount
    maxDc = Math.max(maxDc, dcCount)
    maxEc = Math.max(maxEc, ecCount)
    const dc = buf.bytes.slice(offset, offset + dcCount).map(x => x & 0xff)
    offset += dcCount
    dcData.push(dc)
    const rsPoly = errorCorrectPoly(ecCount)
    const rawPoly = polyNormalize(dc, rsPoly.length - 1)
    const modPoly = polyMod(rawPoly, rsPoly)
    const ec = new Array<number>(rsPoly.length - 1).fill(0)
    for (let i = 0; i < ec.length; i += 1) {
      const modIdx = i + modPoly.length - ec.length
      ec[i] = modIdx >= 0 ? modPoly[modIdx]! : 0
    }
    ecData.push(ec)
  }

  const out: number[] = []
  for (let i = 0; i < maxDc; i += 1) {
    for (const dc of dcData) if (i < dc.length) out.push(dc[i]!)
  }
  for (let i = 0; i < maxEc; i += 1) {
    for (const ec of ecData) if (i < ec.length) out.push(ec[i]!)
  }
  return out
}

function buildMatrix(version: number, level: QrEcLevel, codewords: readonly number[], test: boolean, mask: number): boolean[][] {
  const n = version * 4 + 17
  const grid: (boolean | null)[][] = Array.from({ length: n }, () => new Array<boolean | null>(n).fill(null))

  const placeProbe = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r < 0 || row + r >= n) continue
      for (let c = -1; c <= 7; c += 1) {
        if (col + c < 0 || col + c >= n) continue
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6))
          || (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        grid[row + r]![col + c] = on
      }
    }
  }
  placeProbe(0, 0)
  placeProbe(n - 7, 0)
  placeProbe(0, n - 7)

  const align = ALIGNMENT_POSITIONS[version - 1] ?? []
  for (const row of align) {
    for (const col of align) {
      if (grid[row]![col] !== null) continue
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          grid[row + r]![col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)
        }
      }
    }
  }

  for (let i = 8; i < n - 8; i += 1) {
    if (grid[i]![6] === null) grid[i]![6] = i % 2 === 0
    if (grid[6]![i] === null) grid[6]![i] = i % 2 === 0
  }

  const infoBits = bchTypeInfo((EC_BITS[level] << 3) | mask)
  for (let i = 0; i < 15; i += 1) {
    const mod = !test && ((infoBits >> i) & 1) === 1
    if (i < 6) grid[i]![8] = mod
    else if (i < 8) grid[i + 1]![8] = mod
    else grid[n - 15 + i]![8] = mod

    if (i < 8) grid[8]![n - i - 1] = mod
    else if (i < 9) grid[8]![15 - i] = mod
    else grid[8]![15 - i - 1] = mod
  }
  grid[n - 8]![8] = !test

  if (version >= 7) {
    const vBits = bchTypeNumber(version)
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && ((vBits >> i) & 1) === 1
      grid[Math.floor(i / 3)]![(i % 3) + n - 11] = mod
      grid[(i % 3) + n - 11]![Math.floor(i / 3)] = mod
    }
  }

  let inc = -1
  let row = n - 1
  let bitIdx = 7
  let byteIdx = 0
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (;;) {
      for (let c = 0; c < 2; c += 1) {
        if (grid[row]![col - c] === null) {
          let dark = false
          if (byteIdx < codewords.length) dark = ((codewords[byteIdx]! >>> bitIdx) & 1) === 1
          if (maskBit(mask, row, col - c)) dark = !dark
          grid[row]![col - c] = dark
          bitIdx -= 1
          if (bitIdx === -1) {
            byteIdx += 1
            bitIdx = 7
          }
        }
      }
      row += inc
      if (row < 0 || row >= n) {
        row -= inc
        inc = -inc
        break
      }
    }
  }

  return grid.map(r => r.map(v => Boolean(v)))
}

function penaltyScore(m: readonly (readonly boolean[])[]): number {
  const n = m.length
  let score = 0
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      let same = 0
      const dark = m[r]![c]!
      for (let dr = -1; dr <= 1; dr += 1) {
        if (r + dr < 0 || r + dr >= n) continue
        for (let dc = -1; dc <= 1; dc += 1) {
          if (c + dc < 0 || c + dc >= n || (dr === 0 && dc === 0)) continue
          if (m[r + dr]![c + dc] === dark) same += 1
        }
      }
      if (same > 5) score += 3 + same - 5
    }
  }
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const cnt = Number(m[r]![c]!) + Number(m[r + 1]![c]!) + Number(m[r]![c + 1]!) + Number(m[r + 1]![c + 1]!)
      if (cnt === 0 || cnt === 4) score += 3
    }
  }
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n - 6; c += 1) {
      if (m[r]![c] && !m[r]![c + 1] && m[r]![c + 2] && m[r]![c + 3] && m[r]![c + 4] && !m[r]![c + 5] && m[r]![c + 6]) {
        score += 40
      }
      if (m[c]![r] && !m[c + 1]![r] && m[c + 2]![r] && m[c + 3]![r] && m[c + 4]![r] && !m[c + 5]![r] && m[c + 6]![r]) {
        score += 40
      }
    }
  }
  let darkCount = 0
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) if (m[r]![c]) darkCount += 1
  }
  score += (Math.abs((100 * darkCount) / (n * n) - 50) / 5) * 10
  return score
}

/** Encode `text` (UTF-8) into a square boolean QR module matrix. */
export function qrCodeMatrix(text: string, level: QrEcLevel = 'M'): boolean[][] {
  const utf8 = Buffer.from(text, 'utf8')
  const version = chooseVersion(utf8.length, level)
  const codewords = encodeCodewords(utf8, version, level)
  let bestMask = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(version, level, codewords, true, mask)
    const s = penaltyScore(candidate)
    if (s < bestScore) {
      bestScore = s
      bestMask = mask
    }
  }
  return buildMatrix(version, level, codewords, false, bestMask)
}

/** Render `text` as a crisp standalone `<svg>` QR code with standard 4-module quiet zone. */
export function qrCodeSvg(text: string, opts: { margin?: number; size?: number; level?: QrEcLevel } = {}): string {
  const matrix = qrCodeMatrix(text, opts.level ?? 'M')
  const margin = opts.margin ?? 4
  const size = opts.size ?? 256
  const total = matrix.length + margin * 2
  const parts: string[] = []
  for (let r = 0; r < matrix.length; r += 1) {
    const row = matrix[r]!
    for (let c = 0; c < row.length; c += 1) {
      if (row[c]) parts.push(`M${c + margin},${r + margin}h1v1h-1z`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${parts.join('')}" fill="#000000"/></svg>`
}

/** Render `text` as a `data:image/svg+xml;base64,...` URI ready for `<img src=...>`. */
export function qrCodeDataUrl(text: string, opts: { margin?: number; size?: number; level?: QrEcLevel } = {}): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrCodeSvg(text, opts), 'utf8').toString('base64')}`
}

/** Render `text` as compact UTF-8 half-block QR art (`▀`, `▄`, `█`, ` `) for CLI / Markdown code blocks. */
export function qrCodeTerminal(text: string, opts: { margin?: number; level?: QrEcLevel } = {}): string {
  const matrix = qrCodeMatrix(text, opts.level ?? 'L')
  const margin = opts.margin ?? 2
  const total = matrix.length + margin * 2
  const isDark = (r: number, c: number): boolean => {
    const mr = r - margin
    const mc = c - margin
    if (mr < 0 || mc < 0 || mr >= matrix.length || mc >= matrix.length) return false
    return Boolean(matrix[mr]?.[mc])
  }
  // White quiet-zone background with dark modules -> invert so dark terminal or light background both keep contrast:
  // Use dark=█? In Markdown light-mode code blocks, █ is black (dark module) and space is white (light module)!
  const lines: string[] = []
  for (let r = 0; r < total; r += 2) {
    let line = ''
    for (let c = 0; c < total; c += 1) {
      const top = isDark(r, c)
      const bot = r + 1 < total ? isDark(r + 1, c) : false
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
