/**
 * manager-receipts.js — IndexedDB offline receipt queue + Background Sync
 *
 * Exposes: window.ManagerReceipts
 *
 * IndexedDB: 'kizo-manager' v1
 *   store: 'pending_receipts'  keyPath: 'id'
 *   Row: { id, files, status, merchantId, accessToken,
 *           capturedAt, uploadedAt?, receiptId?, errorMessage? }
 */
;(function () {
  'use strict'

  const DB_NAME    = 'kizo-manager'
  const DB_VERSION = 1
  const STORE_NAME = 'pending_receipts'
  const SYNC_TAG   = 'sync-receipts'
  const BC_NAME    = 'manager-sync'

  // ── Low-level IDB helpers ─────────────────────────────────────────────────

  /** @returns {Promise<IDBDatabase>} */
  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = /** @type {IDBDatabase} */ (e.target.result)
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        }
      }
      req.onsuccess  = (e) => resolve(/** @type {IDBDatabase} */ (e.target.result))
      req.onerror    = (e) => reject(e.target.error)
      req.onblocked  = ()  => reject(new Error('IDB blocked'))
    })
  }

  function _tx(db, mode) {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
  }

  function _idbAll(store) {
    return new Promise((resolve, reject) => {
      const r = store.getAll()
      r.onsuccess = (e) => resolve(e.target.result)
      r.onerror   = (e) => reject(e.target.error)
    })
  }

  function _idbGet(store, key) {
    return new Promise((resolve, reject) => {
      const r = store.get(key)
      r.onsuccess = (e) => resolve(e.target.result)
      r.onerror   = (e) => reject(e.target.error)
    })
  }

  function _idbPut(store, val) {
    return new Promise((resolve, reject) => {
      const r = store.put(val)
      r.onsuccess = (e) => resolve(e.target.result)
      r.onerror   = (e) => reject(e.target.error)
    })
  }

  function _idbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const r = store.delete(key)
      r.onsuccess = (e) => resolve(e.target.result)
      r.onerror   = (e) => reject(e.target.error)
    })
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  function _makeId(merchantId) {
    const date = new Date()
    const ymd  = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map(b => b.toString(16).padStart(2, '0')).join('')
    return `${merchantId}-${ymd}-${rand}`
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Add one or more image files to the pending queue.
   * @param {FileList|File[]} files
   * @param {string} merchantId
   * @param {string} accessToken  current Bearer token, stored so the SW can send it
   * @param {string} [vendorOverride]  pre-selected supplier name; overrides OCR vendor detection
   * @returns {Promise<string>} the queued entry id
   */
  async function queueReceipt(files, merchantId, accessToken, vendorOverride = '') {
    const filesArr = Array.from(files)
    if (!filesArr.length) throw new Error('No files provided')

    const MAX_BYTES = 50 * 1024 * 1024
    for (const f of filesArr) {
      if (f.size > MAX_BYTES) throw new Error(`File "${f.name}" exceeds 50 MB limit`)
      if (!f.type.startsWith('image/')) throw new Error(`File "${f.name}" is not an image`)
    }

    const id  = _makeId(merchantId)
    const row = {
      id,
      files:          filesArr,
      status:         'queued',
      merchantId,
      accessToken,
      capturedAt:     new Date().toISOString(),
      vendorOverride: vendorOverride || undefined,
    }

    const db   = await _openDB()
    const store = _tx(db, 'readwrite')
    await _idbPut(store, row)
    db.close()

    await _registerSync()
    return id
  }

  /**
   * List all pending_receipts entries (all statuses).
   * @returns {Promise<Array>}
   */
  async function listAll() {
    const db    = await _openDB()
    const store = _tx(db, 'readonly')
    const rows  = await _idbAll(store)
    db.close()
    return rows
  }

  /**
   * Count records with status 'queued' or 'error'.
   * @returns {Promise<number>}
   */
  async function pendingCount() {
    const rows = await listAll()
    return rows.filter(r => r.status === 'queued' || r.status === 'error').length
  }

  /**
   * Remove a receipt entry entirely (manager discards failed upload).
   * @param {string} id
   */
  async function discardReceipt(id) {
    const db    = await _openDB()
    const store = _tx(db, 'readwrite')
    await _idbDelete(store, id)
    db.close()
  }

  /**
   * Retry a failed receipt (reset status to 'queued', update accessToken).
   * @param {string} id
   * @param {string} accessToken
   */
  async function retryReceipt(id, accessToken) {
    const db    = await _openDB()
    const store = _tx(db, 'readwrite')
    const row   = await _idbGet(store, id)
    if (row && (row.status === 'error' || row.status === 'uploading')) {
      row.status      = 'queued'
      row.accessToken = accessToken
      row.retryCount  = 0
      delete row.errorMessage
      await _idbPut(store, row)
      await _registerSync()
    }
    db.close()
  }

  /**
   * Update the stored accessToken for all queued/error entries.
   * Called after token refresh so the SW always uses a fresh token.
   * @param {string} accessToken
   */
  async function refreshTokens(accessToken) {
    const db    = await _openDB()
    const store = _tx(db, 'readwrite')
    const rows  = await _idbAll(store)
    for (const row of rows) {
      if (row.status === 'queued' || row.status === 'error') {
        row.accessToken = accessToken
        await _idbPut(store, row)
      }
    }
    db.close()
  }

  // ── Sync registration ─────────────────────────────────────────────────────

  async function _registerSync() {
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const reg = await navigator.serviceWorker.ready
        await reg.sync.register(SYNC_TAG)
        return
      } catch {
        // Background Sync not supported — fall through to inline attempt
      }
    }
    // Fallback: if page is visible and online, attempt immediate upload
    if (navigator.onLine) _attemptImmediateUpload()
  }

  // Keep in sync with MAX_RETRIES in sw.js — both paths must agree on the cap.
  const MAX_RETRIES = 5

  // Prevents concurrent foreground upload runs from racing on the same IDB rows.
  let _uploadInFlight = false

  /**
   * Attempt immediate upload for all queued receipts (foreground fallback).
   * Used when Background Sync is not available or as supplementary trigger.
   */
  async function _attemptImmediateUpload() {
    if (_uploadInFlight) return
    _uploadInFlight = true
    try {
      await _doUpload()
    } finally {
      _uploadInFlight = false
    }
  }

  async function _doUpload() {
    const db = await _openDB()
    const bc = new BroadcastChannel(BC_NAME)

    // Crash recovery: rows left at 'uploading' AND older than the fetch timeout
    // (90 s) are reset to 'queued' so they can be retried. Rows marked uploading
    // within the last 90 s are skipped — they belong to a concurrent in-flight
    // upload and must not be reset, or we risk duplicate POSTs.
    const allRows = await _idbAll(_tx(db, 'readonly'))
    for (const row of allRows) {
      if (row.status === 'uploading' && (Date.now() - (row.uploadingStartedAt ?? 0)) > 90_000) {
        row.status     = 'queued'
        row.retryCount = 0
        delete row.uploadingStartedAt
        await _idbPut(_tx(db, 'readwrite'), row)
      }
    }

    const rows = await _idbAll(_tx(db, 'readonly'))
    const queued = rows.filter(r => r.status === 'queued')
    if (!queued.length) { db.close(); bc.close(); return }

    for (const row of queued) {
      row.status = 'uploading'
      row.uploadingStartedAt = Date.now()
      await _idbPut(_tx(db, 'readwrite'), row)

      // Notify UI of status change
      bc.postMessage({ type: 'queue-updated' })

      try {
        const fd = new FormData()
        fd.append('name', row.id)
        for (const file of row.files) fd.append('files', file)
        if (row.vendorOverride) fd.append('vendor', row.vendorOverride)

        const res = await fetch(
          `/api/merchants/${row.merchantId}/manager/receipts`,
          {
            method:  'POST',
            headers: { Authorization: `Bearer ${row.accessToken}` },
            body:    fd,
            signal:  AbortSignal.timeout(90_000),
          }
        )

        const s = _tx(db, 'readwrite')
        if (res.status === 201 || res.status === 200) {
          const data   = await res.json()
          row.status    = 'done'
          row.receiptId = data.receiptId
          row.uploadedAt = new Date().toISOString()
          row.retryCount = 0
          delete row.files
          await _idbPut(s, row)
          bc.postMessage({ type: 'receipt-synced', id: row.id, receiptId: data.receiptId })
        } else if (res.status >= 400 && res.status < 500) {
          let errMsg = `Upload failed (${res.status})`
          try {
            const errData = await res.json()
            if (errData.detail) errMsg += ': ' + errData.detail
            else if (errData.error) errMsg += ': ' + errData.error
          } catch { /* non-JSON body, keep generic message */ }
          row.status       = 'error'
          row.errorMessage = errMsg
          await _idbPut(s, row)
          bc.postMessage({ type: 'receipt-error', id: row.id, error: row.errorMessage })
        } else {
          // 5xx — requeue up to MAX_RETRIES, then surface as error
          const retries = (row.retryCount ?? 0) + 1
          if (retries >= MAX_RETRIES) {
            row.status       = 'error'
            row.errorMessage = `Upload failed after ${MAX_RETRIES} attempts (server error ${res.status})`
            row.retryCount   = 0
          } else {
            row.status     = 'queued'
            row.retryCount = retries
          }
          await _idbPut(s, row)
          if (row.status === 'error') {
            bc.postMessage({ type: 'receipt-error', id: row.id, error: row.errorMessage })
          }
        }
      } catch {
        const s2 = _tx(db, 'readwrite')
        const retries = (row.retryCount ?? 0) + 1
        if (retries >= MAX_RETRIES) {
          row.status       = 'error'
          row.errorMessage = `Upload failed after ${MAX_RETRIES} attempts (network error)`
          row.retryCount   = 0
          bc.postMessage({ type: 'receipt-error', id: row.id, error: row.errorMessage })
        } else {
          row.status     = 'queued'
          row.retryCount = retries
        }
        await _idbPut(s2, row)
      }

      bc.postMessage({ type: 'queue-updated' })
    }

    db.close()
    bc.close()
  }

  /**
   * Start listening for BroadcastChannel messages from the SW and for
   * the browser 'online' event to trigger fallback uploads.
   * Call once after successful authentication.
   * @param {function} onQueueChange  called with no args whenever queue changes
   */
  function startSync(onQueueChange) {
    const bc = new BroadcastChannel(BC_NAME)
    bc.addEventListener('message', (e) => {
      if (
        e.data.type === 'receipt-synced' ||
        e.data.type === 'receipt-error'  ||
        e.data.type === 'queue-updated'
      ) {
        if (typeof onQueueChange === 'function') onQueueChange()
      }
    })

    window.addEventListener('online', () => {
      _registerSync()
    })

    // Only attempt immediate upload if Background Sync is unavailable.
    // When SyncManager is present the SW's syncReceipts() handles it; calling
    // _attemptImmediateUpload() here too causes both paths to race on the same row.
    if (navigator.onLine && !('SyncManager' in window)) _attemptImmediateUpload().catch(() => {})
  }

  // ── Service worker registration ───────────────────────────────────────────

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/manager-app/sw.js', { scope: '/manager-app/' })
      .catch(err => console.warn('[manager-sw] registration failed:', err))
  }

  // ── Export ────────────────────────────────────────────────────────────────

  window.ManagerReceipts = {
    queueReceipt,
    listAll,
    pendingCount,
    discardReceipt,
    retryReceipt,
    refreshTokens,
    startSync,
    registerServiceWorker,
  }
})()
