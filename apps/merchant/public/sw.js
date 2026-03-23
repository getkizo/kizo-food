/**
 * Kizo Register — Service Worker
 *
 * Responsibilities:
 *   1. Cache app shell for resilience on spotty connections
 *   2. Handle Web Push notifications (new orders, payment confirmed)
 *   3. Network-first strategy for API calls with graceful fallback
 *
 * Cache strategy:
 *   - Static assets (CSS/JS/icons): Cache-first (long-lived, versioned by CACHE_NAME)
 *   - API calls (/api/*): Network-first, no caching (always need fresh data)
 *   - HTML pages: Network-first, fall back to cached shell
 */

const CACHE_NAME = 'merchant-__BUILD__'

const APP_SHELL = [
  '/merchant',
  '/css/styles.css?v=3',
  '/css/dashboard.css?v=50',
  '/css/order-entry.css?v=20',
  '/js/dashboard.js?v=83',
  '/js/order-entry.js?v=32',
  '/js/sync.js?v=3',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json',
]

// ---------------------------------------------------------------------------
// Install — cache the app shell
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache what we can; don't fail install if a resource is missing
      return Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => {
            console.warn(`[SW] Could not cache: ${url}`)
          })
        )
      )
    }).then(() => {
      // Activate immediately without waiting for old tabs to close
      return self.skipWaiting()
    })
  )
})

// ---------------------------------------------------------------------------
// Activate — clean up old caches
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log(`[SW] Deleting old cache: ${key}`)
            return caches.delete(key)
          })
      )
    ).then(() => self.clients.claim())
  )
})

// ---------------------------------------------------------------------------
// Fetch — network-first for API, cache-first for static assets
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Skip non-GET requests and cross-origin requests
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  // API calls: network-first, no caching
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request, { cache: false }))
    return
  }

  // Static assets: cache-first
  if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(cacheFirst(event.request))
    return
  }

  // HTML pages: network-first, fall back to cached shell
  event.respondWith(networkFirst(event.request, { cache: true, fallback: '/merchant' }))
})

/**
 * Network-first strategy.
 * Tries the network; on failure, falls back to cache or fallback URL.
 */
async function networkFirst(request, options = {}) {
  const { cache = true, fallback = null } = options

  try {
    const response = await fetch(request)

    // Cache successful responses
    if (cache && response.ok) {
      const responseClone = response.clone()
      caches.open(CACHE_NAME).then((c) => c.put(request, responseClone))
    }

    return response
  } catch {
    // Network failed — try cache
    const cached = await caches.match(request)
    if (cached) return cached

    // Try fallback URL
    if (fallback) {
      const fallbackCached = await caches.match(fallback)
      if (fallbackCached) return fallbackCached
    }

    // Nothing available — return offline page
    return new Response(
      '<html><body><h2>Offline</h2><p>Please check your connection.</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    )
  }
}

/**
 * Cache-first strategy.
 * Returns cached response immediately; fetches update in background.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  // Not in cache — fetch and cache
  const response = await fetch(request)
  if (response.ok) {
    const responseClone = response.clone()
    caches.open(CACHE_NAME).then((c) => c.put(request, responseClone))
  }
  return response
}

// ---------------------------------------------------------------------------
// Push — receive and display notifications
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  if (!event.data) return

  let data
  try {
    data = event.data.json()
  } catch {
    data = { title: 'Kizo Register', body: event.data.text() }
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',
    data: data.data || {},
    vibrate: [200, 100, 200, 100, 200],   // Three pulses — noticeable on a tablet
    requireInteraction: true,              // Stay on screen until dismissed
    silent: false,
    actions: [
      { action: 'view', title: 'View Order' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
    tag: data.data?.orderId || 'merchant-notification', // Collapse duplicate notifications
  }

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  )
})

// ---------------------------------------------------------------------------
// Notification click — open or focus the dashboard
// ---------------------------------------------------------------------------

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const action = event.action
  const data = event.notification.data || {}

  // Dismiss — do nothing
  if (action === 'dismiss') return

  // Determine target URL
  let targetUrl = '/merchant'
  if (data.orderId || action === 'view') {
    targetUrl = '/merchant#orders'
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // If dashboard is already open, focus it and navigate
      const dashboardClient = clients.find((c) =>
        c.url.includes('/merchant')
      )

      if (dashboardClient) {
        dashboardClient.focus()
        dashboardClient.postMessage({ type: 'NOTIFICATION_CLICK', data })
        return
      }

      // Otherwise open a new window
      return self.clients.openWindow(targetUrl)
    })
  )
})

// ---------------------------------------------------------------------------
// Background Sync — retry queued API calls when connection restores
// ---------------------------------------------------------------------------

const SYNC_TAG_STOCK = 'sync-stock-updates'
const SYNC_TAG_ORDER = 'sync-order-status'
const IDB_NAME = 'kizo-sync'
const IDB_VERSION = 1
const STORE_STOCK = 'stockQueue'
const STORE_ORDER = 'orderQueue'

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG_STOCK) {
    event.waitUntil(replayStockQueue())
  } else if (event.tag === SYNC_TAG_ORDER) {
    event.waitUntil(replayOrderQueue())
  }
})

/** Open (or upgrade) the sync IndexedDB */
function openSyncDB() {
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
    req.onsuccess = (e) => resolve(e.target.result)
    req.onerror = () => reject(req.error)
  })
}

/** Drain and replay all queued stock-status updates */
async function replayStockQueue() {
  const db = await openSyncDB()
  const items = await getAllFromStore(db, STORE_STOCK)
  if (items.length === 0) return

  notifyClients({ type: 'SYNC_START', queue: 'stock', count: items.length })

  try {
    for (const { key, value } of items) {
      try {
        const res = await fetch(value.url, {
          method: value.method,
          headers: value.headers,
          body: value.body,
        })
        if (res.ok) {
          await deleteFromStore(db, STORE_STOCK, key)
        }
        // Non-2xx (e.g. 4xx validation error) — discard, don't retry
        if (res.status >= 400 && res.status < 500) {
          await deleteFromStore(db, STORE_STOCK, key)
        }
      } catch {
        // Network still down — leave in queue, sync will retry
      }
    }
  } finally {
    notifyClients({ type: 'SYNC_DONE', queue: 'stock' })
  }
}

/** Drain and replay all queued order-status updates */
async function replayOrderQueue() {
  const db = await openSyncDB()
  const items = await getAllFromStore(db, STORE_ORDER)
  if (items.length === 0) return

  notifyClients({ type: 'SYNC_START', queue: 'order', count: items.length })

  try {
    for (const { key, value } of items) {
      try {
        const res = await fetch(value.url, {
          method: value.method,
          headers: value.headers,
          body: value.body,
        })
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          await deleteFromStore(db, STORE_ORDER, key)
        }
      } catch { /* leave in queue */ }
    }
  } finally {
    notifyClients({ type: 'SYNC_DONE', queue: 'order' })
  }
}

/** Read all records from an IDB object store */
function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const results = []
    const req = store.openCursor()
    req.onsuccess = (e) => {
      const cursor = e.target.result
      if (cursor) {
        results.push({ key: cursor.key, value: cursor.value })
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Delete a record by key from an IDB object store */
function deleteFromStore(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const req = tx.objectStore(storeName).delete(key)
    req.onsuccess = resolve
    req.onerror = () => reject(req.error)
  })
}

/** Broadcast a message to all open dashboard windows */
function notifyClients(message) {
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    clients.forEach((c) => c.postMessage(message))
  })
}
