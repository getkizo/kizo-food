/**
 * Background Sync client
 *
 * Wraps API calls for menu stock updates and order status changes.
 * When the request fails (offline / spotty connection), the payload is
 * persisted to IndexedDB and replayed by the service worker via the
 * Background Sync API when connectivity is restored.
 *
 * Usage (replaces direct fetch calls):
 *   await Sync.stockUpdate(merchantId, itemId, 'out_today', token)
 *   await Sync.orderStatus(merchantId, orderId, 'ready', token)
 *
 * The service worker (sw.js) calls openSyncDB() and drains the queues on
 * the 'sync' event with tags 'sync-stock-updates' and 'sync-order-status'.
 */

;(function () {
  'use strict'

  const IDB_NAME = 'kizo-sync'
  const IDB_VERSION = 1
  const STORE_STOCK = 'stockQueue'
  const STORE_ORDER = 'orderQueue'
  const SYNC_TAG_STOCK = 'sync-stock-updates'
  const SYNC_TAG_ORDER = 'sync-order-status'

  // -------------------------------------------------------------------------
  // IndexedDB helpers
  // -------------------------------------------------------------------------

  let _db = null

  function openDB() {
    if (_db) return Promise.resolve(_db)
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(STORE_STOCK)) {
          db.createObjectStore(STORE_STOCK, { autoIncrement: true })
        }
        if (!db.objectStoreNames.contains(STORE_ORDER)) {
          db.createObjectStore(STORE_ORDER, { autoIncrement: true })
        }
      }
      req.onsuccess = (e) => {
        _db = e.target.result
        resolve(_db)
      }
      req.onerror = () => reject(req.error)
    })
  }

  function enqueue(storeName, payload) {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).add(payload)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
    })
  }

  // -------------------------------------------------------------------------
  // Background Sync registration
  // -------------------------------------------------------------------------

  async function registerSync(tag) {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return
    try {
      const reg = await navigator.serviceWorker.ready
      await reg.sync.register(tag)
    } catch (err) {
      console.warn('[Sync] Could not register background sync:', err)
    }
  }

  // -------------------------------------------------------------------------
  // Sync indicator UI
  // -------------------------------------------------------------------------

  const indicator = document.getElementById('sync-indicator')
  const indicatorText = document.getElementById('sync-indicator-text')
  let syncTimeout = null

  function showSyncIndicator(text) {
    if (!indicator) return
    if (indicatorText) indicatorText.textContent = text
    indicator.hidden = false
    // Safety net: auto-hide after 30s if SYNC_DONE never arrives
    clearTimeout(syncTimeout)
    syncTimeout = setTimeout(() => { indicator.hidden = true }, 30_000)
  }

  function hideSyncIndicator() {
    if (!indicator) return
    clearTimeout(syncTimeout)
    syncTimeout = null
    indicator.hidden = true
  }

  // Listen for messages from the service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const { type, queue, count } = event.data || {}
      if (type === 'SYNC_START') {
        showSyncIndicator(`Syncing ${count} pending update${count !== 1 ? 's' : ''}…`)
      } else if (type === 'SYNC_DONE') {
        hideSyncIndicator()
        // Refresh whichever section is relevant
        if (queue === 'stock') {
          window.dispatchEvent(new Event('voice:refreshMenu'))
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Update a menu item's stock status.
   * Falls back to Background Sync queue if the request fails.
   */
  async function stockUpdate(merchantId, itemId, stockStatus, token) {
    const url = `/api/merchants/${merchantId}/menu/items/${itemId}`
    const options = {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ stockStatus }),
    }

    try {
      const res = await fetch(url, options)
      if (res.ok) return { ok: true, queued: false }

      // Server error (5xx) — queue for retry
      if (res.status >= 500) throw new Error(`Server error ${res.status}`)

      // Client error (4xx) — don't retry, surface immediately
      return { ok: false, queued: false, status: res.status }
    } catch {
      // Network failure — queue for background sync
      await enqueue(STORE_STOCK, {
        url,
        method: 'PUT',
        headers: options.headers,
        body: options.body,
        queuedAt: new Date().toISOString(),
      })
      await registerSync(SYNC_TAG_STOCK)
      showSyncIndicator('Queued — will sync when connected')
      setTimeout(hideSyncIndicator, 3000)
      return { ok: false, queued: true }
    }
  }

  /**
   * Update an order's status.
   * Falls back to Background Sync queue if the request fails.
   */
  async function orderStatus(merchantId, orderId, status, token) {
    const url = `/api/merchants/${merchantId}/orders/${orderId}/status`
    const options = {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ status }),
    }

    try {
      const res = await fetch(url, options)
      if (res.ok) return { ok: true, queued: false }
      if (res.status >= 500) throw new Error(`Server error ${res.status}`)
      return { ok: false, queued: false, status: res.status }
    } catch {
      await enqueue(STORE_ORDER, {
        url,
        method: 'PATCH',
        headers: options.headers,
        body: options.body,
        queuedAt: new Date().toISOString(),
      })
      await registerSync(SYNC_TAG_ORDER)
      showSyncIndicator('Order update queued — will sync when connected')
      setTimeout(hideSyncIndicator, 3000)
      return { ok: false, queued: true }
    }
  }

  // -------------------------------------------------------------------------
  // Expose globally
  // -------------------------------------------------------------------------

  window.Sync = { stockUpdate, orderStatus }

})()
