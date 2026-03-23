/**
 * Order Entry Tab — iPad-optimized POS for walk-in dine-in and takeout orders.
 *
 * Depends on globals set by dashboard.js before this file loads:
 *   window.state     — { merchantId, accessToken, menu, profile }
 *   window.api()     — authenticated fetch helper
 *   window.showToast()
 *   window.formatPrice()
 */

// ---------------------------------------------------------------------------
// Order state
// ---------------------------------------------------------------------------

/** @typedef {{ cartId: string, itemId: string, name: string, priceCents: number, qty: number, modifiers: Array<{modifierId:string,name:string,priceCents:number}>, note: string, course: 'first'|'main'|'dessert'|null, courseOrder: number|null, isLastCourse: boolean, printDestination: 'both'|'kitchen'|'counter' }} OrderItem */

/**
 * Look up the category that contains an item and return its course routing info.
 * @param {string} itemId
 * @returns {{ courseOrder: number|null, isLastCourse: boolean, printDestination: string }}
 */
function _getCategoryInfoForItem(itemId) {
  const menu = window.state?.menu
  if (!menu) return { courseOrder: null, isLastCourse: false, printDestination: 'both' }
  for (const cat of (menu.categories ?? [])) {
    if ((cat.items ?? []).some((i) => i.id === itemId)) {
      return {
        courseOrder:      cat.courseOrder      ?? null,
        isLastCourse:     cat.isLastCourse     ?? false,
        printDestination: cat.printDestination ?? 'both',
      }
    }
  }
  return { courseOrder: null, isLastCourse: false, printDestination: 'both' }
}

/**
 * Returns true when the current order has at least one coursable item that
 * should be sent as course-2 (main — courseOrder=null, isLastCourse=false,
 * printDestination != 'counter').
 */
function _hasCourse2Items() {
  return orderState.items.some(
    (i) => i.courseOrder == null && !i.isLastCourse && (i.printDestination ?? 'both') !== 'counter'
  )
}

/**
 * Returns true when the order has course-1 items (numbered + not last).
 */
function _hasCourse1Items() {
  return orderState.items.some((i) => i.courseOrder != null && !i.isLastCourse)
}

/**
 * Map of occupied tables: key = "tableLabel|roomLabel" (roomLabel may be empty),
 * value = full order object for loading on click.
 * Populated by _fetchOccupiedTables(); read synchronously by _renderTableGrid().
 * @type {Object.<string, object>}
 */
let _occupiedMap = {}

/**
 * Build the key used in _occupiedMap from a table label and room label.
 * @param {string} tableLabel
 * @param {string|null} roomLabel
 * @returns {string}
 */
function _occupiedKey(tableLabel, roomLabel) {
  return `${tableLabel}|${roomLabel ?? ''}`
}

/**
 * Fetch active dine-in orders with a table assigned, update _occupiedMap,
 * then re-render the table grid.
 */
async function _fetchOccupiedTables() {
  const merchantId = window.state?.merchantId
  if (!merchantId) return
  try {
    const res = await window.api(`/api/merchants/${merchantId}/orders/active-tables`)
    if (!res.ok) return
    const orders = await res.json()
    _occupiedMap = {}
    for (const order of orders) {
      const key = _occupiedKey(order.tableLabel, order.roomLabel)
      // DESC order means first seen = most recent; don't overwrite with an older entry
      if (!_occupiedMap[key]) _occupiedMap[key] = order
    }
    _renderTableGrid()
  } catch {
    // Best-effort — leave _occupiedMap as-is
  }
}

const orderState = {
  orderType: 'dine_in',       // 'dine_in' | 'pickup'
  selectedRoom: null,          // { id, name } | null
  selectedTable: null,         // { id, label } | null
  /** @type {OrderItem[]} */
  items: [],
  courseMode: false,
  printLanguage: 'en',
  /** When editing an existing order, this holds the order ID. null = new order */
  editingOrderId: null,
  customerName: '',
  kitchenNote: '',
  /** ISO timestamp for when the pickup order should be ready, or null for ASAP */
  scheduledFor: null,
  activeCategoryId: null,
  /** Item being edited/added in modal */
  modalItem: null,
  /** cartId if editing an existing order item, else null */
  modalEditCartId: null,
  /** Per-modal modifier selections: { [groupId]: { modifierId, name, priceCents } } */
  modalSelections: {},
  modalCourse: null,
  modalNote: '',
}

// ---------------------------------------------------------------------------
// Init — called by dashboard.js once the order section is first shown
// ---------------------------------------------------------------------------

/**
 * Initialize the Order Entry tab.
 * Safe to call multiple times; guards against double-init.
 */
function initOrderEntry() {
  if (initOrderEntry._done) return
  initOrderEntry._done = true

  _bindTypeBar()
  _bindLangBar()
  _bindEditCancelButton()
  _bindTableSection()
  _bindCoursingToggle()
  _bindCustomerField()
  _bindKitchenNoteField()
  _bindScheduledTimeField()
  _bindFireButton()
  _bindPayButton()
  _bindClearButton()
  _bindModalClose()
}

// ---------------------------------------------------------------------------
// Render — called by showSection('order') in dashboard.js
// ---------------------------------------------------------------------------

function renderOrderEntry() {
  _renderTypeBar()
  _renderTableSection()
  _renderScheduledRow()
  _renderCategoryTabs()
  _renderItemsGrid()
  _renderOrderSummary()
  _renderTotals()
  // Refresh occupied-table indicators in the background
  _fetchOccupiedTables()
}

// ---------------------------------------------------------------------------
// Type bar (Dine-in / Takeout)
// ---------------------------------------------------------------------------

function _bindTypeBar() {
  document.querySelectorAll('.oe-type-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      orderState.orderType = btn.dataset.type
      orderState.scheduledFor = null
      _renderTypeBar()
      _renderTableSection()
      _renderScheduledRow()
      _renderCategoryTabs()  // must re-render: table-gate and takeout have different visibility
      _renderItemsGrid()     // must re-render: switching types changes what's shown
      _renderOrderSummary()  // customer name label changes
    })
  })
}

function _renderTypeBar() {
  document.querySelectorAll('.oe-type-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === orderState.orderType)
    btn.setAttribute('aria-pressed', btn.dataset.type === orderState.orderType ? 'true' : 'false')
  })
}

// ---------------------------------------------------------------------------
// Table selection (dine-in only) — room pills + table bubbles
// ---------------------------------------------------------------------------

function _bindTableSection() {
  // Room pills are re-rendered on each call to _renderTableSection, bindings
  // are attached there. Nothing to bind statically.
}

function _renderTableSection() {
  const section = document.getElementById('oe-table-section')
  const roomPillsEl = document.getElementById('oe-room-pills')
  if (!section) return

  // For non-dine-in: hide only the table grid (not the whole section — fire/pay buttons live there too).
  // CSS sets display:flex so the [hidden] attribute alone is overridden — use style.display.
  const tableGrid = document.getElementById('oe-table-grid')
  if (orderState.orderType !== 'dine_in') {
    if (tableGrid) tableGrid.style.display = 'none'
    if (roomPillsEl) roomPillsEl.style.display = 'none'
    section.style.display = ''  // keep visible for fire/pay buttons
    orderState.selectedRoom = null
    orderState.selectedTable = null
    return
  }
  if (tableGrid) tableGrid.style.display = ''  // restore for dine-in
  section.style.display = ''   // restore CSS default
  if (roomPillsEl) roomPillsEl.style.display = ''  // _renderRoomPills controls visibility for single-room

  const profile = window.state?.profile
  const layout = profile?.tableLayout ?? null
  const rooms = layout?.rooms ?? []

  // Default selected room to first room — only when there are multiple rooms.
  // Single-room restaurants skip this so roomLabel stays null (no clutter on tickets).
  if (!orderState.selectedRoom && rooms.length > 1) {
    orderState.selectedRoom = { id: rooms[0].id, name: rooms[0].name }
  }

  _renderRoomPills(rooms)
  _renderTableGrid(rooms)
}

