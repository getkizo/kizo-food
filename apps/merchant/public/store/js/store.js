/**
 * Kizo Customer Store — SAM State Machine
 *
 * States: LOADING → BROWSING → ITEM → CHECKOUT → PAYING → CONFIRMED | ERROR
 *
 * SAM Pattern:
 *   Action → Model.present() → State(model) → View → [NAP]
 *
 * This file owns the model, action creators, and the render dispatch.
 * Rendering is delegated to store-menu.js, store-cart.js, store-checkout.js.
 * Push subscription is handled by store-push.js.
 *
 * Implementation note — hand-rolled SAM (no sam-pattern npm library):
 *   The model is a plain object; present() is a plain function.  The
 *   sam-pattern library's reserved field collision (error, hasError,
 *   errorMessage, clearError, state, update, flush, clone, continue,
 *   hasNext, allow, log) does NOT apply here.  If sam-pattern is ever
 *   imported into this file, all model field names must be audited against
 *   that list before the change lands.
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Polyfills (iOS 14 compat)
  // ---------------------------------------------------------------------------

  if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
    crypto.randomUUID = function () {
      var b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      var h = Array.from(b, function (v) { return v.toString(16).padStart(2, '0') }).join('')
      return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function formatCents(cents) { return '$' + (cents / 100).toFixed(2) }

  function escHtml(str) {
    if (!str) return ''
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  const ORDER_HISTORY_KEY = 'kizo_order_history'
  const ACTIVE_ORDER_KEY  = 'kizo_active_order'
  const CART_KEY          = 'kizo_cart'
  const PENDING_CART_KEY  = 'kizo_pending_cart'  // saved before redirect; cleared on confirm or restore
  const MAX_HISTORY = 20

  /**
   * Hide/show an element — sets both .hidden and inline style.display.
   * The inline style acts as a fallback when the Service Worker serves stale CSS
   * that lacks the `[hidden] { display: none !important }` override.
   */
  function setVisible(el, show) {
    if (!el) return
    el.hidden = !show
    el.style.display = show ? '' : 'none'
  }

  // ---------------------------------------------------------------------------
  // Splash screen helpers
  // ---------------------------------------------------------------------------

  /**
   * Show the one-time welcome message modal if the merchant has configured one
   * and the user has not dismissed it before (tracked via localStorage).
   * Resolves when the user taps "Let's Go!" or the backdrop.
   *
   * @param {object} profile  - /api/store/profile response
   * @returns {Promise<void>}
   */
  function _maybeShowWelcomeModal(profile) {
    if (!profile.welcomeMessage) return Promise.resolve()
    var key = 'kizo_welcome_' + (profile.slug || 'store')
    try { if (localStorage.getItem(key)) return Promise.resolve() } catch { /* ignore */ }
    return new Promise(function (resolve) {
      var backdrop = document.getElementById('welcome-modal-backdrop')
      var modal    = document.getElementById('welcome-modal')
      var msgEl    = document.getElementById('welcome-modal-message')
      var btn      = document.getElementById('welcome-modal-dismiss')
      if (!modal || !btn) { resolve(); return }
      if (msgEl) msgEl.textContent = profile.welcomeMessage
      if (backdrop) { backdrop.hidden = false; backdrop.removeAttribute('aria-hidden') }
      modal.hidden = false
      modal.removeAttribute('aria-hidden')
      btn.focus()
      var removeTrap = _trapFocus(modal)
      function dismiss() {
        try { localStorage.setItem(key, '1') } catch { /* ignore */ }
        if (backdrop) { backdrop.hidden = true; backdrop.setAttribute('aria-hidden', 'true') }
        modal.hidden = true
        modal.setAttribute('aria-hidden', 'true')
        removeTrap()
        resolve()
      }
      btn.addEventListener('click', dismiss, { once: true })
      if (backdrop) backdrop.addEventListener('click', dismiss, { once: true })
    })
  }

  /**
   * Set the splash image and restaurant name once the profile is loaded.
   * If the merchant has uploaded a splash image, it fills the screen with
   * object-fit: cover. Otherwise only the bottom banner is visible.
   *
   * @param {object} profile  - /api/store/profile response
   */
  function _populateSplash(profile) {
    var nameEl = document.getElementById('splash-restaurant-name')
    if (nameEl) nameEl.textContent = profile.businessName || profile.name || 'Our Menu'

    if (profile.splashUrl) {
      var img = document.getElementById('splash-custom-img')
      if (img) {
        img.src = profile.splashUrl
        img.hidden = false
      }
    }
  }

  // True after the splash has been shown and faded on first boot.
  // Used to skip the splash on subsequent loadStore() calls (e.g. when
  // returning to the menu from the order status page via /pay-return).
  let _splashFaded = false

  // Set to true in boot() when we detect that the customer backed out of the
  // Finix payment page.  loadStore() routes to CHECKOUT instead of BROWSING.
  let _resumeCheckoutOnLoad = false

  // Set in boot() when the URL contains ?fb=TOKEN (scanned QR code on printed bill).
  // loadStore() opens the feedback modal once the store transitions to BROWSING.
  let _pendingFeedbackToken = null

  /**
   * Fade out the splash screen. When a splash image is present the screen
   * holds for 2.4 s so customers see it; without an image the fade starts
   * immediately (just a quick 0.6 s transition out of the loading state).
   * No-ops on subsequent calls so the splash never re-appears mid-session.
   *
   * @param {boolean} hasImage  - true when a merchant splash image is shown
   * @returns {Promise<void>}
   */
  function _fadeSplash(hasImage) {
    if (_splashFaded) return Promise.resolve()
    _splashFaded = true
    var isMobile = window.innerWidth <= 640
    var FADE_MS = isMobile ? 600 : 0
    var HOLD_MS = hasImage && isMobile ? 2400 : 0
    return new Promise(function (resolve) {
      var el = document.getElementById('state-loading')
      if (!el) { resolve(); return }
      setTimeout(function () {
        el.classList.add('splash-fade-out')
        setTimeout(resolve, FADE_MS)
      }, HOLD_MS)
    })
  }

  // ---------------------------------------------------------------------------
  // Active order — persisted in localStorage for cross-view status bar
  // ---------------------------------------------------------------------------

  /** Save or update the active order (visible as status bar across all views) */
  function saveActiveOrder(orderId, pickupCode, status, estimatedReadyAt) {
    try {
      localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify({
        orderId, pickupCode, status, estimatedReadyAt: estimatedReadyAt || null,
      }))
    } catch { /* ignore */ }
    renderActiveOrderBar()
  }

  /** Get active order from localStorage (or null) */
  function getActiveOrder() {
    try {
      return JSON.parse(localStorage.getItem(ACTIVE_ORDER_KEY) || 'null')
    } catch { return null }
  }

  /** Clear active order (when completed/cancelled) */
  function clearActiveOrder() {
    try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* ignore */ }
    renderActiveOrderBar()
  }

  // ---------------------------------------------------------------------------
  // Cart persistence — survives page refresh
  // ---------------------------------------------------------------------------

  function saveCart(cart, tipCents, scheduledFor) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify({ cart, tipCents: tipCents || 0, scheduledFor: scheduledFor || null }))
    } catch { /* ignore */ }
  }

  function loadCart() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY) || 'null') || { cart: [], tipCents: 0, scheduledFor: null }
    } catch { return { cart: [], tipCents: 0, scheduledFor: null } }
  }

  function clearSavedCart() {
    try { localStorage.removeItem(CART_KEY) } catch { /* ignore */ }
  }

  // Campaign persistence — survives page refresh; cleared on order submit
  const CAMPAIGN_KEY         = 'kizo_campaign'
  const REDEEMED_TOKENS_KEY  = 'kizo_redeemed_tokens'

  function saveCampaign(campaign) {
    try { localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(campaign)) } catch { /* ignore */ }
  }

  function loadSavedCampaign() {
    try {
      const raw = localStorage.getItem(CAMPAIGN_KEY)
      if (!raw) return null
      const c = JSON.parse(raw)
      if (!c || !c.valid_until || Date.now() > c.valid_until) {
        localStorage.removeItem(CAMPAIGN_KEY)
        return null
      }
      // Migration gate: stale entries without scanToken pre-date the per-scan instance
      // feature. Force a re-scan so the user gets a valid token.
      if (!c.scanToken) {
        localStorage.removeItem(CAMPAIGN_KEY)
        return null
      }
      // Locally redeemed: token was used on this device; treat as already consumed.
      if (_isTokenRedeemed(c.scanToken)) {
        localStorage.removeItem(CAMPAIGN_KEY)
        return null
      }
      return c
    } catch { return null }
  }

  function clearSavedCampaign() {
    try { localStorage.removeItem(CAMPAIGN_KEY) } catch { /* ignore */ }
  }

  function _markScanTokenRedeemed(scanToken) {
    try {
      const raw    = localStorage.getItem(REDEEMED_TOKENS_KEY)
      const tokens = raw ? JSON.parse(raw) : []
      if (!tokens.includes(scanToken)) tokens.push(scanToken)
      // Cap at 20 entries to avoid unbounded growth
      if (tokens.length > 20) tokens.splice(0, tokens.length - 20)
      localStorage.setItem(REDEEMED_TOKENS_KEY, JSON.stringify(tokens))
    } catch { /* ignore */ }
  }

  function _isTokenRedeemed(scanToken) {
    try {
      const raw = localStorage.getItem(REDEEMED_TOKENS_KEY)
      if (!raw) return false
      const tokens = JSON.parse(raw)
      return Array.isArray(tokens) && tokens.includes(scanToken)
    } catch { return false }
  }

  const CAMPAIGN_DISMISSED_KEY = 'kizo_campaign_dismissed'

  function _getDismissedSlugs() {
    try {
      const raw = localStorage.getItem(CAMPAIGN_DISMISSED_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      // Migrate legacy string value → array
      return Array.isArray(parsed) ? parsed : (typeof parsed === 'string' ? [parsed] : [])
    } catch { return [] }
  }

  function dismissCampaign(slug) {
    try {
      const dismissed = _getDismissedSlugs()
      if (!dismissed.includes(slug)) dismissed.push(slug)
      localStorage.setItem(CAMPAIGN_DISMISSED_KEY, JSON.stringify(dismissed))
    } catch { /* ignore */ }
    // Only clear the persisted QR campaign if it's the one being dismissed
    const saved = loadSavedCampaign()
    if (saved?.slug === slug) clearSavedCampaign()
  }

  function isCampaignDismissed(slug) {
    return _getDismissedSlugs().includes(slug)
  }

  function clearDismissedCampaign() {
    try { localStorage.removeItem(CAMPAIGN_DISMISSED_KEY) } catch { /* ignore */ }
  }

  /** Show a brief toast notification above the cart bar. Auto-hides after 4 s. */
  function showToast(message) {
    const toast = document.getElementById('store-toast')
    if (!toast) return
    toast.textContent = message
    toast.classList.add('store-toast--visible')
    clearTimeout(toast._hideTimer)
    toast._hideTimer = setTimeout(() => toast.classList.remove('store-toast--visible'), 4000)
  }

  /** Set the --active-bar-h CSS variable so sticky navs offset correctly */
  function updateBarHeightVar(visible) {
    if (!visible) {
      document.documentElement.style.setProperty('--active-bar-h', '0px')
      return
    }
    // Measure after paint so the element is in the layout
    requestAnimationFrame(() => {
      const bar = document.getElementById('active-order-bar')
      if (bar && !bar.hidden) {
        document.documentElement.style.setProperty('--active-bar-h', bar.offsetHeight + 'px')
      }
    })
  }

  /** Render the persistent status bar from localStorage */
  function renderActiveOrderBar() {
    const bar      = document.getElementById('active-order-bar')
    const codeEl   = document.getElementById('active-order-code')
    const statusEl = document.getElementById('active-order-status')
    const etaEl    = document.getElementById('active-order-eta')
    const fillEl   = document.getElementById('active-order-progress-fill')
    if (!bar) return

    const active = getActiveOrder()
    // Terminal states clear the bar. picked_up is a terminal state — once
    // the customer has the food, the order is done; no point showing a
    // status bar (and the unrecognized status text used to leak through and
    // push the menu off-screen).
    if (!active || active.status === 'completed' || active.status === 'cancelled' || active.status === 'picked_up') {
      bar.hidden = true
      updateBarHeightVar(false)
      return
    }

    bar.hidden = false
    if (codeEl) codeEl.textContent = active.pickupCode || '????'

    const STATUS_DISPLAY = {
      pending_payment: 'Complete Payment →',
      received:        'Order Received',
      submitted:       'Order Received',
      confirmed:       'Accepted',
      preparing:       'Being Prepared',
      ready:           'Ready for Pickup!',
    }
    if (statusEl) statusEl.textContent = STATUS_DISPLAY[active.status] || active.status

    // Progress bar percentage
    const PROGRESS = { pending_payment: 0, received: 10, submitted: 10, confirmed: 40, preparing: 40, ready: 85 }
    if (fillEl) fillEl.style.width = (PROGRESS[active.status] || 0) + '%'

    // Highlight payment-pending state
    bar.classList.toggle('order-payment-pending', active.status === 'pending_payment')

    // ETA
    if (etaEl) {
      if (active.estimatedReadyAt) {
        const readyDate = new Date(active.estimatedReadyAt)
        const timeStr = readyDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        etaEl.textContent = `~${timeStr}`
        etaEl.hidden = false
      } else {
        etaEl.textContent = ''
        etaEl.hidden = true
      }
    }

    // Highlight ready state
    bar.classList.toggle('order-ready', active.status === 'ready')

    // Update sticky nav offsets
    updateBarHeightVar(true)
  }

  /** Save a completed order to localStorage history */
  function saveOrderToHistory(orderId) {
    try {
      const stored = JSON.parse(localStorage.getItem(`kizo_order_${orderId}`) || 'null')
      if (!stored) return
      const history = JSON.parse(localStorage.getItem(ORDER_HISTORY_KEY) || '[]')
      // Don't duplicate
      if (history.some((h) => h.orderId === orderId)) return
      history.unshift(stored)
      // Trim to max
      if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
      localStorage.setItem(ORDER_HISTORY_KEY, JSON.stringify(history))
    } catch { /* ignore */ }
  }

  /** Load order history from localStorage */
  function loadOrderHistory() {
    try {
      return JSON.parse(localStorage.getItem(ORDER_HISTORY_KEY) || '[]')
    } catch { return [] }
  }

  /** Toggle favorite status for an order */
  function toggleFavorite(orderId) {
    try {
      const history = loadOrderHistory()
      const order = history.find((h) => h.orderId === orderId)
      if (order) {
        order.favorite = !order.favorite
        localStorage.setItem(ORDER_HISTORY_KEY, JSON.stringify(history))
      }
      return order?.favorite ?? false
    } catch { return false }
  }

  // ---------------------------------------------------------------------------
  // Finix fraud detection
  // ---------------------------------------------------------------------------

  /**
   * Finix Auth instance — initialised in loadStore() once the profile reveals
   * the Finix merchant ID and environment.  Used to get the session key at
   * checkout time so Finix can correlate the browser session with the transfer.
   * @type {object|null}
   */
  let _finixAuth = null

  /**
   * Initialise the Finix Auth service for fraud detection tracking.
   * Must be called after the profile is fetched (we need finixMerchantId + finixEnvironment).
   * Safe to call even if window.Finix hasn't loaded yet — returns immediately.
   * @param {string} environment - 'sandbox' | 'live'
   * @param {string} merchantId  - Finix Merchant ID (MU…)
   */
  function _initFinixAuth(environment, merchantId) {
    try {
      if (typeof window.Finix?.Auth !== 'function') return
      _finixAuth = window.Finix.Auth(environment, merchantId)
    } catch (e) {
      console.warn('[store] Finix.Auth() init failed:', e)
    }
  }

  /**
   * Returns the Finix fraud session key if the SDK is initialised,
   * otherwise falls back to a client-generated UUID.
   * @returns {string}
   */
  function _getFinixSessionKey() {
    try {
      const key = _finixAuth?.getSessionKey?.()
      if (key) return key
    } catch { /* fall through */ }
    return crypto.randomUUID()
  }

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------

  function _fmtSchedule(schedule) {
    if (!schedule) return null
    const parts = []
    const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    if (schedule.days?.length) {
      if (schedule.days.length === 7) {
        parts.push('Daily')
      } else {
        const sorted = [...schedule.days].sort((a, b) => a - b)
        const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
        if (consecutive && sorted.length > 2) {
          parts.push(`${DAY_ABBR[sorted[0]]}–${DAY_ABBR[sorted[sorted.length - 1]]}`)
        } else {
          parts.push(sorted.map(d => DAY_ABBR[d]).join(', '))
        }
      }
    }
    if (schedule.windows?.length) {
      const fmtTime = (t) => {
        const [h, m] = t.split(':').map(Number)
        const suffix = h >= 12 ? 'pm' : 'am'
        const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
        return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`
      }
      parts.push(schedule.windows.map(w => `${fmtTime(w.start)}–${fmtTime(w.end)}`).join(', '))
    }
    return parts.length ? parts.join(' ') : null
  }

  /**
   * Compute how many cents a single campaign discounts the given subtotal.
   * @param {object} campaign
   * @param {number} sub  — cartSubtotalCents
   * @param {object} m    — model reference (needs cart, orderType, profile)
   */
  function _campaignDiscount(campaign, sub, m) {
    if (sub < (campaign.offer.min_order_cents || 0)) return 0
    // Marketing-engine campaigns use 'takeout', orders use 'pickup' (the
    // CHECK constraint on orders.order_type doesn't include 'takeout').
    // Treat them as synonyms so a takeout-restricted coupon applies to
    // pickup orders. TODO: migrate marketing engine to use 'pickup'.
    const fr = campaign.offer.fulfillment_restriction
    const orderTypeAlias = m.orderType === 'pickup' ? 'takeout' : m.orderType
    if (fr && fr !== 'both' && fr !== m.orderType && fr !== orderTypeAlias) return 0

    if (campaign.schedule) {
      const tz        = m.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      // For scheduled orders evaluate the campaign window against pickup time, not "now"
      const now       = m.scheduledFor ? new Date(m.scheduledFor) : new Date()
      const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
      if (campaign.schedule.days?.length) {
        const dayStr   = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)
        const localDay = DAY_NAMES.indexOf(dayStr)
        if (localDay === -1 || !campaign.schedule.days.includes(localDay)) return 0
      }
      if (campaign.schedule.windows?.length) {
        const timeStr   = new Intl.DateTimeFormat('en-GB',
          { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).format(now)
        const [h, mn]   = timeStr.split(':').map(Number)
        const localMins = h * 60 + mn
        const inWindow  = campaign.schedule.windows.some(w => {
          const [sh, sm] = w.start.split(':').map(Number)
          const [eh, em] = w.end.split(':').map(Number)
          return localMins >= sh * 60 + sm && localMins <= eh * 60 + em
        })
        if (!inWindow) return 0
      }
    }

    const campaignType = campaign.campaign_type ?? 'coupon'
    if (campaignType === 'bogo' && campaign.trigger && campaign.reward) {
      const trigger = campaign.trigger
      const reward  = campaign.reward
      let triggerCount = 0
      if (trigger.type === 'item_quantity' && trigger.item_name) {
        const tName = trigger.item_name.toLowerCase()
        triggerCount = m.cart.reduce((n, e) => n + (e.item.name.toLowerCase() === tName ? e.qty : 0), 0)
      } else if (trigger.type === 'category_quantity' && trigger.category) {
        const cName = trigger.category.toLowerCase()
        triggerCount = m.cart.reduce((n, e) => n + (e.item.categoryName?.toLowerCase() === cName ? e.qty : 0), 0)
      }
      if (triggerCount < trigger.quantity) return 0
      const rName = reward.item_name.toLowerCase()
      const maxQty = reward.max_quantity ?? 1
      let collected = 0
      let rewardTotal = 0
      for (const e of m.cart) {
        if (e.item.name.toLowerCase() !== rName) continue
        const take = Math.min(e.qty, maxQty - collected)
        if (take <= 0) break
        rewardTotal += e.unitCents * take
        collected   += take
      }
      if (collected === 0) return 0
      if (reward.type === 'free_item') return Math.min(rewardTotal, sub)
      if (reward.type === 'item_discount') {
        const raw = reward.discount_type === 'percent'
          ? Math.round(rewardTotal * reward.discount_value / 100)
          : Math.min(reward.discount_value * collected, rewardTotal)
        return Math.min(raw, sub)
      }
      return 0
    }

    let base = sub
    if (campaign.target?.type === 'item' && campaign.target.item_name) {
      const tName = campaign.target.item_name.toLowerCase()
      base = m.cart.reduce((s, e) => s + (e.item.name.toLowerCase() === tName ? e.totalCents : 0), 0)
      if (base === 0) return 0
    }

    if (campaign.offer.type === 'percent') return Math.round(base * campaign.offer.value / 100)
    return Math.min(campaign.offer.value, base)
  }

  /** Format a campaign validity window as "MM/DD–MM/DD". Falls back to "until MM/DD" when start_at is absent. */
  function _fmtValidityWindow(startMs, endMs) {
    if (!endMs) return ''
    const fmt  = (d) => `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`
    const fmtY = (d) => `${fmt(d)}/${String(d.getFullYear()).slice(2)}`
    const e = new Date(endMs)
    if (!startMs) return `until ${fmt(e)}`
    const s = new Date(startMs)
    if (s.getFullYear() !== e.getFullYear()) return `${fmtY(s)}–${fmtY(e)}`
    return `${fmt(s)}–${fmt(e)}`
  }

  /** @type {StoreModel} */
  const model = {
    appState: 'LOADING',   // LOADING | BROWSING | ITEM | CHECKOUT | PAYING | CONFIRMED | ERROR

    // Data fetched from server
    profile: null,         // { name, slug, logoUrl, bannerUrl, taxRate, tipOptions, businessHours, … }
    menu: [],              // [{ id, name, hoursStart, hoursEnd, availableDays, blackoutDates, items }]

    // Cart
    cart: [],              // [{ item, selectedModifiers, totalCents }]
    tipCents: 0,           // customer-selected tip, applied on top of tax
    orderType: 'pickup',   // 'pickup' | 'delivery' — always pickup for now; used for fulfillment_restriction check

    // Modifier sheet (ITEM state)
    selectedItem: null,    // full item object from menu
    selectedModifiers: {}, // { groupId: string[] } — arrays support both single- and multi-select
    itemQty: 1,            // quantity being added to cart (reset to 1 after each add)
    editingCartIdx: null,  // index into cart[] when editing an existing item (null = adding new)
    editingNoteIdx: null,  // index into cart[] when editing item name/kitchen note (null = closed)

    // Confirmed order
    currentOrder: null,    // { orderId, pickupCode, totalCents, subtotalCents, taxCents }

    // Payment declined state
    paymentDeclined: false,  // true when provider returned a decline (PAYING sub-panel B)
    declinedOrderId: null,   // orderId of the pending_payment order that was declined

    // Scheduled pickup time (ISO string set by checkout time selector, null = ASAP)
    scheduledFor: null,

    // Offer wallet — QR-linked + ambient auto-apply campaigns available to use
    // Each: { slug, name, start_at, valid_until, offer: { type, value, label, … } }
    activeCampaigns: [],

    // Slug of the one campaign the customer has chosen to apply (null = none)
    selectedCampaignSlug: null,

    // Offer preview modal — populated when customer arrives via QR with a coupon slug
    // null = no preview pending; otherwise { campaign, computed_status, already_redeemed }
    offerPreview: null,

    // Error message
    errorMessage: '',

    // ---------------------------------------------------------------------------
    // Derived values (computed, not stored)
    // ---------------------------------------------------------------------------

    get cartCount() {
      return this.cart.reduce((sum, entry) => sum + (entry.qty || 1), 0)
    },
    get cartSubtotalCents() {
      return this.cart.reduce((sum, entry) => sum + entry.totalCents, 0)
    },
    /** The campaign the customer has selected to apply — null if none chosen. */
    get selectedCampaign() {
      if (!this.selectedCampaignSlug) return null
      return this.activeCampaigns.find(c => c.slug === this.selectedCampaignSlug) ?? null
    },
    get cartDiscountCents() {
      const campaign = this.selectedCampaign
      if (!campaign) return 0
      return _campaignDiscount(campaign, this.cartSubtotalCents, this)
    },
    get cartTaxCents() {
      if (!this.profile) return 0
      return Math.round((this.cartSubtotalCents - this.cartDiscountCents) * this.profile.taxRate)
    },
    get cartTotalCents() {
      return this.cartSubtotalCents - this.cartDiscountCents + this.cartTaxCents + this.tipCents
    },
  }

  /**
   * Present a proposal to the model.
   * Validates and merges the proposal, then triggers state + render.
   * @param {Partial<StoreModel>} proposal
   */
  function present(proposal) {
    Object.assign(model, proposal)
    // Auto-persist cart whenever it changes
    if ('cart' in proposal || 'tipCents' in proposal || 'scheduledFor' in proposal) {
      if (model.cart.length > 0 || model.tipCents > 0) {
        saveCart(model.cart, model.tipCents, model.scheduledFor)
      } else {
        clearSavedCart()
      }
    }
    const renderFn = computeState(model)
    renderFn()
    nap(model)
  }

  // ---------------------------------------------------------------------------
  // Actions — called by UI components; produce proposals
  // ---------------------------------------------------------------------------

  const actions = {

    /** Called on page load — fetches profile + menu */
    async loadStore() {
      try {
        const [profileRes, menuRes, topDishesRes] = await Promise.all([
          fetch('/api/store/profile'),
          fetch('/api/store/menu'),
          fetch('/api/store/top-dishes'),
        ])

        if (!profileRes.ok) throw new Error('Merchant not found')
        if (!menuRes.ok)   throw new Error('Could not load menu')

        const profileData = await profileRes.json()
        const menuData    = await menuRes.json()
        const topDishesData = topDishesRes.ok ? await topDishesRes.json() : { topDishes: [] }

        // Set splash image + restaurant name, then fade out
        _populateSplash(profileData)
        await _fadeSplash(!!profileData.splashUrl)
        // Show one-time welcome message (resolves immediately if already seen or not set)
        await _maybeShowWelcomeModal(profileData)

        // Initialise Finix fraud detection if this merchant uses Finix payments.
        // The session key is captured here so Finix can track the browser session
        // from browse-time through to checkout.
        if (profileData.paymentProvider === 'finix' &&
            profileData.finixMerchantId && profileData.finixEnvironment) {
          _initFinixAuth(profileData.finixEnvironment, profileData.finixMerchantId)
        }

        // Inject Google Analytics gtag.js once — only if a measurement ID is
        // configured and the script hasn't been injected yet this session.
        if (profileData.gaTagId && !document.getElementById('gtag-script')) {
          const id = profileData.gaTagId
          const s = document.createElement('script')
          s.id    = 'gtag-script'
          s.async = true
          s.src   = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id)
          document.head.appendChild(s)
          window.dataLayer = window.dataLayer || []
          function gtag() { window.dataLayer.push(arguments) }
          gtag('js', new Date())
          gtag('config', id)
        }

        // Load campaign: prefer ?c= URL param, fall back to localStorage.
        // Strip the params immediately to keep the URL clean (no page reload).
        let qrCampaign = null
        let _pendingOfferPreview = null   // set when we need to show the offer modal
        const _urlParams = new URLSearchParams(window.location.search)
        const _campaignSlug = _urlParams.get('c')
        const _couponCode   = _urlParams.get('code')
        if (_campaignSlug) {
          try {
            const slug      = _campaignSlug.toUpperCase().replace(/[^A-Z0-9_-]/g, '')
            // Build hashed identifiers from stored customer data (privacy-preserving).
            // Names are intentionally NOT hashed: customers share first names /
            // nicknames, so a name hash creates false-positive blocks for legitimate
            // distinct customers. Only phone + email are reliably unique.
            let phoneHash = '', emailHash = ''
            try {
              const _cust = JSON.parse(localStorage.getItem('kizo_customer') || 'null')
              if (_cust) {
                const enc = new TextEncoder()
                const digest = async (v) => {
                  const buf = await crypto.subtle.digest('SHA-256', enc.encode(v))
                  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
                }
                if (_cust.phone) phoneHash = await digest(_cust.phone.replace(/\D/g, ''))
                if (_cust.email) emailHash = await digest(_cust.email.toLowerCase().trim())
              }
            } catch { /* non-fatal */ }

            const previewPayload = { slug }
            if (phoneHash) previewPayload.phoneHash = phoneHash
            if (emailHash) previewPayload.emailHash = emailHash
            const res = await fetch('/api/store/campaign-instance', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(previewPayload),
            })

            if (res.status === 410) {
              clearSavedCampaign()
              setTimeout(() => showToast('This promotion has ended.'), 500)
            } else if (res.status === 404) {
              // Unknown slug — silently discard; clean URL
              clearSavedCampaign()
            } else if (res.ok) {
              const preview = await res.json()
              clearDismissedCampaign()  // fresh link clears any prior dismiss
              if (_couponCode) preview.couponCode = _couponCode.toUpperCase().replace(/[^A-Z0-9]/g, '')
              // Show the offer preview modal (user must accept to apply)
              _pendingOfferPreview = preview
              // Pre-save campaign data so accept action can restore it from model state
              saveCampaign(preview)
            } else {
              clearSavedCampaign()
              const errBody = await res.json().catch(() => ({}))
              if (errBody.error === 'inactive') setTimeout(() => showToast('This offer is no longer active.'), 500)
            }
          } catch { /* non-fatal — store works without campaign */ }
          // Strip ?c=, ?code=, ?src= from URL regardless of campaign validity
          const cleanUrl = window.location.pathname
          history.replaceState(null, '', cleanUrl)
        } else {
          const saved = loadSavedCampaign()
          if (saved && !isCampaignDismissed(saved.slug)) {
            qrCampaign = saved
          }
        }

        // Fetch ambient auto-apply campaigns (coupon_code_required=0, currently active)
        let ambientCampaigns = []
        try {
          const ambRes = await fetch('/api/campaigns')
          if (ambRes.ok) {
            const body = await ambRes.json()
            ambientCampaigns = (body.campaigns || []).filter(c => !isCampaignDismissed(c.slug))
          }
        } catch { /* non-fatal */ }

        // Merge QR campaign first, then ambient — deduplicate by slug
        const _seen = new Set()
        const activeCampaigns = []
        for (const c of [qrCampaign, ...ambientCampaigns]) {
          if (c && !_seen.has(c.slug)) {
            _seen.add(c.slug)
            activeCampaigns.push(c)
          }
        }

        // QR campaigns are auto-selected only when restored from localStorage (no modal needed).
        // When coming fresh from a QR link, _pendingOfferPreview is set — user must accept first.
        const selectedCampaignSlug = _pendingOfferPreview ? null : (qrCampaign?.slug ?? null)
        const offerPreview = _pendingOfferPreview ?? null

        // Route to CHECKOUT if the customer backed out of the payment page —
        // their cart was restored in boot() and they want to review/modify.
        if (_resumeCheckoutOnLoad) {
          _resumeCheckoutOnLoad = false
          present({ appState: 'CHECKOUT', profile: profileData, menu: menuData.menu, topDishes: topDishesData.topDishes || [], activeCampaigns, selectedCampaignSlug, offerPreview })
        } else {
          present({ appState: 'BROWSING', profile: profileData, menu: menuData.menu, topDishes: topDishesData.topDishes || [], activeCampaigns, selectedCampaignSlug, offerPreview })
        }

        // If boot() detected ?fb=TOKEN (printed bill QR), fetch context and open
        // the order feedback modal now that the store is loaded.
        if (_pendingFeedbackToken) {
          const token = _pendingFeedbackToken
          _pendingFeedbackToken = null
          fetch(`/api/store/feedback-context?token=${encodeURIComponent(token)}`)
            .then((r) => r.ok ? r.json() : null)
            .then((ctx) => {
              if (!ctx) return
              const items = (ctx.dishNames || []).map((name) => ({ name }))
              _openFeedbackOrder(ctx.orderId, items)
            })
            .catch(() => { /* expired or network error — silently skip */ })
        }
      } catch (err) {
        present({ appState: 'ERROR', errorMessage: err.message || 'Failed to load store.' })
      }
    },

    /** Open modifier sheet for an item */
    selectItem(item) {
      // selectedModifiers is always { groupId: string[] }.
      // For single-select required groups, auto-pick the first option.
      // Multi-select groups start empty so the customer chooses freely.
      const defaults = {}
      for (const group of (item.modifierGroups || [])) {
        const isSingle = group.maxAllowed === 1
        if (isSingle && group.minRequired > 0 && group.modifiers.length > 0) {
          defaults[group.id] = [group.modifiers[0].id]
        } else {
          defaults[group.id] = []
        }
      }
      present({ appState: 'ITEM', selectedItem: item, selectedModifiers: defaults, itemQty: 1 })
    },

    /** Edit an existing cart item — opens modifier sheet pre-populated with current selections */
    editCartItem(idx) {
      const entry = model.cart[idx]
      if (!entry) return

      // Rebuild selectedModifiers from the resolved modifiers in the cart entry
      const restored = {}
      for (const group of (entry.item.modifierGroups || [])) {
        restored[group.id] = entry.selectedModifiers
          .filter((m) => group.modifiers.some((gm) => gm.id === m.id))
          .map((m) => m.id)
      }

      present({
        appState: 'ITEM',
        selectedItem: entry.item,
        selectedModifiers: restored,
        itemQty: entry.qty || 1,
        editingCartIdx: idx,
      })
    },

    /** Close modifier sheet — return to CHECKOUT if editing, otherwise BROWSING */
    closeItem() {
      const returnState = model.editingCartIdx !== null ? 'CHECKOUT' : 'BROWSING'
      present({ appState: returnState, selectedItem: null, selectedModifiers: {}, itemQty: 1, editingCartIdx: null })
    },

    /**
     * Open the item name / kitchen note editor for a cart entry.
     * @param {number} idx - index into model.cart[]
     */
    openItemNoteEditor(idx) {
      if (idx < 0 || idx >= model.cart.length) return
      present({ editingNoteIdx: idx })
    },

    /**
     * Save the name and kitchen note for the item being edited.
     * Clears the note editor and re-renders checkout.
     * @param {{ itemName: string, kitchenNote: string, instructionToken?: string|null, instructionPerUnitCents?: number, instructionPerEntryCents?: number }} note
     */
    saveItemNote({ itemName, kitchenNote, instructionToken, instructionPerUnitCents, instructionPerEntryCents }) {
      const idx = model.editingNoteIdx
      if (idx === null || idx < 0 || idx >= model.cart.length) {
        present({ editingNoteIdx: null })
        return
      }
      const newCart = [...model.cart]
      const entry = newCart[idx]
      const perUnit  = instructionPerUnitCents  || 0
      const perEntry = instructionPerEntryCents || 0
      newCart[idx] = {
        ...entry,
        itemName:    itemName.trim()    || null,
        kitchenNote: kitchenNote.trim() || null,
        instructionToken:          instructionToken || null,
        instructionPerUnitCents:   perUnit,
        instructionPerEntryCents:  perEntry,
        instructionSurchargeCents: perUnit * entry.qty + perEntry,
      }
      present({ cart: newCart, editingNoteIdx: null })
    },

    /** Toggle a modifier selection within a group (supports both single- and multi-select) */
    toggleModifier(groupId, modifierId) {
      const group = (model.selectedItem?.modifierGroups || []).find((g) => g.id === groupId)
      // maxAllowed === 1 → single-select (radio); null or >1 → multi-select (checkbox)
      const isSingle = group?.maxAllowed === 1
      const maxAllowed = group?.maxAllowed ?? null

      const updated = { ...model.selectedModifiers }
      const current = updated[groupId] || []

      if (current.includes(modifierId)) {
        // Deselect — always allowed
        updated[groupId] = current.filter((id) => id !== modifierId)
      } else if (isSingle) {
        // Single-select: replace any existing selection
        updated[groupId] = [modifierId]
      } else {
        // Multi-select: add unless at maxAllowed cap
        if (maxAllowed !== null && current.length >= maxAllowed) return
        updated[groupId] = [...current, modifierId]
      }

      present({ selectedModifiers: updated })
    },

    /** Set quantity for current item being added */
    setItemQty(qty) {
      const n = Math.max(1, Math.min(99, parseInt(qty, 10) || 1))
      present({ itemQty: n })
    },

    /** Validate modifier selections and add item(s) to cart */
    /**
     * @param {{ instructionToken?: string|null, instructionPerUnitCents?: number, instructionPerEntryCents?: number }} [opts]
     */
    addToCart(opts = {}) {
      const { instructionToken = null, instructionPerUnitCents = 0, instructionPerEntryCents = 0 } = opts
      const item   = model.selectedItem
      const groups = item.modifierGroups || []
      const qty    = model.itemQty || 1

      // Read per-dish name + kitchen note from the modifier sheet inputs
      const itemName    = document.getElementById('sheet-item-name')?.value.trim()         || null
      const kitchenNote = document.getElementById('sheet-item-kitchen-note')?.value.trim() || null

      // Validate required groups — must have at least minRequired selections
      for (const group of groups) {
        const selections = model.selectedModifiers[group.id] || []
        if (group.minRequired > 0 && selections.length < group.minRequired) {
          window.StoreCart?.highlightMissingGroup?.(group.id)
          return
        }
      }

      // Resolve selected modifiers into objects (handles both single- and multi-select)
      const resolvedMods = []
      let modifierCents  = 0

      for (const group of groups) {
        const selectedIds = model.selectedModifiers[group.id] || []
        for (const selectedId of selectedIds) {
          const mod = group.modifiers.find((m) => m.id === selectedId)
          if (mod) {
            resolvedMods.push({ id: mod.id, name: mod.name, priceCents: mod.price_cents })
            modifierCents += mod.price_cents
          }
        }
      }

      const unitCents = item.priceCents + modifierCents
      // per_unit surcharge multiplied by qty; per_entry surcharge added flat once.
      const instructionSurchargeCents = instructionPerUnitCents * qty + instructionPerEntryCents
      const totalCents = unitCents * qty + instructionSurchargeCents

      const modKey  = resolvedMods.map((m) => m.id).sort().join(',')
      const newCart = [...model.cart]
      const editIdx = model.editingCartIdx

      if (editIdx !== null && editIdx >= 0 && editIdx < newCart.length) {
        // Editing existing cart entry — replace in place, use DOM name/note values
        newCart[editIdx] = {
          item,
          selectedModifiers: resolvedMods,
          modKey,
          qty,
          totalCents,
          unitCents,
          itemName,
          kitchenNote,
          instructionToken,
          instructionPerUnitCents,
          instructionPerEntryCents,
          instructionSurchargeCents,
        }
      } else {
        // Only merge identical items when there are no per-item customizations
        const canMerge = !kitchenNote && !instructionToken
        const existingIdx = canMerge
          ? newCart.findIndex((e) => e.item.id === item.id && e.modKey === modKey && !e.kitchenNote && !e.instructionToken)
          : -1
        if (existingIdx >= 0) {
          const existing = newCart[existingIdx]
          newCart[existingIdx] = {
            ...existing,
            qty:        existing.qty + qty,
            totalCents: existing.unitCents * (existing.qty + qty),
          }
        } else {
          newCart.push({
            item,
            selectedModifiers: resolvedMods,
            modKey,
            qty,
            totalCents,
            unitCents,
            itemName,
            kitchenNote,
            instructionToken,
            instructionPerUnitCents,
            instructionPerEntryCents,
            instructionSurchargeCents,
          })
        }
      }

      // First item ever added — prompt iOS users to install before they reach checkout
      if (model.cart.length === 0 && newCart.length > 0) {
        window.StorePush?.maybeShowIOSBanner?.()
      }

      // Return to CHECKOUT when editing, BROWSING when adding new
      const returnState = editIdx !== null ? 'CHECKOUT' : 'BROWSING'
      present({ appState: returnState, cart: newCart, selectedItem: null, selectedModifiers: {}, itemQty: 1, editingCartIdx: null })
    },

    /** Remove a cart entry by index */
    removeFromCart(index) {
      const newCart = model.cart.filter((_, i) => i !== index)
      present({ cart: newCart })
    },

    /**
     * Change the quantity of a cart entry.
     * Removes the entry when newQty drops below 1.
     * @param {number} index  - cart array index
     * @param {number} newQty - desired quantity (≥ 1 to keep, < 1 to remove)
     */
    updateCartQty(index, newQty) {
      if (newQty < 1) {
        const newCart = model.cart.filter((_, i) => i !== index)
        present({ cart: newCart })
        return
      }
      const newCart = model.cart.map((entry, i) => {
        if (i !== index) return entry
        const perUnit  = entry.instructionPerUnitCents  || 0
        const perEntry = entry.instructionPerEntryCents || 0
        const instrCents = perUnit * newQty + perEntry
        return { ...entry, qty: newQty, instructionSurchargeCents: instrCents, totalCents: entry.unitCents * newQty + instrCents }
      })
      present({ cart: newCart })
    },

    /** Update the selected tip amount (in cents) */
    setTip(tipCents) {
      present({ tipCents: Math.max(0, tipCents) })
    },

    /** Clear the cart and return to browsing */
    clearCart() {
      present({ cart: [], tipCents: 0, appState: 'BROWSING' })
    },

    /**
     * Set the scheduled pickup time.
     * @param {string|null} iso — ISO 8601 timestamp, or null for ASAP
     */
    setScheduledFor(iso) {
      present({ scheduledFor: iso || null })
    },

    /**
     * Cancel the current order. Only valid when the order is still within
     * the cancellation window (before pickup_time - prep_time_minutes).
     */
    async cancelOrder() {
      const order = model.currentOrder
      if (!order?.orderId) return

      const cancelBtn = document.getElementById('confirmed-cancel-btn')
      if (cancelBtn) {
        cancelBtn.disabled = true
        cancelBtn.textContent = 'Cancelling…'
      }

      try {
        const res = await fetch(`/api/store/orders/${order.orderId}/cancel`, { method: 'POST' })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Cancellation failed')
        }

        // Show cancellation confirmation, hide cancel section
        setVisible(document.getElementById('confirmed-cancel-section'), false)
        setVisible(document.getElementById('confirmed-cancelled-msg'), true)

        // Update tracker to cancelled state
        updateStatusTracker('cancelled', null)

        // Clear the active order bar
        clearActiveOrder()
        renderActiveOrderBar()
      } catch (err) {
        if (cancelBtn) {
          cancelBtn.disabled = false
          cancelBtn.textContent = 'Cancel Order'
        }
        // Show inline error
        const deadlineNote = document.getElementById('confirmed-cancel-deadline')
        if (deadlineNote) {
          deadlineNote.textContent = err.message || 'Could not cancel. Please contact the restaurant.'
          deadlineNote.classList.add('cancel-deadline-error')
        }
      }
    },

    /** Show checkout panel */
    openCheckout() {
      const p = model.profile
      if (p && p.ordersPaused && p.pausedUntil && new Date().toISOString() < p.pausedUntil) return
      present({ appState: 'CHECKOUT' })
    },

    /** Back to menu browsing */
    backToBrowsing() {
      present({ appState: 'BROWSING' })
    },

    /**
     * Submit the order (pre-payment) then redirect to Converge.
     * @param {{ name: string, phone: string, email: string, note: string, utensils: boolean }} customerInfo
     */
    async submitOrder(customerInfo) {
      present({ appState: 'PAYING' })

      try {
        // Build items payload — expand qty into repeated entries for the server
        const items = model.cart.flatMap((entry) => {
          const row = {
            itemId:    entry.item.id,
            modifiers: entry.selectedModifiers.map((m) => m.id),
            ...(entry.itemName    ? { itemName:    entry.itemName    } : {}),
            ...(entry.kitchenNote ? { kitchenNote: entry.kitchenNote } : {}),
            // Only the first copy of a qty>1 item carries the instruction token —
            // token is one-time and already covers the single surcharge intent.
            ...(entry.instructionToken ? { instructionToken: entry.instructionToken } : {}),
          }
          return Array.from({ length: entry.qty || 1 }, (_, qi) => {
            if (qi === 0) return row
            // Subsequent copies: no token (already consumed above)
            const { instructionToken: _t, ...rowNoToken } = row
            return rowNoToken
          })
        })

        const orderPayload = {
          customerName:    customerInfo.name,
          customerPhone:   customerInfo.phone || undefined,
          customerEmail:   customerInfo.email || undefined,
          items,
          note:            customerInfo.note  || undefined,
          utensilsNeeded:  customerInfo.utensils,
          tipCents:        model.tipCents || 0,
          scheduledFor:    model.scheduledFor || undefined,
        }
        if (model.selectedCampaign && model.cartDiscountCents > 0) {
          orderPayload.campaignSlug          = model.selectedCampaign.slug
          orderPayload.expectedDiscountCents = model.cartDiscountCents
          if (model.selectedCampaign.couponCode)  orderPayload.couponCode      = model.selectedCampaign.couponCode
          if (model.selectedCampaign.scanToken)   orderPayload.couponScanToken = model.selectedCampaign.scanToken
        }
        const orderRes = await fetch('/api/store/orders', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(orderPayload),
        })

        if (!orderRes.ok) {
          const err = await orderRes.json().catch(() => ({}))
          throw new Error(err.error || 'Failed to place order')
        }

        const order = await orderRes.json()

        // Persist order + cart items for recovery and confirmed page display
        const orderItems = model.cart.map((entry) => ({
          name:        entry.item.name,
          qty:         entry.qty || 1,
          unitCents:   entry.unitCents || entry.totalCents,
          totalCents:  entry.totalCents,
          modifiers:   entry.selectedModifiers.map((m) => ({ name: m.name, priceCents: m.priceCents })),
          itemName:    entry.itemName    || undefined,
          kitchenNote: entry.kitchenNote || undefined,
        }))
        try {
          localStorage.setItem(`kizo_order_${order.orderId}`, JSON.stringify({
            orderId:       order.orderId,
            pickupCode:    order.pickupCode,
            subtotalCents: order.subtotalCents,
            taxCents:      order.taxCents,
            totalCents:    order.totalCents,
            items:         orderItems,
            customerName:  customerInfo.name,
            createdAt:     new Date().toISOString(),
            scheduledFor:  order.scheduledFor || null,
          }))
        } catch { /* ignore storage errors */ }

        // Persist active order immediately so a page refresh shows the status bar.
        // 'pending_payment' = order created, payment not yet confirmed.
        // Status advances to 'submitted' once payment-result confirms the charge.
        saveActiveOrder(order.orderId, order.pickupCode, 'pending_payment', null)

        // Save a cart snapshot so it can be restored if the customer backs out
        // of the payment page without completing payment.
        try {
          const cartSnapshot = localStorage.getItem(CART_KEY)
          if (cartSnapshot) localStorage.setItem(PENDING_CART_KEY, cartSnapshot)
        } catch { /* ignore */ }

        // Cart is now an in-flight order — clear the persisted copies so a
        // page refresh doesn't restore a stale cart or campaign alongside the active order.
        clearSavedCart()
        clearSavedCampaign()
        // Record locally that this scan_token was used so the same device can't
        // re-present the offer after a page refresh (server is authoritative; this is UX).
        if (model.selectedCampaign?.scanToken) _markScanTokenRedeemed(model.selectedCampaign.scanToken)

        // Store customer info for next visit (24-hour TTL — shared devices expire overnight)
        try {
          localStorage.setItem('kizo_customer', JSON.stringify({
            name:      customerInfo.name,
            phone:     customerInfo.phone,
            email:     customerInfo.email || undefined,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          }))
        } catch { /* ignore */ }

        // Now get the payment URL — send a relative path; server builds the
        // absolute URL for the payment processor using its own configured domain.
        const returnUrl = `/pay-return?order=${order.orderId}`

        // Finix fraud detection: get the session key from the Finix Auth instance
        // initialised in loadStore(), or fall back to a UUID if the SDK hasn't loaded.
        const fraudSessionId = _getFinixSessionKey()

        const payRes = await fetch(`/api/store/orders/${order.orderId}/pay`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ returnUrl, fraudSessionId }),
        })

        if (!payRes.ok) {
          const err = await payRes.json().catch(() => ({}))
          throw new Error(err.error || 'Could not initiate payment')
        }

        const { paymentUrl } = await payRes.json()

        // Store order for return page
        present({
          currentOrder: {
            orderId:       order.orderId,
            pickupCode:    order.pickupCode,
            subtotalCents: order.subtotalCents,
            taxCents:      order.taxCents,
            totalCents:    order.totalCents,
            items:         orderItems,
            scheduledFor:  order.scheduledFor || null,
          },
        })

        // Redirect to Converge HPP — no return from here in this tab
        window.location.href = paymentUrl

      } catch (err) {
        // Return to checkout with error
        present({ appState: 'CHECKOUT', errorMessage: err.message || 'An error occurred.' })
      }
    },

    /**
     * Resume payment for an order that is still in 'pending_payment' state.
     * Called when the customer refreshes the page before payment completes,
     * then taps the active-order bar.
     *
     * Checks server status first — the payment may have already been processed
     * (phone died after payment but before /pay-return completed). If so, we
     * recover directly to CONFIRMED without charging the customer again.
     * @param {string} orderId
     */
    async resumePayment(orderId) {
      present({ appState: 'PAYING', paymentDeclined: false, declinedOrderId: null })
      try {
        // ── Step 1: Check actual server-side order status ──────────────────
        // The payment processor may have already charged the customer even
        // though our client never received confirmation (crash, network drop).
        const statusRes = await fetch(`/api/store/orders/${orderId}/status`)
        if (statusRes.ok) {
          const statusData = await statusRes.json()
          const paidStatuses = new Set(['submitted', 'confirmed', 'preparing', 'ready', 'completed'])

          if (paidStatuses.has(statusData.status)) {
            // Payment already confirmed — recover to CONFIRMED without repaying
            const pickupCode  = statusData.pickupCode
            const storedOrder = (() => {
              try { return JSON.parse(localStorage.getItem(`kizo_order_${orderId}`) || 'null') } catch { return null }
            })()
            // Clear any stale payment return data
            try { localStorage.removeItem('kizo_payment_return') } catch { /* ignore */ }
            saveActiveOrder(orderId, pickupCode, statusData.status, null)
            present({
              appState: 'CONFIRMED',
              cart: [], tipCents: 0,
              currentOrder: {
                orderId,
                pickupCode,
                subtotalCents: storedOrder?.subtotalCents ?? 0,
                taxCents:      storedOrder?.taxCents ?? 0,
                totalCents:    storedOrder?.totalCents ?? 0,
                items:         storedOrder?.items || [],
                scheduledFor:  storedOrder?.scheduledFor || null,
              },
            })
            return
          }

          if (statusData.status === 'cancelled') {
            clearActiveOrder()
            try { localStorage.removeItem('kizo_payment_return') } catch { /* ignore */ }
            present({ appState: 'BROWSING', errorMessage: 'This order was cancelled.' })
            return
          }
        }

        // ── Step 2: Order still pending_payment — get fresh payment URL ────
        const returnUrl      = `/pay-return?order=${orderId}`
        const fraudSessionId = _getFinixSessionKey()
        const payRes = await fetch(`/api/store/orders/${orderId}/pay`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ returnUrl, fraudSessionId }),
        })
        if (!payRes.ok) {
          const err = await payRes.json().catch(() => ({}))
          throw new Error(err.error || 'Could not resume payment')
        }
        const { paymentUrl } = await payRes.json()
        window.location.href = paymentUrl
      } catch (err) {
        present({ appState: 'BROWSING', errorMessage: err.message || 'Payment could not be resumed.' })
      }
    },

    /**
     * Record payment result (called after payment redirect returns).
     * @param {{ orderId, provider, ssl_result?, ssl_txn_id?, ssl_approval_code?, checkout_form_id? }} params
     */
    async recordPaymentResult(params) {
      present({ appState: 'PAYING' })

      try {
        // Build provider-specific body
        const body = params.provider === 'finix'
          ? { provider: 'finix' }
          : {
              ssl_result:        params.ssl_result,
              ssl_txn_id:        params.ssl_txn_id,
              ssl_approval_code: params.ssl_approval_code,
            }

        const res = await fetch(`/api/store/orders/${params.orderId}/payment-result`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        })

        const data = await res.json()

        // 409 means the status guard rejected — order is no longer 'pending_payment'.
        // This happens when: (a) a concurrent request already confirmed it, or
        // (b) we're replaying stale return params from localStorage for an order
        // that's already been confirmed. Treat as success and recover from storage.
        if (res.status === 409) {
          try { localStorage.removeItem(PAYMENT_RETURN_KEY) } catch { /* ignore */ }
          await actions.resumePayment(params.orderId)
          return
        }

        if (!res.ok || data.status === 'declined') {
          // Declined — keep order in pending_payment so customer can retry.
          // Restore cart from the pre-redirect snapshot so the items are visible.
          try { localStorage.removeItem(PAYMENT_RETURN_KEY) } catch { /* ignore */ }
          try {
            const snap = JSON.parse(localStorage.getItem(PENDING_CART_KEY) || 'null')
            if (snap?.cart?.length > 0) {
              model.cart     = snap.cart
              model.tipCents = snap.tipCents || 0
            }
            localStorage.removeItem(PENDING_CART_KEY)
          } catch { /* ignore — proceed with empty cart */ }
          const declinedMsg = data.message || 'Your payment was declined. Please try a different card.'
          present({
            appState:       'PAYING',
            paymentDeclined: true,
            declinedOrderId: params.orderId,
            errorMessage:    declinedMsg,
          })
          return
        }

        // Recover stored order details
        let storedOrder = model.currentOrder
        if (!storedOrder) {
          try {
            const stored = JSON.parse(localStorage.getItem(`kizo_order_${params.orderId}`) || 'null')
            if (stored) storedOrder = stored
          } catch { /* ignore */ }
        }

        const pickupCode = data.pickupCode || storedOrder?.pickupCode || '????'

        present({
          appState: 'CONFIRMED',
          cart: [],     // clear cart
          tipCents: 0,  // reset tip
          currentOrder: {
            orderId:       params.orderId,
            pickupCode,
            subtotalCents: storedOrder?.subtotalCents ?? 0,
            taxCents:      storedOrder?.taxCents ?? 0,
            totalCents:    storedOrder?.totalCents ?? 0,
            items:         storedOrder?.items || [],
            scheduledFor:  storedOrder?.scheduledFor || null,
          },
        })

        // Persist active order for cross-view status bar.
        // 'submitted' hides "Pay Now" — payment is confirmed at this point.
        saveActiveOrder(params.orderId, pickupCode, 'submitted', null)

        // Payment confirmed — clear crash-recovery and pending-cart snapshots
        try { localStorage.removeItem(PAYMENT_RETURN_KEY) } catch { /* ignore */ }
        try { localStorage.removeItem(PENDING_CART_KEY) }   catch { /* ignore */ }

        // Save to order history
        saveOrderToHistory(params.orderId)
      } catch (err) {
        present({ appState: 'ERROR', errorMessage: err.message || 'Payment verification failed.' })
      }
    },
  }

  // ---------------------------------------------------------------------------
  // State function — derives application state and returns render thunk
  // ---------------------------------------------------------------------------

  let prevAppState = null

  function computeState(m) {
    return function render() {
      // Show/hide top-level panels
      showPanel(m.appState)

      // Always render the persistent active-order bar
      renderActiveOrderBar()

      // Reset to menu view when entering BROWSING from a non-browsing state
      // (e.g., returning from CONFIRMED, CHECKOUT, ERROR)
      const enteringBrowsing = (m.appState === 'BROWSING' || m.appState === 'ITEM')
        && prevAppState !== 'BROWSING' && prevAppState !== 'ITEM' && prevAppState !== null
      prevAppState = m.appState

      switch (m.appState) {
        case 'BROWSING':
        case 'ITEM':
          if (enteringBrowsing && currentView !== 'menu') switchView('menu')
          window.StoreMenu?.render(m)
          window.StoreCart?.renderBar(m)
          window.StoreCart?.renderSheet(m)
          renderClosedBanner(m)
          renderOfferBanner(m)
          renderOfferPreviewSheet(m)
          break
        case 'CHECKOUT':
          window.StoreCart?.renderSheet(m)  // close modifier sheet if transitioning from ITEM
          window.StoreCheckout?.render(m)
          window.StoreCart?.renderBar(m)
          renderOfferBanner(m)
          renderOfferPreviewSheet(m)
          break
        case 'PAYING':
          renderPaying(m)
          break
        case 'CONFIRMED':
          renderConfirmed(m)
          break
        case 'ERROR':
          renderError(m)
          break
      }
    }
  }

  let scheduleBtnWired = false

  function renderPausedBanner(m) {
    const banner  = document.getElementById('store-paused-banner')
    const untilEl = document.getElementById('store-paused-until')
    if (!banner) return

    // Profile may be null when the customer transitions BROWSING-from-CONFIRMED
    // before loadStore() has populated it (e.g. /pay-return → CONFIRMED →
    // "Back to Menu"). nap() will redirect to LOADING on the next tick, but
    // render runs first and used to crash here, aborting StoreMenu.render and
    // leaving an empty BROWSING screen.
    if (!m.profile) {
      banner.hidden = true
      return
    }

    const isPaused = m.profile.ordersPaused && m.profile.pausedUntil &&
                     new Date().toISOString() < m.profile.pausedUntil
    if (!isPaused) {
      banner.hidden = true
      return
    }

    if (untilEl) {
      const until = new Date(m.profile.pausedUntil)
      const diff  = Math.max(0, Math.round((until - Date.now()) / 60000))
      untilEl.textContent = diff > 0
        ? `Try again in about ${diff} minute${diff === 1 ? '' : 's'}.`
        : 'Try again shortly.'
    }
    banner.hidden = false
  }

  function renderClosedBanner(m) {
    // If paused, show the paused banner instead of the hours-closed banner
    renderPausedBanner(m)
    // Same null guard as renderPausedBanner — profile may not be loaded yet.
    if (!m.profile) {
      const banner = document.getElementById('store-closed-banner')
      if (banner) banner.hidden = true
      return
    }
    if (m.profile.ordersPaused && m.profile.pausedUntil &&
        new Date().toISOString() < m.profile.pausedUntil) {
      const banner = document.getElementById('store-closed-banner')
      if (banner) banner.hidden = true
      return
    }

    const banner  = document.getElementById('store-closed-banner')
    const nextEl  = document.getElementById('store-closed-next')
    if (!banner) return

    const status = window.StoreMenu?.getStoreOpenStatus(m.profile)
    if (!status || status.isOpen) {
      banner.hidden = true
      return
    }

    if (nextEl) {
      nextEl.textContent = status.nextOpenLabel
        ? `Opens ${status.nextOpenLabel}`
        : 'Check back later for our hours.'
    }
    banner.hidden = false

    // Wire "Schedule an Order" button once
    if (!scheduleBtnWired) {
      scheduleBtnWired = true
      const btn = document.getElementById('store-closed-schedule-btn')
      if (btn) btn.addEventListener('click', () => actions.openCheckout())
    }
  }

  function _isCampaignScheduleActive(campaign, tz, refDate) {
    const sched = campaign.schedule
    if (!sched) return true
    const now      = refDate instanceof Date ? refDate : new Date()
    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    if (sched.days?.length) {
      const dayStr   = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)
      const localDay = DAY_NAMES.indexOf(dayStr)
      if (localDay === -1 || !sched.days.includes(localDay)) return false
    }
    if (sched.windows?.length) {
      const timeStr   = new Intl.DateTimeFormat('en-GB',
        { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).format(now)
      const [h, mn]   = timeStr.split(':').map(Number)
      const localMins = h * 60 + mn
      return sched.windows.some(w => {
        const [sh, sm] = w.start.split(':').map(Number)
        const [eh, em] = w.end.split(':').map(Number)
        return localMins >= sh * 60 + sm && localMins <= eh * 60 + em
      })
    }
    return true
  }

  function renderOfferBanner(m) {
    const banner = document.getElementById('offer-banner')
    if (!banner) return

    const campaigns = m.activeCampaigns
    if (!campaigns || !campaigns.length) {
      banner.hidden = true
      banner.innerHTML = ''
      return
    }

    const selected    = m.selectedCampaignSlug
    const tz          = m.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const isCheckout  = m.appState === 'CHECKOUT'
    // For scheduled orders, evaluate the campaign window against the scheduled time, not now
    const schedRef    = m.scheduledFor ? new Date(m.scheduledFor) : undefined
    banner.hidden = false
    banner.classList.toggle('offer-banner--checkout', isCheckout)
    banner.innerHTML = campaigns.map((c) => {
      const isSelected  = c.slug === selected
      const isNowValid  = _isCampaignScheduleActive(c, tz, schedRef)
      const label       = c.offer?.label || c.name || 'Special offer'
      const validity    = _fmtValidityWindow(c.start_at, c.valid_until)
      const text        = validity ? `${label} · ${validity}` : label
      const classes     = ['offer-banner-item',
        isSelected  ? 'offer-banner-item--selected' : '',
        !isNowValid ? 'offer-banner-item--inactive'  : '',
      ].filter(Boolean).join(' ')
      // Checkout: strikethrough; menu: plain label (yellow styling via CSS)
      const labelHtml = (!isNowValid && isCheckout)
        ? `<s>${escHtml(text)}</s>`
        : escHtml(text)
      const inactiveHtml = isNowValid ? '' : '<span class="offer-banner-inactive-notice">Not valid now</span>'
      return `<div class="${classes}" data-slug="${escHtml(c.slug)}" role="button" tabindex="0" aria-pressed="${isSelected}">
        <span class="offer-banner-select" aria-hidden="true"></span>
        <span class="offer-banner-text">${labelHtml}</span>
        ${inactiveHtml}
        <button class="offer-banner-dismiss" aria-label="Remove offer" data-slug="${escHtml(c.slug)}">&times;</button>
      </div>`
    }).join('')

    // Select / deselect on row click (inactive offers cannot be selected)
    banner.querySelectorAll('.offer-banner-item').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.offer-banner-dismiss')) return
        if (row.classList.contains('offer-banner-item--inactive')) return
        const slug = row.dataset.slug
        present({ selectedCampaignSlug: slug === model.selectedCampaignSlug ? null : slug })
      })
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click() }
      })
    })

    // Dismiss removes from wallet
    banner.querySelectorAll('.offer-banner-dismiss').forEach(btn => {
      btn.addEventListener('click', () => {
        const slug = btn.dataset.slug
        dismissCampaign(slug)
        present({
          activeCampaigns:       model.activeCampaigns.filter(c => c.slug !== slug),
          selectedCampaignSlug:  slug === model.selectedCampaignSlug ? null : model.selectedCampaignSlug,
        })
      })
    })
  }

  // ── Offer preview sheet — shown once when customer arrives via QR link ───────
  let _offerPreviewWired = false
  function renderOfferPreviewSheet(m) {
    const sheet    = document.getElementById('offer-preview-sheet')
    const backdrop = document.getElementById('offer-preview-backdrop')
    if (!sheet || !backdrop) return

    const preview = m.offerPreview
    if (!preview) {
      if (sheet.classList.contains('open')) {
        sheet.classList.remove('open')
        const hideSheet = () => {
          sheet.hidden    = true
          backdrop.hidden = true
          sheet.setAttribute('aria-hidden', 'true')
        }
        sheet.addEventListener('transitionend', hideSheet, { once: true })
        setTimeout(hideSheet, 350)
      } else {
        sheet.hidden    = true
        backdrop.hidden = true
        sheet.setAttribute('aria-hidden', 'true')
      }
      return
    }

    // Populate content
    const campaign = preview
    document.getElementById('offer-preview-title').textContent = campaign.name || 'Special Offer'
    document.getElementById('offer-preview-description').textContent = campaign.offer?.label || campaign.name || ''

    const pendingBadge = document.getElementById('offer-preview-pending-badge')
    const usedBadge    = document.getElementById('offer-preview-used-badge')
    pendingBadge.hidden = campaign.computed_status !== 'pending'
    usedBadge.hidden    = !campaign.already_redeemed

    // Format dates
    const datesEl = document.getElementById('offer-preview-dates')
    const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    const parts = []
    if (campaign.start_at) parts.push(`Starts: ${fmt(campaign.start_at)}`)
    if (campaign.valid_until) parts.push(`Expires: ${fmt(campaign.valid_until)}`)
    datesEl.textContent = parts.join('  ·  ')

    // Schedule (days / time windows)
    const scheduleEl = document.getElementById('offer-preview-schedule')
    if (scheduleEl) {
      const schedText = _fmtSchedule(campaign.schedule)
      if (schedText) {
        scheduleEl.textContent = `Valid: ${schedText}`
        scheduleEl.hidden = false
      } else {
        scheduleEl.hidden = true
      }
    }

    // Coupon code (if present in URL)
    const codeContainer = document.getElementById('offer-preview-code')
    const codeValue     = document.getElementById('offer-preview-code-value')
    if (campaign.couponCode) {
      codeValue.textContent = campaign.couponCode
      codeContainer.hidden  = false
    } else {
      codeContainer.hidden = true
    }

    // Update accept button label based on state
    const acceptBtn = document.getElementById('offer-accept-btn')
    if (campaign.computed_status === 'pending') {
      acceptBtn.textContent = 'Remind me when active'
    } else if (campaign.already_redeemed) {
      acceptBtn.textContent = 'Got it'
    } else {
      acceptBtn.textContent = 'Accept Offer'
    }

    // Wire buttons once. Handlers read model.offerPreview at click time (not at wire time),
    // so scanning a second QR code in the same session always acts on the current campaign —
    // even though the listeners themselves are attached only on the first render.
    if (!_offerPreviewWired) {
      _offerPreviewWired = true

      document.getElementById('offer-accept-btn').addEventListener('click', () => {
        const p = model.offerPreview
        if (!p) return
        const newCampaigns = model.activeCampaigns.filter(c => c.slug !== p.slug)
        // Only actually apply if active and not already redeemed
        const shouldApply = p.computed_status === 'active' && !p.already_redeemed
        if (shouldApply) newCampaigns.unshift(p)
        present({
          offerPreview: null,
          activeCampaigns: newCampaigns,
          selectedCampaignSlug: shouldApply ? p.slug : model.selectedCampaignSlug,
        })
        if (p.computed_status === 'pending') setTimeout(() => showToast("We'll remind you when this offer is active."), 300)
      })

      document.getElementById('offer-decline-btn').addEventListener('click', () => {
        const p = model.offerPreview
        if (p) clearSavedCampaign()
        present({ offerPreview: null })
      })

      document.getElementById('offer-preview-backdrop').addEventListener('click', () => {
        present({ offerPreview: null })
      })
    }

    // Open sheet
    sheet.hidden    = false
    sheet.setAttribute('aria-hidden', 'false')
    backdrop.hidden = false
    if (!sheet.classList.contains('open')) requestAnimationFrame(() => sheet.classList.add('open'))
  }

  function showPanel(appState) {
    // On re-loads (splash already shown), keep the current panel visible
    // while data fetches silently — avoids flashing the splash screen when
    // the user navigates back to the menu from the order status page.
    if (appState === 'LOADING' && _splashFaded) return

    const panelMap = {
      LOADING:   'state-loading',
      BROWSING:  'state-browsing',
      ITEM:      'state-browsing',   // browsing stays visible; sheet overlays
      CHECKOUT:  'state-checkout',
      PAYING:    'state-paying',
      CONFIRMED: 'state-confirmed',
      ERROR:     'state-error',
    }

    const allPanels = ['state-loading', 'state-browsing', 'state-checkout',
                       'state-paying', 'state-confirmed', 'state-error']

    const target = panelMap[appState] || 'state-loading'
    allPanels.forEach((id) => {
      const el = document.getElementById(id)
      if (el) el.hidden = (id !== target)
    })
  }

  let _payingRetryWired = false
  let _payingBackWired  = false

  function renderPaying(m) {
    const processing = document.getElementById('paying-processing')
    const declined   = document.getElementById('paying-declined')
    const msgEl      = document.getElementById('paying-declined-msg')
    if (!processing || !declined) return

    setVisible(processing, !m.paymentDeclined)
    setVisible(declined,    m.paymentDeclined)

    if (!m.paymentDeclined) return

    if (msgEl) msgEl.textContent = m.errorMessage || 'Your payment was declined. Please try a different card.'

    if (!_payingRetryWired) {
      _payingRetryWired = true
      document.getElementById('paying-retry-btn')?.addEventListener('click', () => {
        actions.resumePayment(model.declinedOrderId)
      })
    }
    if (!_payingBackWired) {
      _payingBackWired = true
      document.getElementById('paying-back-btn')?.addEventListener('click', () => {
        // Cancel the declined order server-side (fire-and-forget) so it doesn't
        // linger as pending_payment when the customer edits and resubmits.
        const oid = model.declinedOrderId
        if (oid) {
          fetch(`/api/store/orders/${oid}/cancel`, { method: 'POST' }).catch(() => {})
          clearActiveOrder()
        }
        present({ appState: 'CHECKOUT', paymentDeclined: false, declinedOrderId: null })
      })
    }
  }

  let confirmedRenderedOrderId = null
  function renderConfirmed(m) {
    const order = m.currentOrder
    if (!order) return

    // Reset per-order DOM state whenever a new order is shown so stale state
    // from a previous order (cancelled message, cancel button, ETA) doesn't bleed in.
    if (confirmedRenderedOrderId !== order.orderId) {
      const cancelSection  = document.getElementById('confirmed-cancel-section')
      const cancelledMsg   = document.getElementById('confirmed-cancelled-msg')
      const cancelBtn      = document.getElementById('confirmed-cancel-btn')
      const deadlineNote   = document.getElementById('confirmed-cancel-deadline')
      const etaEl          = document.getElementById('confirmed-eta')

      setVisible(cancelSection, false)
      setVisible(cancelledMsg, false)
      if (cancelBtn) {
        cancelBtn.disabled    = false
        cancelBtn.textContent = 'Cancel Order'
      }
      if (deadlineNote) {
        deadlineNote.textContent = ''
        deadlineNote.classList.remove('cancel-deadline-error')
      }
      if (etaEl) etaEl.hidden = true
    }

    const codeEl = document.getElementById('confirmed-pickup-code')
    if (codeEl) codeEl.textContent = order.pickupCode

    // Show scheduled time if customer chose a specific pickup time
    const scheduledEl    = document.getElementById('confirmed-scheduled-time')
    const scheduledLabel = document.getElementById('confirmed-scheduled-label')
    if (scheduledEl && scheduledLabel) {
      if (order.scheduledFor) {
        const t = new Date(order.scheduledFor)
        scheduledLabel.textContent = 'Ready by ' + t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        setVisible(scheduledEl, true)
      } else {
        setVisible(scheduledEl, false)
      }
    }

    // Render items and start push/polling only once per order
    if (confirmedRenderedOrderId === order.orderId) return
    confirmedRenderedOrderId = order.orderId

    // For scheduled orders, optimistically show cancel button before first poll
    // (poll will confirm or hide it within ~15s). Only on first render so a
    // second present() in CONFIRMED state (e.g. recordPaymentResult completing
    // after a bar-tap) doesn't re-show it after updateStatusTracker hid it.
    if (order.scheduledFor) {
      const cancelSection = document.getElementById('confirmed-cancel-section')
      const deadlineNote  = document.getElementById('confirmed-cancel-deadline')
      setVisible(cancelSection, true)
      if (deadlineNote) {
        deadlineNote.textContent = `Free cancellation until kitchen starts preparing your order`
        deadlineNote.classList.remove('cancel-deadline-error')
      }
    }

    const listEl = document.getElementById('confirmed-items-list')
    if (listEl && order.items?.length) {
      listEl.innerHTML = order.items.map((item) => {
        const modNames = (item.modifiers || []).map((m) => m.name).join(', ')
        const qtyLabel = (item.qty && item.qty > 1) ? ` ×${item.qty}` : ''
        return `
          <li class="checkout-item">
            <div class="checkout-item-info">
              <p class="checkout-item-name">${escHtml(item.name)}${qtyLabel}</p>
              ${modNames ? `<p class="checkout-item-mods">${escHtml(modNames)}</p>` : ''}
            </div>
            <span class="checkout-item-price">${formatCents(item.totalCents)}</span>
          </li>
        `
      }).join('')
    }

    // Kick off push subscription prompt + status polling
    window.StorePush?.onConfirmed(order.orderId)
  }

  // ---------------------------------------------------------------------------
  // View toggle: Menu vs My Orders
  // ---------------------------------------------------------------------------

  let currentView = 'menu' // 'menu' | 'history'

  function switchView(view) {
    currentView = view
    const menuBody   = document.getElementById('menu-body')
    const catNav     = document.getElementById('category-nav')
    const historyEl  = document.getElementById('order-history-section')
    const menuBtn    = document.getElementById('nav-menu-btn')
    const histBtn    = document.getElementById('nav-history-btn')

    if (view === 'history') {
      if (menuBody) menuBody.hidden = true
      if (catNav)   catNav.hidden = true
      if (historyEl) historyEl.hidden = false
      if (menuBtn)  menuBtn.classList.remove('active')
      if (histBtn)  histBtn.classList.add('active')
      renderOrderHistory(true) // force re-render when switching to view
    } else {
      if (menuBody) menuBody.hidden = false
      if (catNav)   catNav.hidden = false
      if (historyEl) historyEl.hidden = true
      if (menuBtn)  menuBtn.classList.add('active')
      if (histBtn)  histBtn.classList.remove('active')
    }
  }

  // ---------------------------------------------------------------------------
  // Back-button navigation (History API)
  //
  // The device back button must behave like in-app navigation:
  //   My Orders → Menu      (never navigate to previous page/Finix form)
  //   Menu      → exit modal (ask before leaving the app)
  //
  // Strategy: maintain a two-entry floor in the history stack so we can always
  // intercept the final back press before the browser leaves the SPA.
  //   [floor, menu]       — initial state
  //   [floor, menu, history] — when My Orders tab is open
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Focus trap — keeps keyboard focus inside a modal element while active.
  // Returns a cleanup function; call it to detach the listener.
  // ---------------------------------------------------------------------------

  /**
   * Trap Tab/Shift-Tab focus inside `el`.
   * @param {HTMLElement} el  - the modal/dialog container
   * @returns {() => void}    - call to remove the trap
   */
  function _trapFocus(el) {
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    function handler(e) {
      if (e.key !== 'Tab') return
      const focusable = Array.from(el.querySelectorAll(FOCUSABLE)).filter((n) => !n.closest('[hidden]'))
      if (!focusable.length) { e.preventDefault(); return }
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first.focus() }
      }
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }

  // How many history entries we own — used by the Leave button to skip past
  // all of them in one go without the popstate handler pushing them back.
  let _appHistoryDepth = 0
  // Set to true by the Leave button so the popstate handler steps aside.
  let _exitingApp = false

  function _initBackNavigation() {
    // Build owned history entries on the current page's stack.
    //
    // Normal store page (/):
    //   [external | floor | menu]
    //
    // Payment-return page (/pay-return):
    //   [external | finix | floor-2 | floor | menu]
    //                        ^extra guard to absorb the Finix entry behind us
    //
    // Without the extra guard, pressing back twice from CONFIRMED state exhausts
    // floor + menu and the browser navigates to the Finix checkout page.

    const onPayReturn = window.location.pathname === '/pay-return'

    history.replaceState({ view: 'menu-floor' }, '')
    _appHistoryDepth = 1

    if (onPayReturn) {
      history.pushState({ view: 'menu-floor' }, '')
      _appHistoryDepth++
    }

    history.pushState({ view: 'menu' }, '')
    _appHistoryDepth++

    window.addEventListener('popstate', (e) => {
      // Leave button set this flag — step aside and let the browser navigate.
      if (_exitingApp) return

      const view = e.state?.view

      // Not one of our owned entries — don't intercept.
      if (view !== 'menu' && view !== 'menu-floor') return

      // ── My Orders tab → device back → Menu ───────────────────────────────
      if (view === 'menu' && currentView === 'history') {
        switchView('menu')
        return
      }

      // ── CONFIRMED (order status page) → exit modal ──────────────────────
      // Show the same Leave / Stay modal as the menu floor. [Stay] keeps the
      // customer on the status page; [Leave] calls history.go(-_appHistoryDepth)
      // which exits the app past all owned entries. This prevents accidentally
      // navigating back to the Finix payment page while still giving the user
      // a deliberate way out.
      if (model.appState === 'CONFIRMED') {
        history.pushState({ view: 'menu' }, '')
        _appHistoryDepth++
        _showExitModal({ pendingOrder: false })
        return
      }

      // ── Natural exit point (BROWSING + menu at the floor) → exit modal ───
      if (view === 'menu-floor' && model.appState === 'BROWSING' && currentView === 'menu') {
        history.pushState({ view: 'menu' }, '')
        _appHistoryDepth++
        _showExitModal({ pendingOrder: false })
        return
      }

      // ── PAYING → back to review / CHECKOUT ───────────────────────────────
      // User pressed back mid-payment — return them to the order review page.
      if (model.appState === 'PAYING') {
        history.pushState({ view: 'menu' }, '')
        _appHistoryDepth++
        present({ appState: 'CHECKOUT', paymentDeclined: false, declinedOrderId: null })
        return
      }

      // ── Everything else (CHECKOUT, ITEM, secondary floor hit) ─────────────
      // Push menu back silently so the user can never fall through to the
      // payment provider page via the device back button.
      history.pushState({ view: 'menu' }, '')
      _appHistoryDepth++
    })
  }

  // Stores the element that had focus before a modal opened so focus can be
  // returned when the modal closes.
  let _exitModalTrigger   = null
  let _exitModalTrapClean = null

  /**
   * Show the exit confirmation modal.
   * @param {Object} [opts]
   * @param {boolean} [opts.pendingOrder] - true when customer has an order being processed
   */
  function _showExitModal(opts) {
    const backdrop  = document.getElementById('exit-modal-backdrop')
    const modal     = document.getElementById('exit-modal')
    const title     = document.getElementById('exit-modal-title')
    const subtitle  = document.getElementById('exit-modal-subtitle')
    const leaveBtn  = document.getElementById('exit-modal-leave')

    if (opts && opts.pendingOrder) {
      if (title)    title.textContent    = 'Your order is in progress'
      if (subtitle) { subtitle.textContent = 'Leaving won\'t cancel your order. You\'ll receive a push notification when the restaurant accepts it.'; subtitle.hidden = false }
      if (leaveBtn) leaveBtn.textContent = 'Leave anyway'
    } else {
      if (title)    title.textContent    = 'Leave the app?'
      if (subtitle) subtitle.hidden      = true
      if (leaveBtn) leaveBtn.textContent = 'Leave'
    }

    _exitModalTrigger = document.activeElement
    if (backdrop) { backdrop.hidden = false; backdrop.removeAttribute('aria-hidden') }
    if (modal)    { modal.hidden    = false; modal.removeAttribute('aria-hidden') }
    document.getElementById('exit-modal-stay')?.focus()
    if (modal) _exitModalTrapClean = _trapFocus(modal)
  }

  function _hideExitModal() {
    const backdrop = document.getElementById('exit-modal-backdrop')
    const modal    = document.getElementById('exit-modal')
    if (backdrop) { backdrop.hidden = true; backdrop.setAttribute('aria-hidden', 'true') }
    if (modal)    { modal.hidden    = true; modal.setAttribute('aria-hidden', 'true') }
    if (_exitModalTrapClean) { _exitModalTrapClean(); _exitModalTrapClean = null }
    if (_exitModalTrigger)   { _exitModalTrigger.focus(); _exitModalTrigger = null }
  }

  let historyRenderedLen = -1

  /**
   * Mark an order in localStorage history as cancelled.
   * Forces re-render of the history list on next view.
   */
  function markOrderCancelledInHistory(orderId) {
    try {
      const history = loadOrderHistory()
      const entry = history.find((h) => h.orderId === orderId)
      if (entry) {
        entry.status = 'cancelled'
        localStorage.setItem(ORDER_HISTORY_KEY, JSON.stringify(history))
      }
      const stored = JSON.parse(localStorage.getItem(`kizo_order_${orderId}`) || 'null')
      if (stored) {
        stored.status = 'cancelled'
        localStorage.setItem(`kizo_order_${orderId}`, JSON.stringify(stored))
      }
    } catch { /* ignore */ }
    // Force re-render
    historyRenderedLen = -1
  }

  /**
   * For a scheduled order that is not yet cancelled, check the API for
   * cancellability and render a Cancel button inside cancelSection if eligible.
   */
  async function checkOrderCancellable(orderId, cancelSection) {
    try {
      const res = await fetch(`/api/store/orders/${orderId}/status`)
      if (!res.ok) return
      const data = await res.json()
      if (!data.cancellable) return

      cancelSection.innerHTML = ''

      if (data.cancelDeadline) {
        const deadline = new Date(data.cancelDeadline).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        const note = document.createElement('p')
        note.className = 'cancel-deadline-note'
        note.textContent = `Cancel before ${deadline}`
        cancelSection.appendChild(note)
      }

      const btn = document.createElement('button')
      btn.className = 'btn btn-cancel order-history-cancel-btn'
      btn.textContent = 'Cancel Order'
      cancelSection.appendChild(btn)
      cancelSection.hidden = false

      btn.addEventListener('click', async () => {
        if (!confirm('Cancel this order?')) return
        btn.disabled = true
        btn.textContent = 'Cancelling…'
        try {
          const r = await fetch(`/api/store/orders/${orderId}/cancel`, { method: 'POST' })
          if (!r.ok) {
            const err = await r.json().catch(() => ({}))
            throw new Error(err.error || 'Cancellation failed')
          }
          markOrderCancelledInHistory(orderId)
          const msg = document.createElement('p')
          msg.className = 'order-history-cancelled-msg'
          msg.textContent = 'Order cancelled.'
          cancelSection.replaceWith(msg)
        } catch (err) {
          btn.disabled = false
          btn.textContent = 'Cancel Order'
          const errNote = document.createElement('p')
          errNote.className = 'cancel-deadline-error'
          errNote.textContent = err.message || 'Could not cancel. Please contact the restaurant.'
          cancelSection.appendChild(errNote)
        }
      })
    } catch { /* silent */ }
  }

  function renderOrderHistory(forceRender) {
    const section = document.getElementById('order-history-section')
    const listEl  = document.getElementById('order-history-list')
    const emptyEl = document.getElementById('order-history-empty')
    if (!section || !listEl) return

    // Only render when history view is active (or force)
    if (currentView !== 'history' && !forceRender) return

    const history = loadOrderHistory()

    if (history.length === 0) {
      listEl.innerHTML = ''
      if (emptyEl) emptyEl.hidden = false
      return
    }

    if (emptyEl) emptyEl.hidden = true

    // Re-render only when history changes
    if (history.length === historyRenderedLen && !forceRender) return
    historyRenderedLen = history.length

    listEl.innerHTML = ''

    // Determine if any in-progress order exists (not yet completed or cancelled)
    const activeOrder = getActiveOrder()
    const activeId = (activeOrder &&
      activeOrder.status !== 'completed' &&
      activeOrder.status !== 'cancelled')
      ? activeOrder.orderId : null
    // Always show the in-progress order at the top
    const sorted = activeId
      ? [...history].sort((a, b) => a.orderId === activeId ? -1 : b.orderId === activeId ? 1 : 0)
      : history

    sorted.forEach((order) => {
      const li = document.createElement('li')
      li.className = 'order-history-item'
      li.dataset.orderId = order.orderId

      const date = order.createdAt
        ? new Date(order.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : ''
      const itemNames = (order.items || []).map((i) => {
        const qty = (i.qty && i.qty > 1) ? `${i.qty}x ` : ''
        return qty + i.name
      }).join(', ')
      const favClass = order.favorite ? 'active' : ''
      const isCancelled = order.status === 'cancelled'
      const isActive    = order.orderId === activeId

      // Friendly status label shown in the badge for in-progress orders
      const activeLabel = isActive ? ({
        received: 'Received', submitted: 'Received',
        confirmed: 'Accepted', preparing: 'Preparing',
        ready: 'Ready for Pickup!',
      }[activeOrder.status] ?? 'In Progress') : null
      const isReady = isActive && activeOrder.status === 'ready'

      // ── Summary row ──────────────────────────────────────────────────────
      const summaryRow = document.createElement('div')
      summaryRow.className = 'order-history-summary'
      if (isActive) li.classList.add('order-history-item--active')
      summaryRow.innerHTML = `
        <div class="order-history-info">
          <div class="order-history-header">
            <span class="order-history-date">
              ${escHtml(date)}
              ${isActive ? `<span class="order-history-active-pill${isReady ? ' order-history-active-pill--ready' : ''}">${escHtml(activeLabel)}</span>` : ''}
              ${order.scheduledFor && !isActive ? '<span class="order-history-scheduled-pill">⏰ Scheduled</span>' : ''}
              ${isCancelled ? '<span class="order-history-cancelled-pill">Cancelled</span>' : ''}
            </span>
            <span class="order-history-total">${formatCents(order.totalCents || 0)}</span>
          </div>
          <p class="order-history-items">${escHtml(itemNames)}</p>
        </div>
        <div class="order-history-actions">
          <button class="btn-icon order-fav-btn ${favClass}" aria-label="Favorite">&#9829;</button>
          ${isActive
            ? '<button class="btn btn-primary order-track-btn">Track Order</button>'
            : '<button class="btn btn-secondary order-reorder-btn">Reorder</button>'}
          ${!isActive ? '<span class="order-history-chevron" aria-hidden="true">›</span>' : ''}
        </div>
      `

      // ── Detail panel (hidden until expanded) ─────────────────────────────
      const detailPanel = document.createElement('div')
      detailPanel.className = 'order-history-detail'
      detailPanel.hidden = true

      // Items list
      const itemsEl = document.createElement('div')
      itemsEl.className = 'order-history-detail-items';
      (order.items || []).forEach((item) => {
        const qty = item.qty ?? 1
        const mods = (item.modifiers || []).map((m) => m.name).join(', ')
        const row = document.createElement('div')
        row.className = 'order-history-detail-item'
        row.innerHTML = `
          <div class="order-history-detail-item-info">
            <span class="order-history-detail-item-name">${escHtml(item.name)}</span>
            ${qty > 1 ? `<span class="order-history-detail-item-qty">×${qty}</span>` : ''}
            ${mods ? `<p class="order-history-detail-item-mods">${escHtml(mods)}</p>` : ''}
          </div>
          <span class="order-history-detail-item-price">${formatCents(item.totalCents || 0)}</span>
        `
        itemsEl.appendChild(row)
      })
      detailPanel.appendChild(itemsEl)

      // Totals
      const subtotal  = order.subtotalCents || 0
      const tax       = order.taxCents || 0
      const total     = order.totalCents || 0
      const tipCents  = Math.max(0, total - subtotal - tax)
      const totalsEl  = document.createElement('div')
      totalsEl.className = 'order-history-detail-totals'
      totalsEl.innerHTML = `
        <div class="order-history-detail-line"><span>Subtotal</span><span>${formatCents(subtotal)}</span></div>
        <div class="order-history-detail-line"><span>Tax</span><span>${formatCents(tax)}</span></div>
        ${tipCents > 0 ? `<div class="order-history-detail-line"><span>Tip</span><span>${formatCents(tipCents)}</span></div>` : ''}
        <div class="order-history-detail-line order-history-detail-total"><span>Total</span><span>${formatCents(total)}</span></div>
      `
      detailPanel.appendChild(totalsEl)

      // Scheduled time badge
      if (order.scheduledFor) {
        const scheduledTime = new Date(order.scheduledFor).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        const schedEl = document.createElement('p')
        schedEl.className = 'order-history-detail-scheduled'
        schedEl.textContent = `⏰ Scheduled for pickup at ${scheduledTime}`
        detailPanel.appendChild(schedEl)
      }

      // Cancel section (async — only rendered if order is still cancellable)
      const cancelSection = document.createElement('div')
      cancelSection.className = 'order-history-cancel-section'
      cancelSection.hidden = true
      detailPanel.appendChild(cancelSection)

      // Feedback button — shown for completed past orders (not active, not cancelled)
      if (!isActive && !isCancelled) {
        const fbBtn = document.createElement('button')
        fbBtn.className = 'btn btn-outline btn-full order-history-feedback-btn'
        fbBtn.textContent = 'Leave Feedback'
        fbBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          _openFeedbackOrder(order.orderId, order.items || [])
        })
        detailPanel.appendChild(fbBtn)
      }

      li.appendChild(summaryRow)
      li.appendChild(detailPanel)

      // ── Wire favorite button ──────────────────────────────────────────────
      summaryRow.querySelector('.order-fav-btn').addEventListener('click', (e) => {
        e.stopPropagation()
        const isFav = toggleFavorite(order.orderId)
        summaryRow.querySelector('.order-fav-btn').classList.toggle('active', isFav)
      })

      if (isActive) {
        // ── Active order: tap anywhere or "Track Order" → go to CONFIRMED ──
        const goToConfirmed = () => {
          present({
            appState: 'CONFIRMED',
            currentOrder: {
              orderId:       order.orderId,
              pickupCode:    order.pickupCode,
              items:         order.items,
              subtotalCents: order.subtotalCents,
              taxCents:      order.taxCents,
              totalCents:    order.totalCents,
              scheduledFor:  order.scheduledFor || null,
            },
          })
          // Sync status tracker with last-known status from localStorage
          updateStatusTracker(
            activeOrder.status,
            activeOrder.estimatedReadyAt || null,
            {}
          )
        }
        summaryRow.querySelector('.order-track-btn').addEventListener('click', (e) => {
          e.stopPropagation()
          goToConfirmed()
        })
        summaryRow.addEventListener('click', goToConfirmed)
      } else {
        // ── Wire reorder button ─────────────────────────────────────────────
        summaryRow.querySelector('.order-reorder-btn').addEventListener('click', (e) => {
          e.stopPropagation()
          reorderFromHistory(order.orderId)
        })

        // ── Toggle expand/collapse on summary row click ─────────────────────
        summaryRow.setAttribute('role', 'button')
        summaryRow.setAttribute('tabindex', '0')
        summaryRow.setAttribute('aria-expanded', 'false')
        summaryRow.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); summaryRow.click() }
        })
        summaryRow.addEventListener('click', () => {
          const isExpanded = li.classList.toggle('expanded')
          detailPanel.hidden = !isExpanded
          summaryRow.setAttribute('aria-expanded', String(isExpanded))

          // Lazy-check cancellability the first time this scheduled order is opened
          if (isExpanded && order.scheduledFor && !isCancelled && !cancelSection.dataset.checked) {
            cancelSection.dataset.checked = '1'
            checkOrderCancellable(order.orderId, cancelSection)
          }
        })
      }

      listEl.appendChild(li)
    })
  }

  function reorderFromHistory(orderId) {
    const history = loadOrderHistory()
    const order = history.find((h) => h.orderId === orderId)
    if (!order?.items?.length) return

    // Try to find each item in the current menu and add to cart
    const menu = model.menu || []
    const newCart = []

    for (const histItem of order.items) {
      // Find the menu item by name (IDs may have changed)
      let menuItem = null
      for (const cat of menu) {
        menuItem = cat.items.find((i) => i.name === histItem.name)
        if (menuItem) break
      }
      if (!menuItem) continue

      // Resolve modifiers by name
      const resolvedMods = []
      let modCents = 0
      for (const histMod of (histItem.modifiers || [])) {
        for (const group of (menuItem.modifierGroups || [])) {
          const mod = group.modifiers.find((m) => m.name === histMod.name)
          if (mod) {
            resolvedMods.push({ id: mod.id, name: mod.name, priceCents: mod.price_cents })
            modCents += mod.price_cents
            break
          }
        }
      }

      const unitCents = menuItem.priceCents + modCents
      const qty       = histItem.qty || 1
      const modKey    = resolvedMods.map((m) => m.id).sort().join(',')
      newCart.push({
        item:              menuItem,
        selectedModifiers: resolvedMods,
        modKey,
        qty,
        unitCents,
        totalCents:        unitCents * qty,
      })
    }

    if (newCart.length > 0) {
      switchView('menu') // switch back to menu view
      present({ cart: newCart })
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  function renderError(m) {
    const msgEl  = document.getElementById('state-error-msg')
    const retryEl = document.getElementById('state-error-retry')
    if (msgEl) msgEl.textContent = m.errorMessage || 'Something went wrong.'
    if (retryEl) {
      retryEl.onclick = () => actions.loadStore()
    }
  }

  // ---------------------------------------------------------------------------
  // NAP — Next Action Predicate
  // Fires automatic side-effects after render
  // ---------------------------------------------------------------------------

  function nap(m) {
    if (m.appState === 'LOADING') {
      actions.loadStore()
    } else if ((m.appState === 'BROWSING' || m.appState === 'ITEM') && !m.profile) {
      // When coming from /pay-return, loadStore() was never called because handlePaymentReturn()
      // skips the normal LOADING boot. Redirect through LOADING so the menu loads correctly.
      present({ appState: 'LOADING' })
    }
  }

  // ---------------------------------------------------------------------------
  // Payment return page handler
  //
  // Converge: /pay-return?order=...&ssl_result=APPROVAL&...
  // Finix:    /pay-return?order=...&provider=finix  (success_return_url tagged by server)
  // ---------------------------------------------------------------------------

  /** Key for persisting /pay-return params so a crash during recordPaymentResult can be retried */
  const PAYMENT_RETURN_KEY = 'kizo_payment_return'

  function handlePaymentReturn() {
    const path = window.location.pathname
    if (path !== '/pay-return') return false

    const params = new URLSearchParams(window.location.search)
    const orderId = params.get('order')
    if (!orderId) return false

    const provider = params.get('provider') || 'converge'

    // ── Persist params BEFORE replaceState ──────────────────────────────────
    // If the client crashes or loses network during recordPaymentResult(), the
    // URL will be gone but we can replay from localStorage on next boot.
    // This is critical for Converge where ssl_txn_id is only in the redirect URL.
    const returnPayload = {
      orderId,
      provider,
      ssl_result:        params.get('ssl_result')        || '',
      ssl_txn_id:        params.get('ssl_txn_id')        || '',
      ssl_approval_code: params.get('ssl_approval_code') || '',
      savedAt:           Date.now(),
    }
    try { localStorage.setItem(PAYMENT_RETURN_KEY, JSON.stringify(returnPayload)) } catch { /* ignore */ }

    // Replace URL so Back doesn't re-trigger payment
    window.history.replaceState({}, '', '/')

    if (provider === 'finix') {
      // Finix Checkout Pages — redirect to success_return_url means payment succeeded
      actions.recordPaymentResult({ orderId, provider: 'finix' })
    } else {
      // Converge return — result determined by ssl_result param
      actions.recordPaymentResult({
        orderId,
        provider: 'converge',
        ssl_result:        returnPayload.ssl_result,
        ssl_txn_id:        returnPayload.ssl_txn_id,
        ssl_approval_code: returnPayload.ssl_approval_code,
      })
    }

    return true
  }

  // ---------------------------------------------------------------------------
  // Status tracker updates (called by StorePush when polling)
  // ---------------------------------------------------------------------------

  /**
   * @param {string} status
   * @param {string|null} estimatedReadyAt
   * @param {{ cancellable?: boolean, cancelDeadline?: string|null }} [opts]
   */
  function updateStatusTracker(status, estimatedReadyAt, opts = {}) {
    const ALL_STEPS = ['step-received', 'step-accepted', 'step-ready', 'step-pickedup']

    const stepMap = {
      received:  ['step-received'],
      submitted: ['step-received'],
      confirmed: ['step-received', 'step-accepted'],
      preparing: ['step-received', 'step-accepted'],
      ready:     ['step-received', 'step-accepted', 'step-ready'],
      completed: ['step-received', 'step-accepted', 'step-ready', 'step-pickedup'],
    }

    const activeSteps = stepMap[status] || []
    ALL_STEPS.forEach((id) => {
      const el = document.getElementById(id)
      if (!el) return
      const dot = el.querySelector('.step-dot')
      const isActive = activeSteps.includes(id)
      const isLast   = isActive && activeSteps[activeSteps.length - 1] === id

      el.classList.toggle('active', isLast)
      el.classList.toggle('done',   isActive && !isLast)
      if (dot) {
        dot.classList.toggle('active', isLast)
        dot.classList.toggle('done',   isActive && !isLast)
      }
    })

    // Show estimated ready time when accepted
    const etaEl = document.getElementById('confirmed-eta')
    if (etaEl && estimatedReadyAt) {
      const readyDate = new Date(estimatedReadyAt)
      const timeStr = readyDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      etaEl.textContent = `Estimated ready by ${timeStr}`
      etaEl.hidden = false
    }

    // Show/hide cancel button based on cancellability from server
    const cancelSection  = document.getElementById('confirmed-cancel-section')
    const cancelledMsg   = document.getElementById('confirmed-cancelled-msg')
    const deadlineNote   = document.getElementById('confirmed-cancel-deadline')

    if (status === 'cancelled') {
      setVisible(cancelSection, false)
      // Only reveal the "Order Cancelled" toast when the confirmed panel is actually
      // visible. Polls can fire while in BROWSING/LOADING/PAYING state — setting
      // cancelledMsg visible there would corrupt the DOM and the toast would
      // bleed into the next CONFIRMED render if confirmedRenderedOrderId matches.
      if (model.appState === 'CONFIRMED') setVisible(cancelledMsg, true)
    } else if (cancelSection && cancelledMsg.hidden) {
      // Only update if not already showing the cancelled message (customer cancelled locally)
      setVisible(cancelSection, !!opts.cancellable)

      if (opts.cancellable && opts.cancelDeadline && deadlineNote) {
        const deadline = new Date(opts.cancelDeadline)
        const timeStr  = deadline.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        deadlineNote.textContent = `Free cancellation until ${timeStr}`
        deadlineNote.classList.remove('cancel-deadline-error')
      } else if (!opts.cancellable && deadlineNote && !cancelSection.hidden) {
        deadlineNote.textContent = 'Cancellation is no longer available — kitchen is preparing your order.'
      }
    }

    // Update the persistent active-order bar
    const active = getActiveOrder()
    if (active) {
      if (status === 'completed' || status === 'cancelled' || status === 'picked_up') {
        clearActiveOrder()
      } else {
        saveActiveOrder(active.orderId, active.pickupCode, status, estimatedReadyAt || active.estimatedReadyAt)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — modules call back into SAM via window.Store
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Feedback modals — "Rate this app" and per-order dish feedback
  // ---------------------------------------------------------------------------

  /** Feedback state (reset each time a modal opens) */
  var _fbAppStars    = 0
  var _fbOrderStars  = 0
  var _fbOrderId     = null
  var _fbOrderItems  = []
  var _fbSubmitting  = false

  /**
   * Highlight stars 1..n inside a `.feedback-stars` container.
   * @param {HTMLElement} container
   * @param {number} n
   */
  function _setStars(container, n) {
    if (!container) return
    container.querySelectorAll('.feedback-star').forEach((btn) => {
      const star = parseInt(btn.dataset.star, 10)
      btn.classList.toggle('active', star <= n)
      btn.setAttribute('aria-pressed', String(star <= n))
    })
  }

  /**
   * Wire star buttons inside a modal overlay.
   * Returns a getter for the current rating.
   * @param {HTMLElement} overlay
   * @param {function(number):void} onRate
   */
  function _wireStars(overlay, onRate) {
    const container = overlay.querySelector('.feedback-stars')
    if (!container) return
    container.querySelectorAll('.feedback-star').forEach((btn) => {
      btn.setAttribute('aria-pressed', 'false')
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset.star, 10)
        onRate(n)
        _setStars(container, n)
      })
      // Hover preview
      btn.addEventListener('mouseenter', () => {
        const n = parseInt(btn.dataset.star, 10)
        container.querySelectorAll('.feedback-star').forEach((b) => {
          b.classList.toggle('hover', parseInt(b.dataset.star, 10) <= n)
        })
      })
      btn.addEventListener('mouseleave', () => {
        container.querySelectorAll('.feedback-star').forEach((b) => b.classList.remove('hover'))
      })
    })
  }

  /** Reset and open the "Rate this app" feedback modal. */
  function _openFeedbackApp() {
    _fbAppStars = 0
    const overlay = document.getElementById('feedback-app-overlay')
    if (!overlay) return
    const starsContainer = overlay.querySelector('.feedback-stars')
    _setStars(starsContainer, 0)
    const comment = document.getElementById('feedback-app-comment')
    const contact = document.getElementById('feedback-app-contact')
    const submit  = document.getElementById('feedback-app-submit')
    if (comment) comment.value = ''
    if (contact) contact.value = ''
    if (submit) { submit.disabled = true; submit.textContent = 'Submit Feedback' }
    overlay.hidden = false
    overlay.removeAttribute('style')
    overlay.querySelector('.feedback-star[data-star="1"]')?.focus()
  }

  /** Close the "Rate this app" modal. */
  function _closeFeedbackApp() {
    const overlay = document.getElementById('feedback-app-overlay')
    if (overlay) overlay.hidden = true
  }

  /**
   * Reset and open the per-order feedback modal.
   * @param {string} orderId
   * @param {Array<{name:string}>} items
   */
  function _openFeedbackOrder(orderId, items) {
    _fbOrderStars  = 0
    _fbOrderId     = orderId
    _fbOrderItems  = (items || []).slice()
    const overlay = document.getElementById('feedback-order-overlay')
    if (!overlay) return
    const starsContainer = overlay.querySelector('.feedback-stars')
    _setStars(starsContainer, 0)
    const comment = document.getElementById('feedback-order-comment')
    const contact = document.getElementById('feedback-order-contact')
    const submit  = document.getElementById('feedback-order-submit')
    if (comment) comment.value = ''
    if (contact) contact.value = ''
    if (submit) { submit.disabled = true; submit.textContent = 'Submit Feedback' }

    // Build dish list
    const dishList = document.getElementById('feedback-dish-list')
    if (dishList) {
      dishList.innerHTML = ''
      const seen = new Set()
      _fbOrderItems.forEach((item) => {
        const name = item.name
        if (!name || seen.has(name)) return
        seen.add(name)
        const li = document.createElement('li')
        li.className = 'feedback-dish-row'
        li.dataset.dish = name
        li.innerHTML = `
          <span class="feedback-dish-name">${escHtml(name)}</span>
          <div class="feedback-dish-thumbs">
            <button class="feedback-thumb feedback-thumb-up" aria-label="Thumbs up for ${escHtml(name)}" aria-pressed="false">👍</button>
            <button class="feedback-thumb feedback-thumb-down" aria-label="Thumbs down for ${escHtml(name)}" aria-pressed="false">👎</button>
          </div>
        `
        const upBtn   = li.querySelector('.feedback-thumb-up')
        const downBtn = li.querySelector('.feedback-thumb-down')
        upBtn.addEventListener('click', () => {
          const wasActive = upBtn.classList.contains('active-up')
          upBtn.classList.toggle('active-up', !wasActive)
          upBtn.setAttribute('aria-pressed', String(!wasActive))
          downBtn.classList.remove('active-down')
          downBtn.setAttribute('aria-pressed', 'false')
        })
        downBtn.addEventListener('click', () => {
          const wasActive = downBtn.classList.contains('active-down')
          downBtn.classList.toggle('active-down', !wasActive)
          downBtn.setAttribute('aria-pressed', String(!wasActive))
          upBtn.classList.remove('active-up')
          upBtn.setAttribute('aria-pressed', 'false')
        })
        dishList.appendChild(li)
      })
    }

    overlay.hidden = false
    overlay.removeAttribute('style')
    overlay.querySelector('.feedback-star[data-star="1"]')?.focus()
  }

  /** Close the per-order feedback modal. */
  function _closeFeedbackOrder() {
    const overlay = document.getElementById('feedback-order-overlay')
    if (overlay) overlay.hidden = true
  }

  /**
   * POST feedback to `/api/store/feedback`.
   * @param {object} payload
   * @returns {Promise<boolean>} true on success
   */
  async function _submitFeedback(payload) {
    try {
      const res = await fetch('/api/store/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        console.error('[feedback] submit failed', res.status, body)
      }
      return res.ok
    } catch (err) {
      console.error('[feedback] submit error', err)
      return false
    }
  }

  /**
   * Initialise feedback modals — wire stars, close buttons, submit buttons.
   * Called once from boot().
   */
  function _initFeedbackModals() {
    // ── "Give Feedback" button on confirmed page ──────────────────────────
    const feedbackBtn = document.getElementById('confirmed-feedback-btn')
    if (feedbackBtn) {
      feedbackBtn.addEventListener('click', () => _openFeedbackApp())
    }

    // ── App feedback modal ────────────────────────────────────────────────
    const appOverlay = document.getElementById('feedback-app-overlay')
    if (appOverlay) {
      _wireStars(appOverlay, (n) => {
        _fbAppStars = n
        const submit = document.getElementById('feedback-app-submit')
        if (submit) submit.disabled = n === 0
      })

      appOverlay.querySelector('.feedback-close')?.addEventListener('click', _closeFeedbackApp)
      appOverlay.addEventListener('click', (e) => {
        if (e.target === appOverlay) _closeFeedbackApp()
      })

      document.getElementById('feedback-app-submit')?.addEventListener('click', async () => {
        if (_fbSubmitting || _fbAppStars === 0) return
        _fbSubmitting = true
        const btn = document.getElementById('feedback-app-submit')
        if (btn) { btn.disabled = true; btn.textContent = 'Submitting…' }

        const ok = await _submitFeedback({
          type:    'app',
          stars:   _fbAppStars,
          comment: document.getElementById('feedback-app-comment')?.value.trim() || null,
          contact: document.getElementById('feedback-app-contact')?.value.trim() || null,
        })

        _fbSubmitting = false
        if (ok) {
          if (btn) { btn.textContent = 'Thank you!'; btn.disabled = true }
          setTimeout(_closeFeedbackApp, 800)
        } else {
          if (btn) { btn.disabled = false; btn.textContent = 'Submit Feedback' }
          showToast('Could not submit feedback — please try again.')
        }
      })
    }

    // ── Order feedback modal ──────────────────────────────────────────────
    const orderOverlay = document.getElementById('feedback-order-overlay')
    if (orderOverlay) {
      _wireStars(orderOverlay, (n) => {
        _fbOrderStars = n
        const submit = document.getElementById('feedback-order-submit')
        if (submit) submit.disabled = n === 0
      })

      orderOverlay.querySelector('.feedback-close')?.addEventListener('click', _closeFeedbackOrder)
      orderOverlay.addEventListener('click', (e) => {
        if (e.target === orderOverlay) _closeFeedbackOrder()
      })

      document.getElementById('feedback-order-submit')?.addEventListener('click', async () => {
        if (_fbSubmitting || _fbOrderStars === 0) return
        _fbSubmitting = true
        const btn = document.getElementById('feedback-order-submit')
        if (btn) { btn.disabled = true; btn.textContent = 'Submitting…' }

        // Collect dish ratings
        const dishList = document.getElementById('feedback-dish-list')
        const dishRatings = []
        if (dishList) {
          dishList.querySelectorAll('.feedback-dish-row').forEach((row) => {
            const name = row.dataset.dish
            if (!name) return
            const up   = row.querySelector('.feedback-thumb-up')?.classList.contains('active-up')
            const down = row.querySelector('.feedback-thumb-down')?.classList.contains('active-down')
            if (up || down) {
              dishRatings.push({ name, thumbs: up ? 'up' : 'down' })
            }
          })
        }

        const ok = await _submitFeedback({
          type:        'order',
          orderId:     _fbOrderId,
          stars:       _fbOrderStars,
          comment:     document.getElementById('feedback-order-comment')?.value.trim() || null,
          managerNote: document.getElementById('feedback-order-manager-note')?.value.trim() || null,
          contact:     document.getElementById('feedback-order-contact')?.value.trim() || null,
          dishRatings: dishRatings.length ? dishRatings : null,
        })

        _fbSubmitting = false
        if (ok) {
          if (btn) { btn.textContent = 'Thank you!'; btn.disabled = true }
          setTimeout(() => {
            _closeFeedbackOrder()
            // Nudge iOS dine-in customers (who arrived via QR, no active order)
            // to add the app to their home screen after they've engaged.
            setTimeout(() => window.StorePush?.showIOSBanner?.(), 300)
          }, 800)
        } else {
          if (btn) { btn.disabled = false; btn.textContent = 'Submit Feedback' }
          showToast('Could not submit feedback — please try again.')
        }
      })
    }
  }

  window.Store = {
    actions,
    getModel: () => model,
    updateStatusTracker,
    saveActiveOrder,
    getActiveOrder,
    clearActiveOrder,
    renderActiveOrderBar,
    fmtSchedule: _fmtSchedule,
    isCampaignScheduleActive: (campaign, refDate) => _isCampaignScheduleActive(campaign, model.profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, refDate),
  }

  // ---------------------------------------------------------------------------
  // Bootstrap — after all scripts loaded
  // ---------------------------------------------------------------------------

  function boot() {
    // Wire confirmation "Place Another Order"
    const newOrderBtn = document.getElementById('confirmed-new-order-btn')
    if (newOrderBtn) {
      newOrderBtn.addEventListener('click', () => {
        confirmedRenderedOrderId = null  // allow re-render for next order
        present({ appState: 'BROWSING', currentOrder: null, errorMessage: '' })
      })
    }

    // Wire "Cancel Order" button
    const cancelBtn = document.getElementById('confirmed-cancel-btn')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (!confirm('Are you sure you want to cancel this order?')) return
        actions.cancelOrder()
      })
    }

    // Wire view toggle (Menu / My Orders)
    // History API: "My Orders" pushes a state so the device back button pops
    // back to menu instead of navigating to the previous browser page (e.g. Finix).
    const menuBtn = document.getElementById('nav-menu-btn')
    const histBtn = document.getElementById('nav-history-btn')
    if (menuBtn) {
      menuBtn.addEventListener('click', () => {
        if (currentView !== 'menu') {
          switchView('menu')
          history.back() // pop the 'history' entry; popstate fires but currentView is already 'menu'
        }
      })
    }
    if (histBtn) {
      histBtn.addEventListener('click', () => {
        if (currentView !== 'history') {
          history.pushState({ view: 'history' }, '')
          switchView('history')
        }
      })
    }

    // Exit modal buttons
    document.getElementById('exit-modal-stay')?.addEventListener('click', _hideExitModal)
    document.getElementById('exit-modal-backdrop')?.addEventListener('click', _hideExitModal)
    document.getElementById('exit-modal-leave')?.addEventListener('click', () => {
      _hideExitModal()
      _exitingApp = true
      history.go(-_appHistoryDepth)
    })

    // Set up History API back-button interception (floor + menu entries)
    _initBackNavigation()

    // Wire feedback modals
    _initFeedbackModals()

    // Active-order bar: render immediately + make tappable
    renderActiveOrderBar()
    const barEl = document.getElementById('active-order-bar')
    if (barEl) {
      barEl.addEventListener('click', (e) => {
        const active = getActiveOrder()
        if (!active) return

        // Don't navigate while payment is being processed — recordPaymentResult
        // will call present({ appState: 'CONFIRMED' }) once it resolves. A
        // premature bar-tap would set confirmedRenderedOrderId early, causing the
        // reset block to be skipped when recordPaymentResult's present() fires.
        if (model.appState === 'PAYING') return

        // Payment not yet confirmed — re-initiate payment flow
        if (active.status === 'pending_payment') {
          actions.resumePayment(active.orderId)
          return
        }

        if (model.appState === 'CONFIRMED') {
          window.scrollTo({ top: 0, behavior: 'smooth' })
          return
        }

        // Navigate back to the confirmed/tracking screen from any other state.
        // Reconstruct currentOrder from localStorage (survives page refresh).
        let storedOrder = null
        try {
          storedOrder = JSON.parse(localStorage.getItem(`kizo_order_${active.orderId}`) || 'null')
        } catch { /* ignore */ }

        present({
          appState: 'CONFIRMED',
          currentOrder: {
            orderId:       active.orderId,
            pickupCode:    active.pickupCode,
            subtotalCents: storedOrder?.subtotalCents ?? 0,
            taxCents:      storedOrder?.taxCents ?? 0,
            totalCents:    storedOrder?.totalCents ?? 0,
            items:         storedOrder?.items || [],
            scheduledFor:  storedOrder?.scheduledFor || null,
          },
        })
        window.scrollTo({ top: 0, behavior: 'smooth' })
      })
    }

    // Resume polling for active order (deferred so store-push.js is loaded).
    // Skip on /pay-return: recordPaymentResult will start the correct polling after
    // payment verification completes. Resuming here would race against that and
    // could poll a stale/cancelled previous order while the new order is confirming.
    const active = getActiveOrder()
    const isPaymentReturn = window.location.pathname === '/pay-return'
    if (!isPaymentReturn && active && active.status !== 'completed' && active.status !== 'cancelled'
        && active.status !== 'pending_payment') {
      setTimeout(() => {
        window.StorePush?.resumePolling(active.orderId)
      }, 0)
    }

    // Restore cart from localStorage (survives page refresh).
    // Skip if there's already an active order in flight — the Pay Now button handles resumption.
    const activeOnBoot = getActiveOrder()
    const hasActiveOrder = activeOnBoot && activeOnBoot.status !== 'completed' && activeOnBoot.status !== 'cancelled'
    if (!hasActiveOrder) {
      const savedCartData = loadCart()
      if (savedCartData.cart.length > 0) {
        model.cart         = savedCartData.cart
        model.tipCents     = savedCartData.tipCents
        model.scheduledFor = savedCartData.scheduledFor || null
      }
    }

    // ── Detect abandoned payment (customer backed out of Finix) ─────────────
    // When submitOrder() redirects to Finix and the customer presses browser-back,
    // the page reloads with a 'pending_payment' active order but no /pay-return.
    // We cancel the abandoned order, restore the cart, and go straight to CHECKOUT
    // so the customer can review and modify before paying again.
    const pendingCartSnapshot = (() => {
      try { return localStorage.getItem(PENDING_CART_KEY) } catch { return null }
    })()
    if (!isPaymentReturn && activeOnBoot?.status === 'pending_payment' && pendingCartSnapshot) {
      try {
        const savedCart = JSON.parse(pendingCartSnapshot)
        if (savedCart?.cart?.length > 0) {
          model.cart     = savedCart.cart
          model.tipCents = savedCart.tipCents || 0
        }
      } catch { /* ignore — proceed with empty cart */ }
      try { localStorage.removeItem(PENDING_CART_KEY) } catch { /* ignore */ }
      // Fire-and-forget cancel of the abandoned order
      const abandonedId = activeOnBoot.orderId
      clearActiveOrder()
      fetch(`/api/store/orders/${abandonedId}/cancel`, { method: 'POST' }).catch(() => {})
      _resumeCheckoutOnLoad = true
    }

    // ── Detect bill QR feedback link (?fb=TOKEN) ──────────────────────────────
    // When a customer scans the QR code printed on their bill, the URL is
    // /?fb=TOKEN.  Capture the token, clean the URL, then fall through to the
    // normal load so the store initialises before the feedback modal opens.
    const fbParam = new URLSearchParams(window.location.search).get('fb')
    if (fbParam) {
      _pendingFeedbackToken = fbParam
      history.replaceState(null, '', window.location.pathname)
    }

    // Check if returning from Converge/Finix payment redirect
    if (!handlePaymentReturn()) {
      // Not on /pay-return. Check whether the client crashed mid-processing
      // on a previous /pay-return visit (params were saved before replaceState).
      // Window: up to 30 minutes. Stale or replayed data is discarded.
      const pendingReturn = (() => {
        try { return JSON.parse(localStorage.getItem(PAYMENT_RETURN_KEY) || 'null') } catch { return null }
      })()
      const pendingAge = pendingReturn ? (Date.now() - (pendingReturn.savedAt || 0)) : Infinity

      if (pendingReturn?.orderId && pendingAge < 30 * 60 * 1000) {
        // Replay the payment return — this also handles Finix idempotency and
        // 409 recovery. Start the machine first so the render pipeline is ready.
        present({ appState: 'LOADING' })
        // Slight defer so loadStore/profile can initialise before we switch to PAYING
        setTimeout(() => {
          const active = getActiveOrder()
          if (active?.orderId === pendingReturn.orderId && active?.status === 'pending_payment') {
            console.log('[boot] Replaying payment return for order', pendingReturn.orderId)
            actions.recordPaymentResult(pendingReturn)
          } else {
            // Order already confirmed or abandoned — discard stale return params
            try { localStorage.removeItem(PAYMENT_RETURN_KEY) } catch { /* ignore */ }
          }
        }, 0)
      } else {
        // Normal load — start the SAM machine
        if (pendingReturn) {
          try { localStorage.removeItem(PAYMENT_RETURN_KEY) } catch { /* ignore */ }
        }
        present({ appState: 'LOADING' })
      }
    }
  }

  // Listen for SW messages (e.g. notification click → focus + update)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data
      if (!msg) return
      if (msg.type === 'order-ready' && msg.orderId) {
        // SW notification clicked — update status
        window.Store?.updateStatusTracker('ready')
      }
    })
  }

  // ── Suppress pull-to-refresh (Safari/iOS) ──────────────────────────────
  // Chrome/Android is handled by `overscroll-behavior: none` in store.css.
  // Safari ignores that property, so we block the pull-down touchmove only
  // when the user is at the very top of a scrollable container.
  ;(function suppressPullToRefresh() {
    let startY = 0
    document.addEventListener('touchstart', (e) => {
      startY = e.touches[0].pageY
    }, { passive: true })
    document.addEventListener('touchmove', (e) => {
      if (!e.cancelable) return  // browser already committed to native scroll
      const el = e.target.closest('[data-scrollable]') || document.scrollingElement
      const isAtTop       = !el || el.scrollTop <= 0
      const isPullingDown = e.touches[0].pageY > startY
      if (isAtTop && isPullingDown) e.preventDefault()
    }, { passive: false })
  })()

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    // Scripts deferred — DOM already ready
    setTimeout(boot, 0)
  }

})()
