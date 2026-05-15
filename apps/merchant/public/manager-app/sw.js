/**
 * Manager PWA Service Worker
 * Cache: manager-v1
 * Scope: /manager-app/
 */

const CACHE_NAME = 'manager-v15';

const SHELL_FILES = [
  '/manager-app/',
  '/manager-app/index.html',
  '/manager-app/css/manager.css',
  '/manager-app/js/manager.js',
  '/manager-app/js/manager-receipts.js',
  '/manager-app/js/manager-reports.js',
  '/manager-app/js/manager-ingredients.js',
];

// ---------------------------------------------------------------------------
// IDB helpers
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<IDBDatabase>}
 */
function openManagerDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kizo-manager', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending_receipts')) {
        db.createObjectStore('pending_receipts', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<any[]>}
 */
function idbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {any} val
 * @returns {Promise<void>}
 */
function idbPut(db, storeName, val) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(val);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<void>}
 */
function idbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls
  if (url.pathname.startsWith('/api/')) {
    return; // pass through to network
  }

  // Manager app shell: cache-first, fall back to network
  if (url.pathname.startsWith('/manager-app/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Everything else: network only
  // (no event.respondWith means browser handles it normally)
});

// ---------------------------------------------------------------------------
// Background Sync
// ---------------------------------------------------------------------------

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-receipts') {
    event.waitUntil(syncReceipts());
  }
});

// Keep in sync with MAX_RETRIES in manager-receipts.js — both paths must agree on the cap.
const MAX_RETRIES = 5;

/**
 * Upload all queued receipts to the server.
 * @returns {Promise<void>}
 */
async function syncReceipts() {
  const db = await openManagerDB();
  const channel = new BroadcastChannel('manager-sync');

  // Crash recovery: rows left at 'uploading' AND older than the fetch timeout
  // (90 s) are reset to 'queued'. Rows marked uploading within the last 90 s
  // are skipped — they belong to a concurrent in-flight upload in the page and
  // must not be reset, or we risk duplicate POSTs.
  const allRecords = await idbGetAll(db, 'pending_receipts');
  for (const r of allRecords) {
    if (r.status === 'uploading' && (Date.now() - (r.uploadingStartedAt ?? 0)) > 90_000) {
      const reset = Object.assign({}, r, { status: 'queued', retryCount: 0 });
      delete reset.uploadingStartedAt;
      await idbPut(db, 'pending_receipts', reset);
    }
  }

  const refreshed = await idbGetAll(db, 'pending_receipts');
  const queued = refreshed.filter((r) => r.status === 'queued');

  for (const r of queued) {
    const uploading = Object.assign({}, r, { status: 'uploading', uploadingStartedAt: Date.now() });
    await idbPut(db, 'pending_receipts', uploading);

    try {
      const formData = new FormData();
      formData.append('name', r.id);
      if (Array.isArray(r.files)) {
        for (const file of r.files) {
          formData.append('files', file);
        }
      }
      if (r.vendorOverride) formData.append('vendor', r.vendorOverride);

      const res = await fetch(`/api/merchants/${r.merchantId}/manager/receipts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${r.accessToken}`,
        },
        body: formData,
        signal: AbortSignal.timeout(90_000),
      });

      if (res.status === 201 || res.status === 200) {
        const data = await res.json();
        const done = Object.assign({}, uploading, {
          status: 'done',
          receiptId: data.receiptId,
          uploadedAt: new Date().toISOString(),
          retryCount: 0,
        });
        delete done.files;
        await idbPut(db, 'pending_receipts', done);
        channel.postMessage({ type: 'receipt-synced', id: r.id, receiptId: data.receiptId });
      } else if (res.status >= 400 && res.status < 500) {
        let errMsg = `Upload failed (${res.status})`;
        try {
          const errData = await res.json();
          if (errData.detail) errMsg += ': ' + errData.detail;
          else if (errData.error) errMsg += ': ' + errData.error;
        } catch {}
        const errored = Object.assign({}, uploading, {
          status: 'error',
          errorMessage: errMsg,
        });
        await idbPut(db, 'pending_receipts', errored);
        channel.postMessage({ type: 'receipt-error', id: r.id, error: errored.errorMessage });
      } else {
        // 5xx — requeue up to MAX_RETRIES, then surface as error
        const retries = (r.retryCount ?? 0) + 1;
        if (retries >= MAX_RETRIES) {
          const errored = Object.assign({}, uploading, {
            status: 'error',
            errorMessage: `Upload failed after ${MAX_RETRIES} attempts (server error ${res.status})`,
            retryCount: 0,
          });
          await idbPut(db, 'pending_receipts', errored);
          channel.postMessage({ type: 'receipt-error', id: r.id, error: errored.errorMessage });
        } else {
          const requeued = Object.assign({}, uploading, { status: 'queued', retryCount: retries });
          await idbPut(db, 'pending_receipts', requeued);
        }
      }
    } catch (_networkError) {
      const retries = (r.retryCount ?? 0) + 1;
      if (retries >= MAX_RETRIES) {
        const errored = Object.assign({}, uploading, {
          status: 'error',
          errorMessage: `Upload failed after ${MAX_RETRIES} attempts (network error)`,
          retryCount: 0,
        });
        await idbPut(db, 'pending_receipts', errored);
        channel.postMessage({ type: 'receipt-error', id: r.id, error: errored.errorMessage });
      } else {
        const requeued = Object.assign({}, uploading, { status: 'queued', retryCount: retries });
        await idbPut(db, 'pending_receipts', requeued);
      }
    }
  }

  channel.close();
}