function _renderRoomPills(rooms) {
  const pillsEl = document.getElementById('oe-room-pills')
  if (!pillsEl) return

  // Hide room pills for single-room restaurants — no useful choice to make
  pillsEl.style.display = rooms.length <= 1 ? 'none' : ''

  pillsEl.innerHTML = rooms.map((r) => {
    const sel = orderState.selectedRoom?.id === r.id
    return `<button class="oe-room-pill${sel ? ' selected' : ''}" data-room-id="${_esc(r.id)}" aria-pressed="${sel}">${_esc(r.name)}</button>`
  }).join('')

  pillsEl.querySelectorAll('.oe-room-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = rooms.find((x) => x.id === btn.dataset.roomId)
      if (!r) return
      orderState.selectedRoom = { id: r.id, name: r.name }
      orderState.selectedTable = null
      _renderRoomPills(rooms)
      _renderTableGrid(rooms)
    })
  })
}

function _renderTableGrid(rooms) {
  if (!rooms) {
    const profile = window.state?.profile
    const layout = profile?.tableLayout ?? null
    rooms = layout?.rooms ?? []
  }

  const grid = document.getElementById('oe-table-grid')
  if (!grid) return

  const activeRoomId = orderState.selectedRoom?.id ?? rooms[0]?.id
  const activeRoom = rooms.find((r) => r.id === activeRoomId)
  const tables = (activeRoom?.tables ?? [])
    .slice()
    .sort((a, b) => {
      const aLabel = a.label || a.id
      const bLabel = b.label || b.id
      const aNum = Number(aLabel)
      const bNum = Number(bLabel)
      // Pure numbers sort numerically before everything else
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum
      if (!isNaN(aNum)) return -1
      if (!isNaN(bNum)) return 1
      // Both non-numeric: alphabetical, case-insensitive
      return aLabel.localeCompare(bLabel, 'en', { sensitivity: 'base' })
    })

  if (tables.length === 0) {
    grid.innerHTML = '<span class="oe-table-empty">No tables — add tables in Store Profile.</span>'
    return
  }

  grid.innerHTML = tables.map((t) => {
    const sel = orderState.selectedTable?.id === t.id
    const occupiedOrder = _occupiedMap[_occupiedKey(t.label || t.id, activeRoom?.name ?? null)]
      ?? _occupiedMap[_occupiedKey(t.label || t.id, null)]
    const isOccupied = !!occupiedOrder && occupiedOrder.id !== orderState.editingOrderId
    let cls = 'oe-table-btn'
    if (sel) cls += ' selected'
    else if (isOccupied) cls += ' occupied'
    const label = _esc(t.label || t.id)
    const badge = isOccupied ? ` <span class="oe-table-occupied-badge" aria-hidden="true"></span>` : ''
    return `<button class="${cls}" data-id="${_esc(t.id)}" aria-pressed="${sel}" title="${isOccupied ? `Occupied — ${_esc(occupiedOrder.customerName ?? '')}` : ''}">${label}${badge}</button>`
  }).join('')

  grid.querySelectorAll('.oe-table-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const tbl = activeRoom?.tables?.find((t) => t.id === id)
      if (!tbl) return
      const tableKey = tbl.label || tbl.id
      // Try room-qualified lookup first, then fall back to room-agnostic (for orders
      // created before rooms were configured, where room_label is null in the DB).
      const occupiedOrder = _occupiedMap[_occupiedKey(tableKey, activeRoom?.name ?? null)]
        ?? _occupiedMap[_occupiedKey(tableKey, null)]
      const isOccupied = !!occupiedOrder && occupiedOrder.id !== orderState.editingOrderId
      if (isOccupied) {
        // Load the existing order for editing
        loadOrderIntoEntry(occupiedOrder)
        return
      }
      // Toggle: tap same table to deselect
      orderState.selectedTable = orderState.selectedTable?.id === id
        ? null
        : { id: tbl.id, label: tbl.label || tbl.id }
      // If we were editing an order, clear that state — this is a fresh table
      if (orderState.editingOrderId) {
        _unlockEditingOrder()
        orderState.editingOrderId = null
        orderState.items = []
        orderState.customerName = ''
        orderState.kitchenNote = ''
        const nameInput = document.getElementById('oe-customer-name')
        if (nameInput) nameInput.value = ''
        const noteInput = document.getElementById('oe-kitchen-note')
        if (noteInput) noteInput.value = ''
        const banner = document.getElementById('oe-edit-banner')
        if (banner) banner.hidden = true
        const fireBtn = document.getElementById('oe-fire-btn')
        if (fireBtn) fireBtn.textContent = '🔥 Fire to Kitchen'
      }
      _renderTableGrid(rooms)
      _renderCategoryTabs()
      _renderItemsGrid()
      _renderOrderSummary()
      _renderTotals()
    })
  })
}

// ---------------------------------------------------------------------------
// Category tabs
// ---------------------------------------------------------------------------

function _renderCategoryTabs() {
  const tabs = document.getElementById('oe-category-tabs')
  if (!tabs) return

  // In dine-in mode, require a table to be selected before showing the menu
  if (orderState.orderType === 'dine_in' && !orderState.selectedTable) {
    tabs.innerHTML = ''
    return
  }

  const menu = window.state?.menu
  if (!menu) {
    tabs.innerHTML = '<span style="font-size:0.8rem;color:var(--color-gray-400)">Loading menu…</span>'
    return
  }

  // Only show categories marked as available in-store (defaults true if not set)
  const allCategories = menu.categories ?? []
  const categories = allCategories.filter((cat) => cat.availableInStore !== false)

  if (categories.length === 0) {
    tabs.innerHTML = '<span style="font-size:0.8rem;color:var(--color-gray-400)">No menu categories.</span>'
    return
  }

  // Default to first visible category; reset if active one was hidden in-store
  if (!orderState.activeCategoryId || !categories.find((c) => c.id === orderState.activeCategoryId)) {
    orderState.activeCategoryId = categories[0]?.id ?? null
  }

  tabs.innerHTML = categories.map((cat) => {
    const active = cat.id === orderState.activeCategoryId
    const unavail = !_isCategoryAvailableNow(cat)
    const cls = [
      'oe-cat-tab',
      active ? 'active' : '',
      unavail ? 'unavailable' : '',
    ].filter(Boolean).join(' ')
    return `<button class="${cls}" data-cat="${_esc(cat.id)}" title="${unavail ? 'Outside available hours' : ''}">${_esc(cat.name)}</button>`
  }).join('')

  tabs.querySelectorAll('.oe-cat-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      orderState.activeCategoryId = btn.dataset.cat
      _renderCategoryTabs()
      _renderItemsGrid()
    })
  })

}

/**
 * Returns true if this category is currently within its optional time window.
 * If no window is set, always available.
 * @param {{ hoursStart?: string, hoursEnd?: string }} cat
 */
function _isCategoryAvailableNow(cat) {
  if (!cat.hoursStart || !cat.hoursEnd) return true
  const now = new Date()
  const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return cur >= cat.hoursStart && cur <= cat.hoursEnd
}

