/**
 * store-cart.js — Cart bar + modifier bottom sheet
 *
 * Exposes: window.StoreCart = { renderBar, renderSheet, highlightMissingGroup }
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

  // ---------------------------------------------------------------------------
  // Name suggestion localStorage helpers
  // ---------------------------------------------------------------------------

  const DISH_NAMES_KEY = 'kizo_dish_names'
  const MAX_DISH_NAMES = 20

  /** @returns {string[]} */
  function loadNameSuggestions() {
    try { return JSON.parse(localStorage.getItem(DISH_NAMES_KEY) || '[]') } catch { return [] }
  }

  /** Save a name to the suggestions list (most-recent-first, deduped). */
  function saveNameSuggestion(name) {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    const existing = loadNameSuggestions().filter((n) => n.toLowerCase() !== trimmed.toLowerCase())
    existing.unshift(trimmed)
    try { localStorage.setItem(DISH_NAMES_KEY, JSON.stringify(existing.slice(0, MAX_DISH_NAMES))) } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Cart bar (persistent bottom CTA)
  // ---------------------------------------------------------------------------

  function renderBar(model) {
    const bar   = document.getElementById('cart-bar')
    const count = document.getElementById('cart-bar-count')
    const label = document.getElementById('cart-bar-label')
    const total = document.getElementById('cart-bar-total')
    const btn   = document.getElementById('cart-bar-btn')

    if (!bar) return

    if (model.cartCount === 0 || model.appState === 'CHECKOUT') {
      bar.hidden = true
      return
    }

    bar.hidden = false
    if (count) count.textContent = model.cartCount
    if (total) total.textContent = formatCents(model.cartTotalCents)
    if (btn && !btn._wired) {
      btn._wired = true
      btn.addEventListener('click', () => window.Store.actions.openCheckout())
    }
  }

  // ---------------------------------------------------------------------------
  // Modifier sheet (bottom sheet overlay)
  // ---------------------------------------------------------------------------

  // Track which element triggered the sheet so focus can be returned on close.
  let _sheetTrigger = null

  function renderSheet(model) {
    const backdrop = document.getElementById('modifier-sheet-backdrop')
    const sheet    = document.getElementById('modifier-sheet')
    if (!sheet || !backdrop) return

    const wasOpen = sheet.classList.contains('open')

    if (model.appState !== 'ITEM' || !model.selectedItem) {
      // Return focus to the triggering card before hiding.
      if (sheet.contains(document.activeElement)) document.activeElement.blur()
      if (_sheetTrigger) { _sheetTrigger.focus(); _sheetTrigger = null }
      sheet.classList.remove('open')
      sheet.setAttribute('aria-hidden', 'true')
      backdrop.hidden = true
      document.body.classList.remove('sheet-open')
      return
    }

    // Capture the trigger on initial open (not on re-renders while already open)
    if (!wasOpen) _sheetTrigger = document.activeElement

    backdrop.hidden = false
    sheet.classList.add('open')
    document.body.classList.add('sheet-open')
    sheet.setAttribute('aria-hidden', 'false')

    const item = model.selectedItem

    // Image
    const imgEl = document.getElementById('sheet-item-img')
    if (imgEl) {
      if (item.imageUrl) {
        imgEl.src    = item.imageUrl
        imgEl.alt    = item.name
        imgEl.hidden = false
      } else {
        imgEl.hidden = true
      }
    }

    // Name / desc / price
    const nameEl  = document.getElementById('sheet-item-title')
    const descEl  = document.getElementById('sheet-item-desc')
    const priceEl = document.getElementById('sheet-item-price')
    if (nameEl)  nameEl.textContent  = item.name
    if (descEl)  descEl.textContent  = item.description || ''
    if (priceEl) priceEl.textContent = formatCents(item.priceCents)

    // Modifier groups
    const groupsEl = document.getElementById('sheet-modifier-groups')
    if (groupsEl) {
      // Sort: required groups first, then by keyword priority (protein → rice → spice)
      var KEYWORD_ORDER = ['protein', 'rice', 'spice']
      var sortedGroups = (item.modifierGroups || []).slice().sort((a, b) => {
        var aReq = (a.minRequired > 0 || a.isMandatory) ? 0 : 1
        var bReq = (b.minRequired > 0 || b.isMandatory) ? 0 : 1
        if (aReq !== bReq) return aReq - bReq
        var aName = a.name.toLowerCase()
        var bName = b.name.toLowerCase()
        var aIdx = KEYWORD_ORDER.findIndex(k => aName.includes(k))
        var bIdx = KEYWORD_ORDER.findIndex(k => bName.includes(k))
        if (aIdx === -1) aIdx = KEYWORD_ORDER.length
        if (bIdx === -1) bIdx = KEYWORD_ORDER.length
        return aIdx - bIdx
      })
      groupsEl.innerHTML = sortedGroups.map((group) => {
        // maxAllowed === 1 → single-select (radio); null or > 1 → multi-select (checkbox)
        const isSingle  = group.maxAllowed === 1
        const role      = isSingle ? 'radio' : 'checkbox'
        const selIds    = model.selectedModifiers[group.id] || []
        const selCount  = selIds.length

        // Build hint text under the group title
        let hint = ''
        if (!isSingle) {
          if (group.maxAllowed !== null && group.maxAllowed !== undefined) {
            const remaining = group.maxAllowed - selCount
            hint = remaining > 0
              ? `Choose up to ${group.maxAllowed} (${remaining} remaining)`
              : `${group.maxAllowed} selected`
          } else {
            hint = 'Check all that apply'
          }
        }

        return `
        <div class="modifier-group" id="mod-group-${group.id}">
          <p class="modifier-group-title">
            ${escHtml(group.name)}
            ${(group.minRequired > 0 || group.isMandatory) ? `<span class="modifier-required">Required</span>` : ''}
          </p>
          ${hint ? `<p class="modifier-group-hint">${escHtml(hint)}</p>` : ''}
          <div class="modifier-options" role="${isSingle ? 'radiogroup' : 'group'}" aria-label="${escHtml(group.name)}">
            ${group.modifiers.map((mod) => {
              const selected    = selIds.includes(mod.id)
              const unavailable = mod.stockStatus === 'out_today'
              return `
                <div class="modifier-option${selected ? ' selected' : ''}${unavailable ? ' modifier-option--unavailable' : ''}"
                     data-group="${group.id}" data-mod="${mod.id}"
                     role="${role}" aria-checked="${selected}" tabindex="${unavailable ? '-1' : '0'}"
                     aria-disabled="${unavailable}"
                     aria-label="${escHtml(mod.name)}${mod.price_cents ? ' +' + formatCents(mod.price_cents) : ''}${unavailable ? ' — unavailable today' : ''}">
                  <span class="modifier-option-name">${escHtml(mod.name)}</span>
                  ${mod.price_cents ? `<span class="modifier-option-price">+${formatCents(mod.price_cents)}</span>` : ''}
                  ${unavailable ? `<span class="modifier-option-tag">Out today</span>` : ''}
                </div>
              `
            }).join('')}
          </div>
        </div>
      `}).join('')

      // Wire modifier option clicks (skip unavailable options)
      groupsEl.querySelectorAll('.modifier-option:not(.modifier-option--unavailable)').forEach((el) => {
        el.addEventListener('click', () => {
          window.Store.actions.toggleModifier(el.dataset.group, el.dataset.mod)
        })
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            window.Store.actions.toggleModifier(el.dataset.group, el.dataset.mod)
          }
        })
      })
    }

    // Quantity controls — update display each render
    const qty = model.itemQty || 1
    const qtyDisplay = document.getElementById('sheet-qty-display')
    if (qtyDisplay) qtyDisplay.textContent = qty

    const addBtn = document.getElementById('sheet-add-btn')
    if (addBtn) {
      const isEditing = model.editingCartIdx !== null
      if (isEditing) {
        addBtn.textContent = qty > 1 ? `Update (${qty})` : 'Update'
      } else {
        addBtn.textContent = qty > 1 ? `Add ${qty} to Order` : 'Add to Order'
      }
    }

    // Pre-fill or clear name / kitchen note inputs on open
    if (!wasOpen) {
      const nameInput = document.getElementById('sheet-item-name')
      const noteInput = document.getElementById('sheet-item-kitchen-note')
      const sugList   = document.getElementById('sheet-name-suggestions')
      const editing   = model.editingCartIdx !== null ? model.cart[model.editingCartIdx] : null
      if (nameInput) nameInput.value = editing?.itemName    || ''
      if (noteInput) noteInput.value = editing?.kitchenNote || ''
      if (sugList)   sugList.hidden  = true
    }

    // Wire buttons (idempotent)
    wireSheetButtons()

    // Move focus into the sheet on initial open so keyboard users land inside it.
    // Skip on re-renders (sheet already open) to avoid stealing focus mid-interaction.
    if (!wasOpen) {
      const FOCUSABLE = 'button:not([disabled]),[tabindex]:not([tabindex="-1"])'
      const first = sheet.querySelector(FOCUSABLE)
      if (first) first.focus()
    }
  }

  let sheetButtonsWired = false
  function wireSheetButtons() {
    if (sheetButtonsWired) return
    sheetButtonsWired = true

    const cancelBtn  = document.getElementById('sheet-cancel-btn')
    const addBtn     = document.getElementById('sheet-add-btn')
    const backdrop   = document.getElementById('modifier-sheet-backdrop')
    const sheet      = document.getElementById('modifier-sheet')
    const qtyMinus   = document.getElementById('sheet-qty-minus')
    const qtyPlus    = document.getElementById('sheet-qty-plus')

    if (qtyMinus) {
      qtyMinus.addEventListener('click', () => {
        const current = window.Store.getModel().itemQty || 1
        window.Store.actions.setItemQty(current - 1)
      })
    }
    if (qtyPlus) {
      qtyPlus.addEventListener('click', () => {
        const current = window.Store.getModel().itemQty || 1
        window.Store.actions.setItemQty(current + 1)
      })
    }

    const close = () => window.Store.actions.closeItem()

    if (cancelBtn) cancelBtn.addEventListener('click', close)

    // Save name suggestion then dispatch addToCart
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('sheet-item-name')
        saveNameSuggestion(nameInput?.value)
        window.Store.actions.addToCart()
      })
    }

    // Autocomplete for the name field (wired once; suggestions drawn from localStorage)
    // The dropdown uses position:fixed + getBoundingClientRect() to escape the
    // modifier sheet's overflow-y:auto clip boundary.
    const nameInput = document.getElementById('sheet-item-name')
    const sugList   = document.getElementById('sheet-name-suggestions')
    if (nameInput && sugList) {
      const positionSugList = () => {
        const rect = nameInput.getBoundingClientRect()
        sugList.style.top   = (rect.bottom + 2) + 'px'
        sugList.style.left  = rect.left + 'px'
        sugList.style.width = rect.width + 'px'
      }

      const showSuggestions = (matches) => {
        sugList.innerHTML = matches.slice(0, 6).map((n) =>
          `<li class="sheet-name-suggestion" data-name="${escHtml(n)}">${escHtml(n)}</li>`
        ).join('')
        positionSugList()
        sugList.hidden = false
      }

      nameInput.addEventListener('input', () => {
        const q = nameInput.value.trim().toLowerCase()
        if (!q) { sugList.hidden = true; return }
        const matches = loadNameSuggestions().filter((n) => n.toLowerCase().startsWith(q))
        if (!matches.length) { sugList.hidden = true; return }
        showSuggestions(matches)
      })

      sugList.addEventListener('mousedown', (e) => {
        // mousedown fires before blur so we can fill before focus leaves
        const item = e.target.closest('.sheet-name-suggestion')
        if (item) {
          e.preventDefault()
          nameInput.value = item.dataset.name
          sugList.hidden  = true
        }
      })

      nameInput.addEventListener('blur', () => {
        // Small delay lets mousedown on a suggestion fire first
        setTimeout(() => { sugList.hidden = true }, 150)
      })

      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { sugList.hidden = true }
        if (e.key === 'Enter' && !sugList.hidden) {
          const first = sugList.querySelector('.sheet-name-suggestion')
          if (first) { nameInput.value = first.dataset.name; sugList.hidden = true; e.preventDefault() }
        }
      })

      // Hide suggestions if the sheet scrolls (input moves out from under the fixed dropdown)
      if (sheet) sheet.addEventListener('scroll', () => { sugList.hidden = true }, { passive: true })
    }

    // Prevent overscroll on the sheet from triggering pull-to-refresh (Safari)
    if (sheet) {
      let sheetStartY = 0
      sheet.addEventListener('touchstart', (e) => {
        sheetStartY = e.touches[0].pageY
      }, { passive: true })
      sheet.addEventListener('touchmove', (e) => {
        const { scrollTop, scrollHeight, clientHeight } = sheet
        const touchY = e.touches[0].pageY
        const pullingDown = touchY > sheetStartY
        const pushingUp   = touchY < sheetStartY
        if (scrollTop <= 0 && pullingDown) { e.preventDefault(); return }
        if (scrollTop + clientHeight >= scrollHeight && pushingUp) { e.preventDefault(); return }
      }, { passive: false })
    }

    // Prevent any touch interaction on backdrop from propagating
    if (backdrop) {
      backdrop.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false })
    }
  }

  // ---------------------------------------------------------------------------
  // Highlight a modifier group that hasn't been filled in yet
  // ---------------------------------------------------------------------------

  function highlightMissingGroup(groupId) {
    const el = document.getElementById(`mod-group-${groupId}`)
    if (!el) return
    el.style.outline = '2px solid var(--color-brand)'
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => { el.style.outline = '' }, 2000)
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  window.StoreCart = {
    renderBar,
    renderSheet,
    highlightMissingGroup,
  }

})()
