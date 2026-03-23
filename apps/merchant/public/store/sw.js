/**
 * Kizo Store Service Worker
 *
 * Strategy:
 *   - Shell (HTML/CSS/JS): cache-first, fallback to network
 *   - API (/api/store/*): network-first, no cache
 *   - Push: "Your order is ready for pickup!"
 *   - notificationclick: opens /store/confirmed?order=ID
 */

const CACHE = 'store-__BUILD__'

const SHELL_URLS = [
  '/',
  '/store/',
  '/store/index.html',
  '/store/css/store.css?v=24',
  '/store/js/store.js?v=45',
  '/store/js/store-menu.js?v=6',
  '/store/js/store-cart.js?v=12',
  '/store/js/store-checkout.js?v=15',
  '/store/js/store-push.js?v=8',
  '/store/js/store-voice.js?v=5',
]

// ---------------------------------------------------------------------------
// Install — cache shell
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => {
      // Pre-cache shell assets (best-effort; ignore failures)
      return Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(function () {})))
    })
  )
  self.skipWaiting()
})

// ---------------------------------------------------------------------------
// Activate — clean up old caches
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// ---------------------------------------------------------------------------
// Fetch — cache-first for shell, network-first for API
//
// IMPORTANT: Guard all navigation intercepts against non-store paths.
// This SW may be cached on the root domain (dev.kizo.app) if the user
// visited before the merchant-subdomain routing was in place. Without the
// guards below, it would intercept /dashboard and serve the wrong HTML.
// ---------------------------------------------------------------------------

// Paths that must NEVER be intercepted by this SW — pass straight to network
const PASSTHROUGH_PREFIXES = [
  '/api/',
  '/merchant',
  '/payment/',
  '/setup',
  '/refrigerator',
  '/gift-cards',
  '/fog-report',
  '/reserve',
]

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Always pass through admin, API, and payment paths
  if (PASSTHROUGH_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    return event.respondWith(
      fetch(event.request).catch(() =>
        new Response('Service unavailable', { status: 503, statusText: 'Service Unavailable' })
      )
    )
  }

  // Ignore favicon — not served, don't cache, don't error
  if (url.pathname === '/favicon.ico') return

  // Navigation requests: network-first so updated HTML ships immediately.
  // Falls back to cache only when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone()
          caches.open(CACHE).then((cache) => cache.put('/store/index.html', clone))
          return response
        })
        .catch(() => caches.match('/store/index.html'))
    )
    return
  }

  // M-07: JS/CSS — network-first so security patches land immediately.
  // Falls back to cache if offline. Images/fonts stay cache-first for speed.
  const isCodeAsset = url.pathname.endsWith('.js') || url.pathname.endsWith('.css')

  if (isCodeAsset) {
    // Network-first for JS/CSS
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const clone = response.clone()
            caches.open(CACHE).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
        .catch(() => caches.match(event.request).then((cached) => cached || new Response('', { status: 503 })))
    )
    return
  }

  // Static assets (images, fonts, etc.): cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response
        }
        const clone = response.clone()
        caches.open(CACHE).then((cache) => cache.put(event.request, clone))
        return response
      })
    })
  )
})

// ---------------------------------------------------------------------------
// Push — show notification
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data?.json() || {}
  } catch {
    data = { title: 'Kizo', body: event.data?.text() || '' }
  }

  const options = {
    body:    data.body  || 'Update on your order.',
    icon:    data.icon  || '/icons/icon-192.png',
    badge:   data.badge || '/icons/badge-72.png',
    data:    data.data  || {},
    tag:     data.data?.orderId || 'store-order',
    renotify: true,
    requireInteraction: true,
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Kizo', options)
  )
})

// ---------------------------------------------------------------------------
// Notification click — open confirmation page
// ---------------------------------------------------------------------------

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const orderId = event.notification.data?.orderId
  const url     = orderId ? `/?order=${orderId}` : '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Focus existing tab if available
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if (orderId) client.postMessage({ type: 'order-ready', orderId })
          return client.focus()
        }
      }
      // Open new tab
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