// ---------------------------------------------------------------------------
// Item bubbles grid
// ---------------------------------------------------------------------------

function _renderItemsGrid() {
  const grid = document.getElementById('oe-items-grid')
  if (!grid) return

  // In dine-in mode, require a table to be selected before showing items
  if (orderState.orderType === 'dine_in' && !orderState.selectedTable) {
    grid.innerHTML = '<div class="oe-items-empty">Select a table to start the order.</div>'
    return
  }

  const menu = window.state?.menu
  if (!menu) {
    grid.innerHTML = '<div class="oe-items-empty">Menu not loaded.</div>'
    return
  }

  const cat = (menu.categories ?? []).find((c) => c.id === orderState.activeCategoryId)
  const items = cat?.items ?? []

  if (items.length === 0) {
    grid.innerHTML = '<div class="oe-items-empty">No items in this category.</div>'
    return
  }

  grid.innerHTML = items.map((item) => {
    const oos = item.stockStatus && item.stockStatus !== 'in_stock'
    const cls = ['oe-item-bubble', oos ? 'unavailable' : ''].filter(Boolean).join(' ')
    const priceStr = item.priceCents > 0 ? window.formatPrice(item.priceCents) : 'Market price'
    return `
      <button class="${cls}" data-item-id="${_esc(item.id)}" ${oos ? 'aria-disabled="true"' : ''}>
        <span class="oe-item-bubble-name">${_esc(item.name)}</span>
        <span class="oe-item-bubble-price">${_esc(priceStr)}</span>
        ${oos ? `<span class="oe-item-bubble-oos">${_esc(_stockLabel(item.stockStatus))}</span>` : ''}
      </button>
    `
  }).join('')

  grid.querySelectorAll('.oe-item-bubble:not(.unavailable)').forEach((btn) => {
    btn.addEventListener('click', () => {
      const itemId = btn.dataset.itemId
      const allItems = _allItemsFlat()
      const item = allItems.find((i) => i.id === itemId)
      if (item) _openItemModal(item, null)
    })
  })

}

function _stockLabel(status) {
  if (status === 'out_today') return 'Out today'
  if (status === 'out_indefinitely') return 'Out of stock'
  return ''
}

function _allItemsFlat() {
  const menu = window.state?.menu
  if (!menu) return []
  const items = []
  for (const cat of (menu.categories ?? [])) {
    items.push(...(cat.items ?? []))
  }
  items.push(...(menu.uncategorizedItems ?? []))
  return items
}

// ---------------------------------------------------------------------------
// Item customization modal
// ---------------------------------------------------------------------------

/**
 * Open the item modal for adding or editing an order item.
 * @param {object} item — menu item object from state.menu
 * @param {string|null} editCartId — cartId if editing existing, null if adding new
 */
function _openItemModal(item, editCartId) {
  orderState.modalItem = item
  orderState.modalEditCartId = editCartId
  orderState.modalSelections = {}
  orderState.modalCourse = null
  orderState.modalNote = ''

  // Pre-populate if editing
  if (editCartId) {
    const existing = orderState.items.find((i) => i.cartId === editCartId)
    if (existing) {
      // Reconstruct selections
      for (const mod of existing.modifiers) {
        const group = (item.modifierGroups ?? []).find((g) =>
          g.modifiers?.some((m) => m.id === mod.modifierId)
        )
        if (group) {
          orderState.modalSelections[group.id] = {
            modifierId: mod.modifierId,
            name: mod.name,
            priceCents: mod.priceCents,
          }
        }
      }
      orderState.modalCourse = existing.course
      orderState.modalNote = existing.note
    }
  }

  _renderItemModal()

  const modal = document.getElementById('oe-item-modal')
  if (modal) modal.hidden = false
}

function _closeItemModal() {
  const modal = document.getElementById('oe-item-modal')
  if (modal) modal.hidden = true
  orderState.modalItem = null
  orderState.modalEditCartId = null
}

function _bindModalClose() {
  const modal = document.getElementById('oe-item-modal')
  if (!modal) return

  document.getElementById('oe-modal-close-btn')?.addEventListener('click', _closeItemModal)
  document.getElementById('oe-item-modal-backdrop')?.addEventListener('click', _closeItemModal)

  document.getElementById('oe-modal-cancel-btn')?.addEventListener('click', _closeItemModal)

  document.getElementById('oe-modal-add-btn')?.addEventListener('click', () => {
    if (_commitModalItem()) _closeItemModal()
  })

  document.getElementById('oe-modal-delete-btn')?.addEventListener('click', () => {
    if (orderState.modalEditCartId) {
      orderState.items = orderState.items.filter((i) => i.cartId !== orderState.modalEditCartId)
      _closeItemModal()
      _renderOrderSummary()
      _renderTotals()
    }
  })

  // Allergy quick-buttons — event delegation on the modal for maximum reliability
  modal.addEventListener('click', (e) => {
    const btn = e.target.closest('.oe-allergy-btn')
    if (!btn) return

    const noteField = document.getElementById('oe-modal-note')
    if (!noteField) return

    const tag = btn.dataset.allergy
    const current = noteField.value.trim()

    if (current.includes(tag)) {
      noteField.value = current
        .split(/,\s*/)
        .filter((part) => part.trim() !== tag)
        .join(', ')
        .trim()
    } else {
      noteField.value = current ? `${current}, ${tag}` : tag
    }

    orderState.modalNote = noteField.value

    // Sync active state on all allergy buttons
    modal.querySelectorAll('.oe-allergy-btn').forEach((b) => {
      b.classList.toggle('active', noteField.value.includes(b.dataset.allergy))
    })
  })
}

