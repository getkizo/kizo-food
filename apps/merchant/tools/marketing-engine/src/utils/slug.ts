/**
 * Slug normalization — strip non-alphanumeric characters and uppercase.
 * Accepts 'VP-2606-KIR', 'vp2606kir', 'VP2606KIR' — all normalize to 'VP2606KIR'.
 */
export function normalizeSlug(raw: string): string {
  return raw.replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

/** Validate slug format before storing: 1–24 alphanumeric + hyphen chars. */
export function isValidSlug(raw: string): boolean {
  return /^[A-Z0-9-]{1,24}$/i.test(raw)
}
