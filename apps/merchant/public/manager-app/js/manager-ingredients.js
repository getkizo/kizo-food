/**
 * manager-ingredients.js — Ingredient price lookup (offline-first)
 *
 * Uses a dedicated IDB database ('kizo-manager-prices') so it doesn't
 * conflict with the receipt-queue DB version managed by the Service Worker.
 *
 * IDB version history:
 *   v1: ingredient_snapshot (keyPath: 'description')
 *   v2: ingredient_snapshot (keyPath: 'key' = desc|vendor|unit) + offline_cache store
 *
 * Exposes window.ManagerIngredients:
 *   prefetchSnapshot(apiFetch, merchantId)              — cache snapshot on boot (background)
 *   searchSnapshot(query)                               — search IDB (works offline)
 *   fetchHistory(query, apiFetch, merchantId, vendor?)  — 30-day history for chart (online only)
 *   cacheStore(cacheKey, data)                          — persist arbitrary data for offline use
 *   loadCache(cacheKey)                                 — retrieve cached data (null if missing)
 */
;(function () {
  'use strict'

  const IDB_NAME    = 'kizo-manager-prices'
  const IDB_VER     = 2   // v1: description keyPath; v2: composite key + offline_cache store
  const STORE       = 'ingredient_snapshot'
  const CACHE_STORE = 'offline_cache'

  // ── IDB helpers ──────────────────────────────────────────────────────────────

  /** @returns {Promise<IDBDatabase>} */
  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER)
      req.onupgradeneeded = (e) => {
        const db     = e.target.result
        const oldVer = e.oldVersion
        if (oldVer < 2) {
          // v1 used 'description' as keyPath — delete and recreate with composite key
          if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE)
          db.createObjectStore(STORE, { keyPath: 'key' })
          if (!db.objectStoreNames.contains(CACHE_STORE)) {
            db.createObjectStore(CACHE_STORE, { keyPath: 'cacheKey' })
          }
        }
      }
      req.onsuccess = (e) => resolve(e.target.result)
      req.onerror   = (e) => reject(e.target.error)
    })
  }

  /** Clear the snapshot store and write all items atomically, adding composite key. */
  async function _clearAndWrite(items) {
    const db = await _openDB()
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      store.clear()
      items.forEach((item) => store.put({
        ...item,
        key: `${item.description}|${item.vendor ?? ''}|${item.unit ?? ''}`,
      }))
      tx.oncomplete = resolve
      tx.onerror    = (e) => reject(e.target.error)
    })
    db.close()
  }

  /**
   * Linear scan matching query against description (case-insensitive).
   * Returns all (description, vendor, unit) combinations that match.
   * @param {string} query
   * @returns {Promise<Array>}
   */
  async function _searchIDB(query) {
    const db = await _openDB()
    const q  = query.toLowerCase().trim()
    return new Promise((resolve, reject) => {
      const tx      = db.transaction(STORE, 'readonly')
      const store   = tx.objectStore(STORE)
      const results = []
      const req     = store.openCursor()
      req.onsuccess = (e) => {
        const cursor = e.target.result
        if (cursor) {
          if (cursor.value.description.toLowerCase().includes(q)) results.push(cursor.value)
          cursor.continue()
        } else {
          db.close()
          resolve(results)
        }
      }
      req.onerror = (e) => { db.close(); reject(e.target.error) }
    })
  }

  /**
   * Store arbitrary data in the offline cache keyed by cacheKey.
   * @param {string} cacheKey
   * @param {any} data
   * @returns {Promise<void>}
   */
  async function _cacheStore(cacheKey, data) {
    const db = await _openDB()
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(CACHE_STORE, 'readwrite')
      const store = tx.objectStore(CACHE_STORE)
      store.put({ cacheKey, data, savedAt: new Date().toISOString() })
      tx.oncomplete = resolve
      tx.onerror    = (e) => reject(e.target.error)
    })
    db.close()
  }

  /**
   * Retrieve cached data by key. Returns null if not found.
   * @param {string} cacheKey
   * @returns {Promise<any>}
   */
  async function _loadCache(cacheKey) {
    const db = await _openDB()
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(CACHE_STORE, 'readonly')
      const store = tx.objectStore(CACHE_STORE)
      const req   = store.get(cacheKey)
      req.onsuccess = (e) => { db.close(); resolve(e.target.result?.data ?? null) }
      req.onerror   = (e) => { db.close(); reject(e.target.error) }
    })
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Fetch all ingredient prices from server and write to IDB.
   * Called once in background after auth. Silent on failure.
   * @param {function} apiFetch
   * @param {string} merchantId
   */
  async function prefetchSnapshot(apiFetch, merchantId) {
    try {
      const res = await apiFetch(
        `/api/merchants/${merchantId}/manager/ingredients/price-snapshot`
      )
      if (!res.ok) return
      const { items } = await res.json()
      if (Array.isArray(items) && items.length) await _clearAndWrite(items)
    } catch { /* silent — server may be unreachable */ }
  }

  /**
   * Search the local IDB snapshot. Works offline.
   * Returns all (description, vendor, unit) variants that match the query.
   * @param {string} query
   * @returns {Promise<Array<{key, description, lastPrice, lastDate, vendor, unit}>>}
   */
  async function searchSnapshot(query) {
    if (!query.trim()) return []
    try { return await _searchIDB(query) }
    catch { return [] }
  }

  /**
   * Fetch 30-day price history from server for a specific ingredient+vendor.
   * Throws on network failure so the caller can detect offline state.
   * @param {string} query
   * @param {function} apiFetch
   * @param {string} merchantId
   * @param {string} [vendor] — optional vendor filter for vendor-specific chart
   * @returns {Promise<{query, lastPrice, lastDate, vendor, unit, history: Array}>}
   */
  async function fetchHistory(query, apiFetch, merchantId, vendor = '') {
    let url = `/api/merchants/${merchantId}/manager/ingredients/price-history?q=${encodeURIComponent(query)}`
    if (vendor) url += `&vendor=${encodeURIComponent(vendor)}`
    const res = await apiFetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  window.ManagerIngredients = {
    prefetchSnapshot,
    searchSnapshot,
    fetchHistory,
    cacheStore: _cacheStore,
    loadCache:  _loadCache,
  }
})()