function _renderItemModal() {
  const item = orderState.modalItem
  if (!item) return

  // Image
  const img = document.getElementById('oe-modal-item-img')
  if (img) {
    img.src = item.imageUrl || ''
    img.hidden = !item.imageUrl
  }

  // Name / desc / price
  const nameEl = document.getElementById('oe-modal-item-name')
  if (nameEl) nameEl.textContent = item.name

  const descEl = document.getElementById('oe-modal-item-desc')
  if (descEl) {
    descEl.textContent = item.description || ''
    descEl.hidden = !item.description
  }

  const priceEl = document.getElementById('oe-modal-item-price')
  if (priceEl) priceEl.textContent = item.priceCents > 0 ? window.formatPrice(item.priceCents) : ''

  // Modifier groups
  const modBody = document.getElementById('oe-modal-mod-body')
  if (modBody) {
    const groups = item.modifierGroups ?? []
    if (groups.length === 0) {
      modBody.innerHTML = ''
    } else {
      modBody.innerHTML = groups.map((group) => `
        <div class="oe-mod-group" data-group-id="${_esc(group.id)}">
          <div class="oe-mod-group-name">${_esc(group.name)}${group.isMandatory ? '<span class="oe-mod-required">*</span>' : ''}</div>
          <div class="oe-mod-options">
            ${(group.modifiers ?? []).map((mod) => {
              const oos = mod.stockStatus && mod.stockStatus !== 'in_stock'
              const sel = orderState.modalSelections[group.id]?.modifierId === mod.id
              const cls = ['oe-mod-option', sel ? 'selected' : '', oos ? 'unavailable' : ''].filter(Boolean).join(' ')
              const label = mod.priceCents > 0 ? `${mod.name} +${window.formatPrice(mod.priceCents)}` : mod.name
              return `<button class="${cls}" data-group="${_esc(group.id)}" data-mod="${_esc(mod.id)}" data-name="${_esc(mod.name)}" data-price="${mod.priceCents}">${_esc(label)}</button>`
            }).join('')}
          </div>
        </div>
      `).join('')

      modBody.querySelectorAll('.oe-mod-option:not(.unavailable)').forEach((btn) => {
        btn.addEventListener('click', () => {
          const groupId = btn.dataset.group
          const modId = btn.dataset.mod
          const name = btn.dataset.name
          const price = parseInt(btn.dataset.price, 10)

          if (orderState.modalSelections[groupId]?.modifierId === modId) {
            // Deselect
            delete orderState.modalSelections[groupId]
          } else {
            orderState.modalSelections[groupId] = { modifierId: modId, name, priceCents: price }
          }

          // Clear mandatory error highlight once a selection is made
          if (orderState.modalSelections[groupId]) {
            modBody.querySelector(`.oe-mod-group[data-group-id="${groupId}"]`)?.classList.remove('oe-mod-group--error')
          }

          // Re-render just the group options
          modBody.querySelectorAll(`.oe-mod-option[data-group="${groupId}"]`).forEach((b) => {
            b.classList.toggle('selected', orderState.modalSelections[groupId]?.modifierId === b.dataset.mod)
          })
        })
      })
    }
  }

  // Kitchen note
  const noteField = document.getElementById('oe-modal-note')
  if (noteField) {
    noteField.value = orderState.modalNote
    noteField.oninput = () => { orderState.modalNote = noteField.value }

    // Sync allergy button active states to the current note
    document.querySelectorAll('.oe-allergy-btn').forEach((btn) => {
      btn.classList.toggle('active', orderState.modalNote.includes(btn.dataset.allergy))
    })
  }

  // Course selector (only when coursing mode is ON)
  const courseSection = document.getElementById('oe-modal-course-section')
  if (courseSection) {
    courseSection.hidden = !orderState.courseMode
    if (orderState.courseMode) {
      courseSection.querySelectorAll('.oe-course-btn').forEach((btn) => {
        btn.classList.toggle('selected', btn.dataset.course === orderState.modalCourse)
        btn.onclick = () => {
          orderState.modalCourse = btn.dataset.course === orderState.modalCourse ? null : btn.dataset.course
          courseSection.querySelectorAll('.oe-course-btn').forEach((b) => {
            b.classList.toggle('selected', b.dataset.course === orderState.modalCourse)
          })
        }
      })
    }
  }

  // Button labels
  const addBtn = document.getElementById('oe-modal-add-btn')
  if (addBtn) addBtn.textContent = orderState.modalEditCartId ? 'Update Item' : 'Add to Order'

  const deleteBtn = document.getElementById('oe-modal-delete-btn')
  if (deleteBtn) deleteBtn.hidden = !orderState.modalEditCartId
}

/**
 * Commit the modal item into orderState.items.
 * Returns true on success, false if mandatory modifier groups are unsatisfied.
 */
