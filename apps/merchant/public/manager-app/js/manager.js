/**
 * manager.js — Manager PWA main module (Phase 3)
 *
 * SAM states:
 *   LOADING → AUTH_CHECK → UNAUTHENTICATED | ACCEPT | AUTHED
 *   AUTHED sub-states: RECEIPTS | REPORTS | RECEIPT_DETAIL | REPORT_DETAIL
 *
 * Depends on: window.ManagerReceipts (manager-receipts.js)
 *             window.ManagerReports  (manager-reports.js)
 */
;(function () {
  'use strict'

  // ── Constants ─────────────────────────────────────────────────────────────

  const PAGE_SIZE = 20

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * @type {'LOADING'|'AUTH_CHECK'|'UNAUTHENTICATED'|'ACCEPT'|
   *         'RECEIPTS'|'REPORTS'|'RECEIPT_DETAIL'|'REPORT_DETAIL'|'SYNC'|'INGREDIENTS'}
   */
  let _screen = 'LOADING'

  /** @type {{ accessToken: string, merchantId: string, role: string, email: string, name: string } | null} */
  let _auth    = null

  /** @type {{ onsite: boolean } | null} */
  let _location = null

  /** @type {{ token: string, email: string, merchantName: string } | null} */
  let _invite  = null

  /** @type {Array} current server receipt list */
  let _receipts = []

  /** @type {number} pending queue count */
  let _pendingCount = 0

  /** @type {string|null} receipt id currently in RECEIPT_DETAIL */
  let _detailId = null

  let _tokenRefreshTimer = null

  // Phase 3 — capture staging
  /** @type {File[]} files staged for upload (not yet queued) */
  let _captureFiles = []
  /** @type {string[]} Object URL per staged file */
  let _captureUrls  = []
  /** @type {string} vendor selected in the supplier dropdown ('' = let OCR decide) */
  let _captureVendor = ''

  // Phase 3 — receipt list filter + pagination
  let _page           = 0
  let _filterVendor   = ''
  let _filterDateFrom = ''
  let _filterDateTo   = ''
  /** @type {Array} latest IDB snapshot (all statuses) */
  let _idbRows = []

  // Phase 4 — report detail
  /** @type {string|null} active report type key */
  let _reportType = null

  // Phase 5 — sync screen
  /** @type {Array} ingredient catalog for availability toggle */
  let _syncIngredients = []
  /** @type {boolean} loading indicator for sync screen */
  let _syncLoading = false

  // Ingredients price lookup
  /** @type {boolean} true when session was restored from cache due to IP block or offline */
  let _isOffsite   = false
  /** @type {string} current search query */
  let _ingQuery    = ''
  /** @type {number|null} debounce timer */
  let _ingDebounce = null
  /** Monotonically-increasing generation; stale async calls are discarded when this advances. */
  let _ingGen      = 0
  /** @type {{description:string, vendor:string, unit:string}|null} currently selected vendor+unit combo */
  let _ingSelected = null

  /** @type {Object} human-readable titles per report type */
  const _reportTypeTitles = {
    'cogs-trend':     'COGS Trend',
    'price-changes':  'Price Changes',
    'order-warnings': 'Order Warnings',
    'vendor-spend':   'Vendor Spend',
    'sales':          'Sales',
    'shifts':         'Shifts & Tips',
  }

  // Phase 3 — receipt review
  /** @type {Array|null} ingredient catalog for dropdowns */
  let _ingredients = []
  /** @type {Object|null} full data object for the open detail/review */
  let _currentReceiptData = null
  /** @type {Array|null} mutable line-item copies while reviewing */
  let _editedItems = null
  let _saving = false

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** @param {string} id @returns {HTMLElement|null} */
  const el = (id) => document.getElementById(id)

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function fmtDate(iso) {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return iso }
  }

  function fmtCurrency(n) {
    if (n == null) return '—'
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
  }

  // ── Auth / API ────────────────────────────────────────────────────────────

  /** Fetch wrapper that attaches Bearer token and handles 401 → refresh → retry. */
  async function apiFetch(path, opts = {}) {
    if (!_auth) throw new Error('Not authenticated')
    const headers = { ...(opts.headers ?? {}), Authorization: `Bearer ${_auth.accessToken}` }
    let res = await fetch(path, { ...opts, headers })
    if (res.status === 401) {
      const refreshed = await _refreshToken()
      if (!refreshed) return res
      headers.Authorization = `Bearer ${_auth.accessToken}`
      res = await fetch(path, { ...opts, headers })
    }
    return res
  }

  async function _refreshToken() {
    try {
      const refreshToken = localStorage.getItem('mgr_refresh_token')
      if (!refreshToken) { _signOut(); return false }
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      // 401 = refresh token expired/revoked → sign out.
      // 403 (IP block) or 5xx → can't reach server right now, keep session alive.
      if (res.status === 401) { _signOut(); return false }
      if (!res.ok) return false
      const data = await res.json()
      _auth = { ..._auth, accessToken: data.accessToken }
      localStorage.setItem('mgr_access_token', _auth.accessToken)
      await ManagerReceipts.refreshTokens(_auth.accessToken)
      _scheduleTokenRefresh()
      return true
    } catch {
      // Network error or IP block — keep session alive, let IDB serve cached data
      return false
    }
  }

  function _scheduleTokenRefresh() {
    clearTimeout(_tokenRefreshTimer)
    _tokenRefreshTimer = setTimeout(() => _refreshToken(), 20 * 60 * 60 * 1000) // 20 hours
  }

  function _signOut() {
    clearTimeout(_tokenRefreshTimer)
    _auth = null
    localStorage.removeItem('mgr_access_token')
    localStorage.removeItem('mgr_merchant_id')
    _screen = 'UNAUTHENTICATED'
    render()
  }

  /**
   * Returns a { fetch: cachedFetch, fromCache: () => bool } pair.
   * cachedFetch wraps apiFetch: caches successful GET responses in IDB and
   * serves them when the network is unavailable (offline or 403).
   * Used by report renderers so they transparently work offline.
   */
  function _makeCachedFetch() {
    let _usedCache = false
    const mgIng = typeof ManagerIngredients !== 'undefined' ? ManagerIngredients : null

    async function cachedFetch(path, opts = {}) {
      const isGet = !opts.method || opts.method.toUpperCase() === 'GET'
      try {
        const res = await apiFetch(path, opts)
        if (res.ok && isGet && mgIng) {
          res.clone().json()
            .then(d => mgIng.cacheStore('api:' + path, d))
            .catch(() => {})
        }
        return res
      } catch {
        if (isGet && mgIng) {
          const cached = await mgIng.loadCache('api:' + path).catch(() => null)
          if (cached != null) {
            _usedCache = true
            return new Response(JSON.stringify(cached), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
        }
        throw new Error('Network error')
      }
    }

    return { fetch: cachedFetch, fromCache: () => _usedCache }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    ManagerReceipts.registerServiceWorker()

    const params = new URLSearchParams(location.search)
    const inviteToken = params.get('token')

    if (inviteToken) {
      _screen = 'LOADING'
      render()
      try {
        const res = await fetch(`/api/manager/invites/validate?token=${encodeURIComponent(inviteToken)}`)
        if (res.ok) {
          const meta = await res.json()
          _invite = { token: inviteToken, email: meta.email, merchantName: meta.merchantName }
          _screen = 'ACCEPT'
        } else {
          _screen = 'UNAUTHENTICATED'
        }
      } catch { _screen = 'UNAUTHENTICATED' }
      render()
      return
    }

    const sessionToken = params.get('session')
    if (sessionToken) {
      // Clean token out of URL bar immediately
      history.replaceState(null, '', location.pathname)
      try {
        const sessRes = await fetch('/api/auth/oauth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token: sessionToken }),
        })
        if (sessRes.ok) {
          const sess = await sessRes.json()
          if (sess.tokens?.accessToken) {
            localStorage.setItem('mgr_access_token', sess.tokens.accessToken)
            if (sess.tokens.refreshToken) localStorage.setItem('mgr_refresh_token', sess.tokens.refreshToken)
          }
          if (sess.user?.merchantId) localStorage.setItem('mgr_merchant_id', sess.user.merchantId)
        }
      } catch { /* ignore */ }
    }

    const accessToken = localStorage.getItem('mgr_access_token')
    const merchantId  = localStorage.getItem('mgr_merchant_id')
    const meCacheRaw  = localStorage.getItem('mgr_me_cache')

    if (!accessToken) {
      _screen = 'UNAUTHENTICATED'
      render()
      return
    }

    // Optimistic boot: if we have a cached profile, open immediately in offline
    // mode so the user can search ingredient prices without waiting for the network.
    // The server check below runs in the background and upgrades to full mode if
    // the appliance is reachable, or signs out only on an explicit 401.
    if (meCacheRaw) {
      try {
        const cached = JSON.parse(meCacheRaw)
        _auth = { accessToken, merchantId: cached.merchantId ?? merchantId, role: cached.role, email: cached.email, name: cached.name }
        _isOffsite = true
        _screen = 'RECEIPTS'
        render()
        ManagerReceipts.startSync(_onQueueChange)
        _loadReceipts()
      } catch { /* malformed cache — fall through; AUTH_CHECK spinner shows */ }
    }

    // If we had no cache to restore, show the loading spinner while we wait.
    if (!_auth) {
      _screen = 'AUTH_CHECK'
      render()
    }

    // Background verification — upgrades the session or signs out on hard failure.
    try {
      const meRes = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!meRes.ok) {
        if (meRes.status === 401) {
          // Token definitively invalid — sign out even if we already showed offline mode.
          localStorage.removeItem('mgr_access_token')
          _auth = null
          _isOffsite = false
          _screen = 'UNAUTHENTICATED'
          render()
        }
        // 403 (IP block) or 5xx — stay wherever we are (offline mode or spinner).
        // If we showed the spinner (no cache), fall back to unauthenticated.
        if (!_auth) {
          _screen = 'UNAUTHENTICATED'
          render()
        }
        return
      }

      const me = await meRes.json()
      if (me.role !== 'manager' && me.role !== 'owner') {
        localStorage.removeItem('mgr_access_token')
        _auth = null
        _isOffsite = false
        _screen = 'UNAUTHENTICATED'
        render()
        return
      }

      // Server confirmed — upgrade to full authenticated mode.
      _auth = {
        accessToken,
        merchantId: me.merchantId ?? merchantId,
        role:       me.role,
        email:      me.email,
        name:       me.name ?? me.email,
      }
      _isOffsite = false
      localStorage.setItem('mgr_merchant_id', _auth.merchantId)
      // Refresh cache with latest profile from server
      localStorage.setItem('mgr_me_cache', JSON.stringify({ merchantId: _auth.merchantId, role: _auth.role, email: _auth.email, name: _auth.name }))
      _scheduleTokenRefresh()

      apiFetch('/api/manager/location-status')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) _location = d; _renderLocBanner() })
        .catch(() => {})

      _screen = 'RECEIPTS'
      render()

      ManagerReceipts.startSync(_onQueueChange)
      _loadReceipts()

      // Background prefetch for offline ingredient price lookup
      if (typeof ManagerIngredients !== 'undefined') {
        ManagerIngredients.prefetchSnapshot(apiFetch, _auth.merchantId).catch(() => {})
      }
    } catch {
      // Network error — if offline mode was already rendered, stay there.
      // If we were still on the spinner (no cache), go to unauthenticated.
      if (!_auth) {
        _screen = 'UNAUTHENTICATED'
        render()
      }
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  function signIn() {
    window.location.href = '/api/auth/oauth/google?next=/manager-app/'
  }

  function acceptInvite() {
    if (!_invite) return
    window.location.href = `/api/auth/oauth/google?invite_token=${encodeURIComponent(_invite.token)}&next=/manager-app/`
  }

  function navigate(screen) {
    if (screen === 'RECEIPTS') {
      _screen = 'RECEIPTS'
      render()
      _loadReceipts()
    } else if (screen === 'REPORTS') {
      _screen = 'REPORTS'
      render()
    } else if (screen === 'SYNC') {
      _screen = 'SYNC'
      render()
      _loadSyncIngredients()
    } else if (screen === 'INGREDIENTS') {
      _screen = 'INGREDIENTS'
      render()
      _renderIngredientsScreen()
    }
  }

  function openReceiptDetail(receiptId) {
    _detailId = receiptId
    _screen   = 'RECEIPT_DETAIL'
    render()
    _loadReceiptDetail(receiptId)
  }

  function openReportDetail(reportType) {
    _reportType = reportType
    _screen     = 'REPORT_DETAIL'
    render()
    _loadReportDetail()
  }

  async function _loadReportDetail() {
    if (!_auth || !_reportType) return
    const container = el('mg-screen-report-detail')
    if (!container) return
    const { merchantId } = _auth
    const { fetch: cachedFetch, fromCache } = _makeCachedFetch()
    const renderers = {
      'cogs-trend':     () => ManagerReports.renderCogs(container, cachedFetch, merchantId),
      'price-changes':  () => ManagerReports.renderPriceChanges(container, cachedFetch, merchantId),
      'order-warnings': () => ManagerReports.renderOrderWarnings(container, cachedFetch, merchantId),
      'vendor-spend':   () => ManagerReports.renderVendorSpend(container, cachedFetch, merchantId),
      'sales':          () => ManagerReports.renderSales(container, cachedFetch, merchantId),
      'shifts':         () => ManagerReports.renderShifts(container, cachedFetch, merchantId),
    }
    await renderers[_reportType]?.()
    if (fromCache()) {
      const banner = document.createElement('div')
      banner.className = 'mg-offline-banner'
      banner.textContent = 'Offline — showing cached data'
      container.prepend(banner)
    }
  }

  // ── Sync screen ───────────────────────────────────────────────────────────

  async function _loadSyncIngredients() {
    if (!_auth) return
    _syncLoading = true
    _renderSyncScreen()
    try {
      const res = await apiFetch(`/api/merchants/${_auth.merchantId}/ingredients`)
      if (res.ok) {
        const data = await res.json()
        _syncIngredients = data.ingredients ?? (Array.isArray(data) ? data : [])
      }
    } catch { /* render empty state */ }
    _syncLoading = false
    _renderSyncScreen()
  }

  async function _toggleIngredient(ingId, newAvailable) {
    // Optimistic update
    const idx = _syncIngredients.findIndex(i => i.id === ingId)
    if (idx >= 0) _syncIngredients[idx] = { ..._syncIngredients[idx], is_available: newAvailable ? 1 : 0 }
    try {
      const res = await apiFetch(
        `/api/merchants/${_auth.merchantId}/ingredients/${ingId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isAvailable: newAvailable ? 1 : 0 }),
        }
      )
      if (!res.ok) throw new Error(`${res.status}`)
    } catch (err) {
      // Revert
      if (idx >= 0) _syncIngredients[idx] = { ..._syncIngredients[idx], is_available: newAvailable ? 0 : 1 }
      _renderSyncScreen()
      _showListError('Update failed: ' + err.message)
    }
  }

  function _renderSyncScreen() {
    const container = el('mg-screen-sync')
    if (!container || _screen !== 'SYNC') return

    const onsite = _location ? _location.onsite !== false : true
    const locCls = onsite ? 'mg-location-card--onsite' : 'mg-location-card--offsite'
    const locLabel = onsite ? 'On-site' : 'Off-site'
    const locSub   = onsite
      ? 'POS sync is available'
      : 'Connect to the restaurant network to sync'

    if (_syncLoading) {
      container.innerHTML = `
        <div class="mg-location-card ${locCls}">
          <span class="mg-location-dot"></span>
          <div><p class="mg-location-label">${locLabel}</p><p class="mg-location-sub">${locSub}</p></div>
        </div>
        <div class="mg-loading-inline"><div class="mg-spinner"></div></div>`
      return
    }

    const tooltip = onsite ? '' : `title="You must be at the restaurant to sync with the POS."`

    /** @param {string} cat */
    const groupHtml = (cat) => {
      const items = _syncIngredients.filter(i => (i.category ?? 'other') === cat)
      if (!items.length) return ''
      const rowsHtml = items.map(ing => `
        <div class="mg-sync-row">
          <div class="mg-sync-info">
            <span class="mg-sync-name">${esc(ing.display_name || ing.name)}</span>
            <span class="mg-sync-category">${esc(ing.category ?? 'other')}</span>
          </div>
          <label class="mg-toggle" ${tooltip}>
            <input type="checkbox" class="mg-toggle-input"
                   data-ing-id="${esc(String(ing.id))}"
                   ${ing.is_available ? 'checked' : ''}
                   ${onsite ? '' : 'disabled'}>
            <span class="mg-toggle-thumb" aria-hidden="true"></span>
          </label>
        </div>`).join('')
      return `
        <div class="mg-sync-group">
          <h3 class="mg-sync-group-label">${esc(cat)}</h3>
          ${rowsHtml}
        </div>`
    }

    const allCategories = _syncIngredients.length > 0
      ? [...new Set(_syncIngredients.map(i => i.category || 'other'))].sort()
      : []

    const listHtml = allCategories.length
      ? allCategories.map(groupHtml).join('')
      : `<div class="mg-empty-state">
           <div class="mg-empty-icon">🧂</div>
           <p>No ingredients found.</p>
           <p class="mg-empty-sub">Add ingredients in the dashboard to manage availability.</p>
         </div>`

    container.innerHTML = `
      <div class="mg-location-card ${locCls}">
        <span class="mg-location-dot"></span>
        <div>
          <p class="mg-location-label">${locLabel}</p>
          <p class="mg-location-sub">${locSub}</p>
        </div>
      </div>
      <h2 class="mg-section-heading">Ingredient Availability</h2>
      <div class="mg-sync-list">${listHtml}</div>`
  }

  // ── Ingredients price lookup ──────────────────────────────────────────────

  /** Render the Prices screen shell (search box + results + chart). */
  function _renderIngredientsScreen() {
    const container = el('mg-screen-ingredients')
    if (!container) return
    container.innerHTML = `
      <div class="mg-ing-search-wrap">
        <label class="mg-ing-search-box" aria-label="Search ingredient">
          <svg class="mg-ing-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
            <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <input type="search" id="mg-ing-query" class="mg-ing-query"
                 placeholder="Search ingredient&hellip; e.g. broccoli"
                 autocomplete="off" spellcheck="false"
                 value="${esc(_ingQuery)}">
        </label>
        <p class="mg-ing-hint">Works offline &mdash; tap a result to see vendor price history</p>
      </div>
      <div id="mg-ing-results" class="mg-ing-results">
        <div class="mg-empty-state">
          <div class="mg-empty-icon">&#127991;</div>
          <p>Type an ingredient name to look up prices.</p>
        </div>
      </div>
      <div id="mg-ing-chart" class="mg-ing-chart-section"></div>`
    setTimeout(() => el('mg-ing-query')?.focus(), 80)
    if (_ingQuery) _doIngredientSearch()
    if (_ingSelected) _doIngredientChart(_ingSelected.description, _ingSelected.vendor, _ingSelected.unit)
  }

  /** Debounced handler — search IDB for matching (description, vendor, unit) combos. */
  async function _doIngredientSearch() {
    const gen = ++_ingGen        // capture generation; discard this call if a newer one fires
    const q   = _ingQuery.trim()
    const resultsEl = el('mg-ing-results')
    if (!resultsEl) return

    if (!q) {
      resultsEl.innerHTML = `
        <div class="mg-empty-state">
          <div class="mg-empty-icon">&#127991;</div>
          <p>Type an ingredient name to look up prices.</p>
        </div>`
      return
    }

    resultsEl.innerHTML = '<div class="mg-loading-inline"><div class="mg-spinner"></div></div>'

    // Search IDB snapshot (works offline); returns one row per (description, vendor, unit) combo
    const localItems = await ManagerIngredients.searchSnapshot(q)

    if (gen !== _ingGen) return

    if (!localItems.length) {
      resultsEl.innerHTML = `
        <div class="mg-empty-state">
          <p>No results for &ldquo;${esc(q)}&rdquo;.</p>
          <p class="mg-empty-sub">Upload receipts containing this ingredient to build history.</p>
        </div>`
      return
    }

    // Selectable cards — one per (description, vendor, unit) combination
    let html = '<div class="mg-ing-card-list">'
    for (const item of localItems) {
      const priceStr = item.lastPrice != null ? fmtCurrency(item.lastPrice) : '&mdash;'
      const unitStr  = item.unit ? ` / ${esc(item.unit)}` : ''
      const isSelected = _ingSelected &&
        _ingSelected.description === item.description &&
        (_ingSelected.vendor ?? '') === (item.vendor ?? '') &&
        (_ingSelected.unit   ?? '') === (item.unit   ?? '')
      html += `
        <div class="mg-ing-card${isSelected ? ' mg-ing-card--selected' : ''}"
             tabindex="0" role="button"
             aria-pressed="${isSelected ? 'true' : 'false'}"
             data-description="${esc(item.description)}"
             data-vendor="${esc(item.vendor ?? '')}"
             data-unit="${esc(item.unit ?? '')}">
          <div class="mg-ing-card-row">
            <span class="mg-ing-card-name">${esc(item.description)}</span>
            <span class="mg-ing-card-price">${priceStr}<span class="mg-ing-card-unit">${unitStr}</span></span>
          </div>
          <div class="mg-ing-card-meta">
            ${item.vendor ? esc(item.vendor) : ''}${item.vendor && item.lastDate ? ' &middot; ' : ''}${fmtDate(item.lastDate)}
          </div>
        </div>`
    }
    html += '</div>'

    resultsEl.innerHTML = html
  }

  /**
   * Fetch and render the 30-day price chart for a specific (description, vendor, unit) combo.
   * @param {string} description
   * @param {string} vendor
   * @param {string} unit
   */
  async function _doIngredientChart(description, vendor, unit) {
    _ingSelected = { description, vendor, unit }

    // Mark the selected card
    document.querySelectorAll('.mg-ing-card').forEach(c => {
      const sel = c.dataset.description === description &&
                  (c.dataset.vendor ?? '') === (vendor ?? '') &&
                  (c.dataset.unit   ?? '') === (unit   ?? '')
      c.classList.toggle('mg-ing-card--selected', sel)
      c.setAttribute('aria-pressed', String(sel))
    })

    const chartEl = el('mg-ing-chart')
    if (!chartEl) return
    chartEl.innerHTML = '<div class="mg-loading-inline"><div class="mg-spinner"></div></div>'

    if (!_auth) {
      chartEl.innerHTML = '<p class="mg-empty-sub" style="padding:1rem;text-align:center">Sign in to view chart.</p>'
      return
    }

    try {
      const data = await ManagerIngredients.fetchHistory(description, apiFetch, _auth.merchantId, vendor)
      const sparkHtml = _sparkline(data.history)
      const priceStr  = data.lastPrice != null ? fmtCurrency(data.lastPrice) : '&mdash;'
      const unitStr   = unit ? ` / ${esc(unit)}` : ''
      chartEl.innerHTML = `
        <div class="mg-ing-chart-card">
          <div class="mg-ing-chart-header">
            <div>
              <p class="mg-ing-chart-label">${esc(description)}<span class="mg-ing-chart-unit">${unitStr}</span></p>
              <p class="mg-ing-chart-price">${priceStr}</p>
              ${vendor ? `<p class="mg-ing-chart-vendor">${esc(vendor)} &middot; ${fmtDate(data.lastDate)}</p>` : ''}
            </div>
            <span class="mg-ing-live-badge">Live</span>
          </div>
          ${sparkHtml ? `
          <div class="mg-sparkline-wrap">
            ${sparkHtml}
            <div class="mg-sparkline-labels">
              <span>30 days ago</span>
              <span>Today</span>
            </div>
          </div>
          <p class="mg-ing-chart-caption">${data.history.length} purchase${data.history.length !== 1 ? 's' : ''} in the last 30 days &mdash; ${esc(vendor || 'all vendors')}</p>`
          : `<p class="mg-ing-chart-caption">Only 1 purchase in the last 30 days &mdash; not enough data for a chart.</p>`}
        </div>`
    } catch {
      chartEl.innerHTML = '<p class="mg-empty-sub" style="padding:1rem;text-align:center">Chart unavailable offline.</p>'
    }
  }

  /**
   * Render an inline SVG sparkline for the given price history.
   * History array is expected newest-first (as returned by the API).
   * @param {Array<{unitPrice: number|null}>} history
   * @returns {string} SVG markup string, or '' if insufficient data
   */
  function _sparkline(history) {
    const pts = [...history].reverse().filter((p) => p.unitPrice != null)
    if (pts.length < 2) return ''
    const prices = pts.map((p) => p.unitPrice)
    const minP   = Math.min(...prices)
    const maxP   = Math.max(...prices)
    const range  = maxP - minP || 1
    const W = 300, H = 64, PAD = 6
    const points = pts.map((p, i) => {
      const x = (i / (pts.length - 1)) * W
      const y = H - PAD - ((p.unitPrice - minP) / range) * (H - PAD * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
    return `<svg viewBox="0 0 ${W} ${H}" class="mg-sparkline" aria-hidden="true" preserveAspectRatio="none">
      <polyline points="${points}" fill="none" stroke="var(--mg-primary)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`
  }

  function goBack() {
    if (_screen === 'RECEIPT_DETAIL') {
      _editedItems        = null
      _currentReceiptData = null
      _screen             = 'RECEIPTS'
      _detailId           = null
      render()
    } else if (_screen === 'REPORT_DETAIL') {
      _reportType = null
      _screen     = 'REPORTS'
      render()
    }
  }

  // ── Capture staging ───────────────────────────────────────────────────────

  /** Stage files for preview — accumulates across multiple camera captures. */
  function _handleFiles(files) {
    if (!files || files.length === 0) return
    if (!_auth) return
    const newFiles = Array.from(files)
    const newUrls  = newFiles.map(f => URL.createObjectURL(f))
    _captureFiles = _captureFiles.concat(newFiles)
    _captureUrls  = _captureUrls.concat(newUrls)
    _renderCapturePreview()
  }

  function _removeCaptureFile(idx) {
    URL.revokeObjectURL(_captureUrls[idx])
    _captureFiles.splice(idx, 1)
    _captureUrls.splice(idx, 1)
    if (_captureFiles.length === 0) {
      _discardCapture()
    } else {
      _renderCapturePreview()
    }
  }

  function _discardCapture() {
    _captureUrls.forEach(u => URL.revokeObjectURL(u))
    _captureFiles  = []
    _captureUrls   = []
    _captureVendor = ''
    const preview = el('mg-capture-preview')
    if (preview) preview.hidden = true
    const sel = el('mg-capture-vendor')
    if (sel) sel.value = ''
  }

  async function _submitCapture() {
    if (!_captureFiles.length || !_auth) return
    const files  = _captureFiles.slice()
    const vendor = _captureVendor
    _discardCapture()
    try {
      await ManagerReceipts.queueReceipt(files, _auth.merchantId, _auth.accessToken, vendor)
      _loadReceipts()
    } catch (err) {
      _showListError(err.message)
    }
  }

  function _renderCapturePreview() {
    const preview  = el('mg-capture-preview')
    if (!preview) return
    const countEl  = el('mg-capture-count')
    const thumbsEl = el('mg-capture-thumbs')
    if (countEl) countEl.textContent = `${_captureFiles.length} file${_captureFiles.length !== 1 ? 's' : ''} ready to upload`

    // Populate vendor dropdown with unique names from the receipt history
    const selectEl = el('mg-capture-vendor')
    if (selectEl) {
      const vendors = [...new Set(_receipts.map(r => r.vendorName).filter(Boolean))].sort()
      selectEl.innerHTML =
        `<option value="">&#8212; New supplier &#8212;</option>` +
        vendors.map(v => `<option value="${esc(v)}"${v === _captureVendor ? ' selected' : ''}>${esc(v)}</option>`).join('')
    }
    if (thumbsEl) {
      thumbsEl.innerHTML = _captureFiles.map((f, i) => `
        <div class="mg-capture-thumb-wrap">
          <img class="mg-capture-thumb" src="${_captureUrls[i]}" alt="${esc(f.name)}">
          <button class="mg-capture-thumb-del" type="button" data-idx="${i}" aria-label="Remove ${esc(f.name)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
              <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            </svg>
          </button>
          <span class="mg-capture-thumb-name">${esc(f.name.length > 14 ? f.name.slice(0, 12) + '…' : f.name)}</span>
        </div>`
      ).join('')
    }
    preview.hidden = false
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async function _loadReceipts() {
    if (!_auth) return
    const mgIng = typeof ManagerIngredients !== 'undefined' ? ManagerIngredients : null
    let fromCache = false
    try {
      const res = await apiFetch(`/api/merchants/${_auth.merchantId}/manager/receipts`)
      if (res.ok) {
        const data = await res.json()
        _receipts = data.receipts ?? []
        if (mgIng) mgIng.cacheStore('receipts', _receipts).catch(() => {})
      } else {
        throw new Error(`HTTP ${res.status}`)
      }
    } catch {
      if (mgIng) {
        const cached = await mgIng.loadCache('receipts').catch(() => null)
        if (cached && Array.isArray(cached)) { _receipts = cached; fromCache = true }
      }
    }

    _idbRows = await ManagerReceipts.listAll()
    _pendingCount = _idbRows.filter(r => r.status === 'queued' || r.status === 'uploading' || r.status === 'error').length
    _renderPendingBadge()
    _renderReceipts(fromCache)
  }

  async function _loadReceiptDetail(receiptId) {
    const detailEl = el('mg-screen-receipt-detail')
    if (!detailEl) return
    detailEl.innerHTML = '<div class="mg-loading-inline"><div class="mg-spinner"></div></div>'
    try {
      const [detailRes] = await Promise.all([
        apiFetch(`/api/merchants/${_auth.merchantId}/manager/receipts/${receiptId}`),
        _ensureIngredients(),
      ])
      if (!detailRes.ok) throw new Error(`${detailRes.status}`)
      const data = await detailRes.json()
      _currentReceiptData = data
      const { receipt } = data
      if (receipt.status === 'parsed' || receipt.status === 'review') {
        _editedItems = (data.lineItems ?? []).map(item => ({ ...item }))
        _renderReviewForm(detailEl, receipt)
      } else {
        _renderReceiptDetail(data)
      }
    } catch (err) {
      detailEl.innerHTML = `<div class="mg-empty-state">Failed to load: ${esc(err.message)}</div>`
    }
  }

  function _onQueueChange() {
    _loadReceipts()
  }

  /** Lazy-load the ingredient catalog (needed for review dropdowns). */
  async function _ensureIngredients() {
    if (_ingredients.length > 0) return
    try {
      const res = await apiFetch(`/api/merchants/${_auth.merchantId}/ingredients`)
      if (res.ok) {
        const data = await res.json()
        _ingredients = data.ingredients ?? (Array.isArray(data) ? data : [])
      }
    } catch { /* no auto-match available */ }
  }

  // ── Save review ───────────────────────────────────────────────────────────

  async function _saveReview() {
    if (!_editedItems || !_detailId || !_auth || _saving) return
    _saving = true
    _refreshSaveBtn()
    try {
      const body = JSON.stringify({ lineItems: _editedItems, lock: true })
      const res = await apiFetch(
        `/api/merchants/${_auth.merchantId}/manager/receipts/${_detailId}/items`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }
      )
      if (!res.ok) throw new Error(`Save failed (${res.status})`)
      _saving = false
      goBack()
      _loadReceipts()
    } catch (err) {
      _saving = false
      _refreshSaveBtn()
      _showListError(err.message)
    }
  }

  function _refreshSaveBtn() {
    const btn = el('mg-review-save')
    if (!btn) return
    btn.disabled = _saving
    btn.innerHTML = _saving ? '<span class="mg-spinner-sm"></span> Saving…' : 'Save &amp; Lock'
  }

  // ── Render top-level ──────────────────────────────────────────────────────

  function render() {
    const panels = {
      'mg-loading':         _screen === 'LOADING' || _screen === 'AUTH_CHECK',
      'mg-unauthenticated': _screen === 'UNAUTHENTICATED',
      'mg-accept':          _screen === 'ACCEPT',
      'mg-app':             ['RECEIPTS', 'REPORTS', 'RECEIPT_DETAIL', 'REPORT_DETAIL', 'SYNC', 'INGREDIENTS'].includes(_screen),
    }
    for (const [id, visible] of Object.entries(panels)) {
      const node = el(id)
      if (node) node.hidden = !visible
    }

    if (_screen === 'ACCEPT' && _invite) {
      const mEl = el('mg-accept-merchant')
      const eEl = el('mg-accept-email')
      if (mEl) mEl.textContent = _invite.merchantName
      if (eEl) eEl.textContent = _invite.email
    }

    if (['RECEIPTS', 'REPORTS', 'RECEIPT_DETAIL', 'REPORT_DETAIL', 'SYNC', 'INGREDIENTS'].includes(_screen)) {
      _renderAppShell()
    }
  }

  function _renderAppShell() {
    const screens = {
      'mg-screen-receipts':       _screen === 'RECEIPTS',
      'mg-screen-reports':        _screen === 'REPORTS',
      'mg-screen-receipt-detail': _screen === 'RECEIPT_DETAIL',
      'mg-screen-report-detail':  _screen === 'REPORT_DETAIL',
      'mg-screen-sync':           _screen === 'SYNC',
      'mg-screen-ingredients':    _screen === 'INGREDIENTS',
    }
    for (const [id, visible] of Object.entries(screens)) {
      const node = el(id)
      if (node) node.hidden = !visible
    }

    const titleEl  = el('mg-header-title')
    const backBtn  = el('mg-back-btn')
    const titleMap = {
      RECEIPTS:       'Receipts',
      REPORTS:        'Reports',
      RECEIPT_DETAIL: 'Receipt',
      REPORT_DETAIL:  _reportTypeTitles[_reportType] ?? 'Report',
      SYNC:           'POS Sync',
      INGREDIENTS:    'Prices',
    }
    if (titleEl) titleEl.textContent = titleMap[_screen] ?? ''
    if (backBtn) backBtn.hidden = _screen !== 'RECEIPT_DETAIL' && _screen !== 'REPORT_DETAIL'

    document.querySelectorAll('.mg-nav-btn').forEach((btn) => {
      const target = btn.dataset.screen
      btn.classList.toggle('active',
        (target === 'receipts'    && (_screen === 'RECEIPTS' || _screen === 'RECEIPT_DETAIL')) ||
        (target === 'reports'     && (_screen === 'REPORTS'  || _screen === 'REPORT_DETAIL'))  ||
        (target === 'sync'        &&  _screen === 'SYNC') ||
        (target === 'ingredients' &&  _screen === 'INGREDIENTS')
      )
    })

    _renderLocBanner()
  }

  function _renderLocBanner() {
    const banner = el('mg-offsite-banner')
    if (!banner) return
    if (_isOffsite) {
      banner.textContent = 'Off-site – showing cached data. Connect to the restaurant network to sync.'
      banner.hidden = false
    } else if (_location && _location.onsite === false) {
      banner.textContent = 'Not at restaurant – POS sync disabled'
      banner.hidden = false
    } else {
      banner.hidden = true
    }
  }

  function _renderPendingBadge() {
    const badge = el('mg-pending-badge')
    if (!badge) return
    badge.textContent = String(_pendingCount)
    badge.hidden = _pendingCount === 0
  }

  // ── Receipts list ─────────────────────────────────────────────────────────

  /** Render IDB queue rows + filtered, paginated server receipts. */
  function _renderReceipts(fromCache = false) {
    const listEl = el('mg-receipt-list')
    if (!listEl) return

    const offlineBanner = fromCache
      ? '<div class="mg-offline-banner">Offline &mdash; showing cached data</div>'
      : ''

    // Active IDB rows (pending/uploading/error) shown regardless of filter
    const activeIdb = _idbRows.filter(r => r.status !== 'done')
    const idbHtml   = activeIdb.map(row => _idbRowHtml(row)).join('')

    // Apply filter to server receipts
    const vLower = _filterVendor.toLowerCase()
    const filtered = _receipts.filter(r => {
      if (vLower && !((r.vendorName ?? '').toLowerCase().includes(vLower))) return false
      if (_filterDateFrom && r.receiptDate && r.receiptDate < _filterDateFrom) return false
      if (_filterDateTo   && r.receiptDate && r.receiptDate > _filterDateTo)   return false
      return true
    })

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    if (_page >= totalPages) _page = totalPages - 1

    const paged = filtered.slice(_page * PAGE_SIZE, (_page + 1) * PAGE_SIZE)

    if (idbHtml === '' && filtered.length === 0 && _receipts.length === 0) {
      listEl.innerHTML = `
        <div class="mg-empty-state">
          <div class="mg-empty-icon">🧾</div>
          <p>No receipts yet.</p>
          <p class="mg-empty-sub">Tap "Take Photo" or "Choose File" to add your first receipt.</p>
        </div>`
      _renderPagination(0, 1)
      return
    }

    if (idbHtml === '' && paged.length === 0 && filtered.length === 0) {
      listEl.innerHTML = '<div class="mg-empty-state">No receipts match your filter.</div>'
      _renderPagination(0, 1)
      return
    }

    const serverHtml = paged.map(r => `
      <div class="mg-receipt-card" data-id="${esc(r.id)}" tabindex="0" role="button"
           aria-label="Receipt from ${esc(r.vendorName ?? 'unknown')} on ${esc(fmtDate(r.receiptDate || r.createdAt))}">
        <div class="mg-receipt-icon" aria-hidden="true">
          ${r.thumbnailUrl
            ? `<img class="mg-receipt-thumb" src="${esc(r.thumbnailUrl)}" alt="">`
            : '<span class="mg-receipt-icon-inner">🧾</span>'}
        </div>
        <div class="mg-receipt-info">
          <div class="mg-receipt-vendor">${esc(r.vendorName ?? '—')}</div>
          <div class="mg-receipt-date">${esc(fmtDate(r.receiptDate || r.createdAt))}</div>
          ${r.status === 'parsed'
            ? '<span class="mg-receipt-status mg-receipt-status--review">Needs review</span>'
            : ''}
        </div>
        <div class="mg-receipt-right">
          <div class="mg-receipt-total">${esc(fmtCurrency(r.total))}</div>
          ${r.lineItemCount != null
            ? `<div class="mg-receipt-items">${esc(String(r.lineItemCount))} items</div>`
            : ''}
        </div>
      </div>`
    ).join('')

    listEl.innerHTML = offlineBanner + idbHtml + serverHtml

    // Wire server receipt cards
    listEl.querySelectorAll('.mg-receipt-card[data-id]').forEach((card) => {
      const activate = () => openReceiptDetail(card.dataset.id)
      card.addEventListener('click', activate)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
      })
    })

    // Wire IDB row retry/discard buttons
    listEl.querySelectorAll('[data-idb-action]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const { idbAction: action, idbId: id } = btn.dataset
        if (action === 'retry') {
          await ManagerReceipts.retryReceipt(id, _auth.accessToken)
          _loadReceipts()
        } else if (action === 'discard') {
          await ManagerReceipts.discardReceipt(id)
          _loadReceipts()
        }
      })
    })

    _renderPagination(filtered.length, totalPages)
  }

  /** Build HTML card for one IDB queue row. */
  function _idbRowHtml(row) {
    const name = row.files && row.files[0] ? row.files[0].name : 'Receipt'
    const statusLabel = { queued: 'Queued', uploading: 'Uploading…', error: row.errorMessage ?? 'Error' }
    const statusCls   = { queued: 'mg-receipt-status--queued', uploading: 'mg-receipt-status--uploading', error: 'mg-receipt-status--error' }

    const actionHtml = (row.status === 'error' || row.status === 'uploading')
      ? `<div class="mg-idb-actions">
           <button class="mg-btn mg-btn-sm mg-btn-secondary" type="button"
                   data-idb-action="retry" data-idb-id="${esc(row.id)}">Retry</button>
           <button class="mg-btn mg-btn-sm mg-btn-danger" type="button"
                   data-idb-action="discard" data-idb-id="${esc(row.id)}">Discard</button>
         </div>`
      : ''

    return `
      <div class="mg-receipt-card mg-receipt-card--idb">
        <div class="mg-receipt-icon" aria-hidden="true">📤</div>
        <div class="mg-receipt-info">
          <div class="mg-receipt-vendor">${esc(name.length > 28 ? name.slice(0, 26) + '…' : name)}</div>
          <div class="mg-receipt-date">${esc(fmtDate(row.capturedAt))}</div>
          <span class="mg-receipt-status ${esc(statusCls[row.status] ?? '')}">
            ${row.status === 'uploading' ? '<span class="mg-spinner-sm"></span>&nbsp;' : ''}${esc(statusLabel[row.status] ?? row.status)}
          </span>
          ${actionHtml}
        </div>
      </div>`
  }

  function _renderPagination(total, totalPages) {
    const paginEl = el('mg-pagination')
    const prevBtn = el('mg-page-prev')
    const nextBtn = el('mg-page-next')
    const label   = el('mg-page-label')
    if (!paginEl) return
    if (total <= PAGE_SIZE) { paginEl.hidden = true; return }
    paginEl.hidden = false
    if (label)   label.textContent  = `Page ${_page + 1} of ${totalPages}`
    if (prevBtn) prevBtn.disabled   = _page === 0
    if (nextBtn) nextBtn.disabled   = _page >= totalPages - 1
  }

  // ── Receipt detail — read-only view ───────────────────────────────────────

  function _renderReceiptDetail(data) {
    const detailEl = el('mg-screen-receipt-detail')
    if (!detailEl) return
    const { receipt, lineItems = [] } = data

    const itemsHtml = lineItems.map((item) => `
      <tr>
        <td>${esc(item.description)}</td>
        <td class="mg-td-num">${item.quantity != null
          ? esc(String(item.quantity)) + (item.unit ? '&nbsp;' + esc(item.unit) : '') : '—'}</td>
        <td class="mg-td-num">${item.unitPrice  != null ? esc(fmtCurrency(item.unitPrice))  : '—'}</td>
        <td class="mg-td-num">${esc(fmtCurrency(item.totalPrice))}</td>
        <td>${item.ingredientName
          ? `<span class="mg-linked-badge">${esc(item.ingredientName)}</span>`
          : '<span class="mg-unlinked-badge">Unlinked</span>'}</td>
      </tr>`
    ).join('')

    detailEl.innerHTML = `
      <div class="mg-detail-header">
        <div class="mg-detail-vendor">${esc(receipt.vendorName ?? '—')}</div>
        <div class="mg-detail-meta">
          <span>${esc(fmtDate(receipt.receiptDate || receipt.createdAt))}</span>
          <span class="mg-detail-sep">·</span>
          <span>${esc(receipt.documentType ?? 'receipt')}</span>
          ${receipt.documentNumber
            ? `<span class="mg-detail-sep">·</span><span>#${esc(receipt.documentNumber)}</span>`
            : ''}
        </div>
        <div class="mg-detail-total">Total: <strong>${esc(fmtCurrency(receipt.total))}</strong></div>
      </div>
      <div class="mg-detail-table-wrap">
        <table class="mg-detail-table">
          <thead>
            <tr>
              <th>Item</th>
              <th class="mg-td-num">Qty</th>
              <th class="mg-td-num">Unit&nbsp;$</th>
              <th class="mg-td-num">Total</th>
              <th>Ingredient</th>
            </tr>
          </thead>
          <tbody>${itemsHtml || '<tr><td colspan="5" class="mg-empty-cell">No line items</td></tr>'}</tbody>
        </table>
      </div>
      <div class="mg-review-footer">
        <button class="mg-btn mg-btn-secondary" type="button" id="mg-detail-edit-btn">Edit</button>
      </div>`

    el('mg-detail-edit-btn')?.addEventListener('click', () => {
      _editedItems = lineItems.map(item => ({ ...item }))
      _renderReviewForm(detailEl, receipt)
    })
  }

  // ── Receipt review — editable form ────────────────────────────────────────

  /** Resolve a search string to an ingredient ID (exact name match, case-insensitive). */
  function _resolveIngByName(text) {
    const t = text.trim().toLowerCase()
    if (!t) return null
    const ing = _ingredients.find(i =>
      (i.display_name ?? '').toLowerCase() === t || (i.name ?? '').toLowerCase() === t
    )
    return ing ? String(ing.id) : null
  }

  function _renderReviewForm(container, receipt) {
    if (!_editedItems) return

    // Shared datalist — one element reused by all items; browser matches by list= id per input
    const datalistHtml = `<datalist id="mg-ing-datalist">` +
      _ingredients.map(ing => `<option value="${esc(ing.display_name || ing.name)}"></option>`).join('') +
      `</datalist>`

    const itemsHtml = _editedItems.map((item, idx) => {
      // Resolve display name for pre-filled search input
      const desc = (item.description ?? '').toLowerCase()
      let matchedId = item.ingredientId ? String(item.ingredientId) : ''
      if (!matchedId) {
        const match = _ingredients.find(ing => {
          const n = (ing.name ?? '').toLowerCase()
          const d = (ing.display_name ?? '').toLowerCase()
          return (n.length > 2 && desc.includes(n)) || (d.length > 2 && desc.includes(d))
        })
        if (match) matchedId = String(match.id)
      }
      const matchedIng = matchedId ? _ingredients.find(i => String(i.id) === matchedId) : null
      const searchVal  = matchedIng ? (matchedIng.display_name || matchedIng.name) : ''

      // Sync resolved ID back into _editedItems so save picks it up
      if (matchedId && !item.ingredientId) _editedItems[idx] = { ..._editedItems[idx], ingredientId: matchedId }

      const isUnlinked = !matchedId
      const discountFlag = (item.totalPrice != null && item.totalPrice < 0)
        ? `<span class="mg-review-discount-badge">Discount</span>` : ''

      return `
        <div class="mg-review-item${isUnlinked ? ' mg-review-item--unlinked' : ''}" data-idx="${idx}">
          <div class="mg-review-item-header">
            <span class="mg-review-item-num">#${idx + 1}</span>
            ${discountFlag}
            ${isUnlinked ? `<span class="mg-review-unlinked-badge">Needs ingredient</span>` : ''}
            <button class="mg-review-item-del" type="button"
                    data-action="del-item" data-idx="${idx}"
                    aria-label="Delete line item ${idx + 1}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <label class="mg-review-label">Description</label>
          <input class="mg-review-input" data-field="description" data-idx="${idx}"
                 value="${esc(item.description ?? '')}" placeholder="Item description">
          <div class="mg-review-grid-4">
            <div>
              <label class="mg-review-label">Qty</label>
              <input class="mg-review-input" type="number" data-field="quantity" data-idx="${idx}"
                     value="${item.quantity != null ? item.quantity : ''}" min="0" step="any" placeholder="0">
            </div>
            <div>
              <label class="mg-review-label">Unit</label>
              <input class="mg-review-input" data-field="unit" data-idx="${idx}"
                     value="${esc(item.unit ?? '')}" placeholder="lb">
            </div>
            <div>
              <label class="mg-review-label">Unit&nbsp;$</label>
              <input class="mg-review-input" type="number" data-field="unitPrice" data-idx="${idx}"
                     value="${item.unitPrice != null ? item.unitPrice : ''}" min="0" step="0.01" placeholder="0.00">
            </div>
            <div>
              <label class="mg-review-label">Total</label>
              <input class="mg-review-input" type="number" data-field="totalPrice" data-idx="${idx}"
                     value="${item.totalPrice != null ? item.totalPrice : ''}" min="0" step="0.01" placeholder="0.00">
            </div>
          </div>
          <label class="mg-review-label">Ingredient</label>
          <div class="mg-review-ing-wrap">
            <input class="mg-review-input mg-review-ing-search" type="text"
                   data-field="ingredientSearch" data-idx="${idx}"
                   list="mg-ing-datalist"
                   value="${esc(searchVal)}"
                   placeholder="Search ingredients…"
                   autocomplete="off">
            <button class="mg-review-ing-new-btn" type="button"
                    data-action="new-ing" data-idx="${idx}"
                    title="Create new ingredient">+ New</button>
          </div>
          <div class="mg-review-new-ing-form" id="mg-new-ing-form-${idx}" hidden>
            <input class="mg-review-input mg-review-new-ing-name" type="text"
                   placeholder="Ingredient name (required)" data-idx="${idx}">
            <select class="mg-review-select mg-review-new-ing-cat" data-idx="${idx}">
              <option value="protein">Protein</option>
              <option value="vegetable">Vegetable</option>
              <option value="sauce">Sauce</option>
              <option value="spice">Spice</option>
              <option value="dairy">Dairy</option>
              <option value="other" selected>Other</option>
            </select>
            <div class="mg-review-new-ing-actions">
              <button class="mg-btn mg-btn-primary mg-btn-sm" type="button"
                      data-action="create-ing" data-idx="${idx}">Create</button>
              <button class="mg-btn mg-btn-secondary mg-btn-sm" type="button"
                      data-action="cancel-new-ing" data-idx="${idx}">Cancel</button>
            </div>
          </div>
        </div>`
    }).join('')

    container.innerHTML = datalistHtml + `
      <div class="mg-review-header">
        <div class="mg-detail-vendor">${esc(receipt.vendorName ?? 'Unknown Vendor')}</div>
        <div class="mg-detail-meta">
          <span>${esc(fmtDate(receipt.receiptDate || receipt.createdAt))}</span>
          ${receipt.documentNumber
            ? `<span class="mg-detail-sep">·</span><span>#${esc(receipt.documentNumber)}</span>`
            : ''}
          <span class="mg-review-badge">Needs review</span>
        </div>
      </div>
      <div class="mg-review-items">${itemsHtml || '<p class="mg-review-empty">No line items. Add one below.</p>'}</div>
      <div class="mg-review-footer">
        <button class="mg-btn mg-btn-secondary" type="button" id="mg-review-add">+ Add Line</button>
        <button class="mg-btn mg-btn-primary" type="button" id="mg-review-save">Save &amp; Lock</button>
      </div>`
  }

  // ── Review event delegation ────────────────────────────────────────────────

  function _onReviewInput(e) {
    const { field, idx } = e.target.dataset
    if (field == null || idx == null || !_editedItems) return
    const i = Number(idx)
    if (i < 0 || i >= _editedItems.length) return
    const numFields = new Set(['quantity', 'unitPrice', 'totalPrice'])
    const raw = e.target.value
    let val
    if (numFields.has(field)) {
      val = raw === '' ? null : Number(raw)
    } else if (field === 'ingredientSearch') {
      // Resolve typed/selected text to an ingredient ID; null when no match
      val = _resolveIngByName(raw)
      _editedItems[i] = { ..._editedItems[i], ingredientId: val }
      // Update badge + border in place — no full re-render needed
      const itemDiv = e.target.closest('.mg-review-item')
      if (itemDiv) {
        itemDiv.classList.toggle('mg-review-item--unlinked', !val)
        const badge = itemDiv.querySelector('.mg-review-unlinked-badge')
        if (badge) badge.hidden = !!val
      }
      return
    } else {
      val = raw
    }
    _editedItems[i] = { ..._editedItems[i], [field]: val }
  }

  function _onReviewClick(e) {
    const actionBtn = e.target.closest('[data-action]')
    if (actionBtn) {
      const { action, idx } = actionBtn.dataset
      const i = idx != null ? Number(idx) : -1

      if (action === 'del-item' && i >= 0 && _editedItems) {
        _editedItems.splice(i, 1)
        if (_currentReceiptData) {
          _renderReviewForm(el('mg-screen-receipt-detail'), _currentReceiptData.receipt)
        }
        return
      }

      if (action === 'new-ing' && i >= 0) {
        const form = document.getElementById(`mg-new-ing-form-${i}`)
        if (form) { form.hidden = false; form.querySelector('input')?.focus() }
        return
      }

      if (action === 'cancel-new-ing' && i >= 0) {
        const form = document.getElementById(`mg-new-ing-form-${i}`)
        if (form) {
          form.hidden = true
          form.querySelector('.mg-review-new-ing-name').value = ''
        }
        return
      }

      if (action === 'create-ing' && i >= 0) {
        _createIngredientInline(i)
        return
      }

      return
    }

    const btn = e.target.closest('button')
    if (!btn) return
    if (btn.id === 'mg-review-add') {
      _editedItems.push({ description: '', quantity: null, unit: '', unitPrice: null, totalPrice: null, ingredientId: null })
      if (_currentReceiptData) {
        _renderReviewForm(el('mg-screen-receipt-detail'), _currentReceiptData.receipt)
      }
    } else if (btn.id === 'mg-review-save') {
      _saveReview()
    }
  }

  async function _createIngredientInline(idx) {
    const form     = document.getElementById(`mg-new-ing-form-${idx}`)
    if (!form) return
    const nameInput = form.querySelector('.mg-review-new-ing-name')
    const catSel    = form.querySelector('.mg-review-new-ing-cat')
    const name = nameInput.value.trim()
    if (!name) { nameInput.focus(); return }

    const createBtn = form.querySelector('[data-action="create-ing"]')
    createBtn.disabled = true
    createBtn.textContent = 'Saving…'

    try {
      const res = await apiFetch(`/api/merchants/${_auth.merchantId}/ingredients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category: catSel.value }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        _showListError(err.error || `Failed to create ingredient (${res.status})`)
        return
      }
      const newIng = await res.json()
      // Add to local catalog so it's immediately searchable
      _ingredients.push(newIng)
      _ingredients.sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name))

      // Link this line item to the new ingredient
      if (_editedItems && idx < _editedItems.length) {
        _editedItems[idx] = { ..._editedItems[idx], ingredientId: String(newIng.id) }
      }

      // Re-render so the search input shows the new name and datalist is updated
      if (_currentReceiptData) {
        _renderReviewForm(el('mg-screen-receipt-detail'), _currentReceiptData.receipt)
      }
    } catch (err) {
      _showListError('Network error creating ingredient')
    } finally {
      createBtn.disabled = false
      createBtn.textContent = 'Create'
    }
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  function _showListError(msg) {
    const listEl = _screen === 'RECEIPT_DETAIL'
      ? el('mg-screen-receipt-detail')
      : _screen === 'SYNC'
        ? el('mg-screen-sync')
        : el('mg-receipt-list')
    if (!listEl) return
    const div = document.createElement('div')
    div.className = 'mg-upload-error'
    div.textContent = msg
    listEl.prepend(div)
    setTimeout(() => div.remove(), 4000)
  }

  // ── Wire up DOM events ────────────────────────────────────────────────────

  function _wireEvents() {
    // Auth screens
    el('mg-signin-btn')?.addEventListener('click', signIn)
    el('mg-accept-btn')?.addEventListener('click', acceptInvite)

    // Header back
    el('mg-back-btn')?.addEventListener('click', goBack)

    // Bottom nav
    const _navScreenMap = { receipts: 'RECEIPTS', reports: 'REPORTS', sync: 'SYNC', ingredients: 'INGREDIENTS' }
    document.querySelectorAll('.mg-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () =>
        navigate(_navScreenMap[btn.dataset.screen] ?? 'RECEIPTS')
      )
    })

    // Report cards
    el('mg-screen-reports')?.querySelectorAll('.mg-report-card').forEach((card) => {
      const activate = () => openReportDetail(card.dataset.report)
      card.addEventListener('click', activate)
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
      })
    })

    // File inputs — stage rather than queue immediately
    const cameraInput  = el('mg-input-camera')
    const galleryInput = el('mg-input-gallery')
    el('mg-btn-camera')?.addEventListener('click',  () => cameraInput?.click())
    el('mg-btn-gallery')?.addEventListener('click', () => galleryInput?.click())
    cameraInput?.addEventListener('change',  (e) => { _handleFiles(e.target.files); e.target.value = '' })
    galleryInput?.addEventListener('change', (e) => { _handleFiles(e.target.files); e.target.value = '' })

    // Capture preview actions
    el('mg-capture-discard')?.addEventListener('click', _discardCapture)
    el('mg-capture-upload')?.addEventListener('click',  _submitCapture)
    el('mg-capture-vendor')?.addEventListener('change', (e) => { _captureVendor = e.target.value })
    el('mg-capture-thumbs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.mg-capture-thumb-del')
      if (btn) _removeCaptureFile(Number(btn.dataset.idx))
    })

    // Filter bar
    const vendorIn = el('mg-filter-vendor')
    const fromIn   = el('mg-filter-date-from')
    const toIn     = el('mg-filter-date-to')
    let _debounce  = null
    const applyFilter = () => {
      _filterVendor   = vendorIn?.value ?? ''
      _filterDateFrom = fromIn?.value ?? ''
      _filterDateTo   = toIn?.value ?? ''
      _page = 0
      _renderReceipts()
    }
    vendorIn?.addEventListener('input', () => { clearTimeout(_debounce); _debounce = setTimeout(applyFilter, 250) })
    fromIn?.addEventListener('change', applyFilter)
    toIn?.addEventListener('change',   applyFilter)
    el('mg-filter-clear')?.addEventListener('click', () => {
      if (vendorIn) vendorIn.value = ''
      if (fromIn)   fromIn.value   = ''
      if (toIn)     toIn.value     = ''
      _filterVendor = _filterDateFrom = _filterDateTo = ''
      _page = 0
      _renderReceipts()
    })

    // Pagination
    el('mg-page-prev')?.addEventListener('click', () => { _page = Math.max(0, _page - 1); _renderReceipts() })
    el('mg-page-next')?.addEventListener('click', () => { _page += 1; _renderReceipts() })

    // Receipt detail — event delegation for review form (wired once on persistent container)
    // 'change' catches datalist selections on mobile/Safari which skip the 'input' event
    el('mg-screen-receipt-detail')?.addEventListener('input', _onReviewInput)
    el('mg-screen-receipt-detail')?.addEventListener('change', _onReviewInput)
    el('mg-screen-receipt-detail')?.addEventListener('click', _onReviewClick)

    // Sync screen — ingredient availability toggle delegation
    el('mg-screen-sync')?.addEventListener('change', (e) => {
      const inp = e.target.closest('.mg-toggle-input')
      if (!inp || inp.disabled) return
      const ingId = inp.dataset.ingId
      if (ingId) _toggleIngredient(ingId, inp.checked)
    })

    // Ingredients price screen — debounced search input (event delegation)
    el('mg-screen-ingredients')?.addEventListener('input', (e) => {
      if (e.target.id !== 'mg-ing-query') return
      _ingQuery = e.target.value
      _ingSelected = null          // clear vendor selection when query changes
      const chartEl = el('mg-ing-chart')
      if (chartEl) chartEl.innerHTML = ''
      clearTimeout(_ingDebounce)
      _ingDebounce = setTimeout(_doIngredientSearch, 300)
    })

    // Ingredients price screen — card tap / keyboard selection
    el('mg-screen-ingredients')?.addEventListener('click', (e) => {
      const card = e.target.closest('.mg-ing-card')
      if (!card) return
      _doIngredientChart(card.dataset.description ?? '', card.dataset.vendor ?? '', card.dataset.unit ?? '')
    })
    el('mg-screen-ingredients')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const card = e.target.closest('.mg-ing-card')
      if (!card) return
      e.preventDefault()
      _doIngredientChart(card.dataset.description ?? '', card.dataset.vendor ?? '', card.dataset.unit ?? '')
    })
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  _wireEvents()
  boot()
})()
