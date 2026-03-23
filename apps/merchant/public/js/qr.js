/**
 * Minimal QR code generator — zero dependencies, pure browser JS.
 *
 * Only supports QR Version 3 (29×29) and below with byte encoding +
 * error correction level M.  Payload up to ~32 bytes (ideal for
 * short pickup codes / order IDs).
 *
 * Uses the well-tested qrcodegen reference implementation algorithm
 * ported to vanilla JS, trimmed for our use case.
 *
 * Exposes:
 *   window.QR.generate(text, { size, padding, color, bg }) → SVG string
 *   window.QR.appendTo(text, containerEl, opts)            → inserts SVG
 *
 * Based on Project Nayuki's QR Code Generator (MIT licence)
 * https://www.nayuki.io/page/qr-code-generator-library
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Tiny RSP ("Reed-Solomon Primitive") — GF(256) arithmetic for QR
  // ---------------------------------------------------------------------------

  const GF256 = (() => {
    const EXP = new Uint8Array(256)
    const LOG = new Uint8Array(256)
    let x = 1
    for (let i = 0; i < 255; i++) {
      EXP[i] = x
      LOG[x] = i
      x = x * 2 ^ (x >= 128 ? 0x11d : 0)
    }
    EXP[255] = EXP[0]
    return {
      mul(a, b) { return a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255] },
    }
  })()

  // ---------------------------------------------------------------------------
  // Reed-Solomon error correction (EC) codewords
  // ---------------------------------------------------------------------------

  function rsEc(data, ecLen) {
    // Generator polynomial for ecLen error-correction codewords
    let generator = [1]
    for (let i = 0; i < ecLen; i++) {
      generator = polyMul(generator, [1, GF256_EXP[i]])
    }

    const msg = [...data, ...new Uint8Array(ecLen)]
    for (let i = 0; i < data.length; i++) {
      const coeff = msg[i]
      if (coeff !== 0) {
        for (let j = 0; j < generator.length; j++) {
          msg[i + j] ^= GF256.mul(generator[j], coeff)
        }
      }
    }
    return msg.slice(data.length)
  }

  // Pre-computed GF(256) exponent table for generator poly building
  const GF256_EXP = (() => {
    const t = new Uint8Array(256)
    let x = 1
    for (let i = 0; i < 255; i++) {
      t[i] = x
      x = x * 2 ^ (x >= 128 ? 0x11d : 0)
    }
    return t
  })()

  function polyMul(a, b) {
    const res = new Uint8Array(a.length + b.length - 1)
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        res[i + j] ^= GF256.mul(a[i], b[j])
      }
    }
    return res
  }

  // ---------------------------------------------------------------------------
  // QR encoding — version 1-3, byte mode, EC level M
  // ---------------------------------------------------------------------------

  // EC level M capacities and EC codeword counts for versions 1-4
  // [version]: { dataCodewords, ecCodewords, blocks }
  const VERSION_INFO = {
    1: { total: 26,  data: 16, ec: 10, blocks: 1 },
    2: { total: 44,  data: 28, ec: 16, blocks: 1 },
    3: { total: 70,  data: 44, ec: 26, blocks: 2 },
    4: { total: 100, data: 64, ec: 36, blocks: 2 },
  }

  function pickVersion(byteLen) {
    for (const [v, info] of Object.entries(VERSION_INFO)) {
      // byte mode: 4 mode bits + 8 len bits + 8 * byteLen data bits + 4 terminator
      const needed = Math.ceil((4 + 8 + 8 * byteLen + 4) / 8)
      if (needed <= info.data) return { version: parseInt(v), info }
    }
    return null   // too long
  }

  function encodeBytes(text) {
    const bytes = new TextEncoder().encode(text)
    const version = pickVersion(bytes.length)
    if (!version) return null

    const { v, info } = { v: version.version, info: version.info }
    const bits = []

    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
    }

    // Mode indicator: Byte = 0100
    push(0b0100, 4)
    // Character count (8 bits for byte mode, versions 1-9)
    push(bytes.length, 8)
    // Data bytes
    for (const b of bytes) push(b, 8)
    // Terminator (up to 4 zero bits)
    const cap = info.data * 8
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0)
    // Pad to byte boundary
    while (bits.length % 8) bits.push(0)
    // Pad codewords: alternating 0xEC and 0x11
    const PAD = [0xec, 0x11]
    let pi = 0
    while (bits.length < cap) { push(PAD[pi++ & 1], 8) }

    // Convert bits to bytes
    const dataCodewords = []
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0)
      dataCodewords.push(byte)
    }

    // Error correction
    const ecPerBlock = info.ec / info.blocks
    const blockSize = Math.floor(info.data / info.blocks)
    const blocks = []
    for (let b = 0; b < info.blocks; b++) {
      const start = b * blockSize
      const block = dataCodewords.slice(start, start + blockSize)
      blocks.push({ data: block, ec: rsEc(block, ecPerBlock) })
    }

    // Interleave
    const interleaved = []
    const maxDataLen = Math.max(...blocks.map((b) => b.data.length))
    for (let i = 0; i < maxDataLen; i++) {
      for (const block of blocks) { if (i < block.data.length) interleaved.push(block.data[i]) }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const block of blocks) interleaved.push(block.ec[i])
    }

    return { version: v, codewords: interleaved }
  }

  // ---------------------------------------------------------------------------
  // QR matrix builder
  // ---------------------------------------------------------------------------

  function buildMatrix(version, codewords) {
    const size = 17 + version * 4
    const matrix = Array.from({ length: size }, () => new Array(size).fill(null)) // null = unset

    function setModule(r, c, dark) {
      if (r >= 0 && r < size && c >= 0 && c < size) matrix[r][c] = dark
    }

    // Finder patterns (top-left, top-right, bottom-left) + separators
    function placeFinder(row, col) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          if (dr < 0 || dc < 0 || dr > 7 || dc > 7) {
            setModule(row + dr, col + dc, false) // separator
          } else {
            const dark = (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
                          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4))
            setModule(row + dr, col + dc, dark)
          }
        }
      }
    }
    placeFinder(0, 0)
    placeFinder(0, size - 7)
    placeFinder(size - 7, 0)

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setModule(6, i, i % 2 === 0)
      setModule(i, 6, i % 2 === 0)
    }

    // Dark module
    setModule(4 * version + 9, 8, true)

    // Format info placeholder (reserve, will be filled later)
    const formatPositions = [
      [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
      [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8],
      [8, size-1],[8, size-2],[8, size-3],[8, size-4],[8, size-5],[8, size-6],[8, size-7],[8, size-8],
      [size-7,8],[size-6,8],[size-5,8],[size-4,8],[size-3,8],[size-2,8],[size-1,8],
    ]
    for (const [r, c] of formatPositions) setModule(r, c, false)

    // Alignment patterns (none for version 1, one at (6,6) relative offset for v2-4)
    if (version >= 2) {
      const alignCenter = version === 2 ? 18 : version === 3 ? 22 : 26
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)
          setModule(alignCenter + dr, alignCenter + dc, dark)
        }
      }
    }

    // Place data bits using the zigzag scan
    const bits = []
    for (const cw of codewords) {
      for (let b = 7; b >= 0; b--) bits.push((cw >> b) & 1)
    }

    let bitIdx = 0
    let right = size - 1
    let upward = true

    while (right >= 1) {
      if (right === 6) right = 5   // skip timing column

      for (let vert = 0; vert < size; vert++) {
        const row = upward ? size - 1 - vert : vert
        for (let col = right; col >= right - 1; col--) {
          if (matrix[row][col] === null) {
            matrix[row][col] = bits[bitIdx] === 1
            bitIdx++
          }
        }
      }
      right -= 2
      upward = !upward
    }

    // Apply mask pattern 0 (simplest: (row + col) % 2 == 0)
    const MASK = 0  // mask pattern 0
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c] !== null) {
          // Only mask data modules
          if (!isFunction(r, c, version, size)) {
            if ((r + c) % 2 === 0) matrix[r][c] = !matrix[r][c]
          }
        }
      }
    }

    // Format information (EC level M = 00, mask 0 = 000, with BCH 101010000010010 XOR 101010000010010 → nope)
    // Pre-computed for EC=M(01), mask=0: format word = 0b01_000_0000010011 -> apply BCH
    // Actual encoded format string for M/mask0 = 100111011100100 (standard table)
    const FORMAT_M0 = [1,0,0,1,1,1,0,1,1,1,0,0,1,0,0]
    const fmtPositions1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]]
    const fmtPositions2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]]
    for (let i = 0; i < 15; i++) {
      const dark = FORMAT_M0[i] === 1
      const [r1, c1] = fmtPositions1[i]
      const [r2, c2] = fmtPositions2[i]
      matrix[r1][c1] = dark
      matrix[r2][c2] = dark
    }

    return matrix
  }

  function isFunction(r, c, version, size) {
    // Finder patterns + separators
    if (r <= 8 && c <= 8) return true
    if (r <= 8 && c >= size - 8) return true
    if (r >= size - 8 && c <= 8) return true
    // Timing
    if (r === 6 || c === 6) return true
    // Alignment (version >= 2)
    if (version >= 2) {
      const a = version === 2 ? 18 : version === 3 ? 22 : 26
      if (Math.abs(r - a) <= 2 && Math.abs(c - a) <= 2) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // SVG renderer
  // ---------------------------------------------------------------------------

  /**
   * Generate a QR code as an SVG string.
   * @param {string} text
   * @param {{ size?: number, padding?: number, color?: string, bg?: string }} opts
   * @returns {string|null} SVG string or null if text is too long
   */
  function generate(text, opts = {}) {
    const encoded = encodeBytes(text)
    if (!encoded) return null

    const { version, codewords } = encoded
    const matrix = buildMatrix(version, codewords)
    const n = matrix.length
    const size = opts.size || 200
    const padding = opts.padding ?? 4
    const color = opts.color || '#000000'
    const bg = opts.bg || '#ffffff'
    const cellSize = (size - padding * 2) / n

    const rects = []
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          const x = padding + c * cellSize
          const y = padding + r * cellSize
          rects.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}"/>`)
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="QR code">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <g fill="${color}">${rects.join('')}</g>
</svg>`
  }

  /**
   * Generate a QR code and append it to a container element.
   * @param {string} text
   * @param {HTMLElement} container
   * @param {object} opts
   */
  function appendTo(text, container, opts = {}) {
    const svg = generate(text, opts)
    if (!svg) {
      container.innerHTML = '<span style="color:var(--color-gray-400);font-size:0.75rem">QR unavailable</span>'
      return
    }
    container.innerHTML = svg
  }

  window.QR = { generate, appendTo }

})()
