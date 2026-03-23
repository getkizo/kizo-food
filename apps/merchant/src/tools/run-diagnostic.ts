#!/usr/bin/env bun
/**
 * Run printer diagnostic directly from the command line.
 *
 * Usage:
 *   bun run v2/src/tools/run-diagnostic.ts
 *   bun run v2/src/tools/run-diagnostic.ts 192.168.1.179
 */

import { printDiagnostic } from '../services/printer'

const ip = process.argv[2] || '192.168.1.179'

console.log(`\n========================================`)
console.log(`  Printer Diagnostic — ${ip}`)
console.log(`========================================`)
console.log(`  Sending 8 test pages with different`)
console.log(`  page-end signals and ASB modes.`)
console.log(`  Watch the printer for any output...`)
console.log(`========================================\n`)

await printDiagnostic(ip)

console.log(`\nDone. If nothing printed, the issue is firmware-level.`)
