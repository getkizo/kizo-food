/**
 * Generate PNG icons for the PWA from the SVG source.
 * Run: bun run scripts/generate-icons.ts
 *
 * Requires: bun install sharp
 * (sharp is a native image processing library for Node/Bun)
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const iconsDir = join(import.meta.dir, '../public/icons')

if (!existsSync(iconsDir)) {
  mkdirSync(iconsDir, { recursive: true })
}

// Check if sharp is available
let sharp: any
try {
  sharp = (await import('sharp')).default
} catch {
  console.log('📦 sharp not installed. Installing...')
  const proc = Bun.spawn(['bun', 'add', 'sharp'], { stdio: ['inherit', 'inherit', 'inherit'] })
  await proc.exited
  sharp = (await import('sharp')).default
}

const svgPath = join(iconsDir, 'icon.svg')
const svgBuffer = await Bun.file(svgPath).arrayBuffer()

const sizes = [
  { size: 72, name: 'badge-72.png' },
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
]

for (const { size, name } of sizes) {
  const outPath = join(iconsDir, name)
  await sharp(Buffer.from(svgBuffer))
    .resize(size, size)
    .png()
    .toFile(outPath)
  console.log(`✅ Generated ${name} (${size}x${size})`)
}

console.log('\n🎉 Icons generated in public/icons/')
