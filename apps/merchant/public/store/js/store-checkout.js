/**
 * store-checkout.js — Checkout panel: order summary + customer info form
 *
 * Exposes: window.StoreCheckout = { render }
 */

;(function () {
  'use strict'

  function formatCents(cents) {
    return '$' + (cents / 100).toFixed(2)
  }

  function escHtml(str) {
    if (!str) return ''
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  let wired = false
  let tipsBuilt = false    // tip buttons built once per profile load
  let timeSlotBuilt = false // time slot select built once per profile load

  function render(model) {
    renderSummary(model)
    renderError(model)
    renderNoteSheet(model)

    if (!wired) {
      wired = true
      wireButtons()
      prefillFromStorage()

      // Show privacy policy on first visit
      const PRIVACY_KEY = 'kizo_privacy_seen'
      if (!localStorage.getItem(PRIVACY_KEY)) {
        const panel = document.getElementById('privacy-overlay')
        if (panel) panel.hidden = false
        localStorage.setItem(PRIVACY_KEY, '1')
      }
    }

    // Keep summaries fresh inside any already-collapsed sections
    document.querySelectorAll('.checkout-section.is-collapsed').forEach(_updateSectionSummary)

    // Rebuild tip selector whenever profile changes (tipOptions may differ)
    if (model.profile && !tipsBuilt) {
      tipsBuilt = true
      buildTipSelector(model.profile)
    } else if (window._refreshStoreTipLabels) {
      // Cart may have changed — refresh percentage → dollar amounts
      window._refreshStoreTipLabels()
    }

    // Build pickup time selector once per profile load
    if (model.profile && !timeSlotBuilt) {
      timeSlotBuilt = true
      buildTimeSlots(model.profile)
    }
  }

  // ---------------------------------------------------------------------------
  // Order summary
  // ---------------------------------------------------------------------------

  function renderSummary(model) {
    const listEl     = document.getElementById('checkout-items-list')
    const subtotalEl = document.getElementById('checkout-subtotal')
    const taxEl      = document.getElementById('checkout-tax')
    const tipRowEl   = document.getElementById('checkout-tip-row')
    const tipEl      = document.getElementById('checkout-tip')
    const totalEl    = document.getElementById('checkout-total')
    const payTotalEl = document.getElementById('checkout-pay-total')

    if (listEl) {
      listEl.innerHTML = model.cart.map((entry, idx) => {
        const modNames = entry.selectedModifiers.map((m) => m.name).join(', ')
        const qty = entry.qty || 1
        const nameTag = entry.itemName
          ? `<p class="checkout-item-dish-name">${escHtml(entry.itemName)}</p>`
          : ''
        const noteTag = entry.kitchenNote
          ? `<p class="checkout-item-kitchen-note">${escHtml(entry.kitchenNote)}</p>`
          : ''
        return `
          <li class="checkout-item">
            <div class="checkout-item-info checkout-item-edit" data-edit-idx="${idx}" role="button" tabindex="0" aria-label="Edit ${escHtml(entry.item.name)}">
              <p class="checkout-item-name">${escHtml(entry.item.name)}</p>
              ${modNames ? `<p class="checkout-item-mods">${escHtml(modNames)}</p>` : ''}
              ${nameTag}${noteTag}
            </div>
            <div class="checkout-item-right">
              <div class="checkout-item-qty" role="group" aria-label="Quantity">
                <button class="checkout-item-qty-btn checkout-item-qty-dec" data-idx="${idx}" data-qty="${qty}" type="button" aria-label="Decrease quantity">−</button>
                <span class="checkout-item-qty-num" aria-live="polite">${qty}</span>
                <button class="checkout-item-qty-btn checkout-item-qty-inc" data-idx="${idx}" data-qty="${qty}" type="button" aria-label="Increase quantity">+</button>
              </div>
              <span class="checkout-item-price">${formatCents(entry.totalCents)}</span>
              <button class="checkout-item-del" data-idx="${idx}" type="button" aria-label="Remove item">&times;</button>
            </div>
          </li>
        `
      }).join('')
    }

    const tipCents = model.tipCents || 0
    if (subtotalEl) subtotalEl.textContent = formatCents(model.cartSubtotalCents)
    if (taxEl)      taxEl.textContent      = formatCents(model.cartTaxCents)
    if (tipRowEl)   tipRowEl.hidden        = tipCents === 0
    if (tipEl)      tipEl.textContent      = formatCents(tipCents)
    if (totalEl)    totalEl.textContent    = formatCents(model.cartTotalCents)
    if (payTotalEl) payTotalEl.textContent = formatCents(model.cartTotalCents)

    // Update payment provider label
    const providerLabel = document.getElementById('payment-provider-label')
    if (providerLabel) {
      const provider = model.profile?.paymentProvider
      const names = { converge: 'Elavon Converge', finix: 'Finix', stax: 'Stax' }
      providerLabel.textContent = provider && names[provider]
        ? `Secure payment via ${names[provider]}`
        : 'Secure payment'
    }
  }

  // ---------------------------------------------------------------------------
  // Error display
  // ---------------------------------------------------------------------------

  function renderError(model) {
    const errEl = document.getElementById('checkout-error')
    if (!errEl) return
    if (model.errorMessage) {
      errEl.textContent = model.errorMessage
      errEl.hidden      = false
    } else {
      errEl.hidden = true
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-fill form from localStorage
  // ---------------------------------------------------------------------------

  function prefillFromStorage() {
    try {
      const saved = JSON.parse(localStorage.getItem('kizo_customer') || 'null')
      if (!saved) return
      // Honour the TTL — remove and skip if expired (protects shared/kiosk devices)
      if (saved.expiresAt && Date.now() > saved.expiresAt) {
        localStorage.removeItem('kizo_customer')
        return
      }
      const nameEl  = document.getElementById('field-name')
      const phoneEl = document.getElementById('field-phone')
      const emailEl = document.getElementById('field-email')
      if (nameEl  && saved.name)  nameEl.value  = saved.name
      if (phoneEl && saved.phone) phoneEl.value = saved.phone
      if (emailEl && saved.email) emailEl.value = saved.email
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Tip selector
  // ---------------------------------------------------------------------------

  /**
   * Build the tip button strip from profile.tipOptions.
   * Online orders get a -5% discount on each tier (15→10, 20→15, 25→20).
   * @param {{ tipOptions: number[] }} profile
   */
  function buildTipSelector(profile) {
    const container  = document.getElementById('checkout-tip-btns')
    const customArea = document.getElementById('checkout-tip-custom')
    const tipInput   = document.getElementById('checkout-tip-input')
    if (!container) return

    const baseTips = profile.tipOptions ?? [15, 20, 25]
    // Apply -5% for online orders (minimum 0%)
    const onlineTips = baseTips.map((p) => Math.max(0, p - 5)).filter((p, i, a) => a.indexOf(p) === i)

    let selected = null   // tracks the currently active button

    const activate = (btn) => {
      container.querySelectorAll('.store-tip-btn').forEach((b) => b.classList.remove('active'))
      if (btn) btn.classList.add('active')
      selected = btn
    }

    const setTip = (cents) => {
      window.Store.actions.setTip(cents)
    }

    // "No tip" button
    const noTipBtn = document.createElement('button')
    noTipBtn.type = 'button'
    noTipBtn.className = 'store-tip-btn active'
    noTipBtn.textContent = 'No tip'
    noTipBtn.addEventListener('click', () => {
      if (customArea) customArea.hidden = true
      activate(noTipBtn)
      setTip(0)
    })
    container.innerHTML = ''
    container.appendChild(noTipBtn)
    activate(noTipBtn)

    // Percentage buttons
    onlineTips.forEach((pct) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'store-tip-btn'
      btn.dataset.pct = pct
      btn.addEventListener('click', () => {
        if (customArea) customArea.hidden = true
        activate(btn)
        // Compute tip on post-tax total (same as dashboard modal)
        const model = window.Store.getModel()
        const base  = model ? (model.cartSubtotalCents + model.cartTaxCents) : 0
        const cents = Math.round(base * pct / 100)
        btn.dataset.amt = cents
        setTip(cents)
      })
      container.appendChild(btn)
    })

    // "Custom" button
    const customBtn = document.createElement('button')
    customBtn.type = 'button'
    customBtn.className = 'store-tip-btn'
    customBtn.textContent = 'Custom'
    customBtn.addEventListener('click', () => {
      activate(customBtn)
      if (customArea) customArea.hidden = false
      if (tipInput) tipInput.focus()
    })
    container.appendChild(customBtn)

    // Custom input
    if (tipInput) {
      tipInput.oninput = () => {
        const raw   = parseFloat(tipInput.value || '0')
        const cents = (!isNaN(raw) && raw >= 0) ? Math.round(raw * 100) : 0
        setTip(cents)
      }
    }

    // Refresh % labels + amounts after cart changes are reflected in the model
    // Called after render so tipBase is up-to-date
    function refreshPctLabels() {
      const model = window.Store.getModel()
      if (!model) return
      const base = model.cartSubtotalCents + model.cartTaxCents
      container.querySelectorAll('.store-tip-btn[data-pct]').forEach((btn) => {
        const pct   = parseInt(btn.dataset.pct, 10)
        const amt   = Math.round(base * pct / 100)
        btn.dataset.amt = amt
        btn.textContent = formatCents(amt)
        // Re-apply tip only if this button is active AND the amount changed
        // (prevents infinite loop: render → refreshPctLabels → setTip → render)
        if (btn.classList.contains('active') && model.tipCents !== amt) setTip(amt)
      })
    }
    // Run now and expose for re-render
    refreshPctLabels()
    window._refreshStoreTipLabels = refreshPctLabels
  }

  // ---------------------------------------------------------------------------
  // Section accordion
  // ---------------------------------------------------------------------------

  /**
   * Compute and write the one-line summary for a collapsed section.
   * @param {Element} section
   */
  function _updateSectionSummary(section) {
    const summaryEl = section.querySelector('.section-summary')
    if (!summaryEl) return
    const title = (section.querySelector('.section-title') || {}).textContent?.trim()

    if (title === 'Order Summary') {
      const m = window.Store?.getModel()
      if (m) {
        const n = m.cart.length
        summaryEl.textContent = n + ' item' + (n !== 1 ? 's' : '') + ' · ' + formatCents(m.cartTotalCents)
      }
    } else if (title === 'Your Details') {
      const name  = (document.getElementById('field-name')?.value  || '').trim()
      const phone = (document.getElementById('field-phone')?.value || '').trim()
      summaryEl.textContent = [name, phone].filter(Boolean).join(' · ')
    } else if (title?.startsWith('When would you like') || title?.startsWith('Choose a pickup')) {
      const sel = document.getElementById('checkout-time-select')
      summaryEl.textContent = sel?.options[sel.selectedIndex]?.text || ''
    }
  }

  // ---------------------------------------------------------------------------
  // Item note sheet
  // ---------------------------------------------------------------------------

  /**
   * Show/hide the item name + kitchen note editor based on model.editingNoteIdx.
   * Populates the inputs with the current values when opening.
   * @param {object} model
   */
  function renderNoteSheet(model) {
    const sheet    = document.getElementById('item-note-sheet')
    const backdrop = document.getElementById('item-note-backdrop')
    if (!sheet || !backdrop) return

    const idx = model.editingNoteIdx
    const open = idx !== null && idx >= 0 && idx < (model.cart?.length ?? 0)

    sheet.hidden    = !open
    backdrop.hidden = !open
    sheet.setAttribute('aria-hidden', String(!open))

    if (!open) return

    const entry = model.cart[idx]
    const label = document.getElementById('item-note-dish-label')
    const nameInput = document.getElementById('item-note-name-input')
    const noteInput = document.getElementById('item-note-kitchen-input')

    if (label)     label.textContent  = entry.item.name
    if (nameInput) nameInput.value    = entry.itemName    || ''
    if (noteInput) noteInput.value    = entry.kitchenNote || ''

    // Focus the name input when sheet opens (unless values already exist — then note)
    if (nameInput && !entry.itemName && !entry.kitchenNote) nameInput.focus()
    else if (noteInput) noteInput.focus()
  }

  // ---------------------------------------------------------------------------
  // Wire buttons (called once)
  // ---------------------------------------------------------------------------

  /** Wire note sheet once; the sheet itself re-renders on every model update. */
  let noteSheetWired = false

  function wireNoteSheet() {
    if (noteSheetWired) return
    noteSheetWired = true

    const backdrop    = document.getElementById('item-note-backdrop')
    const modBtn      = document.getElementById('item-note-modifier-btn')
    const doneBtn     = document.getElementById('item-note-done-btn')

    const closeSheet = () => {
      const nameInput = document.getElementById('item-note-name-input')
      const noteInput = document.getElementById('item-note-kitchen-input')
      window.Store.actions.saveItemNote({
        itemName:    nameInput?.value ?? '',
        kitchenNote: noteInput?.value ?? '',
      })
    }

    if (backdrop) backdrop.addEventListener('click', closeSheet)
    if (doneBtn)  doneBtn.addEventListener('click',  closeSheet)

    if (modBtn) {
      modBtn.addEventListener('click', () => {
        // Save note first, then open modifier sheet for same entry
        const nameInput = document.getElementById('item-note-name-input')
        const noteInput = document.getElementById('item-note-kitchen-input')
        const model = window.Store.getModel()
        const idx   = model?.editingNoteIdx
        window.Store.actions.saveItemNote({
          itemName:    nameInput?.value ?? '',
          kitchenNote: noteInput?.value ?? '',
        })
        // editingNoteIdx is now null; open the modifier sheet
        if (idx !== null && idx >= 0) {
          window.Store.actions.editCartItem(idx)
        }
      })
    }
  }

  function wireButtons() {
    wireNoteSheet()

    const backBtn  = document.getElementById('checkout-back-btn')
    const payBtn   = document.getElementById('checkout-pay-btn')
    const clearBtn = document.getElementById('checkout-clear-btn')

    // Section accordion — toggle collapse on header tap
    document.querySelectorAll('.section-header').forEach((header) => {
      const toggle = () => {
        const section = header.closest('.checkout-section')
        if (!section) return
        const collapsing = !section.classList.contains('is-collapsed')
        section.classList.toggle('is-collapsed', collapsing)
        header.setAttribute('aria-expanded', collapsing ? 'false' : 'true')
        if (collapsing) _updateSectionSummary(section)
      }
      header.addEventListener('click', toggle)
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
      })
    })

    if (backBtn) {
      backBtn.addEventListener('click', () => window.Store.actions.backToBrowsing())
    }

    // Delete individual items via event delegation (list is re-rendered on every update)
    const listEl = document.getElementById('checkout-items-list')
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        // Decrease quantity (remove when reaching 0)
        const decBtn = e.target.closest('.checkout-item-qty-dec')
        if (decBtn) {
          const idx = parseInt(decBtn.dataset.idx, 10)
          const current = parseInt(decBtn.dataset.qty, 10) || 1
          window.Store.actions.updateCartQty(idx, current - 1)
          return
        }
        // Increase quantity
        const incBtn = e.target.closest('.checkout-item-qty-inc')
        if (incBtn) {
          const idx = parseInt(incBtn.dataset.idx, 10)
          const current = parseInt(incBtn.dataset.qty, 10) || 1
          window.Store.actions.updateCartQty(idx, current + 1)
          return
        }
        // Delete button
        const delBtn = e.target.closest('.checkout-item-del')
        if (delBtn) {
          const idx = parseInt(delBtn.dataset.idx, 10)
          window.Store.actions.removeFromCart(idx)
          return
        }
        // Edit item — tap on name/mods area opens name + note editor
        const editEl = e.target.closest('.checkout-item-edit')
        if (editEl) {
          const idx = parseInt(editEl.dataset.editIdx, 10)
          window.Store.actions.openItemNoteEditor(idx)
        }
      })
    }

    // Clear entire order
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (!confirm('Clear your order and start over?')) return
        window.Store.actions.clearCart()
      })
    }

    // Privacy overlay toggle
    const privacyLink  = document.getElementById('checkout-show-privacy')
    const privacyPanel = document.getElementById('privacy-overlay')
    const privacyClose = document.getElementById('privacy-close-btn')
    if (privacyLink && privacyPanel) {
      privacyLink.addEventListener('click', (e) => {
        e.preventDefault()
        privacyPanel.hidden = false
      })
      if (privacyClose) {
        privacyClose.addEventListener('click', () => { privacyPanel.hidden = true })
      }
    }

    if (payBtn) {
      payBtn.addEventListener('click', () => {
        const name     = document.getElementById('field-name')?.value.trim()
        const phone    = document.getElementById('field-phone')?.value.trim()
        const email    = document.getElementById('field-email')?.value.trim()
        const note     = document.getElementById('field-note')?.value.trim()
        const utensils = document.getElementById('field-utensils')?.checked || false

        /** Show an inline validation error on a field and announce it via #checkout-error. */
        const showFieldError = (el, message) => {
          const errEl = document.getElementById('checkout-error')
          if (el) {
            el.setAttribute('aria-invalid', 'true')
            el.style.borderColor = 'var(--color-error)'
            el.focus()
            // Clear visual + aria state after 4 s (doubled from 2 s for screen-mag users)
            setTimeout(() => {
              el.style.borderColor = ''
              el.removeAttribute('aria-invalid')
              if (errEl) { errEl.hidden = true; errEl.textContent = '' }
            }, 4000)
          }
          if (errEl) { errEl.textContent = message; errEl.hidden = false }
        }

        if (!name) {
          showFieldError(document.getElementById('field-name'), 'Please enter your name.')
          return
        }

        const timeSelect   = document.getElementById('checkout-time-select')
        const scheduledFor = timeSelect?.value || null

        // When the store is closed a scheduled time is required (no ASAP)
        const profile     = window.Store?.getModel()?.profile
        const storeStatus = window.StoreMenu?.getStoreOpenStatus(profile)
        if (storeStatus && !storeStatus.isOpen && !scheduledFor) {
          showFieldError(timeSelect, 'Please select a pickup time.')
          return
        }

        window.Store.actions.setScheduledFor(scheduledFor)
        window.Store.actions.submitOrder({ name, phone, email, note, utensils })
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Pickup time selector
  // ---------------------------------------------------------------------------

  /**
   * Build 30-minute pickup time slots filtered to the merchant's business hours.
   *
   * When the store is OPEN: shows "ASAP" + slots within the next 4 hours today.
   * When the store is CLOSED: omits "ASAP", finds the next opening (possibly
   * tomorrow or later this week) and shows slots from that opening onward.
   * In both cases the section is always shown so the customer can schedule.
   *
   * @param {{ businessHours?: Array, prepTimeMinutes?: number, timezone?: string }} profile
   */
  function buildTimeSlots(profile) {
    const section  = document.getElementById('checkout-time-section')
    const select   = document.getElementById('checkout-time-select')
    const label    = section?.querySelector('.section-title')
    if (!section || !select) return

    const storeStatus = window.StoreMenu?.getStoreOpenStatus(profile) ?? { isOpen: true }
    const isOpen      = storeStatus.isOpen

    const ms30     = 30 * 60_000
    const now      = new Date()
    const prepMins = profile.prepTimeMinutes ?? 20
    const slots    = []

    if (isOpen) {
      // --- Store is open: slots within today's remaining business hours, up to 4 h ---
      const earliest = new Date(now.getTime() + prepMins * 60_000)
      let cursor     = new Date(Math.ceil(earliest.getTime() / ms30) * ms30)
      const limit    = new Date(now.getTime() + 4 * 60 * 60_000)

      const todayHours = (profile.businessHours ?? []).find(
        (h) => h.dayOfWeek === now.getDay() && !h.isClosed,
      )
      let openMinutes  = 0
      let closeMinutes = 24 * 60
      if (todayHours?.openTime && todayHours?.closeTime) {
        const [oh, om] = todayHours.openTime.split(':').map(Number)
        const [ch, cm] = todayHours.closeTime.split(':').map(Number)
        openMinutes  = oh * 60 + om
        closeMinutes = ch * 60 + cm
      }

      while (cursor <= limit) {
        const slotMins = cursor.getHours() * 60 + cursor.getMinutes()
        if (slotMins >= openMinutes && slotMins < closeMinutes) slots.push(new Date(cursor))
        cursor = new Date(cursor.getTime() + ms30)
      }

      select.innerHTML = '<option value="">ASAP (as soon as possible)</option>'
      if (label) label.textContent = 'When would you like your order ready?'
    } else {
      // --- Store is closed: find next opening and offer slots from there ---
      // Scan up to 7 days ahead for the next open slot.
      const earliest = new Date(now.getTime() + prepMins * 60_000)

      for (let daysAhead = 0; daysAhead <= 7 && slots.length === 0; daysAhead++) {
        const targetDate = new Date(now)
        targetDate.setDate(now.getDate() + daysAhead)
        targetDate.setSeconds(0, 0)

        const targetDow  = targetDate.getDay()
        const daySlots   = (profile.businessHours ?? [])
          .filter((h) => h.dayOfWeek === targetDow && !h.isClosed)
          .sort((a, b) => a.openTime.localeCompare(b.openTime))

        for (const dayHours of daySlots) {
          const [oh, om] = dayHours.openTime.split(':').map(Number)
          const [ch, cm] = dayHours.closeTime.split(':').map(Number)

          // Build the opening moment as a real Date on targetDate
          const openDate = new Date(targetDate)
          openDate.setHours(oh, om, 0, 0)
          const closeDate = new Date(targetDate)
          closeDate.setHours(ch, cm, 0, 0)

          // First slot = max(opening time, prep-adjusted now), rounded up to 30-min
          let cursor = new Date(Math.max(openDate.getTime(), earliest.getTime()))
          cursor     = new Date(Math.ceil(cursor.getTime() / ms30) * ms30)

          while (cursor < closeDate) {
            slots.push(new Date(cursor))
            cursor = new Date(cursor.getTime() + ms30)
            // Show at most 8 slots (4 hours) from the first opening
            if (slots.length >= 8) break
          }
        }
      }

      select.innerHTML = '' // no ASAP when closed
      if (label) label.textContent = 'Choose a pickup time:'
    }

    if (slots.length === 0) {
      section.hidden = true
      return
    }

    slots.forEach((slot) => {
      const opt = document.createElement('option')
      opt.value = slot.toISOString()
      // Include day name when slot is not today
      const isToday = slot.toDateString() === now.toDateString()
      const timePart = slot.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      const dayPart  = isToday ? '' : slot.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · '
      opt.textContent = dayPart + timePart
      select.appendChild(opt)
    })

    // When closed the first slot should be pre-selected (no blank ASAP option)
    if (!isOpen && slots.length > 0) select.selectedIndex = 0

    section.hidden = false
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  window.StoreCheckout = {
    render,
  }

})()
