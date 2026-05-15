/**
 * payment-modal.js — Review & Pay full-screen overlay
 *
 * Exposes: window.PaymentModal.open(order, profile)
 *
 * Screens (state machine):
 *   BILL_REVIEW → SPLIT_SELECT → SPLIT_ITEMS_SELECT (by_items only)
 *            ↘ CASH_CONFIRM ↗
 *            ↘ CARD_CONFIRM ↗
 *            → RECEIPT_OPTIONS → LEG_COMPLETE | PIN_EXIT
 *            (cash skips SIGNATURE; card goes CARD_CONFIRM → SIGNATURE → RECEIPT_OPTIONS)
 *
 * Phase 3: Split payments (equal / by_items / custom)
 * Phase 4: Amex surcharge (0.3% of pre-tip base)
 *
 * Depends on: window.api, window.merchantId, window.formatPrice (set by dashboard.js)
 *
 * Implementation note — hand-rolled state machine (no sam-pattern npm library):
 *   State is held in private `let _field` closure variables; render() dispatches
 *   to screen-specific render functions based on _screen.  The sam-pattern
 *   library's reserved field collision (error, hasError, errorMessage, clearError,
 *   state, update, flush, clone, continue, hasNext, allow, log) does NOT apply.
 *   If sam-pattern is ever imported here, all _field names must be audited first.
 */
