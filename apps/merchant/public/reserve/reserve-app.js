/**
 * Kizo Reserve — Customer-facing reservation booking app
 * Multi-step flow: Date → Time → Contact → Confirmation
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let _config = null      // { enabled, maxPartySize, advanceDays, cutoffMinutes, slotMinutes }
  let _profile = null     // { businessName, phoneNumber }
  let _partySize = 2
  let _selectedDate = null  // 'YYYY-MM-DD'
  let _selectedTime = null  // 'HH:MM'

  // Bot-detection: record page load time; real users take > 2.5 s to fill the form
  const _bootTime = Date.now()

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  function show(id)  { const el = document.getElementById(id); if (el) el.hidden = false }
  function hide(id)  { const el = document.getElementById(id); if (el) el.hidden = true  }
  function el(id)    { return document.getElementById(id) }
  function setText(id, text) { const e = el(id); if (e) e.textContent = text }

  /** Escape HTML special characters to prevent XSS in innerHTML contexts */
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
  }

  /** Format 'YYYY-MM-DD' to display string */
  function formatDate(iso) {
    // Parse as local date to avoid UTC offset shift
    const [y, m, d] = iso.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  }

  /** Format 'HH:MM' 24h to 12h display */
  function formatTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const hour = h % 12 || 12
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`
  }

  /** Build a YYYY-MM-DD string for a local date offset by `daysAhead` */
  function localIso(daysAhead = 0) {
    const d = new Date()
    d.setDate(d.getDate() + daysAhead)
    return d.toISOString().slice(0, 10)
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function boot() {
    try {
      // Load config and merchant profile in parallel
      const [cfgRes, profRes] = await Promise.all([
        fetch('/api/store/reservations/config'),
        fetch('/api/store/profile'),
      ])
      if (!cfgRes.ok || !profRes.ok) throw new Error('Load failed')
      _config  = await cfgRes.json()
      const prof = await profRes.json()
      _profile = { businessName: prof.name, phoneNumber: prof.phoneNumber }
    } catch {
      hide('rv-loading')
      show('rv-disabled')
      el('rv-disabled-msg').textContent = 'Unable to load reservation info. Please try again later.'
      return
    }

    hide('rv-loading')

    if (!_config.enabled) {
      show('rv-disabled')
      return
    }

    // Update heading with business name
    setText('rv-business-name', `Reserve at ${_profile.businessName}`)

    // Clamp party size to max
    _partySize = Math.min(_partySize, _config.maxPartySize - 1)
    renderPartySize()
    renderDateGrid()

    show('rv-step-date')
  }

  // ---------------------------------------------------------------------------
  // Step 1: Date + Party Size
  // ---------------------------------------------------------------------------

  function renderPartySize() {
    setText('rv-party-display', String(_partySize))
    el('rv-party-dec').disabled = _partySize <= 1
    el('rv-party-inc').disabled = _partySize >= _config.maxPartySize

    const maxMsg = el('rv-party-max-msg')
    if (_partySize >= _config.maxPartySize) {
      maxMsg.textContent = `For parties of ${_config.maxPartySize} or more, please call us.`
      maxMsg.hidden = false
    } else {
      maxMsg.hidden = true
    }
  }

  el('rv-party-dec')?.addEventListener('click', () => {
    if (!_config) return
    if (_partySize > 1) { _partySize--; renderPartySize(); renderDateGrid() }
  })
  el('rv-party-inc')?.addEventListener('click', () => {
    if (!_config) return
    if (_partySize < _config.maxPartySize) { _partySize++; renderPartySize(); renderDateGrid() }
  })

  function renderDateGrid() {
    const grid = el('rv-date-grid')
    if (!grid) return
    grid.innerHTML = ''

    // Check if party exceeds max — redirect to "please call"
    if (_partySize >= _config.maxPartySize) {
      hide('rv-step-date')
      show('rv-large-party')
      setText('rv-large-size', String(_config.maxPartySize))
      const ph = el('rv-call-phone')
      if (ph && _profile.phoneNumber) {
        ph.textContent = ''
        const a = document.createElement('a')
        a.href = 'tel:' + String(_profile.phoneNumber).replace(/[^0-9+()\-. ]/g, '')
        a.textContent = _profile.phoneNumber
        a.style.color = 'inherit'
        ph.appendChild(a)
      }
      return
    } else {
      hide('rv-large-party')
      show('rv-step-date')
    }

    const today = localIso(0)
    for (let i = 0; i < _config.advanceDays; i++) {
      const iso = localIso(i)
      const [y, m, d] = iso.split('-').map(Number)
      const date = new Date(y, m - 1, d)

      const chip = document.createElement('button')
      chip.type = 'button'
      const todayClass = i === 0 ? ' rv-today' : i === 1 ? ' rv-tomorrow' : ''
      chip.className = `rv-date-chip${todayClass}${iso === _selectedDate ? ' selected' : ''}`
      chip.dataset.date = iso
      chip.setAttribute('aria-pressed', String(iso === _selectedDate))

      const dayLabel = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : date.toLocaleDateString(undefined, { weekday: 'short' })
      const dateNum  = date.getDate()
      const monLabel = date.toLocaleDateString(undefined, { month: 'short' })

      chip.innerHTML = `
        <div class="rv-day">${dayLabel}</div>
        <div class="rv-date">${dateNum}</div>
        <div class="rv-month">${monLabel}</div>
      `
      chip.addEventListener('click', () => {
        _selectedDate = iso
        renderDateGrid()
      })
      grid.appendChild(chip)
    }
  }

  el('rv-date-next')?.addEventListener('click', () => {
    if (!_selectedDate) {
      // Auto-select today
      _selectedDate = localIso(0)
      renderDateGrid()
    }
    goToTimeStep()
  })

  // ---------------------------------------------------------------------------
  // Step 2: Time slots
  // ---------------------------------------------------------------------------

  async function goToTimeStep() {
    hide('rv-step-date')
    show('rv-step-time')
    show('rv-slots-loading')
    hide('rv-slots-empty')
    el('rv-slots-grid').innerHTML = ''

    // Heading
    setText('rv-time-heading', `${_partySize} guests · ${formatDate(_selectedDate)}`)

    try {
      const res = await fetch(`/api/store/reservations/slots?date=${_selectedDate}`)
      if (!res.ok) throw new Error('Failed to load slots')
      const data = await res.json()
      hide('rv-slots-loading')
      renderSlots(data.slots ?? [])
    } catch {
      hide('rv-slots-loading')
      el('rv-slots-empty').textContent = 'Unable to load available times. Please try again.'
      show('rv-slots-empty')
    }
  }

  function renderSlots(slots) {
    const grid = el('rv-slots-grid')
    const available = slots.filter((s) => s.available)

    if (available.length === 0) {
      show('rv-slots-empty')
      return
    }

    slots.forEach((slot) => {
      if (!slot.available) return
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = `rv-slot-chip${slot.time === _selectedTime ? ' selected' : ''}`
      chip.textContent = formatTime(slot.time)
      chip.dataset.time = slot.time
      chip.setAttribute('aria-pressed', String(slot.time === _selectedTime))
      chip.addEventListener('click', () => {
        _selectedTime = slot.time
        grid.querySelectorAll('.rv-slot-chip').forEach((c) => {
          c.classList.toggle('selected', c.dataset.time === _selectedTime)
          c.setAttribute('aria-pressed', String(c.dataset.time === _selectedTime))
        })
        // Advance to contact step after short delay
        setTimeout(goToContactStep, 200)
      })
      grid.appendChild(chip)
    })
  }

  el('rv-back-to-date')?.addEventListener('click', () => {
    hide('rv-step-time')
    show('rv-step-date')
  })

  // ---------------------------------------------------------------------------
  // Step 3: Contact info
  // ---------------------------------------------------------------------------

  function goToContactStep() {
    hide('rv-step-time')
    show('rv-step-contact')
    hide('rv-contact-error')
    renderSummaryBar()
  }

  function renderSummaryBar() {
    const bar = el('rv-summary-bar')
    if (!bar) return
    bar.innerHTML = `
      <span>📅 ${formatDate(_selectedDate)}</span>
      <span>🕐 ${formatTime(_selectedTime)}</span>
      <span>👥 ${_partySize} guest${_partySize > 1 ? 's' : ''}</span>
    `
  }

  el('rv-back-to-time')?.addEventListener('click', () => {
    hide('rv-step-contact')
    show('rv-step-time')
  })

  el('rv-submit-btn')?.addEventListener('click', submitReservation)

  async function submitReservation() {
    const nameVal  = el('rv-name')?.value.trim()
    const phoneVal = el('rv-phone')?.value.trim()
    const emailVal = el('rv-email')?.value.trim()
    const notesVal = el('rv-notes')?.value.trim()

    if (!nameVal) {
      el('rv-contact-error').textContent = 'Please enter your name.'
      show('rv-contact-error')
      el('rv-name')?.focus()
      return
    }

    hide('rv-contact-error')
    const btn = el('rv-submit-btn')
    btn.disabled = true
    btn.textContent = 'Confirming…'

    // Bot-detection checks — silently fake success so bots get no useful signal
    const honeypotFilled = (el('rv-hp')?.value ?? '') !== ''
    const tooFast = Date.now() - _bootTime < 2500
    if (honeypotFilled || tooFast) {
      // Fake a short network delay then show the confirmation screen
      await new Promise(r => setTimeout(r, 800 + Math.random() * 400))
      showConfirmation(null)
      return
    }

    try {
      const res = await fetch('/api/store/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName:  nameVal,
          customerPhone: phoneVal || null,
          customerEmail: emailVal || null,
          partySize:     _partySize,
          date:          _selectedDate,
          time:          _selectedTime,
          notes:         notesVal || null,
          _hp:           el('rv-hp')?.value ?? '',
        }),
      })

      if (res.status === 429) {
        throw new Error('Too many requests. Please wait a moment and try again.')
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to confirm reservation.')
      }

      const data = await res.json()
      showConfirmation(data.confirmationCode)
    } catch (err) {
      el('rv-contact-error').textContent = err.message || 'Something went wrong. Please try again.'
      show('rv-contact-error')
      btn.disabled = false
      btn.textContent = 'Confirm Reservation'
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: Confirmation
  // ---------------------------------------------------------------------------

  function showConfirmation(code) {
    hide('rv-step-contact')
    show('rv-step-confirm')

    el('rv-confirm-details').innerHTML = `
      <div><strong>${esc(formatDate(_selectedDate))}</strong> at <strong>${esc(formatTime(_selectedTime))}</strong></div>
      <div>Party of <strong>${esc(_partySize)}</strong></div>
      ${code ? `<div style="margin-top:12px;font-size:0.8rem;color:#999">Confirmation code: <strong style="font-size:1rem;color:#f0f0f0;letter-spacing:0.1em">${esc(code)}</strong></div>` : ''}
    `
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  boot()
})()
