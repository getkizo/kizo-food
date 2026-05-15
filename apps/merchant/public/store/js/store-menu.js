/**
 * store-menu.js — Menu rendering + category hours filtering
 *
 * Exposes: window.StoreMenu = { render }
 *
 * Hours filtering is purely client-side (no server round trip):
 *   - hoursStart / hoursEnd: HH:MM window
 *   - availableDays: int[] (0=Sun … 6=Sat); null = all days
 *   - blackoutDates: string[] (MM-DD); null = none
 * Thanksgiving (4th Thu of Nov) is computed dynamically.
 */

;(function () {
  'use strict'

  // ---------------------------------------------------------------------------
  // Category availability — client-side time/day/holiday filter
  // ---------------------------------------------------------------------------

  /**
   * Returns the 4th Thursday of November for a given year (Thanksgiving US).
   * @param {number} year
   * @returns {string} MM-DD string, e.g. "11-28"
   */
  function thanksgivingDate(year) {
    // Find the first Thursday (dayOfWeek 4) of November, then +21 days = 4th
    const nov1 = new Date(year, 10, 1)          // Nov 1 (month is 0-indexed)
    const firstThursday = ((4 - nov1.getDay() + 7) % 7) || 7
    const date = new Date(year, 10, firstThursday + 21)
    const mm   = String(date.getMonth() + 1).padStart(2, '0')
    const dd   = String(date.getDate()).padStart(2, '0')
    return `${mm}-${dd}`
  }

  /**
   * Returns a Date-like object representing "now" in the merchant's timezone.
   * Uses Intl.DateTimeFormat parts to extract the wall-clock time components.
   * Falls back to browser local time if the timezone is invalid or unsupported.
   * @param {string} [timezone]  IANA timezone string, e.g. 'America/Los_Angeles'
   * @returns {{ day: number, time: number, year: number, mm: string, dd: string }}
   */
  function getMerchantNow(timezone) {
    const now = new Date()
    try {
      if (timezone) {
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          weekday: 'short',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
        const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
        const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
        const day  = dayMap[parts.weekday] ?? now.getDay()
        const hour = parts.hour === '24' ? 0 : parseInt(parts.hour, 10)
        const min  = parseInt(parts.minute, 10)
        const time = hour * 60 + min
        const year = parseInt(parts.year, 10)
        const mm   = parts.month
        const dd   = parts.day
        return { day, time, year, mm, dd }
      }
    } catch (_) { /* fall through to browser local */ }
    // Browser local time fallback
    return {
      day:  now.getDay(),
      time: now.getHours() * 60 + now.getMinutes(),
      year: now.getFullYear(),
      mm:   String(now.getMonth() + 1).padStart(2, '0'),
      dd:   String(now.getDate()).padStart(2, '0'),
    }
  }

  /**
   * Returns true if the given category is available right now.
   * @param {{ hoursStart, hoursEnd, availableDays, blackoutDates }} category
   * @param {string} [timezone]  Merchant IANA timezone (from profile.timezone)
   * @returns {boolean}
   */
  function isCategoryAvailableNow(category, timezone) {
    const { day, time, year, mm, dd } = getMerchantNow(timezone)

    // Day-of-week check
    if (category.availableDays?.length) {
      if (!category.availableDays.includes(day)) return false
    }

    // Time window check
    if (category.hoursStart && category.hoursEnd) {
      const [sh, sm] = category.hoursStart.split(':').map(Number)
      const [eh, em] = category.hoursEnd.split(':').map(Number)
      if (time < sh * 60 + sm || time > eh * 60 + em) return false
    }

    // Blackout date check (MM-DD)
    if (category.blackoutDates?.length) {
      const mmdd = `${mm}-${dd}`

      const blackouts = [
        ...category.blackoutDates,
        thanksgivingDate(year),   // auto-include Thanksgiving
      ]
      if (blackouts.includes(mmdd)) return false
    }

    return true
  }

  // ---------------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------------

  function formatCents(cents) {
    return '$' + (cents / 100).toFixed(2)
  }

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const CUISINE_EMOJI = {
    thai:    '🍜',
    chinese: '🥡',
    japanese:'🍣',
    korean:  '🍱',
    italian: '🍕',
    mexican: '🌮',
    indian:  '🍛',
    american:'🍔',
    bbq:     '🥩',
    seafood: '🦞',
    vegan:   '🥗',
    default: '🍽️',
  }

  function cuisineEmoji(types) {
    if (!types?.length) return CUISINE_EMOJI.default
    const match = Object.keys(CUISINE_EMOJI).find((k) => types.includes(k))
    return match ? CUISINE_EMOJI[match] : CUISINE_EMOJI.default
  }

  /**
   * Returns whether the store is open right now, and a human-readable label
   * for the next opening time (null when the store is currently open).
   * @param {object} profile  merchant profile from /api/store/profile
   * @returns {{ isOpen: boolean, nextOpenLabel: string|null }}
   */
  /**
   * Returns true if the given YYYY-MM-DD date string falls within any scheduled closure.
   * @param {string} isoDate  e.g. '2026-04-05'
   * @param {Array}  closures array of { startDate, endDate } from profile.scheduledClosures
   */
  function isDateClosed(isoDate, closures) {
    if (!closures?.length) return false
    return closures.some((c) => isoDate >= c.startDate && isoDate <= c.endDate)
  }

  function getStoreOpenStatus(profile) {
    if (!profile?.businessHours?.length) return { isOpen: true, nextOpenLabel: null }

    const now = getMerchantNow(profile.timezone)

    // Build today's YYYY-MM-DD in the merchant's timezone
    const todayLocal = new Date().toLocaleDateString('sv', { timeZone: profile.timezone || 'UTC' })

    // Check scheduled closure for today
    if (isDateClosed(todayLocal, profile.scheduledClosures)) {
      // Find next non-closed opening day
      const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      for (let daysAhead = 1; daysAhead <= 14; daysAhead++) {
        const targetDate = new Date()
        targetDate.setDate(targetDate.getDate() + daysAhead)
        const targetIso = targetDate.toLocaleDateString('sv', { timeZone: profile.timezone || 'UTC' })
        if (isDateClosed(targetIso, profile.scheduledClosures)) continue
        const targetDay = targetDate.getDay()
        const daySlots  = profile.businessHours
          .filter((h) => h.dayOfWeek === targetDay && !h.isClosed)
          .sort((a, b) => a.openTime.localeCompare(b.openTime))
        if (!daySlots.length) continue
        const [oh, om] = daySlots[0].openTime.split(':').map(Number)
        const d = new Date()
        d.setHours(oh, om, 0, 0)
        const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        const label = daysAhead === 1 ? `tomorrow at ${timeStr}` : `${DAY_NAMES[targetDay]} at ${timeStr}`
        return { isOpen: false, nextOpenLabel: label }
      }
      return { isOpen: false, nextOpenLabel: null }
    }

    // Check whether we fall inside any open slot today
    const todaySlots = profile.businessHours.filter((h) => h.dayOfWeek === now.day && !h.isClosed)
    for (const slot of todaySlots) {
      const [oh, om] = slot.openTime.split(':').map(Number)
      const [ch, cm] = slot.closeTime.split(':').map(Number)
      if (now.time >= oh * 60 + om && now.time < ch * 60 + cm) {
        return { isOpen: true, nextOpenLabel: null }
      }
    }

    // Find next future opening — scan up to 7 days ahead (including later today)
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
      const targetDate = new Date()
      targetDate.setDate(targetDate.getDate() + daysAhead)
      const targetIso = targetDate.toLocaleDateString('sv', { timeZone: profile.timezone || 'UTC' })
      if (daysAhead > 0 && isDateClosed(targetIso, profile.scheduledClosures)) continue

      const targetDay = (now.day + daysAhead) % 7
      const daySlots  = profile.businessHours
        .filter((h) => h.dayOfWeek === targetDay && !h.isClosed)
        .sort((a, b) => a.openTime.localeCompare(b.openTime))

      for (const slot of daySlots) {
        const [oh, om] = slot.openTime.split(':').map(Number)
        const openMins = oh * 60 + om
        // When checking today, only count openings still in the future
        if (daysAhead === 0 && openMins <= now.time) continue

        // Format the opening time as "9:00 AM"
        const d = new Date()
        d.setHours(oh, om, 0, 0)
        const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

        let label
        if (daysAhead === 0)      label = `today at ${timeStr}`
        else if (daysAhead === 1) label = `tomorrow at ${timeStr}`
        else                      label = `${DAY_NAMES[targetDay]} at ${timeStr}`

        return { isOpen: false, nextOpenLabel: label }
      }
    }

    return { isOpen: false, nextOpenLabel: null }
  }

  function hoursLabel(profile) {
    if (!profile?.businessHours?.length) return ''
    const now   = new Date()
    const today = now.getDay()
    const time  = now.getHours() * 60 + now.getMinutes()

    const slots = profile.businessHours.filter((h) => h.dayOfWeek === today && !h.isClosed)
    if (!slots.length) return 'Closed today'

    const [open] = slots
    const [oh, om] = open.openTime.split(':').map(Number)
    const [ch, cm] = open.closeTime.split(':').map(Number)
    const openMin  = oh * 60 + om
    const closeMin = ch * 60 + cm

    if (time < openMin) return `Opens at ${open.openTime}`
    if (time >= closeMin) return 'Closed now'
    return `Open until ${open.closeTime}`
  }

  // ---------------------------------------------------------------------------
  // Header rendering
  // ---------------------------------------------------------------------------

  function renderHeader(profile) {
    // Banner
    const bannerEl = document.getElementById('store-banner')
    const bannerImg = document.getElementById('store-banner-img')
    if (profile.bannerUrl && bannerImg) {
      bannerImg.src    = profile.bannerUrl
      bannerImg.alt    = profile.name
      bannerImg.hidden = false
      if (bannerEl) bannerEl.style.background = 'transparent'
    }

    // Logo
    const logoEl = document.getElementById('store-logo')
    if (profile.logoUrl && logoEl) {
      logoEl.src    = profile.logoUrl
      logoEl.alt    = profile.name
      logoEl.hidden = false
    }

    // Name
    const nameEl = document.getElementById('store-name')
    if (nameEl) nameEl.textContent = profile.name

    // Hours badge
    const hoursEl = document.getElementById('store-hours-badge')
    if (hoursEl) hoursEl.textContent = hoursLabel(profile)

    // Page title
    document.title = `${profile.name} — Order Online`
  }

  // ---------------------------------------------------------------------------
  // Menu rendering
  // ---------------------------------------------------------------------------

  /** @type {Map<string, number>} dish name → rank (1-based) */
  let _topDishesMap = new Map()

  function renderMenu(menu, onItemClick, timezone, topDishes) {
    // Build lookup map: dish name (lower-case) → rank
    _topDishesMap = new Map()
    if (topDishes?.length) {
      topDishes.forEach(function (d) { _topDishesMap.set(d.name.toLowerCase(), d.rank) })
    }

    const nav      = document.getElementById('category-nav')
    const body     = document.getElementById('menu-body')
    const emptyMsg = document.getElementById('menu-empty')

    if (!nav || !body) return

    // Filter: only categories that are available right now (with items).
    // __popular__ skips the category-level check, but its items still carry
    // their parent category's time restrictions — filter those individually.
    const visible = menu.filter(
      (cat) => cat.id === '__popular__' || isCategoryAvailableNow(cat, timezone)
    ).map((cat) => {
      if (cat.id !== '__popular__') return cat
      return {
        ...cat,
        items: cat.items.filter((item) => isCategoryAvailableNow(item, timezone)),
      }
    }).filter((cat) => cat.items.length > 0)

    if (visible.length === 0) {
      if (emptyMsg) emptyMsg.hidden = false
      nav.innerHTML  = ''
      body.innerHTML = ''
      return
    }
    if (emptyMsg) emptyMsg.hidden = true

    // Category pills — no inline onclick (CSP disallows inline handlers)
    nav.innerHTML = visible.map((cat) => `
      <button class="category-pill" data-cat="${cat.id}">
        ${escHtml(cat.name)}
      </button>
    `).join('')

    // Wire via event delegation (registered once per render, idempotent guard below)
    if (!nav._pillsWired) {
      nav._pillsWired = true
      nav.addEventListener('click', (e) => {
        const pill = e.target.closest('.category-pill')
        if (pill?.dataset.cat) scrollToCategory(pill.dataset.cat)
      })
    }

    // Menu sections
    const sections = visible.map((cat) => `
      <section class="menu-section" id="cat-${cat.id}" data-cat="${cat.id}">
        <h2 class="menu-section-title">${escHtml(cat.name)}</h2>
        <div class="menu-item-grid">
          ${cat.items.map((item) => renderItemCard(item)).join('')}
        </div>
      </section>
    `).join('')

    body.innerHTML = sections

    // Wire item card clicks and keyboard activation.
    // Cards use role="button" (div), so Enter/Space must be handled explicitly.
    body.querySelectorAll('.menu-item-card').forEach((card) => {
      const activate = () => {
        const itemId = card.dataset.itemId
        let found = null
        let foundCat = null
        for (const cat of menu) {
          if (cat.id === '__popular__') continue
          const match = cat.items.find((i) => i.id === itemId)
          if (match) { found = match; foundCat = cat; break }
        }
        if (found) onItemClick({ ...found, categoryName: foundCat.name })
      }
      card.addEventListener('click', activate)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
      })
    })

    // Activate first pill
    activatePill(visible[0]?.id)

    // Intersection observer to update active pill on scroll
    wireScrollSpy(visible)

    // Proactively cache all menu item images so they're available offline.
    // Only runs once per page load — subsequent BROWSING renders are no-ops.
    precacheImages(visible)
  }

  let _imagesCached = false
  function precacheImages(categories) {
    if (_imagesCached) return
    _imagesCached = true
    const urls = categories.flatMap((cat) => cat.items).map((item) => item.imageUrl).filter(Boolean)
    urls.forEach((url) => fetch(url).catch(() => {}))
  }

  const _VESSEL_SVG = {
    glass: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8l-2.5 8a3.5 3.5 0 01-3 0L8 3z"/><line x1="12" y1="14" x2="12" y2="20"/><line x1="9" y1="20" x2="15" y2="20"/></svg>`,
    bottle: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3h4v2.5l2.5 4V19a1 1 0 01-1 1H8.5a1 1 0 01-1-1V9.5L10 5.5V3z"/></svg>`,
    carafe: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 3h4v2l1 2c1 2 2 3 2 5v8a1 1 0 01-1 1H7a1 1 0 01-1-1v-8c0-2 1-3 2-5l1-2V3z"/><path d="M15 7h2a1 1 0 011 1v1"/></svg>`,
  }

  function _getDrinkMeta(name) {
    const n = name.toLowerCase()
    let vessel = null
    if (n.includes('carafe'))       vessel = 'carafe'
    else if (n.includes('bottle'))  vessel = 'bottle'
    else if (n.includes('glass'))   vessel = 'glass'

    let brand = null
    if (n.includes('space dust'))   brand = 'space-dust'
    else if (n.includes('singha'))  brand = 'singha'
    else if (n.includes('sapporo')) brand = 'sapporo'
    else if (n.includes('heineken'))brand = 'heineken'

    return { vessel, brand }
  }

  const _VESSEL_LABEL = { glass: 'Glass', bottle: 'Bottle', carafe: 'Carafe' }
  const _BRAND_LABEL  = { singha: 'Singha', sapporo: 'Sapporo', heineken: 'Heineken', 'space-dust': 'Space Dust' }

  function _drinkMetaBadges(item) {
    const { vessel, brand } = _getDrinkMeta(item.name)
    if (!vessel && !brand) return ''
    const vesselHtml = vessel
      ? `<span class="vessel-badge" aria-label="${_VESSEL_LABEL[vessel]}">${_VESSEL_SVG[vessel]}${_VESSEL_LABEL[vessel]}</span>`
      : ''
    const brandHtml = brand
      ? `<span class="brand-badge ${brand}" aria-label="${_BRAND_LABEL[brand]}">${_BRAND_LABEL[brand]}</span>`
      : ''
    return `<div class="drink-meta">${vesselHtml}${brandHtml}</div>`
  }

  function renderItemCard(item) {
    const likedRank = _topDishesMap.get(item.name.toLowerCase())
    const mostLikedBadge = likedRank
      ? `<span class="most-liked-badge">Most Liked #${likedRank}</span>` : ''

    const popularBadge = item.isPopular && !likedRank
      ? `<span class="popular-badge">Popular</span>` : ''

    const photo = item.imageUrl
      ? `<img class="item-photo" src="${item.imageUrl}" alt="${escHtml(item.name)}" loading="lazy">`
      : `<div class="item-photo-placeholder" aria-hidden="true">🍽️</div>`

    const tags = (item.dietaryTags || []).map(
      (t) => `<span class="dietary-tag ${t}" aria-label="${t.replace('_', ' ')}">${t.replace('_', ' ')}</span>`
    ).join('')

    return `
      <div class="menu-item-card" data-item-id="${item.id}" tabindex="0" role="button" aria-label="${escHtml(item.name)}">
        ${mostLikedBadge}${popularBadge}
        ${photo}
        <div class="item-card-body">
          <p class="item-name">${escHtml(item.name)}</p>
          ${_drinkMetaBadges(item)}
          <p class="item-price">${formatCents(item.priceCents)}</p>
          ${item.description ? `<p class="item-desc">${escHtml(item.description)}</p>` : ''}
          ${tags ? `<div class="dietary-tags">${tags}</div>` : ''}
        </div>
      </div>
    `
  }

  // ---------------------------------------------------------------------------
  // Category pill scroll spy
  // ---------------------------------------------------------------------------

  let scrollObserver = null

  function wireScrollSpy(categories) {
    if (scrollObserver) scrollObserver.disconnect()

    scrollObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const catId = entry.target.dataset.cat
            activatePill(catId)
            break
          }
        }
      },
      { rootMargin: '-56px 0px -60% 0px', threshold: 0 }
    )

    categories.forEach((cat) => {
      const section = document.getElementById(`cat-${cat.id}`)
      if (section) scrollObserver.observe(section)
    })
  }

  function activatePill(catId) {
    const nav = document.getElementById('category-nav')
    if (!nav) return
    nav.querySelectorAll('.category-pill').forEach((pill) => {
      const active = pill.dataset.cat === catId
      pill.classList.toggle('active', active)
      if (active) {
        pill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
      }
    })
  }

  function scrollToCategory(catId) {
    const el = document.getElementById(`cat-${catId}`)
    if (!el) return
    // Measure the actual bottom of the sticky category nav so the section heading
    // appears just below it, accounting for the active-order bar height dynamically.
    const navEl = document.getElementById('category-nav')
    const navBottom = navEl ? navEl.getBoundingClientRect().bottom : 0
    const elTop = el.getBoundingClientRect().top
    window.scrollBy({ top: elTop - navBottom, behavior: 'smooth' })
  }

  // ---------------------------------------------------------------------------
  // HTML escaping
  // ---------------------------------------------------------------------------

  function escHtml(str) {
    if (!str) return ''
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ---------------------------------------------------------------------------
  // Main render — called from SAM
  // ---------------------------------------------------------------------------

  let lastProfileSlug = null

  function render(model) {
    // Header (render once per merchant load)
    if (model.profile && model.profile.slug !== lastProfileSlug) {
      lastProfileSlug = model.profile.slug
      renderHeader(model.profile)
    }

    // Menu items (re-render in BROWSING; skip in ITEM — sheet overlays)
    if (model.appState === 'BROWSING') {
      renderMenu(model.menu, (item) => window.Store.actions.selectItem(item), model.profile?.timezone, model.topDishes)
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  window.StoreMenu = {
    render,
    scrollToCategory,
    isCategoryAvailableNow,
    getStoreOpenStatus,
  }

})()