;(function () {
  'use strict'

  console.log('[PaymentModal] v20 loaded')

  // ── Constants ─────────────────────────────────────────────────────────────

  /** Fallback service charge rate (20%) when no preset is configured. */
  const SERVICE_CHARGE_RATE_DEFAULT = 0.20

  /**
   * Returns the service charge rate for Clover split legs.
   * Uses the first percent-type preset from the merchant profile; falls back to 20%.
   * @returns {number} rate as a decimal (e.g. 0.18 for 18%)
   */
  function _cloverServiceChargeRate() {
    const presets = _profile?.serviceChargePresets ?? []
    const first = presets.find(p => p.type === 'percent')
    return first ? first.value / 100 : SERVICE_CHARGE_RATE_DEFAULT
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** @param {string} str */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  /** @param {number} cents */
  function fmt(cents) {
    return window.formatPrice ? window.formatPrice(cents) : '$' + (cents / 100).toFixed(2)
  }

  /**
   * Returns 3–4 bill-denomination options that are >= the total.
   * Each option is the smallest multiple of a standard denomination (10, 20, 50, 100, 200, 500)
   * that covers the total.  Duplicates are removed.
   * e.g. $114.23 → [120, 150, 200]   $23 → [30, 40, 50, 100]
   * @param {number} totalCents
   * @returns {number[]} dollar amounts
   */
  function cashDenomOptions(totalCents) {
    const total = totalCents / 100
    const denoms = [10, 20, 50, 100]
    const seen = new Set()
    const opts = []
    for (const d of denoms) {
      const candidate = Math.ceil(total / d) * d
      if (!seen.has(candidate)) {
        seen.add(candidate)
        opts.push(candidate)
        if (opts.length >= 4) break
      }
    }
    return opts
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /** @type {'BILL_REVIEW'|'GIFT_CARD_LOOKUP'|'SPLIT_SELECT'|'SPLIT_ITEMS_SELECT'|'CASH_CONFIRM'|'CARD_CONFIRM'|'COUNTER_WAITING'|'PHONE_TOKENIZE'|'SIGNATURE'|'RECEIPT_OPTIONS'|'LEG_COMPLETE'|'EXIT_CONFIRM_SPLIT'|'PIN_EXIT'} */
  let _screen = 'BILL_REVIEW'

  // Phase 4: previous screen the staff was on before tapping close mid-split.
  // Used by EXIT_CONFIRM_SPLIT's Cancel button so they return to where they were.
  let _prevScreen = null

  /** Order passed to open() */
  let _order = null
  /** Merchant profile passed to open() */
  let _profile = null

  // Per-leg payment state (reset by _resetLegState between legs)
  let _paymentType = null        // 'cash' | 'card'
  let _tipCents = 0
  let _gratuityPercent = null    // number | 'custom' | null
  let _cashTendered = 0
  let _cardType = null
  let _cardLastFour = null
  let _cardholderName = null
  let _transactionId = null
  let _authCode = null
  let _signatureDataUrl = null
  let _paymentId = null
  let _lastLegFromServer = true  // set by ensurePaymentRecorded(); true = last/only leg
  let _amexSurchargeCents = 0   // Phase 4: computed 0.3% when cardType === 'amex'

  // Phase 3: Split state (preserved across legs)
  let _splitMode = null          // null | 'equal' | 'by_items' | 'custom'
  let _splitTotalLegs = 1
  let _splitCurrentLeg = 1
  let _splitLegBases = []        // pre-tip base (sub+tax) of each completed leg
  let _currentLegItems = []      // item indices assigned to current leg (by_items)
  let _assignedItemIndices = new Set() // indices already used by completed legs
  let _customLegBase = null      // cents: staff-entered amount for custom leg 1

  // Phase 3: true when the modal hydrated from an existing server-side
  // split session (in_progress or paused). Used to show a "Resuming" banner
  // on the LEG_COMPLETE landing screen. Cleared after the staff acknowledges.
  let _isResuming = false
  let _resumedFromStatus = null  // 'in_progress' | 'paused' — for banner copy

  // Computed per-leg base; set by _computeLegBase() at start of each leg
  let _legSubtotalCents = null
  let _legTaxCents = 0

  // Terminal sale state — async-polling model (Phase 3 / 2026-04-17):
  //   POST /terminal-sale returns { ttxId } immediately; the Finix POST /transfers
  //   call happens in the server-side SAM workflow. Client polls /by-ttx/:ttxId
  //   for state; the real transferId appears in the poll response once Finix
  //   responds, and we capture it into _transactionId for record-payment.
  let _terminalTxId = null         // workflow's terminal_transactions row ID (ttx_*)
  let _terminalTransferId = null   // Finix transferId — populated from poll response on SUCCEEDED
  let _terminalDeviceId = null
  let _terminalPollTimer = null
  let _terminalPollCount = 0
  let _terminalError = null
  let _terminalInitiating = false  // guard against re-entry during async POST
  let _terminalAutoRetries = 0     // auto-retry count for recoverable failures
  let _terminalAlreadySucceeded = false  // (legacy field — kept false in async-polling flow; workflow handles silent-success via 422 recovery)
  let _terminalTipOnDevice = false  // true when merchant enabled tip-on-terminal and server confirmed it
  let _selectedTerminal = null     // { id, nickname, model, finixDeviceId }
  let _availableTerminals = []     // fetched on modal open
  let _terminalStartedAt = 0       // Date.now() when the current Finix sale was created — drives "Take cash instead" button delay
  let _switchingToCash = false     // true after staff clicked "Take cash instead"; poll outcome handlers use this
  // Retry classification is a server decision (see TerminalOutcome.retryable);
  // the client no longer branches on Finix decline codes.

  // Counter (Android tablet + D135) payment state
  let _counterInitiating = false  // guard against re-entry during POST
  let _counterStatus = null       // null | 'waiting' | 'approved' | 'declined' | 'error' | 'cancelled'
  let _counterError = null
  let _counterPollTimer = null

  // Clover payment state
  let _cloverEnabled  = false  // true when Clover is the merchant's card processor
  let _cloverLegMode  = false  // true for a split leg (synthetic order, service charge replaces tip)
  let _cloverFullMode = false  // true for non-split full-order push (actual items, customer tips on device)

  // Signature canvas drawing state
  let _drawing = false
  let _lastX = 0
  let _lastY = 0

  // PIN-exit state
  let _pinBuffer = ''
  let _pinAttempts = 0
  let _pinLockoutUntil = 0
  let _pinLockoutTimer = null

  // Finix config (applicationId + merchantId + sandbox) — passed via open() opts.
  // Used by PHONE_TOKENIZE to initialise the Finix.js hosted-fields form.
  let _finixConfig = null  // { applicationId, merchantId, sandbox }

  // Phone-payment (tokenization) state
  let _phoneForm     = null   // Finix form object while PHONE_TOKENIZE is active
  let _phoneCharging = false  // true while awaiting token + charge network call
  let _phoneError    = null   // last error message string, shown inline

  // Open-mode: set when open() is called
  // 'card'    → BILL_REVIEW with card terminal action
  // 'cash'    → BILL_REVIEW with cash action pre-selected
  // 'counter' → BILL_REVIEW with counter-device action pre-selected
  // 'phone'   → PHONE_TOKENIZE directly (tip pre-set via opts.tipCents)
  let _openMode = 'card'

  // PIN action context: what happens when PIN is accepted
  // 'done'         → post-payment complete (cleanup + hide + reload orders)
  // 'close_modal'  → staff-initiated close without payment (cleanup + hide)
  // 'pause_split'  → mid-split pause via PATCH /split-session/pause (Phase 4)
  let _pinAction = 'done'

  // Gift card state (preserved across legs; cleared in _cleanup)
  // null = no gift card attached; object = confirmed card
  let _giftCard = null             // { id, maskedCode, faceValueCents, balanceCents, customerName, taxEmbeddedCents }
  let _giftCardTaxOffsetCents = 0  // embedded tax offset applied to this order's tax

  // Item-edit state (EDIT_ITEM screen)
  let _editingItemIdx = null      // index into _order.items
  let _editModalSelections = {}   // { groupId: { modifierId, name, priceCents } }

  // ── DOM refs ──────────────────────────────────────────────────────────────

  let _overlay = null
  let _sigCanvas = null
  let _sigCtx = null

  // ── Core render ──────────────────────────────────────────────────────────

  function show() { _overlay.removeAttribute('hidden'); document.body.style.overflow = 'hidden' }
  function hide() { _overlay.setAttribute('hidden', ''); document.body.style.overflow = '' }

  function render() {
    const header = _overlay.querySelector('.pm-header')
    const screen = _overlay.querySelector('.pm-screen')

    const orderLabel = _order?.tableLabel
      ? `Table ${esc(_order.tableLabel)}`
      : (_order?.orderType === 'dine_in' ? 'Dine In' : (_order?.orderType === 'delivery' ? 'Delivery' : 'Pickup'))
    header.querySelector('.pm-order-meta').textContent =
      `${esc(_order?.id?.slice(-6) ?? '')} · ${orderLabel}`

    switch (_screen) {
      case 'BILL_REVIEW':        return renderBillReview(screen)
      case 'GIFT_CARD_LOOKUP':   return renderGiftCardLookup(screen)
      case 'EDIT_ITEM':          return renderEditItem(screen)
      case 'SPLIT_SELECT':       return renderSplitSelect(screen)
      case 'SPLIT_ITEMS_SELECT': return renderSplitItemsSelect(screen)
      case 'CASH_CONFIRM':       return renderCashConfirm(screen)
      case 'CARD_CONFIRM':       return renderCardConfirm(screen)
      case 'COUNTER_WAITING':    return renderCounterWaiting(screen)
      case 'PHONE_TOKENIZE':     return renderPhoneTokenize(screen)
      case 'SIGNATURE':          return renderSignature(screen)
      case 'RECEIPT_OPTIONS':    return renderReceiptOptions(screen)
      case 'LEG_COMPLETE':       return renderLegComplete(screen)
      case 'EXIT_CONFIRM_SPLIT': return renderExitConfirmSplit(screen)
      case 'PIN_EXIT':           return renderPinExit(screen)
    }
  }

  // ── Computed totals ───────────────────────────────────────────────────────

  /** Returns totals for the current leg (split-aware, gift-card-tax-offset-aware). */
  function computeTotals() {
    if (_splitMode && _legSubtotalCents !== null) {
      // For the gift_card split leg, tax offset is already baked into _legTaxCents
      const total = _legSubtotalCents + _legTaxCents + _tipCents + _amexSurchargeCents
      return { subtotal: _legSubtotalCents, discount: 0, serviceCharge: 0, taxCents: _legTaxCents, taxed: _legSubtotalCents, total }
    }
    const subtotal       = _order.subtotalCents ?? _order.totalCents ?? 0
    const discount       = _order.discountCents ?? 0
    const serviceCharge  = _order.serviceChargeCents ?? 0
    const taxRate        = _profile?.taxRate ?? 0
    const taxed          = subtotal - discount
    const rawTaxCents    = Math.round((taxed + serviceCharge) * taxRate)
    // Apply gift card embedded tax offset (reduces tax owed on this order)
    const taxCents       = Math.max(0, rawTaxCents - _giftCardTaxOffsetCents)
    const total          = taxed + serviceCharge + taxCents + _tipCents + _amexSurchargeCents
    return { subtotal, discount, serviceCharge, taxCents, rawTaxCents, taxed, total }
  }

  // ── Split helpers ─────────────────────────────────────────────────────────

  /** Full order pre-tip base (subtotal - discount + serviceCharge + adjusted tax). */
  function _fullBase() {
    const subtotal      = _order.subtotalCents ?? _order.totalCents ?? 0
    const discount      = _order.discountCents ?? 0
    const serviceCharge = _order.serviceChargeCents ?? 0
    const taxRate       = _profile?.taxRate ?? 0
    const taxed         = subtotal - discount
    const rawTax        = Math.round((taxed + serviceCharge) * taxRate)
    const adjustedTax   = Math.max(0, rawTax - _giftCardTaxOffsetCents)
    return taxed + serviceCharge + adjustedTax
  }

  /** Set _legSubtotalCents / _legTaxCents for the current leg based on _splitMode. */
  function _computeLegBase() {
    const taxRate = _profile?.taxRate ?? 0
    const fb      = _fullBase()
    const paid    = _splitLegBases.reduce((a, b) => a + b, 0)

    if (_splitMode === 'equal') {
      const isLast = _splitCurrentLeg >= _splitTotalLegs
      _legSubtotalCents = isLast ? Math.max(0, fb - paid) : Math.ceil(fb / _splitTotalLegs)
      _legTaxCents = 0 // tax is embedded in the split amount
    } else if (_splitMode === 'by_items') {
      const allUnits = _enumerateUnits(_order?.items)
      const legUnits = _currentLegItems.map(i => allUnits[i]).filter(Boolean)
      const sub      = legUnits.reduce((s, u) => s + u.unitPrice, 0)
      _legSubtotalCents = sub
      _legTaxCents      = Math.round(sub * taxRate)
    } else if (_splitMode === 'custom') {
      const isLast      = _splitCurrentLeg >= _splitTotalLegs
      _legSubtotalCents = isLast ? Math.max(0, fb - paid) : (_customLegBase ?? 0)
      _legTaxCents      = 0
    }
  }

  /**
   * Flattens an order's items into one entry per unit, so that `2× Peanut
   * Sauce` becomes two separately selectable units in the by_items split UI.
   *
   * Returns an array indexed by the same unit-index used by the server's
   * splitItemsJson validation. Per-unit price is `lineTotal / quantity`,
   * rounded down with the remainder absorbed by the last unit so that
   * `sum(units of a line) === line.lineTotalCents` exactly.
   */
  function _enumerateUnits(items) {
    const units = []
    ;(items || []).forEach((item, lineIdx) => {
      const qty = Math.max(1, item.quantity || 1)
      const lineTotal = item.lineTotalCents ?? ((item.priceCents ?? 0) * qty)
      const baseUnit  = Math.floor(lineTotal / qty)
      const remainder = lineTotal - baseUnit * qty
      for (let u = 0; u < qty; u++) {
        units.push({
          unitIdx:     units.length,   // global index = position in flattened list
          lineIdx,
          unitInLine:  u,              // 0..qty-1 within the line
          unitOfTotal: qty,
          item,
          unitPrice:   (u === qty - 1) ? baseUnit + remainder : baseUnit,
        })
      }
    })
    return units
  }

  /** Total selectable units in the order (for completion checks). */
  function _totalUnits() {
    return (_order?.items ?? []).reduce(
      (s, it) => s + Math.max(1, it.quantity || 1), 0
    )
  }

  /**
   * Phase 3: fetch the server-side split session for an order, if any.
   * Returns the session payload on 200, null on 404 / network error.
   * Server endpoint hides completed sessions, so a 200 always means the
   * order has an in_progress or paused split that should be resumed.
   */
  async function _fetchSplitSession(orderId) {
    try {
      const res = await window.api(
        `/api/merchants/${window.merchantId}/orders/${orderId}/split-session`
      )
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  /**
   * Phase 3: rehydrate client split state from a server session payload.
   * Sets _splitMode, _splitTotalLegs, _splitLegBases, _assignedItemIndices,
   * _splitCurrentLeg (= number of legs already paid), and _isResuming.
   */
  function _hydrateFromSession(s) {
    _splitMode           = s.splitMode
    _splitTotalLegs      = s.expectedTotalLegs ?? null
    _splitLegBases       = Array.isArray(s.paidLegBases) ? s.paidLegBases.slice() : []
    _assignedItemIndices = new Set(Array.isArray(s.paidIndices) ? s.paidIndices : [])
    _splitCurrentLeg     = _splitLegBases.length        // last paid leg number
    _isResuming          = true
    _resumedFromStatus   = s.status ?? null
  }

  /**
   * Local fallback for "is this the last split leg?" used only when the server
   * hasn't already returned isLastLeg (e.g. 409 retry, terminal pre-recorded
   * paths). Authoritative answer always comes from the server.
   *
   * Safe to call from BILL_REVIEW (after _computeLegBase ran) and the
   * RECEIPT_OPTIONS / LEG_COMPLETE screens. NOT safe from SPLIT_ITEMS_SELECT
   * before the staff hits "Person N's Items →": _currentLegItems is being
   * mutated and the inferred answer would flap as items are ticked.
   */
  function _inferLastLegLocally() {
    if (!_splitMode) return true
    if (_splitMode === 'by_items') {
      return _assignedItemIndices.size + _currentLegItems.length >= _totalUnits()
    }
    return _splitCurrentLeg >= _splitTotalLegs
  }

  /** Auto-set tip at pct% on current leg base. */
  function _autoSetTip(pct = 20) {
    if (_legSubtotalCents === null) return
    const base = _legSubtotalCents + _legTaxCents
    _tipCents        = Math.round(base * pct / 100)
    _gratuityPercent = pct
  }

  /** Reset per-leg payment state, keeping split configuration. */
  function _resetLegState() {
    _paymentType      = null
    _tipCents         = 0
    _gratuityPercent  = null
    _cashTendered     = 0
    _cardType         = null
    _cardLastFour     = null
    _cardholderName   = null
    _transactionId    = null
    _authCode         = null
    _signatureDataUrl = null
    _paymentId        = null
    _lastLegFromServer = true
    _amexSurchargeCents = 0
    _terminalTxId             = null
    _terminalTransferId       = null
    _terminalDeviceId         = null
    _terminalError            = null
    _terminalInitiating       = false
    _terminalAutoRetries      = 0
    _terminalAlreadySucceeded = false
    _terminalTipOnDevice      = false
    _selectedTerminal         = null
    _terminalStartedAt        = 0
    _switchingToCash          = false
    if (_terminalPollTimer) { clearInterval(_terminalPollTimer); _terminalPollTimer = null }
    _counterInitiating  = false
    _counterStatus      = null
    _counterError       = null
    if (_counterPollTimer) { clearInterval(_counterPollTimer); _counterPollTimer = null }
    _cloverLegMode    = false
    _cloverFullMode   = false
    _cleanupPhoneForm()
    _customLegBase    = null
    _currentLegItems  = []
    _legSubtotalCents = null
    _legTaxCents      = 0
    // NOTE: _splitMode, _splitTotalLegs, _splitCurrentLeg,
    //       _splitLegBases, _assignedItemIndices are preserved
  }

  /**
   * Returns true when the current leg should be processed via Clover Flex with a 20%
   * service charge (replaces tip). False for gift-card legs and non-split orders.
   */
  function _isCloverSplit() {
    return _cloverEnabled && _splitMode !== null && _paymentType !== 'gift_card'
  }

  /** Compute Amex 0.3% surcharge on the current leg's pre-tip base. */
  function _updateAmexSurcharge() {
    if (_paymentType !== 'card' || _cardType !== 'amex') {
      _amexSurchargeCents = 0
      return
    }
    let base
    if (_splitMode && _legSubtotalCents !== null) {
      base = _legSubtotalCents + _legTaxCents
    } else {
      const subtotal      = _order.subtotalCents ?? _order.totalCents ?? 0
      const discount      = _order.discountCents ?? 0
      const serviceCharge = _order.serviceChargeCents ?? 0
      const taxRate       = _profile?.taxRate ?? 0
      const taxed         = subtotal - discount
      base = taxed + serviceCharge + Math.round((taxed + serviceCharge) * taxRate)
    }
    _amexSurchargeCents = Math.ceil(base * 0.003)
  }

  // ── BILL REVIEW ───────────────────────────────────────────────────────────

  function renderBillReview(el) {
    const { subtotal, discount, serviceCharge, taxCents, rawTaxCents, total } = computeTotals()
    const tipOpts  = _profile?.tipOptions ?? [18, 20, 22, 25]
    const isInSplit = !!_splitMode
    // Service charges replace tips — hide tip buttons whenever a service charge exists.
    const hasSvcCharge = (_order.serviceChargeCents ?? 0) > 0
    if (hasSvcCharge) { _tipCents = 0; _gratuityPercent = null }

    // Items to display: all items normally, only this leg's items for by_items
    const allItems    = _order.items ?? []
    const displayItems = _splitMode === 'by_items'
      ? _currentLegItems.map(i => allItems[i]).filter(Boolean)
      : allItems

    let itemRows = ''
    displayItems.forEach((item, displayIdx) => {
      const allItemIdx = _splitMode === 'by_items' ? _currentLegItems[displayIdx] : displayIdx
      const lineTotal = item.lineTotalCents ?? (item.priceCents * item.quantity)
      const modHtml = (item.modifiers ?? [])
        .map(m => esc(m.name) + (m.priceCents > 0 ? ` +${fmt(m.priceCents)}` : ''))
        .join(', ')
      itemRows += `
        <tr class="pm-item-row" data-item-idx="${allItemIdx}">
          <td>${esc(item.quantity)}× ${esc(item.dishName)}
            ${modHtml ? `<div class="pm-item-mods">${modHtml}</div>` : ''}
          </td>
          <td>${fmt(lineTotal)}</td>
        </tr>`
    })

    // Gift card banner (when a card is attached)
    let gcBanner = ''
    if (_giftCard) {
      gcBanner = `
        <div class="pm-gc-banner">
          <span class="pm-gc-icon">🎁</span>
          <span class="pm-gc-info">
            <strong>${esc(_giftCard.maskedCode)}</strong> · Balance: ${fmt(_giftCard.balanceCents)}
            ${_giftCard.customerName !== 'Unknown' ? `<span class="pm-gc-purchaser">Purchased by ${esc(_giftCard.customerName)}</span>` : ''}
          </span>
          <button class="pm-gc-remove" id="pm-btn-gc-remove" title="Remove gift card">✕</button>
        </div>`
    }

    // Split context banner
    let splitBanner = ''
    if (isInSplit) {
      const fb    = _fullBase()
      const paid  = _splitLegBases.reduce((a, b) => a + b, 0)
      const modeLabel = _splitMode === 'equal' ? `Equal (${_splitTotalLegs}-way)` :
                        _splitMode === 'by_items' ? 'By Items' : 'Custom'
      const personLabel = _splitMode === 'by_items'
        ? `Person ${_splitCurrentLeg}`
        : `Person ${_splitCurrentLeg} of ${_splitTotalLegs}`
      splitBanner = `
        <div class="pm-split-banner">
          <span class="pm-split-badge">${modeLabel} · ${personLabel}</span>
          ${paid > 0 ? `<span>${fmt(paid)} paid · ${fmt(Math.max(0, fb - paid))} remaining</span>` : ''}
        </div>`
    }

    // Totals block — custom mode leg 1 shows an amount input instead of computed subtotal
    const isCustomLeg1 = _splitMode === 'custom' && _splitCurrentLeg < _splitTotalLegs
    let totalsHtml
    if (isCustomLeg1) {
      const inputVal = _customLegBase !== null && _customLegBase > 0
        ? (_customLegBase / 100).toFixed(2) : ''
      totalsHtml = `
        <div class="pm-totals">
          <div class="pm-totals-row"><span>This person's share ($)</span></div>
          <div class="pm-tip-custom-row" style="padding:0.25rem 0">
            <input id="pm-custom-share" class="pm-tip-custom-input" type="number" min="0" step="0.01"
                   placeholder="${fmt(_fullBase()).replace('$', '')}" value="${esc(inputVal)}"
                   style="max-width:100%">
          </div>
          ${_tipCents > 0 ? `<div class="pm-totals-row"><span>Tip</span><span>${fmt(_tipCents)}</span></div>` : ''}
          <div class="pm-totals-row pm-total-final"><span>Total</span><span id="pm-live-total">${fmt(total)}</span></div>
        </div>`
    } else {
      const subtotalLabel = _splitMode === 'equal'
        ? `Share (${_splitCurrentLeg < _splitTotalLegs ? `${_splitTotalLegs}-way equal` : 'remainder'})`
        : 'Subtotal'
      const discountRow = discount > 0
        ? `<div class="pm-totals-row pm-discount"><span>${esc(_order.discountLabel ?? 'Discount')}</span><span>-${fmt(discount)}</span></div>`
        : ''
      const svcLabel = _order.serviceChargeLabel ?? 'Service Charge'
      const serviceChargeRow = serviceCharge > 0
        ? `<div class="pm-totals-row pm-service-charge"><span>${esc(svcLabel)}</span><span>+${fmt(serviceCharge)}</span></div>`
        : ''
      const taxRow = (rawTaxCents ?? taxCents) > 0
        ? `<div class="pm-totals-row"><span>Tax</span><span>${fmt(taxCents)}</span></div>`
        : ''
      const gcTaxCreditRow = (_giftCard && _giftCardTaxOffsetCents > 0)
        ? `<div class="pm-totals-row pm-gc-tax-credit"><span>Gift card tax credit</span><span>-${fmt(_giftCardTaxOffsetCents)}</span></div>`
        : ''
      const tipRow = _tipCents > 0
        ? `<div class="pm-totals-row"><span>Tip</span><span>${fmt(_tipCents)}</span></div>`
        : ''
      totalsHtml = `
        <div class="pm-totals">
          <div class="pm-totals-row"><span>${subtotalLabel}</span><span>${fmt(subtotal)}</span></div>
          ${discountRow}${serviceChargeRow}${taxRow}${gcTaxCreditRow}${tipRow}
          <div class="pm-totals-row pm-total-final"><span>Total</span><span id="pm-live-total">${fmt(total)}</span></div>
        </div>`
    }

    // Tip buttons — hidden when a service charge is applied (service charge replaces tip),
    // or replaced by a banner when tip-on-terminal is enabled (terminal collects tip).
    const tipOnTerminalEnabled = _profile?.tipOnTerminal === true
    // Pre-tip base: total before any tip or Amex surcharge
    const preTipBase = total - _tipCents - _amexSurchargeCents
    const tipBtns = (hasSvcCharge || tipOnTerminalEnabled) ? '' : [{ label: 'No Tip', value: 0 }, ...tipOpts.map(p => ({ label: `${p}%`, value: p }))]
      .map(opt => {
        const isActive = opt.value === 0
          ? (_tipCents === 0 && _gratuityPercent === null)
          : (_gratuityPercent === opt.value)
        const dollarHtml = opt.value > 0
          ? `<span class="pm-tip-btn-amt">${fmt(Math.round(preTipBase * opt.value / 100))}</span>`
          : ''
        return `<button class="pm-tip-btn${isActive ? ' active' : ''}" data-tip-pct="${opt.value}"><span>${esc(opt.label)}</span>${dollarHtml}</button>`
      }).join('')

    const tipSectionHtml = hasSvcCharge ? '' : tipOnTerminalEnabled
      ? `<div class="pm-tip-section pm-tip-on-terminal-note">
           <span class="pm-tot-icon">📲</span>
           <span>Customer will select tip on the terminal</span>
         </div>`
      : `
      <div class="pm-tip-section">
        <div class="pm-tip-label">Tip</div>
        <div class="pm-tip-buttons">${tipBtns}
          <button class="pm-tip-btn${_gratuityPercent === 'custom' ? ' active' : ''}" data-tip-pct="custom">Custom</button>
        </div>
        <div class="pm-tip-custom-row" id="pm-custom-tip-row" style="${_gratuityPercent === 'custom' ? '' : 'display:none'}">
          <label for="pm-custom-tip">Amount ($)</label>
          <input id="pm-custom-tip" class="pm-tip-custom-input" type="number" min="0" step="0.01"
                 placeholder="0.00" value="${_tipCents > 0 && _gratuityPercent === 'custom' ? (_tipCents / 100).toFixed(2) : ''}">
        </div>
      </div>`

    // Gift card pay actions — determine case A vs B
    const gcCovered = _giftCard && _giftCard.balanceCents >= total  // Case B: card covers entire total
    const gcPartial = _giftCard && _giftCard.balanceCents < total   // Case A: card covers partial

    el.innerHTML = `
      ${gcBanner}
      ${splitBanner}
      <div class="pm-bill">
        <table class="pm-items-table">
          <thead><tr><th>Item</th><th style="text-align:right">Price</th></tr></thead>
          <tbody>${itemRows || '<tr><td colspan="2" style="color:#999;padding:1rem 0">No items</td></tr>'}</tbody>
        </table>
      </div>
      ${totalsHtml}
      ${tipSectionHtml}
      <div class="pm-pay-actions">
        ${gcCovered
          // Case B: gift card fully covers the order
          ? `<button class="pm-pay-btn gc-pay" id="pm-btn-gc-pay">🎁 Pay with Gift Card</button>`
          : gcPartial
          // Case A: gift card covers partial, split into 2 legs
          ? `<button class="pm-pay-btn gc-pay" id="pm-btn-gc-split">🎁 Use ${fmt(_giftCard.balanceCents)} Gift Card + pay remainder</button>`
          : (() => {
              // Clover: single "Pay via Clover Flex" button for all legs
              if (_cloverEnabled) {
                return '<button class="pm-pay-btn card" id="pm-btn-clover">🍀 Pay via Clover Flex</button>'
              }
              // Normal card/cash buttons
              const dineInTerminals = _availableTerminals.filter(t => t.model === 'pax_a920_pro' || t.model === 'pax_a920_emu')
              return dineInTerminals.length > 1
                ? dineInTerminals.map((t) =>
                    `<button class="pm-pay-btn card" data-terminal-idx="${_availableTerminals.indexOf(t)}">💳 ${esc(t.nickname)}</button>`
                  ).join('')
                : '<button class="pm-pay-btn card" id="pm-btn-card">💳 Charge card</button>'
            })()
        }
        ${(!gcCovered && !gcPartial) ? '<button class="pm-pay-btn cash" id="pm-btn-cash">💵 Pay Cash</button>' : ''}
        ${!isInSplit && !_giftCard ? '<button class="pm-split-btn" id="pm-btn-split">⚡ Split</button>' : ''}
        ${!_giftCard ? `<button class="pm-gc-add-btn" id="pm-btn-add-gc">🎁 Gift Card</button>` : ''}
      </div>`

    // Custom share input (custom split mode, leg 1)
    const shareInput = el.querySelector('#pm-custom-share')
    if (shareInput) {
      shareInput.addEventListener('input', (e) => {
        _customLegBase = Math.round(parseFloat(e.target.value || '0') * 100)
        if (isNaN(_customLegBase) || _customLegBase < 0) _customLegBase = 0
        _legSubtotalCents = _customLegBase
        _legTaxCents = 0
        // Update total and tip button active states without losing input focus
        const liveEl = el.querySelector('#pm-live-total')
        if (liveEl) liveEl.textContent = fmt(computeTotals().total)
        el.querySelectorAll('.pm-tip-btn').forEach(b => {
          if (b.dataset.tipPct === 'custom') return
          const pct = Number(b.dataset.tipPct)
          b.classList.toggle('active', pct === _gratuityPercent && pct !== 0)
          if (pct === 0) b.classList.toggle('active', _tipCents === 0 && _gratuityPercent === null)
        })
        // Update tip row in totals
        const totalsEl = el.querySelector('.pm-totals')
        if (totalsEl && _tipCents > 0) {
          const existingTipRow = totalsEl.querySelector('.pm-tip-row')
          if (existingTipRow) {
            existingTipRow.querySelector('span:last-child').textContent = fmt(_tipCents)
          }
        }
      })
    }

    // Tip button handlers
    el.querySelectorAll('.pm-tip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pct = btn.dataset.tipPct
        const customRow = el.querySelector('#pm-custom-tip-row')
        if (pct === 'custom') {
          // No render() — DOM stays intact; manually update active state
          _gratuityPercent = 'custom'
          customRow.style.display = 'flex'
          el.querySelector('#pm-custom-tip')?.focus()
          el.querySelectorAll('.pm-tip-btn').forEach(b => b.classList.remove('active'))
          btn.classList.add('active')
        } else {
          _gratuityPercent = pct === '0' ? null : Number(pct)
          const { taxed, taxCents: tc } = computeTotals()
          const base = taxed + tc
          _tipCents = pct === '0' ? 0 : Math.round(base * Number(pct) / 100)
          customRow.style.display = 'none'
          // render() rebuilds DOM; active state is driven by _gratuityPercent in the template
          render()
        }
      })
    })

    el.querySelector('#pm-custom-tip')?.addEventListener('input', (e) => {
      _tipCents = Math.round(parseFloat(e.target.value || '0') * 100)
      if (isNaN(_tipCents) || _tipCents < 0) _tipCents = 0
      const liveEl = el.querySelector('#pm-live-total')
      if (liveEl) liveEl.textContent = fmt(computeTotals().total)
    })

    // Card mode: one button per terminal, or single fallback "Charge card"
    const _onCardBtnClick = (terminal) => {
      if (isCustomLeg1 && !_customLegBase) {
        const si = el.querySelector('#pm-custom-share')
        if (si) { si.focus(); si.style.borderColor = '#c0392b'; return }
      }
      _selectedTerminal = terminal
      _paymentType = 'card'
      // Counter (screenless) devices use the Android app via WS; terminal devices use Finix API
      _screen = _isCounterDevice() ? 'COUNTER_WAITING' : 'CARD_CONFIRM'
      render()
    }
    // Use the same dineInTerminals filter as the HTML template so the binding
    // condition always matches the buttons that were actually rendered.
    const dineInTerminals = _availableTerminals.filter(t => t.model === 'pax_a920_pro' || t.model === 'pax_a920_emu')
    if (dineInTerminals.length > 1) {
      el.querySelectorAll('[data-terminal-idx]').forEach(btn => {
        btn.addEventListener('click', () =>
          _onCardBtnClick(_availableTerminals[Number(btn.dataset.terminalIdx)])
        )
      })
    } else {
      el.querySelector('#pm-btn-card')?.addEventListener('click', () =>
        _onCardBtnClick(dineInTerminals[0] ?? null)
      )
    }

    // Pay Cash — available for both single-payment and split-leg flows
    el.querySelector('#pm-btn-cash')?.addEventListener('click', () => {
      if (isCustomLeg1 && !_customLegBase) {
        const si = el.querySelector('#pm-custom-share')
        if (si) { si.focus(); si.style.borderColor = '#c0392b'; return }
      }
      _paymentType = 'cash'
      _screen = 'CASH_CONFIRM'
      render()
    })

    // Clover Flex button — full-order push for non-split, leg push for split
    el.querySelector('#pm-btn-clover')?.addEventListener('click', () => {
      if (isCustomLeg1 && !_customLegBase) {
        const si = el.querySelector('#pm-custom-share')
        if (si) { si.focus(); si.style.borderColor = '#c0392b'; return }
      }
      if (_splitMode !== null) {
        _cloverLegMode  = true   // split: synthetic order + service charge
      } else {
        _cloverFullMode = true   // non-split: actual items, customer tips on device
      }
      _paymentType = 'card'
      _screen      = 'COUNTER_WAITING'
      render()
    })

    const splitBtn = el.querySelector('#pm-btn-split')
    if (splitBtn) {
      splitBtn.addEventListener('click', () => {
        _screen = 'SPLIT_SELECT'
        render()
      })
    }

    // Gift card — add button
    el.querySelector('#pm-btn-add-gc')?.addEventListener('click', () => {
      _screen = 'GIFT_CARD_LOOKUP'
      render()
    })

    // Gift card — remove button
    el.querySelector('#pm-btn-gc-remove')?.addEventListener('click', () => {
      _giftCard = null
      _giftCardTaxOffsetCents = 0
      render()
    })

    // Gift card — Case B: pay with gift card (single leg)
    el.querySelector('#pm-btn-gc-pay')?.addEventListener('click', () => {
      if (!_giftCard) return
      const { taxCents, total } = computeTotals()
      _paymentType = 'gift_card'
      // For Case B the split mode is null — single leg
      _screen = 'RECEIPT_OPTIONS'
      render()
    })

    // Gift card — Case A: auto-split (gift card leg + remainder leg)
    el.querySelector('#pm-btn-gc-split')?.addEventListener('click', () => {
      if (!_giftCard) return
      const { taxCents } = computeTotals()
      // Configure a 2-leg split with gift_card mode
      _splitMode        = 'gift_card'
      _splitTotalLegs   = 2
      _splitCurrentLeg  = 1
      _splitLegBases    = []
      // Leg 1: gift card pays its full balance; tax offset applied, tip = 0
      const gcTax         = Math.min(_giftCardTaxOffsetCents, taxCents)
      _legSubtotalCents   = _giftCard.balanceCents - gcTax  // sub portion of gc balance
      _legTaxCents        = gcTax
      _tipCents           = 0
      _gratuityPercent    = null
      _paymentType        = 'gift_card'
      _screen             = 'RECEIPT_OPTIONS'
      render()
    })

    // Item rows — tappable to edit modifiers (only before split mode is chosen)
    if (!_splitMode) {
      el.querySelectorAll('.pm-item-row').forEach((tr) => {
        const idx = parseInt(tr.dataset.itemIdx, 10)
        if (isNaN(idx)) return
        tr.addEventListener('click', () => {
          _editingItemIdx = idx
          _editModalSelections = {}
          _screen = 'EDIT_ITEM'
          render()
        })
      })
    }
  }

  // ── GIFT CARD LOOKUP ──────────────────────────────────────────────────────

  function renderGiftCardLookup(el) {
    el.innerHTML = `
      <div class="pm-gc-lookup">
        <h3>Add Gift Card</h3>
        <p class="pm-gc-lookup-hint">Enter the last 4 characters of the gift card code</p>
        <div class="pm-gc-lookup-row">
          <input id="pm-gc-suffix" class="pm-gc-suffix-input" type="text"
                 maxlength="4" minlength="4" placeholder="e.g. PTHP" autocomplete="off"
                 style="text-transform:uppercase">
          <button class="pm-btn pm-btn-primary" id="pm-btn-gc-search">Search</button>
        </div>
        <div id="pm-gc-results" class="pm-gc-results"></div>
        <div id="pm-gc-lookup-error" class="pm-gc-lookup-error"></div>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-secondary" id="pm-btn-gc-back">← Back</button>
      </div>`

    const input  = el.querySelector('#pm-gc-suffix')
    const errEl  = el.querySelector('#pm-gc-lookup-error')
    const resEl  = el.querySelector('#pm-gc-results')
    const searchBtn = el.querySelector('#pm-btn-gc-search')

    el.querySelector('#pm-btn-gc-back').addEventListener('click', () => {
      _screen = 'BILL_REVIEW'
      render()
    })

    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    })

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchBtn.click()
    })

    input.focus()

    const doSearch = async () => {
      const suffix = input.value.trim()
      if (suffix.length < 4) {
        errEl.textContent = 'Enter all 4 characters'
        return
      }
      errEl.textContent = ''
      resEl.innerHTML = '<div class="pm-gc-searching">Searching…</div>'
      searchBtn.disabled = true

      try {
        const res = await window.api(
          `/api/merchants/${window.merchantId}/gift-cards/lookup?suffix=${encodeURIComponent(suffix)}`
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)

        const cards = data.cards ?? []
        if (cards.length === 0) {
          resEl.innerHTML = '<div class="pm-gc-no-results">No active gift card found with that code</div>'
        } else {
          resEl.innerHTML = cards.map((card, i) => `
            <div class="pm-gc-result" data-idx="${i}">
              <div class="pm-gc-result-code">${esc(card.maskedCode)}</div>
              <div class="pm-gc-result-details">
                Balance: <strong>${fmt(card.balanceCents)}</strong>
                (Face value: ${fmt(card.faceValueCents)})
                ${card.customerName !== 'Unknown' ? ` · ${esc(card.customerName)}` : ''}
              </div>
              <button class="pm-btn pm-btn-primary pm-gc-confirm-btn" data-idx="${i}">Use This Card</button>
            </div>
          `).join('')

          resEl.querySelectorAll('.pm-gc-confirm-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const card = cards[Number(btn.dataset.idx)]
              if (!card) return
              _giftCard = card
              // Compute tax offset: min(embedded tax, order tax)
              const { rawTaxCents } = computeTotals()
              _giftCardTaxOffsetCents = Math.min(card.taxEmbeddedCents, rawTaxCents ?? 0)
              _screen = 'BILL_REVIEW'
              render()
            })
          })
        }
      } catch (err) {
        resEl.innerHTML = ''
        errEl.textContent = err.message ?? 'Lookup failed. Please try again.'
      } finally {
        searchBtn.disabled = false
      }
    }

    searchBtn.addEventListener('click', doSearch)
  }

  // ── EDIT ITEM ─────────────────────────────────────────────────────────────

  function renderEditItem(el) {
    const item     = (_order.items ?? [])[_editingItemIdx]
    if (!item) { _screen = 'BILL_REVIEW'; return render() }

    // Find menu item for modifier group definitions
    const menu     = window.state?.menu
    const allFlat  = menu ? [
      ...(menu.categories ?? []).flatMap(c => c.items ?? []),
      ...(menu.uncategorizedItems ?? []),
    ] : []
    const menuItem = allFlat.find(i => i.id === item.itemId) ?? null

    // Pre-populate selections from stored modifiers
    if (menuItem && Object.keys(_editModalSelections).length === 0) {
      for (const mod of (item.modifiers ?? [])) {
        const group = (menuItem.modifierGroups ?? []).find(g =>
          (g.modifiers ?? []).some(m => m.id === mod.modifierId)
        )
        if (group) {
          _editModalSelections[group.id] = { modifierId: mod.modifierId, name: mod.name, priceCents: mod.priceCents }
        }
      }
    }

    // Render modifier groups
    let groupsHtml = ''
    if (menuItem?.modifierGroups?.length) {
      for (const group of menuItem.modifierGroups) {
        const optionsHtml = (group.modifiers ?? []).map(mod => {
          const oos = mod.stockStatus && mod.stockStatus !== 'in_stock'
          const sel = _editModalSelections[group.id]?.modifierId === mod.id
          const label = mod.priceCents > 0 ? `${esc(mod.name)} +${fmt(mod.priceCents)}` : esc(mod.name)
          return `<button class="pm-edit-mod-option${sel ? ' selected' : ''}${oos ? ' unavailable' : ''}"
            data-group="${esc(group.id)}" data-mod="${esc(mod.id)}"
            data-name="${esc(mod.name)}" data-price="${mod.priceCents}"
            ${oos ? 'disabled' : ''}>${label}</button>`
        }).join('')
        groupsHtml += `
          <div class="pm-edit-mod-group">
            <div class="pm-edit-mod-group-name">${esc(group.name)}${group.isMandatory ? ' <span class="pm-edit-required">*</span>' : ''}</div>
            <div class="pm-edit-mod-options">${optionsHtml}</div>
          </div>`
      }
    } else if (!menuItem) {
      groupsHtml = '<p class="pm-edit-no-menu">This item is no longer in the menu — modifiers cannot be changed.</p>'
    } else {
      groupsHtml = '<p class="pm-edit-no-menu">No modifier options for this item.</p>'
    }

    el.innerHTML = `
      <div class="pm-edit-item-screen">
        <div class="pm-edit-item-header">
          <span class="pm-edit-item-name">${esc(item.dishName ?? item.name ?? '—')}</span>
          <span class="pm-edit-item-base">${fmt(item.priceCents)}</span>
        </div>
        <div class="pm-edit-mod-body">${groupsHtml}</div>
        <div class="pm-edit-actions">
          <button class="pm-edit-cancel-btn" id="pm-edit-cancel">Cancel</button>
          <button class="pm-edit-update-btn" id="pm-edit-update"${!menuItem ? ' disabled' : ''}>Update Item</button>
        </div>
      </div>`

    // Modifier toggle handlers
    el.querySelectorAll('.pm-edit-mod-option:not(.unavailable)').forEach(btn => {
      btn.addEventListener('click', () => {
        const groupId = btn.dataset.group
        const modId   = btn.dataset.mod
        if (_editModalSelections[groupId]?.modifierId === modId) {
          delete _editModalSelections[groupId]
        } else {
          _editModalSelections[groupId] = {
            modifierId: modId,
            name: btn.dataset.name,
            priceCents: parseInt(btn.dataset.price, 10),
          }
        }
        el.querySelectorAll(`.pm-edit-mod-option[data-group="${groupId}"]`).forEach(b => {
          b.classList.toggle('selected', _editModalSelections[groupId]?.modifierId === b.dataset.mod)
        })
      })
    })

    el.querySelector('#pm-edit-cancel').addEventListener('click', () => {
      _editingItemIdx = null
      _editModalSelections = {}
      _screen = 'BILL_REVIEW'
      render()
    })

    el.querySelector('#pm-edit-update').addEventListener('click', async () => {
      const updateBtn = el.querySelector('#pm-edit-update')
      updateBtn.disabled = true
      updateBtn.textContent = 'Saving…'

      const newMods    = Object.values(_editModalSelections)
      const modCents   = newMods.reduce((s, m) => s + m.priceCents, 0)
      const newLine    = (item.priceCents + modCents) * (item.quantity ?? 1)

      // Mutate order in place
      const items = _order.items ?? []
      items[_editingItemIdx] = { ...items[_editingItemIdx], modifiers: newMods, lineTotalCents: newLine }
      _order.subtotalCents   = items.reduce((s, it) => s + (it.lineTotalCents ?? it.priceCents * (it.quantity ?? 1)), 0)
      _order.totalCents      = null  // will be recomputed by computeTotals()

      // Patch the order on the server
      try {
        const patchItems = items.map(it => ({
          itemId:            it.itemId ?? '',
          name:              it.dishName ?? it.name ?? '',
          priceCents:        it.priceCents ?? 0,
          quantity:          it.quantity ?? 1,
          selectedModifiers: it.modifiers ?? [],
        }))
        const res = await window.api(
          `/api/merchants/${window.merchantId}/orders/${_order.id}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: patchItems }) }
        )
        // Backend refuses edits to finalized orders (paid/completed/cancelled/refunded)
        // with 409. Surface this to staff rather than silently diverging from the
        // server — staff rule is: create a new order for late add-ons.
        if (res && !res.ok && res.status === 409) {
          const errBody = await res.json().catch(() => ({}))
          if (window.showToast) {
            window.showToast(errBody.error || 'Cannot edit a finalized order — create a new order instead.', 'error')
          } else {
            alert(errBody.error || 'Cannot edit a finalized order — create a new order instead.')
          }
        }
      } catch (err) {
        console.warn('[PaymentModal] order PATCH failed — totals updated locally only:', err)
      }

      _editingItemIdx      = null
      _editModalSelections = {}
      _screen              = 'BILL_REVIEW'
      render()
    })
  }

  // ── SPLIT SELECT ──────────────────────────────────────────────────────────

  function renderSplitSelect(el) {
    el.innerHTML = `
      <div class="pm-split-select-screen">
        <h3 style="text-align:center;margin:0.75rem 0">Split Payment</h3>
        <div class="pm-split-options">

          <div class="pm-split-option-card" id="pm-split-equal">
            <div class="pm-split-option-title">⚖️ Equal</div>
            <div class="pm-split-option-desc">Divide total equally among people</div>
            <div class="pm-split-ways" id="pm-equal-ways" style="display:none">
              ${[2, 3, 4, 6].map(n =>
                `<button class="pm-split-way-btn" data-ways="${n}">${n} people</button>`
              ).join('')}
            </div>
          </div>

          <div class="pm-split-option-card" id="pm-split-items">
            <div class="pm-split-option-title">🍽️ By Items</div>
            <div class="pm-split-option-desc">Each person selects their own items</div>
          </div>

          <div class="pm-split-option-card" id="pm-split-custom">
            <div class="pm-split-option-title">✏️ Custom Amount</div>
            <div class="pm-split-option-desc">Enter a custom amount for each person</div>
          </div>

        </div>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-secondary" id="pm-btn-back">Cancel</button>
      </div>`

    // Equal: toggle ways sub-buttons on click
    el.querySelector('#pm-split-equal').addEventListener('click', () => {
      const waysEl = el.querySelector('#pm-equal-ways')
      el.querySelectorAll('.pm-split-option-card').forEach(c => c.classList.remove('active'))
      el.querySelector('#pm-split-equal').classList.add('active')
      waysEl.style.display = waysEl.style.display === 'none' ? 'flex' : 'none'
    })

    el.querySelectorAll('.pm-split-way-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const N = Number(btn.dataset.ways)
        _splitMode          = 'equal'
        _splitTotalLegs     = N
        _splitCurrentLeg    = 1
        _splitLegBases      = []
        _assignedItemIndices = new Set()
        _computeLegBase()
        _screen = 'BILL_REVIEW'
        render()
      })
    })

    el.querySelector('#pm-split-items').addEventListener('click', () => {
      _splitMode          = 'by_items'
      _splitTotalLegs     = null   // by_items: completion is derived from item coverage, not a fixed count
      _splitCurrentLeg    = 1
      _splitLegBases      = []
      _assignedItemIndices = new Set()
      _currentLegItems    = []
      _legSubtotalCents   = 0
      _legTaxCents        = 0
      _screen = 'SPLIT_ITEMS_SELECT'
      render()
    })

    el.querySelector('#pm-split-custom').addEventListener('click', () => {
      _splitMode          = 'custom'
      _splitTotalLegs     = 2
      _splitCurrentLeg    = 1
      _splitLegBases      = []
      _assignedItemIndices = new Set()
      _customLegBase      = null
      _legSubtotalCents   = 0
      _legTaxCents        = 0
      _tipCents           = 0
      _gratuityPercent    = null
      _screen = 'BILL_REVIEW'
      render()
    })

    el.querySelector('#pm-btn-back').addEventListener('click', () => {
      _screen = 'BILL_REVIEW'
      render()
    })
  }

  // ── SPLIT ITEMS SELECT ────────────────────────────────────────────────────

  function renderSplitItemsSelect(el) {
    // Index space is unit-level: a line with quantity 2 (e.g. "2× Peanut
    // Sauce") becomes two distinct units so each can be assigned to a
    // different person paying.
    const allUnits = _enumerateUnits(_order.items)
    const available = allUnits.filter(u => !_assignedItemIndices.has(u.unitIdx))
    const selectedSet = new Set(_currentLegItems)

    function unitLabel(u) {
      const name = esc(u.item.dishName)
      return u.unitOfTotal > 1
        ? `${name} <span style="color:#999;font-weight:normal">(${u.unitInLine + 1} of ${u.unitOfTotal})</span>`
        : name
    }

    let itemCheckboxes = ''
    for (const unit of available) {
      const checked = selectedSet.has(unit.unitIdx) ? 'checked' : ''
      itemCheckboxes += `
        <label class="pm-split-item-row${checked ? ' selected' : ''}" data-idx="${unit.unitIdx}">
          <input type="checkbox" ${checked} data-idx="${unit.unitIdx}" style="margin-right:0.5rem">
          <span class="pm-split-item-name" style="flex:1">${unitLabel(unit)}</span>
          <span class="pm-split-item-price">${fmt(unit.unitPrice)}</span>
        </label>`
    }

    // Already-paid units from previous legs
    const paidUnits = allUnits.filter(u => _assignedItemIndices.has(u.unitIdx))
    let paidHtml = ''
    if (paidUnits.length > 0) {
      paidHtml += '<div class="pm-split-paid-divider">Already paid</div>'
      for (const unit of paidUnits) {
        paidHtml += `
          <div class="pm-split-item-row pm-split-item-row--paid" aria-disabled="true">
            <span style="width:1.25rem;flex-shrink:0"></span>
            <span class="pm-split-item-name" style="flex:1">${unitLabel(unit)}</span>
            <span class="pm-split-item-price">${fmt(unit.unitPrice)}</span>
          </div>`
      }
    }

    const { legSub, legTax, legBase } = _calcLegItemsSubtotal()

    el.innerHTML = `
      <div class="pm-split-items-screen">
        <div class="pm-split-banner">
          <span class="pm-split-badge">By Items · Person ${_splitCurrentLeg}</span>
        </div>
        <div class="pm-split-items-list" id="pm-items-list">
          ${itemCheckboxes || '<div style="padding:1rem;color:#999;text-align:center">No items available</div>'}
          ${paidHtml}
        </div>
        <div class="pm-split-item-subtotal" id="pm-items-subtotal">
          ${_currentLegItems.length > 0
            ? `<span>${_currentLegItems.length} item(s) · ${fmt(legSub)} + ${fmt(legTax)} tax = <strong>${fmt(legBase)}</strong></span>`
            : '<span style="color:#999">Select items above</span>'}
        </div>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-secondary" id="pm-btn-back">Back</button>
        <button class="pm-btn pm-btn-primary" id="pm-btn-assign"
          ${_currentLegItems.length === 0 ? 'disabled' : ''}>
          Person ${_splitCurrentLeg}'s Items →
        </button>
      </div>`

    el.querySelector('#pm-items-list').addEventListener('change', (e) => {
      const cb = e.target
      if (cb.type !== 'checkbox' || !cb.dataset.idx) return
      const idx = Number(cb.dataset.idx)
      if (cb.checked) {
        if (!_currentLegItems.includes(idx)) _currentLegItems.push(idx)
        cb.closest('label').classList.add('selected')
      } else {
        _currentLegItems = _currentLegItems.filter(i => i !== idx)
        cb.closest('label').classList.remove('selected')
      }
      _refreshItemsSubtotal(el)
      el.querySelector('#pm-btn-assign').disabled = _currentLegItems.length === 0
    })

    el.querySelector('#pm-btn-back').addEventListener('click', () => {
      // Return to split select on first leg, or leg complete on subsequent legs
      _currentLegItems = []
      _screen = _splitLegBases.length === 0 ? 'SPLIT_SELECT' : 'LEG_COMPLETE'
      render()
    })

    el.querySelector('#pm-btn-assign').addEventListener('click', () => {
      if (_currentLegItems.length === 0) return
      _computeLegBase()
      _screen = 'BILL_REVIEW'
      render()
    })
  }

  function _calcLegItemsSubtotal() {
    const taxRate  = _profile?.taxRate ?? 0
    const allUnits = _enumerateUnits(_order?.items)
    const legUnits = _currentLegItems.map(i => allUnits[i]).filter(Boolean)
    const legSub   = legUnits.reduce((s, u) => s + u.unitPrice, 0)
    const legTax   = Math.round(legSub * taxRate)
    return { legSub, legTax, legBase: legSub + legTax }
  }

  function _refreshItemsSubtotal(el) {
    const { legSub, legTax, legBase } = _calcLegItemsSubtotal()
    const subtotalEl = el.querySelector('#pm-items-subtotal')
    if (subtotalEl) {
      subtotalEl.innerHTML = _currentLegItems.length > 0
        ? `<span>${_currentLegItems.length} item(s) · ${fmt(legSub)} + ${fmt(legTax)} tax = <strong>${fmt(legBase)}</strong></span>`
        : '<span style="color:#999">Select items above</span>'
    }
  }

  // ── CASH CONFIRM ─────────────────────────────────────────────────────────

  function renderCashConfirm(el) {
    const { total } = computeTotals()
    const denomBtns = cashDenomOptions(total)
      .map(d => `<button class="pm-denom-btn" data-dollars="${d}">$${d}</button>`)
      .join('')

    const rawChangeCents = _cashTendered > 0 ? _cashTendered * 100 - total : null
    // Round change to nearest nickel (pennies out of use)
    const changeCents = rawChangeCents !== null ? Math.round(rawChangeCents / 5) * 5 : null
    const changeHtml = changeCents !== null
      ? `<div class="pm-change-display${changeCents < 0 ? ' owed' : ''}">
           ${changeCents >= 0
             ? `Change: ${fmt(changeCents)}`
             : `Still owed: ${fmt(Math.abs(changeCents))}`}
         </div>`
      : ''

    el.innerHTML = `
      <div class="pm-cash-screen">
        <div class="pm-cash-total-label">Total Due</div>
        <div class="pm-cash-total">${fmt(total)}</div>
        <div class="pm-denomination-row">${denomBtns}</div>
        <div class="pm-tip-custom-row">
          <label for="pm-cash-tendered">Cash tendered ($)</label>
          <input id="pm-cash-tendered" class="pm-tip-custom-input" type="number" min="0" step="0.01"
                 placeholder="${fmt(total).replace('$', '')}"
                 value="${_cashTendered > 0 ? _cashTendered : ''}">
        </div>
        ${changeHtml}
        <div style="flex:1"></div>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-secondary" id="pm-btn-back">Back</button>
        <button class="pm-btn pm-btn-success" id="pm-btn-confirm-cash">Confirm Cash</button>
      </div>`

    el.querySelectorAll('.pm-denom-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _cashTendered = Number(btn.dataset.dollars)
        render()
      })
    })
    el.querySelector('#pm-cash-tendered').addEventListener('input', (e) => {
      _cashTendered = parseFloat(e.target.value || '0') || 0
      const { total: t } = computeTotals()
      const rawCents = _cashTendered > 0 ? _cashTendered * 100 - t : null
      const cCents = rawCents !== null ? Math.round(rawCents / 5) * 5 : null
      const changeEl = el.querySelector('.pm-change-display')
      if (changeEl) {
        changeEl.className = `pm-change-display${cCents !== null && cCents < 0 ? ' owed' : ''}`
        changeEl.textContent = cCents !== null
          ? (cCents >= 0 ? `Change: ${fmt(cCents)}` : `Still owed: ${fmt(Math.abs(cCents))}`)
          : ''
      } else if (_cashTendered > 0) {
        render()
      }
    })
    el.querySelector('#pm-btn-back').addEventListener('click', () => {
      if (_openMode === 'cash') {
        // Cash opened directly to this screen — Back closes the modal (no payment initiated)
        _cleanup()
        hide()
      } else {
        _screen = 'BILL_REVIEW'
        render()
      }
    })
    el.querySelector('#pm-btn-confirm-cash').addEventListener('click', () => {
      _screen = 'RECEIPT_OPTIONS'   // cash payments skip signature
      render()
    })
  }

  // ── CARD CONFIRM (Terminal Processing) ───────────────────────────────────

  function _stopTerminalPoll() {
    if (_terminalPollTimer) { clearInterval(_terminalPollTimer); _terminalPollTimer = null }
  }

  async function _initiateTerminalSale(el) {
    if (_terminalInitiating) return  // prevent concurrent calls
    _terminalInitiating = true
    const { total } = computeTotals()
    _terminalError = null
    _terminalTxId = null
    _terminalTransferId = null

    try {
      // Server now returns in <100 ms: the Finix POST fires in a background
      // workflow. A tight timeout catches genuine network hangs without fighting
      // the terminal's natural card-present cadence.
      const res = await window.api(`/api/merchants/${window.merchantId}/orders/${_order.id}/terminal-sale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalCents:      total,
          terminalId:      _selectedTerminal?.id ?? null,
          splitMode:       _splitMode,
          splitLegNumber:  _splitMode ? _splitCurrentLeg : null,
          splitTotalLegs:  _splitMode ? _splitTotalLegs  : null,
          splitItemsJson:  _splitMode === 'by_items'
                             ? JSON.stringify(_currentLegItems) : null,
        }),
        timeout: 10_000,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 409 && err.activeTtxId) {
          // Terminal is already processing a payment — re-attach to the active TTX
          // instead of showing an error. Covers the case where staff closed and
          // reopened the modal while createTerminalSale was still in flight.
          _terminalTxId       = err.activeTtxId
          _terminalDeviceId   = _selectedTerminal?.finixDeviceId ?? null
          _terminalInitiating = false
          _terminalStartedAt  = _terminalStartedAt || Date.now()
          _switchingToCash    = false
          _startTerminalPoll()
          render()
          return
        }
        if (res.status === 409) {
          _terminalInitiating = false
          _terminalError = err.error || 'Payment already processed for this order.'
          render()
          return
        }
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = await res.json()

      _terminalTxId             = data.ttxId
      _terminalDeviceId         = data.deviceId
      _terminalTransferId       = null  // Finix transferId arrives on first SUCCEEDED poll
      _terminalAlreadySucceeded = false // legacy field; async-polling workflow handles this internally
      _terminalTipOnDevice      = data.tipOnTerminal === true
      _terminalInitiating       = false
      _terminalStartedAt        = Date.now()
      _switchingToCash          = false
      _startTerminalPoll()
      render()
    } catch (err) {
      _terminalInitiating = false
      _terminalError = err.message || 'Failed to send to terminal'
      render()
    }
  }

  const MAX_TERMINAL_POLLS = 150  // 5 minutes at 2s intervals

  function _startTerminalPoll() {
    _stopTerminalPoll()
    _terminalPollCount = 0
    _terminalPollTimer = setInterval(async () => {
      if (!_terminalTxId) return
      if (++_terminalPollCount >= MAX_TERMINAL_POLLS) {
        _stopTerminalPoll()
        _terminalError = 'Terminal timeout — no response after 5 minutes. Please try again.'
        render()
        return
      }
      try {
        const res = await window.api(`/api/merchants/${window.merchantId}/terminal-sale/by-ttx/${_terminalTxId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()

        // Capture the real Finix transferId once the workflow has it — needed
        // by /record-payment later as the payment's transaction_id.
        if (data.transferId && !_terminalTransferId) {
          _terminalTransferId = data.transferId
        }

        if (data.status === 'approved') {
          _stopTerminalPoll()
          // Tap-beat-cancel race: customer tapped before our switch-to-cash cancel reached
          // the device. The card WAS charged — honour it and drop the cash switch.
          if (_switchingToCash) {
            console.log('[PaymentModal] switch-to-cash lost the race — card already charged, proceeding to signature')
            _switchingToCash = false
          }
          _cardType       = (data.cardBrand || 'visa').toLowerCase()
          _cardLastFour   = data.cardLastFour || null
          _authCode       = data.approvalCode || null
          _transactionId  = data.transferId || _terminalTransferId
          _cardholderName = null
          // Processor is source of truth: always capture tip_amount from the outcome.
          if (data.tipAmountCents > 0) {
            _tipCents = data.tipAmountCents
          } else if (_terminalTipOnDevice && data.amountCents > 0) {
            // Fallback: if the processor didn't break out tip_amount (returns 0),
            // infer the tip from the difference between what was charged and what we sent.
            const sentTotal = computeTotals().total
            const inferred  = data.amountCents - sentTotal
            if (inferred > 0) _tipCents = inferred
          }
          // Server already recorded the payment — pre-set _paymentId so
          // ensurePaymentRecorded() is a no-op (mirrors _startCloverLegPoll).
          if (data.paymentId) {
            _paymentId         = data.paymentId
            _lastLegFromServer = typeof data.isLastLeg === 'boolean'
              ? data.isLastLeg
              : _inferLastLegLocally()
          }
          _screen = _shouldCaptureSignatureOnTablet() ? 'SIGNATURE' : 'RECEIPT_OPTIONS'
          render()
        } else if (data.status === 'declined' || data.status === 'cancelled' || data.status === 'error') {
          _stopTerminalPoll()
          // Switch-to-cash: staff clicked "Take cash instead" and the cancel landed.
          // Skip auto-retry; transition to CASH_CONFIRM with tip/amount preserved.
          if (_switchingToCash && data.reason === 'cancelled_by_staff') {
            _switchingToCash = false
            _terminalTxId = null
            _terminalTransferId = null
            _terminalError = null
            _terminalAutoRetries = 0
            _screen = 'CASH_CONFIRM'
            render()
            return
          }
          if (data.retryable && _terminalAutoRetries < 2) {
            _terminalAutoRetries++
            _terminalTxId = null
            _terminalTransferId = null
            _terminalError = null
            console.log(`[PaymentModal] auto-retry ${_terminalAutoRetries} after ${data.status}/${data.reason || '?'}`)
            const retryDelay = data.retryDelayMs || 0
            if (retryDelay) {
              setTimeout(() => render(), retryDelay)
            } else {
              render()  // re-triggers _initiateTerminalSale
            }
          } else {
            _terminalError = data.message || 'Payment failed on terminal'
            render()
          }
        }
        // waiting — keep polling
      } catch (err) {
        // Network error — keep polling, terminal might still be processing
        console.warn('[PaymentModal] poll error:', err.message)
      }
    }, 2000)
  }

  async function _cancelTerminalSale() {
    _stopTerminalPoll()
    // Prefer workflow-routed cancel (by orderId) so the FSM's cancel-beat-tap
    // race handling fires; server falls back to raw device cancel if no
    // workflow is routed for this order.
    if (_order?.id || _terminalDeviceId) {
      try {
        await window.api(`/api/merchants/${window.merchantId}/terminal-sale/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: _order?.id, deviceId: _terminalDeviceId }),
        })
      } catch (err) {
        console.warn('[PaymentModal] cancel error:', err.message)
      }
    }
    _terminalTxId       = null
    _terminalTransferId = null
    _terminalDeviceId   = null
    _terminalError      = null
  }

  /** Returns true if the selected terminal is screenless (counter device). */
  function _isCounterDevice() {
    if (!_selectedTerminal) return false
    const m = _selectedTerminal.model ?? ''
    // A920 Pro and its emulator have a screen; D135 and A800 are screenless
    return m !== 'pax_a920_pro' && m !== 'pax_a920_emu'
  }

  /**
   * Returns true when the Kizo tablet should display the signature pad
   * after a successful card payment. False when (a) merchant has disabled
   * tablet-side signature capture (signature is collected on the terminal
   * instead), or (b) the device is screenless. Default: true.
   */
  function _shouldCaptureSignatureOnTablet() {
    if (_isCounterDevice()) return false
    return _profile?.signatureCapture !== false
  }

  function renderCardConfirm(el) {
    const { total } = computeTotals()
    const deviceLabel = _selectedTerminal?.nickname ?? 'terminal'

    // Initiating — sending sale request to terminal (no cancel allowed)
    if (!_terminalTxId && !_terminalError && !_terminalInitiating) {
      el.innerHTML = `
        <div class="pm-card-screen">
          <div class="pm-terminal-status">
            <div class="pm-terminal-spinner"></div>
            <div class="pm-terminal-msg"><strong>Sending ${fmt(total)} to ${esc(deviceLabel)}…</strong></div>
          </div>
          <div style="flex:1"></div>
        </div>`
      _initiateTerminalSale(el)
      return
    }

    // Error / cancelled by terminal — show Cancel (PIN) + Retry
    if (_terminalError) {
      el.innerHTML = `
        <div class="pm-card-screen">
          <div class="pm-terminal-status">
            <div class="pm-terminal-error">${esc(_terminalError)}</div>
          </div>
          <div style="flex:1"></div>
        </div>
        <div class="pm-action-bar">
          <button class="pm-btn pm-btn-danger" id="pm-btn-cancel-txn">Cancel</button>
          <button class="pm-btn pm-btn-primary" id="pm-btn-retry">Retry</button>
        </div>`
      // Cancel requires staff PIN — closes modal and returns to order view
      el.querySelector('#pm-btn-cancel-txn').addEventListener('click', () => {
        _pinAction = 'close_modal'
        _pinBuffer = ''
        _screen = 'PIN_EXIT'
        render()
      })
      el.querySelector('#pm-btn-retry').addEventListener('click', () => {
        _terminalError = null
        _terminalTxId = null
        _terminalTransferId = null
        render() // will re-trigger _initiateTerminalSale
      })
      return
    }

    // Waiting — customer tapping / inserting card.
    // The "Take cash instead" button is gated on 5s of elapsed wait time so it
    // doesn't appear during the initial device hand-off.
    const waitMsg = _isCounterDevice()
      ? `Customer should tap or insert card at the counter.`
      : `Customer should tap, insert, or swipe on the terminal.`
    const alreadyNote = _terminalAlreadySucceeded
      ? `<div class="pm-terminal-note">Terminal may show an error — verifying with card network…</div>`
      : ''
    const elapsedMs = _terminalStartedAt ? Date.now() - _terminalStartedAt : 0
    const showSwitchBtn = !_switchingToCash && elapsedMs >= 5000
    const switchingNote = _switchingToCash
      ? `<div class="pm-terminal-note">Cancelling card sale — switching to cash…</div>`
      : ''
    el.innerHTML = `
      <div class="pm-card-screen">
        <div class="pm-terminal-status">
          <div class="pm-terminal-spinner"></div>
          <div class="pm-terminal-msg">
            <strong>Waiting for card — ${fmt(total)}</strong><br>
            ${waitMsg}
          </div>
          ${alreadyNote}
          ${switchingNote}
        </div>
        <div style="flex:1"></div>
      </div>
      ${showSwitchBtn ? `
        <div class="pm-action-bar">
          <button class="pm-btn pm-btn-secondary" id="pm-btn-switch-cash">Customer changed mind — take cash</button>
        </div>` : ''}`
    if (showSwitchBtn) {
      el.querySelector('#pm-btn-switch-cash').addEventListener('click', _switchToCashFromTerminal)
    }
    // If the button isn't shown yet (<5s elapsed), re-render once the threshold lands
    // so staff sees it without having to poke the screen.
    if (!showSwitchBtn && !_switchingToCash && _terminalStartedAt && elapsedMs < 5000) {
      setTimeout(() => {
        if (_screen === 'CARD_CONFIRM' && _terminalTxId && !_terminalError) render()
      }, 5000 - elapsedMs + 50)
    }
  }

  /**
   * Staff clicked "Customer changed mind — take cash". Call the server cancel
   * endpoint with a distinguishing reason, keep polling — the FAILED /
   * CANCELLATION_VIA_API outcome transitions to CASH_CONFIRM; SUCCEEDED honours the
   * charge (customer tapped before the cancel reached the device).
   */
  async function _switchToCashFromTerminal() {
    if (_switchingToCash) return
    _switchingToCash = true
    render()
    try {
      await window.api(`/api/merchants/${window.merchantId}/terminal-sale/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: _order?.id,
          deviceId: _terminalDeviceId,
          reason: 'switch_to_cash',
        }),
      })
    } catch (err) {
      console.warn('[PaymentModal] switch-to-cash cancel failed:', err.message)
      _switchingToCash = false
      _terminalError = 'Failed to cancel card sale. Please wait or try again.'
      render()
    }
    // Keep the existing poll running; it will pick up the state change.
  }

  // ── COUNTER WAITING ───────────────────────────────────────────────────────
  //
  // Shown when a counter (screenless) terminal is selected.
  // The Android counter app handles tip, signature, and card processing.
  // Kizo polls /counter/payment-status and records the payment server-side
  // when payment_result arrives via WebSocket.

  function _stopCounterPoll() {
    if (_counterPollTimer) { clearInterval(_counterPollTimer); _counterPollTimer = null }
  }

  async function _initiateCounterPayment() {
    if (_counterInitiating) return
    _counterInitiating = true
    const { total } = computeTotals()

    try {
      const res = await window.api(
        `/api/merchants/${window.merchantId}/counter/request-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: _order.id,
            amountCents: total,
            tipOptions: [15, 18, 20],
          }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      _counterInitiating = false
      _counterStatus = 'waiting'
      _startCounterPoll()
      render()
    } catch (err) {
      _counterInitiating = false
      _counterStatus = 'error'
      _counterError = err.message || 'Failed to send to counter'
      render()
    }
  }

  function _startCounterPoll() {
    _stopCounterPoll()
    _counterPollTimer = setInterval(async () => {
      try {
        const res = await window.api(
          `/api/merchants/${window.merchantId}/counter/payment-status?orderId=${encodeURIComponent(_order.id)}`
        )
        if (!res.ok) return
        const data = await res.json()
        if (!data.status || data.status === 'waiting') return // still waiting

        _stopCounterPoll()

        if (data.status === 'approved') {
          // Payment recorded server-side — go straight to PIN exit
          _screen = 'PIN_EXIT'
          render()
        } else if (data.status === 'cancelled') {
          // Terminal cancelled — show Cancel(PIN)+Retry rather than returning to BILL_REVIEW
          _counterStatus = 'cancelled'
          _counterError = data.message || 'Transaction cancelled at counter'
          render()
        } else {
          // declined | error
          _counterStatus = data.status
          _counterError = data.message ||
            (data.status === 'declined' ? 'Payment was declined' : 'Payment error')
          render()
        }
      } catch { /* keep polling on network errors */ }
    }, 2000)
  }

  // ── CLOVER PAYMENTS ───────────────────────────────────────────────────────

  /**
   * POST counter/request-payment with `cloverFull: true`.
   * Server pushes the full order (actual items) to Clover Flex and polls for payment.
   * Customer sees real line items and tips on the device.
   */
  async function _initiateCloverFullPayment() {
    if (_counterInitiating) return
    _counterInitiating = true

    try {
      const res = await window.api(
        `/api/merchants/${window.merchantId}/counter/request-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: _order.id, cloverFull: true }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      _counterInitiating = false
      _counterStatus     = 'waiting'
      _startCloverLegPoll()   // reuse — same poll/result handling as leg mode
      render()
    } catch (err) {
      _counterInitiating = false
      _counterStatus     = 'error'
      _counterError      = err.message || 'Failed to send to Clover'
      render()
    }
  }

  /**
   * POST counter/request-payment with a `cloverLeg` payload.
   * Fire-and-forget on the server; we poll payment-status for the result.
   */
  async function _initiateCloverLegPayment() {
    if (_counterInitiating) return
    _counterInitiating = true
    const { subtotal: legSubtotalCents, taxCents: legTaxCents, serviceCharge: serviceChargeCents } = computeTotals()

    try {
      const res = await window.api(
        `/api/merchants/${window.merchantId}/counter/request-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: _order.id,
            cloverLeg: {
              legSubtotalCents,
              legTaxCents,
              serviceChargeCents,
              legNumber:  _splitCurrentLeg,
              totalLegs:  _splitTotalLegs,
              splitMode:  _splitMode,
            },
          }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      _counterInitiating = false
      _counterStatus     = 'waiting'
      _startCloverLegPoll()
      render()
    } catch (err) {
      _counterInitiating = false
      _counterStatus     = 'error'
      _counterError      = err.message || 'Failed to send to Clover'
      render()
    }
  }

  /**
   * Polls payment-status for a Clover split leg result.
   * On approval: pre-sets _paymentId so ensurePaymentRecorded() is a no-op,
   * then navigates directly to RECEIPT_OPTIONS.
   */
  function _startCloverLegPoll() {
    _stopCounterPoll()
    _counterPollTimer = setInterval(async () => {
      try {
        const res = await window.api(
          `/api/merchants/${window.merchantId}/counter/payment-status?orderId=${encodeURIComponent(_order.id)}`
        )
        if (!res.ok) return
        const data = await res.json()
        if (!data.status || data.status === 'waiting') return

        _stopCounterPoll()

        if (data.status === 'approved') {
          // Server already recorded the payment — skip ensurePaymentRecorded() by pre-setting _paymentId
          _paymentId         = data.paymentId
          _lastLegFromServer = _inferLastLegLocally()
          _screen            = 'RECEIPT_OPTIONS'
          render()
        } else if (data.status === 'cancelled') {
          _counterStatus = 'cancelled'
          _counterError  = data.message || 'Transaction cancelled on Clover'
          render()
        } else {
          _counterStatus = data.status
          _counterError  = data.message ||
            (data.status === 'declined' ? 'Payment was declined' : 'Clover payment error')
          render()
        }
      } catch { /* keep polling on network errors */ }
    }, 2000)
  }

  function renderCounterWaiting(el) {
    const { total } = computeTotals()
    const deviceLabel = _selectedTerminal?.nickname ?? 'counter'

    // Initiating — sending request to device (no cancel allowed)
    if (!_counterStatus && !_counterInitiating) {
      const sendMsg = _cloverFullMode
        ? '🍀 Sending full order to Clover Flex…'
        : _cloverLegMode
        ? `🍀 Sending ${fmt(total)} to Clover Flex…`
        : `Sending ${fmt(total)} to ${esc(deviceLabel)}…`
      el.innerHTML = `
        <div class="pm-card-screen">
          <div class="pm-terminal-status">
            <div class="pm-terminal-spinner"></div>
            <div class="pm-terminal-msg"><strong>${sendMsg}</strong></div>
          </div>
          <div style="flex:1"></div>
        </div>`
      if (_cloverFullMode)     _initiateCloverFullPayment()
      else if (_cloverLegMode) _initiateCloverLegPayment()
      else                     _initiateCounterPayment()
      return
    }

    // Error, declined, or cancelled by terminal — show Cancel (PIN) + Retry
    if (_counterStatus === 'error' || _counterStatus === 'declined' || _counterStatus === 'cancelled') {
      const errMsg = _counterError
        || (_counterStatus === 'declined' ? 'Payment was declined' : 'Transaction cancelled at counter')
      el.innerHTML = `
        <div class="pm-card-screen">
          <div class="pm-terminal-status">
            <div class="pm-terminal-error">${esc(errMsg)}</div>
          </div>
          <div style="flex:1"></div>
        </div>
        <div class="pm-action-bar">
          <button class="pm-btn pm-btn-danger" id="pm-btn-cancel-txn">Cancel</button>
          <button class="pm-btn pm-btn-primary" id="pm-btn-retry">Retry</button>
        </div>`
      // Cancel requires staff PIN — closes modal and returns to order view
      el.querySelector('#pm-btn-cancel-txn').addEventListener('click', () => {
        _pinAction = 'close_modal'
        _pinBuffer = ''
        _screen = 'PIN_EXIT'
        render()
      })
      el.querySelector('#pm-btn-retry').addEventListener('click', () => {
        _counterStatus = null
        _counterError = null
        render()
      })
      return
    }

    // Waiting — customer completing payment
    const waitTitle = (_cloverFullMode || _cloverLegMode)
      ? `🍀 Waiting for customer on Clover Flex — ${fmt(total)}`
      : `Waiting for customer — ${fmt(total)}`
    const waitBody = _cloverFullMode
      ? 'Customer is selecting tip and paying on the Clover device.'
      : _cloverLegMode
      ? 'Customer is completing payment on the Clover device. Press <strong>Skip</strong> on the tip screen.'
      : 'Customer is selecting tip and signing at the counter.'
    el.innerHTML = `
      <div class="pm-card-screen">
        <div class="pm-terminal-status">
          <div class="pm-terminal-spinner"></div>
          <div class="pm-terminal-msg">
            <strong>${waitTitle}</strong><br>${waitBody}
          </div>
        </div>
        <div style="flex:1"></div>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-danger" id="pm-btn-cancel-counter">Cancel</button>
      </div>`
    el.querySelector('#pm-btn-cancel-counter').addEventListener('click', () => {
      _pinAction = 'close_modal'
      _pinBuffer = ''
      _screen = 'PIN_EXIT'
      render()
    })
  }

  // ── PHONE TOKENIZE (Finix.js hosted fields) ───────────────────────────────
  //
  // Staff types card details dictated over the phone into Finix-hosted iframes.
  // Finix.js tokenizes client-side → server gets a one-time token, never raw PAN.
  // Flow: BILL_REVIEW → PHONE_TOKENIZE → (charge succeeds) → SIGNATURE

  /** Unmount the Finix form and reset all phone-payment state. */
  function _cleanupPhoneForm() {
    try { _phoneForm?.unmount?.() } catch (_) { /* ignore */ }
    _phoneForm     = null
    _phoneCharging = false
    _phoneError    = null
  }

  function renderPhoneTokenize(el) {
    // Unmount any existing Finix form before destroying its container —
    // prevents the SDK's async internals from calling replaceChildren()
    // on a detached DOM node during re-renders or retries.
    try { _phoneForm?.unmount?.() } catch (_) { /* ignore */ }
    _phoneForm = null

    const { total } = computeTotals()

    el.innerHTML = `
      <div class="pm-phone-screen">
        <h3 class="pm-phone-title">📞 Phone Payment — ${fmt(total)}</h3>
        <div class="pm-phone-form">
          <div id="pm-finix-form"></div>
          <div class="pm-phone-error" id="pm-phone-error-msg"></div>
        </div>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-secondary" id="pm-btn-back">Back</button>
        <button class="pm-btn pm-btn-success" id="pm-btn-phone-charge" disabled>Charge ${fmt(total)}</button>
      </div>`

    el.querySelector('#pm-btn-back').addEventListener('click', () => {
      _cleanupPhoneForm()
      if (_openMode === 'phone') {
        // Opened directly from Order Entry — no BILL_REVIEW to return to; just close
        hide()
        _cleanup()
      } else {
        _screen = 'BILL_REVIEW'
        render()
      }
    })

    const chargeBtn = el.querySelector('#pm-btn-phone-charge')
    const errorEl   = el.querySelector('#pm-phone-error-msg')

    // Guard: Finix.js must be loaded.
    // mode:'phone' jumps straight here before the CDN <script defer> finishes.
    // Inject/retry the script and poll until window.Finix appears (up to 30 s).
    if (!_finixConfig?.applicationId) {
      chargeBtn.textContent = 'Finix.js unavailable'
      errorEl.textContent = 'Payment not configured — Finix application ID missing.'
      return
    }
    if (!window.Finix) {
      const attempt = (renderPhoneTokenize._attempt ?? 0) + 1
      renderPhoneTokenize._attempt = attempt
      // On first attempt, also ensure the script tag is in the DOM
      // (handles cases where the original defer tag silently failed to execute)
      if (attempt === 1 && !document.querySelector('script[src*="js.finix.com"]')) {
        const s = document.createElement('script')
        s.src = 'https://js.finix.com/v/2/finix.js'
        document.head.appendChild(s)
      }
      if (attempt > 60) {
        // Gave up after ~30 s
        chargeBtn.textContent = 'Finix.js unavailable'
        errorEl.textContent = 'Finix tokenization library not loaded — check network connection.'
      } else {
        chargeBtn.innerHTML = '<span class="pm-spinner"></span>Loading payment…'
        setTimeout(() => { if (_screen === 'PHONE_TOKENIZE') render() }, 500)
      }
      return
    }
    renderPhoneTokenize._attempt = 0  // reset for next open

    // Initialise Finix PaymentForm V2 (hosted fields — single iframe container).
    // onUpdate fires whenever field state changes; hasErrors gates the charge button.
    const finixEnv = _finixConfig.sandbox ? 'sandbox' : 'live'
    _phoneForm = window.Finix.PaymentForm(
      'pm-finix-form',
      finixEnv,
      _finixConfig.applicationId,
      {
        paymentMethods: ['card'],
        showAddress: true,
        hideFields: [
          'card_holder_name',
          'address_line1',
          'address_line2',
          'address_city',
          'address_region',
          'address_country',
        ],
        onUpdate: (_state, _binInfo, hasErrors) => {
          chargeBtn.disabled = !!hasErrors
        },
      },
    )

    chargeBtn.addEventListener('click', () => {
      if (_phoneCharging || !_phoneForm) return

      chargeBtn.disabled = true
      chargeBtn.innerHTML = '<span class="pm-spinner"></span>Charging…'
      errorEl.textContent = ''
      _phoneCharging = true
      _phoneError    = null

      _phoneForm.submit((err, res) => {
        if (err) {
          _phoneCharging = false
          _phoneError = err.message || 'Card details invalid — please check and retry'
          chargeBtn.disabled = false
          chargeBtn.textContent = `Charge ${fmt(total)}`
          errorEl.textContent = _phoneError
          return
        }

        const token = res?.data?.id
        if (!token) {
          _phoneCharging = false
          _phoneError = 'Tokenization failed — no token returned'
          chargeBtn.disabled = false
          chargeBtn.textContent = `Charge ${fmt(total)}`
          errorEl.textContent = _phoneError
          return
        }

        // Token received — call server to create PaymentInstrument + Transfer
        ;(async () => {
          try {
            const apiRes = await window.api(
              `/api/merchants/${window.merchantId}/orders/${_order.id}/phone-charge`,
              {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                  token:      token,
                  totalCents: total,
                }),
              },
            )
            const data = await apiRes.json().catch(() => ({}))
            if (!apiRes.ok) throw new Error(data.error || `HTTP ${apiRes.status}`)

            // Unmount Finix form before navigating away to prevent it calling
            // replaceChildren() on a detached container after re-render.
            _cleanupPhoneForm()
            _paymentType    = 'card'
            _transactionId  = data.transferId
            _cardType       = (data.cardBrand ?? 'visa').toLowerCase()
            _cardLastFour   = data.cardLastFour ?? null
            _authCode       = data.approvalCode ?? null
            _cardholderName = null
            _screen = _shouldCaptureSignatureOnTablet() ? 'SIGNATURE' : 'RECEIPT_OPTIONS'
            render()
          } catch (err2) {
            _phoneCharging = false
            _phoneError = err2.message || 'Charge failed — try again'
            chargeBtn.disabled = false
            chargeBtn.textContent = `Charge ${fmt(total)}`
            errorEl.textContent = _phoneError
          }
        })()
      })
    })
  }

  // ── SIGNATURE ─────────────────────────────────────────────────────────────

  function renderSignature(el) {
    const approvedNote = _terminalAlreadySucceeded
      ? `<div class="pm-terminal-approved-note">Payment approved by card network ✓<br><small>The terminal display may have shown an error — the charge went through.</small></div>`
      : ''
    el.innerHTML = `
      <div class="pm-sig-screen">
        ${approvedNote}
        <h3>Signature</h3>
        <div class="pm-sig-canvas-wrap">
          <canvas id="pm-sig-canvas"></canvas>
        </div>
        <div class="pm-sig-hint">Sign with your finger or stylus</div>
        <div class="pm-sig-actions">
          <button class="pm-btn pm-btn-secondary" id="pm-sig-clear">Clear</button>
          <button class="pm-btn pm-btn-secondary" id="pm-sig-skip">Skip</button>
          <button class="pm-btn pm-btn-primary" id="pm-sig-accept">Accept →</button>
        </div>
      </div>`

    _sigCanvas = el.querySelector('#pm-sig-canvas')
    _sigCtx    = _sigCanvas.getContext('2d')
    _sigCanvas.width  = _sigCanvas.offsetWidth || 600
    _sigCanvas.height = 240
    _sigCtx.strokeStyle = '#111'
    _sigCtx.lineWidth   = 2
    _sigCtx.lineCap     = 'round'
    _sigCtx.lineJoin    = 'round'
    _drawing          = false
    _signatureDataUrl = null

    const getPos = (e) => {
      const rect = _sigCanvas.getBoundingClientRect()
      const src = e.touches ? e.touches[0] : e
      return { x: src.clientX - rect.left, y: src.clientY - rect.top }
    }
    _sigCanvas.addEventListener('mousedown',  (e) => { _drawing = true; const p = getPos(e); _lastX = p.x; _lastY = p.y })
    _sigCanvas.addEventListener('mousemove',  (e) => {
      if (!_drawing) return
      const p = getPos(e)
      _sigCtx.beginPath(); _sigCtx.moveTo(_lastX, _lastY); _sigCtx.lineTo(p.x, p.y); _sigCtx.stroke()
      _lastX = p.x; _lastY = p.y
    })
    _sigCanvas.addEventListener('mouseup',    () => { _drawing = false })
    _sigCanvas.addEventListener('mouseleave', () => { _drawing = false })
    _sigCanvas.addEventListener('touchstart', (e) => {
      e.preventDefault(); _drawing = true; const p = getPos(e); _lastX = p.x; _lastY = p.y
    }, { passive: false })
    _sigCanvas.addEventListener('touchmove', (e) => {
      e.preventDefault()
      if (!_drawing) return
      const p = getPos(e)
      _sigCtx.beginPath(); _sigCtx.moveTo(_lastX, _lastY); _sigCtx.lineTo(p.x, p.y); _sigCtx.stroke()
      _lastX = p.x; _lastY = p.y
    }, { passive: false })
    _sigCanvas.addEventListener('touchend', () => { _drawing = false })

    el.querySelector('#pm-sig-clear').addEventListener('click', () => {
      _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height)
      _signatureDataUrl = null
    })
    el.querySelector('#pm-sig-skip').addEventListener('click', () => {
      _signatureDataUrl = null
      _screen = 'RECEIPT_OPTIONS'
      render()
    })
    el.querySelector('#pm-sig-accept').addEventListener('click', () => {
      _signatureDataUrl = _sigCanvas.toDataURL('image/png')
      _screen = 'RECEIPT_OPTIONS'
      render()
    })
  }

  // ── RECEIPT OPTIONS ───────────────────────────────────────────────────────

  function renderReceiptOptions(el) {
    const { subtotal, discount, serviceCharge, taxCents, total } = computeTotals()
    const discountRow = discount > 0
      ? `<div class="pm-totals-row pm-discount"><span>${esc(_order.discountLabel ?? 'Discount')}</span><span>-${fmt(discount)}</span></div>`
      : ''
    const tipRow = _tipCents > 0
      ? `<div class="pm-totals-row"><span>Tip</span><span>${fmt(_tipCents)}</span></div>`
      : ''
    const surchargeRow = _amexSurchargeCents > 0
      ? `<div class="pm-totals-row"><span>Amex surcharge</span><span>${fmt(_amexSurchargeCents)}</span></div>`
      : ''
    const svcChargeRow = serviceCharge > 0
      ? `<div class="pm-totals-row pm-service-charge"><span>Service Charge</span><span>+${fmt(serviceCharge)}</span></div>`
      : ''
    const splitLabel = _splitMode === 'by_items'
      ? `Person ${_splitCurrentLeg}`
      : `Person ${_splitCurrentLeg} of ${_splitTotalLegs}`
    const splitInfo = _splitMode
      ? `<div class="pm-totals-row" style="color:#666;font-size:0.85rem">
           <span>Split</span><span>${splitLabel}</span>
         </div>`
      : ''
    const totalItemCount = _totalUnits()
    const isLastLegUI = !_splitMode
      || (_splitMode === 'by_items'
            ? _assignedItemIndices.size + _currentLegItems.length >= totalItemCount
            : _splitCurrentLeg >= _splitTotalLegs)
    const customerEmail = _order.customerEmail ?? ''

    el.innerHTML = `
      <div class="pm-receipt-screen">
        <div class="pm-success-icon">✅</div>
        <h3>${!isLastLegUI ? `Person ${_splitCurrentLeg} Ready` : 'Payment Complete'}</h3>
        <div class="pm-receipt-summary">
          <div class="pm-totals-row"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>
          ${discountRow}
          ${taxCents > 0 ? `<div class="pm-totals-row"><span>Tax</span><span>${fmt(taxCents)}</span></div>` : ''}
          ${tipRow}
          ${surchargeRow}
          ${svcChargeRow}
          <div class="pm-totals-row pm-total-final"><span>Total</span><span>${fmt(total)}</span></div>
          <div class="pm-totals-row" style="color:#666;font-size:0.85rem">
            <span>Method</span><span>${_paymentType === 'card' ? '💳 Card' : '💵 Cash'}</span>
          </div>
          ${splitInfo}
        </div>
        <div class="pm-receipt-actions">
          <button class="pm-btn pm-btn-secondary pm-receipt-action-btn" id="pm-btn-print-receipt">
            🖨️ Print Receipt
          </button>
          <div class="pm-email-receipt-row">
            <input class="pm-receipt-email-input" id="pm-receipt-email" type="email"
                   placeholder="customer@example.com"
                   value="${esc(customerEmail)}">
            <button class="pm-btn pm-btn-secondary" id="pm-btn-send-email">Send Email</button>
          </div>
        </div>
        <div style="flex:1"></div>
        <div id="pm-submit-error" style="color:#c0392b;font-size:0.85rem;padding:0 1rem;min-height:1.2em"></div>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-primary" id="pm-btn-done">
          ${!isLastLegUI ? 'Record &amp; Next →' : 'Done &amp; Close Tab'}
        </button>
      </div>`

    const emailInput = el.querySelector('#pm-receipt-email')
    const errEl      = el.querySelector('#pm-submit-error')

    /**
     * Records the payment exactly once. Subsequent calls return immediately.
     * Stores _paymentId and _lastLegFromServer on the module-level state.
     */
    async function ensurePaymentRecorded() {
      if (_paymentId) return
      const { subtotal: sub, taxCents: tax, total: tot } = computeTotals()
      const res = await window.api(
        `/api/merchants/${window.merchantId}/orders/${_order.id}/record-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentType:            _paymentType,
            subtotalCents:          sub,
            taxCents:               tax,
            tipCents:               _tipCents,
            totalCents:             tot,
            gratuityPercent:        typeof _gratuityPercent === 'number' ? _gratuityPercent : null,
            amexSurchargeCents:     _amexSurchargeCents,
            cardType:               _cardType,
            cardLastFour:           _cardLastFour,
            cardholderName:         _cardholderName,
            transactionId:          _transactionId,
            authCode:               _authCode,
            signatureBase64:        _signatureDataUrl,
            receiptEmail:           emailInput.value.trim() || null,
            splitMode:              _splitMode,
            splitLegNumber:         _splitMode ? _splitCurrentLeg : null,
            splitTotalLegs:         _splitMode ? _splitTotalLegs  : null,
            splitItemsJson:         _splitMode === 'by_items'
                                      ? JSON.stringify(_currentLegItems) : null,
            giftCardId:             _paymentType === 'gift_card' ? (_giftCard?.id ?? null) : null,
            giftCardTaxOffsetCents: _paymentType === 'gift_card' ? _giftCardTaxOffsetCents : 0,
          }),
        }
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        // 409 with a paymentId means the order is already paid for this leg
        // (e.g. orphan sweep, recovery path, or duplicate click). Trust the
        // server's isLastLeg when present; otherwise infer from local split state
        // so a stale paid-state on a split-payment order doesn't bounce the
        // staff to PIN_EXIT after an intermediate leg.
        if (res.status === 409 && body.paymentId) {
          _paymentId         = body.paymentId
          _lastLegFromServer = typeof body.isLastLeg === 'boolean'
            ? body.isLastLeg
            : _inferLastLegLocally()
          return
        }
        throw new Error(body.error ?? `Server error ${res.status}`)
      }
      const data = await res.json()
      _paymentId        = data.paymentId
      _lastLegFromServer = data.isLastLeg
    }

    /** Fires a receipt action (print / email) after payment is recorded (fire-and-forget). */
    function fireReceipt(action, emailTo) {
      if (!_paymentId) return
      window.api(
        `/api/merchants/${window.merchantId}/payments/${_paymentId}/receipt`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, email: emailTo }),
        }
      ).catch(() => {})
    }

    // ── Print Receipt button ────────────────────────────────────────────────
    const printBtn = el.querySelector('#pm-btn-print-receipt')
    printBtn.addEventListener('click', async () => {
      printBtn.disabled = true
      printBtn.textContent = '⏳ Printing…'
      errEl.textContent = ''
      try {
        await ensurePaymentRecorded()
        fireReceipt('print', null)
        printBtn.textContent = '✅ Sent to printer'
      } catch (err) {
        errEl.textContent = err.message ?? 'Failed to record payment.'
        printBtn.disabled = false
        printBtn.textContent = '🖨️ Print Receipt'
      }
    })

    // ── Send Email button ───────────────────────────────────────────────────
    const sendEmailBtn = el.querySelector('#pm-btn-send-email')
    sendEmailBtn.addEventListener('click', async () => {
      const emailTo = emailInput.value.trim()
      if (!emailTo) { errEl.textContent = 'Please enter an email address.'; return }
      sendEmailBtn.disabled = true
      sendEmailBtn.textContent = '⏳ Sending…'
      errEl.textContent = ''
      try {
        await ensurePaymentRecorded()
        fireReceipt('email', emailTo)
        sendEmailBtn.textContent = '✅ Sent!'
      } catch (err) {
        errEl.textContent = err.message ?? 'Failed to record payment.'
        sendEmailBtn.disabled = false
        sendEmailBtn.textContent = 'Send Email'
      }
    })

    // ── Done & Close Tab / Record & Next button ─────────────────────────────
    const doneBtn = el.querySelector('#pm-btn-done')
    doneBtn.addEventListener('click', async () => {
      doneBtn.disabled = true
      doneBtn.innerHTML = '<span class="pm-spinner"></span>Saving…'
      errEl.textContent = ''
      try {
        await ensurePaymentRecorded()
        if (_lastLegFromServer) {
          _screen = 'PIN_EXIT'
          render()
        } else {
          const { subtotal: sub, taxCents: tax } = computeTotals()
          _splitLegBases.push(sub + tax)
          if (_splitMode === 'by_items') {
            _currentLegItems.forEach(i => _assignedItemIndices.add(i))
          }
          if (_paymentType === 'gift_card') {
            _giftCard = null
            _giftCardTaxOffsetCents = 0
          }
          _screen = 'LEG_COMPLETE'
          render()
        }
      } catch (err) {
        errEl.textContent = err.message ?? 'Failed to record payment. Please try again.'
        doneBtn.disabled = false
        doneBtn.innerHTML = !isLastLegUI ? 'Record &amp; Next →' : 'Done &amp; Close Tab'
      }
    })
  }

  // ── LEG COMPLETE ──────────────────────────────────────────────────────────

  function renderLegComplete(el) {
    const fb        = _fullBase()
    const paid      = _splitLegBases.reduce((a, b) => a + b, 0)
    const remaining = Math.max(0, fb - paid)
    const nextLeg   = _splitCurrentLeg + 1

    // Phase 3: when hydrated from a server session, show a resume banner
    // instead of the "Person N paid!" success header (which implies the
    // current staff just finished a leg — misleading on resume).
    const paidCount = _splitCurrentLeg
    const peopleWord = paidCount === 1 ? 'person has' : 'people have'
    const paidSummary = _splitMode === 'by_items'
      ? `${paidCount} ${peopleWord} paid so far.`
      : `${paidCount} of ${_splitTotalLegs ?? '?'} ${paidCount === 1 ? 'leg has' : 'legs have'} been paid.`
    const heading = _isResuming
      ? `<div class="pm-success-icon">↻</div>
         <h3>Resuming split payment</h3>
         <p style="text-align:center;color:#666;margin:0.25rem 1rem 0.5rem;font-size:0.9rem">
           ${_resumedFromStatus === 'paused' ? 'This split was paused.' : 'This split is in progress.'}
           ${paidSummary}
         </p>`
      : `<div class="pm-success-icon">✅</div>
         <h3>Person ${_splitCurrentLeg} paid!</h3>`
    const buttonLabel = _isResuming
      ? `Continue with Person ${nextLeg} →`
      : `Person ${nextLeg} →`

    el.innerHTML = `
      <div class="pm-leg-complete-screen">
        ${heading}
        <div class="pm-receipt-summary" style="margin:0.75rem 0">
          <div class="pm-totals-row">
            <span>Collected so far (pre-tip)</span>
            <span>${fmt(paid)}</span>
          </div>
          <div class="pm-totals-row pm-total-final">
            <span>Remaining base</span>
            <span>${fmt(remaining)}</span>
          </div>
        </div>
        <p style="text-align:center;color:#555;margin:0.5rem 1rem">
          ${remaining > 0
            ? `Person ${nextLeg} owes <strong>${fmt(remaining)}</strong> + their tip`
            : 'Everyone has paid!'}
        </p>
      </div>
      <div class="pm-action-bar">
        <button class="pm-btn pm-btn-primary" id="pm-btn-next-person">
          ${buttonLabel}
        </button>
      </div>`

    el.querySelector('#pm-btn-next-person').addEventListener('click', () => {
      _isResuming = false
      _resumedFromStatus = null
      _splitCurrentLeg++
      _resetLegState()
      if (_splitMode === 'by_items') {
        _screen = 'SPLIT_ITEMS_SELECT'
      } else {
        // For equal / custom: compute leg base
        _computeLegBase()
        _screen = 'BILL_REVIEW'
      }
      render()
    })
  }

  // ── EXIT CONFIRM SPLIT (Phase 4) ──────────────────────────────────────────
  // Confirmation step shown when staff taps the close button while a split
  // payment is in progress (≥1 leg paid). Staff must explicitly choose
  // "Pause & Exit" to proceed to PIN_EXIT — preventing accidental abandonment
  // and surfacing exactly how much is left unpaid.

  function renderExitConfirmSplit(el) {
    const fb        = _fullBase()
    const paid      = _splitLegBases.reduce((a, b) => a + b, 0)
    const remaining = Math.max(0, fb - paid)
    const legCount  = _splitLegBases.length

    const totalItems = _totalUnits()
    // Include items the staff has ticked in the current SPLIT_ITEMS_SELECT
    // (not yet paid) so the "unassigned" count reflects what's left after
    // the current leg would commit. Otherwise it overstates the remaining work.
    const inFlight = _splitMode === 'by_items'
      ? new Set([..._assignedItemIndices, ..._currentLegItems])
      : new Set()
    const itemsLeft  = _splitMode === 'by_items'
      ? totalItems - inFlight.size
      : null

    // Preview discount that would be applied if the staff chooses
    // "Customer left — discount remaining". Mirrors the server math:
    //   newTaxedBase = round(paidPreTip / (1 + taxRate))
    //   discount = (subtotal - existingDiscount + serviceCharge) - newTaxedBase
    // The server is authoritative; this preview is just for the dialog text.
    const taxRate = _profile?.taxRate ?? 0
    const existingTaxedBase = (_order?.subtotalCents ?? 0)
                            - (_order?.discountCents ?? 0)
                            + (_order?.serviceChargeCents ?? 0)
    const newTaxedBase = Math.round(paid / (1 + taxRate))
    const previewDiscount = Math.max(0, existingTaxedBase - newTaxedBase)

    el.innerHTML = `
      <div class="pm-leg-complete-screen">
        <div class="pm-success-icon">⏸</div>
        <h3>Split payment in progress</h3>
        <div class="pm-receipt-summary" style="margin:0.75rem 0">
          <div class="pm-totals-row">
            <span>${legCount} ${legCount === 1 ? 'leg' : 'legs'} paid</span>
            <span>${fmt(paid)}</span>
          </div>
          <div class="pm-totals-row pm-total-final">
            <span>Remaining base</span>
            <span>${fmt(remaining)}</span>
          </div>
          ${itemsLeft !== null && itemsLeft > 0 ? `
            <div class="pm-totals-row" style="color:#666;font-size:0.85rem">
              <span>Items unassigned</span><span>${itemsLeft} of ${totalItems}</span>
            </div>` : ''}
        </div>
        <p style="text-align:center;color:#555;margin:0.5rem 1rem;font-size:0.9rem">
          <strong>Pause &amp; Exit</strong>: keep the order open, resume on any device.<br>
          <strong>Customer Left</strong>: customer is gone — discount the unpaid ${fmt(previewDiscount)} and close the order.
        </p>
      </div>
      <div class="pm-action-bar" style="flex-wrap:wrap">
        <button class="pm-btn pm-btn-secondary" id="pm-exit-cancel">Cancel</button>
        <button class="pm-btn pm-btn-warning"   id="pm-exit-finalize">Customer Left</button>
        <button class="pm-btn pm-btn-danger"    id="pm-exit-pause">Pause &amp; Exit</button>
      </div>`

    el.querySelector('#pm-exit-cancel').addEventListener('click', () => {
      _screen = _prevScreen ?? 'LEG_COMPLETE'
      _prevScreen = null
      render()
    })

    el.querySelector('#pm-exit-pause').addEventListener('click', () => {
      _pinAction = 'pause_split'
      _pinBuffer = ''
      _screen    = 'PIN_EXIT'
      render()
    })

    el.querySelector('#pm-exit-finalize').addEventListener('click', async () => {
      const ok = window.confirm(
        `Customer left — apply ${fmt(previewDiscount)} discount and close the order?\n\n` +
        `The order will be marked paid for ${fmt(paid)}.\n` +
        `The table will be free for the next customer.\n\n` +
        `This is permanent.`
      )
      if (!ok) return

      const finalizeBtn = el.querySelector('#pm-exit-finalize')
      finalizeBtn.disabled = true
      finalizeBtn.textContent = 'Closing…'
      try {
        const res = await window.api(
          `/api/merchants/${window.merchantId}/orders/${_order.id}/finalize-partial`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } }
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `Server error ${res.status}`)
        }
        // Cancel any in-flight terminal/counter sessions on the way out.
        _cancelInflightSessions()
        _cleanup()
        hide()
        if (typeof window.loadOrders === 'function') window.loadOrders()
      } catch (err) {
        finalizeBtn.disabled = false
        finalizeBtn.textContent = 'Customer Left'
        if (typeof window.showToast === 'function') {
          window.showToast(`Failed to close: ${err.message}`, 'error')
        } else {
          window.alert(`Failed to close: ${err.message}`)
        }
      }
    })
  }

  // ── PIN EXIT ──────────────────────────────────────────────────────────────

  function renderPinExit(el) {
    const lockoutRemaining = Math.max(0, Math.ceil((_pinLockoutUntil - Date.now()) / 1000))
    const isLocked = lockoutRemaining > 0
    const dots = '● '.repeat(_pinBuffer.length).trim() || '‒ ‒ ‒ ‒'

    const pinTitle = _pinAction === 'pause_split'
      ? 'Enter your PIN to pause'
      : 'Enter your PIN to close'
    el.innerHTML = `
      <div class="pm-pin-screen">
        <h3>${pinTitle}</h3>
        <div class="pm-pin-display">${dots}</div>
        <div class="pm-pin-error" id="pm-pin-error"></div>
        <div class="pm-keypad" id="pm-keypad">
          ${[1,2,3,4,5,6,7,8,9].map(n =>
            `<button class="pm-key" data-key="${n}">${n}</button>`
          ).join('')}
          <button class="pm-key pm-key-del" id="pm-key-del">⌫</button>
          <button class="pm-key" data-key="0">0</button>
          <button class="pm-key pm-key-submit" id="pm-key-submit">OK</button>
        </div>
        <div class="pm-pin-lockout" id="pm-pin-lockout" style="${isLocked ? '' : 'display:none'}">
          Too many attempts — wait ${lockoutRemaining}s
        </div>
      </div>`

    if (isLocked) {
      _disableKeypad(el)
      _startLockoutCountdown(el)
      return
    }

    el.querySelector('#pm-keypad').addEventListener('click', (e) => {
      const key = e.target.closest('[data-key]')
      if (key) {
        if (_pinBuffer.length < 4) {
          _pinBuffer += key.dataset.key
          _refreshPinDisplay(el)
        }
        if (_pinBuffer.length === 4) _submitPin(el)
        return
      }
      if (e.target.closest('#pm-key-del')) {
        _pinBuffer = _pinBuffer.slice(0, -1)
        _refreshPinDisplay(el)
        return
      }
      if (e.target.closest('#pm-key-submit')) _submitPin(el)
    })
  }

  function _refreshPinDisplay(el) {
    const dots = '● '.repeat(_pinBuffer.length).trim() || '‒ ‒ ‒ ‒'
    const disp = el.querySelector('.pm-pin-display')
    if (disp) disp.textContent = dots
  }

  /** Cancel any in-flight terminal/counter session on staff exit. Best-effort. */
  function _cancelInflightSessions() {
    if (_counterPollTimer && _order?.id) {
      window.api(`/api/merchants/${window.merchantId}/counter/cancel-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: _order.id }),
      }).catch(() => {})
    }
    if ((_terminalTxId || _terminalDeviceId) && _order?.id) {
      window.api(`/api/merchants/${window.merchantId}/terminal-sale/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: _order.id, deviceId: _terminalDeviceId }),
      }).catch(() => {})
    }
  }

  async function _submitPin(el) {
    if (_pinBuffer.length === 0) return
    _disableKeypad(el)
    try {
      // Phase 4: pause_split sends the PIN directly to the pause endpoint
      // (server validates it). One roundtrip; on success we cleanly close.
      if (_pinAction === 'pause_split' && _order?.id) {
        const res = await window.api(
          `/api/merchants/${window.merchantId}/orders/${_order.id}/split-session/pause`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: _pinBuffer }),
          }
        )
        if (res.ok) {
          _cancelInflightSessions()
          _cleanup()
          hide()
          if (typeof window.loadOrders === 'function') window.loadOrders()
          return
        }
        if (res.status === 409) {
          // Order completed by another device while we were on EXIT_CONFIRM_SPLIT.
          // Nothing left to pause — just close.
          _cleanup()
          hide()
          if (typeof window.loadOrders === 'function') window.loadOrders()
          return
        }
        // 401 (bad PIN) and other errors fall through to the same retry / lockout
        // logic the close_modal path uses.
        _pinBuffer = ''
        _refreshPinDisplay(el)
        _pinAttempts++
        if (_pinAttempts >= 3) {
          _pinLockoutUntil = Date.now() + 30_000
          _pinAttempts = 0
          _disableKeypad(el)
          el.querySelector('#pm-pin-lockout').style.display = ''
          _startLockoutCountdown(el)
        } else {
          const errEl = el.querySelector('#pm-pin-error')
          if (errEl) errEl.textContent =
            `Incorrect PIN (${3 - _pinAttempts} attempt${3 - _pinAttempts === 1 ? '' : 's'} left)`
          _enableKeypad(el)
        }
        return
      }

      const res = await window.api(
        `/api/merchants/${window.merchantId}/employees/authenticate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: _pinBuffer }),
        }
      )
      if (res.ok) {
        if (_pinAction === 'close_modal') {
          _cancelInflightSessions()
        }
        _cleanup()
        hide()
        if (typeof window.loadOrders === 'function') window.loadOrders()
        return
      }
      _pinBuffer = ''
      _refreshPinDisplay(el)

      // 429 = server-side lockout (rate limiter); show a clear wait message
      if (res.status === 429) {
        _disableKeypad(el)
        const lockoutEl = el.querySelector('#pm-pin-lockout')
        if (lockoutEl) { lockoutEl.textContent = 'Too many attempts — wait a few minutes'; lockoutEl.style.display = '' }
        return
      }

      _pinAttempts++
      if (_pinAttempts >= 3) {
        _pinLockoutUntil = Date.now() + 30_000
        _pinAttempts = 0
        _disableKeypad(el)
        el.querySelector('#pm-pin-lockout').style.display = ''
        _startLockoutCountdown(el)
      } else {
        const errEl = el.querySelector('#pm-pin-error')
        if (errEl) errEl.textContent =
          `Incorrect PIN (${3 - _pinAttempts} attempt${3 - _pinAttempts === 1 ? '' : 's'} left)`
        _enableKeypad(el)
      }
    } catch {
      _pinBuffer = ''
      const errEl = el.querySelector('#pm-pin-error')
      if (errEl) errEl.textContent = 'Network error — try again'
      _enableKeypad(el)
    }
  }

  function _disableKeypad(el) { el.querySelectorAll('.pm-key').forEach(k => { k.disabled = true }) }
  function _enableKeypad(el)  { el.querySelectorAll('.pm-key').forEach(k => { k.disabled = false }) }

  function _startLockoutCountdown(el) {
    if (_pinLockoutTimer) clearInterval(_pinLockoutTimer)
    _pinLockoutTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((_pinLockoutUntil - Date.now()) / 1000))
      const lockoutEl = el.querySelector('#pm-pin-lockout')
      if (lockoutEl) lockoutEl.textContent = `Too many attempts — wait ${remaining}s`
      if (remaining <= 0) {
        clearInterval(_pinLockoutTimer)
        _pinLockoutTimer = null
        if (lockoutEl) lockoutEl.style.display = 'none'
        _enableKeypad(el)
      }
    }, 1000)
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function _cleanup() {
    if (_pinLockoutTimer) { clearInterval(_pinLockoutTimer); _pinLockoutTimer = null }
    _screen              = 'BILL_REVIEW'
    _order               = null
    _profile             = null
    _paymentType         = null
    _tipCents            = 0
    _gratuityPercent     = null
    _cashTendered        = 0
    _cardType            = null
    _cardLastFour        = null
    _cardholderName      = null
    _transactionId       = null
    _authCode            = null
    _signatureDataUrl    = null
    _paymentId           = null
    _lastLegFromServer   = true
    _amexSurchargeCents  = 0
    _splitMode           = null
    _splitTotalLegs      = 1
    _splitCurrentLeg     = 1
    _splitLegBases       = []
    _currentLegItems     = []
    _assignedItemIndices = new Set()
    _customLegBase       = null
    _legSubtotalCents    = null
    _legTaxCents         = 0
    _isResuming          = false
    _resumedFromStatus   = null
    _prevScreen          = null
    _pinBuffer           = ''
    _pinAttempts         = 0
    _openMode            = 'card'
    _pinAction           = 'done'
    _giftCard               = null
    _giftCardTaxOffsetCents = 0
    _editingItemIdx         = null
    _editModalSelections    = {}
    _stopTerminalPoll()
    _terminalTxId             = null
    _terminalTransferId       = null
    _terminalDeviceId         = null
    _terminalError            = null
    _terminalInitiating       = false
    _terminalAlreadySucceeded = false
    _selectedTerminal         = null
    // _availableTerminals intentionally preserved — same merchant, no need to re-fetch
    if (_counterPollTimer) { clearInterval(_counterPollTimer); _counterPollTimer = null }
    _counterInitiating   = false
    _counterStatus       = null
    _counterError        = null
    _cloverEnabled       = false
    _cloverLegMode       = false
    _cloverFullMode      = false
    _cleanupPhoneForm()
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  function _ensureOverlay() {
    if (_overlay) return
    _overlay = document.getElementById('payment-modal-overlay')
    if (!_overlay) console.error('[PaymentModal] #payment-modal-overlay not found in DOM')
  }

  /**
   * Open the Review & Pay modal.
   *
   * @param {object} order - Order object from dashboard (camelCase fields).
   *   @param {string}   order.id             - Order ID (used for record-payment API call)
   *   @param {Array}    order.items          - Line items array (each item: { name, quantity, priceCents, modifiers? })
   *   @param {number}   [order.subtotalCents] - Pre-tax, pre-discount subtotal; falls back to totalCents
   *   @param {number}   [order.totalCents]   - Fallback subtotal when subtotalCents is absent
   *   @param {number}   [order.discountCents] - Discount amount in cents (optional)
   *   @param {string}   [order.discountLabel] - Discount label text; defaults to 'Discount'
   *   @param {string}   [order.tableLabel]   - Table identifier displayed in bill header (optional)
   *   @param {string}   [order.customerEmail] - Pre-fill email for receipt delivery (optional)
   *
   * @param {object} profile - Merchant profile object.
   *   @param {number}   [profile.taxRate]    - Tax rate as a decimal (e.g. 0.095); defaults to 0
   *   @param {number[]} [profile.tipOptions] - Suggested tip percentages (e.g. [18,20,22,25]); defaults to [18,20,22,25]
   *
   * @param {{ mode?: 'card'|'cash'|'counter'|'phone', tipCents?: number }} [opts]
   *   mode 'cash'    — bill review shows cash-payment action (no terminal buttons)
   *   mode 'counter' — bill review shows counter-device action
   *   mode 'card'    — default; bill review shows card terminal buttons
   *   mode 'phone'   — skip bill review; open Finix tokenise screen with pre-set tipCents
   */
  async function open(order, profile, opts) {
    _ensureOverlay()
    if (!_overlay) return
    _cleanup()
    _order       = order
    _profile     = profile
    _openMode       = opts?.mode ?? 'card'
    _pinAction      = 'done'
    _finixConfig    = opts?.finix ?? null
    _cloverEnabled  = opts?.clover?.enabled === true

    // Phase 3: if the order has an active split session, resume it.
    // Overrides opts.mode — once a split is in progress, the customer must
    // continue from where the previous staff left off.
    const session = await _fetchSplitSession(order.id)
    if (session) {
      _hydrateFromSession(session)
      _screen = 'LEG_COMPLETE'
      show()
      render()
      return
    }

    if (_openMode === 'cash') {
      // Skip BILL_REVIEW — go straight to cash denomination picker
      _paymentType = 'cash'
      _screen = 'CASH_CONFIRM'
      show()
      render()
    } else if (_openMode === 'counter') {
      // Skip BILL_REVIEW — go straight to counter device flow
      _paymentType = 'card'
      _screen = 'COUNTER_WAITING'
      show()
      render()
    } else if (_openMode === 'phone') {
      // Skip BILL_REVIEW — go straight to phone tokenize (tip pre-set via opts)
      _paymentType = 'card'
      _tipCents    = opts?.tipCents ?? 0
      _screen      = 'PHONE_TOKENIZE'
      show()
      render()
    } else {
      _screen = 'BILL_REVIEW'
      show()
      render()
      // Fetch available terminals in background (non-blocking)
      _fetchTerminals()
    }
  }

  /** Fetches terminal devices for per-terminal pay buttons. */
  async function _fetchTerminals() {
    try {
      const res = await window.api(`/api/merchants/${window.merchantId}/terminals/devices`)
      if (!res.ok) return
      const data = await res.json()
      _availableTerminals = (data.terminals ?? []).filter(t => t.finixDeviceId)
      // Re-render if still on BILL_REVIEW to show terminal buttons
      if (_screen === 'BILL_REVIEW') render()
    } catch {
      _availableTerminals = []
    }
  }

  // Wire up close button once on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    _ensureOverlay()
    const closeBtn = _overlay?.querySelector('.pm-close-btn')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        // Already showing exit-related screens — do nothing to avoid re-entrancy.
        if (_screen === 'PIN_EXIT' || _screen === 'EXIT_CONFIRM_SPLIT') return

        // Phase 4: if a split is in progress (≥1 leg already paid),
        // route through EXIT_CONFIRM_SPLIT so staff explicitly chooses to pause.
        if (_splitMode && _splitLegBases.length > 0) {
          _prevScreen = _screen
          _screen     = 'EXIT_CONFIRM_SPLIT'
          render()
          return
        }

        // All other screens: require staff PIN before closing.
        // This ensures staff can always escape a stuck or locked payment modal.
        _pinAction = 'close_modal'
        _pinBuffer = ''
        _screen = 'PIN_EXIT'
        render()
      })
    }
  })

  /**
   * Called by dashboard.js SSE handler when the server broadcasts
   * counter_payment_result. Resolves the COUNTER_WAITING screen immediately
   * without waiting for the next 2 s poll tick.
   * @param {{ orderId: string, status: string, message?: string, paymentId?: string }} data
   */
  function notifyCounterResult(data) {
    if (_screen !== 'COUNTER_WAITING') return
    if (!data || !data.orderId || data.orderId !== _order?.id) return
    if (!data.status || data.status === 'waiting') return

    _stopCounterPoll()

    if (data.status === 'approved') {
      _screen = 'PIN_EXIT'
      render()
    } else if (data.status === 'cancelled') {
      _counterStatus = 'cancelled'
      _counterError = data.message || 'Transaction cancelled at counter'
      render()
    } else {
      // declined | error
      _counterStatus = data.status
      _counterError = data.message ||
        (data.status === 'declined' ? 'Payment was declined' : 'Payment error')
      render()
    }
  }

  window.PaymentModal = { open, notifyCounterResult }
})()
