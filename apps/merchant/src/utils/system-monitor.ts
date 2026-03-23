/**
 * system-monitor.ts — Background OS & process sampler + error ring buffer.
 *
 * Starts automatically when this module is first imported.
 * Exports snapshot getters for use by the health route.
 */

import os from 'os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CpuSample {
  /** Unix ms */
  t: number
  /** 0–100 */
  pct: number
}

export interface MemSample {
  /** Unix ms */
  t: number
  /** Process RSS bytes */
  rss: number
  /** Process heap used bytes */
  heapUsed: number
  /** System used bytes */
  sysUsed: number
}

export interface ErrorEntry {
  timestamp: string
  message: string
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const HISTORY_SIZE = 60          // 5 minutes at 5s interval
const ERROR_RING_SIZE = 100

/** Previous CPU tick snapshot for delta calculation */
interface RawCpuTick { idle: number; total: number }
let _prevCpu: RawCpuTick | null = null

const _cpuHistory:  CpuSample[]  = []
const _memHistory:  MemSample[]  = []
const _errorRing:   ErrorEntry[] = []

// ---------------------------------------------------------------------------
// CPU helpers
// ---------------------------------------------------------------------------

function _readCpuTick(): RawCpuTick {
  const cpus = os.cpus()
  let idle = 0, total = 0
  for (const cpu of cpus) {
    const t = cpu.times
    idle  += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

function _sampleCpu(): void {
  const now = _readCpuTick()
  if (_prevCpu) {
    const dTotal = now.total - _prevCpu.total
    const dIdle  = now.idle  - _prevCpu.idle
    const pct    = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0
    _cpuHistory.push({ t: Date.now(), pct })
    if (_cpuHistory.length > HISTORY_SIZE) _cpuHistory.shift()
  }
  _prevCpu = now
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

function _sampleMem(): void {
  const proc = process.memoryUsage()
  const sysUsed = os.totalmem() - os.freemem()
  _memHistory.push({
    t: Date.now(),
    rss:     proc.rss,
    heapUsed: proc.heapUsed,
    sysUsed,
  })
  if (_memHistory.length > HISTORY_SIZE) _memHistory.shift()
}

// ---------------------------------------------------------------------------
// Error ring
// ---------------------------------------------------------------------------

export function pushError(message: string): void {
  _errorRing.push({ timestamp: new Date().toISOString(), message: message.slice(0, 500) })
  if (_errorRing.length > ERROR_RING_SIZE) _errorRing.shift()
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export function stopMonitor(): void {
  clearInterval(_interval)
}

export function getCpuHistory():  CpuSample[]  { return [..._cpuHistory]  }
export function getMemHistory():  MemSample[]  { return [..._memHistory]  }
export function getRecentErrors(): ErrorEntry[] { return [..._errorRing].reverse() }

export function currentCpuPct(): number {
  return _cpuHistory.length > 0 ? _cpuHistory[_cpuHistory.length - 1].pct : 0
}

// ---------------------------------------------------------------------------
// Bootstrap — sample immediately then every 5 s
// ---------------------------------------------------------------------------

_sampleCpu()
_sampleMem()

const _interval = setInterval(() => {
  _sampleCpu()
  _sampleMem()
}, 5_000)

// Don't prevent process exit
if (typeof _interval.unref === 'function') _interval.unref()