function _commitModalItem() {
  const item = orderState.modalItem
  if (!item) return false

  // Validate mandatory modifier groups — required when isMandatory=true OR minRequired >= 1
  const unsatisfied = (item.modifierGroups ?? []).filter(
    (g) => (g.isMandatory || (g.minRequired ?? 0) >= 1) && !orderState.modalSelections[g.id]
  )
  if (unsatisfied.length > 0) {
    // Highlight the first unsatisfied group and scroll to it
    const modBody = document.getElementById('oe-modal-mod-body')
    if (modBody) {
      modBody.querySelectorAll('.oe-mod-group').forEach((el) => {
        el.classList.remove('oe-mod-group--error')
      })
      for (const g of unsatisfied) {
        const el = modBody.querySelector(`.oe-mod-group[data-group-id="${g.id}"]`)
        if (el) {
          el.classList.add('oe-mod-group--error')
          if (g === unsatisfied[0]) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      }
    }
    return false
  }

  const modifiers = Object.values(orderState.modalSelections)
  const modTotal = modifiers.reduce((s, m) => s + m.priceCents, 0)
  const linePriceCents = item.priceCents + modTotal

  if (orderState.modalEditCartId) {
    // Update existing
    const idx = orderState.items.findIndex((i) => i.cartId === orderState.modalEditCartId)
    if (idx !== -1) {
      orderState.items[idx] = {
        ...orderState.items[idx],
        modifiers,
        note: orderState.modalNote,
        course: orderState.courseMode ? orderState.modalCourse : null,
        priceCents: item.priceCents,
      }
    }
  } else {
    // Check if identical item already in order (same item + same modifiers, no note)
    if (!orderState.modalNote && modifiers.length === 0) {
      const existing = orderState.items.find(
        (i) => i.itemId === item.id && i.modifiers.length === 0 && !i.note
      )
      if (existing) {
        existing.qty++
        _renderOrderSummary()
        _renderTotals()
        return true
      }
    }

    const catInfo = _getCategoryInfoForItem(item.id)
    orderState.items.push({
      cartId: `ci_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      itemId: item.id,
      name: item.name,
      priceCents: item.priceCents,
      qty: 1,
      modifiers,
      note: orderState.modalNote,
      course: orderState.courseMode ? orderState.modalCourse : null,
      courseOrder:      catInfo.courseOrder,
      isLastCourse:     catInfo.isLastCourse,
      printDestination: catInfo.printDestination,
    })
  }

  _renderOrderSummary()
  _renderTotals()
  return true
}

// ---------------------------------------------------------------------------
// Order summary (right column)
// ---------------------------------------------------------------------------

function _renderOrderSummary() {
  const listEl = document.getElementById('oe-order-items')
  const emptyEl = document.getElementById('oe-order-empty')
  if (!listEl) return

  const items = orderState.items
  listEl.innerHTML = ''

  if (items.length === 0) {
    if (emptyEl) emptyEl.hidden = false
    return
  }
  if (emptyEl) emptyEl.hidden = true

  if (orderState.courseMode) {
    // Grouped by course
    const groups = [
      { key: 'first', label: '1st Course' },
      { key: 'main', label: 'Main' },
      { key: 'dessert', label: 'Dessert' },
      { key: null, label: 'Other' },
    ]
    for (const g of groups) {
      const grouped = items.filter((i) => i.course === g.key)
      if (grouped.length === 0) continue
      const heading = document.createElement('div')
      heading.className = 'oe-course-heading'
      heading.textContent = g.label
      listEl.appendChild(heading)
      for (const item of grouped) listEl.appendChild(_buildOrderItemRow(item))
    }
  } else {
    for (const item of items) listEl.appendChild(_buildOrderItemRow(item))
  }

  // Customer name field label
  const nameLabel = document.getElementById('oe-customer-name-label')
  if (nameLabel) {
    nameLabel.textContent = orderState.orderType === 'pickup' ? 'Customer name *' : 'Customer name (optional)'
  }

  // Restore field values
  const nameInput = document.getElementById('oe-customer-name')
  if (nameInput) nameInput.value = orderState.customerName

  const noteInput = document.getElementById('oe-kitchen-note')
  if (noteInput) noteInput.value = orderState.kitchenNote
}

/** @param {OrderItem} item */
function _buildOrderItemRow(item) {
  const modTotal = item.modifiers.reduce((s, m) => s + m.priceCents, 0)
  const lineTotal = (item.priceCents + modTotal) * item.qty

  const row = document.createElement('div')
  row.className = 'oe-order-item'

  const modSummary = item.modifiers.map((m) => m.name).join(', ')
  const isRemove = item.qty === 1

  row.innerHTML = `
    <div class="oe-order-item-info">
      <div class="oe-order-item-name">${_esc(item.name)}</div>
      ${modSummary ? `<div class="oe-order-item-mods">${_esc(modSummary)}</div>` : ''}
      ${item.note ? `<div class="oe-order-item-note">${_esc(item.note)}</div>` : ''}
    </div>
    <div class="oe-order-item-qty-ctrl">
      <button class="oe-qty-btn oe-qty-minus${isRemove ? ' is-remove' : ''}"
              aria-label="${isRemove ? 'Remove item' : 'Decrease quantity'}">−</button>
      <span class="oe-qty-val">${item.qty}</span>
      <button class="oe-qty-btn oe-qty-plus" aria-label="Increase quantity">+</button>
    </div>
    <div class="oe-order-item-price">${window.formatPrice(lineTotal)}</div>
    <svg class="oe-order-item-edit-icon" aria-hidden="true" role="button" tabindex="0"
         aria-label="${_esc(item.name)} — tap to edit modifiers"
         width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  `

  // – button: decrement qty, or remove when already at 1
  row.querySelector('.oe-qty-minus').addEventListener('click', (e) => {
    e.stopPropagation()
    const idx = orderState.items.findIndex((i) => i.cartId === item.cartId)
    if (idx === -1) return
    if (orderState.items[idx].qty > 1) {
      orderState.items[idx].qty--
    } else {
      orderState.items = orderState.items.filter((i) => i.cartId !== item.cartId)
    }
    _renderOrderSummary()
    _renderTotals()
  })

  // + button: increment qty
  row.querySelector('.oe-qty-plus').addEventListener('click', (e) => {
    e.stopPropagation()
    const idx = orderState.items.findIndex((i) => i.cartId === item.cartId)
    if (idx === -1) return
    orderState.items[idx].qty++
    _renderOrderSummary()
    _renderTotals()
  })

  // Edit icon: open modifier/note modal
  const editFn = () => {
    if (!window.state?.menu) {
      window.showToast?.('Menu is still loading — please try again.', 'info')
      return
    }
    const allItems = _allItemsFlat()
    const menuItem = allItems.find((i) => i.id === item.itemId)
    if (menuItem) {
      _openItemModal(menuItem, item.cartId)
    } else {
      window.showToast?.('Item no longer in menu. Tap to delete it.', 'info')
    }
  }
  const editIcon = row.querySelector('.oe-order-item-edit-icon')
  editIcon.addEventListener('click', editFn)
  editIcon.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') editFn() })
  return row
}

// ---------------------------------------------------------------------------
// Coursing toggle
// ---------------------------------------------------------------------------

function _bindCoursingToggle() {
  const toggle = document.getElementById('oe-coursing-toggle')
  if (!toggle) return
  toggle.addEventListener('click', () => {
    orderState.courseMode = !orderState.courseMode
    toggle.setAttribute('aria-checked', orderState.courseMode ? 'true' : 'false')
    toggle.classList.toggle('is-on', orderState.courseMode)
    // Strip course assignments when turning off
    if (!orderState.courseMode) {
      orderState.items.forEach((i) => { i.course = null })
    }
    _renderOrderSummary()
  })
}

// ---------------------------------------------------------------------------
// Language bar (EN / ES)
// ---------------------------------------------------------------------------

function _bindLangBar() {
  const bar = document.querySelector('.oe-lang-bar')
  if (!bar) return
  bar.querySelectorAll('.oe-lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      orderState.printLanguage = btn.dataset.lang
      bar.querySelectorAll('.oe-lang-btn').forEach((b) => {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Customer field & kitchen note
// ---------------------------------------------------------------------------

function _bindCustomerField() {
  const input = document.getElementById('oe-customer-name')
  if (input) input.addEventListener('input', () => { orderState.customerName = input.value })
}

function _bindKitchenNoteField() {
  const input = document.getElementById('oe-kitchen-note')
  if (input) input.addEventListener('input', () => { orderState.kitchenNote = input.value })
}

// ---------------------------------------------------------------------------
// Scheduled time field (pickup only)
// ---------------------------------------------------------------------------

function _bindScheduledTimeField() {
  const input = document.getElementById('oe-scheduled-time')
  if (!input) return
  input.addEventListener('change', () => {
    if (!input.value) {
      orderState.scheduledFor = null
      return
    }
    // Combine today's date with the chosen HH:MM to get an ISO timestamp
    const now = new Date()
    const [hh, mm] = input.value.split(':').map(Number)
    const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0)
    // If time is before now, assume next day
    if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1)
    orderState.scheduledFor = scheduled.toISOString()
  })
}

/**
 * Show the "Ready by" row only for pickup orders.
 * Also resets the time input when hiding.
 */
function _renderScheduledRow() {
  const isPickup = orderState.orderType === 'pickup'

  // "Ready by" time — takeout only
  const scheduledRow = document.getElementById('oe-scheduled-row')
  const scheduledInput = document.getElementById('oe-scheduled-time')
  if (scheduledRow) scheduledRow.hidden = !isPickup
  if (!isPickup && scheduledInput) {
    scheduledInput.value = ''
    orderState.scheduledFor = null
  }

  // Customer name — takeout only (dine-in uses the table number)
  const nameRow = document.getElementById('oe-customer-name-row')
  if (nameRow) nameRow.hidden = !isPickup

  // "Course the meal" toggle — dine-in only
  const coursingRow = document.getElementById('oe-coursing-row')
  if (coursingRow) coursingRow.hidden = isPickup
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function _renderTotals() {
  const subtotal = orderState.items.reduce((s, item) => {
    const modTotal = item.modifiers.reduce((ms, m) => ms + m.priceCents, 0)
    return s + (item.priceCents + modTotal) * item.qty
  }, 0)

  const profile = window.state?.profile
  const taxRate = parseFloat(profile?.taxRate ?? 0)
  // taxRate is stored as a decimal (e.g. 0.0875 = 8.75%) — no /100 needed
  const tax = Math.round(subtotal * taxRate)

  const total = subtotal + tax

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }

  set('oe-subtotal', window.formatPrice(subtotal))
  const taxRow = document.getElementById('oe-tax-row')
  if (taxRow) taxRow.hidden = tax === 0
  set('oe-tax', window.formatPrice(tax))

  set('oe-total', window.formatPrice(total))

  const hasItems = orderState.items.length > 0

  // Enable fire button only when there are items
  const fireBtn = document.getElementById('oe-fire-btn')
  if (fireBtn) fireBtn.disabled = !hasItems

  // Show pay button only when an active payment provider is selected in the profile
  const payBtn = document.getElementById('oe-pay-btn')
  if (payBtn) {
    payBtn.hidden   = !window.state?.profile?.paymentProvider
    payBtn.disabled = !hasItems
  }
}

// ---------------------------------------------------------------------------
// Coursing delay prompt
// ---------------------------------------------------------------------------

/**
 * Show a compact inline popup asking the server how many minutes to wait
 * before firing the mains (course-2) to the kitchen.
 *
 * Resolves with:
 *   number  — delay in minutes (use coursing)
 *   0       — fire everything now (user chose "Cancel — fire all now")
 *   null    — user dismissed overlay without choosing (abort the Fire)
 * @returns {Promise<number|null>}
 */
function _promptCourseDelay() {
  return new Promise((resolve) => {
    document.getElementById('oe-course-delay-popup')?.remove()

    const overlay = document.createElement('div')
    overlay.id = 'oe-course-delay-popup'
    overlay.className = 'oe-course-delay-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', 'Course delay')

    overlay.innerHTML = `
      <div class="oe-course-delay-box">
        <p class="oe-course-delay-title">&#127869; Starters fired &mdash; when to fire mains?</p>
        <div class="oe-course-delay-options">
          <button class="oe-delay-btn" data-minutes="10">10 min</button>
          <button class="oe-delay-btn" data-minutes="15">15 min</button>
          <button class="oe-delay-btn" data-minutes="20">20 min</button>
          <button class="oe-delay-btn" data-minutes="25">25 min</button>
          <button class="oe-delay-btn" data-minutes="30">30 min</button>
        </div>
        <div class="oe-course-delay-custom">
          <label class="oe-delay-custom-label">Custom:
            <input type="number" id="oe-delay-custom-input" class="oe-delay-custom-input"
              min="1" max="120" placeholder="min" />
          </label>
          <button class="btn btn-primary oe-delay-confirm-btn" disabled>
            Fire mains in <span id="oe-delay-preview">--</span>
          </button>
        </div>
        <button class="oe-delay-cancel-btn">Cancel &mdash; fire all now</button>
      </div>
    `

    document.body.appendChild(overlay)

    let selectedMinutes = null
    const preview = overlay.querySelector('#oe-delay-preview')
    const customInput = overlay.querySelector('#oe-delay-custom-input')
    const confirmBtn = overlay.querySelector('.oe-delay-confirm-btn')

    const updatePreview = (mins) => {
      preview.textContent = mins ? `${mins} min` : '--'
      confirmBtn.disabled = !mins
    }

    overlay.querySelectorAll('.oe-delay-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.oe-delay-btn').forEach((b) => b.classList.remove('selected'))
        btn.classList.add('selected')
        selectedMinutes = parseInt(btn.dataset.minutes, 10)
        customInput.value = ''
        updatePreview(selectedMinutes)
      })
    })

    customInput.addEventListener('input', () => {
      overlay.querySelectorAll('.oe-delay-btn').forEach((b) => b.classList.remove('selected'))
      const v = parseInt(customInput.value, 10)
      selectedMinutes = (!isNaN(v) && v > 0) ? v : null
      updatePreview(selectedMinutes)
    })

    confirmBtn.addEventListener('click', () => {
      if (!selectedMinutes) return
      overlay.remove()
      resolve(selectedMinutes)
    })

    overlay.querySelector('.oe-delay-cancel-btn').addEventListener('click', () => {
      overlay.remove()
      resolve(0)
    })

    // Backdrop click = full cancel (abort Fire)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove()
        resolve(null)
      }
    })

    // Default-select 20 min
    overlay.querySelector('[data-minutes="20"]')?.click()
  })
}

// ---------------------------------------------------------------------------
// Fire to Kitchen
// ---------------------------------------------------------------------------

function _bindFireButton() {
  const btn = document.getElementById('oe-fire-btn')
  if (!btn) return

  btn.addEventListener('click', async () => {
    if (!_validateOrder()) return

    const isEditing = !!orderState.editingOrderId

    // ── Coursing delay popup ───────────────────────────────────────────────
    // When courseMode is on and the order has both course-1 (starters) and
    // course-2 (mains), ask the server how long to wait before firing mains.
    let courseDelayMinutes = 0
    if (!isEditing && orderState.courseMode && _hasCourse1Items() && _hasCourse2Items()) {
      const delay = await _promptCourseDelay()
      if (delay === null) return // user cancelled
      courseDelayMinutes = delay
    }

    btn.disabled = true
    btn.textContent = isEditing ? 'Updating…' : 'Sending…'

    try {
      const merchantId = window.state?.merchantId

      const items = orderState.items.map((oi) => ({
        itemId: oi.itemId,
        name: oi.name,
        priceCents: oi.priceCents,
        quantity: oi.qty,
        selectedModifiers: oi.modifiers,
        serverNotes: oi.note || undefined,
      }))

      if (isEditing) {
        // ── Update existing order ─────────────────────────────────────────
        const body = {
          items,
          customerName: orderState.customerName.trim() || undefined,
          notes: orderState.kitchenNote.trim() || '',
          tableLabel: orderState.selectedTable?.label ?? undefined,
          roomLabel: orderState.selectedRoom?.name ?? undefined,
          printLanguage: orderState.printLanguage,
          reprintTicket: true,
        }

        const res = await window.api(
          `/api/merchants/${merchantId}/orders/${orderState.editingOrderId}`,
          { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${res.status}`)
        }

        window.showToast('Order updated — tickets sent to kitchen and counter', 'success')
        _unlockEditingOrder()
        _resetOrder()
        _fetchOccupiedTables()
      } else {
        // ── Create new order ─────────────────────────────────────────────
        const body = {
          orderType: orderState.orderType,
          customerName: orderState.customerName.trim() || (orderState.orderType === 'dine_in' ? 'Dine-in' : 'Takeout'),
          notes: orderState.kitchenNote.trim() || undefined,
          items,
          tableLabel: orderState.selectedTable?.label ?? undefined,
          roomLabel: orderState.selectedRoom?.name ?? undefined,
          courseMode: orderState.courseMode,
          courseDelayMinutes: courseDelayMinutes || undefined,
          utensilsNeeded: false,
          printLanguage: orderState.printLanguage,
          employeeId: window.currentEmployee?.id ?? undefined,
          employeeNickname: window.currentEmployee?.nickname ?? undefined,
          scheduledFor: orderState.scheduledFor || undefined,
        }

        const res = await window.api(`/api/merchants/${merchantId}/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${res.status}`)
        }

        window.showToast(
          orderState.scheduledFor ? 'Scheduled order saved!' : 'Order sent to kitchen!',
          'success',
        )
        _resetOrder()
        _fetchOccupiedTables()
      }
    } catch (err) {
      window.showToast(`Failed: ${err.message}`, 'error')
    } finally {
      btn.disabled = orderState.items.length === 0
      btn.textContent = orderState.editingOrderId ? '🔥 Update Order' : '🔥 Fire to Kitchen'
    }
  })
}

