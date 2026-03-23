/**
 * PWA runtime: service worker, push notifications, wake lock, network monitor.
 * Loaded as a separate script after dashboard.js.
 *
 * Reads `window.authToken` set by dashboard.js after login.
 */

;(function () {
  'use strict'

  // -------------------------------------------------------------------------
  // Service Worker registration
  // -------------------------------------------------------------------------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          console.log('[PWA] Service worker registered, scope:', reg.scope)

          // Listen for messages from SW (e.g., notification click)
          navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data?.type === 'NOTIFICATION_CLICK') {
              // Navigate to orders section
              const ordersLink = document.querySelector('[data-section="orders"]')
              if (ordersLink) ordersLink.click()
            }
          })
        })
        .catch((err) => console.error('[PWA] Service worker registration failed:', err))
    })
  }

  // -------------------------------------------------------------------------
  // Screen Wake Lock — keep tablet screen on
  // -------------------------------------------------------------------------

  let wakeLock = null

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return
    try {
      wakeLock = await navigator.wakeLock.request('screen')
      console.log('[PWA] Wake lock acquired')

      wakeLock.addEventListener('release', () => {
        console.log('[PWA] Wake lock released')
      })
    } catch (err) {
      console.warn('[PWA] Wake lock failed:', err)
    }
  }

  // Re-acquire wake lock when tab becomes visible again
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await acquireWakeLock()
    }
  })

  // Acquire on startup
  acquireWakeLock()

  // -------------------------------------------------------------------------
  // Network quality monitor
  // -------------------------------------------------------------------------

  const banner = document.getElementById('connection-banner')

  function updateConnectionBanner() {
    if (!banner) return

    if (!navigator.onLine) {
      banner.textContent = 'No connection — data may be delayed'
      banner.className = 'visible offline'
      return
    }

    // Network Information API (Chrome/Android)
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
    if (conn) {
      const slow = conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g'
      if (slow) {
        banner.textContent = `Slow connection (${conn.effectiveType}) — some data may be delayed`
        banner.className = 'visible'
        return
      }
    }

    // Connection is fine — hide banner
    banner.className = ''
    banner.textContent = ''
  }

  window.addEventListener('online', () => {
    updateConnectionBanner()
    // Network restored — SSE connection is likely stale (zombie TCP), force reconnect
    if (typeof window._reconnectSSE === 'function') {
      window._reconnectSSE('network online event')
    }
  })
  window.addEventListener('offline', updateConnectionBanner)

  if (navigator.connection) {
    navigator.connection.addEventListener('change', () => {
      updateConnectionBanner()
      // Network type changed (e.g. WiFi switch) — SSE may be on a dead socket
      if (navigator.onLine && typeof window._reconnectSSE === 'function') {
        window._reconnectSSE('network connection change')
      }
    })
  }

  updateConnectionBanner()

  // -------------------------------------------------------------------------
  // Push notification subscription
  // -------------------------------------------------------------------------

  const pushPrompt = document.getElementById('push-prompt')
  const pushAllow = document.getElementById('push-allow')
  const pushDeny = document.getElementById('push-deny')

  const PUSH_DISMISSED_KEY = 'push_prompt_dismissed'

  /**
   * Subscribes this device to push notifications.
   * Called after user grants permission.
   */
  async function subscribeToPush() {
    if (!('PushManager' in window)) return

    try {
      // Fetch VAPID public key
      const res = await fetch('/api/push/vapid-public-key')
      if (!res.ok) return  // Push not configured on server

      const { publicKey } = await res.json()

      const reg = await navigator.serviceWorker.ready
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      })

      // Send subscription to server
      const token = window.authToken || localStorage.getItem('accessToken')
      if (!token) return

      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))),
            auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')))),
          },
          deviceLabel: getDeviceLabel(),
        }),
      })

      console.log('[PWA] Push subscription saved')
    } catch (err) {
      console.error('[PWA] Push subscription failed:', err)
    }
  }

  /**
   * Shows the push permission prompt after a short delay
   * (only if not already granted/dismissed).
   */
  async function maybeShowPushPrompt() {
    if (!('Notification' in window) || !('PushManager' in window)) return
    if (localStorage.getItem(PUSH_DISMISSED_KEY)) return
    if (Notification.permission === 'granted') {
      // Already granted — subscribe silently
      await subscribeToPush()
      return
    }
    if (Notification.permission === 'denied') return

    // Show prompt after 3 seconds (let the user see the app first)
    setTimeout(() => {
      if (pushPrompt) pushPrompt.classList.add('visible')
    }, 3000)
  }

  if (pushAllow) {
    pushAllow.addEventListener('click', async () => {
      pushPrompt?.classList.remove('visible')
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        await subscribeToPush()
      }
    })
  }

  if (pushDeny) {
    pushDeny.addEventListener('click', () => {
      pushPrompt?.classList.remove('visible')
      localStorage.setItem(PUSH_DISMISSED_KEY, '1')
    })
  }

  // Show prompt once user is authenticated (dashboard.js fires this event)
  window.addEventListener('merchant:authenticated', () => {
    maybeShowPushPrompt()
  })

  // If user is already authenticated on page load
  if (window.authToken || localStorage.getItem('accessToken')) {
    maybeShowPushPrompt()
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Returns a human-readable label for this device */
  function getDeviceLabel() {
    const ua = navigator.userAgent
    if (/iPad/.test(ua)) return 'iPad'
    if (/Android.*Tablet|Tablet.*Android/.test(ua)) return 'Android Tablet'
    if (/Android/.test(ua)) return 'Android'
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/Mac/.test(ua)) return 'Mac'
    if (/Windows/.test(ua)) return 'Windows PC'
    return 'Browser'
  }

  // Expose push subscribe for dashboard.js to call after login
  window.pwa = {
    subscribeToPush,
    acquireWakeLock,
  }

})()
