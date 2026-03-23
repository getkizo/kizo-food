/**
 * Gift Card Store — client-side application
 * @version 2
 *
 * States: LOADING → SELECTING → CHECKOUT → PAYING → CONFIRMED | ERROR
 *
 * Pay-return flow:
 *   Converge: /gift-cards/pay-return?purchase=ID&ssl_result=0&ssl_txn_id=...
 *   Finix:    /gift-cards/pay-return?purchase=ID&provider=finix&transfer_id=...
 */
;(function () {
  'use strict'

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** @param {string} s */
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** @param {number} cents */
  function formatCents(cents) {
    return '$' + (cents / 100).toFixed(2).replace(/\.00$/, '')
  }

  /** Show one step, hide all others */
  function showOnly(id) {
    const STEPS = [
      'gc-loading',
      'gc-unavailable',
      'gc-step-select',
      'gc-step-checkout',
      'gc-step-paying',
      'gc-step-thankyou',
      'gc-step-confirmed',
      'gc-step-error',
    ]
    for (const s of STEPS) {
      const el = document.getElementById(s)
      if (el) el.hidden = s !== id
    }
  }

  // ── Model ─────────────────────────────────────────────────────────────────

  const VALID_DENOMS = [2500, 5000, 7500, 10000, 15000]
  const MAX_TOTAL_CENTS = 200000 // $2,000
  let _nextCartId = 1

  const model = {
    /** @type {{ id: number, denominationCents: number, qty: number }[]} */
    cart: [],
    selectedCents: 5000,
    qty: 1,
    purchaseId: /** @type {string|null} */ (null),
    /** @type {{ id: string, code: string, faceValueCents: number, expiresAt: string }[]} */
    confirmedCards: [],
    confirmedEmail: '',
    /** @type {string|null} */
    paymentProvider: null,
  }

  // ── Cart helpers ──────────────────────────────────────────────────────────

  function cartTotal() {
    return model.cart.reduce((sum, item) => sum + item.denominationCents * item.qty, 0)
  }

  function addToCart(denominationCents, qty) {
    model.cart.push({ id: _nextCartId++, denominationCents, qty })
  }

  /** @param {number} cartId */
  function removeFromCart(cartId) {
    model.cart = model.cart.filter(item => item.id !== cartId)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function renderDenomButtons() {
    document.querySelectorAll('.gc-denom-btn').forEach(btn => {
      const cents = parseInt(btn.dataset.cents, 10)
      btn.classList.toggle('gc-denom-btn--active', cents === model.selectedCents)
    })
  }

  function renderQty() {
    const el = document.getElementById('gc-qty-val')
    if (el) el.textContent = model.qty
    const dec = document.getElementById('gc-qty-dec')
    if (dec) dec.disabled = model.qty <= 1
  }

  function renderCart() {
    const list = document.getElementById('gc-cart-list')
    const section = document.getElementById('gc-cart-section')
    const cta = document.getElementById('gc-checkout-cta')
    const totalEl = document.getElementById('gc-cart-total')
    if (!list) return

    list.innerHTML = ''

    if (model.cart.length === 0) {
      list.innerHTML = '<li class="gc-cart-empty">No items yet.</li>'
      if (section) section.hidden = true
      if (cta) cta.hidden = true
      return
    }

    for (const item of model.cart) {
      const li = document.createElement('li')
      li.className = 'gc-cart-item'
      const lineTotal = item.denominationCents * item.qty
      li.innerHTML = `
        <div class="gc-cart-item-left">
          <span class="gc-cart-item-label">${escHtml(formatCents(item.denominationCents))} Gift Card</span>
          <span class="gc-cart-item-sub">Qty: ${escHtml(String(item.qty))}</span>
        </div>
        <div class="gc-cart-item-right">
          <span class="gc-cart-item-total">${escHtml(formatCents(lineTotal))}</span>
          <button type="button" class="gc-cart-remove-btn" aria-label="Remove" data-cart-id="${item.id}">✕</button>
        </div>
      `
      list.appendChild(li)
    }

    if (totalEl) totalEl.textContent = formatCents(cartTotal())
    if (section) section.hidden = false
    if (cta) cta.hidden = false
  }

  function renderSummaryBox() {
    const box = document.getElementById('gc-summary-box')
    if (!box) return
    let html = ''
    for (const item of model.cart) {
      const lineTotal = item.denominationCents * item.qty
      html += `<div class="gc-summary-row">
        <span class="gc-summary-label">${escHtml(formatCents(item.denominationCents))} Gift Card × ${escHtml(String(item.qty))}</span>
        <span class="gc-summary-value">${escHtml(formatCents(lineTotal))}</span>
      </div>`
    }
    html += `<div class="gc-summary-row gc-summary-total">
      <span class="gc-summary-label">Total</span>
      <span class="gc-summary-value">${escHtml(formatCents(cartTotal()))}</span>
    </div>`
    box.innerHTML = html
  }

  function renderConfirmedCards() {
    const el = document.getElementById('gc-confirmed-cards')
    if (!el) return
    el.innerHTML = ''
    for (const card of model.confirmedCards) {
      const row = document.createElement('div')
      row.className = 'gc-confirmed-card'
      const exp = new Date(card.expiresAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      row.innerHTML = `
        <span class="gc-confirmed-code">${escHtml(card.code)}</span>
        <div style="text-align:right">
          <div class="gc-confirmed-amount">${escHtml(formatCents(card.faceValueCents))}</div>
          <div style="font-size:.75rem;color:var(--color-muted)">Expires ${escHtml(exp)}</div>
        </div>
      `
      el.appendChild(row)
    }

    const sub = document.getElementById('gc-confirmed-sub')
    if (sub) {
      const n = model.confirmedCards.length
      sub.textContent =
        `${n} gift card${n !== 1 ? 's' : ''} sent to ${model.confirmedEmail}`
    }
  }

  // ── Boot & profile ────────────────────────────────────────────────────────

  async function boot() {
    // Handle Converge / Finix pay-return redirect
    if (window.location.pathname === '/gift-cards/pay-return') {
      await handlePayReturn()
      return
    }

    try {
      const res = await fetch('/api/store/profile')
      if (res.ok) {
        const data = await res.json()
        const profile = data.profile || data

        // Splash
        const splashName = document.getElementById('gc-splash-name')
        if (splashName && profile.name) splashName.textContent = profile.name
        if (profile.bannerUrl) {
          const splashImg = document.getElementById('gc-splash-img')
          if (splashImg) { splashImg.src = profile.bannerUrl; splashImg.hidden = false }
        }

        // Small delay to show branded splash
        await new Promise(r => setTimeout(r, 600))

        // Store header
        const storeName = document.getElementById('gc-store-name')
        if (storeName && profile.name) storeName.textContent = profile.name

        if (profile.bannerUrl) {
          const bannerImg = document.getElementById('gc-banner-img')
          if (bannerImg) { bannerImg.src = profile.bannerUrl; bannerImg.hidden = false }
        }
        if (profile.logoUrl) {
          const logoImg = document.getElementById('gc-logo-img')
          if (logoImg) { logoImg.src = profile.logoUrl; logoImg.hidden = false }
        }

        // Payment provider label
        if (profile.paymentProvider) {
          model.paymentProvider = profile.paymentProvider
          const secureNote = document.querySelector('.gc-secure-note')
          if (secureNote) {
            const label = profile.paymentProvider === 'finix' ? 'Finix' : 'Converge'
            secureNote.textContent = `🔒 Secured by ${label}`
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 400))
      }
    } catch (err) {
      console.warn('[gc-app] profile fetch failed:', err)
      await new Promise(r => setTimeout(r, 400))
    }

    renderDenomButtons()
    renderQty()
    renderCart()
    showOnly('gc-step-select')
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  // Denomination buttons
  document.getElementById('gc-denom-grid')?.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('.gc-denom-btn')
    if (!btn) return
    model.selectedCents = parseInt(btn.dataset.cents, 10)
    renderDenomButtons()
  })

  // Qty controls
  document.getElementById('gc-qty-dec')?.addEventListener('click', () => {
    if (model.qty > 1) { model.qty--; renderQty() }
  })
  document.getElementById('gc-qty-inc')?.addEventListener('click', () => {
    model.qty++
    renderQty()
  })

  // Add to cart
  document.getElementById('gc-add-btn')?.addEventListener('click', () => {
    const newTotal = cartTotal() + model.selectedCents * model.qty
    if (newTotal > MAX_TOTAL_CENTS) {
      alert(`Maximum cart total is ${formatCents(MAX_TOTAL_CENTS)}.`)
      return
    }
    addToCart(model.selectedCents, model.qty)
    model.qty = 1
    renderQty()
    renderCart()
  })

  // Remove from cart (delegated)
  document.getElementById('gc-cart-list')?.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('.gc-cart-remove-btn')
    if (!btn) return
    const cartId = parseInt(btn.dataset.cartId, 10)
    removeFromCart(cartId)
    renderCart()
  })

  // Continue to checkout
  document.getElementById('gc-to-checkout-btn')?.addEventListener('click', () => {
    if (model.cart.length === 0) return
    renderSummaryBox()
    showOnly('gc-step-checkout')
  })

  // Back
  document.getElementById('gc-back-btn')?.addEventListener('click', () => {
    showOnly('gc-step-select')
  })

  // Purchase
  document.getElementById('gc-purchase-btn')?.addEventListener('click', handlePurchase)

  // Retry
  document.getElementById('gc-retry-btn')?.addEventListener('click', () => {
    model.purchaseId = null
    showOnly('gc-step-select')
  })

  // Buy another
  document.getElementById('gc-buy-another-btn')?.addEventListener('click', () => {
    model.cart = []
    model.selectedCents = 5000
    model.qty = 1
    model.purchaseId = null
    model.confirmedCards = []
    model.confirmedEmail = ''
    renderDenomButtons()
    renderQty()
    renderCart()
    showOnly('gc-step-select')
  })

  // ── Purchase flow ─────────────────────────────────────────────────────────

  async function handlePurchase() {
    const nameEl = /** @type {HTMLInputElement} */ (document.getElementById('gc-name'))
    const emailEl = /** @type {HTMLInputElement} */ (document.getElementById('gc-email'))
    const recipientNameEl = /** @type {HTMLInputElement} */ (document.getElementById('gc-recipient-name'))
    const btn = document.getElementById('gc-purchase-btn')

    const name = nameEl?.value.trim() ?? ''
    const email = emailEl?.value.trim() ?? ''
    const recipientName = recipientNameEl?.value.trim() ?? ''

    _hideCheckoutErr()

    if (!name) { nameEl?.focus(); _showCheckoutErr('Please enter your name.'); return }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailEl?.focus(); _showCheckoutErr('Please enter a valid email address.'); return
    }
    if (model.cart.length === 0) { _showCheckoutErr('Your cart is empty.'); return }

    btn.disabled = true
    btn.textContent = 'Processing…'

    try {
      // 1 — Create purchase record
      const purchaseRes = await fetch('/api/store/gift-cards/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: name,
          customerEmail: email,
          recipientName: recipientName || undefined,
          lineItems: model.cart.map(({ denominationCents, qty }) => ({ denominationCents, qty })),
        }),
      })
      if (!purchaseRes.ok) {
        const body = await purchaseRes.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${purchaseRes.status}`)
      }
      const { purchaseId } = await purchaseRes.json()
      model.purchaseId = purchaseId
      model.confirmedEmail = email

      // 2 — Initiate payment (get redirect URL)
      const payRes = await fetch(`/api/store/gift-cards/purchases/${purchaseId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnUrl: `/gift-cards/pay-return?purchase=${purchaseId}`,
        }),
      })
      if (!payRes.ok) {
        const body = await payRes.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${payRes.status}`)
      }
      const payData = await payRes.json()

      const redirectUrl = payData.paymentUrl || payData.hostedUrl
      if (!redirectUrl) throw new Error('No payment URL returned from server.')

      showOnly('gc-step-paying')
      window.location.href = redirectUrl

    } catch (err) {
      console.error('[gc-app] purchase error:', err)
      _showCheckoutErr(err.message || 'Something went wrong. Please try again.')
      btn.disabled = false
      btn.textContent = 'Purchase Gift Card'
    }
  }

  function _showCheckoutErr(msg) {
    const el = document.getElementById('gc-checkout-err')
    if (el) { el.textContent = msg; el.hidden = false }
  }
  function _hideCheckoutErr() {
    const el = document.getElementById('gc-checkout-err')
    if (el) el.hidden = true
  }

  // ── Pay-return handler ────────────────────────────────────────────────────

  async function handlePayReturn() {
    showOnly('gc-step-paying')
    const payingText = document.getElementById('gc-paying-text')
    if (payingText) payingText.textContent = 'Confirming your payment…'

    const params = new URLSearchParams(window.location.search)
    const purchaseId = params.get('purchase')

    if (!purchaseId) {
      _showStep5Error('Payment Not Completed', 'Missing purchase reference. Please contact the restaurant.')
      return
    }

    model.purchaseId = purchaseId

    // Forward all query params (except purchase) to the payment-result endpoint
    const body = {}
    for (const [key, value] of params.entries()) {
      if (key !== 'purchase') body[key] = value
    }

    // Fetch store profile for the back-link label (best-effort)
    let storeName = 'the store'
    try {
      const pr = await fetch('/api/store/profile')
      if (pr.ok) {
        const pd = await pr.json()
        storeName = (pd.profile || pd).name || storeName
      }
    } catch { /* non-fatal */ }

    try {
      const res = await fetch(`/api/store/gift-cards/purchases/${purchaseId}/payment-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok || data.status !== 'paid') {
        throw new Error(data.error || 'Payment could not be confirmed.')
      }

      // Populate thank-you screen
      const subEl = document.getElementById('gc-thankyou-sub')
      if (subEl) {
        subEl.textContent = data.customerEmail
          ? `Your gift cards have been sent to ${data.customerEmail}. Check your inbox!`
          : 'Your gift cards have been sent to your email inbox.'
      }
      const storeNameEl = document.getElementById('gc-thankyou-store-name')
      if (storeNameEl) storeNameEl.textContent = storeName

      showOnly('gc-step-thankyou')

    } catch (err) {
      console.error('[gc-app] payment-result error:', err)
      _showStep5Error('Payment Not Completed', err.message || 'Something went wrong. Please contact the restaurant.')
    }
  }

  function _showStep5Error(title, body) {
    const t = document.getElementById('gc-err-title')
    const b = document.getElementById('gc-err-body')
    if (t) t.textContent = title
    if (b) b.textContent = body
    showOnly('gc-step-error')
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  boot().catch(err => {
    console.error('[gc-app] boot failed:', err)
    _showStep5Error('Unable to Load', 'Please refresh the page and try again.')
  })
})()