// ---------------------------------------------------------------------------
// Pay (Stax / Converge)
// ---------------------------------------------------------------------------

/**
 * Bind the Pay button — dispatches to Converge, Finix, or Stax depending on config.
 */
function _bindPayButton() {
  const btn = document.getElementById('oe-pay-btn')
  if (!btn) return
  btn.addEventListener('click', () => {
    const provider = window.state?.profile?.paymentProvider
    if (provider === 'converge') {
      _openConvergePaymentFromOrderEntry()
    } else if (provider === 'finix') {
      _openFinixPaymentFromOrderEntry()
    } else {
      _openStaxPaymentFromOrderEntry()
    }
  })
}

/**
 * Opens the Stax hosted payment page from Order Entry.
 * Saves orderState to sessionStorage in the format resumeAfterStaxPayment() reads,
 * then opens the Stax URL in a new tab.
 */
function _openStaxPaymentFromOrderEntry() {
  if (!_validateOrder()) return

  const token = window.state?.profile?.staxToken
  if (!token) {
    window.showToast('Stax payment token not configured', 'error')
    return
  }

  const profile = window.state?.profile
  const taxRate = parseFloat(profile?.taxRate ?? 0)

  const subtotalCents = orderState.items.reduce((s, oi) => {
    const modTotal = oi.modifiers.reduce((ms, m) => ms + m.priceCents, 0)
    return s + (oi.priceCents + modTotal) * oi.qty
  }, 0)
  const taxCents    = Math.round(subtotalCents * taxRate)
  const customerName = orderState.customerName.trim() || 'Guest'

  // Show payment preview modal; proceed to Stax on confirm
  window.openPaymentPreviewModal(
    { items: orderState.items, subtotalCents, taxCents, customerName, orderType: orderState.orderType },
    (tipCents) => {
      const grandCents   = subtotalCents + taxCents + tipCents
      const totalDollars = (grandCents / 100).toFixed(2)

      const itemSummary = orderState.items.map((oi) => `${oi.qty}x ${oi.name}`).join(', ')
      const nameParts   = customerName.split(/\s+/)
      const firstName   = nameParts[0] ?? 'Guest'
      const lastName    = nameParts.slice(1).join(' ') || firstName

      const redirectUrl = `${window.location.origin}${window.location.pathname}#stax-paid`
      const params = new URLSearchParams({
        memo: `${itemSummary} — ${customerName}`,
        total: totalDollars,
        r: redirectUrl,
        firstname: firstName,
        lastname: lastName,
      })

      sessionStorage.setItem('stax_pending_order', JSON.stringify({
        cartState: {
          orderType: orderState.orderType,
          items: orderState.items.map((oi) => ({
            itemId: oi.itemId,
            name: oi.name,
            priceCents: oi.priceCents,
            quantity: oi.qty,
            modifiers: oi.modifiers,
          })),
        },
        customerName,
        customerPhone: '',
        customerEmail: '',
        notes: orderState.kitchenNote.trim() || '',
        utensilsNeeded: false,
        tableLabel: orderState.selectedTable?.label ?? null,
        roomLabel: orderState.selectedRoom?.name ?? null,
        printLanguage: orderState.printLanguage,
        tipCents,
        paidAmountCents: grandCents,
        paymentMethod: 'card',
      }))

      window.location.href = `https://app.staxpayments.com/#/pay/${encodeURIComponent(token)}?${params.toString()}`
    }
  )
}

