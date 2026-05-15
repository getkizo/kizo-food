const CACHE = 'fridge-v1'
const ASSETS = [
  '/refrigerator',
  '/refrigerator/css/refrigerator.css?v=1',
  '/refrigerator/js/refrigerator.js?v=1',
  '/refrigerator/manifest.json',
]

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  e.respondWith(
    caches.match(e.request).then(cached => cached ?? fetch(e.request))
  )
})
