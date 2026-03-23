/**
 * Build version — computed once at process startup.
 *
 * Uses the short git commit hash so every deployment automatically produces
 * a unique SW cache name, eliminating the risk of stale assets when a
 * developer forgets to manually bump the version constant.
 *
 * Fallback: if git is unavailable (e.g. running from a zip archive) we use a
 * startup timestamp truncated to the minute, which changes on every restart
 * and is safe enough for the appliance's single-tenant deployment model.
 */

function computeBuildVersion(): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'])
    if (result.exitCode === 0) {
      const hash = result.stdout.toString().trim()
      if (hash.length > 0) return hash
    }
  } catch {
    // git not in PATH or not a git repo — fall through to timestamp
  }

  // Compact ISO timestamp: "20260323T1430" — changes on every server restart
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', 'T').slice(0, 13).replace(/[^0-9T]/g, '')
}

/** Short git hash of the running commit, e.g. "a3f8d2c". Falls back to a
 *  startup timestamp when git is unavailable. */
export const BUILD_VERSION: string = computeBuildVersion()
