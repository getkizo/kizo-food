/**
 * store-push.js — Customer push subscription + iOS install prompt + polling fallback
 *
 * On confirmation:
 *   1. iOS non-standalone: show "Add to Home Screen" install banner (once per session)
 *   2. Capable browsers: attempt push subscription, POST to /api/store/push/subscribe
 *   3. Fallback (iOS/unsupported): poll /api/store/orders/:id/status every 15s
 *
 * Exposes: window.StorePush = { onConfirmed }
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Feature detection
  // ---------------------------------------------------------------------------

  const isIOS        = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
  const isStandalone = navigator.standalone === true ||
                       window.matchMedia('(display-mode: standalone)').matches
  const canPush      = 'serviceWorker' in navigator &&
                       'PushManager' in window &&
                       (!isIOS || isStandalone)

  // ---------------------------------------------------------------------------
  // iOS install banner
  // ---------------------------------------------------------------------------

  function maybeShowIOSBanner() {
    if (!isIOS || isStandalone) return
    if (sessionStorage.getItem('kizo_ios_prompted')) return

    const banner    = document.getElementById('ios-install-banner')
    const dismissBtn = document.getElementById('ios-banner-dismiss')
    if (!banner) return

    banner.hidden = false
    sessionStorage.setItem('kizo_ios_prompted', '1')

    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => { banner.hidden = true })
    }
  }

  // ---------------------------------------------------------------------------
  // Push subscription
  // ---------------------------------------------------------------------------

  async function getVapidKey() {
    const res = await fetch('/api/push/vapid-public-key')
    if (!res.ok) throw new Error('VAPID key unavailable')
    const data = await res.json()
    return data.publicKey
  }

  /**
   * Subscribe to push for an order.
   * @returns {Promise<boolean>} true on success, false on failure (falls back to polling)
   */
  async function subscribePush(orderId) {
    const pollingEl = document.getElementById('confirmed-polling-note')

    if (!canPush) {
      if (pollingEl) pollingEl.hidden = false
      startPolling(orderId)
      return false
    }

    try {
      const vapidKey = await getVapidKey()
      const reg      = await navigator.serviceWorker.ready

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      })

      await fetch('/api/store/push/subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          orderId,
          subscription: {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: arrayBufferToBase64(subscription.getKey('p256dh')),
              auth:   arrayBufferToBase64(subscription.getKey('auth')),
            },
          },
        }),
      })

      console.log('[StorePush] Customer push subscribed for order', orderId)
      return true
    } catch (err) {
      // Permission denied or subscription failed — fall back to polling
      console.warn('[StorePush] Push subscription failed, falling back to polling:', err)
      if (pollingEl) pollingEl.hidden = false
      startPolling(orderId)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Polling fallback
  // ---------------------------------------------------------------------------

  let pollInterval = null
  // Kept at module scope so the visibilitychange handler can trigger an
  // immediate re-poll when the user returns to the page after backgrounding.
  let _poll = null

  function startPolling(orderId) {
    if (pollInterval) clearInterval(pollInterval)

    async function poll() {
      try {
        const res = await fetch(`/api/store/orders/${orderId}/status`)
        if (res.status === 404) {
          // Order not found — was deleted server-side (e.g., stale cleanup).
          // Treat the same as an explicit 'cancelled' so the customer sees a
          // "Order Cancelled" message rather than the UI going silent.
          clearInterval(pollInterval)
          pollInterval = null
          window.Store?.updateStatusTracker('cancelled', null, {})
          setTimeout(() => { window.Store?.clearActiveOrder() }, 5000)
          return
        }
        if (!res.ok) return
        const data = await res.json()

        // Guard against stale polls: if a different order is now confirmed, bail out.
        // This can happen when resumePolling fires for an old active-order (stale localStorage)
        // and recordPaymentResult for a NEW order completes while this fetch was in-flight.
        // Without this guard, the stale 'cancelled' result would corrupt the new order's UI.
        // NOTE: do NOT clear pollInterval here — by the time this in-flight fetch completes,
        // pollInterval may already point to the NEW order's interval (set by startPolling).
        // Clearing it would accidentally stop the new order's polling.
        const currentModel = window.Store?.getModel()
        if (currentModel?.currentOrder && currentModel.currentOrder.orderId !== orderId) {
          return
        }

        // Update status tracker in SAM (also updates active-order bar + cancel button)
        window.Store?.updateStatusTracker(data.status, data.estimatedReadyAt, {
          cancellable:    data.cancellable,
          cancelDeadline: data.cancelDeadline,
        })

        if (data.status === 'completed' || data.status === 'cancelled') {
          clearInterval(pollInterval)
          pollInterval = null
          // Clear persistent bar after a short delay so user sees the final state
          setTimeout(() => { window.Store?.clearActiveOrder() }, 5000)
        }
      } catch { /* network error — retry next interval */ }
    }

    _poll = poll
    pollInterval = setInterval(poll, 15_000)
    poll() // immediate first check
  }

  // Re-poll immediately when the page becomes visible after being backgrounded.
  // Mobile browsers throttle setInterval in background tabs, so the next scheduled
  // poll may be significantly delayed. This ensures the status is always current on return.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _poll) {
      _poll()
    }
  })

  /**
   * Resume polling for an active order (called on page load when
   * an active order exists in localStorage).
   */
  function resumePolling(orderId) {
    if (pollInterval) return // already polling
    startPolling(orderId)
  }

  // ---------------------------------------------------------------------------
  // Main entry point — called by SAM when CONFIRMED state is reached
  // ---------------------------------------------------------------------------

  function onConfirmed(orderId) {
    maybeShowIOSBanner()

    if (!canPush) {
      // No push possible — go straight to polling
      startPolling(orderId)
      return
    }

    const permission = Notification.permission

    if (permission === 'denied') {
      // User explicitly blocked notifications — fall back to polling only.
      startPolling(orderId)
      return
    }

    // permission === 'granted' or 'default' — attempt silently, no UI shown.
    // The browser's own permission dialog handles first-time prompting if needed.
    // Polling starts as a backup regardless of outcome.
    subscribePush(orderId).then((ok) => {
      if (ok) startPolling(orderId)
      // If not ok, subscribePush already started polling as fallback
    })
  }

  // ---------------------------------------------------------------------------
  // Service worker registration (for push to work)
  // ---------------------------------------------------------------------------

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/store/sw.js', { scope: '/', updateViaCache: 'none' }).then((reg) => {
      console.log('[StorePush] Service worker registered', reg.scope)
      // Always check for SW updates on page load — bypasses HTTP cache
      reg.update()
    }).catch((err) => {
      console.warn('[StorePush] SW registration failed:', err)
    })
  }

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------

  /** Convert a Base64URL string (VAPID public key) to Uint8Array */
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4)
    const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const raw     = window.atob(base64)
    const output  = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
    return output
  }

  /** Convert ArrayBuffer to Base64URL string */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let str = ''
    bytes.forEach((b) => { str += String.fromCharCode(b) })
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  window.StorePush = {
    onConfirmed,
    resumePolling,
  }

})()
