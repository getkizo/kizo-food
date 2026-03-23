/**
 * Voice Commands — Web Speech API
 *
 * Allows staff to mark menu items in/out of stock with their voice.
 * Optimised for noisy restaurant environments: push-to-talk only,
 * tight command grammar, fuzzy name matching.
 *
 * Supported commands:
 *   "[item name] out"           → stockStatus: out_today
 *   "[item name] out today"     → stockStatus: out_today
 *   "[item name] out for good"  → stockStatus: out_indefinitely
 *   "[item name] back"          → stockStatus: in_stock
 *   "[item name] in stock"      → stockStatus: in_stock
 *   "order [code] ready"        → updates order status to ready
 *
 * Requires:
 *   - window.authToken (set by dashboard.js after login)
 *   - window.merchantId (set by dashboard.js after login)
 *   - state.allItems accessible via window (exposed below)
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Feature detection
  // ---------------------------------------------------------------------------

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition

  if (!SpeechRecognition) {
    console.warn('[Voice] Web Speech API not supported in this browser')
    return
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let recognition = null
  let isListening = false
  let btn = null
  let feedbackEl = null

  // ---------------------------------------------------------------------------
  // Command grammar
  // ---------------------------------------------------------------------------

  const OUT_PATTERNS = [
    /\bout(\s+today)?\b/i,
    /\bsold\s+out\b/i,
    /\bno\s+more\b/i,
  ]

  const OUT_GOOD_PATTERNS = [
    /\bout\s+(for\s+)?(good|indefinitely|always|now)\b/i,
    /\bindefinitely\b/i,
  ]

  const BACK_PATTERNS = [
    /\bback\b/i,
    /\bin\s+stock\b/i,
    /\bavailable\b/i,
  ]

  const ORDER_READY_PATTERN = /\border\s+([a-z0-9]{3,6})\s+ready\b/i

  /**
   * Determine the intended stock action from the transcript.
   * Returns 'out_today' | 'out_indefinitely' | 'in_stock' | null
   */
  function parseStockAction(transcript) {
    for (const p of OUT_GOOD_PATTERNS) {
      if (p.test(transcript)) return 'out_indefinitely'
    }
    for (const p of OUT_PATTERNS) {
      if (p.test(transcript)) return 'out_today'
    }
    for (const p of BACK_PATTERNS) {
      if (p.test(transcript)) return 'in_stock'
    }
    return null
  }

  /**
   * Fuzzy name match — normalise and check if item name appears in transcript.
   * Strips accents, lowercases, allows partial matches.
   */
  function normStr(s) {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // strip diacritics
      .replace(/[^a-z0-9\s]/g, '')       // keep only alphanum + space
      .trim()
  }

  /**
   * Returns items from state.allItems whose name appears in the transcript,
   * sorted by match length (longer = more specific = higher priority).
   */
  function matchItems(transcript) {
    const t = normStr(transcript)
    const items = window._voiceItems || []

    return items
      .filter((item) => {
        const name = normStr(item.name)
        return t.includes(name)
      })
      .sort((a, b) => b.name.length - a.name.length)  // longest match first
  }

  // ---------------------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------------------

  async function updateItemStock(itemId, stockStatus) {
    const token = window.authToken
    const merchantId = window.merchantId
    if (!token || !merchantId) return false

    const res = await fetch(
      `/api/merchants/${merchantId}/menu/items/${itemId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ stockStatus }),
      }
    )
    return res.ok
  }

  // ---------------------------------------------------------------------------
  // Feedback UI
  // ---------------------------------------------------------------------------

  const STATUS_LABELS = {
    out_today: 'Out today',
    out_indefinitely: 'Out of stock',
    in_stock: 'Back in stock',
  }

  function showFeedback(message, type = 'info') {
    if (!feedbackEl) return
    feedbackEl.textContent = message
    feedbackEl.className = `voice-feedback voice-feedback--${type} visible`
    clearTimeout(feedbackEl._timer)
    feedbackEl._timer = setTimeout(() => {
      feedbackEl.classList.remove('visible')
    }, 3500)
  }

  function setListeningState(listening) {
    isListening = listening
    if (!btn) return
    btn.setAttribute('aria-pressed', listening ? 'true' : 'false')
    btn.classList.toggle('voice-btn--active', listening)
    btn.title = listening ? 'Listening… speak now' : 'Voice command (hold to speak)'

    // Pulse the mic icon while listening
    const icon = btn.querySelector('.voice-btn__icon')
    if (icon) icon.classList.toggle('pulse', listening)
  }

  // ---------------------------------------------------------------------------
  // Recognition lifecycle
  // ---------------------------------------------------------------------------

  function buildRecognition() {
    const r = new SpeechRecognition()
    r.continuous = false
    r.interimResults = true
    r.maxAlternatives = 3
    r.lang = 'en-US'

    let finalised = false

    r.onstart = () => {
      finalised = false
      setListeningState(true)
      showFeedback('Listening…', 'info')
    }

    r.onend = () => {
      setListeningState(false)
      if (!finalised) showFeedback('Nothing heard', 'warn')
    }

    r.onerror = (event) => {
      setListeningState(false)
      if (event.error === 'no-speech') {
        showFeedback('Nothing heard — try again', 'warn')
      } else if (event.error === 'not-allowed') {
        showFeedback('Microphone access denied', 'error')
      } else {
        showFeedback(`Error: ${event.error}`, 'error')
      }
    }

    r.onresult = async (event) => {
      // Show interim transcript as feedback
      const latest = event.results[event.results.length - 1]
      const interim = latest[0].transcript
      if (!latest.isFinal) {
        showFeedback(`"${interim}"`, 'info')
        return
      }

      finalised = true

      // Collect all alternatives and try each
      const transcripts = Array.from(latest).map((alt) => alt.transcript)
      await handleTranscripts(transcripts)
    }

    return r
  }

  async function handleTranscripts(transcripts) {
    // Try each alternative until we get a match
    for (const transcript of transcripts) {
      // --- Order ready command ---
      const orderMatch = transcript.match(ORDER_READY_PATTERN)
      if (orderMatch) {
        const code = orderMatch[1].toUpperCase()
        showFeedback(`Order ${code} → ready`, 'success')
        await updateOrderReady(code)
        return
      }

      // --- Stock commands ---
      const action = parseStockAction(transcript)
      if (!action) continue

      const matched = matchItems(transcript)
      if (matched.length === 0) continue

      // Take the best match (longest name)
      const item = matched[0]
      const label = STATUS_LABELS[action]

      showFeedback(`"${item.name}" → ${label}`, 'success')

      const ok = await updateItemStock(item.id, action)
      if (ok) {
        // Refresh the live menu state so the UI reflects the change
        window.dispatchEvent(new CustomEvent('voice:stockChanged', {
          detail: { itemId: item.id, stockStatus: action, itemName: item.name },
        }))
      } else {
        showFeedback(`Failed to update "${item.name}"`, 'error')
      }
      return
    }

    // No transcript matched
    showFeedback(`Not understood: "${transcripts[0]}"`, 'warn')
  }

  async function updateOrderReady(pickupCode) {
    const token = window.authToken
    const merchantId = window.merchantId
    if (!token || !merchantId) return

    // Find order by pickup code from DOM (orders list is rendered in dashboard)
    const orderEl = document.querySelector(`[data-pickup-code="${pickupCode}"]`)
    const orderId = orderEl?.dataset?.orderId
    if (!orderId) {
      showFeedback(`Order ${pickupCode} not found`, 'warn')
      return
    }

    const res = await fetch(`/api/merchants/${merchantId}/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'ready' }),
    })

    if (res.ok) {
      window.dispatchEvent(new CustomEvent('voice:orderReady', { detail: { orderId, pickupCode } }))
    } else {
      showFeedback(`Could not update order ${pickupCode}`, 'error')
    }
  }

  // ---------------------------------------------------------------------------
  // Initialise UI
  // ---------------------------------------------------------------------------

  function init() {
    btn = document.getElementById('voice-btn')
    feedbackEl = document.getElementById('voice-feedback')

    if (!btn) return   // Voice UI not present on this page

    recognition = buildRecognition()

    // Push-to-talk: hold button OR single tap
    let holdTimer = null

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      holdTimer = setTimeout(() => {
        holdTimer = null
        startListening()
      }, 150)  // 150ms hold threshold
    })

    btn.addEventListener('pointerup', () => {
      if (holdTimer !== null) {
        // Short tap — toggle
        clearTimeout(holdTimer)
        holdTimer = null
        if (isListening) {
          stopListening()
        } else {
          startListening()
        }
      } else {
        // End of hold — stop listening
        stopListening()
      }
    })

    btn.addEventListener('pointercancel', () => {
      clearTimeout(holdTimer)
      holdTimer = null
      stopListening()
    })

    // Keyboard shortcut: press V to toggle voice (when not in an input)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'v' || e.key === 'V') {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        isListening ? stopListening() : startListening()
      }
    })

    // React to voice:stockChanged — trigger dashboard menu reload
    window.addEventListener('voice:stockChanged', (e) => {
      const { itemId, stockStatus, itemName } = e.detail
      // Update state.allItems in-place so subsequent commands are accurate
      const item = (window._voiceItems || []).find((i) => i.id === itemId)
      if (item) item.stockStatus = stockStatus
      // Ask dashboard to refresh its menu render
      window.dispatchEvent(new Event('voice:refreshMenu'))
    })

    console.log('[Voice] Commands ready — press V or tap mic button')
  }

  function startListening() {
    if (isListening) return
    // Sync item list from dashboard state right before listening
    window._voiceItems = Array.isArray(window.state?.allItems)
      ? window.state.allItems
      : []
    try {
      recognition.start()
    } catch {
      // Already started — rebuild and retry
      recognition = buildRecognition()
      recognition.start()
    }
  }

  function stopListening() {
    if (!isListening) return
    try { recognition.stop() } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  // Wait for auth before initialising (mic button may not be in DOM yet)
  window.addEventListener('merchant:authenticated', init)

  // Also init immediately if auth already happened (page reload with token)
  if (window.authToken) init()

})()