/**
 * Opens the Converge hosted payment page from Order Entry.
 * Calls the session endpoint server-side (PIN never touches the browser),
 * saves cart to sessionStorage, then opens the URL in a new tab.
 * On return, postMessage from /payment/converge/return triggers
 * resumeAfterConvergePayment in dashboard.js.
 */
async function _openConvergePaymentFromOrderEntry() {
  if (!_validateOrder()) return

  const merchantId  = window.state?.merchantId
  const profile     = window.state?.profile
  const taxRate     = parseFloat(profile?.taxRate ?? 0)
  const customerName = orderState.customerName.trim() || 'Guest'

  const subtotalCents = orderState.items.reduce((s, oi) => {
    const modTotal = oi.modifiers.reduce((ms, m) => ms + m.priceCents, 0)
    return s + (oi.priceCents + modTotal) * oi.qty
  }, 0)
  const taxCents = Math.round(subtotalCents * taxRate)

  window.openPaymentPreviewModal(
    { items: orderState.items, subtotalCents, taxCents, customerName, orderType: orderState.orderType },
    async (tipCents) => {
      const grandCents  = subtotalCents + taxCents + tipCents
      const itemSummary = orderState.items.map((oi) => `${oi.qty}x ${oi.name}`).join(', ')
      const memo        = `${itemSummary} — ${customerName}`

      // The return page posts a message to window.opener (dashboard tab stays open)
      const returnUrl = `${window.location.origin}/payment/converge/return`

      try {
        const res = await window.api(`/api/merchants/${merchantId}/payments/converge/session`, {
          method: 'POST',
          body: JSON.stringify({ amountCents: grandCents, memo, returnUrl }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${res.status}`)
        }
        const { url } = await res.json()

        // Save cart so the opener's postMessage handler can submit the order
        sessionStorage.setItem('converge_pending_order', JSON.stringify({
          cartState: {
            orderType: orderState.orderType,
            items: orderState.items.map((oi) => ({
              itemId:    oi.itemId,
              name:      oi.name,
              priceCents: oi.priceCents,
              quantity:  oi.qty,
              modifiers: oi.modifiers,
            })),
          },
          customerName,
          customerPhone: '',
          customerEmail: '',
          notes:         orderState.kitchenNote.trim() || '',
          utensilsNeeded: false,
          tableLabel:    orderState.selectedTable?.label ?? null,
          roomLabel:     orderState.selectedRoom?.name  ?? null,
          printLanguage: orderState.printLanguage,
          tipCents,
          paidAmountCents: grandCents,
          paymentMethod: 'card',
        }))

        // Intentionally omit 'noopener' so the return page can postMessage back
        window.open(url, '_blank')
        window.showToast('Payment page opened — complete payment there to place the order', 'info')
      } catch (err) {
        window.showToast(`Could not open payment page: ${err.message}`, 'error')
      }
    }
  )
}

/**
 * Opens the Finix Checkout Page from Order Entry.
 * Shows the payment preview modal first (tip selection), then redirects
 * to the Finix hosted payment page. On return the order is created and
 * the cart is cleared automatically.
 */
/**
 * "Pay over the phone" flow for Finix: shows tip selector, creates the order,
 * then opens the PaymentModal inline Finix tokenisation screen.
 */
async function _openFinixPaymentFromOrderEntry() {
  if (!_validateOrder()) return

  const profile      = window.state?.profile
  const merchantId   = window.state?.merchantId
  const taxRate      = parseFloat(profile?.taxRate ?? 0)
  const customerName = orderState.customerName.trim() || 'Guest'

  const subtotalCents = orderState.items.reduce((s, oi) => {
    const modTotal = oi.modifiers.reduce((ms, m) => ms + m.priceCents, 0)
    return s + (oi.priceCents + modTotal) * oi.qty
  }, 0)
  const taxCents = Math.round(subtotalCents * taxRate)

  window.openPaymentPreviewModal(
    { items: orderState.items, subtotalCents, taxCents, customerName, orderType: orderState.orderType },
    async (tipCents) => {
      try {
        // Create the order in the DB (fires kitchen ticket)
        const items = orderState.items.map((oi) => ({
          itemId:     oi.itemId,
          name:       oi.name,
          priceCents: oi.priceCents,
          quantity:   oi.qty,
          modifiers:  oi.modifiers,
        }))
        const res = await window.api(`/api/merchants/${merchantId}/orders`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderType:        orderState.orderType,
            customerName,
            notes:            orderState.kitchenNote.trim() || undefined,
            items,
            tableLabel:       orderState.selectedTable?.label ?? undefined,
            roomLabel:        orderState.selectedRoom?.name  ?? undefined,
            utensilsNeeded:   false,
            printLanguage:    orderState.printLanguage,
            employeeId:       window.currentEmployee?.id ?? undefined,
            employeeNickname: window.currentEmployee?.nickname ?? undefined,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${res.status}`)
        }
        const { orderId } = await res.json()

        // Reset order entry form
        _resetOrder()

        // Open PaymentModal directly at the phone tokenise screen
        const finixCfg = window.state?.paymentConfig?.finix
        if (window.PaymentModal) {
          window.PaymentModal.open(
            { id: orderId, subtotalCents },
            profile,
            {
              mode:     'phone',
              tipCents,
              finix: finixCfg?.enabled ? {
                applicationId: finixCfg.applicationId,
                merchantId:    finixCfg.merchantId,
                sandbox:       finixCfg.sandbox,
              } : null,
            },
          )
        }
      } catch (err) {
        window.showToast(`Failed to create order: ${err.message}`, 'error')
      }
    }
  )
}

function _validateOrder() {
  // Clear previous validation errors
  const nameInput = document.getElementById('oe-customer-name')
  if (nameInput) nameInput.classList.remove('oe-input-error')
  const prevErr = document.querySelector('.oe-validation-error')
  if (prevErr) prevErr.remove()

  if (orderState.items.length === 0) {
    window.showToast('Add at least one item', 'error')
    return false
  }
  // Customer name is optional for takeout — default to 'Takeout' if blank
  return true
}

function _resetOrder() {
  orderState.items = []
  orderState.selectedTable = null
  orderState.selectedRoom = null
  orderState.customerName = ''
  orderState.kitchenNote = ''
  orderState.scheduledFor = null
  orderState.courseMode = false
  orderState.editingOrderId = null

  const toggle = document.getElementById('oe-coursing-toggle')
  if (toggle) {
    toggle.setAttribute('aria-checked', 'false')
    toggle.classList.remove('is-on')
  }

  const nameInput = document.getElementById('oe-customer-name')
  if (nameInput) nameInput.value = ''

  const noteInput = document.getElementById('oe-kitchen-note')
  if (noteInput) noteInput.value = ''

  const scheduledInput = document.getElementById('oe-scheduled-time')
  if (scheduledInput) scheduledInput.value = ''

  // Hide editing banner and restore fire button label
  const banner = document.getElementById('oe-edit-banner')
  if (banner) banner.hidden = true
  const fireBtn = document.getElementById('oe-fire-btn')
  if (fireBtn) fireBtn.textContent = '🔥 Fire to Kitchen'

  _renderTableSection()   // re-renders table grid and room pills
  _renderCategoryTabs()   // re-applies table-first gate
  _renderItemsGrid()      // re-applies table-first gate
  _renderOrderSummary()
  _renderTotals()

  const payBtn = document.getElementById('oe-pay-btn')
  if (payBtn) payBtn.disabled = true
}

// ---------------------------------------------------------------------------
// Clear button
// ---------------------------------------------------------------------------

function _bindClearButton() {
  const btn     = document.getElementById('oe-clear-btn')
  const overlay = document.getElementById('oe-confirm-overlay')
  const btnOk   = document.getElementById('oe-confirm-btn-ok')
  const btnKeep = document.getElementById('oe-confirm-btn-cancel')

  let _pendingConfirm = null

  function _showConfirm(onConfirm) {
    _pendingConfirm = onConfirm
    if (overlay) overlay.hidden = false
    if (btnOk) btnOk.focus()
  }

  function _dismiss() {
    if (overlay) overlay.hidden = true
    _pendingConfirm = null
  }

  if (btnOk) btnOk.addEventListener('click', () => {
    const cb = _pendingConfirm
    _dismiss()
    if (cb) cb()
  })

  if (btnKeep) btnKeep.addEventListener('click', _dismiss)

  // Tap outside the dialog box to dismiss
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) _dismiss()
  })

  if (!btn) return
  btn.addEventListener('click', () => {
    if (orderState.items.length === 0) {
      _resetOrder()
      return
    }
    _showConfirm(() => { _unlockEditingOrder(); _resetOrder() })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _parseJSON(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

// ---------------------------------------------------------------------------
// Edit mode: load an existing order into the entry UI
// ---------------------------------------------------------------------------

/**
 * Load an existing order into the order entry tab for editing.
 * Called from dashboard.js reopenOrder().
 * @param {object} order - order object returned by GET /orders
 */
function loadOrderIntoEntry(order) {
  // Ensure init has run
  if (!initOrderEntry._done) initOrderEntry()

  // Populate state
  orderState.editingOrderId = order.id
  orderState.orderType = order.orderType ?? 'dine_in'
  orderState.customerName = order.customerName ?? ''
  orderState.courseMode = false

  // Resolve table/room IDs from the layout so the table button gets highlighted.
  // Stored orders only carry label strings, not IDs — look them up by name.
  const allRooms = window.state?.profile?.tableLayout?.rooms ?? []
  let resolvedRoom = null
  let resolvedTable = null
  if (order.roomLabel) {
    const r = allRooms.find((r) => r.name === order.roomLabel)
    resolvedRoom = r ? { id: r.id, name: r.name } : { id: null, name: order.roomLabel }
  }
  if (order.tableLabel) {
    const searchIn = resolvedRoom ? allRooms.filter((r) => r.id === resolvedRoom.id) : allRooms
    outer: for (const r of searchIn) {
      for (const t of r.tables ?? []) {
        if ((t.label || t.id) === order.tableLabel) {
          resolvedTable = { id: t.id, label: order.tableLabel }
          if (!resolvedRoom) resolvedRoom = { id: r.id, name: r.name }
          break outer
        }
      }
    }
    if (!resolvedTable) resolvedTable = { id: null, label: order.tableLabel }
  }
  orderState.selectedRoom  = resolvedRoom
  orderState.selectedTable = resolvedTable

  // Map stored items → OrderItem format
  orderState.items = (order.items ?? []).map((it) => ({
    cartId: `edit-${Math.random().toString(36).slice(2)}`,
    itemId: it.itemId ?? '',
    name: it.dishName ?? it.name ?? '',
    priceCents: it.priceCents ?? 0,
    qty: it.quantity ?? 1,
    modifiers: it.modifiers ?? [],
    note: it.specialInstructions ?? it.note ?? '',
    course: null,
  }))

  // Extract kitchen note from the notes field (before the first " | Table:" segment)
  const rawNotes = order.notes ?? ''
  const tableNotePattern = / \| Table:.*$/
  orderState.kitchenNote = rawNotes.replace(tableNotePattern, '').trim()

  // Update the name input
  const nameInput = document.getElementById('oe-customer-name')
  if (nameInput) nameInput.value = orderState.customerName

  const noteInput = document.getElementById('oe-kitchen-note')
  if (noteInput) noteInput.value = orderState.kitchenNote

  // Show editing banner
  const banner = document.getElementById('oe-edit-banner')
  const orderIdEl = document.getElementById('oe-edit-order-id')
  if (banner) banner.hidden = false
  if (orderIdEl) orderIdEl.textContent = `#${order.id.slice(-8).toUpperCase()}`

  // Update order type pills
  document.querySelectorAll('.oe-type-pill').forEach((pill) => {
    const active = pill.dataset.type === orderState.orderType
    pill.classList.toggle('active', active)
    pill.setAttribute('aria-pressed', String(active))
  })

  // Update fire button label
  const fireBtn = document.getElementById('oe-fire-btn')
  if (fireBtn) fireBtn.textContent = '🔥 Update Order'

  _renderTableGrid()
  _renderCategoryTabs()
  _renderItemsGrid()
  _renderOrderSummary()
  _renderTotals()
}

/**
 * Bind the "Cancel Edit" button in the editing banner.
 */
function _bindEditCancelButton() {
  const btn = document.getElementById('oe-edit-cancel-btn')
  if (!btn) return
  btn.addEventListener('click', () => {
    _unlockEditingOrder()
    _resetOrder()
  })
}

// ---------------------------------------------------------------------------
// Order lock helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget unlock of the currently-editing order. */
function _unlockEditingOrder() {
  const orderId = orderState.editingOrderId
  if (!orderId) return
  const merchantId = window.state?.merchantId
  const employeeId = window.currentEmployee?.id
  if (!merchantId || !employeeId) return
  // Best-effort — don't await; server TTL is the safety net
  window.api(`/api/merchants/${merchantId}/orders/${orderId}/lock`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId }),
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Expose to dashboard.js
// ---------------------------------------------------------------------------

window.initOrderEntry = initOrderEntry
window.renderOrderEntry = renderOrderEntry
window.loadOrderIntoEntry = loadOrderIntoEntry
window.resetOrderEntry = _resetOrder
window.isEditingOrder    = () => !!orderState.editingOrderId
window.getEditingOrderId = () => orderState.editingOrderId
