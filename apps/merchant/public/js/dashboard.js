/**
 * Kizo Register Dashboard
 *
 * Implementation note — plain state object (no sam-pattern npm library):
 *   `state` is a plain mutable object updated by direct assignment.  The
 *   sam-pattern library's reserved field collision (error, hasError,
 *   errorMessage, clearError, state, update, flush, clone, continue,
 *   hasNext, allow, log) does NOT apply.  If sam-pattern is ever imported
 *   into this file, all state field names must be audited against that list.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  merchantId: null,
  accessToken: null,
  profile: null,
  /** Full menu data from API: { categories, uncategorizedItems, lastSynced } */
  menu: null,
  /** All items flat list (for modifier panel item picker) */
  allItems: [],
  activeSection: 'profile',
  /** Item being edited in the item panel */
  editingItem: null,
  /** Modifier group being edited in the modifier panel */
  editingGroup: null,
  /**
   * Preview URL (blob: object URL) for the image chosen this edit session,
   * or null if no new image was chosen.  Set alongside editingImageBlob.
   */
  editingImageDataUrl: null,
  /**
   * WebP Blob pending upload to the server. Populated whenever the user
   * picks or crops an image; cleared after a successful upload on save.
   */
  editingImageBlob: null,
  /** Employee mode: when true the PIN overlay is shown and employees clock in/out */
  employeeMode: false,
  /** Currently active employee (server/manager) after PIN entry, or null */
  currentEmployee: null,  // { id, nickname, role, openShiftId }
  /** Payment provider config from /api/merchants/:id/payments/config */
  paymentConfig: null,   // { clover: { enabled }, stax: { enabled, token }, converge: { enabled, sandbox, accountId, userId } }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  state.accessToken = localStorage.getItem('accessToken')

  if (!state.accessToken) {
    window.location.href = '/setup'
    return
  }

  // Validate access token — silently refresh if expired before giving up.
  // This keeps the POS logged in permanently as long as the refresh token is valid.
  try {
    let meRes = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${state.accessToken}` },
    })

    if (meRes.status === 401) {
      // Access token expired — try to refresh silently before redirecting to login
      const refreshToken = localStorage.getItem('refreshToken')
      if (refreshToken) {
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
        if (refreshRes.ok) {
          const { accessToken } = await refreshRes.json()
          state.accessToken = accessToken
          localStorage.setItem('accessToken', accessToken)
          // Retry /api/auth/me with fresh token
          meRes = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` },
          })
        }
      }
    }

    if (!meRes.ok) {
      // Refresh token also expired or revoked — must re-authenticate
      clearAuth()
      window.location.href = '/setup'
      return
    }

    const me = await meRes.json()
    state.merchantId = me.merchantId
    localStorage.setItem('merchantId', me.merchantId)
    // Expose token for pwa.js (push subscription) and voice.js
    window.authToken = state.accessToken
    window.merchantId = state.merchantId
    window.state = state   // voice.js reads state.allItems for name matching
    window.dispatchEvent(new Event('merchant:authenticated'))
  } catch {
    window.location.href = '/setup'
    return
  }

  initNav()
  initSidebarCollapse()
  initItemPanel()
  initModifierPanel()
  initCropModal()
  initModifierPickerModal()
  initOrders()
  initBrandImages()
  initTableLayout()
  initPrinterToggles()
  initPrinterDiscovery()
  initTestPrintButtons()
  initEmployees()
  initEmployeeMode()
  initTimesheet()
  await loadProfile()
  await Promise.all([loadHours(), loadClosures(), loadPaymentConfig(), loadTerminals()])
  initConvergeUI()
  initFinixUI()
  initPayPeriodUI()
  initOrderSSE()
  loadCounterSetup()

  // Voice command: refresh menu render after stock change
  window.addEventListener('voice:refreshMenu', () => {
    if (state.activeSection === 'menu' && state.menu) renderMenu(state.menu)
    updateOosBadge()
  })

  // Check if we're returning from a payment page
  if (window.location.hash.startsWith('#stax-paid')) {
    // Stax appends query params to our redirect hash: #stax-paid?total=12.14&firstname=Paul&...
    const hash = window.location.hash
    const qsStart = hash.indexOf('?')
    const staxParams = qsStart >= 0 ? new URLSearchParams(hash.slice(qsStart + 1)) : new URLSearchParams()
    window.history.replaceState(null, '', window.location.pathname)
    await resumeAfterStaxPayment(staxParams)
  } else if (window.location.hash === '#converge-paid') {
    // Same-tab Converge return — result stored in sessionStorage by the return page
    window.history.replaceState(null, '', window.location.pathname)
    await resumeAfterConvergePayment(null)
  } else if (window.location.hash === '#finix-paid') {
    // Same-tab Finix return — result stored in sessionStorage by the return page
    window.history.replaceState(null, '', window.location.pathname)
    await resumeAfterFinixPayment(null)
  } else {
    const hash = window.location.hash.replace('#', '') || 'profile'
    showSection(hash)
  }

  // Listen for postMessage from payment return pages (new-tab flow)
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'converge-payment-result') {
      resumeAfterConvergePayment(event.data)
    } else if (event.data?.type === 'finix-payment-result') {
      resumeAfterFinixPayment(event.data)
    }
  })

  // Start polling for Stax payment failure notifications
  startPaymentNotificationPolling()
})

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function initNav() {
  document.querySelectorAll('.sidebar-link[data-section]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      const section = link.dataset.section
      showSection(section)
      window.location.hash = section
    })
  })

  document.getElementById('logout-btn').addEventListener('click', () => {
    clearAuth()
    window.location.href = '/setup'
  })
}

function initSidebarCollapse() {
  // Restore persisted state immediately so sidebar is correct before first paint
  const collapsed = localStorage.getItem('sidebar-collapsed') === 'true'
  document.querySelector('.dashboard-layout')?.classList.toggle('sidebar-collapsed', collapsed)

  const btn = document.getElementById('sidebar-collapse-btn')
  if (!btn) return
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  btn.addEventListener('click', () => {
    const layout = document.querySelector('.dashboard-layout')
    const nowCollapsed = layout?.classList.toggle('sidebar-collapsed')
    localStorage.setItem('sidebar-collapsed', nowCollapsed ? 'true' : 'false')
    btn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true')
  })
}

/** Sections a clocked-in server may access. Managers get everything. */
const SERVER_SECTIONS = new Set(['orders', 'order', 'reservations', 'gift-cards'])

/** Sections restricted to manager/owner employee role only. */
const MANAGER_ONLY_SECTIONS = new Set(['reports', 'backup'])

/**
 * Hides sidebar links the given role cannot access, or restores all links
 * when role is null (admin / no employee logged in).
 * @param {string|null} role
 */
function applyNavRestrictions(role) {
  document.querySelectorAll('.sidebar-link[data-section]').forEach((link) => {
    const section = link.dataset.section
    let hidden = false
    if (role === 'server') {
      hidden = !SERVER_SECTIONS.has(section)
    } else if (role === 'chef') {
      hidden = MANAGER_ONLY_SECTIONS.has(section)
    }
    link.style.display = hidden ? 'none' : ''
  })
}

function showSection(name) {
  // Block navigation to restricted sections based on employee role
  const empRole = state.currentEmployee?.role
  if (empRole === 'server' && !SERVER_SECTIONS.has(name)) return
  if (empRole === 'chef'   && MANAGER_ONLY_SECTIONS.has(name)) return

  // Stop health poll when navigating away
  if (name !== 'health') stopHealthPolling()

  const sectionTitles = {
    profile: 'Store Profile',
    menu: 'Menu Items',
    order: 'Order Entry',
    modifiers: 'Modifiers',
    orders: 'Orders',
    employees: 'Employees',
    timesheet: 'Timesheet',
    reports: 'Reports',
    backup: 'Backup & Restore',
    feedback: 'Customer Feedback',
    reservations: 'Reservations',
    'gift-cards': 'Gift Cards',
    maintenance: 'Maintenance',
    health: 'System Health',
  }

  state.activeSection = name

  document.querySelectorAll('.sidebar-link').forEach((l) => {
    l.classList.toggle('active', l.dataset.section === name)
  })

  document.getElementById('section-title').textContent = sectionTitles[name] ?? name

  document.querySelectorAll('.dash-section').forEach((s) => {
    s.hidden = s.id !== `section-${name}`
  })

  if (name === 'menu') {
    if (state.menu) {
      renderMenu(state.menu)
    } else {
      showMenuState('loading')
      loadMenu()
    }
  }

  if (name === 'order') {
    // Ensure menu is loaded so item bubbles can render
    if (!state.menu) loadMenu()
    if (typeof window.initOrderEntry === 'function') window.initOrderEntry()
    if (typeof window.renderOrderEntry === 'function') window.renderOrderEntry()
  }

  if (name === 'modifiers') {
    if (state.menu) {
      renderModifiers(state.menu)
    } else {
      showModifiersState('loading')
      loadMenu()
    }
  }

  if (name === 'orders') {
    loadOrders()
  }

  if (name === 'employees') {
    document.dispatchEvent(new CustomEvent('section:employees'))
  }

  if (name === 'timesheet') {
    document.dispatchEvent(new CustomEvent('section:timesheet'))
  }

  if (name === 'reports') {
    document.dispatchEvent(new CustomEvent('section:reports'))
  }

  if (name === 'backup') {
    document.dispatchEvent(new CustomEvent('section:backup'))
  }

  if (name === 'feedback') {
    loadFeedback(true)
    loadFeedbackStats()
  }

  if (name === 'reservations') {
    initReservations()
  }

  if (name === 'gift-cards') {
    loadGiftCards(true)
  }

  if (name === 'maintenance') {
    loadFog(true)
    loadHoodFog(true)
  }

  if (name === 'health') {
    startHealthPolling()
  }
}

// ---------------------------------------------------------------------------
// System Health
// ---------------------------------------------------------------------------

let _healthPollTimer = null

/** Start (or restart) the 10-second health poll. Stops when tab changes away. */
function startHealthPolling() {
  stopHealthPolling()
  loadHealth()
  _healthPollTimer = setInterval(loadHealth, 10_000)
}

function stopHealthPolling() {
  if (_healthPollTimer) { clearInterval(_healthPollTimer); _healthPollTimer = null }
}

async function loadHealth() {
  if (!state.merchantId) return
  try {
    const res = await api(`/api/merchants/${state.merchantId}/system/health`)
    if (!res.ok) return
    const data = await res.json()
    renderHealth(data)
  } catch { /* network error — keep showing last data */ }
}

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtBytes(b) {
  if (!b || b === 0) return '—'
  if (b >= 1_073_741_824) return (b / 1_073_741_824).toFixed(1) + ' GB'
  if (b >= 1_048_576)     return (b / 1_048_576).toFixed(0)     + ' MB'
  return (b / 1024).toFixed(0) + ' KB'
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600)  / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}

function fmtDateTime(iso) {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── Main render ─────────────────────────────────────────────────────────────

function renderHealth(data) {
  const { system, cpuNow, cpuHistory, memHistory, printers, terminals, recentErrors, timestamp } = data

  // Metric cards
  document.getElementById('hc-uptime').textContent     = fmtUptime(system.uptimeSec)
  document.getElementById('hc-started').textContent    = 'started ' + fmtDateTime(system.startedAt)
  document.getElementById('hc-cpu').textContent        = system.loadAvg[0].toFixed(2)
  document.getElementById('hc-cpu-model').textContent  = `${system.cpuCount}× ${system.cpuModel.split('@')[0].trim()}`
  document.getElementById('hc-mem-sys').textContent    = fmtBytes(system.memory.sysUsed) + ' / ' + fmtBytes(system.memory.sysTotal)
  document.getElementById('hc-mem-proc').textContent   = 'process ' + fmtBytes(system.memory.processRss)

  if (system.disk.total > 0) {
    const pct = Math.round(system.disk.used / system.disk.total * 100)
    document.getElementById('hc-disk').textContent      = `${fmtBytes(system.disk.used)} / ${fmtBytes(system.disk.total)} (${pct}%)`
    document.getElementById('hc-disk-free').textContent = `${fmtBytes(system.disk.free)} free`
  } else {
    document.getElementById('hc-disk').textContent      = '—'
    document.getElementById('hc-disk-free').textContent = 'unavailable'
  }

  // Charts
  drawCpuChart(cpuHistory)
  drawMemChart(memHistory, system.memory.sysTotal)

  // Printers
  const pEl = document.getElementById('health-printers')
  if (printers.length === 0) {
    pEl.innerHTML = '<p class="health-empty">No printers configured</p>'
  } else {
    pEl.innerHTML = printers.map(p => `
      <div class="health-device-row" id="hpr-${esc(p.ip.replace(/\./g,'-'))}">
        <span class="health-status-dot unknown"></span>
        <span class="health-device-name">${esc(p.role.charAt(0).toUpperCase() + p.role.slice(1))} Printer</span>
        <span class="health-device-meta">${esc(p.ip)} · ${esc(p.protocol)}</span>
        <button class="health-printer-test-btn" data-ip="${esc(p.ip)}" data-protocol="${esc(p.protocol)}">Test</button>
      </div>
      <div class="health-printer-diagnostic" id="hpd-${esc(p.ip.replace(/\./g,'-'))}" hidden></div>
    `).join('')
    pEl.querySelectorAll('.health-printer-test-btn').forEach(btn => {
      btn.addEventListener('click', () => testPrinter(btn.dataset.ip, btn.dataset.protocol))
    })
  }

  // Terminals
  const tEl = document.getElementById('health-terminals')
  if (terminals.length === 0) {
    tEl.innerHTML = '<p class="health-empty">No terminals configured</p>'
  } else {
    const statusDot = s => {
      if (s === 'connected') return 'ok'
      if (s === 'bridge_only') return 'warn'
      if (s === 'offline') return 'error'
      return 'unknown'
    }
    const statusLabel = s => {
      if (s === 'connected') return 'Connected'
      if (s === 'bridge_only') return 'Bridge only'
      if (s === 'offline') return 'Offline'
      return 'Configured'
    }
    tEl.innerHTML = terminals.map(t => `
      <div class="health-device-row">
        <span class="health-status-dot ${statusDot(t.status)}"></span>
        <span class="health-device-name">${esc(t.nickname)}</span>
        <span class="health-device-meta">${esc(t.displayName)}${t.serialNumber ? ' · ' + esc(t.serialNumber) : ''}</span>
        <span class="health-device-meta">${statusLabel(t.status)}</span>
      </div>
    `).join('')
  }

  // Recent errors
  const eEl = document.getElementById('health-errors-list')
  if (!recentErrors || recentErrors.length === 0) {
    eEl.innerHTML = '<p class="health-empty">No errors recorded</p>'
  } else {
    eEl.innerHTML = recentErrors.slice(0, 50).map(e => `
      <div class="health-error-row">
        <span class="health-error-ts">${esc(fmtDateTime(e.timestamp))}</span>
        <span class="health-error-msg">${esc(e.message)}</span>
      </div>
    `).join('')
  }

  document.getElementById('health-last-refresh').textContent = 'Refreshed ' + fmtTime(timestamp)
}

// ── Printer test ─────────────────────────────────────────────────────────────

async function testPrinter(ip, protocol) {
  const mid   = state.merchantId
  const rowId = 'hpr-' + ip.replace(/\./g, '-')
  const diagId = 'hpd-' + ip.replace(/\./g, '-')
  const row  = document.getElementById(rowId)
  const diag = document.getElementById(diagId)
  if (!row || !diag) return

  const dot = row.querySelector('.health-status-dot')
  if (dot) dot.className = 'health-status-dot warn'
  diag.hidden = false
  diag.textContent = 'Testing…'

  try {
    const res = await api(`/api/merchants/${mid}/system/printer-test`, {
      method: 'POST',
      body: JSON.stringify({ ip, protocol }),
      timeout: 12_000,
    })
    const data = await res.json()
    const allOk = data.results.every(r => r.success)
    if (dot) dot.className = 'health-status-dot ' + (allOk ? 'ok' : 'error')
    diag.textContent = data.results.map(r => (r.success ? '✓' : '✗') + ' ' + r.test + ': ' + r.detail).join('\n')
  } catch (err) {
    if (dot) dot.className = 'health-status-dot error'
    diag.textContent = 'Error: ' + err.message
  }
}

// ── SVG Sparkline charts ─────────────────────────────────────────────────────

/**
 * Draw a line sparkline into a container element.
 * @param {HTMLElement} container
 * @param {number[]} values  — data points (0–maxVal)
 * @param {{ maxVal: number, color: string, fillColor: string, label?: string }} opts
 */
function drawSparkline(container, values, opts) {
  const W = container.clientWidth  || 300
  const H = container.clientHeight || 100
  if (values.length < 2) {
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text x="50%" y="50%" text-anchor="middle" fill="#aaa" font-size="12">Collecting data…</text></svg>`
    return
  }

  const maxVal   = opts.maxVal   ?? 100
  const color    = opts.color    ?? '#6c63ff'
  const fill     = opts.fillColor ?? 'rgba(108,99,255,0.12)'
  const pad      = 2
  const n        = values.length
  const xStep    = (W - pad * 2) / (n - 1)

  const pts = values.map((v, i) => {
    const x = pad + i * xStep
    const y = H - pad - ((Math.min(v, maxVal) / maxVal) * (H - pad * 2))
    return [x, y]
  })

  const linePath  = 'M ' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')
  const areaPath  = linePath + ` L ${pts[n-1][0].toFixed(1)},${H} L ${pts[0][0].toFixed(1)},${H} Z`

  // Y-axis grid lines at 25% intervals
  const grids = [25, 50, 75].map(pct => {
    const y = H - pad - (pct / 100 * (H - pad * 2))
    return `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${W - pad}" y2="${y.toFixed(1)}" stroke="#f0f0f0" stroke-width="1"/>`
  }).join('')

  const lastVal = values[values.length - 1]
  const label   = opts.label ? `<text x="${W - 4}" y="14" text-anchor="end" fill="${color}" font-size="11" font-weight="600">${opts.label(lastVal)}</text>` : ''

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${grids}
      <path d="${areaPath}" fill="${fill}" />
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${label}
    </svg>`
}

function drawCpuChart(cpuHistory) {
  const el = document.getElementById('health-cpu-chart')
  if (!el) return
  const values = cpuHistory.map(s => s.pct)
  drawSparkline(el, values, {
    maxVal: 100,
    color: '#6c63ff',
    fillColor: 'rgba(108,99,255,0.10)',
    label: v => v + '%',
  })
}

function drawMemChart(memHistory, sysTotal) {
  const el = document.getElementById('health-mem-chart')
  if (!el) return
  const values = memHistory.map(s => s.rss)
  const maxVal = sysTotal > 0 ? sysTotal : Math.max(...values) * 1.2
  drawSparkline(el, values, {
    maxVal,
    color: '#48bb78',
    fillColor: 'rgba(72,187,120,0.10)',
    label: v => fmtBytes(v),
  })
}

// ---------------------------------------------------------------------------
// Store Profile
// ---------------------------------------------------------------------------

async function loadProfile() {
  try {
    const res = await api(`/api/merchants/${state.merchantId}`)
    if (!res.ok) {
      if (res.status === 401) { clearAuth(); window.location.href = '/setup'; return }
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    state.profile = await res.json()
    populateProfileForm(state.profile)
    loadServerLocalIps()
    document.dispatchEvent(new CustomEvent('profile:loaded', { detail: state.profile }))
  } catch (err) {
    showToast(`Could not load store profile: ${err.message}`, 'error')
  }
}

/**
 * Fetch the server's local network IPs and render clickable copy-to-clipboard
 * badges in #server-local-ips (Store Profile → Server section).
 */
async function loadServerLocalIps() {
  const container = document.getElementById('server-local-ips')
  if (!container) return
  try {
    const res = await api(`/api/merchants/${state.merchantId}/local-ips`)
    if (!res.ok) { container.innerHTML = '<span class="helper-text">Unavailable</span>'; return }
    const { ips } = await res.json()
    if (!ips.length) { container.innerHTML = '<span class="helper-text">No network interfaces found</span>'; return }
    container.innerHTML = ips.map(({ iface, ip }) =>
      `<button type="button" class="server-ip-badge" data-ip="${escHtml(ip)}" title="Click to copy">` +
        `<span class="server-ip-value">${escHtml(ip)}</span>` +
        `<span class="server-ip-iface">${escHtml(iface)}</span>` +
      `</button>`
    ).join('')
    container.querySelectorAll('.server-ip-badge').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.ip).then(() => {
          showToast(`Copied ${btn.dataset.ip}`, 'success')
        }).catch(() => {})
      })
    })
  } catch {
    container.innerHTML = '<span class="helper-text">Could not load server IPs</span>'
  }
}

function populateProfileForm(profile) {
  setValue('store-name', profile.businessName ?? '')
  setValue('store-phone', profile.phoneNumber ?? '')
  setValue('store-email', profile.email ?? '')
  setValue('store-website', profile.website ?? '')
  setValue('store-tax-rate', profile.taxRate != null ? (profile.taxRate * 100).toFixed(2) : '')
  setValue('store-stax-token', profile.staxToken ?? '')
  updateStaxBadge(profile.staxToken)

  // Kitchen printer
  setValue('store-kitchen-printer-ip', profile.printerIp ?? '')
  setSelectValue('store-kitchen-printer-protocol', profile.kitchenPrinterProtocol ?? 'star-line')

  // Counter printer — toggle off if a distinct IP is saved
  var counterSame = !profile.counterPrinterIp || profile.counterPrinterIp === profile.printerIp
  document.getElementById('store-counter-printer-same').checked = counterSame
  var counterInput = document.getElementById('store-counter-printer-ip')
  var counterProtoSelect = document.getElementById('store-counter-printer-protocol')
  counterInput.disabled = counterSame
  counterProtoSelect.disabled = counterSame
  counterInput.value = counterSame ? '' : (profile.counterPrinterIp ?? '')
  setSelectValue('store-counter-printer-protocol', profile.counterPrinterProtocol ?? 'star-line')

  // Receipt printer — toggle off if a distinct IP is saved
  var receiptSame = !profile.receiptPrinterIp || profile.receiptPrinterIp === profile.printerIp
  document.getElementById('store-receipt-printer-same').checked = receiptSame
  var receiptInput = document.getElementById('store-receipt-printer-ip')
  var receiptProtoSelect = document.getElementById('store-receipt-printer-protocol')
  receiptInput.disabled = receiptSame
  receiptProtoSelect.disabled = receiptSame
  receiptInput.value = receiptSame ? '' : (profile.receiptPrinterIp ?? '')
  setSelectValue('store-receipt-printer-protocol', profile.receiptPrinterProtocol ?? 'star-line')

  // Ticket style (html vs classic)
  setSelectValue('store-receipt-style', profile.receiptStyle ?? 'classic')

  // Probe configured printer IPs for online/offline status
  probePrinterStatus(profile.printerIp, profile.counterPrinterIp, profile.receiptPrinterIp)

  // Email receipts
  const emailFromInput = document.getElementById('store-receipt-email-from')
  if (emailFromInput) emailFromInput.value = profile.receiptEmailFrom ?? ''
  const emailStatus = document.getElementById('email-receipts-status')
  if (emailStatus) {
    if (profile.receiptEmailConfigured && profile.receiptEmailFrom) {
      emailStatus.textContent = `Configured — sending from ${profile.receiptEmailFrom}`
      emailStatus.style.color = 'var(--color-success, #2ecc71)'
    } else if (profile.receiptEmailConfigured) {
      emailStatus.textContent = 'App Password saved. Enter a Gmail address to complete setup.'
      emailStatus.style.color = 'var(--color-warning, #f39c12)'
    } else {
      emailStatus.textContent = 'Not configured — customers cannot receive email receipts.'
      emailStatus.style.color = ''
    }
  }

  setValue('store-address', profile.address ?? '')
  setValue('store-description', profile.description ?? '')

  // Populate tip options
  const tips = profile.tipOptions ?? [15, 20, 25]
  document.querySelectorAll('.tip-option-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', String(tips.includes(Number(btn.dataset.tip))))
  })

  // Tip-on-terminal toggle + terminal tip percentages
  const totToggle  = document.getElementById('store-tip-on-terminal')
  const totPctArea = document.getElementById('tip-on-terminal-pcts')
  if (totToggle && totPctArea) {
    totToggle.checked        = profile.tipOnTerminal === true
    totPctArea.style.display = profile.tipOnTerminal ? '' : 'none'
    const termTips = profile.suggestedTipPercentages ?? [15, 20, 25]
    document.querySelectorAll('.terminal-tip-btn').forEach(btn => {
      btn.setAttribute('aria-pressed', String(termTips.includes(Number(btn.dataset.tip))))
    })
  }

  // Employee sales sharing toggle
  const salesToggle = document.getElementById('store-show-employee-sales')
  if (salesToggle) salesToggle.checked = profile.showEmployeeSales !== false

  // Pay period config
  setSelectValue('store-pay-period-type', profile.payPeriodType ?? 'biweekly')
  const anchorInput = document.getElementById('store-pay-period-anchor')
  if (anchorInput) anchorInput.value = profile.payPeriodAnchor ?? ''
  const anchorRow = document.getElementById('pay-period-anchor-row')
  if (anchorRow) anchorRow.hidden = (profile.payPeriodType ?? 'biweekly') === 'semimonthly'

  // Break rule
  const breakEnabled = document.getElementById('store-break-rule-enabled')
  const breakDetail  = document.getElementById('break-rule-detail')
  const hasBreak = !!profile.breakRule
  if (breakEnabled) breakEnabled.checked = hasBreak
  if (breakDetail)  breakDetail.hidden   = !hasBreak
  if (hasBreak && profile.breakRule) {
    setValue('store-break-threshold', String(profile.breakRule.thresholdHours ?? 5))
    setValue('store-break-deduction', String(profile.breakRule.deductionMinutes ?? 30))
  }

  // Kitchen prep time
  const prepTimeInput = document.getElementById('store-prep-time')
  if (prepTimeInput) prepTimeInput.value = profile.prepTimeMinutes ?? 20

  // Refund permissions
  const staffCanRefundToggle = document.getElementById('store-staff-can-refund')
  if (staffCanRefundToggle) staffCanRefundToggle.checked = profile.staffCanRefund === true

  // Notification sound
  const soundSelect = document.getElementById('store-notification-sound')
  if (soundSelect) soundSelect.value = profile.notificationSound ?? 'chime'

  // Active payment provider
  const providerSelect = document.getElementById('payment-active-provider')
  if (providerSelect) providerSelect.value = profile.paymentProvider ?? ''

  // Populate brand images
  setBrandPreview('logo', profile.logoUrl ?? null)
  setBrandPreview('banner', profile.bannerUrl ?? null)
  setBrandPreview('splash', profile.splashUrl ?? null)

  // Populate welcome message
  const welcomeEl = document.getElementById('welcome-message-input')
  if (welcomeEl) welcomeEl.value = profile.welcomeMessage ?? ''

  // Reservation settings
  const resEnabledCb = document.getElementById('store-reservation-enabled')
  if (resEnabledCb) resEnabledCb.checked = !!profile.reservationEnabled
  const resSlotEl   = document.getElementById('store-reservation-slot-minutes')
  if (resSlotEl)   resSlotEl.value   = profile.reservationSlotMinutes   ?? 120
  const resCutoffEl = document.getElementById('store-reservation-cutoff-minutes')
  if (resCutoffEl) resCutoffEl.value = profile.reservationCutoffMinutes ?? 75
  const resAdvEl    = document.getElementById('store-reservation-advance-days')
  if (resAdvEl)    resAdvEl.value    = profile.reservationAdvanceDays    ?? 7
  const resMaxEl    = document.getElementById('store-reservation-max-party')
  if (resMaxEl)    resMaxEl.value    = profile.reservationMaxPartySize   ?? 12
  const resStartEl  = document.getElementById('store-reservation-start-time')
  if (resStartEl)  resStartEl.value  = profile.reservationStartTime      ?? ''

  // Populate table layout
  loadTableLayout(profile.tableLayout ?? null)

  // Populate discount presets
  renderDiscountLevels(profile.discountLevels ?? [])

  // Populate service charge presets
  renderServiceChargePresets(profile.serviceChargePresets ?? [])
}

// ---------------------------------------------------------------------------
// Discount preset list management (Store Profile)
// ---------------------------------------------------------------------------

function renderDiscountLevels(levels) {
  const list = document.getElementById('discount-levels-list')
  if (!list) return
  list.innerHTML = ''
  if (!levels.length) {
    list.innerHTML = '<tr class="discount-empty-row"><td colspan="4">No presets yet — add one below.</td></tr>'
  }
  for (const lvl of levels) _appendDiscountRow(list, lvl.label, lvl.type, lvl.value)
}

/** Appends a read-only display row to the discount presets tbody. */
function _appendDiscountRow(tbody, label, type, value) {
  // Clear empty-state placeholder on first real row
  tbody.querySelector('.discount-empty-row')?.remove()
  const tr = document.createElement('tr')
  tr.className = 'discount-level-row'
  tr.dataset.label = label
  tr.dataset.type  = type
  tr.dataset.value = String(value)
  const typeLabel = type === 'percent' ? '%' : '$'
  tr.innerHTML = `
    <td class="dl-cell-label">${escHtml(String(label))}</td>
    <td class="dl-cell-value">${escHtml(String(value))}</td>
    <td class="dl-cell-type">${typeLabel}</td>
    <td class="dl-cell-del">
      <button type="button" class="btn-icon dl-remove" aria-label="Remove preset">✕</button>
    </td>
  `
  tr.querySelector('.dl-remove').addEventListener('click', () => {
    tr.remove()
    const list = document.getElementById('discount-levels-list')
    if (list && !list.querySelector('.discount-level-row')) {
      list.innerHTML = '<tr class="discount-empty-row"><td colspan="4">No presets yet — add one below.</td></tr>'
    }
  })
  tbody.appendChild(tr)
}

// "Add" button in the tfoot — wired with event delegation so it always fires
// regardless of script execution order.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#discount-add-btn')) return
  const labelEl = document.getElementById('dl-new-label')
  const valueEl = document.getElementById('dl-new-value')
  const typeEl  = document.getElementById('dl-new-type')
  if (!labelEl || !valueEl || !typeEl) return
  const label = labelEl.value.trim()
  const value = parseFloat(valueEl.value)
  const type  = typeEl.value
  if (!label) {
    labelEl.focus()
    labelEl.style.outline = '2px solid var(--color-danger, #dc2626)'
    setTimeout(() => { labelEl.style.outline = '' }, 1200)
    return
  }
  if (!value || value <= 0) {
    valueEl.focus()
    valueEl.style.outline = '2px solid var(--color-danger, #dc2626)'
    setTimeout(() => { valueEl.style.outline = '' }, 1200)
    return
  }
  const list = document.getElementById('discount-levels-list')
  if (list) _appendDiscountRow(list, label, type, value)
  labelEl.value = ''
  valueEl.value = ''
  typeEl.value  = 'percent'
  labelEl.focus()
})

// ---------------------------------------------------------------------------
// Service Charge Presets (Store Profile)
// ---------------------------------------------------------------------------

function renderServiceChargePresets(presets) {
  const list = document.getElementById('service-charge-presets-list')
  if (!list) return
  list.innerHTML = ''
  if (!presets.length) {
    list.innerHTML = '<tr class="discount-empty-row"><td colspan="4">No presets yet — add one below.</td></tr>'
  }
  for (const lvl of presets) _appendServiceChargeRow(list, lvl.label, lvl.type, lvl.value)
}

function _appendServiceChargeRow(tbody, label, type, value) {
  tbody.querySelector('.discount-empty-row')?.remove()
  const tr = document.createElement('tr')
  tr.className = 'discount-level-row sc-preset-row'
  tr.dataset.label = label
  tr.dataset.type  = type
  tr.dataset.value = String(value)
  const typeLabel = type === 'percent' ? '%' : '$'
  tr.innerHTML = `
    <td class="dl-cell-label">${escHtml(String(label))}</td>
    <td class="dl-cell-value">${escHtml(String(value))}</td>
    <td class="dl-cell-type">${typeLabel}</td>
    <td class="dl-cell-del">
      <button type="button" class="btn-icon dl-remove" aria-label="Remove preset">✕</button>
    </td>
  `
  tr.querySelector('.dl-remove').addEventListener('click', () => {
    tr.remove()
    const list = document.getElementById('service-charge-presets-list')
    if (list && !list.querySelector('.sc-preset-row')) {
      list.innerHTML = '<tr class="discount-empty-row"><td colspan="4">No presets yet — add one below.</td></tr>'
    }
  })
  tbody.appendChild(tr)
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#service-charge-add-btn')) return
  const labelEl = document.getElementById('sc-new-label')
  const valueEl = document.getElementById('sc-new-value')
  const typeEl  = document.getElementById('sc-new-type')
  if (!labelEl || !valueEl || !typeEl) return
  const label = labelEl.value.trim()
  const value = parseFloat(valueEl.value)
  const type  = typeEl.value
  if (!label) {
    labelEl.focus()
    labelEl.style.outline = '2px solid var(--color-danger, #dc2626)'
    setTimeout(() => { labelEl.style.outline = '' }, 1200)
    return
  }
  if (!value || value <= 0) {
    valueEl.focus()
    valueEl.style.outline = '2px solid var(--color-danger, #dc2626)'
    setTimeout(() => { valueEl.style.outline = '' }, 1200)
    return
  }
  const list = document.getElementById('service-charge-presets-list')
  if (list) _appendServiceChargeRow(list, label, type, value)
  labelEl.value = ''
  valueEl.value = ''
  typeEl.value  = 'percent'
  labelEl.focus()
})

// ---------------------------------------------------------------------------
// Terminal list management (Store Profile)
// ---------------------------------------------------------------------------

const TERMINAL_MODEL_LABELS = {
  pax_a800:     'Pax A800',
  pax_a920_pro: 'Pax A920 Pro',
  pax_a920_emu: 'Pax A920 Pro (Emulator)',
  pax_d135:     'Pax D135',
}

/** Shows or hides the emulator option in the terminal model dropdown based on sandbox state. */
function updateTerminalEmuOption(sandboxEnabled) {
  const opt = document.querySelector('#term-new-model .term-emu-option')
  if (!opt) return
  opt.hidden = !sandboxEnabled
  // If emulator was selected but sandbox is now off, fall back to first option
  const sel = document.getElementById('term-new-model')
  if (!sandboxEnabled && sel?.value === 'pax_a920_emu') sel.value = 'pax_a920_pro'
  _updateTerminalAddForm()
}

/** Adjusts the serial # and device ID hint cells based on the selected model. */
function _updateTerminalAddForm() {
  const model = document.getElementById('term-new-model')?.value
  const serialInput = document.getElementById('term-new-serial')
  const deviceHint = document.getElementById('term-new-device-hint')
  if (!serialInput || !deviceHint) return
  if (model === 'pax_a920_emu') {
    serialInput.value = ''
    serialInput.disabled = true
    serialInput.placeholder = 'N/A'
    deviceHint.textContent = 'Auto-set to emulator device ID'
  } else {
    serialInput.disabled = false
    serialInput.placeholder = 'Optional serial #'
    deviceHint.textContent = 'Auto-resolved from serial #'
  }
}

document.getElementById('term-new-model')?.addEventListener('change', _updateTerminalAddForm)

async function loadTerminals() {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/terminals`)
    if (!res.ok) return
    const { terminals } = await res.json()
    renderTerminals(terminals)
  } catch (err) {
    console.warn('[loadTerminals] failed:', err)
  }
}

function renderTerminals(terminals) {
  const list = document.getElementById('terminals-list')
  if (!list) return
  list.innerHTML = ''
  if (!terminals.length) {
    list.innerHTML = '<tr class="terminals-empty-row"><td colspan="5">No terminals yet — add one below.</td></tr>'
    return
  }
  for (const t of terminals) _appendTerminalRow(list, t)
}

/** Appends a read-only display row to the terminals tbody. */
function _appendTerminalRow(tbody, terminal) {
  tbody.querySelector('.terminals-empty-row')?.remove()
  const tr = document.createElement('tr')
  tr.className = 'terminal-row'
  tr.dataset.id    = terminal.id
  tr.dataset.model = terminal.model
  const deviceIdCell = terminal.model === 'pax_a920_emu'
    ? `<span class="term-device-id-emu" title="Emulator device ID: ${escHtml(terminal.finixDeviceId ?? '')}">Emulator</span>`
    : terminal.finixDeviceId
      ? `<code class="term-device-id">${escHtml(terminal.finixDeviceId)}</code>`
      : `<span class="term-device-id-missing" title="Add the terminal and enter its serial number to auto-resolve">—</span>`
  tr.innerHTML = `
    <td class="term-cell-model">${escHtml(TERMINAL_MODEL_LABELS[terminal.model] ?? terminal.model)}</td>
    <td class="term-cell-nickname">${escHtml(terminal.nickname)}</td>
    <td class="term-cell-serial">${escHtml(terminal.serialNumber ?? '—')}</td>
    <td class="term-cell-device-id">${deviceIdCell}</td>
    <td class="term-cell-del">
      <button type="button" class="btn-icon term-remove" aria-label="Remove terminal">✕</button>
    </td>
  `
  tr.querySelector('.term-remove').addEventListener('click', async () => {
    if (!confirm(`Remove terminal "${terminal.nickname}"?`)) return
    const res = await api(`/api/merchants/${state.merchantId}/terminals/${terminal.id}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      tr.remove()
      const list = document.getElementById('terminals-list')
      if (list && !list.querySelector('.terminal-row')) {
        list.innerHTML = '<tr class="terminals-empty-row"><td colspan="5">No terminals yet — add one below.</td></tr>'
      }
    }
  })
  tbody.appendChild(tr)
}

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#terminal-add-btn')) return
  const modelEl    = document.getElementById('term-new-model')
  const nicknameEl = document.getElementById('term-new-nickname')
  const serialEl   = document.getElementById('term-new-serial')
  if (!modelEl || !nicknameEl || !serialEl) return
  const nickname = nicknameEl.value.trim()
  if (!nickname) {
    nicknameEl.focus()
    nicknameEl.style.outline = '2px solid var(--color-danger, #dc2626)'
    setTimeout(() => { nicknameEl.style.outline = '' }, 1200)
    return
  }
  const btn = e.target.closest('#terminal-add-btn')
  btn.disabled    = true
  btn.textContent = 'Adding…'
  try {
    const isEmu = modelEl.value === 'pax_a920_emu'
    const res = await api(`/api/merchants/${state.merchantId}/terminals`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:        modelEl.value,
        nickname,
        serialNumber: isEmu ? undefined : (serialEl.value.trim() || undefined),
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { terminal } = await res.json()
    const list = document.getElementById('terminals-list')
    if (list) _appendTerminalRow(list, terminal)
    nicknameEl.value = ''
    serialEl.value   = ''
    nicknameEl.focus()
  } catch (err) {
    console.error('[terminal-add]', err)
  } finally {
    btn.disabled    = false
    btn.textContent = 'Add'
  }
})

document.getElementById('save-profile-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('save-profile-btn')
  btn.disabled = true
  btn.textContent = 'Saving…'
  try {
    const res = await api(`/api/merchants/${state.merchantId}`, {
      method: 'PUT',
      body: JSON.stringify({
        businessName: getValue('store-name'),
        phoneNumber: getValue('store-phone'),
        email: getValue('store-email'),
        website: getValue('store-website'),
        taxRate: parseFloat(getValue('store-tax-rate')) / 100 || 0,
        staxToken: getValue('store-stax-token').trim() || '',
        printerIp: getValue('store-kitchen-printer-ip').trim() || null,
        counterPrinterIp: document.getElementById('store-counter-printer-same').checked
          ? null
          : (getValue('store-counter-printer-ip').trim() || null),
        receiptPrinterIp: document.getElementById('store-receipt-printer-same').checked
          ? null
          : (getValue('store-receipt-printer-ip').trim() || null),
        kitchenPrinterProtocol: document.getElementById('store-kitchen-printer-protocol').value || 'star-line',
        counterPrinterProtocol: document.getElementById('store-counter-printer-protocol').value || 'star-line',
        receiptPrinterProtocol: document.getElementById('store-receipt-printer-protocol').value || 'star-line',
        receiptStyle: document.getElementById('store-receipt-style').value || 'classic',
        tipOptions: [...document.querySelectorAll('.tip-option-btn:not(.terminal-tip-btn)[aria-pressed="true"]')]
          .map(b => Number(b.dataset.tip))
          .sort((a, b) => a - b),
        tipOnTerminal: document.getElementById('store-tip-on-terminal')?.checked ?? false,
        suggestedTipPercentages: [...document.querySelectorAll('.terminal-tip-btn[aria-pressed="true"]')]
          .map(b => Number(b.dataset.tip))
          .sort((a, b) => a - b),
        address: getValue('store-address'),
        description: getValue('store-description'),
        showEmployeeSales: document.getElementById('store-show-employee-sales')?.checked ?? true,
        convergeSandbox: document.getElementById('store-converge-sandbox')?.checked ?? true,
        paymentProvider: document.getElementById('payment-active-provider')?.value || null,
        payPeriodType: document.getElementById('store-pay-period-type')?.value ?? 'biweekly',
        payPeriodAnchor: document.getElementById('store-pay-period-anchor')?.value || null,
        breakRule: document.getElementById('store-break-rule-enabled')?.checked
          ? {
              thresholdHours:   parseFloat(getValue('store-break-threshold'))  || 5,
              deductionMinutes: parseInt(getValue('store-break-deduction'), 10) || 30,
            }
          : null,
        notificationSound: document.getElementById('store-notification-sound')?.value ?? 'chime',
        prepTimeMinutes: parseInt(document.getElementById('store-prep-time')?.value ?? '20', 10) || 20,
        staffCanRefund: document.getElementById('store-staff-can-refund')?.checked ?? false,
        discountLevels: [...document.querySelectorAll('#discount-levels-list .discount-level-row')].map(tr => ({
          label: tr.dataset.label ?? '',
          type:  tr.dataset.type  ?? 'percent',
          value: parseFloat(tr.dataset.value) || 0,
        })).filter(d => d.label && d.value > 0),
        serviceChargePresets: [...document.querySelectorAll('#service-charge-presets-list .sc-preset-row')].map(tr => ({
          label: tr.dataset.label ?? '',
          type:  tr.dataset.type  ?? 'percent',
          value: parseFloat(tr.dataset.value) || 0,
        })).filter(d => d.label && d.value > 0),
        receiptEmailFrom: (document.getElementById('store-receipt-email-from')?.value ?? '').trim() || null,
        ...(document.getElementById('store-receipt-email-password')?.value?.trim()
          ? { receiptEmailPassword: document.getElementById('store-receipt-email-password').value.trim() }
          : {}),
        reservationEnabled: document.getElementById('store-reservation-enabled')?.checked ?? false,
        reservationSlotMinutes: parseInt(document.getElementById('store-reservation-slot-minutes')?.value ?? '120', 10) || 120,
        reservationCutoffMinutes: parseInt(document.getElementById('store-reservation-cutoff-minutes')?.value ?? '75', 10) || 75,
        reservationAdvanceDays: parseInt(document.getElementById('store-reservation-advance-days')?.value ?? '7', 10) || 7,
        reservationMaxPartySize: parseInt(document.getElementById('store-reservation-max-party')?.value ?? '12', 10) || 12,
        reservationStartTime: document.getElementById('store-reservation-start-time')?.value?.trim() || null,
      }),
    })
    if (!res.ok) throw new Error('Save failed')
    // Clear password field — never re-populate for security
    const pwField = document.getElementById('store-receipt-email-password')
    if (pwField) pwField.value = ''
    const savedData = await res.json().catch(() => null)
    if (savedData) {
      const emailStatus = document.getElementById('email-receipts-status')
      if (emailStatus) {
        if (savedData.receiptEmailConfigured && savedData.receiptEmailFrom) {
          emailStatus.textContent = `Configured — sending from ${savedData.receiptEmailFrom}`
          emailStatus.style.color = 'var(--color-success, #2ecc71)'
        } else if (savedData.receiptEmailConfigured) {
          emailStatus.textContent = 'App Password saved. Enter a Gmail address to complete setup.'
          emailStatus.style.color = 'var(--color-warning, #f39c12)'
        } else {
          emailStatus.textContent = 'Not configured — customers cannot receive email receipts.'
          emailStatus.style.color = ''
        }
      }
    }
    showToast('Store profile saved', 'success')
  } catch {
    showToast('Failed to save profile', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Changes'
  }
})

document.getElementById('deploy-btn')?.addEventListener('click', async () => {
  if (!confirm('Pull latest code from GitHub and restart the server?')) return
  const btn = document.getElementById('deploy-btn')
  btn.disabled = true
  btn.textContent = 'Deploying…'
  try {
    await api(`/api/merchants/${state.merchantId}/deploy`, { method: 'POST' })
  } catch {
    // Server may restart before responding — treat as success
  }
  showToast('Deploy started — page will reload in 20 seconds', 'success')
  btn.textContent = 'Restarting…'
  setTimeout(() => window.location.reload(), 20000)
})

/**
 * Binds "Same as Kitchen" checkboxes for counter and receipt printer fields.
 */
function initPrinterToggles() {
  function bindToggle(checkboxId, inputId, protocolId) {
    var checkbox = document.getElementById(checkboxId)
    var input    = document.getElementById(inputId)
    var proto    = document.getElementById(protocolId)
    if (!checkbox || !input) return

    checkbox.addEventListener('change', function() {
      if (checkbox.checked) {
        input.disabled = true
        input.value = ''
        if (proto) proto.disabled = true
      } else {
        input.disabled = false
        if (proto) proto.disabled = false
        input.focus()
      }
    })
  }

  bindToggle('store-counter-printer-same', 'store-counter-printer-ip', 'store-counter-printer-protocol')
  bindToggle('store-receipt-printer-same', 'store-receipt-printer-ip', 'store-receipt-printer-protocol')
}

/**
 * Printer discovery — "Scan for printers" button.
 * Calls GET /api/merchants/:id/printers/discover, then renders found printers
 * with assign-to-Kitchen/Counter/Receipt action pills.
 */
function initPrinterDiscovery() {
  var btn = document.getElementById('scan-printers-btn')
  if (btn) btn.addEventListener('click', function() { scanForPrinters() })

  var diagBtn = document.getElementById('diagnose-printer-btn')
  if (diagBtn) diagBtn.addEventListener('click', function() { diagnosePrinter() })
}

/**
 * Init test-print buttons (data-printer="kitchen|counter|receipt").
 * Resolves the effective IP at click time so it picks up unsaved field edits.
 */
function initTestPrintButtons() {
  document.querySelectorAll('.btn-test-print').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var role = btn.getAttribute('data-printer')   // kitchen | counter | receipt
      testPrint(role, btn)
    })
  })
}

/**
 * Send a test page to the printer for the given role.
 * Reads current IP + protocol values straight from the form fields.
 * @param {'kitchen'|'counter'|'receipt'} role
 * @param {HTMLElement} btn  — the button element (for loading state)
 */
async function testPrint(role, btn) {
  var kitchenIp   = getValue('store-kitchen-printer-ip')
  var kitchenProto = document.getElementById('store-kitchen-printer-protocol')?.value ?? 'star-line'

  var ipMap = {
    kitchen: { ip: kitchenIp, proto: kitchenProto },
    counter: {
      ip: (document.getElementById('store-counter-printer-same')?.checked
        ? kitchenIp
        : getValue('store-counter-printer-ip')) || kitchenIp,
      proto: (document.getElementById('store-counter-printer-same')?.checked
        ? kitchenProto
        : document.getElementById('store-counter-printer-protocol')?.value) ?? kitchenProto,
    },
    receipt: {
      ip: (document.getElementById('store-receipt-printer-same')?.checked
        ? kitchenIp
        : getValue('store-receipt-printer-ip')) || kitchenIp,
      proto: (document.getElementById('store-receipt-printer-same')?.checked
        ? kitchenProto
        : document.getElementById('store-receipt-printer-protocol')?.value) ?? kitchenProto,
    },
  }

  var entry = ipMap[role]
  if (!entry || !entry.ip) {
    showToast('No IP configured for ' + role + ' printer', 'error')
    return
  }

  var label = role.charAt(0).toUpperCase() + role.slice(1)

  var origText = btn.textContent
  btn.disabled = true
  btn.textContent = '…'

  try {
    var res = await api('/api/merchants/' + state.merchantId + '/printers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: entry.ip, protocol: entry.proto, label }),
    })
    var data = await res.json()
    if (data.success) {
      btn.textContent = '✓'
      btn.classList.add('btn-test-print--ok')
      setTimeout(function() {
        btn.textContent = origText
        btn.classList.remove('btn-test-print--ok')
        btn.disabled = false
      }, 2000)
    } else {
      throw new Error(data.error || 'Print failed')
    }
  } catch (err) {
    btn.textContent = '✗'
    btn.classList.add('btn-test-print--err')
    showToast('Test print failed: ' + err.message, 'error')
    setTimeout(function() {
      btn.textContent = origText
      btn.classList.remove('btn-test-print--err')
      btn.disabled = false
    }, 2500)
  }
}

async function scanForPrinters() {
  var merchantId = localStorage.getItem('merchantId')
  if (!merchantId) return

  var btn     = document.getElementById('scan-printers-btn')
  var status  = document.getElementById('scan-printers-status')
  var results = document.getElementById('scan-printers-results')
  if (!btn || !status || !results) return

  // Loading state
  btn.disabled = true
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Scanning\u2026'
  status.hidden = true
  results.hidden = true
  results.innerHTML = ''

  try {
    var res = await api('/api/merchants/' + merchantId + '/printers/discover')
    var data = await res.json()

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Scan failed')
    }

    var printers = data.printers || []

    if (printers.length === 0) {
      status.textContent = 'No printers found on local network'
      status.hidden = false
    } else {
      renderPrinterScanResults(printers, results)
      results.hidden = false
    }
  } catch (err) {
    status.textContent = 'Scan error: ' + (err.message || err)
    status.hidden = false
  } finally {
    btn.disabled = false
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> Scan again'
  }
}

/**
 * Run printer diagnostics: HTTP probe, WebPRNT test, raw TCP tests.
 * Uses the kitchen printer IP from the form.
 */
async function diagnosePrinter() {
  var merchantId = localStorage.getItem('merchantId')
  if (!merchantId) return

  var ip = getValue('store-kitchen-printer-ip')
  if (!ip) {
    showToast('Enter a kitchen printer IP first', 'error')
    return
  }

  var btn     = document.getElementById('diagnose-printer-btn')
  var container = document.getElementById('diagnose-printer-results')
  if (!btn || !container) return

  btn.disabled = true
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Diagnosing\u2026'
  container.hidden = true
  container.innerHTML = ''

  try {
    var res = await api('/api/merchants/' + merchantId + '/printers/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: ip }),
    })
    var data = await res.json()

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Diagnostic failed')
    }

    // Render results
    var results = data.results || []
    var html = '<div class="diagnose-results-inner">'
    html += '<div class="diagnose-header">Diagnostic Results for ' + escHtml(ip) + '</div>'

    results.forEach(function(r) {
      var icon = r.success ? '<span class="diagnose-ok">&#10003;</span>' : '<span class="diagnose-fail">&#10007;</span>'
      html += '<div class="diagnose-row">'
      html += icon + ' <strong>' + escHtml(r.test) + '</strong>: ' + escHtml(r.detail)
      html += '</div>'
    })

    if (data.recommendation) {
      html += '<div class="diagnose-recommendation">' + escHtml(data.recommendation) + '</div>'
    }

    html += '</div>'
    container.innerHTML = html
    container.hidden = false
  } catch (err) {
    container.innerHTML = '<div class="diagnose-results-inner"><div class="diagnose-fail">Diagnostic error: ' + escHtml(err.message || String(err)) + '</div></div>'
    container.hidden = false
  } finally {
    btn.disabled = false
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg> Diagnose again'
  }
}

/**
 * Render scan result cards with assign buttons.
 * @param {Array<{ip:string,port:number,hostname?:string,method:string}>} printers
 * @param {HTMLElement} container
 */
function renderPrinterScanResults(printers, container) {
  container.innerHTML = ''

  printers.forEach(function(printer) {
    var card = document.createElement('div')
    card.className = 'scan-result-item'

    var left = document.createElement('div')
    left.className = 'scan-result-left'

    var ipBadge = document.createElement('span')
    ipBadge.className = 'scan-ip'
    ipBadge.textContent = printer.ip

    var methodBadge = document.createElement('span')
    methodBadge.className = 'scan-method scan-method--' + printer.method
    methodBadge.textContent = printer.method === 'mdns' ? 'Bonjour' : 'TCP'

    var onlineDot = document.createElement('span')
    onlineDot.className = 'scan-online-dot'
    onlineDot.title = 'Checking…'

    left.appendChild(ipBadge)
    left.appendChild(onlineDot)
    if (printer.hostname) {
      var nameEl = document.createElement('span')
      nameEl.className = 'scan-hostname'
      nameEl.textContent = printer.hostname
      left.appendChild(nameEl)
    }
    left.appendChild(methodBadge)

    // Probe this IP immediately (fire-and-forget)
    ;(function(ip, dot) {
      api('/api/merchants/' + state.merchantId + '/printers/status?ips=' + encodeURIComponent(ip))
        .then(function(r) { return r.json() })
        .then(function(d) {
          if (d.success && d.status) {
            var online = !!d.status[ip]
            dot.className = 'scan-online-dot scan-online-dot--' + (online ? 'online' : 'offline')
            dot.title = online ? 'Online' : 'Offline'
          }
        })
        .catch(function() {})
    }(printer.ip, onlineDot))

    var actions = document.createElement('div')
    actions.className = 'scan-result-actions'

    var targets = [
      { id: 'store-kitchen-printer-ip',  label: 'Kitchen' },
      { id: 'store-counter-printer-ip',  label: 'Counter' },
      { id: 'store-receipt-printer-ip',  label: 'Receipt' },
    ]

    targets.forEach(function(target) {
      var pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'btn-assign-printer'
      pill.textContent = target.label
      pill.setAttribute('aria-label', 'Use ' + printer.ip + ' as ' + target.label + ' printer')

      pill.addEventListener('click', function() {
        var input = document.getElementById(target.id)
        if (!input) return

        // Un-check "Same as Kitchen" if counter/receipt are being set independently
        if (target.id === 'store-counter-printer-ip') {
          var cb = document.getElementById('store-counter-printer-same')
          if (cb && cb.checked) { cb.checked = false; input.disabled = false }
        }
        if (target.id === 'store-receipt-printer-ip') {
          var cb2 = document.getElementById('store-receipt-printer-same')
          if (cb2 && cb2.checked) { cb2.checked = false; input.disabled = false }
        }

        input.value = printer.ip
        input.dispatchEvent(new Event('input', { bubbles: true }))

        // Brief visual confirmation
        pill.textContent = '\u2713 Set'
        pill.classList.add('btn-assign-printer--set')
        setTimeout(function() {
          pill.textContent = target.label
          pill.classList.remove('btn-assign-printer--set')
        }, 1500)
      })

      actions.appendChild(pill)
    })

    card.appendChild(left)
    card.appendChild(actions)
    container.appendChild(card)
  })
}

document.querySelectorAll('.tip-option-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const pressed = btn.getAttribute('aria-pressed') === 'true'
    const selected = [...document.querySelectorAll('.tip-option-btn[aria-pressed="true"]')]
    if (pressed && selected.length <= 2) return  // enforce minimum 2
    if (!pressed && selected.length >= 4) return  // enforce maximum 4
    btn.setAttribute('aria-pressed', String(!pressed))
  })
})

// Tip-on-terminal: show/hide percentage selector when toggle changes
document.getElementById('store-tip-on-terminal')?.addEventListener('change', (e) => {
  const area = document.getElementById('tip-on-terminal-pcts')
  if (area) area.style.display = e.target.checked ? '' : 'none'
})

// Terminal tip percentage buttons
document.querySelectorAll('.terminal-tip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const pressed = btn.getAttribute('aria-pressed') === 'true'
    const selected = [...document.querySelectorAll('.terminal-tip-btn[aria-pressed="true"]')]
    if (pressed && selected.length <= 2) return  // enforce minimum 2
    if (!pressed && selected.length >= 4) return  // enforce maximum 4
    btn.setAttribute('aria-pressed', String(!pressed))
  })
})

document.getElementById('save-instructions-btn')?.addEventListener('click', () => {
  showToast('Instructions saved (local only — backend field coming soon)', 'success')
})

// ---------------------------------------------------------------------------
// Store Hours
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** In-memory copy of what's on the server, keyed by serviceType. */
const hoursState = { regular: [], catering: [] }

/** Active tab ('regular' | 'catering'). */
let activeServiceType = 'regular'

/**
 * Loads both regular and catering hours from the API and renders them.
 */
async function loadHours() {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/hours`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    hoursState.regular = data.regular ?? []
    hoursState.catering = data.catering ?? []
  } catch (err) {
    // Non-fatal: render empty grid so the UI is still usable
    console.error('Could not load store hours:', err.message)
  }
  // Always render — empty hoursState means all days show "Closed"
  renderHoursPanel('regular')
  renderHoursPanel('catering')
}

/**
 * Renders the day-of-week grid for one service type panel.
 * @param {'regular'|'catering'} serviceType
 */
function renderHoursPanel(serviceType) {
  const container = document.getElementById(`hours-days-${serviceType}`)
  if (!container) return

  // Group slots by dayOfWeek
  const slotsByDay = new Map()
  for (const slot of hoursState[serviceType]) {
    const arr = slotsByDay.get(slot.dayOfWeek) ?? []
    arr.push(slot)
    slotsByDay.set(slot.dayOfWeek, arr)
  }

  container.innerHTML = ''
  for (let day = 0; day < 7; day++) {
    const slots = slotsByDay.get(day) ?? []
    container.appendChild(buildDayRow(day, slots, serviceType))
  }
}

/**
 * Builds a single day-of-week row element (editable).
 * Collapsed by default; clicking the day bubble expands the slot editor.
 * @param {number} day 0–6
 * @param {Array} slots existing slots for this day
 * @param {'regular'|'catering'} serviceType
 */
function buildDayRow(day, slots, serviceType) {
  const row = document.createElement('div')
  row.className = 'hours-day-row'
  row.dataset.day = day
  row.dataset.service = serviceType

  // Clickable header — the "hour bubble"
  const header = document.createElement('div')
  header.className = 'hours-day-header'
  header.setAttribute('role', 'button')
  header.setAttribute('tabindex', '0')
  header.setAttribute('aria-expanded', 'false')

  const nameEl = document.createElement('span')
  nameEl.className = 'hours-day-name'
  nameEl.textContent = DAY_NAMES[day].slice(0, 3) // Mon, Tue…

  const summaryEl = document.createElement('span')
  summaryEl.className = 'hours-day-summary'

  const chevronEl = document.createElement('span')
  chevronEl.className = 'hours-chevron'
  chevronEl.setAttribute('aria-hidden', 'true')
  chevronEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 6,8 10,4"/></svg>'

  header.appendChild(nameEl)
  header.appendChild(summaryEl)
  header.appendChild(chevronEl)
  row.appendChild(header)

  const slotsCol = document.createElement('div')
  slotsCol.className = 'hours-slots'

  // Track slots as plain objects; rebuildSlots() re-renders from this array
  slotsCol._slots = slots.map(s => ({ open: s.openTime, close: s.closeTime }))

  function updateSummary() {
    if (slotsCol._slots.length === 0) {
      summaryEl.textContent = 'Closed'
      summaryEl.className = 'hours-day-summary hours-summary-closed'
    } else {
      var first = slotsCol._slots[0]
      summaryEl.textContent = slotsCol._slots.length === 1
        ? ((first.open || '?') + ' \u2013 ' + (first.close || '?'))
        : (slotsCol._slots.length + ' slots')
      summaryEl.className = 'hours-day-summary hours-summary-open'
    }
  }

  function rebuildSlots() {
    slotsCol.innerHTML = ''

    if (slotsCol._slots.length === 0) {
      const closed = document.createElement('span')
      closed.className = 'hours-closed-label'
      closed.textContent = 'Closed'
      slotsCol.appendChild(closed)
    } else {
      slotsCol._slots.forEach((s, idx) => {
        const slotRow = buildSlotRow(s, idx, slotsCol, rebuildSlots)
        slotsCol.appendChild(slotRow)
      })
    }

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'hours-add-slot'
    addBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg> Add slot'
    addBtn.addEventListener('click', () => {
      slotsCol._slots.push({ open: '', close: '' })
      rebuildSlots()
    })
    slotsCol.appendChild(addBtn)

    updateSummary()
  }

  // Toggle expand/collapse
  header.addEventListener('click', () => {
    const isOpen = row.classList.toggle('is-open')
    header.setAttribute('aria-expanded', String(isOpen))
  })
  header.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      header.click()
    }
  })

  rebuildSlots()
  row.appendChild(slotsCol)
  return row
}

/**
 * Builds one time-slot row: [open input] – [close input] [remove button].
 * Syncs values back into the _slots array on change.
 */
function buildSlotRow(slotData, idx, slotsCol, rebuildSlots) {
  const slotEl = document.createElement('div')
  slotEl.className = 'hours-slot'

  const openInput = document.createElement('input')
  openInput.type = 'time'
  openInput.className = 'hours-time-input'
  openInput.value = slotData.open
  openInput.setAttribute('aria-label', 'Opens at')
  openInput.addEventListener('change', () => { slotsCol._slots[idx].open = openInput.value })

  const sep = document.createElement('span')
  sep.className = 'hours-slot-sep'
  sep.setAttribute('aria-hidden', 'true')
  sep.textContent = '–'

  const closeInput = document.createElement('input')
  closeInput.type = 'time'
  closeInput.className = 'hours-time-input'
  closeInput.value = slotData.close
  closeInput.setAttribute('aria-label', 'Closes at')
  closeInput.addEventListener('change', () => { slotsCol._slots[idx].close = closeInput.value })

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className = 'hours-slot-remove'
  removeBtn.setAttribute('aria-label', 'Remove time slot')
  removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
  removeBtn.addEventListener('click', () => {
    slotsCol._slots.splice(idx, 1)
    rebuildSlots()
  })

  slotEl.appendChild(openInput)
  slotEl.appendChild(sep)
  slotEl.appendChild(closeInput)
  slotEl.appendChild(removeBtn)
  return slotEl
}

/**
 * Collects all slot values from a panel's DOM and returns them as an array
 * suitable for the PUT /hours API body.
 */
function collectHoursSlots(serviceType) {
  const container = document.getElementById(`hours-days-${serviceType}`)
  if (!container) return []

  const slots = []
  container.querySelectorAll('.hours-day-row').forEach(row => {
    const day = parseInt(row.dataset.day, 10)
    const slotsCol = row.querySelector('.hours-slots')
    if (!slotsCol || !slotsCol._slots) return
    for (const s of slotsCol._slots) {
      if (s.open && s.close) {
        slots.push({ dayOfWeek: day, openTime: s.open, closeTime: s.close })
      }
    }
  })
  return slots
}

// Tab switching
document.querySelectorAll('.hours-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeServiceType = tab.dataset.service
    document.querySelectorAll('.hours-tab').forEach(t => {
      t.classList.toggle('active', t === tab)
      t.setAttribute('aria-selected', String(t === tab))
    })
    document.getElementById('hours-panel-regular').hidden = activeServiceType !== 'regular'
    document.getElementById('hours-panel-catering').hidden = activeServiceType !== 'catering'
  })
})

// Save hours button
document.getElementById('save-hours-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('save-hours-btn')
  btn.disabled = true
  btn.textContent = 'Saving…'

  try {
    // Save whichever tab is currently active
    const slots = collectHoursSlots(activeServiceType)

    const res = await api(`/api/merchants/${state.merchantId}/hours`, {
      method: 'PUT',
      body: JSON.stringify({ serviceType: activeServiceType, slots }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || `HTTP ${res.status}`)
    }

    // Sync in-memory state with what we just saved
    hoursState[activeServiceType] = slots.map((s, i) => ({
      dayOfWeek: s.dayOfWeek,
      openTime: s.openTime,
      closeTime: s.closeTime,
      slotIndex: i,
    }))

    const label = activeServiceType === 'catering' ? 'Catering' : 'Dining room'
    showToast(`${label} hours saved`, 'success')
  } catch (err) {
    showToast(`Failed to save hours: ${err.message}`, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Hours'
  }
})

// ---------------------------------------------------------------------------
// Scheduled Closures
// ---------------------------------------------------------------------------

/** In-memory list of closures from the server. */
let closuresList = []

/**
 * Loads scheduled closures from the API and renders the list.
 */
async function loadClosures() {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/closures`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    closuresList = await res.json()
  } catch (err) {
    console.error('Could not load closures:', err.message)
  }
  // Always render — empty list shows the "No closures scheduled" state
  renderClosures()
}

/**
 * Re-renders the full closures list from closuresList.
 */
function renderClosures() {
  const list = document.getElementById('closures-list')
  const empty = document.getElementById('closures-empty')
  if (!list || !empty) return

  list.innerHTML = ''
  empty.hidden = closuresList.length > 0

  closuresList.forEach(closure => {
    list.appendChild(buildClosureItem(closure))
  })
}

/**
 * Formats a date range for display. Single-day: "Dec 25". Range: "Dec 24 – Dec 26".
 */
function formatClosureDates(startDate, endDate) {
  const fmt = d => {
    const [, m, day] = d.split('-').map(Number)
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${months[m - 1]} ${day}`
  }
  return startDate === endDate ? fmt(startDate) : `${fmt(startDate)} – ${fmt(endDate)}`
}

/**
 * Builds a closure list item element (read mode).
 * Edit mode is toggled inline when the Edit button is clicked.
 */
function buildClosureItem(closure) {
  const li = document.createElement('li')
  li.className = 'closure-item'
  li.dataset.id = closure.id

  // -- Read view --
  const readView = document.createElement('div')
  readView.className = 'closure-item-read'
  readView.style.cssText = 'display:flex;align-items:center;gap:1rem;flex:1;min-width:0'

  const datesEl = document.createElement('span')
  datesEl.className = 'closure-dates'
  datesEl.textContent = formatClosureDates(closure.startDate, closure.endDate)

  const labelEl = document.createElement('span')
  labelEl.className = 'closure-label'
  labelEl.textContent = closure.label

  readView.appendChild(datesEl)
  readView.appendChild(labelEl)

  // -- Edit view (hidden initially) --
  const editView = document.createElement('div')
  editView.className = 'closure-edit-fields'
  editView.hidden = true

  const startInput = document.createElement('input')
  startInput.type = 'date'
  startInput.className = 'closure-edit-date input'
  startInput.value = closure.startDate
  startInput.setAttribute('aria-label', 'Start date')

  const dateSep = document.createElement('span')
  dateSep.className = 'hours-slot-sep'
  dateSep.textContent = '–'
  dateSep.setAttribute('aria-hidden', 'true')

  const endInput = document.createElement('input')
  endInput.type = 'date'
  endInput.className = 'closure-edit-date input'
  endInput.value = closure.endDate
  endInput.setAttribute('aria-label', 'End date')

  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'closure-edit-label-input input'
  labelInput.value = closure.label
  labelInput.maxLength = 100
  labelInput.placeholder = 'e.g. Christmas, Vacation…'
  labelInput.setAttribute('aria-label', 'Closure label')

  editView.appendChild(startInput)
  editView.appendChild(dateSep)
  editView.appendChild(endInput)
  editView.appendChild(labelInput)

  // -- Actions --
  const actions = document.createElement('div')
  actions.className = 'closure-actions'

  const editBtn = document.createElement('button')
  editBtn.type = 'button'
  editBtn.className = 'closure-btn'
  editBtn.textContent = 'Edit'

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'closure-btn closure-btn--save'
  saveBtn.textContent = 'Save'
  saveBtn.hidden = true

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'closure-btn'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.hidden = true

  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'closure-btn closure-btn--delete'
  deleteBtn.textContent = 'Delete'

  actions.appendChild(editBtn)
  actions.appendChild(saveBtn)
  actions.appendChild(cancelBtn)
  actions.appendChild(deleteBtn)

  li.appendChild(readView)
  li.appendChild(editView)
  li.appendChild(actions)

  // -- Toggle edit mode --
  function enterEdit() {
    readView.hidden = true
    editView.hidden = false
    editBtn.hidden = true
    deleteBtn.hidden = true
    saveBtn.hidden = false
    cancelBtn.hidden = false
    li.style.background = '#fff'
    li.style.borderColor = 'var(--color-primary)'
    labelInput.focus()
  }

  function exitEdit() {
    readView.hidden = false
    editView.hidden = true
    editBtn.hidden = false
    deleteBtn.hidden = false
    saveBtn.hidden = true
    cancelBtn.hidden = true
    li.style.background = ''
    li.style.borderColor = ''
  }

  editBtn.addEventListener('click', enterEdit)
  cancelBtn.addEventListener('click', exitEdit)

  saveBtn.addEventListener('click', async () => {
    const startDate = startInput.value
    const endDate = endInput.value
    const label = labelInput.value.trim()

    if (!startDate || !endDate || !label) {
      showToast('All fields are required', 'error')
      return
    }
    if (endDate < startDate) {
      showToast('End date must be on or after start date', 'error')
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Saving…'
    try {
      const res = await api(`/api/merchants/${state.merchantId}/closures/${closure.id}`, {
        method: 'PUT',
        body: JSON.stringify({ startDate, endDate, label }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const updated = await res.json()
      // Patch in-memory list
      const idx = closuresList.findIndex(c => c.id === closure.id)
      if (idx !== -1) closuresList[idx] = updated

      // Update read view without full re-render
      datesEl.textContent = formatClosureDates(updated.startDate, updated.endDate)
      labelEl.textContent = updated.label
      // Sync input defaults in case user edits again
      closure.startDate = updated.startDate
      closure.endDate = updated.endDate
      closure.label = updated.label

      exitEdit()
      showToast('Closure updated', 'success')
    } catch (err) {
      showToast(`Failed to save: ${err.message}`, 'error')
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = 'Save'
    }
  })

  deleteBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${closure.label}"?`)) return
    deleteBtn.disabled = true
    try {
      const res = await api(`/api/merchants/${state.merchantId}/closures/${closure.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      closuresList = closuresList.filter(c => c.id !== closure.id)
      renderClosures()
      showToast('Closure deleted', 'success')
    } catch (err) {
      showToast(`Failed to delete: ${err.message}`, 'error')
      deleteBtn.disabled = false
    }
  })

  return li
}

// Add Closure button — inserts a new editable row at the top of the list
document.getElementById('add-closure-btn')?.addEventListener('click', () => {
  const list = document.getElementById('closures-list')
  const empty = document.getElementById('closures-empty')
  if (!list) return

  // Don't stack multiple new rows
  if (list.querySelector('.closure-item--new')) {
    list.querySelector('.closure-item--new input')?.focus()
    return
  }

  empty.hidden = true

  const li = document.createElement('li')
  li.className = 'closure-item closure-item--new'

  const fields = document.createElement('div')
  fields.className = 'closure-edit-fields'

  const today = new Date().toISOString().slice(0, 10)

  const startInput = document.createElement('input')
  startInput.type = 'date'
  startInput.className = 'closure-edit-date input'
  startInput.value = today
  startInput.setAttribute('aria-label', 'Start date')

  const sep = document.createElement('span')
  sep.className = 'hours-slot-sep'
  sep.textContent = '–'
  sep.setAttribute('aria-hidden', 'true')

  const endInput = document.createElement('input')
  endInput.type = 'date'
  endInput.className = 'closure-edit-date input'
  endInput.value = today
  endInput.setAttribute('aria-label', 'End date')

  const labelInput = document.createElement('input')
  labelInput.type = 'text'
  labelInput.className = 'closure-edit-label-input input'
  labelInput.maxLength = 100
  labelInput.placeholder = 'e.g. Christmas, Vacation…'
  labelInput.setAttribute('aria-label', 'Closure label')

  fields.appendChild(startInput)
  fields.appendChild(sep)
  fields.appendChild(endInput)
  fields.appendChild(labelInput)

  const actions = document.createElement('div')
  actions.className = 'closure-actions'

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'closure-btn closure-btn--save'
  saveBtn.textContent = 'Save'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'closure-btn'
  cancelBtn.textContent = 'Cancel'

  actions.appendChild(saveBtn)
  actions.appendChild(cancelBtn)

  li.appendChild(fields)
  li.appendChild(actions)

  list.insertBefore(li, list.firstChild)
  labelInput.focus()

  cancelBtn.addEventListener('click', () => {
    li.remove()
    if (closuresList.length === 0) empty.hidden = false
  })

  saveBtn.addEventListener('click', async () => {
    const startDate = startInput.value
    const endDate = endInput.value
    const label = labelInput.value.trim()

    if (!startDate || !endDate || !label) {
      showToast('All fields are required', 'error')
      labelInput.focus()
      return
    }
    if (endDate < startDate) {
      showToast('End date must be on or after start date', 'error')
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = 'Saving…'
    try {
      const res = await api(`/api/merchants/${state.merchantId}/closures`, {
        method: 'POST',
        body: JSON.stringify({ startDate, endDate, label }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const created = await res.json()
      closuresList.push(created)
      closuresList.sort((a, b) => a.startDate.localeCompare(b.startDate))
      li.remove()
      renderClosures()
      showToast('Closure added', 'success')
    } catch (err) {
      showToast(`Failed to add closure: ${err.message}`, 'error')
      saveBtn.disabled = false
      saveBtn.textContent = 'Save'
    }
  })
})

// ---------------------------------------------------------------------------
// Menu Manager
// ---------------------------------------------------------------------------

async function loadMenu() {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/menu`)
    if (!res.ok) throw new Error('Failed to load menu')
    state.menu = await res.json()

    // Build flat item list for modifier panel
    state.allItems = [
      ...(state.menu.categories ?? []).flatMap((c) => c.items ?? []),
      ...(state.menu.uncategorizedItems ?? []),
    ]

    // Only update the section that is currently visible
    if (state.activeSection === 'menu') renderMenu(state.menu)
    if (state.activeSection === 'modifiers') renderModifiers(state.menu)
    if (state.activeSection === 'order' && typeof window.renderOrderEntry === 'function') window.renderOrderEntry()
  } catch {
    if (state.activeSection === 'menu') showMenuState('empty')
    if (state.activeSection === 'modifiers') showModifiersState('empty')
  }
}

// ---------------------------------------------------------------------------
// Out-of-stock quick-restore modal
// ---------------------------------------------------------------------------

document.getElementById('oos-btn')?.addEventListener('click', openOosModal)
document.getElementById('oos-modal-close')?.addEventListener('click', closeOosModal)
document.getElementById('oos-modal-backdrop')?.addEventListener('click', closeOosModal)
document.getElementById('oos-restore-all-btn')?.addEventListener('click', restoreAllOos)

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('oos-modal')?.hidden) closeOosModal()
})

function openOosModal() {
  renderOosModal()
  document.getElementById('oos-modal').hidden = false
  document.getElementById('oos-modal-backdrop').hidden = false
}

function closeOosModal() {
  document.getElementById('oos-modal').hidden = true
  document.getElementById('oos-modal-backdrop').hidden = true
}

/** Collect all out-of-stock dishes and modifier options from state.menu */
function getOosItems() {
  const dishes = []
  const modifiers = []
  if (!state.menu) return { dishes, modifiers }

  const allItems = [
    ...(state.menu.uncategorizedItems ?? []),
    ...(state.menu.categories ?? []).flatMap((c) => c.items ?? []),
  ]

  for (const item of allItems) {
    if (item.stockStatus && item.stockStatus !== 'in_stock') {
      dishes.push(item)
    }
    for (const group of item.modifierGroups ?? []) {
      for (const mod of group.modifiers ?? []) {
        if (mod.stockStatus && mod.stockStatus !== 'in_stock') {
          modifiers.push({ mod, group, item })
        }
      }
    }
  }

  // Deduplicate modifiers (same mod may appear via multiple items)
  const seenMods = new Set()
  const uniqueModifiers = modifiers.filter(({ mod }) => {
    if (seenMods.has(mod.id)) return false
    seenMods.add(mod.id)
    return true
  })

  return { dishes, modifiers: uniqueModifiers }
}

/** Update the toolbar badge count — call after any restore */
function updateOosBadge() {
  const { dishes, modifiers } = getOosItems()
  const total = dishes.length + modifiers.length
  const btn = document.getElementById('oos-btn')
  const badge = document.getElementById('oos-count')
  if (!btn || !badge) return
  btn.hidden = total === 0
  badge.textContent = total
  badge.setAttribute('aria-label', `${total} item${total !== 1 ? 's' : ''} out of stock`)
}

const STATUS_LABEL = { out_today: 'Out today', out_indefinitely: 'Out of stock' }

function renderOosModal() {
  const body = document.getElementById('oos-modal-body')
  const hint = document.getElementById('oos-modal-hint')
  const restoreAllBtn = document.getElementById('oos-restore-all-btn')
  body.innerHTML = ''

  const { dishes, modifiers } = getOosItems()
  const total = dishes.length + modifiers.length

  if (total === 0) {
    const empty = document.createElement('p')
    empty.className = 'oos-empty'
    empty.textContent = 'Everything is in stock. 🎉'
    body.appendChild(empty)
    if (hint) hint.textContent = ''
    if (restoreAllBtn) restoreAllBtn.hidden = true
    return
  }

  if (hint) hint.textContent = `${total} item${total !== 1 ? 's' : ''} unavailable`
  if (restoreAllBtn) restoreAllBtn.hidden = false

  if (dishes.length > 0) {
    const label = document.createElement('p')
    label.className = 'oos-section-label'
    label.textContent = `Dishes (${dishes.length})`
    body.appendChild(label)

    for (const item of dishes) {
      body.appendChild(buildOosDishRow(item))
    }
  }

  if (modifiers.length > 0) {
    const label = document.createElement('p')
    label.className = 'oos-section-label'
    label.textContent = `Modifier options (${modifiers.length})`
    body.appendChild(label)

    for (const { mod, group } of modifiers) {
      body.appendChild(buildOosModRow(mod, group))
    }
  }
}

function buildOosDishRow(item) {
  const row = document.createElement('div')
  row.className = 'oos-row'
  row.dataset.itemId = item.id

  const name = document.createElement('span')
  name.className = 'oos-row-name'
  name.textContent = item.name
  row.appendChild(name)

  const badge = document.createElement('span')
  badge.className = `oos-status-badge ${item.stockStatus}`
  badge.textContent = STATUS_LABEL[item.stockStatus] ?? item.stockStatus
  row.appendChild(badge)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'oos-restore-btn'
  btn.textContent = 'Back in stock'
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Restoring…'
    try {
      const res = await api(`/api/merchants/${state.merchantId}/menu/items/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ stockStatus: 'in_stock' }),
      })
      if (!res.ok) throw new Error()
      item.stockStatus = 'in_stock'
      row.remove()
      updateOosBadge()
      renderOosModal()
      loadMenu()
      showToast(`${item.name} back in stock`, 'success')
    } catch {
      showToast(`Failed to restore ${item.name}`, 'error')
      btn.disabled = false
      btn.textContent = 'Back in stock'
    }
  })
  row.appendChild(btn)
  return row
}

function buildOosModRow(mod, group) {
  const row = document.createElement('div')
  row.className = 'oos-row'
  row.dataset.modId = mod.id

  const name = document.createElement('span')
  name.className = 'oos-row-name'
  name.textContent = mod.name
  row.appendChild(name)

  const sub = document.createElement('span')
  sub.className = 'oos-row-sub'
  sub.textContent = group.name
  row.appendChild(sub)

  const badge = document.createElement('span')
  badge.className = `oos-status-badge ${mod.stockStatus}`
  badge.textContent = STATUS_LABEL[mod.stockStatus] ?? mod.stockStatus
  row.appendChild(badge)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'oos-restore-btn'
  btn.textContent = 'Back in stock'
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Restoring…'
    try {
      const res = await api(
        `/api/merchants/${state.merchantId}/menu/modifiers/${mod.id}/stock`,
        { method: 'PATCH', body: JSON.stringify({ stockStatus: 'in_stock' }) }
      )
      if (!res.ok) throw new Error()
      mod.stockStatus = 'in_stock'
      row.remove()
      updateOosBadge()
      renderOosModal()
      showToast(`${mod.name} back in stock`, 'success')
    } catch {
      showToast(`Failed to restore ${mod.name}`, 'error')
      btn.disabled = false
      btn.textContent = 'Back in stock'
    }
  })
  row.appendChild(btn)
  return row
}

async function restoreAllOos() {
  const btn = document.getElementById('oos-restore-all-btn')
  btn.disabled = true
  btn.textContent = 'Restoring…'

  const { dishes, modifiers } = getOosItems()

  const results = await Promise.allSettled([
    ...dishes.map((item) =>
      api(`/api/merchants/${state.merchantId}/menu/items/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ stockStatus: 'in_stock' }),
      }).then((r) => { if (r.ok) item.stockStatus = 'in_stock' })
    ),
    ...modifiers.map(({ mod }) =>
      api(`/api/merchants/${state.merchantId}/menu/modifiers/${mod.id}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ stockStatus: 'in_stock' }),
      }).then((r) => { if (r.ok) mod.stockStatus = 'in_stock' })
    ),
  ])

  const failed = results.filter((r) => r.status === 'rejected').length
  if (failed > 0) {
    showToast(`${failed} item${failed !== 1 ? 's' : ''} failed to restore`, 'error')
  } else {
    showToast(`All items restored to stock`, 'success')
    closeOosModal()
  }

  updateOosBadge()
  renderOosModal()
  loadMenu()

  btn.disabled = false
  btn.textContent = 'Restore all'
}

document.getElementById('new-category-btn').addEventListener('click', async function() {
  var btn = document.getElementById('new-category-btn')
  btn.disabled = true
  try {
    var res = await api('/api/merchants/' + state.merchantId + '/menu/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'New Category' }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    var data = await res.json()
    await loadMenu()
    // Auto-focus the inline name editor on the newly created category
    var newSection = document.querySelector('[data-cat-id="' + data.id + '"]')
    if (newSection) {
      var h3 = newSection.querySelector('.menu-category-name--editable')
      if (h3) {
        newSection.scrollIntoView({ behavior: 'smooth', block: 'center' })
        setTimeout(function() { startCategoryRename(h3, data.id) }, 150)
      }
    }
  } catch (err) {
    showToast('Failed to create category: ' + err.message, 'error')
  } finally {
    btn.disabled = false
  }
})

document.getElementById('import-menu-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('import-menu-btn')
  const provider = document.getElementById('menu-import-provider')?.value || 'clover'
  btn.disabled = true
  const svg = btn.querySelector('svg')
  if (svg) svg.style.animation = 'spin 0.8s linear infinite'

  try {
    const res = await api(`/api/merchants/${state.merchantId}/menu/sync`, {
      method: 'POST',
      body: JSON.stringify({ provider }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Import failed')
    showToast(`Imported ${data.itemsCount} items across ${data.categoriesCount} categories`, 'success')
    state.menu = null
    await loadMenu()
  } catch (err) {
    showToast(err.message || 'Menu import failed', 'error')
  } finally {
    btn.disabled = false
    if (svg) svg.style.animation = ''
  }
})

function renderMenu(menuData) {
  const hasCategories = menuData.categories?.length > 0
  const hasUncategorized = menuData.uncategorizedItems?.length > 0

  if (!hasCategories && !hasUncategorized) {
    showMenuState('empty')
    return
  }

  showMenuState('content')
  updateOosBadge()

  const lastSynced = document.getElementById('menu-last-synced')
  if (lastSynced && menuData.lastSynced) {
    lastSynced.textContent = `Last synced ${formatDate(menuData.lastSynced)}`
  }

  const container = document.getElementById('menu-categories')
  container.innerHTML = ''

  // Virtual "Most Popular" section — shown first when any items are flagged popular
  const popularItems = (menuData.categories ?? [])
    .flatMap((c) => c.items ?? [])
    .filter((i) => i.isPopular)
  if (popularItems.length > 0) {
    container.appendChild(renderCategory('Most Popular', popularItems))
  }

  for (const cat of (menuData.categories ?? [])) {
    container.appendChild(renderCategory(cat, cat.items ?? []))
  }

  if (hasUncategorized) {
    container.appendChild(renderCategory('Other Items', menuData.uncategorizedItems))
  }
}

function renderCategory(cat, items) {
  // Accept either a full category object or a plain name string (for uncategorized)
  const catId = typeof cat === 'object' ? cat.id : null
  const name = typeof cat === 'object' ? cat.name : cat
  const availableOnline = typeof cat === 'object' ? (cat.availableOnline !== false) : true
  const availableInStore = typeof cat === 'object' ? (cat.availableInStore !== false) : true
  const hoursStart = typeof cat === 'object' ? (cat.hoursStart ?? '') : ''
  const hoursEnd = typeof cat === 'object' ? (cat.hoursEnd ?? '') : ''
  const courseOrder = typeof cat === 'object' ? (cat.courseOrder ?? null) : null
  const isLastCourse = typeof cat === 'object' ? (cat.isLastCourse === true) : false
  const printDestination = typeof cat === 'object' ? (cat.printDestination ?? 'both') : 'both'

  const section = document.createElement('div')
  section.className = 'menu-category'
  if (catId) section.dataset.catId = catId

  const header = document.createElement('div')
  header.className = 'menu-category-header'

  const h3 = document.createElement('h3')
  h3.className = 'menu-category-name'
  h3.textContent = name

  if (catId) {
    h3.className = 'menu-category-name menu-category-name--editable'
    h3.title = 'Click to rename'
    h3.setAttribute('role', 'button')
    h3.setAttribute('tabindex', '0')
    h3.addEventListener('click', function() { startCategoryRename(h3, catId) })
    h3.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startCategoryRename(h3, catId) }
    })
  }

  const count = document.createElement('span')
  count.className = 'menu-category-count'
  count.textContent = items.length + ' item' + (items.length === 1 ? '' : 's')

  header.appendChild(h3)
  header.appendChild(count)

  // Per-category controls (only for real categories with an ID)
  if (catId) {
    const controls = document.createElement('div')
    controls.className = 'cat-controls'

    // "Available online" toggle
    const onlineLabel = document.createElement('label')
    onlineLabel.className = 'cat-online-label'
    onlineLabel.title = 'Available for online ordering'

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'toggle-switch cat-online-toggle'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-checked', String(availableOnline))
    toggle.setAttribute('aria-label', 'Available online')
    toggle.innerHTML = `<span class="toggle-thumb"></span>`

    const toggleText = document.createElement('span')
    toggleText.className = 'cat-online-text'
    toggleText.textContent = availableOnline ? 'Online' : 'Offline only'

    toggle.addEventListener('click', async () => {
      const nowOnline = toggle.getAttribute('aria-checked') !== 'true'
      toggle.setAttribute('aria-checked', String(nowOnline))
      toggleText.textContent = nowOnline ? 'Online' : 'Offline only'
      section.classList.toggle('cat-offline', !nowOnline)
      try {
        const res = await api(`/api/merchants/${state.merchantId}/menu/categories/${catId}`, {
          method: 'PUT', body: JSON.stringify({ availableOnline: nowOnline }),
        })
        if (!res.ok) throw new Error()
        showToast(`${name}: ${nowOnline ? 'available online' : 'hidden from online'}`, 'success')
      } catch {
        // Revert on failure
        toggle.setAttribute('aria-checked', String(!nowOnline))
        toggleText.textContent = !nowOnline ? 'Online' : 'Offline only'
        section.classList.toggle('cat-offline', nowOnline)
        showToast(`Failed to update ${name}`, 'error')
      }
    })

    onlineLabel.appendChild(toggle)
    onlineLabel.appendChild(toggleText)
    controls.appendChild(onlineLabel)

    // "Available in store" toggle — controls Order Entry (POS) visibility
    const inStoreLabel = document.createElement('label')
    inStoreLabel.className = 'cat-online-label'
    inStoreLabel.title = 'Show in Order Entry (in-store POS)'

    const inStoreToggle = document.createElement('button')
    inStoreToggle.type = 'button'
    inStoreToggle.className = 'toggle-switch cat-instore-toggle'
    inStoreToggle.setAttribute('role', 'switch')
    inStoreToggle.setAttribute('aria-checked', String(availableInStore))
    inStoreToggle.setAttribute('aria-label', 'Available in store')
    inStoreToggle.innerHTML = `<span class="toggle-thumb"></span>`

    const inStoreText = document.createElement('span')
    inStoreText.className = 'cat-online-text'
    inStoreText.textContent = availableInStore ? 'In Store' : 'Hidden in store'

    inStoreToggle.addEventListener('click', async () => {
      const nowInStore = inStoreToggle.getAttribute('aria-checked') !== 'true'
      inStoreToggle.setAttribute('aria-checked', String(nowInStore))
      inStoreText.textContent = nowInStore ? 'In Store' : 'Hidden in store'
      try {
        const res = await api(`/api/merchants/${state.merchantId}/menu/categories/${catId}`, {
          method: 'PUT', body: JSON.stringify({ availableInStore: nowInStore }),
        })
        if (!res.ok) throw new Error()
        showToast(`${name}: ${nowInStore ? 'visible in store' : 'hidden from Order Entry'}`, 'success')
      } catch {
        inStoreToggle.setAttribute('aria-checked', String(!nowInStore))
        inStoreText.textContent = !nowInStore ? 'In Store' : 'Hidden in store'
        showToast(`Failed to update ${name}`, 'error')
      }
    })

    inStoreLabel.appendChild(inStoreToggle)
    inStoreLabel.appendChild(inStoreText)
    controls.appendChild(inStoreLabel)

    // Hours restriction
    const hoursWrap = document.createElement('div')
    hoursWrap.className = 'cat-hours-wrap'

    const hoursToggle = document.createElement('button')
    hoursToggle.type = 'button'
    hoursToggle.className = `cat-hours-toggle${hoursStart || hoursEnd ? ' active' : ''}`
    hoursToggle.setAttribute('aria-expanded', String(!!(hoursStart || hoursEnd)))
    hoursToggle.setAttribute('aria-label', 'Set availability hours')
    hoursToggle.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${hoursStart && hoursEnd ? `${hoursStart}–${hoursEnd}` : 'Hours'}
    `

    const hoursPanel = document.createElement('div')
    hoursPanel.className = 'cat-hours-panel'
    hoursPanel.hidden = true // Always start collapsed; toggle button shows current hours in its label

    const fromWrap = document.createElement('label')
    fromWrap.className = 'cat-hours-field'
    fromWrap.textContent = 'From '
    const fromInput = document.createElement('input')
    fromInput.type = 'time'
    fromInput.className = 'input cat-hours-input'
    fromInput.value = hoursStart
    fromInput.setAttribute('aria-label', 'Hours from')
    fromWrap.appendChild(fromInput)

    const toWrap = document.createElement('label')
    toWrap.className = 'cat-hours-field'
    toWrap.textContent = 'To '
    const toInput = document.createElement('input')
    toInput.type = 'time'
    toInput.className = 'input cat-hours-input'
    toInput.value = hoursEnd
    toInput.setAttribute('aria-label', 'Hours to')
    toWrap.appendChild(toInput)

    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'cat-hours-clear'
    clearBtn.textContent = 'Clear'

    const saveHoursBtn = document.createElement('button')
    saveHoursBtn.type = 'button'
    saveHoursBtn.className = 'btn btn-primary cat-hours-save'
    saveHoursBtn.textContent = 'Save'

    hoursPanel.appendChild(fromWrap)
    hoursPanel.appendChild(toWrap)
    hoursPanel.appendChild(clearBtn)
    hoursPanel.appendChild(saveHoursBtn)

    hoursToggle.addEventListener('click', () => {
      const open = hoursPanel.hidden
      hoursPanel.hidden = !open
      hoursToggle.setAttribute('aria-expanded', String(open))
      if (open) fromInput.focus()
    })

    const saveHours = async (start, end) => {
      try {
        const res = await api(`/api/merchants/${state.merchantId}/menu/categories/${catId}`, {
          method: 'PUT', body: JSON.stringify({ hoursStart: start || null, hoursEnd: end || null }),
        })
        if (!res.ok) throw new Error()
        const label = start && end ? `${start}–${end}` : 'Hours'
        hoursToggle.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${label}
        `
        hoursToggle.classList.toggle('active', !!(start && end))
        hoursPanel.hidden = true
        hoursToggle.setAttribute('aria-expanded', 'false')
        showToast(start && end ? `${name}: available ${start}–${end}` : `${name}: hours cleared`, 'success')
      } catch {
        showToast(`Failed to save hours for ${name}`, 'error')
      }
    }

    saveHoursBtn.addEventListener('click', () => saveHours(fromInput.value, toInput.value))

    clearBtn.addEventListener('click', () => {
      fromInput.value = ''
      toInput.value = ''
      saveHours('', '')
    })

    hoursWrap.appendChild(hoursToggle)
    hoursWrap.appendChild(hoursPanel)
    controls.appendChild(hoursWrap)

    // ── Course order select ────────────────────────────────────────────────
    const courseWrap = document.createElement('div')
    courseWrap.className = 'cat-course-wrap'

    const courseLabel = document.createElement('label')
    courseLabel.className = 'cat-course-label'
    courseLabel.textContent = 'Course'

    const courseSelect = document.createElement('select')
    courseSelect.className = 'cat-course-select'
    courseSelect.setAttribute('aria-label', 'Course order')
    courseSelect.title = 'Kitchen course order for this category'

    const courseOptions = [
      { value: 'main',  label: 'Main (default)' },
      { value: '1',     label: '1st Course' },
      { value: '2',     label: '2nd Course' },
      { value: '3',     label: '3rd Course' },
      { value: 'last',  label: 'Last (Desserts)' },
    ]

    // Determine current select value
    let currentCourseValue = 'main'
    if (isLastCourse) currentCourseValue = 'last'
    else if (courseOrder != null) currentCourseValue = String(courseOrder)

    for (const opt of courseOptions) {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      if (opt.value === currentCourseValue) el.selected = true
      courseSelect.appendChild(el)
    }

    courseSelect.addEventListener('change', async () => {
      const val = courseSelect.value
      const payload = val === 'last'
        ? { courseOrder: null, isLastCourse: true }
        : val === 'main'
          ? { courseOrder: null, isLastCourse: false }
          : { courseOrder: parseInt(val, 10), isLastCourse: false }
      try {
        const res = await api(`/api/merchants/${state.merchantId}/menu/categories/${catId}`, {
          method: 'PUT', body: JSON.stringify(payload),
        })
        if (!res.ok) throw new Error()
        showToast(`${name}: course order saved`, 'success')
      } catch {
        showToast(`Failed to save course order for ${name}`, 'error')
      }
    })

    courseWrap.appendChild(courseLabel)
    courseWrap.appendChild(courseSelect)
    controls.appendChild(courseWrap)

    // ── Print destination select ────────────────────────────────────────────
    const printWrap = document.createElement('div')
    printWrap.className = 'cat-print-wrap'

    const printLabel = document.createElement('label')
    printLabel.className = 'cat-print-label'
    printLabel.textContent = 'Print'

    const printSelect = document.createElement('select')
    printSelect.className = 'cat-print-select'
    printSelect.setAttribute('aria-label', 'Print destination')
    printSelect.title = 'Where to send tickets for items in this category'

    const printOptions = [
      { value: 'both',    label: 'Kitchen + Counter' },
      { value: 'kitchen', label: 'Kitchen only' },
      { value: 'counter', label: 'Counter only' },
    ]

    for (const opt of printOptions) {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      if (opt.value === printDestination) el.selected = true
      printSelect.appendChild(el)
    }

    printSelect.addEventListener('change', async () => {
      try {
        const res = await api(`/api/merchants/${state.merchantId}/menu/categories/${catId}`, {
          method: 'PUT', body: JSON.stringify({ printDestination: printSelect.value }),
        })
        if (!res.ok) throw new Error()
        showToast(`${name}: print destination saved`, 'success')
      } catch {
        showToast(`Failed to save print destination for ${name}`, 'error')
      }
    })

    printWrap.appendChild(printLabel)
    printWrap.appendChild(printSelect)
    controls.appendChild(printWrap)

    const deleteCatBtn = document.createElement('button')
    deleteCatBtn.type = 'button'
    deleteCatBtn.className = 'cat-delete-btn'
    deleteCatBtn.setAttribute('aria-label', 'Delete category')
    deleteCatBtn.title = 'Delete category'
    deleteCatBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>'
    deleteCatBtn.addEventListener('click', function() { deleteCategory(catId, name, items.length) })
    controls.appendChild(deleteCatBtn)

    header.appendChild(controls)

    if (!availableOnline) section.classList.add('cat-offline')
  }

  section.appendChild(header)

  const grid = document.createElement('div')
  grid.className = 'menu-items-grid'
  for (const item of items) grid.appendChild(renderMenuItem(item))

  // "Add item" card — only for real categories (not the uncategorized bucket)
  if (catId) {
    const addCard = document.createElement('button')
    addCard.type = 'button'
    addCard.className = 'menu-item-card menu-item-add-card'
    addCard.setAttribute('aria-label', `Add item to ${name}`)
    addCard.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span>Add item</span>`
    addCard.addEventListener('click', () => openNewItemPanel(catId))
    grid.appendChild(addCard)
  }

  section.appendChild(grid)

  // Drag-to-reorder within the grid (only for real categories with an ID)
  if (catId) {
    let dragPlaceholder = null
    let draggedItemId = null

    const ensurePlaceholder = () => {
      if (!dragPlaceholder) {
        dragPlaceholder = document.createElement('div')
        dragPlaceholder.className = 'menu-item-card drag-placeholder'
        dragPlaceholder.setAttribute('aria-hidden', 'true')
      }
      return dragPlaceholder
    }

    grid.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-menu-reorder')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'

      // Walk up from whatever element is under the pointer
      const target = e.target.closest?.('.menu-item-card:not(.dragging):not(.drag-placeholder)')
      const ph = ensurePlaceholder()

      if (target && target.parentNode === grid) {
        const rect = target.getBoundingClientRect()
        const after = e.clientX > rect.left + rect.width / 2
        grid.insertBefore(ph, after ? target.nextSibling : target)
      } else if (!grid.contains(ph)) {
        grid.appendChild(ph)
      }
    })

    grid.addEventListener('dragleave', (e) => {
      // Only remove placeholder when leaving the grid entirely
      if (!grid.contains(e.relatedTarget)) {
        dragPlaceholder?.remove()
        dragPlaceholder = null
      }
    })

    grid.addEventListener('drop', async (e) => {
      const itemId = e.dataTransfer.getData('application/x-menu-reorder')
      if (!itemId) return
      e.preventDefault()

      const draggedCard = grid.querySelector(`.menu-item-card[data-item-id="${CSS.escape(itemId)}"]`)
      if (draggedCard && dragPlaceholder?.parentNode === grid) {
        grid.insertBefore(draggedCard, dragPlaceholder)
      }
      dragPlaceholder?.remove()
      dragPlaceholder = null

      // Read new order from DOM
      const newOrder = [...grid.querySelectorAll('.menu-item-card[data-item-id]')]
        .map((c) => c.dataset.itemId)

      // Update state.menu so re-renders stay in sync
      const catData = state.menu?.categories?.find((c) => c.id === catId)
      if (catData) {
        catData.items = newOrder.map((id) => catData.items.find((i) => i.id === id)).filter(Boolean)
      }

      try {
        const res = await api(
          `/api/merchants/${state.merchantId}/menu/categories/${catId}/items/reorder`,
          { method: 'PATCH', body: JSON.stringify({ itemIds: newOrder }) }
        )
        if (!res.ok) throw new Error()
      } catch {
        showToast('Failed to save new order', 'error')
      }
    })
  }

  return section
}

/**
 * Replaces the category name h3 with an editable input.
 * Blur or Enter saves via PUT; Escape cancels.
 * @param {HTMLElement} h3El  - the .menu-category-name element
 * @param {string} catId
 */
function startCategoryRename(h3El, catId) {
  if (h3El.querySelector('input')) return // already editing
  var currentName = h3El.textContent.trim()

  var input = document.createElement('input')
  input.type = 'text'
  input.className = 'cat-name-input'
  input.value = currentName
  input.setAttribute('aria-label', 'Category name')

  h3El.textContent = ''
  h3El.appendChild(input)
  input.select()

  var saving = false

  function cancel() {
    if (saving) return
    h3El.textContent = currentName
  }

  function save() {
    if (saving) return
    var newName = input.value.trim()
    if (!newName || newName === currentName) { cancel(); return }
    saving = true
    h3El.textContent = newName // optimistic
    api('/api/merchants/' + state.merchantId + '/menu/categories/' + catId, {
      method: 'PUT',
      body: JSON.stringify({ name: newName }),
    }).then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      showToast('Category renamed to "' + newName + '"', 'success')
    }).catch(function() {
      h3El.textContent = currentName // revert
      showToast('Failed to rename category', 'error')
    })
  }

  input.addEventListener('blur', save)
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); input.blur() }
    if (e.key === 'Escape') { e.preventDefault(); saving = true; cancel() }
  })
}

/**
 * Confirms then deletes a category.
 * If it has items they are moved to Uncategorized automatically (ON DELETE SET NULL).
 * @param {string} catId
 * @param {string} name
 * @param {number} itemCount
 */
async function deleteCategory(catId, name, itemCount) {
  var msg = itemCount > 0
    ? 'Delete "' + name + '"? Its ' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + ' will be moved to Uncategorized.'
    : 'Delete category "' + name + '"?'

  if (!confirm(msg)) return

  try {
    var res = await api('/api/merchants/' + state.merchantId + '/menu/categories/' + catId, {
      method: 'DELETE',
    })
    if (!res.ok) {
      var err = await res.json().catch(function() { return {} })
      throw new Error(err.error || ('HTTP ' + res.status))
    }
    await loadMenu()
    var toastMsg = itemCount > 0
      ? '"' + name + '" deleted. ' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + ' moved to Uncategorized.'
      : '"' + name + '" deleted.'
    showToast(toastMsg, 'success')
  } catch (err) {
    showToast('Failed to delete category: ' + err.message, 'error')
  }
}

function renderMenuItem(item) {
  const card = document.createElement('div')
  card.className = 'menu-item-card'
  card.setAttribute('role', 'button')
  card.setAttribute('tabindex', '0')
  card.setAttribute('aria-label', `Edit ${item.name}`)

  // Drag handle — real element for reliable grab target
  const dragHandle = document.createElement('span')
  dragHandle.className = 'menu-item-drag-handle'
  dragHandle.setAttribute('aria-hidden', 'true')
  dragHandle.textContent = '⠿'
  card.appendChild(dragHandle)

  // Drag: supports both cart-drop (text/plain) and grid-reorder (application/x-menu-reorder)
  // draggable is enabled only while the handle is held, to avoid interfering with click-to-edit
  card.dataset.itemId = item.id
  let _didDrag = false

  dragHandle.addEventListener('mousedown', () => {
    card.setAttribute('draggable', 'true')
  })
  dragHandle.addEventListener('mouseup', () => {
    // If no drag started, remove draggable so card click still works
    if (!card.classList.contains('dragging')) card.removeAttribute('draggable')
  })

  card.addEventListener('dragstart', (e) => {
    if (!card.getAttribute('draggable')) { e.preventDefault(); return }
    _didDrag = false
    e.dataTransfer.setData('text/plain', item.id)
    e.dataTransfer.setData('application/x-menu-reorder', item.id)
    e.dataTransfer.effectAllowed = 'copyMove'
    // Defer adding the class so the browser captures the drag image first
    requestAnimationFrame(() => card.classList.add('dragging'))
  })

  card.addEventListener('dragend', () => {
    card.removeAttribute('draggable')
    card.classList.remove('dragging')
    _didDrag = true
    setTimeout(() => { _didDrag = false }, 0)
  })

  // Click anywhere on card opens edit panel (suppressed right after a drag ends)
  card.addEventListener('click', () => { if (!_didDrag) openItemPanel(item) })
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openItemPanel(item) })

  // Photo area
  if (item.imageUrl) {
    const img = document.createElement('img')
    img.className = 'menu-item-image'
    img.src = item.imageUrl
    img.alt = item.name
    img.loading = 'lazy'
    card.appendChild(img)
  } else {
    const ph = document.createElement('div')
    ph.className = 'menu-item-image-placeholder'
    ph.setAttribute('aria-hidden', 'true')
    ph.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <path d="M21 15l-5-5L5 21"/>
      </svg>
      <span>Add photo</span>
    `
    card.appendChild(ph)
  }

  // Body
  const body = document.createElement('div')
  body.className = 'menu-item-body'

  const name = document.createElement('p')
  name.className = 'menu-item-name'
  name.textContent = item.name
  body.appendChild(name)

  if (item.description) {
    const desc = document.createElement('p')
    desc.className = 'menu-item-description'
    desc.textContent = item.description
    body.appendChild(desc)
  }
  card.appendChild(body)

  // Footer: price
  const footer = document.createElement('div')
  footer.className = 'menu-item-footer'

  const price = document.createElement('span')
  price.className = `menu-item-price${item.priceType !== 'FIXED' ? ' variable' : ''}`
  price.textContent = item.priceType === 'FIXED'
    ? formatPrice(item.priceCents)
    : item.priceType === 'VARIABLE' ? 'Variable' : 'Per unit'
  footer.appendChild(price)

  // Modifier group count badge
  if (item.modifierGroups?.length > 0) {
    const badge = document.createElement('span')
    badge.className = 'modifier-pill'
    badge.textContent = `${item.modifierGroups.length} mod group${item.modifierGroups.length > 1 ? 's' : ''}`
    footer.appendChild(badge)
  }

  // Offline badge — shown when item is hidden from online ordering
  if (item.availableOnline === false) {
    const offlineBadge = document.createElement('span')
    offlineBadge.className = 'menu-item-offline-badge'
    offlineBadge.textContent = 'Offline only'
    footer.appendChild(offlineBadge)
  }

  // Stock badge — shown when item is not in stock; clicking it immediately restores to in-stock
  if (item.stockStatus && item.stockStatus !== 'in_stock') {
    const stockBadge = document.createElement('button')
    stockBadge.type = 'button'
    stockBadge.className = `menu-item-stock-badge ${item.stockStatus}`
    stockBadge.textContent = item.stockStatus === 'out_today' ? 'Out today' : 'Out of stock'
    stockBadge.title = 'Click to mark back in stock'
    stockBadge.addEventListener('click', async (e) => {
      e.stopPropagation() // don't open the edit panel
      stockBadge.textContent = '…'
      stockBadge.disabled = true
      try {
        const res = await api(`/api/merchants/${state.merchantId}/menu/items/${item.id}`, {
          method: 'PUT',
          body: JSON.stringify({ stockStatus: 'in_stock' }),
        })
        if (!res.ok) throw new Error()
        item.stockStatus = 'in_stock'
        stockBadge.remove()
        updateOosBadge()
        showToast(`${item.name} back in stock`, 'success')
      } catch {
        showToast(`Failed to restore ${item.name}`, 'error')
        stockBadge.textContent = item.stockStatus === 'out_today' ? 'Out today' : 'Out of stock'
        stockBadge.disabled = false
      }
    })
    footer.appendChild(stockBadge)
  }

  card.appendChild(footer)

  // Dietary tag pills — below footer on the card body
  if (item.dietaryTags?.length > 0) {
    const dietaryRow = document.createElement('div')
    dietaryRow.className = 'menu-item-dietary'
    const labels = { vegan: '🌱 Vegan', vegetarian: '🥦 Vegetarian', gluten_free: '🌾 GF' }
    for (const tag of item.dietaryTags) {
      const pill = document.createElement('span')
      pill.className = 'dietary-pill'
      pill.textContent = labels[tag] ?? tag
      dietaryRow.appendChild(pill)
    }
    card.appendChild(dietaryRow)
  }

  return card
}

function showMenuState(s) {
  document.getElementById('menu-loading').hidden = s !== 'loading'
  document.getElementById('menu-empty').hidden = s !== 'empty'
  document.getElementById('menu-content').hidden = s !== 'content'
}

// ---------------------------------------------------------------------------
// Modifiers section
// ---------------------------------------------------------------------------

function renderModifiers(menuData) {
  const groups = menuData.allModifierGroups ?? []

  if (groups.length === 0) {
    showModifiersState('empty')
    return
  }

  showModifiersState('content')

  // Build a flat item lookup so we can show assigned dish names in the panel
  const itemById = new Map()
  for (const cat of menuData.categories ?? []) {
    for (const item of cat.items ?? []) itemById.set(item.id, item)
  }
  for (const item of menuData.uncategorizedItems ?? []) itemById.set(item.id, item)

  const list = document.getElementById('modifier-groups-list')
  list.innerHTML = ''

  for (const group of groups) {
    // Enrich group with assigned item objects for the panel
    const items = (group.assignedItemIds ?? [])
      .map((id) => itemById.get(id))
      .filter(Boolean)
      .map((i) => ({ id: i.id, name: i.name }))

    list.appendChild(renderModifierGroupCard({ ...group, items }))
  }

  // Wire drag-to-reorder on the list (event-delegation, once per lifetime of the element)
  if (!list._groupDragWired) {
    list._groupDragWired = true
    wireGroupListDrag(list)
  }
}

function renderModifierGroupCard(group) {
  const card = document.createElement('div')
  card.className = 'modifier-group-card'
  card.dataset.groupId = group.id

  // Drag handle (left edge)
  const dragHandle = document.createElement('span')
  dragHandle.className = 'modifier-group-drag'
  dragHandle.setAttribute('aria-hidden', 'true')
  dragHandle.setAttribute('title', 'Drag to reorder')
  dragHandle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`
  card.appendChild(dragHandle)

  const body = document.createElement('div')
  body.className = 'modifier-group-card-body'

  const nameRow = document.createElement('div')
  nameRow.className = 'modifier-group-card-name-row'

  const nameEl = document.createElement('h3')
  nameEl.className = 'modifier-group-card-name'
  nameEl.textContent = group.name
  nameRow.appendChild(nameEl)

  if (group.isMandatory || group.minRequired >= 1) {
    const badge = document.createElement('span')
    badge.className = 'modifier-required-badge'
    badge.textContent = 'Required'
    nameRow.appendChild(badge)
  }

  body.appendChild(nameRow)

  const meta = document.createElement('p')
  meta.className = 'modifier-group-card-meta'
  const parts = []
  if (group.minRequired > 0) parts.push(`Min ${group.minRequired}`)
  if (group.maxAllowed != null) parts.push(`Max ${group.maxAllowed}`)
  if (parts.length === 0) parts.push('Optional')
  if (group.availableForTakeout === false) parts.push('Dine-in only')
  meta.textContent = parts.join(' · ')
  body.appendChild(meta)

  // Modifier options with inline stock selects
  if (group.modifiers?.length > 0) {
    const pills = document.createElement('div')
    pills.className = 'modifier-pills'
    for (const mod of group.modifiers) {
      const row = document.createElement('span')
      row.className = 'modifier-pill-row'

      const pill = document.createElement('span')
      pill.className = 'modifier-pill'
      pill.textContent = mod.priceCents > 0 ? `${mod.name} +${formatPrice(mod.priceCents)}` : mod.name
      row.appendChild(pill)

      const sel = document.createElement('select')
      sel.className = `modifier-stock-select ${mod.stockStatus ?? 'in_stock'}`
      sel.setAttribute('aria-label', `Stock status for ${mod.name}`)
      ;[
        ['in_stock', 'In stock'],
        ['out_today', 'Out today'],
        ['out_indefinitely', 'Out of stock'],
      ].forEach(([val, label]) => {
        const opt = document.createElement('option')
        opt.value = val
        opt.textContent = label
        if ((mod.stockStatus ?? 'in_stock') === val) opt.selected = true
        sel.appendChild(opt)
      })
      sel.addEventListener('change', async () => {
        const newStatus = sel.value
        sel.className = `modifier-stock-select ${newStatus}`
        try {
          const res = await api(
            `/api/merchants/${state.merchantId}/menu/modifiers/${mod.id}/stock`,
            { method: 'PATCH', body: JSON.stringify({ stockStatus: newStatus }) }
          )
          if (!res.ok) throw new Error()
          showToast(`${mod.name}: ${newStatus === 'in_stock' ? 'back in stock' : newStatus === 'out_today' ? 'out today' : 'out of stock'}`, 'success')
          // Update cached state so re-renders stay in sync
          mod.stockStatus = newStatus
        } catch {
          showToast(`Failed to update stock for ${mod.name}`, 'error')
          sel.value = mod.stockStatus ?? 'in_stock'
          sel.className = `modifier-stock-select ${mod.stockStatus ?? 'in_stock'}`
        }
      })
      row.appendChild(sel)
      pills.appendChild(row)
    }
    body.appendChild(pills)
  }

  // Items using this group
  if (group.items?.length > 0) {
    const itemsEl = document.createElement('p')
    itemsEl.className = 'modifier-group-card-items'
    itemsEl.textContent = `Used by: ${group.items.map((i) => i.name).join(', ')}`
    body.appendChild(itemsEl)
  }

  card.appendChild(body)

  const editBtn = document.createElement('button')
  editBtn.className = 'modifier-group-edit-btn'
  editBtn.type = 'button'
  editBtn.textContent = 'Edit'
  editBtn.addEventListener('click', () => openModifierPanel(group))
  card.appendChild(editBtn)

  return card
}

function showModifiersState(s) {
  document.getElementById('modifiers-loading').hidden = s !== 'loading'
  document.getElementById('modifiers-empty').hidden = s !== 'empty'
  document.getElementById('modifiers-content').hidden = s !== 'content'
}

// ---------------------------------------------------------------------------
// Item edit panel
// ---------------------------------------------------------------------------

function initItemPanel() {
  document.getElementById('item-panel-close').addEventListener('click', closeItemPanel)
  document.getElementById('item-panel-cancel').addEventListener('click', closeItemPanel)
  document.getElementById('item-panel-backdrop').addEventListener('click', closeItemPanel)
  document.getElementById('item-panel-save').addEventListener('click', saveItemChanges)
  document.getElementById('item-panel-delete').addEventListener('click', deleteCurrentItem)
  document.getElementById('item-panel-copy').addEventListener('click', duplicateCurrentItem)
  document.getElementById('item-dup-confirm').addEventListener('click', executeDuplicate)

  // Available online toggle
  const toggle = document.getElementById('edit-item-available-online')
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true'))
  })
  toggle.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle.click() }
  })

  // Most popular toggle
  const popularToggle = document.getElementById('edit-item-is-popular')
  popularToggle.addEventListener('click', () => {
    popularToggle.setAttribute('aria-checked', String(popularToggle.getAttribute('aria-checked') !== 'true'))
  })
  popularToggle.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); popularToggle.click() }
  })

  // Stock picker — only one button active at a time
  document.getElementById('edit-item-stock')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.stock-btn')
    if (!btn) return
    document.querySelectorAll('#edit-item-stock .stock-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'))
    btn.setAttribute('aria-pressed', 'true')
  })

  // Dietary tag buttons — toggle independently
  document.getElementById('edit-item-dietary')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.dietary-btn')
    if (!btn) return
    const current = btn.getAttribute('aria-pressed') === 'true'
    btn.setAttribute('aria-pressed', String(!current))
  })

  // Photo upload area — click to open file picker
  const uploadArea = document.getElementById('photo-upload-area')
  const fileInput = document.getElementById('photo-file-input')
  const removeBtn = document.getElementById('photo-remove-btn')

  uploadArea.addEventListener('click', () => fileInput.click())
  uploadArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click() }
  })

  // Drag-and-drop support
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault()
    uploadArea.classList.add('drag-over')
  })
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'))
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault()
    uploadArea.classList.remove('drag-over')
    const file = e.dataTransfer.files?.[0]
    if (file && file.type.startsWith('image/')) {
      processImageFile(file, IMG_W, IMG_H, (previewUrl, blob) => {
        state.editingImageDataUrl = previewUrl
        state.editingImageBlob   = blob
        setPhotoPreview(previewUrl)
      })
    }
  })

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) {
      processImageFile(file, IMG_W, IMG_H, (previewUrl, blob) => {
        state.editingImageDataUrl = previewUrl
        state.editingImageBlob   = blob
        setPhotoPreview(previewUrl)
      })
    }
    fileInput.value = '' // reset so re-selecting same file fires change again
  })

  removeBtn.addEventListener('click', () => {
    state.editingImageDataUrl = null
    state.editingImageBlob   = null
    setPhotoPreview(null)
  })

  document.getElementById('modifier-add-btn').addEventListener('click', openModifierPicker)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('item-panel').hidden) closeItemPanel()
  })
}

/** Open the item panel in create mode (no existing item). */
function openNewItemPanel(catId) {
  state.editingItem = null
  state.editingImageDataUrl = null
  state.editingImageBlob   = null

  document.getElementById('edit-item-id').value = ''
  document.getElementById('edit-item-category-id').value = catId
  document.getElementById('edit-item-name').value = ''
  document.getElementById('edit-item-price').value = ''
  document.getElementById('edit-item-description').value = ''

  setPhotoPreview(null)
  renderModifierChips([])

  document.getElementById('edit-item-available-online').setAttribute('aria-checked', 'true')
  document.getElementById('edit-item-is-popular').setAttribute('aria-checked', 'false')

  document.querySelectorAll('#edit-item-stock .stock-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.status === 'in_stock'))
  })
  document.querySelectorAll('#edit-item-dietary .dietary-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', 'false')
  })

  document.getElementById('item-panel-title').textContent = 'New Item'
  document.getElementById('item-panel-save').textContent = 'Add Item'
  document.getElementById('item-panel-delete').hidden = true
  document.getElementById('item-panel-copy').hidden = true
  document.getElementById('item-panel-duplicate-row').hidden = true
  document.getElementById('item-panel').hidden = false
  document.getElementById('item-panel-backdrop').hidden = false
  document.getElementById('edit-item-name').focus()
}

function openItemPanel(item) {
  state.editingItem = item
  state.editingImageDataUrl = null // clear any pending image from previous edit
  state.editingImageBlob   = null

  document.getElementById('edit-item-id').value = item.id
  document.getElementById('edit-item-category-id').value = ''
  document.getElementById('edit-item-name').value = item.name ?? ''
  document.getElementById('edit-item-price').value = item.priceCents != null ? (item.priceCents / 100).toFixed(2) : ''
  document.getElementById('edit-item-description').value = item.description ?? ''

  // Show existing image (if any) in the upload preview area
  setPhotoPreview(item.imageUrl ?? null)

  // Populate modifier chips from item's currently assigned groups
  renderModifierChips(item.modifierGroups ?? [])

  // Populate "Available online" toggle
  const isOnline = item.availableOnline !== false // default true for existing items
  document.getElementById('edit-item-available-online').setAttribute('aria-checked', String(isOnline))

  // Populate "Most popular" toggle
  document.getElementById('edit-item-is-popular').setAttribute('aria-checked', String(item.isPopular === true))

  // Populate stock picker
  const stockStatus = item.stockStatus ?? 'in_stock'
  document.querySelectorAll('#edit-item-stock .stock-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.status === stockStatus))
  })

  // Populate dietary tags
  const tags = new Set(item.dietaryTags ?? [])
  document.querySelectorAll('#edit-item-dietary .dietary-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(tags.has(btn.dataset.tag)))
  })

  document.getElementById('item-panel-title').textContent = item.name
  document.getElementById('item-panel-delete').hidden = false
  document.getElementById('item-panel-copy').hidden = false
  document.getElementById('item-panel-duplicate-row').hidden = false

  // Pre-populate the "Move to" category dropdown (state.menu is guaranteed fresh)
  populateCategorySelect(item.id)

  document.getElementById('item-panel-save').textContent = 'Save Changes'
  document.getElementById('item-panel').hidden = false
  document.getElementById('item-panel-backdrop').hidden = false
  document.getElementById('edit-item-name').focus()
}

function closeItemPanel() {
  document.getElementById('item-panel').hidden = true
  document.getElementById('item-panel-backdrop').hidden = true
  document.getElementById('item-panel-save').textContent = 'Save Changes'
  state.editingItem = null
}

/**
 * Asks for confirmation then permanently deletes the item currently open in the panel.
 */
async function deleteCurrentItem() {
  const item = state.editingItem
  if (!item) return

  if (!confirm('Delete "' + item.name + '"? This cannot be undone.')) return

  const btn = document.getElementById('item-panel-delete')
  btn.disabled = true

  try {
    const res = await api('/api/merchants/' + state.merchantId + '/menu/items/' + item.id, {
      method: 'DELETE',
    })
    if (!res.ok) {
      const err = await res.json().catch(function() { return {} })
      throw new Error(err.error || ('HTTP ' + res.status))
    }
    closeItemPanel()
    await loadMenu()
    showToast('"' + item.name + '" deleted', 'success')
  } catch (err) {
    showToast('Failed to delete item: ' + err.message, 'error')
    btn.disabled = false
  }
}

/**
 * Duplicates the current item in the same category (creates a copy with " (copy)" suffix).
 */
async function duplicateCurrentItem() {
  var item = state.editingItem
  if (!item) return

  var currentCatId = null
  if (state.menu) {
    for (var i = 0; i < (state.menu.categories || []).length; i++) {
      var cat = state.menu.categories[i]
      for (var j = 0; j < (cat.items || []).length; j++) {
        if (cat.items[j].id === item.id) { currentCatId = cat.id; break }
      }
      if (currentCatId) break
    }
  }
  if (!currentCatId) { showToast('Could not determine item category', 'error'); return }

  var btn = document.getElementById('item-panel-copy')
  btn.disabled = true
  btn.textContent = 'Duplicating…'

  var modifierGroupIds = Array.from(
    document.getElementById('edit-item-modifier-chips').querySelectorAll('.modifier-chip')
  ).map(function(chip) { return chip.dataset.groupId })

  var body = {
    categoryId: currentCatId,
    name: item.name + ' (copy)',
    priceCents: item.priceCents || 0,
    description: item.description || null,
    imageUrl: item.imageUrl || null,
    isPopular: false,
    stockStatus: 'in_stock',
    dietaryTags: item.dietaryTags || [],
    availableOnline: item.availableOnline !== false,
    modifierGroupIds: modifierGroupIds,
  }

  try {
    var res = await api('/api/merchants/' + state.merchantId + '/menu/items', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      var errData = await res.json().catch(function() { return {} })
      throw new Error(errData.error || ('HTTP ' + res.status))
    }
    closeItemPanel()
    await loadMenu()
    showToast('"' + item.name + '" duplicated', 'success')
  } catch (err) {
    showToast('Failed to duplicate item: ' + err.message, 'error')
    btn.disabled = false
    btn.textContent = 'Duplicate'
  }
}

/**
 * Populates the #item-dup-cat select with categories from state.menu.
 * Called once when the panel opens (state.menu is guaranteed fresh at that time).
 * @param {string} itemId — the ID of the item being edited, to pre-select its category
 */
function populateCategorySelect(itemId) {
  var select = document.getElementById('item-dup-cat')
  if (!select) return
  select.innerHTML = ''

  var categories = (state.menu && state.menu.categories) ? state.menu.categories : []
  var currentCatId = ''

  // Find which category owns this item
  for (var i = 0; i < categories.length; i++) {
    var items = categories[i].items || []
    for (var j = 0; j < items.length; j++) {
      if (items[j].id === itemId) { currentCatId = categories[i].id; break }
    }
    if (currentCatId) break
  }

  for (var k = 0; k < categories.length; k++) {
    var opt = document.createElement('option')
    opt.value = categories[k].id
    opt.textContent = categories[k].name
    if (categories[k].id === currentCatId) opt.selected = true
    select.appendChild(opt)
  }
}

/**
 * Creates a copy of the current item in the selected category.
 */
async function executeDuplicate() {
  var item = state.editingItem
  if (!item) return

  var categoryId = document.getElementById('item-dup-cat').value
  if (!categoryId) { showToast('Please select a category', 'error'); return }

  var confirmBtn = document.getElementById('item-dup-confirm')
  confirmBtn.disabled = true
  confirmBtn.textContent = 'Moving…'

  try {
    var res = await api('/api/merchants/' + state.merchantId + '/menu/items/' + item.id, {
      method: 'PUT',
      body: JSON.stringify({ categoryId: categoryId }),
    })
    if (!res.ok) {
      var errData = await res.json().catch(function() { return {} })
      throw new Error(errData.error || ('HTTP ' + res.status))
    }
    var select = document.getElementById('item-dup-cat')
    var catName = select.options[select.selectedIndex].text
    closeItemPanel()
    await loadMenu()
    showToast('"' + item.name + '" moved to ' + catName, 'success')
  } catch (err) {
    showToast('Failed to move item: ' + err.message, 'error')
    confirmBtn.disabled = false
    confirmBtn.textContent = 'Move here'
  }
}

async function saveItemChanges() {
  const itemId = document.getElementById('edit-item-id').value
  const categoryId = document.getElementById('edit-item-category-id').value
  const isNew = !itemId

  const btn = document.getElementById('item-panel-save')
  btn.disabled = true
  btn.textContent = 'Saving…'

  const name = document.getElementById('edit-item-name').value.trim()
  if (!name) {
    showToast('Item name is required', 'error')
    btn.disabled = false
    btn.textContent = isNew ? 'Add Item' : 'Save Changes'
    return
  }

  const priceRaw = parseFloat(document.getElementById('edit-item-price').value)
  const priceCents = isNaN(priceRaw) ? 0 : Math.round(priceRaw * 100)

  const description = document.getElementById('edit-item-description').value.trim()

  const selectedGroupIds = Array.from(
    document.getElementById('edit-item-modifier-chips').querySelectorAll('.modifier-chip')
  ).map((chip) => chip.dataset.groupId)

  const availableOnline = document.getElementById('edit-item-available-online').getAttribute('aria-checked') === 'true'
  const isPopular = document.getElementById('edit-item-is-popular').getAttribute('aria-checked') === 'true'
  const stockStatus = document.querySelector('#edit-item-stock .stock-btn[aria-pressed="true"]')?.dataset.status ?? 'in_stock'
  const dietaryTags = Array.from(
    document.querySelectorAll('#edit-item-dietary .dietary-btn[aria-pressed="true"]')
  ).map((btn) => btn.dataset.tag)

  try {
    // Upload any pending WebP blob first; fall back to the existing imageUrl otherwise.
    // Kept inside try so a failed upload is caught and the finally block re-enables the button.
    let imagePayload = state.editingItem?.imageUrl ?? null
    if (state.editingImageBlob) {
      imagePayload = await uploadImage(state.editingImageBlob)
      state.editingImageBlob = null
    } else if (state.editingImageDataUrl !== null) {
      // Legacy path: data URL stored directly (e.g. from older camera.js flow)
      imagePayload = state.editingImageDataUrl
    }
    let res
    if (isNew) {
      res = await api(`/api/merchants/${state.merchantId}/menu/items`, {
        method: 'POST',
        body: JSON.stringify({
          categoryId,
          name,
          priceCents,
          description: description || null,
          imageUrl: imagePayload,
          availableOnline,
          isPopular,
          stockStatus,
          dietaryTags,
          modifierGroupIds: selectedGroupIds,
        }),
      })
    } else {
      res = await api(`/api/merchants/${state.merchantId}/menu/items/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, priceCents, description, imageUrl: imagePayload, availableOnline, isPopular, stockStatus, dietaryTags, modifierGroupIds: selectedGroupIds }),
      })
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Save failed')
    }

    showToast(isNew ? 'Item added' : 'Item saved', 'success')
    closeItemPanel()
    state.menu = null
    await loadMenu()
  } catch (err) {
    showToast(err.message || 'Failed to save item', 'error')
  } finally {
    btn.disabled = false
    // Only restore label if the panel is still open (error path).
    // On success, closeItemPanel() already hid the panel and reset state;
    // overwriting here would leave a stale label for the next open.
    if (!document.getElementById('item-panel').hidden) {
      btn.textContent = isNew ? 'Add Item' : 'Save Changes'
    }
  }
}

// ---------------------------------------------------------------------------
// Modifier group edit panel
// ---------------------------------------------------------------------------

function initModifierPanel() {
  document.getElementById('modifier-panel-close').addEventListener('click', closeModifierPanel)
  document.getElementById('modifier-panel-cancel').addEventListener('click', closeModifierPanel)
  document.getElementById('modifier-panel-backdrop').addEventListener('click', closeModifierPanel)
  document.getElementById('modifier-panel-save').addEventListener('click', saveModifierAssignments)
  document.getElementById('modifier-new-btn')?.addEventListener('click', openNewModifierPanel)

  // Takeout toggle
  const takeoutToggle = document.getElementById('edit-group-takeout')
  takeoutToggle?.addEventListener('click', () => {
    const checked = takeoutToggle.getAttribute('aria-checked') === 'true'
    takeoutToggle.setAttribute('aria-checked', String(!checked))
  })
  takeoutToggle?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); takeoutToggle.click() }
  })

  // Mandatory toggle
  const mandatoryToggle = document.getElementById('edit-group-mandatory')
  mandatoryToggle?.addEventListener('click', () => {
    const checked = mandatoryToggle.getAttribute('aria-checked') === 'true'
    mandatoryToggle.setAttribute('aria-checked', String(!checked))
  })
  mandatoryToggle?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); mandatoryToggle.click() }
  })

  // "Add option" button
  document.getElementById('mod-option-add-btn')?.addEventListener('click', () => addModOptionRow())

  // "Add dish" button opens the dish picker
  document.getElementById('modifier-dish-add-btn')?.addEventListener('click', openDishPicker)

  // Dish picker modal
  document.getElementById('dish-picker-close')?.addEventListener('click', closeDishPicker)
  document.getElementById('dish-picker-backdrop')?.addEventListener('click', closeDishPicker)
  document.getElementById('dish-picker-confirm')?.addEventListener('click', confirmDishPicker)
  document.getElementById('dish-picker-search')?.addEventListener('input', (e) => {
    renderDishPickerList(e.target.value.trim().toLowerCase())
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('dish-picker-modal').hidden) { closeDishPicker(); return }
      if (!document.getElementById('modifier-panel').hidden) closeModifierPanel()
    }
  })
}

/** Selected item IDs in the dish picker (cleared on open) */
const _dishPickerSelected = new Set()

function _updateDishPickerFooter() {
  const count = _dishPickerSelected.size
  const countEl = document.getElementById('dish-picker-count')
  const confirmBtn = document.getElementById('dish-picker-confirm')
  if (countEl) countEl.textContent = count === 0 ? '0 selected' : `${count} selected`
  if (confirmBtn) {
    confirmBtn.disabled = count === 0
    confirmBtn.textContent = count > 0 ? `Add ${count} dish${count === 1 ? '' : 'es'}` : 'Add dishes'
  }
}

function openDishPicker() {
  _dishPickerSelected.clear()
  _updateDishPickerFooter()
  document.getElementById('dish-picker-search').value = ''
  renderDishPickerList('')
  document.getElementById('dish-picker-modal').hidden = false
  document.getElementById('dish-picker-backdrop').hidden = false
  document.getElementById('dish-picker-search').focus()
}

function closeDishPicker() {
  document.getElementById('dish-picker-modal').hidden = true
  document.getElementById('dish-picker-backdrop').hidden = true
}

function confirmDishPicker() {
  const container = document.getElementById('edit-modifier-dish-chips')
  for (const itemId of _dishPickerSelected) {
    const item = state.allItems.find((i) => i.id === itemId)
    if (!item) continue
    const chip = document.createElement('span')
    chip.className = 'modifier-chip'
    chip.dataset.itemId = item.id
    chip.textContent = item.name
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'modifier-chip-remove'
    removeBtn.setAttribute('aria-label', `Remove ${item.name}`)
    removeBtn.textContent = '×'
    removeBtn.addEventListener('click', () => chip.remove())
    chip.appendChild(removeBtn)
    container.appendChild(chip)
  }
  closeDishPicker()
}

function renderDishPickerList(query) {
  const list = document.getElementById('dish-picker-list')
  list.innerHTML = ''

  // Get IDs already assigned (from chips currently in the panel)
  const assignedIds = new Set(
    Array.from(document.getElementById('edit-modifier-dish-chips').querySelectorAll('.modifier-chip[data-item-id]'))
      .map((c) => c.dataset.itemId)
  )

  const filtered = state.allItems.filter((item) =>
    !assignedIds.has(item.id) &&
    (!query || item.name.toLowerCase().includes(query))
  )

  // Keep only valid selections after filtering
  for (const id of _dishPickerSelected) {
    if (!filtered.find((i) => i.id === id)) _dishPickerSelected.delete(id)
  }
  _updateDishPickerFooter()

  if (filtered.length === 0) {
    const li = document.createElement('li')
    li.className = 'picker-list-empty'
    li.textContent = query ? 'No dishes match your search.' : 'All dishes are already assigned.'
    list.appendChild(li)
    return
  }

  for (const item of filtered) {
    const li = document.createElement('li')
    li.className = 'picker-list-item picker-list-item--check'
    li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', String(_dishPickerSelected.has(item.id)))
    li.setAttribute('tabindex', '0')

    const label = document.createElement('div')
    label.className = 'picker-item-label'

    const name = document.createElement('span')
    name.className = 'picker-item-name'
    name.textContent = item.name
    label.appendChild(name)

    if (item.priceCents > 0) {
      const price = document.createElement('span')
      price.className = 'picker-item-meta'
      price.textContent = formatPrice(item.priceCents)
      label.appendChild(price)
    }

    li.appendChild(label)

    const toggle = () => {
      if (_dishPickerSelected.has(item.id)) {
        _dishPickerSelected.delete(item.id)
        li.setAttribute('aria-selected', 'false')
      } else {
        _dishPickerSelected.add(item.id)
        li.setAttribute('aria-selected', 'true')
      }
      _updateDishPickerFooter()
    }

    li.addEventListener('click', toggle)
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
    })

    list.appendChild(li)
  }
}

/** Opens the modifier panel in "create new group" mode */
function openNewModifierPanel() {
  state.editingGroup = null

  document.getElementById('edit-group-id').value = ''
  document.getElementById('edit-group-name').value = ''
  document.getElementById('edit-group-takeout').setAttribute('aria-checked', 'true')
  document.getElementById('edit-group-mandatory').setAttribute('aria-checked', 'false')
  const _minI = document.getElementById('edit-group-min')
  const _maxI = document.getElementById('edit-group-max')
  if (_minI) _minI.value = '0'
  if (_maxI) _maxI.value = ''
  document.getElementById('mod-options-list').innerHTML = ''
  document.getElementById('edit-modifier-dish-chips').innerHTML = ''
  document.getElementById('modifier-panel-title').textContent = 'New Modifier Group'

  document.getElementById('modifier-panel').hidden = false
  document.getElementById('modifier-panel-backdrop').hidden = false

  // Focus the name field
  setTimeout(() => document.getElementById('edit-group-name').focus(), 50)
}

function openModifierPanel(group) {
  state.editingGroup = group

  document.getElementById('edit-group-id').value = group.id
  document.getElementById('edit-group-name').value = group.name ?? ''

  // Populate takeout toggle (default true if not set)
  const takeoutToggle = document.getElementById('edit-group-takeout')
  takeoutToggle.setAttribute('aria-checked', String(group.availableForTakeout !== false))

  // Populate mandatory toggle
  const mandatoryToggle = document.getElementById('edit-group-mandatory')
  mandatoryToggle.setAttribute('aria-checked', String(group.isMandatory === true))

  // Populate min/max selection counts
  const minInput = document.getElementById('edit-group-min')
  const maxInput = document.getElementById('edit-group-max')
  if (minInput) minInput.value = group.minRequired ?? 0
  if (maxInput) maxInput.value = group.maxAllowed != null ? group.maxAllowed : ''

  // Populate options editor
  const list = document.getElementById('mod-options-list')
  list.innerHTML = ''
  for (const mod of group.modifiers ?? []) {
    addModOptionRow(mod.id, mod.name, mod.priceCents)
  }

  // Render assigned dishes as removable chips
  renderModifierDishChips(group.items ?? [])

  document.getElementById('modifier-panel').hidden = false
  document.getElementById('modifier-panel-backdrop').hidden = false
}

/** Render the assigned dishes as removable chips in the modifier panel */
function renderModifierDishChips(items) {
  const container = document.getElementById('edit-modifier-dish-chips')
  container.innerHTML = ''
  for (const item of items) {
    const chip = document.createElement('span')
    chip.className = 'modifier-chip'
    chip.dataset.itemId = item.id
    chip.textContent = item.name

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'modifier-chip-remove'
    removeBtn.setAttribute('aria-label', `Remove ${item.name}`)
    removeBtn.textContent = '×'
    removeBtn.addEventListener('click', () => {
      chip.remove()
    })

    chip.appendChild(removeBtn)
    container.appendChild(chip)
  }
}

/**
 * Add a single option row to the modifier options list.
 * @param {string|undefined} id  - existing modifier ID (undefined for new rows)
 * @param {string} name          - option name
 * @param {number} priceCents    - price in cents (0 = free)
 */
function addModOptionRow(id, name = '', priceCents = 0) {
  const list = document.getElementById('mod-options-list')

  const li = document.createElement('li')
  li.className = 'mod-option-row'
  if (id) li.dataset.modId = id

  // Drag handle
  const handle = document.createElement('span')
  handle.className = 'mod-option-drag'
  handle.setAttribute('aria-hidden', 'true')
  handle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`
  li.appendChild(handle)

  // Name input
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'mod-option-name input'
  nameInput.value = name
  nameInput.placeholder = 'Option name'
  nameInput.setAttribute('aria-label', 'Option name')
  li.appendChild(nameInput)

  // Price input with $ prefix
  const priceWrap = document.createElement('span')
  priceWrap.className = 'mod-option-price-wrap'
  const prefix = document.createElement('span')
  prefix.className = 'mod-option-price-prefix'
  prefix.textContent = '$'
  prefix.setAttribute('aria-hidden', 'true')
  const priceInput = document.createElement('input')
  priceInput.type = 'number'
  priceInput.className = 'mod-option-price'
  priceInput.value = priceCents === 0 ? '0' : (priceCents / 100).toFixed(2)
  priceInput.min = '0'
  priceInput.step = '0.01'
  priceInput.setAttribute('aria-label', 'Price')
  priceWrap.appendChild(prefix)
  priceWrap.appendChild(priceInput)
  li.appendChild(priceWrap)

  // Delete button
  const delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.className = 'mod-option-delete'
  delBtn.setAttribute('aria-label', 'Remove option')
  delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
  delBtn.addEventListener('click', () => li.remove())
  li.appendChild(delBtn)

  // Drag-to-reorder via pointer events on the handle
  wireModOptionDrag(handle, li, list)

  list.appendChild(li)
  if (!id) nameInput.focus()
}

/** Pointer-based drag-to-reorder for option rows */
function wireModOptionDrag(handle, row, list) {
  let dragging = false
  let startY = 0
  let placeholder = null

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    dragging = true
    startY = e.clientY

    row.style.opacity = '0.5'
    placeholder = document.createElement('li')
    placeholder.style.cssText = `height:${row.offsetHeight}px;border:2px dashed var(--color-primary);border-radius:6px;opacity:0.4`
    list.insertBefore(placeholder, row.nextSibling)
  })

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const rows = [...list.querySelectorAll('.mod-option-row')]
    const mouseY = e.clientY
    for (const sibling of rows) {
      if (sibling === row) continue
      const rect = sibling.getBoundingClientRect()
      const mid = rect.top + rect.height / 2
      if (mouseY < mid) {
        list.insertBefore(placeholder, sibling)
        break
      } else if (sibling === rows[rows.length - 1]) {
        list.appendChild(placeholder)
      }
    }
  })

  handle.addEventListener('pointerup', () => {
    if (!dragging) return
    dragging = false
    row.style.opacity = ''
    if (placeholder) {
      list.insertBefore(row, placeholder)
      placeholder.remove()
      placeholder = null
    }
  })
}

/**
 * Pointer-based drag-to-reorder for the modifier group card list.
 * Wired once on the list element via event delegation (pointerdown on .modifier-group-drag).
 * Calls saveModifierGroupOrder() after every successful drop.
 * @param {HTMLElement} list - the #modifier-groups-list element
 */
function wireGroupListDrag(list) {
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.modifier-group-drag')
    if (!handle) return
    const card = handle.closest('.modifier-group-card')
    if (!card) return

    e.preventDefault()
    list.setPointerCapture(e.pointerId)

    let dragging = true
    card.style.opacity = '0.5'
    card.classList.add('dragging')

    const placeholder = document.createElement('div')
    placeholder.className = 'modifier-group-drag-placeholder'
    placeholder.style.cssText = `height:${card.offsetHeight}px;border:2px dashed var(--color-primary);border-radius:8px;opacity:0.4;margin:0`
    list.insertBefore(placeholder, card.nextSibling)

    function onMove(e) {
      if (!dragging) return
      const cards = [...list.querySelectorAll('.modifier-group-card')]
      const mouseY = e.clientY
      let placed = false
      for (const sibling of cards) {
        if (sibling === card) continue
        const rect = sibling.getBoundingClientRect()
        if (mouseY < rect.top + rect.height / 2) {
          list.insertBefore(placeholder, sibling)
          placed = true
          break
        }
      }
      if (!placed) list.appendChild(placeholder)
    }

    function onUp() {
      if (!dragging) return
      dragging = false
      card.style.opacity = ''
      card.classList.remove('dragging')
      list.insertBefore(card, placeholder)
      placeholder.remove()
      list.removeEventListener('pointermove', onMove)
      list.removeEventListener('pointerup', onUp)
      saveModifierGroupOrder()
    }

    list.addEventListener('pointermove', onMove)
    list.addEventListener('pointerup', onUp)
  })
}

/** Persist the current visual order of modifier group cards via the reorder API. */
async function saveModifierGroupOrder() {
  const list = document.getElementById('modifier-groups-list')
  const order = Array.from(list.querySelectorAll('.modifier-group-card'))
    .map((card) => card.dataset.groupId)
    .filter(Boolean)

  try {
    const res = await api(
      `/api/merchants/${state.merchantId}/menu/modifier-groups/reorder`,
      { method: 'PATCH', body: JSON.stringify({ order }) }
    )
    if (!res.ok) throw new Error()
  } catch {
    showToast('Failed to save modifier order', 'error')
  }
}

function closeModifierPanel() {
  document.getElementById('modifier-panel').hidden = true
  document.getElementById('modifier-panel-backdrop').hidden = true
  document.getElementById('modifier-panel-title').textContent = 'Edit Modifier Group'
  state.editingGroup = null
}

async function saveModifierAssignments() {
  const btn = document.getElementById('modifier-panel-save')
  btn.disabled = true
  btn.textContent = 'Saving…'

  const groupName = document.getElementById('edit-group-name').value.trim()
  const availableForTakeout = document.getElementById('edit-group-takeout').getAttribute('aria-checked') === 'true'
  const isMandatory = document.getElementById('edit-group-mandatory').getAttribute('aria-checked') === 'true'
  const minRequired = parseInt(document.getElementById('edit-group-min')?.value || '0', 10) || 0
  const maxAllowedRaw = document.getElementById('edit-group-max')?.value
  const maxAllowed = maxAllowedRaw ? (parseInt(maxAllowedRaw, 10) || null) : null

  // Collect options from the editor rows
  const options = Array.from(
    document.getElementById('mod-options-list').querySelectorAll('.mod-option-row')
  ).map((row) => {
    const name = row.querySelector('.mod-option-name').value.trim()
    const priceRaw = row.querySelector('.mod-option-price').value
    const priceCents = Math.round(parseFloat(priceRaw || '0') * 100)
    const id = row.dataset.modId || undefined
    return { id, name, priceCents }
  }).filter((o) => o.name.length > 0)

  const selectedItemIds = Array.from(
    document.getElementById('edit-modifier-dish-chips').querySelectorAll('.modifier-chip[data-item-id]')
  ).map((chip) => chip.dataset.itemId)

  try {
    if (!groupName) throw new Error('Group name is required')

    let groupId = document.getElementById('edit-group-id').value

    if (!groupId) {
      // Create the group first
      const createRes = await api(
        `/api/merchants/${state.merchantId}/menu/modifier-groups`,
        { method: 'POST', body: JSON.stringify({ name: groupName }) }
      )
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to create modifier group')
      }
      const created = await createRes.json()
      groupId = created.id
    }

    // Save options
    const optRes = await api(
      `/api/merchants/${state.merchantId}/menu/modifier-groups/${groupId}/options`,
      { method: 'PUT', body: JSON.stringify({ name: groupName, availableForTakeout, isMandatory, minRequired, maxAllowed, options }) }
    )
    if (!optRes.ok) {
      const err = await optRes.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to save options')
    }

    // Save dish assignments
    const assignRes = await api(
      `/api/merchants/${state.merchantId}/menu/modifier-groups/${groupId}/items`,
      { method: 'PUT', body: JSON.stringify({ itemIds: selectedItemIds }) }
    )
    if (!assignRes.ok) {
      const err = await assignRes.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to save dish assignments')
    }

    showToast('Modifier group saved', 'success')
    closeModifierPanel()
    state.menu = null
    await loadMenu()
  } catch (err) {
    showToast(err.message || 'Failed to save modifier group', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Changes'
  }
}

/**
 * Syncs the current modifier group's options to Clover.
 * Saves locally first, then pushes the diff to the Clover API.
 */

// ---------------------------------------------------------------------------
// Brand images (logo + banner in profile)
// ---------------------------------------------------------------------------

/** Pending brand image data URLs — null means "no change this session" */
const brandImages     = { logo: null, banner: null, splash: null }
/** Corresponding WebP blobs for pending logo / banner / splash uploads */
const brandImageBlobs = { logo: null, banner: null, splash: null }

const LOGO_W = 1024, LOGO_H = 1024
const BANNER_W = 1280, BANNER_H = 768
const SPLASH_W = 1080, SPLASH_H = 1920

/**
 * Wire up one brand image upload area.
 * @param {'logo'|'banner'} key
 * @param {number} targetW
 * @param {number} targetH
 */
function wireBrandUpload(key, targetW, targetH) {
  const area = document.getElementById(`${key}-upload-area`)
  const fileInput = document.getElementById(`${key}-file-input`)
  const removeBtn = document.getElementById(`${key}-remove-btn`)

  const handleFile = (file) => {
    if (!file || !file.type.startsWith('image/')) return
    processImageFile(file, targetW, targetH, (previewUrl, blob) => {
      brandImages[key]     = previewUrl
      brandImageBlobs[key] = blob
      setBrandPreview(key, previewUrl)
    })
  }

  area.addEventListener('click', () => fileInput.click())
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click() }
  })
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('drag-over') })
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'))
  area.addEventListener('drop', (e) => {
    e.preventDefault()
    area.classList.remove('drag-over')
    handleFile(e.dataTransfer.files?.[0])
  })

  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files?.[0])
    fileInput.value = ''
  })

  removeBtn.addEventListener('click', () => {
    brandImages[key] = ''   // empty string = explicitly cleared
    setBrandPreview(key, null)
  })
}

function initBrandImages() {
  wireBrandUpload('logo', LOGO_W, LOGO_H)
  wireBrandUpload('banner', BANNER_W, BANNER_H)
  wireBrandUpload('splash', SPLASH_W, SPLASH_H)

  document.getElementById('save-images-btn').addEventListener('click', saveBrandImages)

  // Welcome message — save on button click (shares the save-images-btn)
  // The welcome message is included in the same PUT call.
}

/** Show or clear the preview for logo or banner */
function setBrandPreview(key, url) {
  const area = document.getElementById(`${key}-upload-area`)
  const placeholder = document.getElementById(`${key}-upload-placeholder`)
  const preview = document.getElementById(`${key}-upload-preview`)
  const removeBtn = document.getElementById(`${key}-remove-btn`)

  if (url) {
    preview.src = url
    preview.hidden = false
    placeholder.hidden = true
    removeBtn.hidden = false
    area.classList.add('has-photo')
  } else {
    preview.src = ''
    preview.hidden = true
    placeholder.hidden = false
    removeBtn.hidden = true
    area.classList.remove('has-photo')
  }
}

async function saveBrandImages() {
  const btn = document.getElementById('save-images-btn')
  btn.disabled = true
  btn.textContent = 'Saving…'

  // Upload pending blobs first, then build payload with server URLs
  const payload = {}
  const keyMap = { logo: 'logoUrl', banner: 'bannerUrl', splash: 'splashUrl' }
  for (const key of ['logo', 'banner', 'splash']) {
    if (brandImages[key] === null) continue           // not changed this session
    if (brandImageBlobs[key]) {
      const url = await uploadImage(brandImageBlobs[key])
      brandImageBlobs[key] = null
      payload[keyMap[key]] = url
    } else {
      // Explicitly cleared (empty string) or legacy data URL
      payload[keyMap[key]] = brandImages[key] || null
    }
  }

  // Include welcome message if the textarea exists
  const welcomeEl = document.getElementById('welcome-message-input')
  if (welcomeEl) {
    payload.welcomeMessage = welcomeEl.value.trim() || null
  }

  if (Object.keys(payload).length === 0) {
    showToast('No changes to save', 'error')
    btn.disabled = false
    btn.textContent = 'Save Images'
    return
  }

  try {
    const res = await api(`/api/merchants/${state.merchantId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error('Save failed')
    // Reset pending state
    brandImages.logo = null
    brandImages.banner = null
    brandImages.splash = null
    showToast('Images saved', 'success')
  } catch {
    showToast('Failed to save images', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Images'
  }
}

// ---------------------------------------------------------------------------
// Image upload, resize & crop
// ---------------------------------------------------------------------------

/** TARGET dimensions for stored images — 600×450 is sufficient for food-photo thumbnails */
const IMG_W = 600
const IMG_H = 450

/**
 * Update the photo upload area to show a preview image (url/data URL) or
 * reset it to the placeholder state when url is null.
 */
function setPhotoPreview(url) {
  const area = document.getElementById('photo-upload-area')
  const placeholder = document.getElementById('photo-upload-placeholder')
  const preview = document.getElementById('photo-upload-preview')
  const removeBtn = document.getElementById('photo-remove-btn')

  if (url) {
    preview.src = url
    preview.hidden = false
    placeholder.hidden = true
    removeBtn.hidden = false
    area.classList.add('has-photo')
  } else {
    preview.src = ''
    preview.hidden = true
    placeholder.hidden = false
    removeBtn.hidden = true
    area.classList.remove('has-photo')
  }
}

/**
 * Read a File, then decide whether to show the crop modal or render directly.
 * If the image already covers the target at exact ratio, render immediately;
 * otherwise always show crop to let the user choose the framing.
 *
 * @param {File} file
 * @param {number} targetW  - output canvas width
 * @param {number} targetH  - output canvas height
 * @param {(previewUrl: string, blob: Blob|null) => void} onResult - called with a
 *   blob: object URL for preview display and the raw WebP Blob for later upload.
 *   Falls back to a JPEG data URL + null blob on browsers without WebP canvas support.
 */
function processImageFile(file, targetW, targetH, onResult) {
  const reader = new FileReader()
  reader.onload = (ev) => {
    const img = new Image()
    img.onload = () => {
      const targetAR = targetW / targetH
      const imageAR = img.naturalWidth / img.naturalHeight

      // If the image is already the exact ratio and at least as large, draw directly
      const exactRatio = Math.abs(imageAR - targetAR) < 0.01
      const largeEnough = img.naturalWidth >= targetW && img.naturalHeight >= targetH

      if (exactRatio && largeEnough) {
        const canvas = document.getElementById('image-canvas')
        canvas.width = targetW
        canvas.height = targetH
        canvas.getContext('2d').drawImage(img, 0, 0, targetW, targetH)
        _canvasToResult(canvas, onResult)
      } else {
        // Show crop modal — works for any ratio mismatch or size difference
        openCropModal(img, targetW, targetH, onResult)
      }
    }
    img.src = ev.target.result
  }
  reader.readAsDataURL(file)
}

/**
 * Convert a canvas to a WebP Blob and call onResult(previewUrl, blob).
 * Falls back to JPEG data URL + null blob if WebP toBlob is unsupported.
 * @param {HTMLCanvasElement} canvas
 * @param {(previewUrl: string, blob: Blob|null) => void} onResult
 */
function _canvasToResult(canvas, onResult) {
  canvas.toBlob(
    (blob) => {
      if (!blob) {
        // Fallback: very old browser with no WebP canvas support
        onResult(canvas.toDataURL('image/jpeg', 0.82), null)
        return
      }
      onResult(URL.createObjectURL(blob), blob)
    },
    'image/webp',
    0.82
  )
}

// ---------------------------------------------------------------------------
// camera.js integration hooks
// Expose functions so camera.js (loaded after this file) can call back into
// dashboard.js internals without tight coupling.
// ---------------------------------------------------------------------------

/** Called by camera.js after snap → crop → confirm for the menu item photo */
window.processImageFile = processImageFile

/** Called by camera.js after snap → crop → confirm for the menu item photo */
window._dashboardSetPhoto = (previewUrl, blob) => {
  state.editingImageDataUrl = previewUrl
  state.editingImageBlob   = blob ?? null
  setPhotoPreview(previewUrl)
}

/** Called by camera.js after snap → crop → confirm for logo or banner */
window._dashboardSetBrand = (key, previewUrl, blob) => {
  brandImages[key]     = previewUrl
  brandImageBlobs[key] = blob ?? null
  setBrandPreview(key, previewUrl)
}

// ---------------------------------------------------------------------------
// Crop modal
// ---------------------------------------------------------------------------

/**
 * Generalised crop modal state.
 * Supports 2D panning for any target aspect ratio (logo 1:1, banner 5:3, menu item 4:3).
 */
const cropState = {
  img: null,
  /** Target output width/height in pixels */
  targetW: IMG_W,
  targetH: IMG_H,
  /** Scaled image dimensions at display scale */
  scaledW: 0,
  scaledH: 0,
  /** Current image offset inside viewport (both axes, ≤ 0) */
  imgX: 0,
  imgY: 0,
  /** Pointer tracking */
  dragging: false,
  lastX: 0,
  lastY: 0,
  /** Scale factor: viewport display width / targetW */
  displayScale: 1,
  /** Callback(dataUrl) called when user confirms */
  onConfirm: null,
}

function initCropModal() {
  const viewport = document.getElementById('crop-viewport')

  document.getElementById('crop-confirm-btn').addEventListener('click', confirmCrop)
  document.getElementById('crop-cancel-btn').addEventListener('click', closeCropModal)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('crop-modal').hidden) closeCropModal()
  })

  // 2D pointer drag
  viewport.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    cropState.dragging = true
    cropState.lastX = e.clientX
    cropState.lastY = e.clientY
    viewport.setPointerCapture(e.pointerId)
  })

  viewport.addEventListener('pointermove', (e) => {
    if (!cropState.dragging) return
    const dx = e.clientX - cropState.lastX
    const dy = e.clientY - cropState.lastY
    cropState.lastX = e.clientX
    cropState.lastY = e.clientY
    moveCropImage(dx, dy)
  })

  const stopDrag = () => { cropState.dragging = false }
  viewport.addEventListener('pointerup', stopDrag)
  viewport.addEventListener('pointercancel', stopDrag)
}

/**
 * Open the crop modal for any target size.
 * @param {HTMLImageElement} img      — already-loaded image
 * @param {number} targetW            — output width in px
 * @param {number} targetH            — output height in px
 * @param {(dataUrl: string) => void} onConfirm — called with JPEG data URL on confirm
 */
function openCropModal(img, targetW, targetH, onConfirm) {
  cropState.img = img
  cropState.targetW = targetW
  cropState.targetH = targetH
  cropState.onConfirm = onConfirm

  const viewport = document.getElementById('crop-viewport')
  const cropImg  = document.getElementById('crop-img')
  const inner    = document.querySelector('.crop-modal-inner')

  // Set viewport aspect ratio to match target
  viewport.style.aspectRatio = `${targetW} / ${targetH}`

  // For portrait images, shrink the modal so the crop window isn't huge.
  // Target ~1/3 display scale for 9:16 (360 px wide + 48 px inner padding).
  // For landscape/square, clear any previous override and use the CSS default.
  if (inner) {
    if (targetH > targetW) {
      const displayW = Math.round(Math.min(targetW / 3, 400))
      inner.style.maxWidth = (displayW + 48) + 'px'
    } else {
      inner.style.maxWidth = ''
    }
  }

  // Show modal first so layout dimensions are real
  cropImg.src = ''
  document.getElementById('crop-modal').hidden = false

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const viewportW = viewport.clientWidth
    const viewportH = viewport.clientHeight
    cropState.displayScale = viewportW / targetW

    // Scale image so it covers the viewport fully in both dimensions
    // Use the larger scale factor (cover, not contain)
    const scaleX = viewportW / img.naturalWidth
    const scaleY = viewportH / img.naturalHeight
    const scale = Math.max(scaleX, scaleY)

    cropState.scaledW = Math.round(img.naturalWidth * scale)
    cropState.scaledH = Math.round(img.naturalHeight * scale)

    cropImg.src = img.src
    cropImg.style.width = `${cropState.scaledW}px`
    cropImg.style.height = `${cropState.scaledH}px`

    // Start centred on both axes
    cropState.imgX = Math.round((viewportW - cropState.scaledW) / 2)
    cropState.imgY = Math.round((viewportH - cropState.scaledH) / 2)
    applyCropPosition()
  }))
}

function closeCropModal() {
  document.getElementById('crop-modal').hidden = true
  const inner = document.querySelector('.crop-modal-inner')
  if (inner) inner.style.maxWidth = ''
  cropState.img = null
  cropState.onConfirm = null
}

/** Move image by (dx, dy) display-pixels, clamped to never expose empty space */
function moveCropImage(dx, dy) {
  const viewport = document.getElementById('crop-viewport')
  const viewportW = viewport.clientWidth
  const viewportH = viewport.clientHeight

  // X: image must cover viewport horizontally
  const minX = viewportW - cropState.scaledW
  const maxX = 0
  cropState.imgX = Math.min(maxX, Math.max(minX, cropState.imgX + dx))

  // Y: image must cover viewport vertically
  const minY = viewportH - cropState.scaledH
  const maxY = 0
  cropState.imgY = Math.min(maxY, Math.max(minY, cropState.imgY + dy))

  applyCropPosition()
}

function applyCropPosition() {
  document.getElementById('crop-img').style.transform =
    `translate(${cropState.imgX}px, ${cropState.imgY}px)`
}

function confirmCrop() {
  const { img, targetW, targetH, scaledW, scaledH, imgX, imgY, onConfirm } = cropState

  // displayScale: how many display pixels correspond to one target pixel
  // (viewport is sized to targetW × targetH at displayScale)
  const displayScale = cropState.displayScale  // = viewportW / targetW

  // Convert display-space offset back to source-image coordinates.
  // The displayed image is scaledW × scaledH display-px = naturalW × naturalH source-px.
  const scaleToNatural = img.naturalWidth / scaledW

  // Top-left of the crop window in display space is (0,0).
  // imgX/imgY are where the image's top-left sits in display space (≤ 0).
  // So the crop window starts at (-imgX, -imgY) in display space relative to image.
  // In source space that is (-imgX * scaleToNatural, -imgY * scaleToNatural).
  const srcX = -imgX * scaleToNatural
  const srcY = -imgY * scaleToNatural

  // The crop window in display space is (viewportW × viewportH) = (targetW × targetH) * displayScale.
  // In source space the crop covers (viewport / scaledW) * naturalW pixels wide.
  const srcW = (targetW * displayScale) / scaledW * img.naturalWidth
  const srcH = (targetH * displayScale) / scaledH * img.naturalHeight

  const canvas = document.getElementById('image-canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, targetW, targetH)

  closeCropModal()
  if (onConfirm) _canvasToResult(canvas, onConfirm)
}

// ---------------------------------------------------------------------------
// Modifier chips (in item edit panel)
// ---------------------------------------------------------------------------

/**
 * Render the assigned modifier groups as removable chips.
 * @param {Array<{id: string, name: string, modifiers?: unknown[]}>} groups
 */
function renderModifierChips(groups) {
  const container = document.getElementById('edit-item-modifier-chips')
  container.innerHTML = ''

  for (const group of groups) {
    const chip = document.createElement('span')
    chip.className = 'modifier-chip'
    chip.dataset.groupId = group.id

    const label = document.createElement('span')
    label.textContent = group.name

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'modifier-chip-remove'
    removeBtn.setAttribute('aria-label', `Remove ${group.name}`)
    removeBtn.innerHTML = '&times;'
    removeBtn.addEventListener('click', () => {
      chip.remove()
    })

    chip.appendChild(label)
    chip.appendChild(removeBtn)
    container.appendChild(chip)
  }
}

// ---------------------------------------------------------------------------
// Modifier picker modal
// ---------------------------------------------------------------------------

function initModifierPickerModal() {
  document.getElementById('picker-modal-close').addEventListener('click', closeModifierPicker)
  document.getElementById('picker-modal-backdrop').addEventListener('click', closeModifierPicker)

  document.getElementById('picker-search').addEventListener('input', (e) => {
    renderPickerList(e.target.value.trim())
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('modifier-picker-modal').hidden) {
      closeModifierPicker()
    }
  })
}

function openModifierPicker() {
  document.getElementById('picker-search').value = ''
  renderPickerList('')
  document.getElementById('modifier-picker-modal').hidden = false
  document.getElementById('picker-modal-backdrop').hidden = false
  document.getElementById('picker-search').focus()
}

function closeModifierPicker() {
  document.getElementById('modifier-picker-modal').hidden = true
  document.getElementById('picker-modal-backdrop').hidden = true
}

/** Build the picker list filtered by query, excluding already-assigned groups */
function renderPickerList(query) {
  const list = document.getElementById('picker-list')
  list.innerHTML = ''

  const allGroups = getAllModifierGroups()
  const assignedIds = new Set(
    Array.from(document.getElementById('edit-item-modifier-chips').querySelectorAll('.modifier-chip'))
      .map((c) => c.dataset.groupId)
  )

  const q = query.toLowerCase()
  const filtered = allGroups.filter((g) =>
    !assignedIds.has(g.id) && (!q || g.name.toLowerCase().includes(q))
  )

  if (filtered.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'picker-list-empty'
    empty.textContent = query ? 'No groups match your search.' : 'All modifier groups are already assigned.'
    list.appendChild(empty)
    return
  }

  for (const group of filtered) {
    const li = document.createElement('li')
    li.className = 'picker-list-item'
    li.setAttribute('role', 'option')
    li.setAttribute('tabindex', '0')

    const name = document.createElement('span')
    name.className = 'picker-item-name'
    name.textContent = group.name

    const meta = document.createElement('span')
    meta.className = 'picker-item-meta'
    meta.textContent = group.modifiers?.length ? `${group.modifiers.length} options` : ''

    li.appendChild(name)
    li.appendChild(meta)

    const addGroup = () => {
      // Add chip to the panel
      renderModifierChips([
        ...Array.from(document.getElementById('edit-item-modifier-chips').querySelectorAll('.modifier-chip'))
          .map((c) => ({ id: c.dataset.groupId, name: c.querySelector('span').textContent })),
        { id: group.id, name: group.name },
      ])
      closeModifierPicker()
    }

    li.addEventListener('click', addGroup)
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addGroup() }
    })

    list.appendChild(li)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all unique modifier groups from current menu data */
function getAllModifierGroups() {
  if (!state.menu) return []
  const map = new Map()
  const collect = (items) => {
    for (const item of items ?? []) {
      for (const g of item.modifierGroups ?? []) {
        if (!map.has(g.id)) map.set(g.id, g)
      }
    }
  }
  for (const cat of state.menu.categories ?? []) collect(cat.items)
  collect(state.menu.uncategorizedItems)
  return Array.from(map.values())
}

/** Build a checkbox row for the checklist panels */
function makeCheckRow(id, label, meta, checked, value) {
  const row = document.createElement('label')
  row.className = 'modifier-check-row'
  row.htmlFor = id

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.id = id
  cb.checked = checked
  cb.dataset.value = value

  const labelEl = document.createElement('span')
  labelEl.className = 'modifier-check-label'
  labelEl.textContent = label

  row.appendChild(cb)
  row.appendChild(labelEl)

  if (meta) {
    const metaEl = document.createElement('span')
    metaEl.className = 'modifier-check-meta'
    metaEl.textContent = meta
    row.appendChild(metaEl)
  }

  return row
}

function clearAuth() {
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
  localStorage.removeItem('merchantId')
}

/**
 * Upload a WebP Blob to the server image store.
 * Returns the public URL path (e.g. "/images/merchants/m_xxx/abc.webp"),
 * or null if blob is null (no new image chosen).
 *
 * NOTE: must NOT use api() here — api() always injects Content-Type: application/json
 * which overrides the browser's automatic multipart/form-data boundary header and
 * causes the server to reject the upload with 400.
 * @param {Blob|null} blob
 * @returns {Promise<string|null>}
 */
async function uploadImage(blob) {
  if (!blob) return null
  const fd = new FormData()
  fd.append('image', blob, 'image.webp')

  // Use fetch directly — no Content-Type header so browser auto-sets multipart boundary
  const doFetch = (token) => fetch(`/api/merchants/${state.merchantId}/images`, {
    method: 'POST',
    body: fd,
    headers: { 'Authorization': `Bearer ${token}` },
  })

  let res = await doFetch(state.accessToken)

  // Retry once with a refreshed token on 401 (mirrors api() behaviour)
  if (res.status === 401 && state.refreshToken) {
    try {
      const refresh = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      })
      if (refresh.ok) {
        const data = await refresh.json()
        state.accessToken = data.accessToken
        res = await doFetch(state.accessToken)
      }
    } catch {
      // refresh failed — fall through, caller handles the response
    }
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.error || `Image upload failed (${res.status})`)
  }
  const { url } = await res.json()
  return url
}

/**
 * Authenticated API fetch.
 * Automatically retries once with a refreshed access token on 401.
 */
async function api(path, options = {}) {
  const timeout = options.timeout ?? 15_000
  const maxRetries = options.retries ?? 1

  const makeRequest = (token) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    return fetch(path, {
      ...options,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
    }).finally(() => clearTimeout(timer))
  }

  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let res = await makeRequest(state.accessToken)

      if (res.status === 401) {
        // Token expired — try to refresh silently
        const refreshToken = localStorage.getItem('refreshToken')
        if (refreshToken) {
          try {
            const refreshRes = await fetch('/api/auth/refresh', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refreshToken }),
            })
            if (refreshRes.ok) {
              const { accessToken } = await refreshRes.json()
              state.accessToken = accessToken
              localStorage.setItem('accessToken', accessToken)
              res = await makeRequest(accessToken)
            }
          } catch {
            // Refresh failed — fall through, caller handles the 401
          }
        }
      }

      return res
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }

  throw lastErr
}
// Expose shared utilities for order-entry.js (loaded after this file)
window.api = api
window.showToast = showToast
window.formatPrice = formatPrice

function getValue(id) { return document.getElementById(id)?.value ?? '' }
function setValue(id, value) { const e = document.getElementById(id); if (e) e.value = value }
function setSelectValue(id, value) { var e = document.getElementById(id); if (e) e.value = value }

/**
 * Probe up to three printer IPs and update the status dot next to each label.
 * @param {string|null|undefined} kitchenIp
 * @param {string|null|undefined} counterIp
 * @param {string|null|undefined} receiptIp
 */
async function probePrinterStatus(kitchenIp, counterIp, receiptIp) {
  var ips = [kitchenIp, counterIp, receiptIp].filter(Boolean)
  if (!ips.length) return

  var dotIds = {
    [kitchenIp]: 'kitchen-printer-status',
    [counterIp]: 'counter-printer-status',
    [receiptIp]: 'receipt-printer-status',
  }

  function setDot(ip, online) {
    var id = dotIds[ip]
    if (!id) return
    var dot = document.getElementById(id)
    if (!dot) return
    if (online) {
      dot.className = 'printer-status-dot printer-status-dot--online'
      dot.title = 'Online'
    } else {
      dot.className = 'printer-status-dot printer-status-dot--offline'
      dot.title = 'Offline'
    }
  }

  try {
    var query = ips.map(function(ip) { return encodeURIComponent(ip) }).join(',')
    var res = await api('/api/merchants/' + state.merchantId + '/printers/status?ips=' + query)
    if (!res.ok) return
    var data = await res.json()
    if (!data.success || !data.status) return
    ips.forEach(function(ip) {
      setDot(ip, !!data.status[ip])
    })
  } catch {
    // Silently ignore — status dots just stay gray
  }
}

function formatPrice(cents) { return '$' + (cents / 100).toFixed(2) }

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast')
  if (!toast) return
  toast.textContent = message
  toast.className = `toast ${type} show`
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { toast.className = 'toast' }, 3500)
}

// ---------------------------------------------------------------------------
// Stax payment failure notifications
// ---------------------------------------------------------------------------

/**
 * Polls /api/merchants/:id/payment-notifications for Stax payment failures.
 * Stax's hosted payment page does not redirect on failure, so failures are
 * captured via Stax webhooks and surfaced here via polling.
 *
 * Fires on:
 *  - Page load (after authentication)
 *  - Tab becoming visible (visibilitychange)
 *  - Every 30 seconds while the page is open
 */
function startPaymentNotificationPolling() {
  let lastCheckAt = 0

  async function checkPaymentNotifications() {
    if (!state.merchantId || !state.accessToken) return
    // Debounce: skip if checked within the last 5 seconds
    if (Date.now() - lastCheckAt < 5_000) return
    lastCheckAt = Date.now()

    try {
      const res = await api(`/api/merchants/${state.merchantId}/payment-notifications`)
      if (!res.ok) return
      const data = await res.json()

      for (const n of data.notifications) {
        // Build a human-readable message
        const amount = n.total != null ? `$${parseFloat(n.total).toFixed(2)}` : 'Payment'
        const card   = n.last4 ? ` (card ···${n.last4})` : ''
        const who    = n.customerName ? ` for ${n.customerName}` : ''
        showToast(`${amount}${card} DECLINED${who} — please retry payment`, 'error')

        // Mark as dismissed so it won't be shown again
        api(
          `/api/merchants/${state.merchantId}/payment-notifications/${n.id}/dismiss`,
          { method: 'PATCH' }
        ).catch(() => {})
      }
    } catch {
      // Silent fail — notifications are best-effort
    }
  }

  // Fire on tab refocus (merchant switches back after attempting payment)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkPaymentNotifications()
  })

  // Poll every 30 seconds as a fallback
  setInterval(checkPaymentNotifications, 30_000)

  // Initial check shortly after boot (give auth a moment to settle)
  setTimeout(checkPaymentNotifications, 2_000)
}

// ---------------------------------------------------------------------------
// Shopping Cart (order creation in the Menu section)
// ---------------------------------------------------------------------------

/**
 * Cart state:
 *   items: [{ cartId, itemId, name, priceCents, quantity, modifiers: [{modifierId, name, priceCents}] }]
 *   orderType: 'dine_in' | 'pickup' | 'delivery'
 */
const cartState = {
  items: [],
  orderType: 'dine_in',
  /** The item currently being customized (before adding to cart) */
  pendingItem: null,
  /** Pending selections per group while customizer is open */
  pendingSelections: {},
  /** Selected tip percentage (integer, e.g. 15), or null for no tip */
  tipPercent: null,
}

let _cartId = 1
function nextCartId() { return `ci_${_cartId++}` }

function initCart() {
  // Order type buttons
  document.querySelectorAll('.cart-type-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cart-type-btn').forEach((b) => {
        b.classList.remove('active')
        b.setAttribute('aria-pressed', 'false')
      })
      btn.classList.add('active')
      btn.setAttribute('aria-pressed', 'true')
      cartState.orderType = btn.dataset.type
    })
  })

  // Clear button
  document.getElementById('cart-clear-btn')?.addEventListener('click', () => {
    cartState.items = []
    cartState.tipPercent = null
    const tipContainer = document.getElementById('cart-tip-options')
    if (tipContainer) delete tipContainer.dataset.wired
    closeCartCustomizer()
    renderCart()
  })

  // Utensils toggle
  const utensilsToggle = document.getElementById('cart-utensils')
  utensilsToggle?.addEventListener('click', () => {
    const checked = utensilsToggle.getAttribute('aria-checked') === 'true'
    utensilsToggle.setAttribute('aria-checked', String(!checked))
  })
  utensilsToggle?.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); utensilsToggle.click() }
  })

  // Drag-and-drop: cart as drop target
  const dropZone = document.getElementById('cart-drop-zone')
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    dropZone.classList.add('drag-over')
  })
  dropZone?.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over')
  })
  dropZone?.addEventListener('drop', (e) => {
    e.preventDefault()
    dropZone.classList.remove('drag-over')
    const itemId = e.dataTransfer.getData('text/plain')
    const item = state.allItems.find((i) => i.id === itemId)
    if (item) addToCart(item)
  })

  // Customizer cancel
  document.getElementById('cart-customizer-cancel')?.addEventListener('click', closeCartCustomizer)

  // Customizer add button
  document.getElementById('cart-customizer-add')?.addEventListener('click', confirmCartCustomizer)

  // Place order
  document.getElementById('cart-place-btn')?.addEventListener('click', placeOrder)

  // Pay Now — opens Stax hosted payment page, then submits the order
  document.getElementById('cart-pay-btn')?.addEventListener('click', openStaxPayment)

  renderCart()
}

/**
 * Add a menu item to the cart.
 * If it has modifier groups, opens the inline customizer first.
 */
function addToCart(item) {
  const groups = item.modifierGroups ?? []

  if (groups.length > 0) {
    openCartCustomizer(item)
  } else {
    pushCartItem(item, [])
    renderCart()
  }
}

/** Push a resolved item (with selected modifiers) into cartState */
function pushCartItem(item, modifiers) {
  // Check if an identical item+modifiers combo already exists → increment qty
  const modKey = JSON.stringify(modifiers.map((m) => m.modifierId).sort())
  const existing = cartState.items.find(
    (ci) => ci.itemId === item.id && JSON.stringify(ci.modifiers.map((m) => m.modifierId).sort()) === modKey
  )
  if (existing) {
    existing.quantity += 1
  } else {
    cartState.items.push({
      cartId: nextCartId(),
      itemId: item.id,
      name: item.name,
      priceCents: item.priceCents,
      quantity: 1,
      modifiers,
      specialInstructions: '',
    })
  }
}

/** Open the inline modifier customizer for an item */
function openCartCustomizer(item) {
  cartState.pendingItem = item
  cartState.pendingSelections = {}

  const body = document.getElementById('cart-customizer-body')
  body.innerHTML = ''

  const groups = item.modifierGroups ?? []

  for (const group of groups) {
    const groupEl = document.createElement('div')
    groupEl.className = 'cart-modifier-group'

    const label = document.createElement('div')
    label.className = 'cart-modifier-group-label'
    label.textContent = group.name
    if (group.minRequired > 0) {
      const star = document.createElement('span')
      star.className = 'required-star'
      star.setAttribute('aria-label', 'required')
      star.textContent = '*'
      label.appendChild(star)
    }
    groupEl.appendChild(label)

    const optionsEl = document.createElement('div')
    optionsEl.className = 'cart-modifier-options'

    for (const mod of group.modifiers ?? []) {
      if (mod.stockStatus === 'out_indefinitely') continue

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cart-modifier-option'
      btn.dataset.groupId = group.id
      btn.dataset.modId = mod.id
      btn.setAttribute('aria-pressed', 'false')

      const nameSpan = document.createElement('span')
      nameSpan.textContent = mod.name
      btn.appendChild(nameSpan)

      if (mod.priceCents > 0) {
        const delta = document.createElement('span')
        delta.className = 'mod-price-delta'
        delta.textContent = `+${formatPrice(mod.priceCents)}`
        btn.appendChild(delta)
      }

      btn.addEventListener('click', () => {
        const alreadySelected = btn.classList.contains('selected')

        // Deselect all in group first (radio behaviour)
        optionsEl.querySelectorAll('.cart-modifier-option').forEach((b) => {
          b.classList.remove('selected')
          b.setAttribute('aria-pressed', 'false')
        })

        if (alreadySelected && group.minRequired === 0) {
          // Toggle off: optional group, clicking selected option deselects it
          delete cartState.pendingSelections[group.id]
        } else {
          btn.classList.add('selected')
          btn.setAttribute('aria-pressed', 'true')
          cartState.pendingSelections[group.id] = { modifierId: mod.id, name: mod.name, priceCents: mod.priceCents }
        }
        updateCustomizerAddBtn()
      })

      optionsEl.appendChild(btn)
    }

    groupEl.appendChild(optionsEl)
    body.appendChild(groupEl)
  }

  document.getElementById('cart-customizer-title').textContent = `Customize: ${item.name}`
  document.getElementById('cart-customizer').hidden = false
  updateCustomizerAddBtn()
}

function updateCustomizerAddBtn() {
  const item = cartState.pendingItem
  if (!item) return
  const groups = item.modifierGroups ?? []
  const allRequiredMet = groups
    .filter((g) => g.minRequired > 0)
    .every((g) => cartState.pendingSelections[g.id])
  document.getElementById('cart-customizer-add').disabled = !allRequiredMet
}

function confirmCartCustomizer() {
  const item = cartState.pendingItem
  if (!item) return
  const modifiers = Object.values(cartState.pendingSelections)
  pushCartItem(item, modifiers)
  closeCartCustomizer()
  renderCart()
}

function closeCartCustomizer() {
  const el = document.getElementById('cart-customizer')
  if (el) el.hidden = true
  cartState.pendingItem = null
  cartState.pendingSelections = {}
}

/** Re-render the cart items list and update totals */
function renderCart() {
  const list = document.getElementById('cart-items')
  const emptyEl = document.getElementById('cart-empty')
  const placeBtn = document.getElementById('cart-place-btn')
  // Cart DOM was removed when Order Entry tab replaced the old menu cart
  if (!list) return
  list.innerHTML = ''

  const isEmpty = cartState.items.length === 0
  emptyEl.hidden = !isEmpty

  for (const ci of cartState.items) {
    const li = document.createElement('li')
    li.className = 'cart-item'

    // Top row: name + line price
    const top = document.createElement('div')
    top.className = 'cart-item-top'

    const nameEl = document.createElement('span')
    nameEl.className = 'cart-item-name'
    nameEl.textContent = ci.name
    top.appendChild(nameEl)

    const priceEl = document.createElement('span')
    priceEl.className = 'cart-item-price'
    const lineTotal = (ci.priceCents + ci.modifiers.reduce((s, m) => s + m.priceCents, 0)) * ci.quantity
    priceEl.textContent = formatPrice(lineTotal)
    top.appendChild(priceEl)

    li.appendChild(top)

    // Modifier summary line
    if (ci.modifiers.length > 0) {
      const modLine = document.createElement('div')
      modLine.className = 'cart-item-modifiers'
      modLine.textContent = ci.modifiers.map((m) => m.name).join(', ')
      li.appendChild(modLine)
    }

    // Controls: − qty + | Remove
    const controls = document.createElement('div')
    controls.className = 'cart-item-controls'

    const decBtn = document.createElement('button')
    decBtn.type = 'button'
    decBtn.className = 'cart-qty-btn'
    decBtn.textContent = '−'
    decBtn.setAttribute('aria-label', 'Decrease quantity')
    decBtn.addEventListener('click', () => { changeCartQty(ci.cartId, -1); renderCart() })

    const qtySpan = document.createElement('span')
    qtySpan.className = 'cart-qty-value'
    qtySpan.textContent = ci.quantity

    const incBtn = document.createElement('button')
    incBtn.type = 'button'
    incBtn.className = 'cart-qty-btn'
    incBtn.textContent = '+'
    incBtn.setAttribute('aria-label', 'Increase quantity')
    incBtn.addEventListener('click', () => { changeCartQty(ci.cartId, +1); renderCart() })

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'cart-item-remove'
    removeBtn.textContent = 'Remove'
    removeBtn.setAttribute('aria-label', `Remove ${ci.name}`)
    removeBtn.addEventListener('click', () => {
      cartState.items = cartState.items.filter((x) => x.cartId !== ci.cartId)
      renderCart()
    })

    controls.appendChild(decBtn)
    controls.appendChild(qtySpan)
    controls.appendChild(incBtn)
    controls.appendChild(removeBtn)
    li.appendChild(controls)

    // Special instructions (per-item note)
    const noteRow = document.createElement('div')
    noteRow.className = 'cart-item-note-row'

    const noteToggle = document.createElement('button')
    noteToggle.type = 'button'
    noteToggle.className = 'cart-item-note-toggle'
    noteToggle.setAttribute('aria-expanded', String(!!(ci.specialInstructions)))
    noteToggle.textContent = ci.specialInstructions ? 'Edit note' : '+ Add note'

    const noteArea = document.createElement('textarea')
    noteArea.className = 'input cart-item-note-input'
    noteArea.placeholder = 'Special instructions…'
    noteArea.rows = 2
    noteArea.setAttribute('aria-label', `Special instructions for ${ci.name}`)
    noteArea.value = ci.specialInstructions ?? ''
    noteArea.hidden = !ci.specialInstructions

    noteToggle.addEventListener('click', () => {
      const expanded = noteToggle.getAttribute('aria-expanded') === 'true'
      noteToggle.setAttribute('aria-expanded', String(!expanded))
      noteArea.hidden = expanded
      if (!expanded) noteArea.focus()
    })

    noteArea.addEventListener('input', () => {
      ci.specialInstructions = noteArea.value
      noteToggle.textContent = noteArea.value.trim() ? 'Edit note' : '+ Add note'
    })

    noteRow.appendChild(noteToggle)
    noteRow.appendChild(noteArea)
    li.appendChild(noteRow)

    list.appendChild(li)
  }

  // ── Totals ──────────────────────────────────────────────────────────────
  const subtotal = cartState.items.reduce(
    (s, ci) => s + (ci.priceCents + ci.modifiers.reduce((ms, m) => ms + m.priceCents, 0)) * ci.quantity,
    0
  )
  document.getElementById('cart-subtotal').textContent = formatPrice(subtotal)

  const taxRate = state.profile?.taxRate ?? 0
  const taxCents = Math.round(subtotal * taxRate)
  const hasTax = taxRate > 0 && !isEmpty
  const taxRow = document.getElementById('cart-tax-row')
  if (taxRow) {
    taxRow.hidden = !hasTax
    document.getElementById('cart-tax').textContent = formatPrice(taxCents)
  }

  // Tip selector — build pills from merchant config once items are present
  const tipRow = document.getElementById('cart-tip-row')
  const tipOptions = state.profile?.tipOptions ?? [15, 20, 25]
  if (tipRow) {
    tipRow.hidden = isEmpty
    const tipContainer = document.getElementById('cart-tip-options')
    if (tipContainer && !tipContainer.dataset.wired) {
      tipContainer.dataset.wired = '1'
      // Build pill buttons: "No tip" + each tip %
      const pills = [{ label: 'No tip', value: 0 }, ...tipOptions.map(p => ({ label: `${p}%`, value: p }))]
      tipContainer.innerHTML = ''
      for (const { label, value } of pills) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'cart-tip-btn'
        btn.textContent = label
        btn.dataset.tip = value
        btn.setAttribute('aria-pressed', String(cartState.tipPercent === value))
        btn.addEventListener('click', () => {
          cartState.tipPercent = value
          document.querySelectorAll('.cart-tip-btn').forEach(b => {
            b.setAttribute('aria-pressed', String(Number(b.dataset.tip) === value))
          })
          updateCartTotals()
        })
        tipContainer.appendChild(btn)
      }
    }
  }

  updateCartTotals()

  if (placeBtn) placeBtn.disabled = isEmpty

  // Show Pay Now only when cart has items and a Stax token is configured
  const payBtn = document.getElementById('cart-pay-btn')
  if (payBtn) payBtn.hidden = isEmpty || !state.profile?.staxToken
}

/** Recomputes tip + total rows from live cartState — always reads fresh values */
function updateCartTotals() {
  const subtotal = cartState.items.reduce(
    (s, ci) => s + (ci.priceCents + ci.modifiers.reduce((ms, m) => ms + m.priceCents, 0)) * ci.quantity,
    0
  )
  const taxRate = state.profile?.taxRate ?? 0
  const taxCents = Math.round(subtotal * taxRate)
  const tipPercent = cartState.tipPercent ?? 0
  const tipCents = Math.round(subtotal * tipPercent / 100)
  const total = subtotal + taxCents + tipCents

  const tipAmountRow = document.getElementById('cart-tip-amount-row')
  const totalRow = document.getElementById('cart-total-row')

  const hasTip = tipPercent > 0
  if (tipAmountRow) {
    tipAmountRow.hidden = !hasTip
    document.getElementById('cart-tip-amount').textContent = formatPrice(tipCents)
  }

  const hasBreakdown = (taxRate > 0 || hasTip) && subtotal > 0
  if (totalRow) {
    totalRow.hidden = !hasBreakdown
    document.getElementById('cart-total').textContent = formatPrice(total)
  }
}

function changeCartQty(cartId, delta) {
  const ci = cartState.items.find((x) => x.cartId === cartId)
  if (!ci) return
  ci.quantity = Math.max(0, ci.quantity + delta)
  if (ci.quantity === 0) cartState.items = cartState.items.filter((x) => x.cartId !== cartId)
}

/** Submit the cart as a new order */
/**
 * Opens the Stax hosted payment page in a new tab, pre-filled with the
 * order total and a redirect URL that triggers order submission on return.
 *
 * Flow:
 *  1. Validate cart (name + items)
 *  2. Compute total
 *  3. Build Stax dynamic link with ?memo, ?total, ?r flags
 *  4. Open in new tab
 *  5. The redirect URL is a special `#pay-complete` hash on this page —
 *     detected on load to auto-submit the order (best-effort, same-tab only)
 */
/**
 * Called on page load when returning from the Stax payment page (#stax-paid).
 * Restores the order from sessionStorage, enriches with Stax-returned customer
 * data, and auto-submits the order.
 * @param {URLSearchParams} staxParams - Query params appended by Stax to the redirect URL
 */
async function resumeAfterStaxPayment(staxParams) {
  const raw = sessionStorage.getItem('stax_pending_order')
  sessionStorage.removeItem('stax_pending_order')

  // Parse Stax-returned fields (more reliable than what we saved — customer may
  // have corrected their name/email on the Stax form)
  const staxFirstname = staxParams?.get('firstname') || ''
  const staxLastname  = staxParams?.get('lastname')  || ''
  const staxName  = [staxFirstname, staxLastname].filter(Boolean).join(' ')
  const staxPhone = staxParams?.get('phone') || ''
  const staxEmail = staxParams?.get('email') || ''
  const staxTotal = staxParams?.get('total') || ''

  if (!raw) {
    showSection('orders')
    showToast('Payment complete — but order data was lost. Please re-enter the order manually.', 'error')
    return
  }

  let saved
  try { saved = JSON.parse(raw) } catch {
    showSection('orders')
    return
  }

  // Prefer Stax-returned customer details; fall back to what we saved
  const customerName  = staxName  || saved.customerName  || 'Guest'
  const customerPhone = staxPhone || saved.customerPhone  || undefined
  const customerEmail = staxEmail || saved.customerEmail  || undefined

  // Convert Stax dollar total to cents for receipt printing
  const paidAmountCents = staxTotal ? Math.round(parseFloat(staxTotal) * 100) : undefined

  const confirmMsg = staxTotal
    ? `Payment of $${staxTotal} confirmed for ${customerName}…`
    : `Payment confirmed for ${customerName}…`
  showToast(confirmMsg, 'success')

  // ── Paying an existing order (from the Orders tab) ──────────────────────
  if (saved.existingOrderId) {
    try {
      const res = await api(`/api/merchants/${state.merchantId}/orders/${saved.existingOrderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'paid',
          paymentMethod: 'card',
          ...(paidAmountCents ? { paidAmountCents } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      showToast('Order marked as paid!', 'success')
      showSection('orders')
      await loadOrders()
      if (paidAmountCents) showReceiptPrompt(saved.existingOrderId, paidAmountCents)
    } catch (err) {
      showToast(`Failed to mark order as paid: ${err.message}`, 'error')
      showSection('orders')
      await loadOrders()
    }
    return
  }

  // ── New order (from the cart / order-entry Pay flow) ────────────────────
  try {
    const items = (saved.cartState?.items ?? []).map((ci) => ({
      itemId: ci.itemId,
      name: ci.name,
      priceCents: ci.priceCents,
      quantity: ci.quantity,
      selectedModifiers: ci.modifiers ?? [],
    }))

    const body = {
      orderType: saved.cartState?.orderType ?? 'pickup',
      customerName,
      customerPhone,
      customerEmail,
      notes: saved.notes || undefined,
      utensilsNeeded: !!saved.utensilsNeeded,
      tableLabel: saved.tableLabel ?? undefined,
      roomLabel: saved.roomLabel ?? undefined,
      items,
      printLanguage: saved.printLanguage || 'en',
      paymentMethod: 'card',
      ...(paidAmountCents ? { paidAmountCents } : {}),
    }

    const res = await api(`/api/merchants/${state.merchantId}/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json().catch(() => ({}))
    showToast('Order placed!', 'success')
    window.resetOrderEntry?.()
    showSection('orders')
    await loadOrders()
    if (paidAmountCents && data.orderId) showReceiptPrompt(data.orderId, paidAmountCents)
    return
  } catch (err) {
    showToast(`Order submission failed: ${err.message}`, 'error')
  }

  showSection('orders')
}

// ---------------------------------------------------------------------------
// CONVERGE (ELAVON) PAYMENT
// ---------------------------------------------------------------------------

/**
 * Loads payment provider config and updates the Converge section UI.
 */
async function loadPaymentConfig() {
  if (!state.merchantId) return
  try {
    const res = await api(`/api/merchants/${state.merchantId}/payments/config`)
    if (!res.ok) {
      if (res.status !== 401) {
        console.warn(`[loadPaymentConfig] HTTP ${res.status} — payment config not loaded`)
        if (res.status === 403) showToast('Payment config access denied — check IP allowlist', 'error')
      }
      return
    }
    state.paymentConfig = await res.json()
    updateConvergeUI(state.paymentConfig.converge)
    updateFinixUI(state.paymentConfig.finix)
    updateStaxBadge(state.paymentConfig.stax?.token)
    updateProviderSelector(state.paymentConfig)
  } catch (err) {
    console.warn('[loadPaymentConfig] failed:', err)
  }
}

/**
 * Shows/hides the Active Pay Button selector and disables options for
 * providers that aren't configured yet.
 * @param {{ stax: { enabled: boolean }, converge: { enabled: boolean } }} config
 */
function updateProviderSelector(config) {
  const row      = document.getElementById('payment-active-provider-row')
  const select   = document.getElementById('payment-active-provider')
  if (!row || !select) return

  const staxOk     = !!config?.stax?.enabled
  const convergeOk = !!config?.converge?.enabled
  const finixOk    = !!config?.finix?.enabled
  const anyEnabled = staxOk || convergeOk || finixOk

  row.hidden = !anyEnabled

  // Disable options for unconfigured providers so user can't select something that won't work
  select.querySelector('option[value="stax"]').disabled     = !staxOk
  select.querySelector('option[value="converge"]').disabled = !convergeOk
  const finixOpt = select.querySelector('option[value="finix"]')
  if (finixOpt) finixOpt.disabled = !finixOk

  // If the current saved value is for a provider that's no longer configured, clear it
  if (select.value && !anyEnabled) select.value = ''
  if (select.value === 'stax'     && !staxOk)     select.value = ''
  if (select.value === 'converge' && !convergeOk) select.value = ''
  if (select.value === 'finix'    && !finixOk)    select.value = ''
}

/**
 * Updates the Stax status badge in the profile form.
 * @param {string|null} token
 */
function updateStaxBadge(token) {
  const badge = document.getElementById('stax-status-badge')
  if (!badge) return
  if (token) {
    badge.textContent = 'Active'
    badge.className = 'payment-status-badge badge-active'
  } else {
    badge.textContent = 'Not configured'
    badge.className = 'payment-status-badge badge-inactive'
  }
}

/**
 * Updates the Converge card UI based on current config.
 * @param {{ enabled: boolean, sandbox: boolean, accountId: string|null, userId: string|null }} config
 */
function updateConvergeUI(config) {
  const badge       = document.getElementById('converge-status-badge')
  const setupView   = document.getElementById('converge-setup-view')
  const configView  = document.getElementById('converge-configured-view')
  const accountDisp = document.getElementById('converge-account-display')
  const userDisp    = document.getElementById('converge-user-display')
  const sandboxChk  = document.getElementById('store-converge-sandbox')
  if (!badge || !setupView || !configView) return

  if (config?.enabled) {
    badge.textContent = config.sandbox ? 'Demo' : 'Live'
    badge.className   = 'payment-status-badge badge-active'
    setupView.hidden  = true
    configView.hidden = false
    if (accountDisp) accountDisp.textContent = config.accountId ?? ''
    if (userDisp)    userDisp.textContent    = config.userId    ?? ''
    if (sandboxChk)  sandboxChk.checked      = !!config.sandbox
  } else {
    badge.textContent = 'Not configured'
    badge.className   = 'payment-status-badge badge-inactive'
    setupView.hidden  = false
    configView.hidden = true
  }
}

/**
 * Binds Converge UI buttons (save credentials, remove credentials).
 * Called once on page load.
 */
function initConvergeUI() {
  // Fetch and display server IP for whitelist instructions.
  // Pass sandbox flag so the endpoint queries the correct Converge environment
  // (demo and production have SEPARATE IP whitelists and separate myip URLs).
  ;(async () => {
    const ipEl        = document.getElementById('converge-server-ip')
    const copyBtn     = document.getElementById('converge-copy-ip-btn')
    const whitelistEl = document.getElementById('converge-whitelist-link')
    if (!ipEl) return

    // Read sandbox state from the setup-view checkbox (checked by default = sandbox)
    const sandboxChk = document.getElementById('converge-sandbox-input')
    const sandbox = sandboxChk ? sandboxChk.checked : true
    const qs = sandbox ? '' : '?sandbox=0'

    try {
      const res = await fetch(`/api/payments/server-ip${qs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { ip, whitelistUrl } = await res.json()
      ipEl.textContent = ip || 'Unknown'
      if (whitelistEl && whitelistUrl) whitelistEl.href = whitelistUrl
      if (copyBtn && ip) {
        copyBtn.hidden = false
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(ip).then(() => {
            const orig = copyBtn.textContent
            copyBtn.textContent = 'Copied!'
            setTimeout(() => { copyBtn.textContent = orig }, 1500)
          }).catch(() => {})
        })
      }
    } catch {
      ipEl.textContent = 'Could not determine'
    }
  })()

  // Re-fetch IP when the sandbox toggle changes so the whitelist link stays correct
  document.getElementById('converge-sandbox-input')?.addEventListener('change', async (e) => {
    const sandbox = e.target.checked
    const qs = sandbox ? '' : '?sandbox=0'
    const ipEl        = document.getElementById('converge-server-ip')
    const whitelistEl = document.getElementById('converge-whitelist-link')
    if (ipEl) ipEl.textContent = 'Loading…'
    try {
      const res = await fetch(`/api/payments/server-ip${qs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { ip, whitelistUrl } = await res.json()
      if (ipEl) ipEl.textContent = ip || 'Unknown'
      if (whitelistEl && whitelistUrl) whitelistEl.href = whitelistUrl
    } catch {
      if (ipEl) ipEl.textContent = 'Could not determine'
    }
  })

  // Save credentials
  document.getElementById('converge-save-btn')?.addEventListener('click', async () => {
    const accountId = document.getElementById('converge-account-id-input')?.value.trim()
    const userId    = document.getElementById('converge-user-id-input')?.value.trim()
    const pin       = document.getElementById('converge-pin-input')?.value.trim()
    const sandbox   = document.getElementById('converge-sandbox-input')?.checked ?? true

    if (!accountId || !userId || !pin) {
      showToast('Account ID, User ID and PIN are all required', 'error')
      return
    }

    const btn = document.getElementById('converge-save-btn')
    btn.disabled = true
    btn.textContent = 'Saving…'

    try {
      // 1. Store encrypted credentials via existing keys endpoint
      const keyRes = await api(`/api/merchants/${state.merchantId}/keys`, {
        method: 'POST',
        body: JSON.stringify({
          keyType:       'payment',
          provider:      'converge',
          apiKey:        pin,
          posMerchantId: `${accountId}:${userId}`,
        }),
      })
      if (!keyRes.ok) {
        const err = await keyRes.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${keyRes.status}`)
      }

      // 2. Save sandbox flag via profile PUT
      await api(`/api/merchants/${state.merchantId}`, {
        method: 'PUT',
        body: JSON.stringify({ convergeSandbox: sandbox }),
      })

      showToast('Converge credentials saved', 'success')
      await loadPaymentConfig()

      // Clear the PIN field for security
      const pinInput = document.getElementById('converge-pin-input')
      if (pinInput) pinInput.value = ''
    } catch (err) {
      showToast(`Failed to save Converge credentials: ${err.message}`, 'error')
    } finally {
      btn.disabled = false
      btn.textContent = 'Save Converge credentials'
    }
  })

  // Remove credentials
  document.getElementById('converge-remove-btn')?.addEventListener('click', async () => {
    if (!confirm('Remove Converge credentials? The Pay button will be disabled until you re-enter them.')) return
    try {
      const res = await api(
        `/api/merchants/${state.merchantId}/keys/converge?keyType=payment`,
        { method: 'DELETE' }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      showToast('Converge credentials removed', 'success')
      await loadPaymentConfig()
    } catch (err) {
      showToast(`Failed to remove credentials: ${err.message}`, 'error')
    }
  })
}

// ---------------------------------------------------------------------------
// Finix provider card UI
// ---------------------------------------------------------------------------

/**
 * Show/hide configured vs setup view for the Finix provider card.
 * @param {object|null} config - finix section from /payments/config
 */
function updateFinixUI(config) {
  const badge       = document.getElementById('finix-status-badge')
  const setupView   = document.getElementById('finix-setup-view')
  const configView  = document.getElementById('finix-configured-view')
  const userDisp    = document.getElementById('finix-username-display')
  const merchantDisp = document.getElementById('finix-merchant-display')
  const sandboxChk  = document.getElementById('store-finix-sandbox')
  const refundLocalChk = document.getElementById('store-finix-refund-local')
  if (!badge || !setupView || !configView) return

  if (config?.enabled) {
    badge.textContent = config.sandbox ? 'Demo' : 'Live'
    badge.className   = 'payment-status-badge badge-active'
    setupView.hidden  = true
    configView.hidden = false
    if (userDisp)     userDisp.textContent     = config.username   ?? ''
    if (merchantDisp) merchantDisp.textContent = config.merchantId ?? ''
    if (sandboxChk)   sandboxChk.checked       = !!config.sandbox
    if (refundLocalChk) refundLocalChk.checked = (config.refundMode ?? 'local') === 'local'
    updateTerminalEmuOption(!!config.sandbox)
  } else {
    badge.textContent = 'Not configured'
    badge.className   = 'payment-status-badge badge-inactive'
    setupView.hidden  = false
    configView.hidden = true
    updateTerminalEmuOption(false)
  }
}

/**
 * Bind all Finix provider-card interactions (save / remove / sandbox toggle).
 * Called once on page load.
 */
function initFinixUI() {
  // Save credentials
  document.getElementById('finix-save-btn')?.addEventListener('click', async () => {
    const username   = document.getElementById('finix-username-input')?.value.trim()
    const appId      = document.getElementById('finix-app-id-input')?.value.trim()
    const merchantId = document.getElementById('finix-merchant-id-input')?.value.trim()
    const password   = document.getElementById('finix-password-input')?.value.trim()
    const sandbox    = document.getElementById('finix-sandbox-input')?.checked ?? true

    if (!username || !appId || !merchantId || !password) {
      showToast('All four Finix fields are required', 'error')
      return
    }

    const btn = document.getElementById('finix-save-btn')
    btn.disabled = true
    btn.textContent = 'Saving…'

    try {
      // Store encrypted password; pos_merchant_id = "username:appId:merchantId"
      const keyRes = await api(`/api/merchants/${state.merchantId}/keys`, {
        method: 'POST',
        body: JSON.stringify({
          keyType:       'payment',
          provider:      'finix',
          apiKey:        password,
          posMerchantId: `${username}:${appId}:${merchantId}`,
        }),
      })
      if (!keyRes.ok) {
        const err = await keyRes.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${keyRes.status}`)
      }

      // Save sandbox flag
      await api(`/api/merchants/${state.merchantId}`, {
        method: 'PUT',
        body: JSON.stringify({ finixSandbox: sandbox }),
      })

      showToast('Finix credentials saved', 'success')
      await loadPaymentConfig()

      // Clear password for security
      const pwInput = document.getElementById('finix-password-input')
      if (pwInput) pwInput.value = ''
    } catch (err) {
      showToast(`Failed to save Finix credentials: ${err.message}`, 'error')
    } finally {
      btn.disabled = false
      btn.textContent = 'Save Finix credentials'
    }
  })

  // Sandbox toggle in configured view — auto-save
  document.getElementById('store-finix-sandbox')?.addEventListener('change', async (e) => {
    updateTerminalEmuOption(e.target.checked)
    try {
      await api(`/api/merchants/${state.merchantId}`, {
        method: 'PUT',
        body: JSON.stringify({ finixSandbox: e.target.checked }),
      })
      await loadPaymentConfig()
    } catch (err) {
      showToast(`Failed to update sandbox mode: ${err.message}`, 'error')
    }
  })

  // Refund mode toggle — checked = 'local' (accounting only), unchecked = 'api' (call Finix)
  document.getElementById('store-finix-refund-local')?.addEventListener('change', async (e) => {
    try {
      await api(`/api/merchants/${state.merchantId}`, {
        method: 'PUT',
        body: JSON.stringify({ finixRefundMode: e.target.checked ? 'local' : 'api' }),
      })
      await loadPaymentConfig()
      showToast(e.target.checked ? 'Refunds are now accounting-only' : 'Refunds will call Finix API', 'success')
    } catch (err) {
      showToast(`Failed to update refund mode: ${err.message}`, 'error')
    }
  })

  // Remove credentials
  document.getElementById('finix-remove-btn')?.addEventListener('click', async () => {
    if (!confirm('Remove Finix credentials? The Pay button will be disabled until you re-enter them.')) return
    try {
      const res = await api(
        `/api/merchants/${state.merchantId}/keys/finix?keyType=payment`,
        { method: 'DELETE' }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      showToast('Finix credentials removed', 'success')
      await loadPaymentConfig()
    } catch (err) {
      showToast(`Failed to remove credentials: ${err.message}`, 'error')
    }
  })
}

/**
 * Bind pay period type selector and break rule toggle.
 * Called once on page load.
 */
function initPayPeriodUI() {
  // Hide anchor date when semimonthly (no anchor needed)
  document.getElementById('store-pay-period-type')?.addEventListener('change', (e) => {
    const anchorRow = document.getElementById('pay-period-anchor-row')
    if (anchorRow) anchorRow.hidden = e.target.value === 'semimonthly'
  })

  // Toggle break rule detail panel
  document.getElementById('store-break-rule-enabled')?.addEventListener('change', (e) => {
    const detail = document.getElementById('break-rule-detail')
    if (detail) detail.hidden = !e.target.checked
  })
}

/**
 * Opens the Converge hosted payment page for an existing order (from the Orders tab).
 * Saves order info to sessionStorage and redirects the current tab to Converge.
 * On return, resumeAfterConvergePayment patches the order to 'paid'.
 *
 * @param {object} order - Order object from buildOrderCard
 */
function openConvergePaymentForOrder(order) {
  const name = order.customerName || 'Guest'
  const subtotalCents  = order.subtotalCents ?? order.totalCents ?? 0
  const discountCents  = order.discountCents ?? 0
  const discountLabel  = order.discountLabel ?? null
  const taxRate        = state.profile?.taxRate ?? 0
  const taxCents       = Math.round((subtotalCents - discountCents) * taxRate)

  openPaymentPreviewModal(
    { items: order.items ?? [], subtotalCents, taxCents, customerName: name, discountCents, discountLabel },
    async (tipCents) => {
      const grandCents = (subtotalCents - discountCents) + taxCents + tipCents

      const itemSummary = (order.items ?? [])
        .map((it) => `${it.quantity ?? 1}x ${it.dishName ?? it.name ?? ''}`)
        .join(', ')
      const memo = `${itemSummary} — ${name}`

      // Return URL: same tab redirects back to dashboard with hash
      const returnUrl = `${window.location.origin}/payment/converge/return`

      try {
        const res = await api(`/api/merchants/${state.merchantId}/payments/converge/session`, {
          method: 'POST',
          body: JSON.stringify({ amountCents: grandCents, memo, returnUrl }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${res.status}`)
        }
        const { url } = await res.json()

        sessionStorage.setItem('converge_pending_order', JSON.stringify({
          existingOrderId: order.id,
          customerName: name,
          customerEmail: order.customerEmail || '',
          customerPhone: order.customerPhone || '',
          paidAmountCents: grandCents,
        }))

        // Same-tab redirect (mirrors openStaxPaymentForOrder)
        window.location.href = url
      } catch (err) {
        showToast(`Could not open payment page: ${err.message}`, 'error')
      }
    }
  )
}

/**
 * Called on page load (same-tab return, #converge-paid) or via postMessage
 * (new-tab return).  Reads sessionStorage, patches/creates the order, cleans up.
 *
 * @param {object|null} result - postMessage data or null (reads sessionStorage)
 */
async function resumeAfterConvergePayment(result) {
  // For same-tab flow the result lives in sessionStorage (set by return page)
  if (!result) {
    try {
      const raw = sessionStorage.getItem('converge_payment_result')
      sessionStorage.removeItem('converge_payment_result')
      result = raw ? JSON.parse(raw) : null
    } catch { result = null }
  }

  const raw = sessionStorage.getItem('converge_pending_order')
  sessionStorage.removeItem('converge_pending_order')

  if (!result?.success) {
    const msg = result?.errorMessage ?? 'Payment was declined or cancelled'
    showToast(msg, 'error')
    showSection('orders')
    await loadOrders()
    return
  }

  if (!raw) {
    showToast('Payment complete — but order data was lost. Please re-enter the order manually.', 'error')
    showSection('orders')
    return
  }

  let saved
  try { saved = JSON.parse(raw) } catch {
    showSection('orders')
    return
  }

  const paidAmountCents = saved.paidAmountCents
    ?? (result.amount ? Math.round(parseFloat(result.amount) * 100) : undefined)

  const confirmMsg = result.amount
    ? `Payment of $${result.amount} confirmed for ${saved.customerName ?? 'Guest'}…`
    : `Payment confirmed for ${saved.customerName ?? 'Guest'}…`
  showToast(confirmMsg, 'success')

  // Converge ssl_txn_id — passed through so the refund path can use it later
  const convergeTxnId = result?.txnId || null

  // ── Paying an existing order ─────────────────────────────────────────────
  if (saved.existingOrderId) {
    try {
      const res = await api(`/api/merchants/${state.merchantId}/orders/${saved.existingOrderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'paid',
          paymentMethod: 'card',
          ...(paidAmountCents ? { paidAmountCents } : {}),
          ...(convergeTxnId ? { transferId: convergeTxnId } : {}),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      showToast('Order marked as paid!', 'success')
      showSection('orders')
      await loadOrders()
      if (paidAmountCents) showReceiptPrompt(saved.existingOrderId, paidAmountCents)
    } catch (err) {
      showToast(`Failed to mark order as paid: ${err.message}`, 'error')
      showSection('orders')
      await loadOrders()
    }
    return
  }

  // ── New order (from the cart) ────────────────────────────────────────────
  try {
    const items = (saved.cartState?.items ?? []).map((ci) => ({
      itemId:            ci.itemId,
      name:              ci.name,
      priceCents:        ci.priceCents,
      quantity:          ci.quantity,
      selectedModifiers: ci.modifiers ?? [],
    }))

    const body = {
      orderType:    saved.cartState?.orderType ?? 'pickup',
      customerName: saved.customerName ?? 'Guest',
      customerPhone: saved.customerPhone || undefined,
      customerEmail: saved.customerEmail || undefined,
      notes:         saved.notes || undefined,
      utensilsNeeded: !!saved.utensilsNeeded,
      tableLabel:    saved.tableLabel ?? undefined,
      roomLabel:     saved.roomLabel  ?? undefined,
      items,
      printLanguage: saved.printLanguage || 'en',
      paymentMethod: 'card',
      ...(paidAmountCents ? { paidAmountCents } : {}),
      ...(convergeTxnId ? { transferId: convergeTxnId } : {}),
    }

    const res = await api(`/api/merchants/${state.merchantId}/orders`, {
      method: 'POST',
      body:   JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json().catch(() => ({}))
    showToast('Order placed!', 'success')
    window.resetOrderEntry?.()
    showSection('orders')
    await loadOrders()
    if (paidAmountCents && data.orderId) showReceiptPrompt(data.orderId, paidAmountCents)
  } catch (err) {
    showToast(`Order submission failed: ${err.message}`, 'error')
    showSection('orders')
  }
}

function openStaxPayment() {
  const name = document.getElementById('cart-customer-name')?.value.trim()
  if (!name) {
    showToast('Enter a customer name before paying', 'error')
    document.getElementById('cart-customer-name')?.focus()
    return
  }
  if (cartState.items.length === 0) {
    showToast('Add at least one item', 'error')
    return
  }

  const token = state.profile?.staxToken
  if (!token) return

  const subtotalCents = cartState.items.reduce(
    (s, ci) => s + (ci.priceCents + ci.modifiers.reduce((ms, m) => ms + m.priceCents, 0)) * ci.quantity,
    0
  )
  const taxRate = state.profile?.taxRate ?? 0
  const taxCents = Math.round(subtotalCents * taxRate)
  const tipCents = Math.round(subtotalCents * (cartState.tipPercent ?? 0) / 100)
  const totalCents = subtotalCents + taxCents + tipCents
  const totalDollars = (totalCents / 100).toFixed(2)

  // Build memo: "<items> — <name>"
  const itemSummary = cartState.items.map(ci => `${ci.quantity}x ${ci.name}`).join(', ')
  const memo = `${itemSummary} — ${name}`

  const email = document.getElementById('cart-customer-email')?.value.trim() || ''

  // Split name into first/last for Stax customer matching
  const nameParts = name.trim().split(/\s+/)
  const firstName = nameParts[0] ?? ''
  const lastName = nameParts.slice(1).join(' ') || firstName

  // Redirect back to this dashboard page with a hash flag so we know payment completed
  const redirectUrl = `${window.location.origin}${window.location.pathname}#stax-paid`

  const params = new URLSearchParams({
    memo,
    total: totalDollars,
    r: redirectUrl,
    firstname: firstName,
    lastname: lastName,
    ...(email && { email }),
  })

  const staxUrl = `https://app.staxpayments.com/#/pay/${encodeURIComponent(token)}?${params.toString()}`

  // Snapshot cart state into sessionStorage so we can submit the order after redirect
  sessionStorage.setItem('stax_pending_order', JSON.stringify({
    cartState: {
      items: cartState.items,
      orderType: cartState.orderType,
      tipPercent: cartState.tipPercent,
    },
    customerName: name,
    customerEmail: document.getElementById('cart-customer-email')?.value.trim() || '',
    customerPhone: document.getElementById('cart-customer-phone')?.value.trim() || '',
    notes: document.getElementById('cart-notes')?.value.trim() || '',
    utensilsNeeded: document.getElementById('cart-utensils')?.getAttribute('aria-checked') === 'true',
  }))

  window.open(staxUrl, '_blank', 'noopener')
  showToast('Payment page opened — return here after paying to complete the order', 'info')
}

/**
 * Open the Stax hosted payment page for an already-created order.
 * On return, resumeAfterStaxPayment will PATCH the order to 'paid' instead of creating a new one.
 * @param {object} order - Order object from buildOrderCard
 */
/**
 * Show the payment preview modal (receipt + tip selector) before redirecting to Stax.
 *
 * @param {object} opts
 *   items          - array of order items (supports both order-entry and orders-tab shapes)
 *   subtotalCents  - pre-tax subtotal
 *   taxCents       - tax amount
 *   customerName   - display name
 *   orderType      - 'dine_in' | 'pickup' — pickup applies −5% to each tip tier
 * @param {function} onProceed  - called with tipCents when the user confirms
 */
function openPaymentPreviewModal({ items, subtotalCents, taxCents, customerName, orderType, discountCents = 0, discountLabel = null }, onProceed) {
  const modal    = document.getElementById('pay-preview-modal')
  const itemsEl  = document.getElementById('ppr-items')
  const subEl    = document.getElementById('ppr-subtotals')
  const tipBtns  = document.getElementById('ppr-tip-btns')
  const customEl = document.getElementById('ppr-custom-tip')
  const tipInput = document.getElementById('ppr-tip-input')
  const grandEl  = document.getElementById('ppr-grand-total')
  const confirmBtn = document.getElementById('pay-preview-confirm')
  const custEl   = document.getElementById('ppr-customer')
  if (!modal) return

  const baseTipOptions = state.profile?.tipOptions ?? [15, 20, 25]
  // Takeout orders get a −5% discount on each tier (minimum 0), deduplicated
  const tipOptions = orderType === 'pickup'
    ? [...new Set(baseTipOptions.map((p) => Math.max(0, p - 5)))]
    : baseTipOptions
  let tipCents = 0

  // ── Customer header ──────────────────────────────────────────────────────
  custEl.textContent = customerName || ''

  // ── Line items ───────────────────────────────────────────────────────────
  itemsEl.innerHTML = (items ?? []).map((it) => {
    const qty      = it.qty ?? it.quantity ?? 1
    const name     = it.name ?? it.dishName ?? ''
    const unitCents = it.priceCents ?? 0
    const paidMods = (it.modifiers ?? []).filter((m) => m.priceCents > 0)
    const modCents = paidMods.reduce((s, m) => s + m.priceCents, 0)
    const lineTotal = (unitCents + modCents) * qty
    const modHtml = paidMods
      .map((m) => `<li class="ppr-mod">+ ${escHtml(m.name)} <span>${formatPrice(m.priceCents)}</span></li>`)
      .join('')
    return `
      <li class="ppr-item">
        <span class="ppr-item-qty">${qty}×</span>
        <ul class="ppr-item-detail">
          <li class="ppr-item-name">${escHtml(name)}</li>
          ${modHtml}
        </ul>
        <span class="ppr-item-price">${formatPrice(lineTotal)}</span>
      </li>`
  }).join('')

  // ── Subtotal / discount / tax (static) ───────────────────────────────────
  const discountedSubtotal = subtotalCents - discountCents
  const discountLine = discountCents > 0
    ? `<div class="ppr-row ppr-discount-row">
         <span>Discount${discountLabel ? ` · ${escHtml(discountLabel)}` : ''}</span>
         <span>−${formatPrice(discountCents)}</span>
       </div>`
    : ''
  subEl.innerHTML = `
    <div class="ppr-row"><span>Subtotal</span><span>${formatPrice(subtotalCents)}</span></div>
    ${discountLine}
    <div class="ppr-row"><span>Tax</span><span>${formatPrice(taxCents)}</span></div>`

  // ── Tip + grand total (reactive) ─────────────────────────────────────────
  // Grand total uses the discounted subtotal; tip base is anchored to the
  // original (pre-discount) subtotal + original tax, so discounts don't
  // reduce what the customer tips on.
  const refreshTotal = () => {
    const grand = discountedSubtotal + taxCents + tipCents
    const tipLine = tipCents > 0
      ? `<div class="ppr-row ppr-tip-row"><span>Tip</span><span>${formatPrice(tipCents)}</span></div>`
      : ''
    grandEl.innerHTML = `${tipLine}<div class="ppr-row ppr-grand"><span>Total</span><span>${formatPrice(grand)}</span></div>`
    confirmBtn.textContent = `Pay ${formatPrice(grand)}`
  }

  const activateBtn = (el) => tipBtns.querySelectorAll('.ppr-tip-opt').forEach((b) => b.classList.toggle('active', b === el))

  // Tips anchored to original pre-discount total so discounts don't affect tip suggestions
  const taxRate      = state.profile?.taxRate ?? 0
  const originalTax  = Math.round(subtotalCents * taxRate)
  const tipBase      = subtotalCents + originalTax
  tipBtns.innerHTML = [
    `<button type="button" class="ppr-tip-opt active" data-mode="none">No tip</button>`,
    ...tipOptions.map((pct) => {
      const amt = Math.round(tipBase * pct / 100)
      return `<button type="button" class="ppr-tip-opt" data-mode="pct" data-amt="${amt}">${pct}%&ensp;${formatPrice(amt)}</button>`
    }),
    `<button type="button" class="ppr-tip-opt" data-mode="custom">Custom</button>`,
  ].join('')

  tipBtns.querySelectorAll('.ppr-tip-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode
      customEl.hidden = mode !== 'custom'
      if (mode === 'none')     tipCents = 0
      else if (mode === 'pct') tipCents = parseInt(btn.dataset.amt, 10)
      else                     tipCents = Math.round(parseFloat(tipInput.value || '0') * 100)
      activateBtn(btn)
      refreshTotal()
    })
  })

  tipInput.oninput = () => {
    tipCents = Math.round(parseFloat(tipInput.value || '0') * 100)
    refreshTotal()
  }

  // Reset tip state
  tipCents = 0
  customEl.hidden = true
  tipInput.value = ''
  refreshTotal()

  // ── Show modal ────────────────────────────────────────────────────────────
  modal.hidden = false
  modal.querySelector('.ppr-inner').scrollTop = 0

  const close = () => { modal.hidden = true }
  document.getElementById('pay-preview-close').onclick  = close
  document.getElementById('pay-preview-cancel').onclick = close
  modal.onclick = (e) => { if (e.target === modal) close() }

  confirmBtn.onclick = () => {
    close()
    onProceed(tipCents)
  }
}
window.openPaymentPreviewModal = openPaymentPreviewModal

// ---------------------------------------------------------------------------
// Finix Checkout Pages (redirect flow — mirrors Converge)
// ---------------------------------------------------------------------------

/**
 * Opens the Finix Checkout Page for an existing order (from the Orders tab).
 * Saves order info to sessionStorage and redirects to the Finix hosted page.
 * On return, resumeAfterFinixPayment patches the order to 'paid'.
 *
 * @param {object} order - Order object from buildOrderCard
 */
function openFinixPaymentForOrder(order) {
  const name = order.customerName || 'Guest'
  const subtotalCents  = order.subtotalCents ?? order.totalCents ?? 0
  const discountCents  = order.discountCents ?? 0
  const discountLabel  = order.discountLabel ?? null
  const taxRate        = state.profile?.taxRate ?? 0
  const taxCents       = Math.round((subtotalCents - discountCents) * taxRate)

  openPaymentPreviewModal(
    { items: order.items ?? [], subtotalCents, taxCents, customerName: name, discountCents, discountLabel },
    async (tipCents) => {
      const grandCents = (subtotalCents - discountCents) + taxCents + tipCents

      const itemSummary = (order.items ?? [])
        .map((it) => `${it.quantity ?? 1}x ${it.dishName ?? it.name ?? ''}`)
        .join(', ')
      const memo = `${itemSummary} — ${name}`

      const returnUrl = `${window.location.origin}/payment/finix/return`

      try {
        const res = await api(`/api/merchants/${state.merchantId}/payments/finix/checkout`, {
          method: 'POST',
          body: JSON.stringify({ amountCents: grandCents, customerName: name, memo, returnUrl }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `HTTP ${res.status}`)
        }
        const { url, checkoutFormId } = await res.json()

        sessionStorage.setItem('finix_pending_order', JSON.stringify({
          existingOrderId: order.id,
          customerName: name,
          customerEmail: order.customerEmail || '',
          customerPhone: order.customerPhone || '',
          paidAmountCents: grandCents,
          checkoutFormId,
        }))

        // Same-tab redirect (mirrors Converge flow)
        window.location.href = url
      } catch (err) {
        showToast(`Could not open payment page: ${err.message}`, 'error')
      }
    }
  )
}

/**
 * Opens the Finix Checkout Page for a new order from Order Entry.
 * Called by the order-entry module when Finix is the payment provider.
 *
 * @param {object} opts
 * @param {number}  opts.amountCents      - Total to charge (including tip)
 * @param {string}  [opts.customerName]   - Customer name
 * @param {string}  [opts.memo]           - Description
 * @param {string}  [opts.existingOrderId] - If set, patches the order to paid after charge
 * @param {object}  [opts.orderData]      - New-order payload (cartState, etc.) if not existingOrderId
 * @param {Function} [opts.onSuccess]     - Called after a successful charge
 */
async function openFinixPaymentModal(opts = {}) {
  const { amountCents, customerName = 'Guest', memo = '', existingOrderId, orderData, onSuccess } = opts

  const returnUrl = `${window.location.origin}/payment/finix/return`

  try {
    const res = await api(`/api/merchants/${state.merchantId}/payments/finix/checkout`, {
      method: 'POST',
      body: JSON.stringify({ amountCents, customerName, memo, returnUrl }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const { url, checkoutFormId } = await res.json()

    // Save pending order data so we can reconcile on return
    sessionStorage.setItem('finix_pending_order', JSON.stringify({
      existingOrderId: existingOrderId || null,
      orderData: orderData || null,
      customerName,
      paidAmountCents: amountCents,
      hasOnSuccess: typeof onSuccess === 'function',
      checkoutFormId,
    }))

    // Same-tab redirect to Finix hosted payment page
    window.location.href = url
  } catch (err) {
    showToast(`Could not open payment page: ${err.message}`, 'error')
  }
}
window.openFinixPaymentModal = openFinixPaymentModal

/**
 * Called on page load (same-tab return, #finix-paid) or via postMessage
 * (new-tab return). Reads sessionStorage, patches/creates the order, cleans up.
 *
 * @param {object|null} result - postMessage data or null (reads sessionStorage)
 */
async function resumeAfterFinixPayment(result) {
  // For same-tab flow the result lives in sessionStorage (set by return page)
  if (!result) {
    try {
      const raw = sessionStorage.getItem('finix_payment_result')
      sessionStorage.removeItem('finix_payment_result')
      result = raw ? JSON.parse(raw) : null
    } catch { result = null }
  }

  const raw = sessionStorage.getItem('finix_pending_order')
  sessionStorage.removeItem('finix_pending_order')

  if (!result?.success) {
    const msg = result?.errorMessage ?? 'Payment was declined or cancelled'
    showToast(msg, 'error')
    showSection('orders')
    await loadOrders()
    return
  }

  if (!raw) {
    showToast('Payment complete — but order data was lost. Please re-enter the order manually.', 'error')
    showSection('orders')
    return
  }

  let saved
  try { saved = JSON.parse(raw) } catch {
    showSection('orders')
    return
  }

  const paidAmountCents = saved.paidAmountCents

  const confirmMsg = paidAmountCents
    ? `Payment of $${(paidAmountCents / 100).toFixed(2)} confirmed for ${saved.customerName ?? 'Guest'}`
    : `Payment confirmed for ${saved.customerName ?? 'Guest'}`
  showToast(confirmMsg, 'success')

  // ── Paying an existing order ─────────────────────────────────────────────
  const cfId = saved.checkoutFormId || result?.checkoutFormId || null
  if (saved.existingOrderId) {
    try {
      const res = await api(`/api/merchants/${state.merchantId}/orders/${saved.existingOrderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'paid',
          paymentMethod: 'card',
          ...(paidAmountCents ? { paidAmountCents } : {}),
          ...(cfId ? { checkoutFormId: cfId } : {}),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      showToast('Order marked as paid!', 'success')
      showSection('orders')
      await loadOrders()
      if (paidAmountCents) showReceiptPrompt(saved.existingOrderId, paidAmountCents)
    } catch (err) {
      showToast(`Failed to mark order as paid: ${err.message}`, 'error')
      showSection('orders')
      await loadOrders()
    }
    return
  }

  // ── Creating a new order after payment ───────────────────────────────────
  if (saved.orderData) {
    try {
      const orderRes = await api(`/api/merchants/${state.merchantId}/orders`, {
        method: 'POST',
        body: JSON.stringify({ ...saved.orderData, paidAmountCents, paymentMethod: 'card', ...(cfId ? { checkoutFormId: cfId } : {}) }),
      })
      if (!orderRes.ok) {
        const err = await orderRes.json().catch(() => ({}))
        showToast(`Payment succeeded but order creation failed: ${err.error ?? 'Unknown error'}`, 'error')
      } else {
        window.resetOrderEntry?.()
      }
    } catch (err) {
      showToast(`Payment succeeded but order creation failed: ${err.message}`, 'error')
    }
    showSection('orders')
    await loadOrders()
    return
  }

  // Fallback: just refresh orders
  showSection('orders')
  await loadOrders()
}

/**
 * Open Stax payment page for an already-created order (from the Orders tab).
 * Shows the payment preview modal first.
 */
function openStaxPaymentForOrder(order) {
  const token = state.profile?.staxToken
  if (!token) {
    showToast('Stax payment not configured', 'error')
    return
  }

  const name = order.customerName || 'Guest'
  const subtotalCents  = order.subtotalCents ?? order.totalCents ?? 0
  const discountCents  = order.discountCents ?? 0
  const discountLabel  = order.discountLabel ?? null
  // tax_cents is stored as 0 in the DB (POS handles tax); recalculate from merchant profile
  const taxRate        = state.profile?.taxRate ?? 0
  const taxCents       = Math.round((subtotalCents - discountCents) * taxRate)

  openPaymentPreviewModal(
    { items: order.items ?? [], subtotalCents, taxCents, customerName: name, discountCents, discountLabel },
    (tipCents) => {
      const grandCents  = (subtotalCents - discountCents) + taxCents + tipCents
      const totalDollars = (grandCents / 100).toFixed(2)

      const itemSummary = (order.items ?? [])
        .map((it) => `${it.quantity ?? 1}x ${it.dishName ?? it.name ?? ''}`)
        .join(', ')
      const nameParts = name.trim().split(/\s+/)
      const firstName = nameParts[0] ?? ''
      const lastName  = nameParts.slice(1).join(' ') || firstName

      const redirectUrl = `${window.location.origin}${window.location.pathname}#stax-paid`
      const params = new URLSearchParams({
        memo: `${itemSummary} — ${name}`,
        total: totalDollars,
        r: redirectUrl,
        firstname: firstName,
        lastname: lastName,
        ...(order.customerEmail ? { email: order.customerEmail } : {}),
      })

      sessionStorage.setItem('stax_pending_order', JSON.stringify({
        existingOrderId: order.id,
        cartState: {
          items: (order.items ?? []).map((it) => ({
            itemId: it.itemId ?? '',
            name: it.dishName ?? it.name ?? '',
            priceCents: it.priceCents ?? 0,
            quantity: it.quantity ?? 1,
            modifiers: it.modifiers ?? [],
          })),
          orderType: order.orderType,
        },
        customerName: name,
        customerEmail: order.customerEmail || '',
        customerPhone: order.customerPhone || '',
        notes: order.notes || '',
        utensilsNeeded: order.utensilsNeeded ?? false,
        tableLabel: order.tableLabel ?? null,
        roomLabel: order.roomLabel ?? null,
        printLanguage: 'en',
      }))

      window.location.href = `https://app.staxpayments.com/#/pay/${encodeURIComponent(token)}?${params.toString()}`
    }
  )
}

// ---------------------------------------------------------------------------
// CASH PAYMENT
// ---------------------------------------------------------------------------

/**
 * Returns suggested cash tender amounts (in whole dollars) for the given total.
 * All returned amounts are strictly greater than the total.
 *
 * Ranges:
 *   total < $20          → [$20, $50]
 *   $20 ≤ total < $30    → [$30, $40, $50]
 *   $30 ≤ total < $40    → [$40, $50]
 *   $40 ≤ total < $50    → [$50, $100]
 *   $50 ≤ total < $100   → [$100]
 *   $100 ≤ total         → [next $100 multiple, next + $100]
 *
 * @param {number} totalCents
 * @returns {number[]} dollar amounts
 */
function getCashOptions(totalCents) {
  const total = totalCents / 100
  if (total < 20)  return [20, 50]
  if (total < 30)  return [30, 40, 50]
  if (total < 40)  return [40, 50]
  if (total < 50)  return [50, 100]
  if (total < 100) return [100]
  const next = Math.ceil((total + 0.01) / 100) * 100
  return next + 100 <= 1000 ? [next, next + 100] : [next]
}

/**
 * Opens the cash payment modal for an existing order.
 * Server selects the bill denomination → change is shown → confirm marks the order paid.
 * @param {object} order - Order object with id and totalCents
 */
function openCashPaymentModal(order) {
  const modal      = document.getElementById('cash-pay-modal')
  const itemsEl    = document.getElementById('cash-pay-items')
  const subtotalsEl = document.getElementById('cash-pay-subtotals')
  const grandEl    = document.getElementById('cash-pay-grand')
  const custEl     = document.getElementById('cash-pay-customer')
  const billsEl    = document.getElementById('cash-pay-bills')
  const changeRow  = document.getElementById('cash-pay-change-row')
  const changeAmt  = document.getElementById('cash-pay-change-amount')
  if (!modal) return

  const subtotalCents  = order.subtotalCents ?? 0
  const discountCents  = order.discountCents ?? 0
  const discountLabel  = order.discountLabel ?? null
  // tax_cents is stored as 0 in the DB; recalculate from merchant profile on discounted subtotal
  const taxRate        = state.profile?.taxRate ?? 0
  const taxCents       = Math.round((subtotalCents - discountCents) * taxRate)
  const totalCents     = (subtotalCents - discountCents) + taxCents

  // ── Customer name ─────────────────────────────────────────────────────────
  custEl.textContent = order.customerName || ''

  // ── Line items ────────────────────────────────────────────────────────────
  itemsEl.innerHTML = (order.items ?? []).map((it) => {
    const qty       = it.qty ?? it.quantity ?? 1
    const name      = it.name ?? it.dishName ?? ''
    const unitCents = it.priceCents ?? 0
    const paidMods  = (it.modifiers ?? it.selectedModifiers ?? []).filter((m) => m.priceCents > 0)
    const modCents  = paidMods.reduce((s, m) => s + m.priceCents, 0)
    const lineTotal = (unitCents + modCents) * qty
    const modHtml   = paidMods
      .map((m) => `<li class="ppr-mod">+ ${escHtml(m.name)} <span>${formatPrice(m.priceCents)}</span></li>`)
      .join('')
    return `
      <li class="ppr-item">
        <span class="ppr-item-qty">${qty}×</span>
        <ul class="ppr-item-detail">
          <li class="ppr-item-name">${escHtml(name)}</li>
          ${modHtml}
        </ul>
        <span class="ppr-item-price">${formatPrice(lineTotal)}</span>
      </li>`
  }).join('')

  // ── Subtotal / discount / tax ─────────────────────────────────────────────
  const cashDiscountLine = discountCents > 0
    ? `<div class="ppr-row ppr-discount-row">
         <span>Discount${discountLabel ? ` · ${escHtml(discountLabel)}` : ''}</span>
         <span>−${formatPrice(discountCents)}</span>
       </div>`
    : ''
  subtotalsEl.innerHTML = `
    <div class="ppr-row"><span>Subtotal</span><span>${formatPrice(subtotalCents)}</span></div>
    ${cashDiscountLine}
    <div class="ppr-row"><span>Tax</span><span>${formatPrice(taxCents)}</span></div>`

  grandEl.innerHTML = `<div class="ppr-row ppr-grand"><span>Total</span><span>${formatPrice(totalCents)}</span></div>`

  // Reset change display
  changeRow.hidden = true
  changeAmt.textContent = ''

  // Fresh buttons via clone-replace to avoid stale listeners
  const oldCancel  = document.getElementById('cash-pay-cancel')
  const oldConfirm = document.getElementById('cash-pay-confirm')
  const newCancel  = oldCancel.cloneNode(true)
  const newConfirm = oldConfirm.cloneNode(true)
  oldCancel.parentNode.replaceChild(newCancel, oldCancel)
  oldConfirm.parentNode.replaceChild(newConfirm, oldConfirm)

  newConfirm.disabled = true
  newConfirm.style.cssText = 'background:#16a34a;color:#fff;border:1px solid #16a34a;opacity:0.35'

  newCancel.addEventListener('click', () => { modal.hidden = true })
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true }

  // Build bill denomination buttons
  let selectedCents = 0
  billsEl.innerHTML = ''
  getCashOptions(totalCents).forEach((dollars) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cash-pay-bill-btn'
    btn.textContent = `$${dollars}`
    btn.addEventListener('click', () => {
      billsEl.querySelectorAll('.cash-pay-bill-btn').forEach((b) => b.classList.remove('selected'))
      btn.classList.add('selected')
      selectedCents = dollars * 100
      changeAmt.textContent = formatPrice(selectedCents - totalCents)
      changeRow.hidden = false
      newConfirm.disabled = false
      newConfirm.style.opacity = '1'
    })
    billsEl.appendChild(btn)
  })

  newConfirm.addEventListener('click', async () => {
    if (!selectedCents) return
    newConfirm.disabled = true
    newConfirm.style.opacity = '0.6'
    try {
      const res = await api(`/api/merchants/${state.merchantId}/orders/${order.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'paid', paymentMethod: 'cash', paidAmountCents: totalCents }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      modal.hidden = true
      showToast(`Paid · Change: ${formatPrice(selectedCents - totalCents)}`, 'success')
      loadOrders()
    } catch (err) {
      showToast(err.message || 'Payment failed', 'error')
      newConfirm.disabled = false
      newConfirm.style.opacity = '1'
    }
  })

  modal.hidden = false
}

/**
 * Show the receipt prompt modal after a card payment.
 * Server asks customer if they want a receipt; taps "Print Receipt" if yes.
 * @param {string} orderId
 * @param {number} paidAmountCents
 */
function showReceiptPrompt(orderId, paidAmountCents) {
  const modal = document.getElementById('receipt-prompt-modal')
  if (!modal) return

  const printBtn = document.getElementById('receipt-prompt-print')
  const skipBtn = document.getElementById('receipt-prompt-skip')
  if (!printBtn || !skipBtn) return

  const newPrint = printBtn.cloneNode(true)
  const newSkip = skipBtn.cloneNode(true)
  printBtn.replaceWith(newPrint)
  skipBtn.replaceWith(newSkip)

  newSkip.addEventListener('click', () => {
    modal.hidden = true
  })

  newPrint.addEventListener('click', async () => {
    newPrint.disabled = true
    newPrint.textContent = 'Printing…'
    try {
      const res = await api(`/api/merchants/${state.merchantId}/orders/${orderId}/print-receipt`, {
        method: 'POST',
        body: JSON.stringify({ paidAmountCents }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Print failed')
      }
      showToast('Receipt printed', 'success')
    } catch (err) {
      showToast(`Receipt print failed: ${err.message}`, 'error')
      newPrint.disabled = false
      newPrint.textContent = '🧾 Print Receipt'
      return
    }
    modal.hidden = true
  })

  modal.hidden = false
}

/**
 * Load an existing order into the Order Entry tab for editing.
 * @param {object} order - order object from buildOrderCard
 */
async function reopenOrder(order) {
  // Client-side guard: can't open another order while already editing one.
  // Exception: reopening the same order (e.g. to adjust after starting a payment) is allowed.
  if (typeof window.isEditingOrder === 'function' && window.isEditingOrder()) {
    const currentId = typeof window.getEditingOrderId === 'function' ? window.getEditingOrderId() : null
    if (currentId !== order.id) {
      window.showToast('Finish or cancel the current order first.', 'error')
      return
    }
  }

  // Server-side lock: prevent two tablets editing the same order
  const merchantId = state.merchantId
  const employeeId = window.currentEmployee?.id
  const employeeName = window.currentEmployee?.nickname || 'Unknown'
  if (merchantId && employeeId) {
    try {
      const res = await window.api(`/api/merchants/${merchantId}/orders/${order.id}/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, employeeName }),
      })
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}))
        window.showToast(`Order is being edited by ${data.lockedBy || 'someone else'}.`, 'error')
        return
      }
    } catch (err) {
      // Lock service unavailable — proceed anyway (server TTL is safety net)
    }
  }

  showSection('order')
  // Ensure menu is loaded before populating the cart — loadMenu() is async
  // and showSection only fires it; without awaiting, tapping a cart item
  // before the fetch completes causes a silent "can't find menu item" failure.
  if (!state.menu) await loadMenu()
  if (typeof window.loadOrderIntoEntry === 'function') {
    window.loadOrderIntoEntry(order)
  }
}

/**
 * Delete an order after confirmation.
 * @param {string} orderId
 * @param {HTMLElement} card - the order card element to remove from DOM
 * @param {HTMLElement} triggerBtn
 */
async function deleteOrder(orderId, card, triggerBtn) {
  if (!confirm('Delete this order? This cannot be undone.')) return

  triggerBtn.disabled = true
  triggerBtn.textContent = 'Deleting…'

  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders/${orderId}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    card.remove()
    showToast('Order deleted', 'success')
  } catch (err) {
    showToast(err.message || 'Failed to delete order', 'error')
    triggerBtn.disabled = false
    triggerBtn.textContent = '🗑️ Delete'
  }
}

async function placeOrder() {
  const name = document.getElementById('cart-customer-name')?.value.trim()
  if (!name) {
    showToast('Customer name is required', 'error')
    document.getElementById('cart-customer-name')?.focus()
    return
  }
  if (cartState.items.length === 0) {
    showToast('Add at least one item', 'error')
    return
  }

  const btn = document.getElementById('cart-place-btn')
  if (btn) { btn.disabled = true; btn.textContent = 'Placing…' }

  const subtotalCents = cartState.items.reduce(
    (s, ci) => s + (ci.priceCents + ci.modifiers.reduce((ms, m) => ms + m.priceCents, 0)) * ci.quantity,
    0
  )
  const taxRate = state.profile?.taxRate ?? 0
  const taxCents = Math.round(subtotalCents * taxRate)
  const tipCents = Math.round(subtotalCents * (cartState.tipPercent ?? 0) / 100)

  const payload = {
    orderType: cartState.orderType,
    customerName: name,
    customerEmail: document.getElementById('cart-customer-email')?.value.trim() || undefined,
    customerPhone: document.getElementById('cart-customer-phone')?.value.trim() || undefined,
    notes: document.getElementById('cart-notes')?.value.trim() || undefined,
    utensilsNeeded: document.getElementById('cart-utensils')?.getAttribute('aria-checked') === 'true',
    taxCents,
    tipCents,
    totalCents: subtotalCents + taxCents + tipCents,
    items: cartState.items.map((ci) => ({
      itemId: ci.itemId,
      name: ci.name,
      priceCents: ci.priceCents,
      quantity: ci.quantity,
      selectedModifiers: ci.modifiers,
      specialInstructions: ci.specialInstructions || undefined,
    })),
  }

  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to place order')
    }
    const data = await res.json()
    showToast(`Order #${data.orderId.slice(-6).toUpperCase()} placed — ${formatPrice(data.totalCents)}`, 'success')

    // Clear cart and fields
    cartState.items = []
    cartState.orderType = 'dine_in'
    cartState.tipPercent = null
    const tipContainer = document.getElementById('cart-tip-options')
    if (tipContainer) delete tipContainer.dataset.wired
    closeCartCustomizer()
    renderCart()
    const clearField = (id) => { const el = document.getElementById(id); if (el) el.value = '' }
    clearField('cart-customer-name')
    clearField('cart-customer-email')
    clearField('cart-customer-phone')
    clearField('cart-notes')
    document.getElementById('cart-utensils')?.setAttribute('aria-checked', 'false')
    document.querySelectorAll('.cart-type-btn').forEach((b, i) => {
      b.classList.toggle('active', i === 0)
      b.setAttribute('aria-pressed', String(i === 0))
    })

    // Refresh orders tab if it was loaded
    if (state.activeSection === 'orders') loadOrders()
  } catch (err) {
    showToast(err.message || 'Failed to place order', 'error')
  } finally {
    if (btn) { btn.disabled = cartState.items.length === 0; btn.textContent = 'Place Order' }
  }
}

// ---------------------------------------------------------------------------
// Orders section
// ---------------------------------------------------------------------------

/** Ephemeral orders UI state */
const ordersState = {
  /** Epoch ms for current range */
  fromMs: null,
  toMs: null,
  activePreset: 'today',
  /** Active source tab: 'in-store' | 'online' | 'payments' */
  activeTab: 'in-store',
  /** Unfiltered orders from API (used for tab filtering) */
  allOrders: [],
}

/** True when at least one unmatched payment has been flagged this session */
let _paymentsAlertPending = false

function initOrders() {
  // Preset buttons
  document.querySelectorAll('.date-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.date-preset-btn').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      ordersState.activePreset = btn.dataset.preset
      applyPreset(btn.dataset.preset)
      loadOrders()
    })
  })

  // Custom date range apply
  document.getElementById('orders-custom-apply').addEventListener('click', () => {
    const from = document.getElementById('orders-from').value
    const to = document.getElementById('orders-to').value
    if (!from || !to) { showToast('Please select both dates', 'error'); return }
    ordersState.fromMs = new Date(from).getTime()
    ordersState.toMs = new Date(to).getTime() + 86399999 // end of day
    ordersState.activePreset = 'custom'
    document.querySelectorAll('.date-preset-btn').forEach((b) => b.classList.remove('active'))
    loadOrders()
  })

  // Sync button
  document.getElementById('sync-orders-btn').addEventListener('click', syncOrdersFromClover)

  // Order source tabs
  document.querySelectorAll('.orders-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.orders-tab').forEach((t) => {
        t.classList.remove('active')
        t.setAttribute('aria-selected', 'false')
      })
      tab.classList.add('active')
      tab.setAttribute('aria-selected', 'true')
      ordersState.activeTab = tab.dataset.tab

      const isPaymentsTab = ordersState.activeTab === 'payments'
      const isOnlineTab   = ordersState.activeTab === 'online'
      // Toggle the orders UI vs. the payments panel
      document.getElementById('orders-summary').hidden = isPaymentsTab
      document.getElementById('orders-list').hidden    = isPaymentsTab
      document.getElementById('orders-loading').hidden = isPaymentsTab
      document.getElementById('orders-empty').hidden   = isPaymentsTab
      document.getElementById('payments-panel').hidden = !isPaymentsTab
      document.getElementById('gc-purchases-section').hidden = !isOnlineTab

      if (isPaymentsTab) {
        // Clear alert badge when user opens the tab
        _paymentsAlertPending = false
        const badge = document.getElementById('payments-alert-badge')
        if (badge) badge.hidden = true
        loadPayments()
      } else {
        renderFilteredOrders()
      }
    })
  })

  // Set default range: today
  applyPreset('today')
}

function applyPreset(preset) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  if (preset === 'today') {
    ordersState.fromMs = todayStart
    ordersState.toMs = Date.now()
  } else if (preset === 'yesterday') {
    ordersState.fromMs = todayStart - 86400000
    ordersState.toMs = todayStart - 1
  } else if (preset === 'week') {
    ordersState.fromMs = todayStart - 6 * 86400000
    ordersState.toMs = Date.now()
  }
}

function showOrdersState(s) {
  document.getElementById('orders-loading').hidden = s !== 'loading'
  document.getElementById('orders-empty').hidden = s !== 'empty'
  document.getElementById('orders-list').hidden = s !== 'content'
  document.getElementById('orders-summary').hidden = s !== 'content'
}

async function loadOrders() {
  // Delegate to the payments loader when that tab is active
  if (ordersState.activeTab === 'payments') { await loadPayments(); return }

  // Re-apply rolling presets so 'today' and 'week' always reflect current time
  if (ordersState.activePreset !== 'custom') applyPreset(ordersState.activePreset)

  showOrdersState('loading')

  try {
    const url = `/api/merchants/${state.merchantId}/orders` +
      `?from=${ordersState.fromMs}&to=${ordersState.toMs}`
    const res = await api(url)
    if (!res.ok) throw new Error('Failed to load orders')
    const data = await res.json()
    ordersState.allOrders = data.orders
    renderFilteredOrders()
    // gc-purchases-section visibility is toggled by renderFilteredOrders via loadGiftCardPurchases()
  } catch (err) {
    showOrdersState('empty')
    showToast(err.message || 'Failed to load orders', 'error')
  }
}

/**
 * Filter orders by active source tab and render.
 */
function renderFilteredOrders() {
  if (ordersState.activeTab === 'payments') return   // handled by loadPayments()
  const all = ordersState.allOrders
  const isOnlineTab = ordersState.activeTab === 'online'

  const filtered = all.filter((o) => {
    const isOnline = o.source === 'online'
    return isOnlineTab ? isOnline : !isOnline
  })

  // Update online orders badge
  const onlineActive = all.filter((o) => {
    const isTerminal = ['picked_up', 'completed', 'cancelled', 'paid'].includes(o.status)
    return o.source === 'online' && !isTerminal
  })
  const badge = document.getElementById('online-orders-badge')
  if (badge) {
    badge.textContent = String(onlineActive.length)
    badge.hidden = onlineActive.length === 0
  }

  renderOrders(filtered)

  if (isOnlineTab) loadGiftCardPurchases()
}

// ---------------------------------------------------------------------------
// Gift card purchases (Online Orders tab)
// ---------------------------------------------------------------------------

async function loadGiftCardPurchases() {
  if (!state.merchantId) return
  const loadingEl = document.getElementById('gc-purchases-loading')
  const emptyEl   = document.getElementById('gc-purchases-empty')
  const listEl    = document.getElementById('gc-purchases-list')
  if (!loadingEl || !emptyEl || !listEl) return

  loadingEl.hidden = false
  emptyEl.hidden   = true
  listEl.hidden    = true

  try {
    const from = ordersState.fromMs ?? new Date().setHours(0, 0, 0, 0)
    const to   = ordersState.toMs   ?? Date.now()
    const res  = await api(`/api/merchants/${state.merchantId}/gift-card-purchases?from=${from}&to=${to}`)
    if (!res.ok) throw new Error('Failed to load gift card sales')
    const { purchases } = await res.json()

    loadingEl.hidden = true
    if (!purchases.length) {
      emptyEl.hidden = false
      return
    }

    listEl.innerHTML = ''
    for (const p of purchases) {
      const timeStr  = p.createdAt
        ? new Date(p.createdAt.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—'
      const totalStr = `$${(p.totalCents / 100).toFixed(2)}`
      const cardDesc = (p.lineItems ?? [])
        .map((li) => `${li.qty > 1 ? li.qty + '× ' : ''}$${(li.denominationCents / 100).toFixed(0)} gift card`)
        .join(', ') || 'Gift card'

      const row = document.createElement('div')
      row.className = 'pay-row'
      row.dataset.gcpId = p.id
      row.title = 'Click to view purchase'
      row.style.cursor = 'pointer'
      row.innerHTML =
        `<span class="pay-time">${timeStr}</span>` +
        `<span class="pay-customer">${escHtml(p.customerName || '—')}</span>` +
        `<span class="pay-type">🎁 ${escHtml(cardDesc)}</span>` +
        `<span class="pay-order-type">Online</span>` +
        `<span class="pay-amount">${totalStr}</span>` +
        `<span class="pay-status-cell"><span class="pay-status pay-status--matched">✓ Paid</span></span>`

      row.addEventListener('click', () => openGiftCardPurchaseModal(p.id))
      listEl.appendChild(row)
    }
    listEl.hidden = false
  } catch (err) {
    loadingEl.hidden = true
    emptyEl.hidden   = false
    console.error('[gift-card-purchases]', err)
  }
}

async function openGiftCardPurchaseModal(purchaseId) {
  const overlay = document.getElementById('order-detail-overlay')
  const body    = document.getElementById('order-detail-body')
  if (!overlay || !body) return

  body.innerHTML = '<p class="od-loading">Loading…</p>'
  overlay.hidden = false

  // Hide receipt/email/link controls — not applicable for gift card purchases
  ;['od-print-receipt-btn', 'od-email-row', 'od-link-row'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.hidden = true
  })

  try {
    const res = await api(`/api/merchants/${state.merchantId}/gift-card-purchases/${purchaseId}`)
    if (!res.ok) throw new Error(`Server error ${res.status}`)
    const { purchase, cards } = await res.json()

    const dateStr = purchase.createdAt
      ? new Date(purchase.createdAt.replace(' ', 'T') + 'Z')
          .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—'

    let html = `<div class="od-meta">
      <span><strong>${escHtml(purchase.customerName || 'Unknown')}</strong></span>
      ${purchase.customerEmail ? `<span>${escHtml(purchase.customerEmail)}</span>` : ''}
      ${purchase.recipientName ? `<span>For: ${escHtml(purchase.recipientName)}</span>` : ''}
      <span>Online Gift Card Sale</span>
      <span>${dateStr}</span>
    </div>`

    // Line items
    const lineItems = purchase.lineItems ?? []
    if (lineItems.length) {
      html += `<table class="od-items"><thead><tr><th>Item</th><th style="text-align:right">Amount</th></tr></thead><tbody>`
      for (const li of lineItems) {
        html += `<tr><td>${li.qty > 1 ? li.qty + ' × ' : ''}$${(li.denominationCents / 100).toFixed(0)} Gift Card</td><td>${formatPrice(li.denominationCents * li.qty)}</td></tr>`
      }
      html += '</tbody></table>'
    }

    // Totals
    html += `<table class="od-totals"><tbody>`
    html += `<tr><td>Subtotal (net)</td><td>${formatPrice(purchase.netRevenueCents)}</td></tr>`
    html += `<tr><td>Tax (embedded)</td><td>${formatPrice(purchase.taxEmbeddedCents)}</td></tr>`
    html += `<tr class="od-total-row"><td>Total</td><td>${formatPrice(purchase.totalCents)}</td></tr>`
    html += '</tbody></table>'

    // Payment info
    const provider = purchase.paymentProvider ?? 'online'
    const tid      = purchase.paymentTransferId ? ` · ${purchase.paymentTransferId}` : ''
    html += `<div class="od-payment-section"><h4>Payment</h4>
      <div class="od-pay-leg">
        <strong>${formatPrice(purchase.totalCents)}</strong>
        <span>${escHtml(provider.charAt(0).toUpperCase() + provider.slice(1))}${escHtml(tid)}</span>
        <span class="od-pay-recon od-pay-recon--matched">✓ Matched</span>
      </div>
    </div>`

    // Issued cards
    if (cards.length) {
      html += `<div class="od-payment-section"><h4>Issued Gift Cards</h4>`
      for (const gc of cards) {
        const bal = gc.balanceCents < gc.faceValueCents
          ? ` · Balance ${formatPrice(gc.balanceCents)}`
          : ''
        html += `<div class="od-pay-leg">
          <strong>${escHtml(gc.code)}</strong>
          <span>${formatPrice(gc.faceValueCents)}${escHtml(bal)}</span>
          <span class="od-pay-recon od-pay-recon--${gc.status === 'active' ? 'matched' : 'pending'}">${escHtml(gc.status)}</span>
        </div>`
      }
      html += '</div>'
    }

    body.innerHTML = html
  } catch (err) {
    body.innerHTML = `<p class="od-loading">${escHtml(err.message || 'Error loading purchase')}</p>`
  }
}

// ---------------------------------------------------------------------------
// Payments tab
// ---------------------------------------------------------------------------

/**
 * @param {'loading'|'empty'|'content'} s
 */
function showPaymentsState(s) {
  document.getElementById('payments-loading').hidden = s !== 'loading'
  document.getElementById('payments-empty').hidden   = s !== 'empty'
  document.getElementById('payments-summary').hidden = s !== 'content'
  document.getElementById('payments-list').hidden    = s !== 'content'
}

async function loadPayments() {
  if (!state.merchantId) return
  if (ordersState.activeTab !== 'payments') return

  showPaymentsState('loading')

  try {
    const from = ordersState.fromMs ?? new Date().setHours(0, 0, 0, 0)
    const to   = ordersState.toMs   ?? Date.now()
    const url  = `/api/merchants/${state.merchantId}/payments/reconciliation?from=${from}&to=${to}`
    const res  = await api(url)
    if (!res.ok) throw new Error('Failed to load payments')
    const data = await res.json()

    if (!data.payments.length) {
      showPaymentsState('empty')
      return
    }

    renderPayments(data.payments, data.summary)
    showPaymentsState('content')
  } catch (err) {
    showPaymentsState('empty')
    showToast(err.message || 'Failed to load payments', 'error')
  }
}

/**
 * Open a modal showing the full order detail (bill view) for a payment row.
 * @param {string} orderId - the order to display
 */
async function openOrderDetailModal(orderId) {
  const overlay = document.getElementById('order-detail-overlay')
  const body    = document.getElementById('order-detail-body')

  body.innerHTML = '<p class="od-loading">Loading…</p>'
  overlay.hidden = false

  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders/${orderId}/detail`)
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Server error ${res.status}: ${errBody || res.statusText}`)
    }
    const { order, paymentLegs } = await res.json()
    renderOrderDetailModal(order, paymentLegs)
  } catch (err) {
    body.innerHTML = `<p class="od-loading">${escHtml(err.message || 'Error loading order')}</p>`
  }
}

/**
 * Render order detail inside the modal body.
 */
function renderOrderDetailModal(order, paymentLegs) {
  const body = document.getElementById('order-detail-body')

  const typeLabel = order.orderType === 'dine_in' ? 'Dine In'
    : order.orderType === 'delivery' ? 'Delivery' : 'Pickup'
  const tableInfo = order.tableLabel ? ` · ${escHtml(order.tableLabel)}` : ''
  const sourceLabel = order.source === 'online' ? 'Online' : order.source === 'clover' ? 'Clover' : 'Dashboard'

  const createdAtISO = order.createdAt
    ? (order.createdAt.endsWith('Z') ? order.createdAt : order.createdAt + 'Z')
    : null
  const dateStr = createdAtISO
    ? new Date(createdAtISO).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—'

  // Meta bar
  let html = `<div class="od-meta">
    <span><strong>${escHtml(order.customerName || 'Unknown')}</strong></span>
    ${order.customerPhone ? `<span>${escHtml(order.customerPhone)}</span>` : ''}
    <span>${typeLabel}${tableInfo}</span>
    <span>${sourceLabel}</span>
    <span>${dateStr}</span>
    <span class="od-status-chip ${order.status}">${order.status}</span>
  </div>`

  // Items table
  html += `<table class="od-items"><thead><tr><th>Item</th><th style="text-align:right">Amount</th></tr></thead><tbody>`
  const items = Array.isArray(order.items) ? order.items : []
  for (const it of items) {
    const qty = it.quantity ?? 1
    const price = it.lineTotalCents ?? (it.priceCents ?? 0) * qty
    const modStr = Array.isArray(it.modifiers) && it.modifiers.length
      ? `<span class="od-item-mods">${it.modifiers.map((m) => escHtml(m.name || m.modifierName || '')).join(', ')}</span>`
      : ''
    html += `<tr>
      <td>${qty > 1 ? qty + ' × ' : ''}${escHtml(it.dishName || it.name || '?')}${modStr}</td>
      <td>${formatPrice(price)}</td>
    </tr>`
  }
  html += '</tbody></table>'

  // Totals
  html += '<table class="od-totals"><tbody>'
  html += `<tr><td>Subtotal</td><td>${formatPrice(order.subtotalCents)}</td></tr>`
  if (order.discountCents > 0) {
    const label = order.discountLabel ? `Discount (${escHtml(order.discountLabel)})` : 'Discount'
    html += `<tr class="od-discount"><td>${label}</td><td>-${formatPrice(order.discountCents)}</td></tr>`
  }
  if ((order.serviceChargeCents ?? 0) > 0) {
    const svcLabel = order.serviceChargeLabel ? escHtml(order.serviceChargeLabel) : 'Service Charge'
    html += `<tr><td>${svcLabel}</td><td>${formatPrice(order.serviceChargeCents)}</td></tr>`
  }
  html += `<tr><td>Tax</td><td>${formatPrice(order.taxCents)}</td></tr>`
  if (order.tipCents > 0) {
    html += `<tr><td>Tip</td><td>${formatPrice(order.tipCents)}</td></tr>`
  }
  html += `<tr class="od-total-row"><td>Total</td><td>${formatPrice(order.totalCents)}</td></tr>`
  html += '</tbody></table>'

  // Payment legs (in-person) or online payment info
  if (paymentLegs && paymentLegs.length > 0) {
    html += '<div class="od-payment-section"><h4>Payment Records</h4>'
    for (const leg of paymentLegs) {
      const typeStr = leg.paymentType === 'cash' ? 'Cash'
        : (leg.cardType ? leg.cardType.charAt(0).toUpperCase() + leg.cardType.slice(1) : 'Card')
      const cardStr = leg.cardLastFour ? ` ···${leg.cardLastFour}` : ''
      const splitStr = leg.splitMode && leg.splitTotalLegs > 1
        ? ` (Split ${leg.splitLegNumber}/${leg.splitTotalLegs})`
        : ''
      const tipStr = leg.tipCents > 0 ? ` · Tip ${formatPrice(leg.tipCents)}` : ''
      const surcharge = leg.amexSurchargeCents > 0 ? ` · Surcharge ${formatPrice(leg.amexSurchargeCents)}` : ''

      let reconHtml = ''
      if (leg.reconciliation) {
        const rs = leg.reconciliation.status
        const cls = rs === 'matched' ? 'matched' : rs === 'unmatched' ? 'unmatched' : 'pending'
        reconHtml = `<span class="od-pay-recon od-pay-recon--${cls}">${rs === 'matched' ? '✓ Matched' : rs === 'unmatched' ? '⚠ Unmatched' : rs}</span>`
      }

      html += `<div class="od-pay-leg">
        <strong>${formatPrice(leg.amountCents)}</strong>
        <span>${typeStr}${escHtml(cardStr)}${splitStr}</span>
        <span>${tipStr}${surcharge}</span>
        ${reconHtml}
      </div>`
    }
    html += '</div>'
  } else if (order.paymentMethod) {
    // Online order — show inline payment info
    const pm = order.paymentMethod === 'cash' ? 'Cash' : 'Card'
    const tid = order.paymentTransferId ? ` · ${order.paymentTransferId.slice(0, 20)}…` : ''
    html += `<div class="od-payment-section"><h4>Payment</h4>
      <div class="od-pay-leg"><strong>${formatPrice(order.paidAmountCents || order.totalCents)}</strong> <span>${pm}${tid}</span></div>
    </div>`
  }

  body.innerHTML = html

  // Show/wire Print Receipt + Email Receipt when there are payment records
  const printReceiptBtn = document.getElementById('od-print-receipt-btn')
  const emailRow        = document.getElementById('od-email-row')
  const emailInput      = document.getElementById('od-email-input')
  const emailBtn        = document.getElementById('od-email-receipt-btn')

  const paidAmountCents = paymentLegs && paymentLegs.length > 0
    ? paymentLegs.reduce((sum, leg) => sum + (leg.amountCents || 0), 0)
    : (order.paidAmountCents || 0)
  // First payment leg ID — used by the receipt/email endpoint
  const firstPaymentId = paymentLegs && paymentLegs.length > 0 ? paymentLegs[0].id : null

  if (paidAmountCents > 0) {
    // Print button
    if (printReceiptBtn) {
      printReceiptBtn.hidden = false
      const freshPrint = printReceiptBtn.cloneNode(true)
      printReceiptBtn.replaceWith(freshPrint)
      freshPrint.addEventListener('click', async () => {
        freshPrint.disabled = true
        freshPrint.textContent = 'Printing…'
        try {
          const res = await api(`/api/merchants/${state.merchantId}/orders/${order.id}/print-receipt`, {
            method: 'POST',
            body: JSON.stringify({ paidAmountCents }),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || 'Print failed')
          }
          showToast('Receipt printed', 'success')
        } catch (err) {
          showToast(`Print failed: ${err.message}`, 'error')
        }
        freshPrint.disabled = false
        freshPrint.textContent = '🖨 Print Receipt'
      })
    }

    // Email row — only for in-person payments (paymentLegs present)
    if (emailRow && emailInput && emailBtn && firstPaymentId) {
      emailRow.hidden = false
      // Pre-fill with customer email if known
      emailInput.value = order.customerEmail || ''
      const freshEmail = emailBtn.cloneNode(true)
      emailBtn.replaceWith(freshEmail)
      freshEmail.addEventListener('click', async () => {
        const address = emailInput.value.trim()
        if (!address) { showToast('Enter an email address', 'error'); return }
        freshEmail.disabled = true
        freshEmail.textContent = 'Sending…'
        try {
          const res = await api(
            `/api/merchants/${state.merchantId}/payments/${firstPaymentId}/receipt`,
            { method: 'POST', body: JSON.stringify({ action: 'email', email: address }) },
          )
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || 'Email failed')
          }
          showToast(`Receipt emailed to ${address}`, 'success')
        } catch (err) {
          showToast(`Email failed: ${err.message}`, 'error')
        }
        freshEmail.disabled = false
        freshEmail.textContent = '📧 Email'
      })
    } else if (emailRow) {
      emailRow.hidden = true
    }
  } else {
    if (printReceiptBtn) printReceiptBtn.hidden = true
    if (emailRow) emailRow.hidden = true

    // Show "Link Payment" for unpaid orders (orphaned Finix transfer recovery)
    const linkRow = document.getElementById('od-link-row')
    const linkInput = document.getElementById('od-link-input')
    const linkBtn = document.getElementById('od-link-btn')
    if (linkRow && linkInput && linkBtn && order.status !== 'cancelled') {
      linkRow.hidden = false
      linkInput.value = ''
      const freshLink = linkBtn.cloneNode(true)
      linkBtn.replaceWith(freshLink)
      freshLink.addEventListener('click', async () => {
        const transferId = linkInput.value.trim()
        if (!transferId) { showToast('Enter a Finix Transfer ID', 'error'); return }
        freshLink.disabled = true
        freshLink.textContent = 'Linking…'
        try {
          const res = await api(
            `/api/merchants/${state.merchantId}/orders/${order.id}/link-transfer`,
            { method: 'POST', body: JSON.stringify({ transferId }) },
          )
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || 'Link failed')
          }
          showToast('Payment linked successfully', 'success')
          // Reload order detail to show the new payment
          openOrderDetailModal(order.id)
          if (state.activeSection === 'orders') loadOrders()
        } catch (err) {
          showToast(`Link failed: ${err.message}`, 'error')
        }
        freshLink.disabled = false
        freshLink.textContent = '🔗 Link'
      })
    }
  }
}

// Wire up order-detail modal close button + overlay click
;(function initOrderDetailModal() {
  const overlay = document.getElementById('order-detail-overlay')
  if (!overlay) return
  overlay.querySelector('.od-close').addEventListener('click', () => { overlay.hidden = true })
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true
  })
})()

/**
 * @param {Array}  payments  - payment objects from reconciliation endpoint
 * @param {object} summary   - { total, matched, unmatched, pending, totalCents }
 */
function renderPayments(payments, summary) {
  // --- Summary bar ---
  const summaryEl = document.getElementById('payments-summary')
  const unmatchedClass = summary.unmatched > 0 ? 'pay-summary-alert' : ''
  summaryEl.innerHTML =
    `<span class="pay-summary-stat">${summary.total} payment${summary.total !== 1 ? 's' : ''}</span>` +
    `<span class="pay-summary-sep" aria-hidden="true">·</span>` +
    `<span class="pay-summary-stat">Total <strong>$${(summary.totalCents / 100).toFixed(2)}</strong></span>` +
    (summary.matched   ? `<span class="pay-summary-sep" aria-hidden="true">·</span><span class="pay-summary-stat pay-summary-ok">✓ ${summary.matched} matched</span>` : '') +
    (summary.unmatched ? `<span class="pay-summary-sep" aria-hidden="true">·</span><span class="pay-summary-stat pay-summary-warn ${unmatchedClass}">⚠ ${summary.unmatched} unmatched</span>` : '') +
    (summary.pending   ? `<span class="pay-summary-sep" aria-hidden="true">·</span><span class="pay-summary-stat pay-summary-pending">⏳ ${summary.pending} pending</span>` : '')

  // --- Payment rows ---
  const list = document.getElementById('payments-list')
  list.innerHTML = ''

  for (const p of payments) {
    const timeStr = p.createdAt
      ? new Date(p.createdAt.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—'

    const amountStr      = `$${(p.amountCents / 100).toFixed(2)}`
    const isGcPurchase   = p.sourceType === 'gift_card_purchase'
    const typeLabel      = isGcPurchase ? '🎁 Gift Card Sale'
      : p.paymentType === 'cash' ? 'Cash'
      : p.paymentType === 'gift_card' ? '🎁 Gift Card'
      : (p.cardType ? p.cardType.charAt(0).toUpperCase() + p.cardType.slice(1) : 'Card')
    const cardInfo       = p.cardLastFour ? ` ···${p.cardLastFour}` : ''
    const orderTypeLabel = isGcPurchase ? 'Online'
      : p.orderType === 'dine_in' ? 'Dine In'
      : p.orderType === 'delivery' ? 'Delivery' : 'Takeout'
    const splitInfo      = p.splitMode && p.splitTotalLegs > 1
      ? ` <span class="pay-split-chip">${p.splitLegNumber}/${p.splitTotalLegs}</span>`
      : ''

    const rec = p.reconciliation
    let statusHtml
    if (!rec) {
      statusHtml = p.paymentType === 'cash'
        ? `<span class="pay-status pay-status--cash">Cash</span>`
        : `<span class="pay-status pay-status--pending">Pending check</span>`
    } else if (rec.status === 'matched') {
      statusHtml = `<span class="pay-status pay-status--matched">✓ Matched</span>`
    } else if (rec.status === 'unmatched') {
      statusHtml = `<span class="pay-status pay-status--unmatched">⚠ Unmatched</span>`
    } else if (rec.status === 'cash_skipped') {
      statusHtml = `<span class="pay-status pay-status--cash">Cash</span>`
    } else {
      statusHtml = `<span class="pay-status pay-status--no-proc">No processor</span>`
    }

    const row = document.createElement('div')
    row.className = `pay-row${rec?.status === 'unmatched' ? ' pay-row--alert' : ''}`
    row.dataset.paymentId  = p.id
    row.dataset.orderId    = p.orderId
    row.dataset.sourceType = p.sourceType ?? 'in_person'
    row.title = 'Click to view order'
    row.style.cursor = 'pointer'
    row.innerHTML =
      `<span class="pay-time">${timeStr}</span>` +
      `<span class="pay-customer">${escHtml(p.customerName || '—')}</span>` +
      `<span class="pay-type">${typeLabel}${escHtml(cardInfo)}${splitInfo}</span>` +
      `<span class="pay-order-type">${orderTypeLabel}</span>` +
      `<span class="pay-amount">${amountStr}</span>` +
      `<span class="pay-status-cell">${statusHtml}</span>`

    row.addEventListener('click', () => {
      if (row.dataset.sourceType === 'gift_card_purchase') {
        openGiftCardPurchaseModal(row.dataset.paymentId)
      } else {
        openOrderDetailModal(row.dataset.orderId)
      }
    })
    list.appendChild(row)
  }
}

async function syncOrdersFromClover() {
  const btn = document.getElementById('sync-orders-btn')
  btn.disabled = true
  const svg = btn.querySelector('svg')
  if (svg) svg.style.animation = 'spin 0.8s linear infinite'

  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders/sync`, {
      method: 'POST',
      body: JSON.stringify({ from: ordersState.fromMs, to: ordersState.toMs }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Sync failed')
    showToast(`Synced ${data.synced} orders from Clover`, 'success')
    await loadOrders()
  } catch (err) {
    showToast(err.message || 'Sync failed', 'error')
  } finally {
    btn.disabled = false
    if (svg) svg.style.animation = ''
  }
}

function renderOrders(orders) {
  if (!orders || orders.length === 0) {
    showOrdersState('empty')
    return
  }

  showOrdersState('content')

  // Summary bar — count (always) + financial breakdown (manager/owner only)
  const count = orders.length
  const taxRate = state.profile?.taxRate ?? 0
  let itemsCents          = 0
  let discountsCents      = 0
  let serviceChargeCents  = 0
  let taxCents            = 0
  let tipsCents           = 0
  let totalCents          = 0

  for (const o of orders) {
    const sub     = o.subtotalCents        ?? 0
    const discount = o.discountCents       ?? 0
    const svc     = o.serviceChargeCents   ?? 0
    const discSub = sub - discount
    const total   = o.totalCents           ?? 0
    // tax_cents may be 0 in DB for legacy orders; recalculate from profile on (discounted subtotal + service charge)
    const tax     = o.taxCents > 0 ? o.taxCents : Math.round((discSub + svc) * taxRate)
    // use stored tip_cents directly — never derive by subtraction
    const tip     = o.tipCents             ?? 0
    itemsCents         += sub
    discountsCents     += discount
    serviceChargeCents += svc
    taxCents           += tax
    tipsCents          += tip
    totalCents         += total
  }

  document.getElementById('orders-count-label').textContent =
    `${count} order${count !== 1 ? 's' : ''}`

  const role = state.currentEmployee?.role ?? 'owner'
  const isManager = role === 'manager' || role === 'owner'
  const financialsEl = document.getElementById('orders-financials')

  if (isManager) {
    document.getElementById('orders-fin-items').textContent = formatPrice(itemsCents)
    document.getElementById('orders-fin-tax').textContent   = formatPrice(taxCents)
    document.getElementById('orders-fin-tips').textContent  = formatPrice(tipsCents)
    document.getElementById('orders-fin-total').textContent = formatPrice(totalCents)

    // Service charge — shown only when present in current view
    const svcWrap = document.getElementById('orders-fin-svc-wrap')
    const svcSep  = document.getElementById('orders-fin-svc-sep')
    if (svcWrap) {
      svcWrap.hidden = serviceChargeCents === 0
      if (serviceChargeCents > 0) {
        document.getElementById('orders-fin-svc').textContent = formatPrice(serviceChargeCents)
      }
    }
    if (svcSep) svcSep.hidden = serviceChargeCents === 0

    // Discounts — shown only when present in current view
    const discWrap = document.getElementById('orders-fin-discounts-wrap')
    const discSep  = document.getElementById('orders-fin-discounts-sep')
    if (discWrap) {
      discWrap.hidden = discountsCents === 0
      if (discountsCents > 0) {
        document.getElementById('orders-fin-discounts').textContent = `−${formatPrice(discountsCents)}`
      }
    }
    if (discSep) discSep.hidden = discountsCents === 0
    financialsEl.hidden = false
  } else {
    financialsEl.hidden = true
  }

  const list = document.getElementById('orders-list')
  list.innerHTML = ''

  for (const order of orders) {
    list.appendChild(buildOrderCard(order))
  }
}

/**
 * Status → next action button label + target status.
 * null = no primary action available (terminal state).
 */
const ORDER_NEXT_ACTION = {
  received:    null,
  submitted:   null,
  confirmed:   { label: 'Mark Ready', next: 'ready',     icon: '✅' }, // legacy fallback
  preparing:   { label: 'Mark Ready', next: 'ready',     icon: '✅' },
  ready:       null,  // dine-in/takeout: payment modal handles completion; online: overridden below
  picked_up:   null,
  completed:   null,  // legacy
  cancelled:   null,
  paid:        null,
  pos_error:   null,
}

const STATUS_LABELS = {
  received:  'Received',
  submitted: 'Submitted',
  confirmed: 'Accepted',
  preparing: 'In Kitchen',
  ready:     'Ready',
  picked_up: 'Picked Up',
  completed: 'Completed',  // legacy label for historical orders
  cancelled: 'Cancelled',
  paid:      'Paid',
  pos_error: 'POS Error',
  open:      'Open',
}

function buildOrderCard(order) {
  const card = document.createElement('div')
  card.className = 'order-card'
  card.dataset.orderId = order.id

  // SQLite datetime('now') returns UTC without a 'Z' — coerce to UTC before parsing
  const createdAtISO = order.createdAt
    ? (order.createdAt.endsWith('Z') || order.createdAt.includes('+') ? order.createdAt : order.createdAt + 'Z')
    : null
  const timeStr = createdAtISO
    ? new Date(createdAtISO).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '—'

  const statusKey = order.status ?? 'received'
  const statusLabel = STATUS_LABELS[statusKey] ?? statusKey

  const sourceBadge = order.source === 'clover'
    ? `<span class="order-source-badge clover">Clover</span>`
    : order.source === 'dashboard'
      ? `<span class="order-source-badge dashboard">Dashboard</span>`
      : `<span class="order-source-badge">App</span>`

  // Order type + table chip
  const typeLabel = order.orderType === 'dine_in' ? 'Dine In'
    : order.orderType === 'delivery' ? 'Delivery' : 'Pickup'
  const tableChipText = order.orderType === 'dine_in' && order.tableLabel
    ? `${typeLabel} · ${escHtml(order.tableLabel)}`
    : typeLabel
  const typeChip = `<span class="order-type-chip ${order.orderType ?? 'pickup'}">${tableChipText}</span>`

  // Scheduled badge (shown when pickupTime is set)
  let scheduledBadge = ''
  if (order.pickupTime) {
    const ptISO = order.pickupTime.endsWith('Z') || order.pickupTime.includes('+')
      ? order.pickupTime : order.pickupTime + 'Z'
    const ptLabel = new Date(ptISO).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    scheduledBadge = `<span class="order-scheduled-badge" title="Scheduled ready at ${ptLabel}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      ${ptLabel}
    </span>`
  }

  // Refund state — derived from server-provided refund totals
  // Fallback: online store orders placed before the paid_amount_cents fix have 0 recorded;
  // if paymentMethod is set, treat totalCents as the paid amount for refund purposes.
  const _paidCents = (order.paidAmountCents > 0)
    ? order.paidAmountCents
    : (order.paymentMethod ? (order.totalCents ?? 0) : 0)
  const _refundedCents = order.refundedCents ?? 0
  const isRefundNeeded = !!(order.paymentMethod && statusKey === 'cancelled' && _paidCents > 0 && _refundedCents < _paidCents)
  const isPartiallyRefunded = _refundedCents > 0 && _refundedCents < _paidCents && !isRefundNeeded
  const isFullyRefunded = _paidCents > 0 && _refundedCents >= _paidCents

  // Header (clickable to expand)
  const header = document.createElement('div')
  header.className = 'order-card-header'
  header.setAttribute('role', 'button')
  header.setAttribute('tabindex', '0')
  header.setAttribute('aria-expanded', 'false')
  header.innerHTML = `
    <span class="order-time">${timeStr}</span>
    <div class="order-customer">
      <div class="order-customer-name">${escHtml(order.customerName ?? 'Unknown')}</div>
      ${order.customerPhone ? `<div class="order-customer-phone">${escHtml(order.customerPhone)}</div>` : ''}
      ${order.employeeNickname ? `<div class="order-server-name">👤 ${escHtml(order.employeeNickname)}</div>` : ''}
    </div>
    ${typeChip}
    ${scheduledBadge}
    ${sourceBadge}
    <span class="order-status ${statusKey}">${statusLabel}</span>
    ${order.paymentMethod === 'cash' ? '<span class="order-payment-badge cash">💵 Cash</span>' : ''}
    ${order.paymentMethod === 'card' ? '<span class="order-payment-badge card">💳 Card</span>' : ''}
    ${isRefundNeeded ? '<span class="order-refund-needed-badge">Refund Needed</span>' : ''}
    ${isPartiallyRefunded ? '<span class="order-partial-refund-badge">Partial Refund</span>' : ''}
    ${isFullyRefunded ? '<span class="order-refunded-badge">Refunded</span>' : ''}
    <span class="order-total">${formatPrice(order.totalCents ?? 0)}</span>
    <svg class="order-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
  `

  // Detail panel
  const items = Array.isArray(order.items) ? order.items : []
  const itemRows = items.map((it) => {
    const modLine = it.modifiers?.length
      ? `<li class="order-item-note">${escHtml(it.modifiers.map((m) => m.name).join(', '))}</li>`
      : ''
    return `
      <li class="order-item-row">
        <span class="order-item-qty">${it.quantity ?? 1}×</span>
        <span class="order-item-name">${escHtml(it.dishName ?? it.name ?? '—')}</span>
        <span class="order-item-price">${formatPrice((it.lineTotalCents ?? (it.priceCents ?? 0) * (it.quantity ?? 1)))}</span>
      </li>
      ${modLine}
      ${it.serverNotes || it.specialInstructions || it.note ? `<li class="order-item-note order-item-server-note">${escHtml(it.serverNotes ?? it.specialInstructions ?? it.note)}</li>` : ''}
    `
  }).join('')

  const detail = document.createElement('div')
  detail.className = 'order-detail'

  // Items list
  const itemsList = document.createElement('ul')
  itemsList.className = 'order-items-list'
  itemsList.innerHTML = itemRows || '<li style="color:var(--color-gray-500);font-size:0.85rem">No item details available</li>'
  detail.appendChild(itemsList)

  // Notes + utensils — shown directly below the items list
  if (order.notes || order.utensilsNeeded) {
    const notesEl = document.createElement('div')
    notesEl.className = 'order-notes'

    // Utensils first (kitchen needs to know immediately)
    if (order.utensilsNeeded) {
      const utensilRow = document.createElement('div')
      utensilRow.className = 'order-notes-row order-utensil-row'
      utensilRow.innerHTML = `<span class="order-notes-icon" aria-hidden="true">🥢</span><span>Utensils requested</span>`
      notesEl.appendChild(utensilRow)
    }

    if (order.notes) {
      const noteRow = document.createElement('div')
      noteRow.className = 'order-notes-row'
      noteRow.innerHTML = `<span class="order-notes-icon" aria-hidden="true">📝</span><span>${escHtml(order.notes)}</span>`
      notesEl.appendChild(noteRow)
    }

    detail.appendChild(notesEl)
  }

  // Scheduled pickup time row
  if (order.pickupTime) {
    const ptISO = order.pickupTime.endsWith('Z') || order.pickupTime.includes('+')
      ? order.pickupTime : order.pickupTime + 'Z'
    const ptFormatted = new Date(ptISO).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
    const scheduledRow = document.createElement('div')
    scheduledRow.className = 'order-notes order-scheduled-detail'
    scheduledRow.innerHTML = `
      <div class="order-notes-row">
        <span class="order-notes-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:middle"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        </span>
        <span>Scheduled ready at <strong>${escHtml(ptFormatted)}</strong></span>
      </div>
    `
    detail.appendChild(scheduledRow)
  }

  // Discount line — shown when a discount has been applied
  if ((order.discountCents ?? 0) > 0) {
    const discountRowEl = document.createElement('div')
    discountRowEl.className = 'order-notes order-discount-detail'
    const discLabel = order.discountLabel ? ` · ${escHtml(order.discountLabel)}` : ''
    discountRowEl.innerHTML = `
      <div class="order-notes-row order-discount-row">
        <span class="order-notes-icon" aria-hidden="true">🏷</span>
        <span>Discount${discLabel} — <strong>−${formatPrice(order.discountCents)}</strong></span>
      </div>
    `
    detail.appendChild(discountRowEl)
  }

  // Service charge line — shown when a service charge has been applied
  if ((order.serviceChargeCents ?? 0) > 0) {
    const scRowEl = document.createElement('div')
    scRowEl.className = 'order-notes order-service-charge-detail'
    const scLabel = order.serviceChargeLabel ? ` · ${escHtml(order.serviceChargeLabel)}` : ''
    scRowEl.innerHTML = `
      <div class="order-notes-row">
        <span class="order-notes-icon" aria-hidden="true">➕</span>
        <span>Service Charge${scLabel} — <strong>+${formatPrice(order.serviceChargeCents)}</strong></span>
      </div>
    `
    detail.appendChild(scRowEl)
  }

  // Refund history — shown when refunds have been recorded
  if (_refundedCents > 0) {
    const refundHistEl = document.createElement('div')
    refundHistEl.className = 'order-notes order-refund-history'
    const refundLabel = isFullyRefunded
      ? `Fully refunded — ${formatPrice(_refundedCents)}`
      : `Partially refunded — ${formatPrice(_refundedCents)} of ${formatPrice(_paidCents)}`
    refundHistEl.innerHTML = `
      <div class="order-notes-row">
        <span class="order-notes-icon" aria-hidden="true">↩️</span>
        <span>${refundLabel}</span>
      </div>
    `
    detail.appendChild(refundHistEl)
  }

  // Payment detail — shown when a payment method has been recorded
  if (order.paymentMethod) {
    const icon = order.paymentMethod === 'cash' ? '💵' : '💳'
    const methodLabel = order.paymentMethod === 'cash' ? 'Cash' : 'Card'
    const paidCents = (order.paidAmountCents ?? 0) > 0 ? order.paidAmountCents : (order.totalCents ?? 0)
    let payText = `${methodLabel} · ${formatPrice(paidCents)}`
    if ((order.tipCents ?? 0) > 0) payText += ` · Tip: ${formatPrice(order.tipCents)}`
    const paymentEl = document.createElement('div')
    paymentEl.className = 'order-notes order-payment-detail'
    paymentEl.innerHTML = `
      <div class="order-notes-row">
        <span class="order-notes-icon" aria-hidden="true">${icon}</span>
        <span>${payText}</span>
      </div>
    `
    detail.appendChild(paymentEl)
  }

  // Meta footer (ID, pickup code, QR code)
  const metaFooter = document.createElement('div')
  metaFooter.className = 'order-detail-footer'
  metaFooter.innerHTML = `
    <span class="order-id-label">${order.posOrderId ? `POS: ${escHtml(order.posOrderId)}` : `ID: ${order.id.slice(-8)}`}</span>
    ${order.pickupCode ? `<span class="order-pickup-code" data-pickup-code="${escHtml(order.pickupCode)}" data-order-id="${escHtml(order.id)}">Pickup: <strong>${escHtml(order.pickupCode)}</strong></span>` : ''}
  `
  detail.appendChild(metaFooter)

  // QR code — rendered lazily on first expand (avoid rendering all cards upfront)
  if (order.pickupCode && window.QR) {
    const qrWrap = document.createElement('div')
    qrWrap.className = 'order-qr'
    qrWrap.setAttribute('aria-label', `QR code for order ${order.pickupCode}`)

    const qrPayload = JSON.stringify({
      m: state.merchantId,
      o: order.id.slice(-8),
      p: order.pickupCode,
    })

    let qrRendered = false
    card.addEventListener('click', () => {
      if (!qrRendered && card.classList.contains('expanded')) {
        window.QR.appendTo(qrPayload, qrWrap, { size: 120, padding: 3 })
        qrRendered = true
      }
    }, { capture: true })

    detail.appendChild(qrWrap)
  }

  // ── Action buttons ────────────────────────────────────────────────────────
  const isTerminal = statusKey === 'picked_up' || statusKey === 'completed' || statusKey === 'cancelled' || statusKey === 'paid'
  const isOnline = order.source === 'online'

  // For online orders, override the action map with the accept/prepare/pickup lifecycle
  let nextAction = ORDER_NEXT_ACTION[statusKey] ?? null
  if (isOnline) {
    if (statusKey === 'received' || statusKey === 'submitted') {
      nextAction = { label: 'Accept Order', next: 'preparing', icon: '✅', acceptFlow: true }
    } else if (statusKey === 'ready') {
      nextAction = { label: 'Picked Up', next: 'picked_up', icon: '✅' }
    }
  }

  const actionsEl = document.createElement('div')
  actionsEl.className = 'order-actions'

  if (!isTerminal) {
    if (nextAction && nextAction.acceptFlow) {
      // Accept Order flow — prep time dropdown + accept button
      const wrap = document.createElement('div')
      wrap.className = 'order-accept-wrap'

      const select = document.createElement('select')
      select.className = 'order-prep-select'
      select.setAttribute('aria-label', 'Estimated prep time')
      for (const mins of [15, 20, 30, 45]) {
        const opt = document.createElement('option')
        opt.value = mins
        opt.textContent = `${mins} min`
        if (mins === 20) opt.selected = true
        select.appendChild(opt)
      }
      select.addEventListener('click', (e) => e.stopPropagation())

      const acceptBtn = document.createElement('button')
      acceptBtn.type = 'button'
      acceptBtn.className = 'btn btn-primary order-action-btn'
      acceptBtn.textContent = `${nextAction.icon} ${nextAction.label}`
      acceptBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        acceptOnlineOrder(order.id, parseInt(select.value, 10), card, acceptBtn)
      })

      wrap.appendChild(select)
      wrap.appendChild(acceptBtn)
      actionsEl.appendChild(wrap)
    } else if (nextAction) {
      const primaryBtn = document.createElement('button')
      primaryBtn.type = 'button'
      primaryBtn.className = 'btn btn-primary order-action-btn'
      primaryBtn.textContent = `${nextAction.icon} ${nextAction.label}`
      primaryBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        advanceOrderStatus(order.id, nextAction.next, card, primaryBtn)
      })
      actionsEl.appendChild(primaryBtn)
    }

    // Bill button — prints pre-payment customer bill
    const billBtn = document.createElement('button')
    billBtn.type = 'button'
    billBtn.className = 'btn btn-secondary order-action-btn'
    billBtn.textContent = '🧾 Bill'
    billBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      billBtn.disabled = true
      billBtn.textContent = 'Printing…'
      try {
        const res = await window.api(`/api/merchants/${state.merchantId}/orders/${order.id}/print-bill`, { method: 'POST' })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Print failed')
        }
        showToast('Bill sent to printer', 'success')
      } catch (err) {
        showToast(`Bill print failed: ${err.message}`, 'error')
      } finally {
        billBtn.disabled = false
        billBtn.textContent = '🧾 Bill'
      }
    })
    actionsEl.appendChild(billBtn)

    // Discount button — visible on any unpaid, non-cancelled order
    const discountBtn = document.createElement('button')
    discountBtn.type = 'button'
    discountBtn.className = 'btn btn-secondary order-action-btn'
    discountBtn.textContent = '🏷 Discount'
    if ((order.discountCents ?? 0) > 0) {
      discountBtn.textContent = '🏷 Discount ✓'
      discountBtn.classList.add('btn-discount-active')
    }
    discountBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openDiscountModal(order)
    })
    actionsEl.appendChild(discountBtn)

    // Service charge button — dine-in orders only
    if (order.orderType === 'dine_in') {
      const scBtn = document.createElement('button')
      scBtn.type = 'button'
      scBtn.className = 'btn btn-secondary order-action-btn'
      scBtn.textContent = '➕ Service Charge'
      if ((order.serviceChargeCents ?? 0) > 0) {
        scBtn.textContent = '➕ Service Charge ✓'
        scBtn.classList.add('btn-discount-active')
      }
      scBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        openServiceChargeModal(order)
      })
      actionsEl.appendChild(scBtn)
    }

    // Pay / Cash buttons — hide if order already has a payment method
    const alreadyPaid = !!order.paymentMethod

    if (!alreadyPaid) {
      if (order.source === 'online') {
        // Online orders: keep existing redirect payment button (Converge / Finix / Stax)
        const activeProvider = state.profile?.paymentProvider
        if (activeProvider) {
          const payBtn = document.createElement('button')
          payBtn.type = 'button'
          payBtn.className = 'btn btn-success order-action-btn'
          payBtn.textContent = '💳 Pay'
          payBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (activeProvider === 'converge') {
              openConvergePaymentForOrder(order)
            } else if (activeProvider === 'finix') {
              openFinixPaymentForOrder(order)
            } else {
              openStaxPaymentForOrder(order)
            }
          })
          actionsEl.appendChild(payBtn)
        }
      } else {
        // In-person orders: Cash + Counter + Charge card quick-action buttons
        const cashBtn = document.createElement('button')
        cashBtn.type = 'button'
        cashBtn.className = 'btn btn-secondary order-action-btn'
        cashBtn.textContent = '💵 Pay Cash'
        cashBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          if (window.PaymentModal) window.PaymentModal.open(order, state.profile, {
            mode: 'cash',
            finix: state.paymentConfig?.finix?.enabled ? {
              applicationId: state.paymentConfig.finix.applicationId,
              merchantId:    state.paymentConfig.finix.merchantId,
              sandbox:       state.paymentConfig.finix.sandbox,
            } : null,
          })
        })
        actionsEl.appendChild(cashBtn)

        // Counter and dine-in card buttons — hidden when Clover is the payment processor
        // (Clover device handles card collection; cash button remains for cash payments)
        if (!state.paymentConfig?.clover?.enabled) {
          const counterBtn = document.createElement('button')
          counterBtn.type = 'button'
          counterBtn.className = 'btn btn-secondary order-action-btn'
          counterBtn.textContent = '💳 Pay Counter'
          counterBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (window.PaymentModal) window.PaymentModal.open(order, state.profile, {
              mode: 'counter',
              finix: state.paymentConfig?.finix?.enabled ? {
                applicationId: state.paymentConfig.finix.applicationId,
                merchantId:    state.paymentConfig.finix.merchantId,
                sandbox:       state.paymentConfig.finix.sandbox,
              } : null,
            })
          })
          actionsEl.appendChild(counterBtn)

          const chargeCardBtn = document.createElement('button')
          chargeCardBtn.type = 'button'
          chargeCardBtn.className = 'btn btn-success order-action-btn'
          chargeCardBtn.textContent = '💳 Pay Dine-in'
          chargeCardBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (window.PaymentModal) window.PaymentModal.open(order, state.profile, {
              mode: 'card',
              finix: state.paymentConfig?.finix?.enabled ? {
                applicationId: state.paymentConfig.finix.applicationId,
                merchantId:    state.paymentConfig.finix.merchantId,
                sandbox:       state.paymentConfig.finix.sandbox,
              } : null,
            })
          })
          actionsEl.appendChild(chargeCardBtn)
        }

        if (state.paymentConfig?.finix?.enabled && state.paymentConfig.finix.applicationId) {
          const phoneBtn = document.createElement('button')
          phoneBtn.type = 'button'
          phoneBtn.className = 'btn btn-secondary order-action-btn'
          phoneBtn.textContent = '📞 Pay by phone'
          phoneBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (window.PaymentModal) window.PaymentModal.open(order, state.profile, {
              mode: 'phone',
              finix: {
                applicationId: state.paymentConfig.finix.applicationId,
                merchantId:    state.paymentConfig.finix.merchantId,
                sandbox:       state.paymentConfig.finix.sandbox,
              },
            })
          })
          actionsEl.appendChild(phoneBtn)
        }

        // Clover: single entry point via payment modal (handles card, split, gift card)
        // "Send to Clover" is handled transparently inside the modal — no separate button needed
        if (state.paymentConfig?.clover?.enabled) {
          const cloverReviewBtn = document.createElement('button')
          cloverReviewBtn.type = 'button'
          cloverReviewBtn.className = 'btn btn-success order-action-btn'
          cloverReviewBtn.textContent = '🍀 Review & Pay'
          cloverReviewBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (window.PaymentModal) window.PaymentModal.open(order, state.profile, {
              mode: 'card',
              clover: { enabled: true },
            })
          })
          actionsEl.appendChild(cloverReviewBtn)
        }

        // Already pushed — show Clover order ID as a badge
        if (order.cloverOrderId) {
          const cloverBadge = document.createElement('span')
          cloverBadge.className = 'order-clover-badge'
          cloverBadge.textContent = `🍀 ${order.cloverOrderId}`
          cloverBadge.title = 'This order has been sent to Clover'
          actionsEl.appendChild(cloverBadge)
        }

        // Clover receipt link — shown once payment is reconciled (internal use only)
        if (order.cloverPaymentId) {
          const receiptLink = document.createElement('a')
          receiptLink.href = `https://www.clover.com/r/${order.cloverPaymentId}`
          receiptLink.target = '_blank'
          receiptLink.rel = 'noopener noreferrer'
          receiptLink.className = 'order-clover-receipt-link'
          receiptLink.textContent = '🧾 Clover Receipt'
          receiptLink.title = 'View Clover payment receipt (internal reference)'
          actionsEl.appendChild(receiptLink)
        }
      }
    }

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn btn-secondary order-action-btn btn-cancel'
    cancelBtn.textContent = 'Cancel Order'
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      advanceOrderStatus(order.id, 'cancelled', card, cancelBtn)
    })
    actionsEl.appendChild(cancelBtn)
  }

  // Refund button — managers and owners only, on any paid order not fully refunded
  const _refundRole = state.currentEmployee?.role ?? 'owner'
  const _canSeeRefund = _refundRole === 'manager' || _refundRole === 'owner'
  if (order.paymentMethod && !isFullyRefunded && _canSeeRefund) {
    const refundBtn = document.createElement('button')
    refundBtn.type = 'button'
    refundBtn.className = 'btn btn-secondary order-action-btn'
    refundBtn.textContent = _refundedCents > 0 ? '↩️ Add Refund' : '↩️ Refund'
    refundBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openRefundModal(order)
    })
    actionsEl.appendChild(refundBtn)
  }

  // Fire to Kitchen — always available (reprint) unless cancelled
  if (statusKey !== 'cancelled') {
    const fireBtn = document.createElement('button')
    fireBtn.type = 'button'
    fireBtn.className = 'btn btn-secondary order-action-btn'
    fireBtn.textContent = '🖨️ Fire to Kitchen'
    fireBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      fireBtn.disabled = true
      fireBtn.textContent = 'Printing…'
      try {
        const res = await window.api(`/api/merchants/${state.merchantId}/orders/${order.id}/reprint`, { method: 'POST' })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || 'Print failed')
        }
        showToast('Ticket sent to kitchen', 'success')
      } catch (err) {
        showToast(err.message || 'Print failed', 'error')
      } finally {
        fireBtn.disabled = false
        fireBtn.textContent = '🖨️ Fire to Kitchen'
      }
    })
    actionsEl.appendChild(fireBtn)
  }

  // Reopen — load into Order Entry tab for editing (all non-cancelled orders)
  if (statusKey !== 'cancelled') {
    const reopenBtn = document.createElement('button')
    reopenBtn.type = 'button'
    reopenBtn.className = 'btn btn-secondary order-action-btn'
    reopenBtn.textContent = '✏️ Reopen'
    reopenBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      reopenOrder(order)
    })
    actionsEl.appendChild(reopenBtn)
  }

  // Delete — not allowed on paid orders; owner/manager only (API enforces)
  if (statusKey !== 'paid') {
    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'btn btn-secondary order-action-btn btn-cancel'
    deleteBtn.textContent = '🗑️ Delete'
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      deleteOrder(order.id, card, deleteBtn)
    })
    actionsEl.appendChild(deleteBtn)
  }

  if (actionsEl.children.length > 0) {
    detail.appendChild(actionsEl)
  }

  // Toggle expand
  const toggle = () => {
    const expanded = card.classList.toggle('expanded')
    header.setAttribute('aria-expanded', String(expanded))
  }
  header.addEventListener('click', toggle)
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
  })

  // Non-terminal orders start expanded so staff sees them without an extra click.
  // Terminal orders (picked_up / cancelled / paid) start collapsed to keep the
  // list compact — they require deliberate action to inspect.
  if (!isTerminal) {
    card.classList.add('expanded')
    header.setAttribute('aria-expanded', 'true')
  }

  card.appendChild(header)
  card.appendChild(detail)
  return card
}

// ---------------------------------------------------------------------------
// Discount modal
// ---------------------------------------------------------------------------

/**
 * Open the discount modal for a given order.
 * Allows applying a preset or custom discount (% or $) to the subtotal.
 * Tip is always calculated on the original pre-discount total (per business rule).
 *
 * @param {object} order - Order object from buildOrderCard
 */
function openDiscountModal(order) {
  const modal      = document.getElementById('discount-modal')
  const presetBtns = document.getElementById('discount-preset-btns')
  const currentEl  = document.getElementById('discount-current')
  const previewEl  = document.getElementById('discount-preview')
  const removeBtn  = document.getElementById('discount-remove-btn')
  const applyBtn   = document.getElementById('discount-apply-btn')
  const pctBtn     = document.getElementById('discount-type-pct')
  const fixedBtn   = document.getElementById('discount-type-fixed')
  const valInput   = document.getElementById('discount-custom-value')
  if (!modal) return

  const subtotalCents = order.subtotalCents ?? 0
  let selectedCents = 0
  let selectedLabel = 'Custom'

  // Show existing discount badge
  if ((order.discountCents ?? 0) > 0) {
    currentEl.hidden = false
    currentEl.textContent =
      `Current: ${order.discountLabel ? escHtml(order.discountLabel) + ' — ' : ''}−${formatPrice(order.discountCents)}`
    removeBtn.hidden = false
  } else {
    currentEl.hidden = true
    removeBtn.hidden = true
  }

  // Activate helper — highlights the chosen preset chip
  const activateBtn = (el) =>
    presetBtns.querySelectorAll('.ppr-tip-opt').forEach((b) => b.classList.toggle('active', b === el))

  const updatePreview = () => {
    if (selectedCents > 0) {
      const newSubtotal = subtotalCents - selectedCents
      previewEl.textContent =
        `−${formatPrice(selectedCents)}  →  subtotal ${formatPrice(newSubtotal)}`
      applyBtn.disabled = false
    } else {
      previewEl.textContent = ''
      applyBtn.disabled = true
    }
  }

  // Build preset chips from merchant profile (hidden if none configured)
  const levels = state.profile?.discountLevels ?? []
  presetBtns.innerHTML = ''
  presetBtns.hidden = levels.length === 0

  for (const lvl of levels) {
    const isPercent = lvl.type === 'percent'
    const labelText = isPercent ? `${lvl.label} ${lvl.value}%` : `${lvl.label} −${formatPrice(Math.round(lvl.value * 100))}`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ppr-tip-opt'
    btn.textContent = labelText
    btn.addEventListener('click', () => {
      // Fill in the input so the user can see / adjust the value
      customType = isPercent ? 'percent' : 'fixed'
      pctBtn.setAttribute('aria-pressed', String(isPercent))
      fixedBtn.setAttribute('aria-pressed', String(!isPercent))
      valInput.value = String(lvl.value)
      valInput.dispatchEvent(new Event('input'))
      selectedLabel = lvl.label   // override 'Custom' label set by oninput
      activateBtn(btn)
    })
    presetBtns.appendChild(btn)
  }

  // Type toggle and live input — always visible
  let customType = 'percent'
  pctBtn.setAttribute('aria-pressed', 'true')
  fixedBtn.setAttribute('aria-pressed', 'false')
  pctBtn.onclick = () => {
    customType = 'percent'
    pctBtn.setAttribute('aria-pressed', 'true')
    fixedBtn.setAttribute('aria-pressed', 'false')
    const v = parseFloat(valInput.value) || 0
    selectedCents = Math.round(subtotalCents * v / 100)
    selectedLabel = 'Custom'
    activateBtn(null)
    updatePreview()
  }
  fixedBtn.onclick = () => {
    customType = 'fixed'
    fixedBtn.setAttribute('aria-pressed', 'true')
    pctBtn.setAttribute('aria-pressed', 'false')
    const v = parseFloat(valInput.value) || 0
    selectedCents = Math.round(v * 100)
    selectedLabel = 'Custom'
    activateBtn(null)
    updatePreview()
  }
  valInput.oninput = () => {
    const v = parseFloat(valInput.value) || 0
    selectedCents = customType === 'percent'
      ? Math.round(subtotalCents * v / 100)
      : Math.round(v * 100)
    selectedLabel = 'Custom'
    activateBtn(null)
    updatePreview()
  }

  // Reset input, preview, and Apply button state
  valInput.value = ''
  previewEl.textContent = ''
  applyBtn.disabled = true
  setTimeout(() => valInput.focus(), 50)

  // Show modal
  modal.hidden = false

  const close = () => { modal.hidden = true }
  document.getElementById('discount-modal-close').onclick = close
  document.getElementById('discount-modal-cancel').onclick = close
  modal.onclick = (e) => { if (e.target === modal) close() }

  removeBtn.onclick = async () => {
    close()
    await applyDiscount(order.id, 0, null)
  }

  applyBtn.onclick = async () => {
    if (selectedCents > subtotalCents) {
      showToast('Discount cannot exceed the order subtotal', 'error')
      return
    }
    close()
    await applyDiscount(order.id, selectedCents, selectedLabel)
  }
}

/**
 * PATCH the discount on an order and reload the orders list.
 * @param {string} orderId
 * @param {number} discountCents - 0 to remove
 * @param {string|null} discountLabel
 */
async function applyDiscount(orderId, discountCents, discountLabel) {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: JSON.stringify({ discountCents, discountLabel }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error ?? 'Failed to apply discount', 'error')
      return
    }
    showToast(discountCents > 0 ? 'Discount applied' : 'Discount removed', 'success')
    await loadOrders()
  } catch (err) {
    showToast(err.message ?? 'Failed to apply discount', 'error')
  }
}

/**
 * Open the service charge modal for a dine-in order.
 * @param {object} order - The order object from state.orders
 */
function openServiceChargeModal(order) {
  const modal      = document.getElementById('service-charge-modal')
  const presetBtns = document.getElementById('service-charge-preset-btns')
  const currentEl  = document.getElementById('service-charge-current')
  const previewEl  = document.getElementById('service-charge-preview')
  const removeBtn  = document.getElementById('service-charge-remove-btn')
  const applyBtn   = document.getElementById('service-charge-apply-btn')
  const pctBtn     = document.getElementById('service-charge-type-pct')
  const fixedBtn   = document.getElementById('service-charge-type-fixed')
  const valInput   = document.getElementById('service-charge-custom-value')
  if (!modal) return

  const subtotalCents = order.subtotalCents ?? 0
  let selectedCents = 0
  let selectedLabel = 'Custom'

  // Show existing service charge badge
  if ((order.serviceChargeCents ?? 0) > 0) {
    currentEl.hidden = false
    currentEl.textContent =
      `Current: ${order.serviceChargeLabel ? escHtml(order.serviceChargeLabel) + ' — ' : ''}+${formatPrice(order.serviceChargeCents)}`
    removeBtn.hidden = false
  } else {
    currentEl.hidden = true
    removeBtn.hidden = true
  }

  const activateBtn = (el) =>
    presetBtns.querySelectorAll('.ppr-tip-opt').forEach((b) => b.classList.toggle('active', b === el))

  const updatePreview = () => {
    if (selectedCents > 0) {
      const newTotal = subtotalCents + selectedCents
      previewEl.textContent =
        `+${formatPrice(selectedCents)}  →  subtotal ${formatPrice(newTotal)} (before tax)`
      applyBtn.disabled = false
    } else {
      previewEl.textContent = ''
      applyBtn.disabled = true
    }
  }

  // Build preset chips from merchant profile
  const presets = state.profile?.serviceChargePresets ?? []
  presetBtns.innerHTML = ''
  presetBtns.hidden = presets.length === 0

  for (const lvl of presets) {
    const isPercent = lvl.type === 'percent'
    const labelText = isPercent ? `${lvl.label} ${lvl.value}%` : `${lvl.label} +${formatPrice(Math.round(lvl.value * 100))}`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ppr-tip-opt'
    btn.textContent = labelText
    btn.addEventListener('click', () => {
      customType = isPercent ? 'percent' : 'fixed'
      pctBtn.setAttribute('aria-pressed', String(isPercent))
      fixedBtn.setAttribute('aria-pressed', String(!isPercent))
      valInput.value = String(lvl.value)
      valInput.dispatchEvent(new Event('input'))
      selectedLabel = lvl.label
      activateBtn(btn)
    })
    presetBtns.appendChild(btn)
  }

  let customType = 'percent'
  pctBtn.setAttribute('aria-pressed', 'true')
  fixedBtn.setAttribute('aria-pressed', 'false')
  pctBtn.onclick = () => {
    customType = 'percent'
    pctBtn.setAttribute('aria-pressed', 'true')
    fixedBtn.setAttribute('aria-pressed', 'false')
    const v = parseFloat(valInput.value) || 0
    selectedCents = Math.round(subtotalCents * v / 100)
    selectedLabel = 'Custom'
    activateBtn(null)
    updatePreview()
  }
  fixedBtn.onclick = () => {
    customType = 'fixed'
    fixedBtn.setAttribute('aria-pressed', 'true')
    pctBtn.setAttribute('aria-pressed', 'false')
    const v = parseFloat(valInput.value) || 0
    selectedCents = Math.round(v * 100)
    selectedLabel = 'Custom'
    activateBtn(null)
    updatePreview()
  }
  valInput.oninput = () => {
    const v = parseFloat(valInput.value) || 0
    selectedCents = customType === 'percent'
      ? Math.round(subtotalCents * v / 100)
      : Math.round(v * 100)
    selectedLabel = 'Custom'
    activateBtn(null)
    updatePreview()
  }

  valInput.value = ''
  previewEl.textContent = ''
  applyBtn.disabled = true
  setTimeout(() => valInput.focus(), 50)

  modal.hidden = false

  const close = () => { modal.hidden = true }
  document.getElementById('service-charge-modal-close').onclick = close
  document.getElementById('service-charge-modal-cancel').onclick = close
  modal.onclick = (e) => { if (e.target === modal) close() }

  removeBtn.onclick = async () => {
    close()
    await applyServiceCharge(order.id, 0, null)
  }

  applyBtn.onclick = async () => {
    close()
    await applyServiceCharge(order.id, selectedCents, selectedLabel)
  }
}

async function applyServiceCharge(orderId, serviceChargeCents, serviceChargeLabel) {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders/${orderId}/service-charge`, {
      method: 'PATCH',
      body: JSON.stringify({ serviceChargeCents, serviceChargeLabel }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error ?? 'Failed to apply service charge', 'error')
      return
    }
    showToast(serviceChargeCents > 0 ? 'Service charge applied' : 'Service charge removed', 'success')
    await loadOrders()
  } catch (err) {
    showToast(err.message ?? 'Failed to apply service charge', 'error')
  }
}

/**
 * Open the refund modal for a given order.
 * Supports full and by-item refunds with proportional tax computation.
 */
function openRefundModal(order) {
  const modal   = document.getElementById('refund-modal')
  const body    = document.getElementById('refund-modal-body')
  const confirm = document.getElementById('refund-modal-confirm')
  const cancel  = document.getElementById('refund-modal-cancel')
  const close   = document.getElementById('refund-modal-close')
  if (!modal || !body || !confirm) return

  // Fallback: online store orders placed before the paid_amount_cents fix have 0 recorded.
  const paidCents     = (order.paidAmountCents > 0)
    ? order.paidAmountCents
    : (order.paymentMethod ? (order.totalCents ?? 0) : 0)
  const alreadyRefCents = order.refundedCents ?? 0
  const maxRefundable = paidCents - alreadyRefCents
  const taxCents      = order.taxCents ?? 0
  const subtotalCents = order.subtotalCents ?? (paidCents - taxCents)
  const items         = Array.isArray(order.items) ? order.items : []

  /** Proportional per-item tax: floor(lineTotalCents / subtotal * totalTax) */
  function itemTax(lineTotalCents) {
    if (!subtotalCents || !taxCents) return 0
    return Math.floor(lineTotalCents / subtotalCents * taxCents)
  }

  // Build modal body
  body.innerHTML = `
    <div class="refund-type-pills" role="group" aria-label="Refund type">
      <button type="button" class="refund-type-pill active" data-type="full">Full Refund</button>
      <button type="button" class="refund-type-pill" data-type="items">By Item</button>
    </div>

    <div id="refund-full-view" class="refund-amount-summary">
      <div class="refund-amount-row">
        <span>Refund amount</span>
        <strong>${formatPrice(maxRefundable)}</strong>
      </div>
      ${taxCents > 0 && alreadyRefCents === 0 ? `<div class="refund-amount-note">Includes tax of ${formatPrice(taxCents)}</div>` : ''}
    </div>

    <div id="refund-items-view" hidden>
      <ul class="refund-item-list">
        ${items.map((it, idx) => {
          const lineTotal = it.lineTotalCents ?? ((it.priceCents ?? 0) * (it.quantity ?? 1))
          const tax = itemTax(lineTotal)
          return `<li class="refund-item-row">
            <label>
              <input type="checkbox" class="refund-item-check" data-idx="${idx}" data-amount="${lineTotal}" data-tax="${tax}">
              <span class="refund-item-name">${escHtml(it.dishName ?? it.name ?? '—')}</span>
              <span class="refund-item-price">${formatPrice(lineTotal)}</span>
            </label>
          </li>`
        }).join('')}
      </ul>
      <div class="refund-items-total">
        Selected: <strong id="refund-items-selected-total">${formatPrice(0)}</strong>
      </div>
      <div id="refund-items-tax-note" class="refund-amount-note" hidden></div>
    </div>

    <div class="refund-notes-wrap">
      <label for="refund-notes-input">Notes <span style="font-weight:400;color:var(--color-gray-400)">(optional)</span></label>
      <textarea id="refund-notes-input" class="refund-notes-textarea" rows="2" placeholder="Reason for refund"></textarea>
    </div>
  `

  // Type pill toggle
  let refundType = 'full'
  body.querySelectorAll('.refund-type-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      refundType = pill.dataset.type
      body.querySelectorAll('.refund-type-pill').forEach(p => p.classList.remove('active'))
      pill.classList.add('active')
      document.getElementById('refund-full-view').hidden  = refundType !== 'full'
      document.getElementById('refund-items-view').hidden = refundType !== 'items'
      updateConfirmState()
    })
  })

  // Item checkbox updates
  function updateItemsTotal() {
    let total = 0
    let tax = 0
    body.querySelectorAll('.refund-item-check:checked').forEach(cb => {
      total += parseInt(cb.dataset.amount, 10) || 0
      tax   += parseInt(cb.dataset.tax,    10) || 0
    })
    const el = document.getElementById('refund-items-selected-total')
    if (el) el.textContent = formatPrice(total)
    const taxNote = document.getElementById('refund-items-tax-note')
    if (taxNote) {
      if (tax > 0) {
        taxNote.textContent = `Includes tax of ${formatPrice(tax)}`
        taxNote.hidden = false
      } else {
        taxNote.hidden = true
      }
    }
    return total
  }
  body.querySelectorAll('.refund-item-check').forEach(cb => {
    cb.addEventListener('change', () => { updateItemsTotal(); updateConfirmState() })
  })

  function updateConfirmState() {
    if (refundType === 'full') {
      confirm.disabled = false
    } else {
      const checked = body.querySelectorAll('.refund-item-check:checked').length
      confirm.disabled = checked === 0
    }
  }
  updateConfirmState()

  // Confirm handler
  async function handleConfirm() {
    confirm.disabled = true
    confirm.textContent = 'Recording…'

    try {
      let body_payload
      const notes = document.getElementById('refund-notes-input')?.value.trim() || undefined

      if (refundType === 'full') {
        body_payload = { type: 'full', notes }
      } else {
        const selectedItems = []
        body.querySelectorAll('.refund-item-check:checked').forEach(cb => {
          const idx = parseInt(cb.dataset.idx, 10)
          const it = items[idx]
          if (!it) return
          const lineTotal = parseInt(cb.dataset.amount, 10)
          const tax = parseInt(cb.dataset.tax, 10)
          selectedItems.push({
            itemIndex: idx,
            dishName: it.dishName ?? it.name ?? '—',
            quantity: it.quantity ?? 1,
            amountCents: lineTotal,
            taxCents: tax,
          })
        })
        body_payload = { type: 'partial', items: selectedItems, notes }
      }

      const res = await api(`/api/merchants/${state.merchantId}/orders/${order.id}/refunds`, {
        method: 'POST',
        body: JSON.stringify(body_payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Refund failed')
      }

      const refundData = await res.json().catch(() => ({}))
      modal.hidden = true
      if (refundData?.refund?.processorRefunded) {
        showToast('Refund processed — money will be returned to the customer', 'success')
      } else {
        showToast('Refund recorded — issue the payment refund manually in your Finix/Converge portal', 'warning')
      }
      // Refresh orders list so badges update
      await loadOrders()
    } catch (err) {
      showToast(err.message || 'Refund failed', 'error')
      confirm.disabled = false
      confirm.textContent = 'Confirm Refund'
    }
  }

  // Wire buttons
  confirm.onclick = handleConfirm
  cancel.onclick  = () => { modal.hidden = true }
  close.onclick   = () => { modal.hidden = true }

  modal.hidden = false
}

/**
 * Accept an online order with estimated prep time.
 * PATCHes status to 'preparing' + estimatedMinutes, fires kitchen ticket.
 */
async function acceptOnlineOrder(orderId, estimatedMinutes, card, triggerBtn) {
  triggerBtn.disabled = true
  const originalText = triggerBtn.textContent
  triggerBtn.textContent = 'Accepting…'

  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'preparing', estimatedMinutes }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to accept order')
    }

    stopOrderSoundRepeat(orderId)
    playFireSound()
    showToast(`Order accepted — ready in ~${estimatedMinutes} min`, 'success')
    await refreshOrderCard(orderId, card)
  } catch (err) {
    showToast(`Accept failed: ${err.message}`, 'error')
    triggerBtn.disabled = false
    triggerBtn.textContent = originalText
  }
}

/**
 * PATCH the order status, then refresh the card in place.
 */
async function advanceOrderStatus(orderId, newStatus, card, triggerBtn) {
  triggerBtn.disabled = true
  const originalText = triggerBtn.textContent
  triggerBtn.textContent = 'Updating…'

  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to update status')
    }

    const statusLabels = {
      submitted: 'sent to POS',
      preparing: 'sent to kitchen',
      ready:     'marked ready',
      picked_up: 'picked up',
      cancelled: 'cancelled',
    }
    showToast(`Order ${statusLabels[newStatus] ?? newStatus}`, newStatus === 'cancelled' ? 'error' : 'success')

    // Re-fetch and re-render just this card
    await refreshOrderCard(orderId, card)
  } catch (err) {
    showToast(err.message || 'Failed to update order', 'error')
    triggerBtn.disabled = false
    triggerBtn.textContent = originalText
  }
}

/** Fetch a single order and rebuild its card DOM in place */
async function refreshOrderCard(orderId, card) {
  try {
    // Pull the full list for today (simplest — we're not yet on a per-order GET endpoint)
    // We re-render the specific card using the data from state if available
    await loadOrders()
  } catch {
    // Fallback: just reload the full list
    loadOrders()
  }
}

// =============================================================================
// RESERVATIONS
// =============================================================================

/** @type {string} currently viewed date YYYY-MM-DD */
let _resDate = null
/** @type {boolean} whether init listeners have been attached */
let _resInitDone = false

/** Format 24h HH:MM to 12h display */
function _resFormatTime(hhmm) {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
}

/** Return today's date as YYYY-MM-DD in local time */
function _resToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Format YYYY-MM-DD for the date nav label */
function _resDateLabel(iso) {
  if (!iso) return ''
  const today = _resToday()
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const label = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  return iso === today ? `Today — ${label}` : label
}

/** Advance iso date by `delta` days */
function _resShiftDate(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d + delta)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Badge HTML for reservation status */
function _resStatusBadge(status) {
  const map = {
    confirmed: { label: 'Confirmed', cls: 'badge-info' },
    seated:    { label: 'Seated',    cls: 'badge-success' },
    cancelled: { label: 'Cancelled', cls: 'badge-neutral' },
    no_show:   { label: 'No-show',   cls: 'badge-danger' },
  }
  const { label, cls } = map[status] ?? { label: status, cls: 'badge-neutral' }
  return `<span class="badge ${cls}">${label}</span>`
}

/** One-time init: wire date nav buttons and add-reservation button */
function _resInitListeners() {
  if (_resInitDone) return
  _resInitDone = true

  document.getElementById('res-prev-day')?.addEventListener('click', () => {
    _resDate = _resShiftDate(_resDate, -1)
    loadReservations()
  })
  document.getElementById('res-next-day')?.addEventListener('click', () => {
    _resDate = _resShiftDate(_resDate, 1)
    loadReservations()
  })
  document.getElementById('res-today-btn')?.addEventListener('click', () => {
    _resDate = _resToday()
    loadReservations()
  })
  document.getElementById('res-add-btn')?.addEventListener('click', () => openResModal(null))

  // Modal close
  document.getElementById('res-modal-close')?.addEventListener('click', closeResModal)
  document.getElementById('res-m-cancel')?.addEventListener('click', closeResModal)
  document.getElementById('res-m-save')?.addEventListener('click', saveReservation)

  // Close on backdrop click
  document.getElementById('res-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('res-modal')) closeResModal()
  })

  // SSE reservation listeners are registered in connectSSE() on the EventSource directly
}

/** Entry point called by showSection('reservations') */
function initReservations() {
  _resInitListeners()
  if (!_resDate) _resDate = _resToday()
  loadReservations()
  loadResUpcoming()
}

/** Load upcoming reservations (next 60 min) for the reminder strip */
async function loadResUpcoming() {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/reservations/upcoming`)
    if (!res.ok) return
    const data = await res.json()
    const upcoming = data.reservations ?? []
    const strip = document.getElementById('res-upcoming-strip')
    const list  = document.getElementById('res-upcoming-list')
    if (!strip || !list) return
    if (upcoming.length === 0) { strip.hidden = true; return }
    strip.hidden = false
    list.innerHTML = upcoming.map((r) =>
      `<span class="res-upcoming-item">${_resFormatTime(r.time)} · ${escHtml(r.customerName)} · ${r.partySize}</span>`
    ).join('')
  } catch { /* non-critical */ }
}

/** Load reservations for _resDate */
async function loadReservations() {
  const label = document.getElementById('res-date-label')
  if (label) label.textContent = _resDateLabel(_resDate)

  const loading = document.getElementById('res-list-loading')
  const empty   = document.getElementById('res-list-empty')
  const list    = document.getElementById('res-list')
  if (!list) return

  list.innerHTML = ''
  loading.hidden = false
  empty.hidden   = true

  try {
    const res = await api(`/api/merchants/${state.merchantId}/reservations?date=${_resDate}`)
    loading.hidden = true
    if (!res.ok) { empty.hidden = false; return }
    const data = await res.json()
    const rows = data.reservations ?? []
    if (rows.length === 0) { empty.hidden = false; return }
    renderReservationList(rows)
  } catch {
    loading.hidden = true
    empty.hidden = false
  }
}

/** Render the list of reservation rows */
function renderReservationList(rows) {
  const list = document.getElementById('res-list')
  list.innerHTML = ''

  rows.forEach((r) => {
    const row = document.createElement('div')
    row.className = `res-row res-row--${r.status}`
    row.dataset.id = r.id

    const tableLabel = r.tableLabel ? `Table ${escHtml(r.tableLabel)}` : 'No table'

    row.innerHTML = `
      <div class="res-row-time">${_resFormatTime(r.time)}</div>
      <div class="res-row-info">
        <div class="res-row-name">${escHtml(r.customerName)} ${_resStatusBadge(r.status)}</div>
        <div class="res-row-meta">
          ${r.partySize} guests · ${tableLabel}
          ${r.customerPhone ? ` · <a href="tel:${escHtml(r.customerPhone)}" class="res-phone">${escHtml(r.customerPhone)}</a>` : ''}
          ${r.notes ? ` · <em class="res-notes">${escHtml(r.notes)}</em>` : ''}
        </div>
      </div>
      <div class="res-row-actions">
        ${r.status === 'confirmed' ? `<button class="btn btn-sm btn-success res-action" data-action="seated" data-id="${r.id}">Seated</button>` : ''}
        ${r.status === 'confirmed' || r.status === 'seated' ? `<button class="btn btn-sm btn-secondary res-action" data-action="no_show" data-id="${r.id}">No-show</button>` : ''}
        ${r.status !== 'cancelled' && r.status !== 'no_show' ? `<button class="btn btn-sm btn-secondary res-action" data-action="cancel" data-id="${r.id}">Cancel</button>` : ''}
        <button class="btn btn-sm btn-secondary res-action" data-action="edit" data-id="${r.id}" data-res='${JSON.stringify(r)}'>Edit</button>
      </div>
    `
    list.appendChild(row)
  })

  // Event delegation for action buttons
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('.res-action')
    if (!btn) return
    const { action, id } = btn.dataset
    if (action === 'edit') {
      const resData = JSON.parse(btn.dataset.res)
      openResModal(resData)
      return
    }
    const statusMap = { seated: 'seated', no_show: 'no_show', cancel: 'cancelled' }
    const newStatus = statusMap[action]
    if (!newStatus) return
    btn.disabled = true
    try {
      const res = await api(`/api/merchants/${state.merchantId}/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) throw new Error()
      loadReservations()
    } catch {
      showToast('Failed to update reservation', 'error')
      btn.disabled = false
    }
  }, { once: true })
}

/** Build table/group options for the modal <select> */
function _resTableOptions(selectedLabel) {
  const layout = state.profile?.tableLayout
  if (!layout) return ''
  const allTables = (layout.rooms ?? []).flatMap((r) => r.tables ?? [])
  const groups    = layout.groups ?? []
  let html = '<option value="">Unassigned</option>'
  allTables.forEach((t) => {
    const sel = t.label === selectedLabel ? ' selected' : ''
    html += `<option value="${escHtml(t.label)}"${sel}>${escHtml(t.label)} (${t.seats ?? 2} seats)</option>`
  })
  if (groups.length > 0) {
    html += '<optgroup label="Groups">'
    groups.forEach((g) => {
      if (!g.name) return
      const sel = g.name === selectedLabel ? ' selected' : ''
      html += `<option value="${escHtml(g.name)}"${sel}>${escHtml(g.name)} (${g.seats} seats)</option>`
    })
    html += '</optgroup>'
  }
  return html
}

/** @type {string|null} ID of reservation being edited, null for new */
let _resEditingId = null

function openResModal(resData) {
  _resEditingId = resData?.id ?? null
  const modal = document.getElementById('res-modal')
  if (!modal) return

  document.getElementById('res-modal-title').textContent = resData ? 'Edit Reservation' : 'New Reservation'
  document.getElementById('res-m-name').value  = resData?.customerName  ?? ''
  document.getElementById('res-m-phone').value = resData?.customerPhone ?? ''
  document.getElementById('res-m-email').value = resData?.customerEmail ?? ''
  document.getElementById('res-m-date').value  = resData?.date ?? _resDate
  document.getElementById('res-m-time').value  = resData?.time ?? ''
  document.getElementById('res-m-party').value = resData?.partySize ?? 2
  document.getElementById('res-m-notes').value = resData?.notes ?? ''
  document.getElementById('res-m-table').innerHTML = _resTableOptions(resData?.tableLabel ?? '')
  document.getElementById('res-m-error').hidden = true
  modal.hidden = false
  document.getElementById('res-m-name').focus()
}

function closeResModal() {
  const modal = document.getElementById('res-modal')
  if (modal) modal.hidden = true
  _resEditingId = null
}

async function saveReservation() {
  const nameVal  = document.getElementById('res-m-name')?.value.trim()
  const dateVal  = document.getElementById('res-m-date')?.value
  const timeVal  = document.getElementById('res-m-time')?.value
  const partyVal = parseInt(document.getElementById('res-m-party')?.value ?? '2', 10)

  const errEl = document.getElementById('res-m-error')
  if (!nameVal || !dateVal || !timeVal || isNaN(partyVal)) {
    errEl.textContent = 'Name, date, time and party size are required.'
    errEl.hidden = false
    return
  }

  const saveBtn = document.getElementById('res-m-save')
  saveBtn.disabled = true
  errEl.hidden = true

  const payload = {
    customerName:  nameVal,
    customerPhone: document.getElementById('res-m-phone')?.value.trim() || null,
    customerEmail: document.getElementById('res-m-email')?.value.trim() || null,
    date:          dateVal,
    time:          timeVal,
    partySize:     partyVal,
    tableLabel:    document.getElementById('res-m-table')?.value || null,
    notes:         document.getElementById('res-m-notes')?.value.trim() || null,
  }

  try {
    let res
    if (_resEditingId) {
      res = await api(`/api/merchants/${state.merchantId}/reservations/${_resEditingId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    } else {
      // Staff-created reservations bypass slot validation — use authenticated endpoint
      res = await api(`/api/merchants/${state.merchantId}/reservations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || 'Save failed')
    }
    closeResModal()
    loadReservations()
    showToast(_resEditingId ? 'Reservation updated' : 'Reservation created', 'success')
  } catch (err) {
    errEl.textContent = err.message || 'Failed to save reservation'
    errEl.hidden = false
    saveBtn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Table Layout Designer
// ---------------------------------------------------------------------------

/**
 * Data model:
 *   tableLayout = {
 *     rooms:  [{ id, name, tables: [{ id, label, shape, seats, x, y, rotation }] }],
 *     groups: [{ id, name, tableIds: string[], seats: number }]
 *   }
 *
 * shape: 'rect2' | 'rect4' | 'round'
 * seats: explicit seat count for capacity calculations
 * x, y: position in pixels from top-left of canvas
 */

/** Default seat count inferred from shape when none is stored */
function _seatsFromShape(shape) {
  return shape === 'rect2' ? 2 : 4
}

let tableLayoutState = {
  /** @type {{ id: string, name: string, tables: Array<{id:string,label:string,shape:string,seats:number,x:number,y:number,rotation:number}> }[]>} */
  rooms: [],
  /** @type {{ id: string, name: string, tableIds: string[], seats: number }[]} */
  groups: [],
  /** Index of the currently active room */
  activeRoomIdx: 0,
  /** ID of the currently selected table token (or null) */
  selectedTableId: null,
}

let _nextTableId = 1

function tlId() {
  return `tl_${Date.now()}_${_nextTableId++}`
}

/** Return the active room object, or null if no rooms */
function activeRoom() {
  return tableLayoutState.rooms[tableLayoutState.activeRoomIdx] ?? null
}

/** Return number of tables across all rooms (for default label numbering) */
function totalTableCount() {
  return tableLayoutState.rooms.reduce((n, r) => n + r.tables.length, 0)
}

function initTableLayout() {
  // Add room button
  document.getElementById('add-room-btn')?.addEventListener('click', () => {
    const roomNum = tableLayoutState.rooms.length + 1
    const room = { id: tlId(), name: `Room ${roomNum}`, tables: [] }
    tableLayoutState.rooms.push(room)
    tableLayoutState.activeRoomIdx = tableLayoutState.rooms.length - 1
    renderRoomTabs()
    renderCanvas()
  })

  // Table type buttons: add a new table to active room
  document.querySelectorAll('.layout-table-btn[data-shape]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = activeRoom()
      if (!room) {
        showToast('Add a room first', 'error')
        return
      }
      const shape = btn.dataset.shape
      const label = String(totalTableCount() + 1)
      const canvas = document.getElementById('layout-canvas')
      // Place near center with small random offset so tables don't stack
      const cx = Math.round(canvas.clientWidth / 2 - 48 + (Math.random() * 40 - 20))
      const cy = Math.round(160 + (Math.random() * 40 - 20))
      const table = { id: tlId(), label, shape, seats: _seatsFromShape(shape), rotation: 0, x: Math.max(8, cx), y: Math.max(8, cy) }
      room.tables.push(table)
      renderCanvas()
      selectTable(table.id)
    })
  })

  // Delete selected
  document.getElementById('layout-delete-selected')?.addEventListener('click', () => {
    const room = activeRoom()
    if (!room || !tableLayoutState.selectedTableId) return
    room.tables = room.tables.filter((t) => t.id !== tableLayoutState.selectedTableId)
    tableLayoutState.selectedTableId = null
    renderCanvas()
    updateTableEditor()
  })

  // Label apply button
  document.getElementById('layout-label-apply')?.addEventListener('click', applyTableLabel)
  document.getElementById('layout-table-label')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTableLabel()
  })
  // Live update: apply label to in-memory state and canvas token on each keystroke
  document.getElementById('layout-table-label')?.addEventListener('input', () => {
    const room = activeRoom()
    const id = tableLayoutState.selectedTableId
    if (!room || !id) return
    const table = room.tables.find((t) => t.id === id)
    if (!table) return
    const labelVal = document.getElementById('layout-table-label').value.trim()
    if (!labelVal) return
    table.label = labelVal
    const token = document.querySelector(`.layout-table[data-table-id="${id}"]`)
    if (token) {
      token.textContent = labelVal
      token.setAttribute('aria-label', `Table ${labelVal}`)
    }
  })
  // Live update: seats field
  document.getElementById('layout-table-seats')?.addEventListener('input', () => {
    const room = activeRoom()
    const id = tableLayoutState.selectedTableId
    if (!room || !id) return
    const table = room.tables.find((t) => t.id === id)
    if (!table) return
    const seatsVal = parseInt(document.getElementById('layout-table-seats').value, 10)
    if (!isNaN(seatsVal) && seatsVal >= 1) table.seats = seatsVal
  })

  // Rotate button
  document.getElementById('layout-rotate-btn')?.addEventListener('click', () => {
    const room = activeRoom()
    const id = tableLayoutState.selectedTableId
    if (!room || !id) return
    const table = room.tables.find((t) => t.id === id)
    if (!table || table.shape === 'round') return
    table.rotation = ((table.rotation ?? 0) + 90) % 180
    // Update transform on the existing DOM element — no full re-render needed
    const el = document.querySelector(`.layout-table[data-table-id="${id}"]`)
    if (el) el.style.transform = table.rotation ? `rotate(${table.rotation}deg)` : ''
  })

  // Save layout
  document.getElementById('save-layout-btn')?.addEventListener('click', saveTableLayout)

  // Deselect on canvas background click
  document.getElementById('layout-canvas')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('layout-canvas')) {
      selectTable(null)
    }
  })

  // Add group button
  document.getElementById('layout-add-group-btn')?.addEventListener('click', () => {
    const allTables = tableLayoutState.rooms.flatMap((r) => r.tables)
    if (allTables.length === 0) {
      showToast('Add tables before creating groups', 'error')
      return
    }
    const group = { id: tlId(), name: '', tableIds: [], seats: 0 }
    tableLayoutState.groups.push(group)
    renderGroups()
  })
}

function applyTableLabel() {
  const room = activeRoom()
  const id = tableLayoutState.selectedTableId
  if (!room || !id) return
  const table = room.tables.find((t) => t.id === id)
  if (!table) return
  const labelVal = document.getElementById('layout-table-label').value.trim()
  if (labelVal) table.label = labelVal
  const seatsVal = parseInt(document.getElementById('layout-table-seats')?.value ?? '', 10)
  if (!isNaN(seatsVal) && seatsVal >= 1) table.seats = seatsVal
  // Update the canvas token directly — avoids full re-render which can lose changes
  const token = document.querySelector(`.layout-table[data-table-id="${id}"]`)
  if (token) {
    token.textContent = table.label
    token.setAttribute('aria-label', `Table ${table.label}`)
  }
  updateTableEditor()
  updateDeleteBtn()
  renderGroups()
  saveTableLayout()
}

/** Load layout from API data into state and re-render */
function loadTableLayout(layout) {
  if (layout && Array.isArray(layout.rooms) && layout.rooms.length > 0) {
    // Migrate old tables that lack a seats field
    tableLayoutState.rooms = layout.rooms.map((room) => ({
      ...room,
      tables: (room.tables ?? []).map((t) => ({
        ...t,
        seats: t.seats ?? _seatsFromShape(t.shape),
      })),
    }))
    tableLayoutState.activeRoomIdx = 0
    tableLayoutState.selectedTableId = null
  } else {
    // Default: one empty room
    tableLayoutState.rooms = [{ id: tlId(), name: 'Room 1', tables: [] }]
    tableLayoutState.activeRoomIdx = 0
    tableLayoutState.selectedTableId = null
  }
  tableLayoutState.groups = Array.isArray(layout?.groups) ? layout.groups : []
  renderRoomTabs()
  renderCanvas()
  renderGroups()
}

async function saveTableLayout() {
  const btn = document.getElementById('save-layout-btn')
  btn.disabled = true
  btn.textContent = 'Saving…'
  try {
    const res = await api(`/api/merchants/${state.merchantId}`, {
      method: 'PUT',
      body: JSON.stringify({
        tableLayout: {
          rooms: tableLayoutState.rooms,
          groups: tableLayoutState.groups,
        },
      }),
    })
    if (!res.ok) throw new Error('Save failed')
    showToast('Table layout saved', 'success')
  } catch {
    showToast('Failed to save layout', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Layout'
  }
}

/** Render the room tab strip */
function renderRoomTabs() {
  const strip = document.getElementById('layout-room-tabs')
  strip.innerHTML = ''

  tableLayoutState.rooms.forEach((room, idx) => {
    const tab = document.createElement('div')
    tab.className = `layout-room-tab${idx === tableLayoutState.activeRoomIdx ? ' active' : ''}`
    tab.dataset.idx = idx
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(idx === tableLayoutState.activeRoomIdx))
    tab.tabIndex = 0

    // Editable room name
    const nameSpan = document.createElement('span')
    nameSpan.className = 'layout-room-tab-name'
    nameSpan.contentEditable = 'true'
    nameSpan.textContent = room.name
    nameSpan.addEventListener('input', () => {
      room.name = nameSpan.textContent.trim() || room.name
    })
    nameSpan.addEventListener('click', (e) => e.stopPropagation())
    nameSpan.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameSpan.blur() }
    })

    // Delete button (hidden for the last room)
    const delBtn = document.createElement('button')
    delBtn.className = 'layout-room-tab-delete'
    delBtn.innerHTML = '&times;'
    delBtn.setAttribute('aria-label', `Delete ${room.name}`)
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (tableLayoutState.rooms.length === 1) {
        showToast('At least one room is required', 'error')
        return
      }
      tableLayoutState.rooms.splice(idx, 1)
      tableLayoutState.activeRoomIdx = Math.min(tableLayoutState.activeRoomIdx, tableLayoutState.rooms.length - 1)
      tableLayoutState.selectedTableId = null
      renderRoomTabs()
      renderCanvas()
    })

    tab.appendChild(nameSpan)
    tab.appendChild(delBtn)

    tab.addEventListener('click', () => {
      tableLayoutState.activeRoomIdx = idx
      tableLayoutState.selectedTableId = null
      renderRoomTabs()
      renderCanvas()
      updateTableEditor()
    })
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tab.click() }
    })

    strip.appendChild(tab)
  })
}

/** Render all table tokens for the active room */
function renderCanvas() {
  const canvas = document.getElementById('layout-canvas')
  const empty = document.getElementById('layout-empty')
  if (!canvas) return

  // Remove old tokens
  canvas.querySelectorAll('.layout-table').forEach((el) => el.remove())

  const room = activeRoom()
  const hasTables = room && room.tables.length > 0
  empty.hidden = hasTables

  if (!room) return

  room.tables.forEach((table) => {
    const el = document.createElement('div')
    el.className = `layout-table${table.id === tableLayoutState.selectedTableId ? ' selected' : ''}`
    el.dataset.tableId = table.id
    el.dataset.shape = table.shape
    el.textContent = table.label
    el.style.left = `${table.x}px`
    el.style.top = `${table.y}px`
    if (table.rotation) el.style.transform = `rotate(${table.rotation}deg)`
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-label', `Table ${table.label}`)

    // Select on click
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      selectTable(table.id)
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTable(table.id) }
    })

    // Drag to reposition
    wireTableDrag(el, table)

    canvas.appendChild(el)
  })

  updateTableEditor()
  updateDeleteBtn()
}

/**
 * Select a table by ID.
 * Updates CSS classes on existing DOM elements instead of re-rendering,
 * so pointer capture and drag handlers on the moved element are preserved.
 */
function selectTable(id) {
  tableLayoutState.selectedTableId = id
  // Update .selected class on existing tokens — do NOT call renderCanvas()
  const canvas = document.getElementById('layout-canvas')
  canvas?.querySelectorAll('.layout-table').forEach((el) => {
    el.classList.toggle('selected', el.dataset.tableId === id)
  })
  updateTableEditor()
  updateDeleteBtn()
}

function updateTableEditor() {
  const editor = document.getElementById('layout-table-editor')
  const input = document.getElementById('layout-table-label')
  const seatsInput = document.getElementById('layout-table-seats')
  const rotateBtn = document.getElementById('layout-rotate-btn')
  const room = activeRoom()
  const id = tableLayoutState.selectedTableId
  const table = room?.tables.find((t) => t.id === id) ?? null

  if (table) {
    editor.hidden = false
    input.value = table.label
    if (seatsInput) seatsInput.value = table.seats ?? _seatsFromShape(table.shape)
    if (rotateBtn) rotateBtn.hidden = (table.shape === 'round')
  } else {
    editor.hidden = true
  }
  updateDeleteBtn()
}

function updateDeleteBtn() {
  const btn = document.getElementById('layout-delete-selected')
  if (btn) btn.hidden = !tableLayoutState.selectedTableId
}

/** Render the Table Groups list */
function renderGroups() {
  const container = document.getElementById('layout-groups-list')
  if (!container) return
  container.innerHTML = ''

  // Build a flat map of all tables across all rooms for label lookup
  const allTables = tableLayoutState.rooms.flatMap((r) => r.tables)

  if (tableLayoutState.groups.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'layout-groups-empty'
    empty.textContent = 'No groups yet. Groups let large parties be seated across combined tables.'
    container.appendChild(empty)
    return
  }

  tableLayoutState.groups.forEach((group, idx) => {
    const row = document.createElement('div')
    row.className = 'layout-group-row'

    // Group name input
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.className = 'input layout-group-name'
    nameInput.placeholder = 'Group name (e.g. Patio 1+2)'
    nameInput.maxLength = 40
    nameInput.value = group.name
    nameInput.addEventListener('input', () => { group.name = nameInput.value })

    // Seats input (auto-computes from selected tables but overridable)
    const seatsInput = document.createElement('input')
    seatsInput.type = 'number'
    seatsInput.className = 'input layout-group-seats'
    seatsInput.min = '1'
    seatsInput.max = '999'
    seatsInput.step = '1'
    seatsInput.title = 'Total seats when all tables are combined'
    seatsInput.value = group.seats || ''
    seatsInput.placeholder = 'Seats'
    seatsInput.addEventListener('input', () => {
      const v = parseInt(seatsInput.value, 10)
      group.seats = isNaN(v) ? 0 : v
    })

    // Table checkboxes
    const tablesWrap = document.createElement('div')
    tablesWrap.className = 'layout-group-tables'

    /** Recompute seats from checked tables */
    const recomputeSeats = () => {
      const checked = allTables.filter((t) => group.tableIds.includes(t.id))
      const computed = checked.reduce((n, t) => n + (t.seats ?? _seatsFromShape(t.shape)), 0)
      if (computed > 0) {
        group.seats = computed
        seatsInput.value = computed
      }
    }

    allTables.forEach((t) => {
      const label = document.createElement('label')
      label.className = 'layout-group-table-check'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = t.id
      cb.checked = group.tableIds.includes(t.id)
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (!group.tableIds.includes(t.id)) group.tableIds.push(t.id)
        } else {
          group.tableIds = group.tableIds.filter((id) => id !== t.id)
        }
        recomputeSeats()
      })
      label.appendChild(cb)
      label.appendChild(document.createTextNode(` ${t.label}`))
      tablesWrap.appendChild(label)
    })

    // Delete group button
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'btn btn-danger btn-sm layout-group-del'
    delBtn.setAttribute('aria-label', 'Delete group')
    delBtn.innerHTML = '&times;'
    delBtn.addEventListener('click', () => {
      tableLayoutState.groups.splice(idx, 1)
      renderGroups()
    })

    row.appendChild(nameInput)
    row.appendChild(seatsInput)
    row.appendChild(tablesWrap)
    row.appendChild(delBtn)
    container.appendChild(row)
  })
}

/** Wire pointer-based drag for a table token element */
function wireTableDrag(el, table) {
  let startX, startY, startLeft, startTop, dragging = false

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    el.setPointerCapture(e.pointerId)
    dragging = true
    startX = e.clientX
    startY = e.clientY
    startLeft = table.x
    startTop = table.y
    el.classList.add('dragging')
    selectTable(table.id)
  })

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const canvas = document.getElementById('layout-canvas')
    // When rotated 90°, visual footprint swaps width↔height
    const rotated = (table.rotation ?? 0) % 180 !== 0
    const visW = rotated ? el.offsetHeight : el.offsetWidth
    const visH = rotated ? el.offsetWidth : el.offsetHeight
    const maxX = canvas.clientWidth - visW - 4
    const maxY = canvas.clientHeight - visH - 4
    table.x = Math.max(4, Math.min(maxX, startLeft + (e.clientX - startX)))
    table.y = Math.max(4, Math.min(maxY, startTop + (e.clientY - startY)))
    el.style.left = `${table.x}px`
    el.style.top = `${table.y}px`
  })

  el.addEventListener('pointerup', () => {
    dragging = false
    el.classList.remove('dragging')
  })
}

/** Minimal HTML escape to prevent XSS from order data */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// =============================================================================
// EMPLOYEE MANAGEMENT
// =============================================================================

const SCHEDULE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const SCHEDULE_DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }

/** In-memory employee list */
let employeeList = []

/** Loads employees from API and renders the list */
async function loadEmployees() {
  const loading = document.getElementById('employees-loading')
  const empty   = document.getElementById('employees-empty')
  const list    = document.getElementById('employees-list')

  loading.hidden = false
  empty.hidden   = true
  list.hidden    = true

  try {
    const res = await api(`/api/merchants/${state.merchantId}/employees`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    employeeList = data.employees ?? []
    renderEmployeeList()
  } catch (err) {
    showToast('Failed to load employees', 'error')
  } finally {
    loading.hidden = true
  }
}

function renderEmployeeList() {
  const empty = document.getElementById('employees-empty')
  const list  = document.getElementById('employees-list')

  if (employeeList.length === 0) {
    empty.hidden = false
    list.hidden  = true
    return
  }

  empty.hidden = false
  list.hidden  = false
  empty.hidden = true

  list.innerHTML = employeeList.map(emp => {
    const initials = emp.nickname.slice(0, 2).toUpperCase()
    const inactive = emp.active ? '' : 'employee-card--inactive'
    return `
      <li class="employee-card ${inactive}" data-id="${escHtml(emp.id)}">
        <div class="employee-avatar">${escHtml(initials)}</div>
        <div class="employee-info">
          <span class="employee-name">${escHtml(emp.nickname)}</span>
          <span class="employee-role-badge ${escHtml(emp.role)}">${escHtml(emp.role)}</span>
          ${!emp.active ? '<span class="employee-inactive-tag">Inactive</span>' : ''}
        </div>
        <div class="employee-card-actions">
          <button class="btn btn-secondary btn-sm emp-edit-btn" data-id="${escHtml(emp.id)}" aria-label="Edit ${escHtml(emp.nickname)}">Edit</button>
          <button class="btn btn-sm emp-delete-btn" style="background:rgba(220,38,38,0.1);color:#dc2626;border:1px solid rgba(220,38,38,0.2)" data-id="${escHtml(emp.id)}" aria-label="Delete ${escHtml(emp.nickname)}">Delete</button>
        </div>
      </li>`
  }).join('')

  list.querySelectorAll('.emp-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEmployeeForm(btn.dataset.id))
  })
  list.querySelectorAll('.emp-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteEmployee(btn.dataset.id))
  })
}

/** Builds the 7-day schedule grid inside the form */
function buildScheduleGrid(schedule) {
  const grid = document.getElementById('emp-schedule-grid')
  grid.innerHTML = SCHEDULE_DAYS.map(day => {
    const slot = schedule?.[day] ?? null
    return `
      <div class="emp-schedule-row" data-day="${day}">
        <span class="emp-schedule-day">${SCHEDULE_DAY_LABELS[day]}</span>
        <input type="time" class="emp-schedule-time emp-schedule-start" data-day="${day}"
               value="${slot?.start ?? ''}" placeholder="Start">
        <input type="time" class="emp-schedule-time emp-schedule-end" data-day="${day}"
               value="${slot?.end ?? ''}" placeholder="End">
      </div>`
  }).join('')
}

/** Reads the schedule grid values and returns a schedule object */
function readScheduleGrid() {
  const schedule = {}
  SCHEDULE_DAYS.forEach(day => {
    const start = document.querySelector(`.emp-schedule-start[data-day="${day}"]`)?.value ?? ''
    const end   = document.querySelector(`.emp-schedule-end[data-day="${day}"]`)?.value ?? ''
    schedule[day] = (start || end) ? { start, end } : null
  })
  return schedule
}

/** Opens the employee add/edit form */
function openEmployeeForm(empId = null) {
  const modal     = document.getElementById('emp-form-modal')
  const backdrop  = document.getElementById('emp-form-backdrop')
  const title     = document.getElementById('emp-form-title')
  const idInput   = document.getElementById('emp-form-id')
  const nickname  = document.getElementById('emp-form-nickname')
  const code      = document.getElementById('emp-form-code')
  const role      = document.getElementById('emp-form-role')
  const activeRow = document.getElementById('emp-form-active-row')
  const activeChk = document.getElementById('emp-form-active')

  const codeHint  = code.nextElementSibling

  if (empId) {
    const emp = employeeList.find(e => e.id === empId)
    if (!emp) return
    title.textContent     = 'Edit Employee'
    idInput.value         = emp.id
    nickname.value        = emp.nickname
    code.value            = ''
    code.placeholder      = '(leave blank to keep current code)'
    role.value            = emp.role
    activeRow.hidden      = false
    activeChk.checked     = emp.active
    codeHint.hidden       = false
    buildScheduleGrid(emp.schedule)
  } else {
    title.textContent     = 'Add Employee'
    idInput.value         = ''
    nickname.value        = ''
    code.value            = ''
    code.placeholder      = 'e.g. 1234'
    role.value            = 'server'
    activeRow.hidden      = true
    activeChk.checked     = true
    codeHint.hidden       = true
    buildScheduleGrid(null)
  }

  modal.hidden    = false
  backdrop.hidden = false
  nickname.focus()
}

function closeEmployeeForm() {
  document.getElementById('emp-form-modal').hidden   = true
  document.getElementById('emp-form-backdrop').hidden = true
}

async function saveEmployee() {
  const empId    = document.getElementById('emp-form-id').value.trim()
  const nickname = document.getElementById('emp-form-nickname').value.trim()
  const code     = document.getElementById('emp-form-code').value.trim()
  const role     = document.getElementById('emp-form-role').value
  const active   = document.getElementById('emp-form-active').checked
  const schedule = readScheduleGrid()

  if (!nickname) { showToast('Nickname is required', 'error'); return }
  if (!empId && !/^\d{4}$/.test(code)) { showToast('Access code must be exactly 4 digits', 'error'); return }
  if (empId && code && !/^\d{4}$/.test(code)) { showToast('Access code must be exactly 4 digits', 'error'); return }

  const saveBtn = document.getElementById('emp-form-save')
  saveBtn.disabled = true

  try {
    let res
    if (empId) {
      const body = { nickname, role, schedule, active }
      if (code) body.accessCode = code
      res = await api(`/api/merchants/${state.merchantId}/employees/${empId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    } else {
      res = await api(`/api/merchants/${state.merchantId}/employees`, {
        method: 'POST',
        body: JSON.stringify({ nickname, accessCode: code, role, schedule }),
      })
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }

    closeEmployeeForm()
    await loadEmployees()
    showToast(empId ? 'Employee updated' : 'Employee added', 'success')
  } catch (err) {
    showToast(err.message || 'Save failed', 'error')
  } finally {
    saveBtn.disabled = false
  }
}

async function deleteEmployee(empId) {
  const emp = employeeList.find(e => e.id === empId)
  if (!emp) return
  if (!confirm(`Delete ${emp.nickname}? This cannot be undone.`)) return

  try {
    const res = await api(`/api/merchants/${state.merchantId}/employees/${empId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await loadEmployees()
    showToast('Employee deleted', 'success')
  } catch (err) {
    showToast('Delete failed', 'error')
  }
}

/** Binds all employee management UI events */
function initEmployees() {
  document.getElementById('add-employee-btn')?.addEventListener('click', () => openEmployeeForm())
  document.getElementById('emp-form-close')?.addEventListener('click', closeEmployeeForm)
  document.getElementById('emp-form-cancel')?.addEventListener('click', closeEmployeeForm)
  document.getElementById('emp-form-save')?.addEventListener('click', saveEmployee)

  // Click outside the inner box to close (the overlay IS the backdrop)
  document.getElementById('emp-form-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('emp-form-modal')) closeEmployeeForm()
  })

  // Load employees when switching to employees section
  document.addEventListener('section:employees', () => loadEmployees())
}

// =============================================================================
// EMPLOYEE MODE — PIN overlay
// =============================================================================

/** Restores employee mode state from localStorage on boot */
function initEmployeeMode() {
  state.employeeMode = localStorage.getItem('employeeMode') === 'true'

  // Sync toggle button state
  const toggle = document.getElementById('emp-mode-toggle')
  if (toggle) toggle.setAttribute('aria-checked', String(state.employeeMode))

  toggle?.addEventListener('click', () => {
    state.employeeMode = !state.employeeMode
    localStorage.setItem('employeeMode', String(state.employeeMode))
    toggle.setAttribute('aria-checked', String(state.employeeMode))
    if (state.employeeMode) {
      showPinOverlay()
    } else {
      hidePinOverlay()
      clearCurrentEmployee()
    }
    showToast(state.employeeMode ? 'Employee mode enabled' : 'Employee mode disabled', 'success')
  })

  // Topbar clock-out button (servers/managers)
  document.getElementById('emp-topbar-clockout-btn')?.addEventListener('click', () => {
    if (state.currentEmployee) openClockModal(state.currentEmployee, true)
  })

  // Sidebar "Return to Keypad" button — locks the screen without clocking out
  // The shift stays open in the DB; re-entering the PIN resumes the session
  document.getElementById('emp-return-keypad-btn')?.addEventListener('click', () => {
    clearCurrentEmployee()
    if (state.employeeMode) showPinOverlay()
  })

  // Set merchant name in PIN overlay from profile (when available)
  document.addEventListener('profile:loaded', (e) => {
    const logo = document.getElementById('emp-pin-logo')
    if (logo && e.detail?.businessName) logo.textContent = e.detail.businessName
  })

  // Show PIN overlay if employee mode is active on load
  if (state.employeeMode) showPinOverlay()

  // Bind keypad
  initPinKeypad()

  // Periodic token refresh in employee mode (every 10 min)
  setInterval(() => {
    if (state.employeeMode) refreshAccessToken()
  }, 10 * 60 * 1000)
}

// --- PIN keypad logic -------------------------------------------------------

let pinBuffer = ''

function initPinKeypad() {
  document.querySelectorAll('.emp-pin-key').forEach(key => {
    key.addEventListener('click', () => {
      const k = key.dataset.key
      if (k === 'clear') {
        pinBuffer = pinBuffer.slice(0, -1)
      } else if (/^\d$/.test(k) && pinBuffer.length < 4) {
        pinBuffer += k
      }
      updatePinDots()
      if (pinBuffer.length === 4) submitPin()
    })
  })

  // Also support physical keyboard when overlay is visible
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('emp-pin-overlay').hidden) return
    if (/^\d$/.test(e.key) && pinBuffer.length < 4) {
      pinBuffer += e.key
      updatePinDots()
      if (pinBuffer.length === 4) submitPin()
    } else if (e.key === 'Backspace') {
      pinBuffer = pinBuffer.slice(0, -1)
      updatePinDots()
    }
  })
}

function updatePinDots() {
  document.querySelectorAll('.emp-pin-dot').forEach((dot, i) => {
    dot.classList.toggle('filled', i < pinBuffer.length)
  })
}

async function submitPin() {
  const code = pinBuffer
  pinBuffer = ''
  updatePinDots()

  try {
    const res = await api(`/api/merchants/${state.merchantId}/employees/authenticate`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    })

    if (!res.ok) {
      showPinError('Invalid code')
      return
    }

    const data = await res.json()
    const { employee, clockedIn, openShiftId } = data

    hidePinError()

    const emp = { ...employee, openShiftId: clockedIn ? openShiftId : null }

    if (clockedIn && employee.role !== 'chef') {
      // Server / manager returning from a locked screen — resume session directly
      setCurrentEmployee(emp)
      hidePinOverlay()
    } else {
      // Not clocked in (first use today, or after explicit clock-out) → clock-in modal
      // Chef clocked in → clock-out modal (chefs use PIN to clock out)
      openClockModal(emp, clockedIn)
    }
  } catch {
    showPinError('Error — try again')
  }
}

function showPinError(msg) {
  const el = document.getElementById('emp-pin-error')
  el.textContent = msg
  el.hidden = false
  setTimeout(() => { el.hidden = true }, 2500)
}

function hidePinError() {
  document.getElementById('emp-pin-error').hidden = true
}

function showPinOverlay() {
  pinBuffer = ''
  updatePinDots()
  hidePinError()
  document.getElementById('emp-pin-overlay').hidden = false
}

function hidePinOverlay() {
  document.getElementById('emp-pin-overlay').hidden = true
  pinBuffer = ''
  updatePinDots()
}

// --- Clock In/Out modal -----------------------------------------------------

/**
 * @param {object} employee  - { id, nickname, role, openShiftId }
 * @param {boolean} isOut    - true = clock out, false = clock in
 */
function openClockModal(employee, isOut) {
  const modal    = document.getElementById('emp-clock-modal')
  const backdrop = document.getElementById('emp-clock-backdrop')
  const icon     = document.getElementById('emp-clock-icon')
  const title    = document.getElementById('emp-clock-title')
  const name     = document.getElementById('emp-clock-name')
  const time     = document.getElementById('emp-clock-time')
  const worked   = document.getElementById('emp-clock-worked')
  const confirm  = document.getElementById('emp-clock-confirm')
  const cancel   = document.getElementById('emp-clock-cancel')

  icon.textContent  = isOut ? '🔴' : '🟢'
  title.textContent = isOut ? 'Clock Out' : 'Clock In'
  name.textContent  = employee.nickname
  time.textContent  = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  // Worked-today + sales summary: only shown on clock-out
  worked.hidden = true
  worked.textContent = ''
  const salesEl = document.getElementById('emp-clock-sales')
  if (salesEl) salesEl.hidden = true

  if (isOut && state.merchantId) {
    const today = new Date().toISOString().slice(0, 10)

    // Hours worked today
    api(`/api/merchants/${state.merchantId}/timesheets?from=${today}&to=${today}&employeeId=${employee.id}`)
      .then(r => r.json())
      .then(data => {
        const entries = data.timesheets ?? []
        const now = Date.now()
        let totalMs = 0
        for (const e of entries) {
          const inMs  = new Date(e.clockIn.endsWith('Z') ? e.clockIn : e.clockIn + 'Z').getTime()
          const outMs = e.clockOut
            ? new Date(e.clockOut.endsWith('Z') ? e.clockOut : e.clockOut + 'Z').getTime()
            : now
          totalMs += Math.max(0, outMs - inMs)
        }
        const totalMin = Math.round(totalMs / 60000)
        const h   = Math.floor(totalMin / 60)
        const min = totalMin % 60
        worked.textContent = h > 0 ? `${h}h ${min}m worked today` : `${min}m worked today`
        worked.hidden = false
      })
      .catch(() => {})

    // Sales collected today and over the last 14 days
    api(`/api/merchants/${state.merchantId}/employees/${employee.id}/sales`)
      .then(r => r.json())
      .then(data => {
        const fmt = (n) => formatPrice(n ?? 0)
        const orderLabel = (n) => `${n} order${n !== 1 ? 's' : ''}`

        document.getElementById('emp-sales-today-total').textContent = fmt(data.today?.totalCents)
        document.getElementById('emp-sales-today-count').textContent = orderLabel(data.today?.orderCount ?? 0)
        document.getElementById('emp-sales-fort-total').textContent  = fmt(data.fortnight?.totalCents)
        document.getElementById('emp-sales-fort-count').textContent  = orderLabel(data.fortnight?.orderCount ?? 0)

        // Tips — only shown when non-zero
        const todayTips = data.today?.tipsCents ?? 0
        const fortTips  = data.fortnight?.tipsCents ?? 0
        const todayTipsEl = document.getElementById('emp-sales-today-tips')
        const fortTipsEl  = document.getElementById('emp-sales-fort-tips')
        if (todayTipsEl) {
          todayTipsEl.textContent = `${fmt(todayTips)} tips`
          todayTipsEl.hidden = todayTips === 0
        }
        if (fortTipsEl) {
          fortTipsEl.textContent = `${fmt(fortTips)} tips`
          fortTipsEl.hidden = fortTips === 0
        }

        if (salesEl) salesEl.hidden = false
      })
      .catch(() => {})
  }

  modal.hidden    = false
  backdrop.hidden = false

  // Replace both buttons on every open to get fresh, stale-listener-free elements

  const newConfirm = confirm.cloneNode(true)
  confirm.parentNode.replaceChild(newConfirm, confirm)
  newConfirm.disabled    = false
  newConfirm.textContent = isOut ? 'Clock Out' : 'Clock In'
  newConfirm.className   = 'btn'
  newConfirm.style.cssText = isOut
    ? 'background:rgba(220,38,38,0.15);color:#dc2626;border:1px solid rgba(220,38,38,0.3)'
    : 'background:#16a34a;color:#fff;border:1px solid #16a34a'
  newConfirm.addEventListener('click', async () => {
    newConfirm.disabled = true
    try {
      if (isOut) {
        await clockOut(employee)
      } else {
        await clockIn(employee)
      }
      closeClockModal()
    } catch (err) {
      showToast(err.message || 'Failed', 'error')
      newConfirm.disabled = false
    }
  })

  const newCancel = cancel.cloneNode(true)
  cancel.parentNode.replaceChild(newCancel, cancel)
  newCancel.addEventListener('click', () => {
    closeClockModal()
    // Return to PIN if in employee mode and nobody is logged in
    if (state.employeeMode && !state.currentEmployee) showPinOverlay()
  })
}

function closeClockModal() {
  document.getElementById('emp-clock-modal').hidden    = true
  document.getElementById('emp-clock-backdrop').hidden = true
  const worked = document.getElementById('emp-clock-worked')
  if (worked) { worked.hidden = true; worked.textContent = '' }
  const sales = document.getElementById('emp-clock-sales')
  if (sales) sales.hidden = true
}

// Click outside the inner clock box — same behaviour as cancel
document.getElementById('emp-clock-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('emp-clock-modal')) {
    closeClockModal()
    if (state.employeeMode && !state.currentEmployee) showPinOverlay()
  }
})

async function clockIn(employee) {
  const res = await api(`/api/merchants/${state.merchantId}/employees/${employee.id}/clock-in`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Clock-in failed')
  }
  const data = await res.json()

  showToast(`${employee.nickname} clocked in`, 'success')

  if (employee.role === 'chef') {
    // Kitchen: return to PIN overlay — chef doesn't use the app UI
    clearCurrentEmployee()
    if (state.employeeMode) showPinOverlay()
  } else {
    // Server / manager: activate session and show the app
    setCurrentEmployee({ ...employee, openShiftId: data.shiftId })
    hidePinOverlay()
  }
}

async function clockOut(employee) {
  const res = await api(`/api/merchants/${state.merchantId}/employees/${employee.id}/clock-out`, {
    method: 'POST',
    body: JSON.stringify({ shiftId: employee.openShiftId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Clock-out failed')
  }

  showToast(`${employee.nickname} clocked out`, 'success')
  clearCurrentEmployee()

  if (state.employeeMode) showPinOverlay()
}

/** Sets the active employee and updates the topbar chip */
function setCurrentEmployee(emp) {
  state.currentEmployee = emp

  const chip            = document.getElementById('emp-topbar-chip')
  const nameEl          = document.getElementById('emp-topbar-name')
  const clockBtn        = document.getElementById('emp-topbar-clockout-btn')
  const returnKeypadBtn = document.getElementById('emp-return-keypad-btn')

  nameEl.textContent = emp.nickname
  chip.hidden        = false

  // Only servers and managers see the clock-out button in the topbar
  clockBtn.hidden = emp.role === 'chef'

  // Sidebar "Return to Keypad" is visible for servers and managers (not chefs)
  if (returnKeypadBtn) returnKeypadBtn.hidden = emp.role === 'chef'

  // Apply nav restrictions based on role
  applyNavRestrictions(emp.role)

  // Redirect to orders if the current section is now off-limits
  if (emp.role === 'server' && !SERVER_SECTIONS.has(state.activeSection)) {
    showSection('orders')
  }

  // Expose to order-entry.js
  window.currentEmployee = emp
}

/** Clears the active employee session */
function clearCurrentEmployee() {
  state.currentEmployee = null
  document.getElementById('emp-topbar-chip').hidden = true
  const returnKeypadBtn = document.getElementById('emp-return-keypad-btn')
  if (returnKeypadBtn) returnKeypadBtn.hidden = true
  window.currentEmployee = null
  // Restore full nav (admin view)
  applyNavRestrictions(null)
}

/** Silently refreshes the admin access token to keep employee mode alive */
async function refreshAccessToken() {
  try {
    const refreshToken = localStorage.getItem('refreshToken')
    if (!refreshToken) return
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) return
    const data = await res.json()
    if (data.accessToken) {
      state.accessToken = data.accessToken
      localStorage.setItem('accessToken', data.accessToken)
    }
    if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken)
  } catch {
    // Silent — don't disrupt employee mode on refresh failure
  }
}

// =============================================================================
// TIMESHEET
// =============================================================================

function initTimesheet() {
  const today = new Date().toISOString().slice(0, 10)
  const fromInput = document.getElementById('ts-date-from')
  const toInput   = document.getElementById('ts-date-to')
  if (fromInput) fromInput.value = today
  if (toInput)   toInput.value   = today

  document.getElementById('ts-apply-btn')?.addEventListener('click', loadTimesheet)
  document.getElementById('ts-filter-apply')?.addEventListener('click', loadTimesheet)

  document.addEventListener('section:timesheet', () => loadTimesheet())
}

async function loadTimesheet() {
  const from = document.getElementById('ts-date-from')?.value
  const to   = document.getElementById('ts-date-to')?.value || from

  const loading = document.getElementById('ts-loading')
  const empty   = document.getElementById('ts-empty')
  const table   = document.getElementById('ts-table')

  loading.hidden = false
  empty.hidden   = true
  table.hidden   = true

  try {
    const params = new URLSearchParams({ from, to })
    const res = await api(`/api/merchants/${state.merchantId}/timesheets?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    renderTimesheet(data.timesheets)
  } catch {
    showToast('Failed to load timesheet', 'error')
  } finally {
    loading.hidden = true
  }
}

function renderTimesheet(rows) {
  const empty = document.getElementById('ts-empty')
  const table = document.getElementById('ts-table')
  const tbody = document.getElementById('ts-tbody')

  if (!rows.length) {
    empty.hidden = false
    table.hidden = true
    return
  }

  empty.hidden = false
  table.hidden = false
  empty.hidden = true

  tbody.innerHTML = rows.map(r => {
    const clockIn  = r.clockIn  ? new Date(r.clockIn  + (r.clockIn.includes('Z') ? '' : 'Z')) : null
    const clockOut = r.clockOut ? new Date(r.clockOut + (r.clockOut.includes('Z') ? '' : 'Z')) : null
    const fmtTime  = (d) => d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'

    let hours = ''
    if (clockIn && clockOut) {
      const diffMin = Math.round((clockOut - clockIn) / 60000)
      hours = `${Math.floor(diffMin / 60)}h ${diffMin % 60}m`
    } else if (clockIn) {
      hours = '<span class="ts-clocked-in">In progress</span>'
    }

    return `<tr>
      <td>${escHtml(r.nickname)}</td>
      <td><span class="employee-role-badge ${escHtml(r.role)}">${escHtml(r.role)}</span></td>
      <td>${escHtml(r.date)}</td>
      <td>${fmtTime(clockIn)}</td>
      <td>${clockOut ? fmtTime(clockOut) : '<span class="ts-clocked-in">Active</span>'}</td>
      <td>${hours}</td>
    </tr>`
  }).join('')
}


// =============================================================================
// REPORTS
// =============================================================================

/** @type {{ activeTab: 'sales'|'shifts'|'tips', from: string, to: string }} */
const reportsState = {
  activeTab: 'sales',
  from: '',
  to: '',
}

/**
 * Compute a pay period date range given merchant profile settings.
 * @param {'current'|'last'} which
 * @returns {{ from: string, to: string }}
 */
function computePayPeriod(which) {
  const profile = state.profile
  const type    = profile?.payPeriodType ?? 'biweekly'
  const today   = new Date()
  const fmtDate = (d) => d.toLocaleDateString('sv')

  if (type === 'semimonthly') {
    const year  = today.getFullYear()
    const month = today.getMonth()
    const day   = today.getDate()

    let fromDate, toDate
    if (day <= 15) {
      fromDate = new Date(year, month, 1)
      toDate   = new Date(year, month, 15)
    } else {
      fromDate = new Date(year, month, 16)
      toDate   = new Date(year, month + 1, 0)
    }

    if (which === 'last') {
      if (day <= 15) {
        toDate   = new Date(year, month, 0)
        fromDate = new Date(toDate.getFullYear(), toDate.getMonth(), 16)
      } else {
        fromDate = new Date(year, month, 1)
        toDate   = new Date(year, month, 15)
      }
    }
    return { from: fmtDate(fromDate), to: fmtDate(toDate) }
  }

  // Biweekly: anchor date + 14-day cycles (use local midnight, not UTC)
  const anchorStr = profile?.payPeriodAnchor ?? '2026-01-02'
  const [ay, am, ad] = anchorStr.split('-').map(Number)
  const anchor    = new Date(ay, am - 1, ad)
  const now       = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const diffDays  = Math.floor((now.getTime() - anchor.getTime()) / 86400000)
  const periodIdx = Math.floor(diffDays / 14)
  const idx       = which === 'current' ? periodIdx : periodIdx - 1
  const fromMs    = anchor.getTime() + idx * 14 * 86400000
  const toMs      = fromMs  + 13 * 86400000

  return { from: fmtDate(new Date(fromMs)), to: fmtDate(new Date(toMs)) }
}

// Report date helpers — use browser-local time (staff are at the restaurant)
function rptTodayStr() { return new Date().toLocaleDateString('sv') }
function rptYesterdayStr() {
  const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString('sv')
}
function rptThirtyAgoStr() {
  const d = new Date(); d.setDate(d.getDate() - 30); return d.toLocaleDateString('sv')
}
function rptThisMonthRange() {
  const d = new Date(); const y = d.getFullYear(); const m = d.getMonth() + 1
  const pad = (n) => String(n).padStart(2, '0')
  const last = new Date(y, m, 0).getDate()
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` }
}
function rptLastMonthRange() {
  const d = new Date(); const y = d.getFullYear(); const m = d.getMonth()
  const pad = (n) => String(n).padStart(2, '0')
  const ly = m === 0 ? y - 1 : y; const lm = m === 0 ? 12 : m
  const last = new Date(ly, lm, 0).getDate()
  return { from: `${ly}-${pad(lm)}-01`, to: `${ly}-${pad(lm)}-${pad(last)}` }
}

/** Set the from/to date inputs and update active preset button */
function reportsSetRange(from, to, activePreset) {
  reportsState.from = from
  reportsState.to   = to
  const fromInput = document.getElementById('reports-from')
  const toInput   = document.getElementById('reports-to')
  if (fromInput) fromInput.value = from
  if (toInput)   toInput.value   = to
  document.querySelectorAll('.reports-preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === activePreset)
  })
}

/** Load the currently active report tab */
async function loadActiveReport() {
  const tab  = reportsState.activeTab
  const from = reportsState.from || rptThirtyAgoStr()
  const to   = reportsState.to   || rptTodayStr()
  reportsState.from = from
  reportsState.to   = to
  if (tab === 'sales')  await loadSalesReport(from, to)
  if (tab === 'shifts') await loadShiftsReport(from, to)
  if (tab === 'tips')   await loadTipsReport(from, to)
}

// ── Sales ────────────────────────────────────────────────────────────────────

async function loadSalesReport(from, to) {
  const merchantId = state.merchantId
  try {
    const res = await api(`/api/merchants/${merchantId}/reports/sales?from=${from}&to=${to}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    renderSalesReport(await res.json())
  } catch (err) {
    const empty = document.getElementById('sales-empty')
    if (empty) { empty.hidden = false; empty.textContent = 'Failed to load: ' + err.message }
    const table = document.getElementById('sales-table')
    if (table) table.hidden = true
  }
}

function renderSalesReport(data) {
  const { summary, days, orders } = data
  const isSingleDay = data.from === data.to
  const fmt = formatPrice

  // ── Summary breakdown + tender types ──────────────────────────────────────
  const summaryBlock = document.getElementById('sales-summary-block')
  if (summaryBlock) {
    const discountRow = '<div class="ss-row' + (summary.discountCents > 0 ? ' ss-neg' : '') + '"><span>Discounts</span><span>' + (summary.discountCents > 0 ? '-' : '') + fmt(summary.discountCents) + '</span></div>'
    const refundRow   = '<div class="ss-row' + (summary.refundedCents  > 0 ? ' ss-neg' : '') + '"><span>Refunds</span><span>'   + (summary.refundedCents  > 0 ? '-' : '') + fmt(summary.refundedCents)  + '</span></div>'
    const svcRow      = '<div class="ss-row"><span>Service Charge</span><span>' + fmt(summary.serviceChargeCents) + '</span></div>'
    const cardRow     = '<tr><td>Card</td><td class="num">' + fmt(summary.tenders?.card ?? 0) + '</td></tr>'
    const cashRow     = '<tr><td>Cash</td><td class="num">' + fmt(summary.tenders?.cash ?? 0) + '</td></tr>'
    const gcAmt       = summary.tenders?.giftCard ?? 0
    const giftCardRow = gcAmt > 0 ? '<tr><td>Gift Card</td><td class="num">' + fmt(gcAmt) + '</td></tr>' : ''
    const orderCount = summary.totalOrders
    summaryBlock.innerHTML =
      '<div class="sales-summary-layout">' +
        '<div class="ss-block">' +
          '<div class="ss-row"><span>Gross Sales</span><span>' + fmt(summary.grossSalesCents) + '</span></div>' +
          discountRow + refundRow +
          '<div class="ss-row ss-sub"><span>Net Sales</span><span>' + fmt(summary.netSalesCents) + '</span></div>' +
          '<div class="ss-sep"></div>' +
          '<div class="ss-row"><span>Taxes &amp; Fees</span><span>' + fmt(summary.taxCents) + '</span></div>' +
          '<div class="ss-row"><span>Tips</span><span>' + fmt(summary.tipCents) + '</span></div>' +
          svcRow +
          '<div class="ss-row ss-total"><span>Amount Collected</span><span>' + fmt(summary.amountCollectedCents) + '</span></div>' +
        '</div>' +
        '<div class="ss-block">' +
          '<div class="ss-heading">Tender Types</div>' +
          '<table class="reports-table ss-tender-table">' +
            '<thead><tr><th>Tender</th><th class="num">Amount Collected</th></tr></thead>' +
            '<tbody>' + cardRow + cashRow + giftCardRow +
              '<tr class="total-row"><td>Total</td><td class="num">' + fmt(summary.amountCollectedCents) + '</td></tr>' +
            '</tbody>' +
          '</table>' +
          '<div class="ss-orders-count">' + orderCount + ' order' + (orderCount !== 1 ? 's' : '') + '</div>' +
        '</div>' +
      '</div>'
  }

  // ── Detail table ───────────────────────────────────────────────────────────
  const detailWrap = document.getElementById('sales-detail-wrap')
  const emptyEl    = document.getElementById('sales-empty')

  if (!days?.length) {
    if (detailWrap) detailWrap.innerHTML = ''
    if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'No paid orders in this period.' }
    return
  }
  if (emptyEl) emptyEl.hidden = true

  if (isSingleDay && orders?.length) {
    // Per-order detail for same-day view
    const rowsHtml = orders.map((o) =>
      '<tr>' +
      '<td>' + fmtReportTime(o.createdAt) + '</td>' +
      '<td>' + escHtml(o.customerName) + '</td>' +
      '<td>' + escHtml(o.paymentMethod === 'gift_card' ? 'Gift Card' : o.paymentMethod === 'gift_card_purchase' ? 'Gift Card Sale' : o.paymentMethod.charAt(0).toUpperCase() + o.paymentMethod.slice(1)) + '</td>' +
      '<td class="num">' + fmt(o.subtotalCents) + '</td>' +
      '<td class="num">' + (o.discountCents > 0 ? '<span class="ss-neg">-' + fmt(o.discountCents) + '</span>' : fmt(0)) + '</td>' +
      '<td class="num">' + fmt(o.taxCents) + '</td>' +
      '<td class="num">' + fmt(o.tipCents) + '</td>' +
      '<td class="num">' + fmt(o.serviceChargeCents) + '</td>' +
      '<td class="num">' + fmt(o.amountCollectedCents) + '</td>' +
      '</tr>'
    ).join('')
    const totalRow =
      '<tr class="total-row">' +
      '<td colspan="3">Total (' + orders.length + ')</td>' +
      '<td class="num">' + fmt(summary.grossSalesCents) + '</td>' +
      '<td class="num">' + (summary.discountCents > 0 ? '-' + fmt(summary.discountCents) : fmt(0)) + '</td>' +
      '<td class="num">' + fmt(summary.taxCents) + '</td>' +
      '<td class="num">' + fmt(summary.tipCents) + '</td>' +
      '<td class="num">' + fmt(summary.serviceChargeCents) + '</td>' +
      '<td class="num">' + fmt(summary.amountCollectedCents) + '</td>' +
      '</tr>'
    if (detailWrap) detailWrap.innerHTML =
      '<h4 class="reports-section-sub-heading">Order Detail</h4>' +
      '<div class="reports-table-wrap"><table class="reports-table">' +
      '<thead><tr><th>Time</th><th>Customer</th><th>Tender</th>' +
      '<th class="num">Subtotal</th><th class="num">Discount</th>' +
      '<th class="num">Tax</th><th class="num">Tip</th><th class="num">Svc Charge</th><th class="num">Total</th></tr></thead>' +
      '<tbody>' + rowsHtml + totalRow + '</tbody>' +
      '</table></div>'
  } else {
    // Daily breakdown for multi-day view
    const rowsHtml = days.map((d) =>
      '<tr>' +
      '<td>' + escHtml(d.date) + '</td>' +
      '<td class="num">' + d.orders + '</td>' +
      '<td class="num">' + fmt(d.grossSalesCents) + '</td>' +
      '<td class="num">' + (d.discountCents > 0 ? '<span class="ss-neg">-' + fmt(d.discountCents) + '</span>' : fmt(0)) + '</td>' +
      '<td class="num">' + fmt(d.netSalesCents) + '</td>' +
      '<td class="num">' + fmt(d.taxCents) + '</td>' +
      '<td class="num">' + fmt(d.tipCents) + '</td>' +
      '<td class="num">' + fmt(d.serviceChargeCents) + '</td>' +
      '<td class="num">' + fmt(d.amountCollectedCents) + '</td>' +
      '</tr>'
    ).join('')
    const totalRow =
      '<tr class="total-row">' +
      '<td>Total</td>' +
      '<td class="num">' + summary.totalOrders + '</td>' +
      '<td class="num">' + fmt(summary.grossSalesCents) + '</td>' +
      '<td class="num">' + (summary.discountCents > 0 ? '-' + fmt(summary.discountCents) : fmt(0)) + '</td>' +
      '<td class="num">' + fmt(summary.netSalesCents) + '</td>' +
      '<td class="num">' + fmt(summary.taxCents) + '</td>' +
      '<td class="num">' + fmt(summary.tipCents) + '</td>' +
      '<td class="num">' + fmt(summary.serviceChargeCents) + '</td>' +
      '<td class="num">' + fmt(summary.amountCollectedCents) + '</td>' +
      '</tr>'
    if (detailWrap) detailWrap.innerHTML =
      '<div class="reports-table-wrap"><table class="reports-table">' +
      '<thead><tr><th>Date</th><th class="num">Orders</th>' +
      '<th class="num">Gross Sales</th><th class="num">Discounts</th>' +
      '<th class="num">Net Sales</th><th class="num">Tax</th>' +
      '<th class="num">Tips</th><th class="num">Svc Charge</th><th class="num">Collected</th></tr></thead>' +
      '<tbody>' + rowsHtml + totalRow + '</tbody>' +
      '</table></div>'
  }
}

// ── Shifts ───────────────────────────────────────────────────────────────────

async function loadShiftsReport(from, to) {
  const merchantId = state.merchantId
  try {
    const res = await api(`/api/merchants/${merchantId}/reports/shifts?from=${from}&to=${to}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    renderShiftsReport(await res.json())
  } catch (err) {
    const empty = document.getElementById('shifts-empty')
    if (empty) { empty.hidden = false; empty.textContent = 'Failed to load: ' + err.message }
    const table = document.getElementById('shifts-table')
    if (table) table.hidden = true
  }
}

function renderShiftsReport(data) {
  const { summary, breakRule, employees } = data
  document.getElementById('shifts-total-hours').textContent = summary.grandTotalHours.toFixed(2) + ' h'
  document.getElementById('shifts-emp-count').textContent   = employees.length

  const breakCard = document.getElementById('shifts-break-card')
  const breakVal  = document.getElementById('shifts-break-rule')
  if (breakRule) {
    breakCard.hidden = false
    breakVal.textContent = '>' + breakRule.thresholdHours + 'h \u2192 \u2212' + breakRule.deductionMinutes + 'min'
  } else {
    breakCard.hidden = true
  }

  const tbody = document.getElementById('shifts-tbody')
  const table = document.getElementById('shifts-table')
  const empty = document.getElementById('shifts-empty')

  const allShifts = employees.flatMap((e) =>
    e.shifts.map((s) => Object.assign({}, s, { nickname: e.nickname, role: e.role }))
  )

  if (allShifts.length === 0) {
    table.hidden = true; empty.hidden = false
    empty.textContent = 'No shifts recorded in this period.'
    return
  }
  table.hidden = false; empty.hidden = true

  const rowsHtml = allShifts.map((s) => {
    const hoursStr = s.hours != null
      ? s.hours.toFixed(2) + ' h'
      : '<span class="ts-clocked-in">Active</span>'
    const clockOutCell = s.clockOut
      ? fmtReportTime(s.clockOut)
      : '<span class="ts-clocked-in">Active</span>'
    return '<tr>' +
      '<td>' + escHtml(s.nickname) + '</td>' +
      '<td><span class="employee-role-badge ' + escHtml(s.role) + '">' + escHtml(s.role) + '</span></td>' +
      '<td>' + escHtml(s.date) + '</td>' +
      '<td>' + fmtReportTime(s.clockIn) + '</td>' +
      '<td>' + clockOutCell + '</td>' +
      '<td class="num">' + hoursStr + '</td>' +
      '</tr>'
  }).join('')

  const totalRow = '<tr class="total-row">' +
    '<td colspan="5">Total</td>' +
    '<td class="num">' + summary.grandTotalHours.toFixed(2) + ' h</td>' +
    '</tr>'

  tbody.innerHTML = rowsHtml + totalRow
}

// ── Tips ─────────────────────────────────────────────────────────────────────

async function loadTipsReport(from, to) {
  const merchantId = state.merchantId
  try {
    const res = await api(`/api/merchants/${merchantId}/reports/tips?from=${from}&to=${to}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    renderTipsReport(await res.json())
  } catch (err) {
    const empty = document.getElementById('tips-empty')
    if (empty) { empty.hidden = false; empty.textContent = 'Failed to load: ' + err.message }
    const table = document.getElementById('tips-table')
    if (table) table.hidden = true
  }
}

function renderTipsReport(data) {
  const { summary, employees } = data
  document.getElementById('tips-total').textContent     = formatPrice(summary.grandTotalTipsCents)
  document.getElementById('tips-emp-count').textContent = employees.length

  const tbody = document.getElementById('tips-tbody')
  const table = document.getElementById('tips-table')
  const empty = document.getElementById('tips-empty')

  if (!employees || employees.length === 0) {
    table.hidden = true; empty.hidden = false
    empty.textContent = 'No tips recorded in this period.'
    return
  }
  table.hidden = false; empty.hidden = true

  let totalOrders = 0
  const rowsHtml = employees.map((e) => {
    const avg = e.orderCount > 0 ? Math.round(e.totalTipCents / e.orderCount) : 0
    totalOrders += e.orderCount
    return '<tr>' +
      '<td>' + escHtml(e.nickname) + '</td>' +
      '<td class="num">' + e.orderCount + '</td>' +
      '<td class="num">' + formatPrice(e.totalTipCents) + '</td>' +
      '<td class="num">' + formatPrice(avg) + '</td>' +
      '</tr>'
  }).join('')

  const totalRow = '<tr class="total-row">' +
    '<td>Total</td>' +
    '<td class="num">' + totalOrders + '</td>' +
    '<td class="num">' + formatPrice(summary.grandTotalTipsCents) + '</td>' +
    '<td></td>' +
    '</tr>'

  tbody.innerHTML = rowsHtml + totalRow
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format an ISO datetime string as HH:MM */
function fmtReportTime(iso) {
  if (!iso) return '\u2014'
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch (e) {
    return iso.slice(11, 16)
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

function initReports() {
  // Sub-tab switching
  document.querySelectorAll('.reports-subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      reportsState.activeTab = btn.dataset.report
      document.querySelectorAll('.reports-subtab-btn').forEach((b) => {
        b.classList.toggle('active', b === btn)
        b.setAttribute('aria-selected', String(b === btn))
      })
      document.querySelectorAll('.reports-panel').forEach((p) => {
        const active = p.id === ('reports-panel-' + reportsState.activeTab)
        p.classList.toggle('active', active)
        p.hidden = !active
      })
      loadActiveReport()
    })
  })

  // Preset buttons
  document.querySelectorAll('.reports-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset
      let from, to
      if (preset === 'today')          { from = to = rptTodayStr() }
      else if (preset === 'yesterday') { from = to = rptYesterdayStr() }
      else if (preset === 'last30')    { from = rptThirtyAgoStr(); to = rptTodayStr() }
      else if (preset === 'this-period') { var p = computePayPeriod('current'); from = p.from; to = p.to }
      else if (preset === 'this-month')  { var p = rptThisMonthRange(); from = p.from; to = p.to }
      else if (preset === 'last-month')  { var p = rptLastMonthRange(); from = p.from; to = p.to }
      else if (preset === 'last-period') { var p = computePayPeriod('last');    from = p.from; to = p.to }
      reportsSetRange(from, to, preset)
      loadActiveReport()
    })
  })

  // Manual date apply
  document.getElementById('reports-apply-btn')?.addEventListener('click', () => {
    const from = document.getElementById('reports-from')?.value
    const to   = document.getElementById('reports-to')?.value
    if (!from || !to) return
    reportsState.from = from
    reportsState.to   = to
    document.querySelectorAll('.reports-preset-btn').forEach((b) => b.classList.remove('active'))
    loadActiveReport()
  })

  // Auto-load when section becomes active
  document.addEventListener('section:reports', () => {
    if (!reportsState.from) reportsSetRange(rptThirtyAgoStr(), rptTodayStr(), 'last30')
    loadActiveReport()
  })
}

initReports()

// ---------------------------------------------------------------------------
// Backup & Restore
// ---------------------------------------------------------------------------

/**
 * Switch visible backup sub-tab.
 * @param {string} tab  — 'backup' | 'restore' | 'wipe' | 's3'
 */
function switchBackupTab(tab) {
  document.querySelectorAll('.bkp-tab').forEach((btn) => {
    const active = btn.dataset.bkpTab === tab
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', String(active))
  })
  document.querySelectorAll('.bkp-panel').forEach((panel) => {
    panel.hidden = panel.id !== `bkp-panel-${tab}`
  })
}

/** Trigger a browser file download for the current backup selection. */
async function downloadBackup() {
  const type = document.getElementById('bkp-type')?.value || 'full'
  const from  = document.getElementById('bkp-from')?.value || ''
  const to    = document.getElementById('bkp-to')?.value   || ''

  const btn = document.getElementById('bkp-download-btn')
  if (btn) btn.disabled = true

  try {
    let url = `/api/merchants/${state.merchantId}/backup?type=${encodeURIComponent(type)}`
    if (from) url += `&from=${encodeURIComponent(from)}`
    if (to)   url += `&to=${encodeURIComponent(to)}`

    const res = await api(url)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error || 'Backup failed', 'error')
      return
    }
    const blob = await res.blob()
    const date = new Date().toISOString().slice(0, 10)
    const filename = `merchant-backup-${type}-${date}.json`
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
    showToast('Backup downloaded', 'success')
  } catch (e) {
    showToast('Backup failed: ' + e.message, 'error')
  } finally {
    if (btn) btn.disabled = false
  }
}

/** Read and validate a backup JSON file, then show preview before restoring. */
function handleRestoreFileSelect(file) {
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result)
      if (!json.version || !json.type || !json.merchantId) {
        showToast('Invalid backup file', 'error')
        return
      }
      const preview    = document.getElementById('bkp-restore-preview')
      const previewTxt = document.getElementById('bkp-restore-preview-text')
      const restoreBtn = document.getElementById('bkp-restore-btn')
      if (preview && previewTxt && restoreBtn) {
        const from = json.from ? ` from ${json.from}` : ''
        const to   = json.to   ? ` to ${json.to}`     : ''
        previewTxt.textContent =
          `Type: ${json.type} | Created: ${json.createdAt}${from}${to} | Merchant: ${json.merchantId}`
        preview.hidden = false
        restoreBtn.disabled = false
        restoreBtn._backupData = json
      }
    } catch {
      showToast('Could not parse backup file', 'error')
    }
  }
  reader.readAsText(file)
}

/** Post the parsed backup JSON to the restore endpoint. */
async function doRestore() {
  const btn  = document.getElementById('bkp-restore-btn')
  const data = btn?._backupData
  if (!data) return

  const confirmed = window.confirm(
    `This will REPLACE all ${data.type} data with the backup from ${data.createdAt}.\n\nContinue?`
  )
  if (!confirmed) return

  btn.disabled = true
  try {
    const res = await api(`/api/merchants/${state.merchantId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backup: data, confirm: true }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error || 'Restore failed', 'error')
      btn.disabled = false
      return
    }
    showToast('Restore complete', 'success')
    const fileInput = document.getElementById('bkp-file')
    if (fileInput) fileInput.value = ''
    const preview = document.getElementById('bkp-restore-preview')
    if (preview) preview.hidden = true
    btn._backupData = null
    btn.disabled = true
  } catch (e) {
    showToast('Restore failed: ' + e.message, 'error')
    btn.disabled = false
  }
}

/** Send a wipe request for the given data type. */
async function doWipe(type) {
  const label = type === 'full' ? 'FACTORY RESET (all data)' : `all ${type} data`
  if (!window.confirm(`WARNING: This will permanently delete ${label}.\n\nThis cannot be undone. Continue?`)) return
  if (type === 'full' && !window.confirm('Are you absolutely sure? All data will be lost permanently.')) return

  try {
    const res = await api(`/api/merchants/${state.merchantId}/wipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, confirm: true }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error || 'Wipe failed', 'error')
      return
    }
    showToast(`${type === 'full' ? 'Factory reset' : type + ' data deleted'} successfully`, 'success')
  } catch (e) {
    showToast('Wipe failed: ' + e.message, 'error')
  }
}

/** Load S3 config and populate the form. */
async function loadS3Config() {
  const status = document.getElementById('bkp-s3-status')
  if (status) { status.hidden = false; status.textContent = 'Loading…'; status.className = 'bkp-s3-status' }
  try {
    const res = await api(`/api/merchants/${state.merchantId}/s3-config`)
    if (res.status === 404) {
      if (status) { status.textContent = 'No S3 credentials saved.'; status.className = 'bkp-s3-status bkp-s3-status-info'; status.hidden = false }
      return
    }
    if (!res.ok) {
      if (status) { status.textContent = 'Could not load S3 config.'; status.className = 'bkp-s3-status bkp-s3-status-error'; status.hidden = false }
      return
    }
    const data = await res.json()
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || '' }
    setVal('bkp-s3-key-id', data.accessKeyId)
    setVal('bkp-s3-bucket',  data.bucket)
    setVal('bkp-s3-region',  data.region)
    const secret = document.getElementById('bkp-s3-secret')
    if (secret) secret.placeholder = '(saved — leave blank to keep)'
    if (status) { status.textContent = 'S3 credentials saved.'; status.className = 'bkp-s3-status bkp-s3-status-ok'; status.hidden = false }
  } catch (e) {
    if (status) { status.textContent = 'Error: ' + e.message; status.className = 'bkp-s3-status bkp-s3-status-error'; status.hidden = false }
  }
}

/** Save S3 credentials. */
async function saveS3Config() {
  const get = (id) => document.getElementById(id)?.value.trim() || ''
  const accessKeyId     = get('bkp-s3-key-id')
  const secretAccessKey = get('bkp-s3-secret')
  const bucket          = get('bkp-s3-bucket')
  const region          = get('bkp-s3-region')

  if (!accessKeyId || !bucket || !region) {
    showToast('Access Key ID, Bucket, and Region are required', 'error')
    return
  }

  const btn = document.getElementById('bkp-s3-save-btn')
  if (btn) btn.disabled = true
  try {
    const body = { accessKeyId, bucket, region }
    if (secretAccessKey) body.secretAccessKey = secretAccessKey
    const res = await api(`/api/merchants/${state.merchantId}/s3-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error || 'Failed to save S3 credentials', 'error')
      return
    }
    showToast('S3 credentials saved', 'success')
    loadS3Config()
  } catch (e) {
    showToast('Error: ' + e.message, 'error')
  } finally {
    if (btn) btn.disabled = false
  }
}

/** Remove S3 credentials. */
async function deleteS3Config() {
  if (!window.confirm('Remove S3 credentials? Nightly backups will stop.')) return
  try {
    const res = await api(`/api/merchants/${state.merchantId}/s3-config`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error || 'Failed to remove S3 credentials', 'error')
      return
    }
    showToast('S3 credentials removed', 'success')
    ;['bkp-s3-key-id', 'bkp-s3-secret', 'bkp-s3-bucket', 'bkp-s3-region'].forEach((id) => {
      const el = document.getElementById(id)
      if (el) { el.value = ''; el.placeholder = '' }
    })
    const status = document.getElementById('bkp-s3-status')
    if (status) { status.textContent = 'No S3 credentials saved.'; status.className = 'bkp-s3-status bkp-s3-status-info'; status.hidden = false }
  } catch (e) {
    showToast('Error: ' + e.message, 'error')
  }
}

/** Manually trigger an S3 backup now. */
async function triggerS3Backup() {
  const btn    = document.getElementById('bkp-s3-trigger-btn')
  const status = document.getElementById('bkp-s3-status')
  if (btn) btn.disabled = true
  if (status) { status.textContent = 'Running backup…'; status.className = 'bkp-s3-status bkp-s3-status-info'; status.hidden = false }
  try {
    const res = await api(`/api/merchants/${state.merchantId}/s3-backup/trigger`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      showToast(err.error || 'S3 backup failed', 'error')
      if (status) { status.textContent = 'Backup failed.'; status.className = 'bkp-s3-status bkp-s3-status-error' }
      return
    }
    const data = await res.json()
    showToast('S3 backup uploaded', 'success')
    if (status) { status.textContent = `Uploaded: ${data.key}`; status.className = 'bkp-s3-status bkp-s3-status-ok' }
  } catch (e) {
    showToast('Error: ' + e.message, 'error')
    if (status) { status.textContent = 'Error: ' + e.message; status.className = 'bkp-s3-status bkp-s3-status-error' }
  } finally {
    if (btn) btn.disabled = false
  }
}

function initBackup() {
  // Sub-tab switching
  document.querySelectorAll('.bkp-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchBackupTab(btn.dataset.bkpTab))
  })

  // Backup type → show/hide date range
  document.getElementById('bkp-type')?.addEventListener('change', (e) => {
    const needsDate = ['orders', 'employees', 'full'].includes(e.target.value)
    const dateRow   = document.getElementById('bkp-date-row')
    if (dateRow) dateRow.hidden = !needsDate
    if (needsDate) {
      const today = new Date().toISOString().slice(0, 10)
      const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const fromEl = document.getElementById('bkp-from')
      const toEl   = document.getElementById('bkp-to')
      if (fromEl && !fromEl.value) fromEl.value = ago30
      if (toEl   && !toEl.value)   toEl.value   = today
    }
  })

  // Download backup
  document.getElementById('bkp-download-btn')?.addEventListener('click', downloadBackup)

  // Restore: file select + confirm
  document.getElementById('bkp-file')?.addEventListener('change', (e) => {
    handleRestoreFileSelect(e.target.files?.[0])
  })
  document.getElementById('bkp-restore-btn')?.addEventListener('click', doRestore)

  // Wipe buttons
  document.querySelectorAll('[data-wipe]').forEach((btn) => {
    btn.addEventListener('click', () => doWipe(btn.dataset.wipe))
  })

  // S3 buttons
  document.getElementById('bkp-s3-save-btn')?.addEventListener('click', saveS3Config)
  document.getElementById('bkp-s3-delete-btn')?.addEventListener('click', deleteS3Config)
  document.getElementById('bkp-s3-trigger-btn')?.addEventListener('click', triggerS3Backup)

  // Load S3 config when the backup section becomes active
  document.addEventListener('section:backup', () => loadS3Config())
}

initBackup()

// ---------------------------------------------------------------------------
// Order Notifications — Web Audio API sound synthesis
// ---------------------------------------------------------------------------

/**
 * Shared AudioContext — reused across all sound plays.
 * Created lazily; warmed up on first user interaction so the browser unlocks it.
 * @type {AudioContext|null}
 */
let _sharedAudioCtx = null

/** Ensure the shared AudioContext is alive and running. */
function _getAudioCtx() {
  if (!_sharedAudioCtx) {
    _sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)()
  }
  if (_sharedAudioCtx.state === 'suspended') {
    _sharedAudioCtx.resume().catch(() => {})
  }
  return _sharedAudioCtx
}

// Warm up AudioContext on first interaction (click or touch — covers tablets)
;['click', 'touchstart'].forEach(evt => {
  document.addEventListener(evt, function _warm() {
    _getAudioCtx()
    document.removeEventListener(evt, _warm)
  }, { once: true })
})

// ── Repeating new-order sound ───────────────────────────────────────────────
// Instead of setInterval (which browsers block for audio without user gesture),
// we pre-schedule all future tone bursts on the AudioContext's internal clock
// in one shot — right when the first play succeeds (SSE handler).
// The AudioContext plays them at the exact times; no timers needed.

/** Map<orderId, OscillatorNode[]> — pre-scheduled repeating chimes */
const _orderSoundNodes = new Map()

/**
 * Schedule a single tone burst at `startAt` on the shared AudioContext.
 * Pushes the OscillatorNode into `nodes` so it can be cancelled on accept.
 */
function _scheduleTone(ctx, nodes, freq, startAt, duration, type, gainPeak) {
  const osc  = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.type = type ?? 'sine'
  osc.frequency.setValueAtTime(freq, startAt)
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(gainPeak ?? 0.5, startAt + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.05)
  nodes.push(osc)
}

/** Schedule one burst of the selected notification sound at `startAt`. */
function _scheduleNotifBurst(ctx, nodes, startAt) {
  var name = document.getElementById('store-notification-sound')?.value ?? 'chime'
  if (name === 'bell') {
    _scheduleTone(ctx, nodes, 523,  startAt, 0.8, 'sine',     0.4)
    _scheduleTone(ctx, nodes, 1047, startAt, 0.6, 'sine',     0.2)
    _scheduleTone(ctx, nodes, 1568, startAt, 0.5, 'triangle', 0.1)
  } else if (name === 'double-beep') {
    _scheduleTone(ctx, nodes, 880, startAt,       0.15, 'square', 0.3)
    _scheduleTone(ctx, nodes, 880, startAt + 0.2, 0.15, 'square', 0.3)
  } else if (name === 'ding') {
    _scheduleTone(ctx, nodes, 1047, startAt, 0.6, 'sine', 0.5)
  } else {
    // chime (default + fallback)
    _scheduleTone(ctx, nodes, 880,  startAt,       0.4, 'sine', 0.45)
    _scheduleTone(ctx, nodes, 1320, startAt + 0.2, 0.5, 'sine', 0.4)
  }
}

/**
 * Pre-schedule 40 repetitions (10 min) of the notification sound, every 15 s.
 * All oscillators are booked on the AudioContext's timeline in one call,
 * so no setInterval / user-gesture is needed for subsequent plays.
 * @param {string} orderId
 */
function startOrderSoundRepeat(orderId) {
  if (_orderSoundNodes.has(orderId)) return
  try {
    var ctx   = _getAudioCtx()
    var nodes = []
    for (var i = 1; i <= 40; i++) {
      _scheduleNotifBurst(ctx, nodes, ctx.currentTime + i * 15)
    }
    _orderSoundNodes.set(orderId, nodes)
  } catch (err) {
    console.warn('[sound] Failed to schedule repeat:', err)
  }
}

/**
 * Cancel all pre-scheduled chimes for an order (on accept).
 * @param {string} orderId
 */
function stopOrderSoundRepeat(orderId) {
  var nodes = _orderSoundNodes.get(orderId)
  if (!nodes) return
  for (var n of nodes) { try { n.stop(); n.disconnect() } catch {} }
  _orderSoundNodes.delete(orderId)
}

/** Stop ALL repeating new-order sounds. */
function stopAllOrderSounds() {
  for (var [id] of _orderSoundNodes) stopOrderSoundRepeat(id)
}

// ---------------------------------------------------------------------------
// Print error alert — modal + repeating alarm sound every 60 s until dismissed
// ---------------------------------------------------------------------------

/** setInterval handle for the repeating print-error alarm. null when inactive. */
let _printErrorAlarmTimer = null

/**
 * Play a two-tone urgent alert sound to signal a print failure.
 * Distinct from the new-order chime so staff can recognise it by ear.
 */
function _playPrintErrorSound() {
  try {
    const ctx = _getAudioCtx()
    function tone(freq, startAt, duration, type, gainPeak) {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = type ?? 'square'
      osc.frequency.setValueAtTime(freq, startAt)
      gain.gain.setValueAtTime(0, startAt)
      gain.gain.linearRampToValueAtTime(gainPeak ?? 0.4, startAt + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
      osc.start(startAt); osc.stop(startAt + duration + 0.05)
    }
    const t = ctx.currentTime
    // Two harsh descending pulses: A5 → E5
    tone(880, t,        0.18, 'square', 0.4)
    tone(659, t + 0.22, 0.18, 'square', 0.35)
    tone(880, t + 0.50, 0.18, 'square', 0.4)
    tone(659, t + 0.72, 0.18, 'square', 0.35)
  } catch (err) {
    console.warn('[sound] Print error sound unavailable:', err)
  }
}

/**
 * Show the print error modal and start the 60-second repeating alarm.
 * @param {{ orderId?: string, context?: string, message?: string }} data
 */
function showPrintErrorModal(data) {
  const overlay = document.getElementById('print-error-overlay')
  const detail  = document.getElementById('print-error-detail')
  if (!overlay) return

  // Build detail line: show context + sanitised error message
  const contextLabel = data.context === 'order_edit'   ? 'Order edit reprint'
    : data.context === 'order_accept' ? 'Online order accepted'
    : 'New order'
  const errText = data.message ? escHtml(String(data.message)) : 'Unknown error'
  if (detail) detail.innerHTML = `<strong>${contextLabel}</strong> — ${errText}`

  overlay.hidden = false

  // Play immediately then repeat every 60 s until dismissed
  _playPrintErrorSound()
  if (!_printErrorAlarmTimer) {
    _printErrorAlarmTimer = setInterval(_playPrintErrorSound, 60_000)
  }
}

/** Dismiss the print error modal and stop the alarm. */
function _dismissPrintErrorModal() {
  const overlay = document.getElementById('print-error-overlay')
  if (overlay) overlay.hidden = true
  if (_printErrorAlarmTimer) {
    clearInterval(_printErrorAlarmTimer)
    _printErrorAlarmTimer = null
  }
}

// Wire up dismiss button (runs once after DOM ready)
document.getElementById('print-error-dismiss-btn')
  ?.addEventListener('click', _dismissPrintErrorModal)

/**
 * Play a "fire to kitchen" confirmation sound — a bright descending arpeggio.
 * Distinct from the new-order alerts so staff can recognise it by ear.
 */
function playFireSound() {
  try {
    const ctx = _getAudioCtx()
    function tone(freq, startAt, duration, type, gainPeak) {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = type ?? 'sine'
      osc.frequency.setValueAtTime(freq, startAt)
      gain.gain.setValueAtTime(0, startAt)
      gain.gain.linearRampToValueAtTime(gainPeak ?? 0.5, startAt + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
      osc.start(startAt); osc.stop(startAt + duration + 0.05)
    }
    const t = ctx.currentTime
    // Quick three-note descending arpeggio: E6 → C6 → G5
    tone(1319, t,       0.15, 'sine', 0.5)
    tone(1047, t + 0.12, 0.15, 'sine', 0.45)
    tone(784,  t + 0.24, 0.30, 'sine', 0.4)
  } catch (err) {
    console.warn('[sound] Fire sound unavailable:', err)
  }
}

/**
 * Play the selected notification sound using the Web Audio API.
 * No audio files required — tones are synthesised on the fly.
 *
 * @param {string} [sound] - One of 'chime' | 'bell' | 'double-beep' | 'ding'.
 *   Defaults to the value of #store-notification-sound, then falls back to 'chime'.
 */
function playNotificationSound(sound) {
  const name = sound ?? document.getElementById('store-notification-sound')?.value ?? 'chime'

  try {
    const ctx = _getAudioCtx()

    /** Schedule a single tone burst. */
    function tone(freq, startAt, duration, type, gainPeak) {
      type     = type     ?? 'sine'
      gainPeak = gainPeak ?? 0.5

      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.type = type
      osc.frequency.setValueAtTime(freq, startAt)

      gain.gain.setValueAtTime(0, startAt)
      gain.gain.linearRampToValueAtTime(gainPeak, startAt + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)

      osc.start(startAt)
      osc.stop(startAt + duration + 0.05)
    }

    const t = ctx.currentTime

    if (name === 'chime') {
      // Bright ascending two-note chime
      tone(880,  t,       0.4, 'sine', 0.45)
      tone(1320, t + 0.2, 0.5, 'sine', 0.4)
    } else if (name === 'bell') {
      // Rich bell-like tone with detuned harmonics
      tone(523,  t, 0.8, 'sine',     0.4)
      tone(1047, t, 0.6, 'sine',     0.2)
      tone(1568, t, 0.5, 'triangle', 0.1)
    } else if (name === 'double-beep') {
      // Two short electronic beeps
      tone(880, t,       0.15, 'square', 0.3)
      tone(880, t + 0.2, 0.15, 'square', 0.3)
    } else if (name === 'ding') {
      // Single crisp ding
      tone(1047, t, 0.6, 'sine', 0.5)
    } else {
      // Fallback: same as chime
      tone(880,  t,       0.4, 'sine', 0.45)
      tone(1320, t + 0.2, 0.5, 'sine', 0.4)
    }

    // Shared AudioContext stays open — no close needed
  } catch (err) {
    console.warn('[sound] Web Audio API unavailable:', err)
  }
}

// Wire up the Preview button in the profile form
document.getElementById('preview-sound-btn')?.addEventListener('click', () => {
  playNotificationSound()
})

// ---------------------------------------------------------------------------
// New-order accept modal — shown when staff is not on the Online Orders tab
// ---------------------------------------------------------------------------

/** Queue of order IDs waiting to be shown in the modal (FIFO). */
const _newOrderQueue = []

/** True while the modal is visible — prevents re-entry. */
let _newOrderModalOpen = false

/**
 * Fetch a single order by ID from today's orders list.
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
async function _fetchOrder(orderId) {
  try {
    const res = await api(`/api/merchants/${state.merchantId}/orders?from=0&to=${Date.now()}`)
    if (!res.ok) return null
    const data = await res.json()
    return data.orders.find(o => o.id === orderId) ?? null
  } catch { return null }
}

/**
 * Show the new-order accept modal for a specific order.
 * If the modal is already open (another order), queues this one.
 * @param {string} orderId
 */
async function showNewOrderModal(orderId) {
  if (_newOrderModalOpen) {
    _newOrderQueue.push(orderId)
    return
  }
  _newOrderModalOpen = true

  const overlay = document.getElementById('new-order-overlay')
  const body    = document.getElementById('new-order-body')
  if (!overlay || !body) { _newOrderModalOpen = false; return }

  // Show the modal immediately with a loading state
  body.innerHTML = '<p class="od-loading">Loading order…</p>'
  overlay.hidden = false

  const order = await _fetchOrder(orderId)
  if (!order || (order.status !== 'submitted' && order.status !== 'received' && order.status !== 'confirmed')) {
    // Order already handled or not found — close and try next in queue
    _hideNewOrderModal()
    return
  }

  // Build the order summary
  const typeLabel = order.orderType === 'dine_in' ? 'Dine-in'
    : order.orderType === 'delivery' ? 'Delivery' : 'Pickup'
  const itemCount = (order.items || []).length
  const itemsHtml = (order.items || []).map(item => {
    const qty   = item.qty > 1 ? `<span class="new-order-item-qty">${item.qty}×</span> ` : ''
    const price = formatPrice(item.totalCents ?? item.priceCents ?? 0)
    const mods  = (item.modifiers || []).map(m => m.name || m).filter(Boolean)
    const modLine  = mods.length ? `<div class="new-order-item-mods">${mods.map(m => escHtml(String(m))).join(', ')}</div>` : ''
    const label    = item.dishLabel ? `<div class="new-order-item-label">${escHtml(item.dishLabel)}</div>` : ''
    const instruc  = (item.serverNotes || item.specialInstructions) ? `<div class="new-order-item-instr">${escHtml(item.serverNotes ?? item.specialInstructions)}</div>` : ''
    return `<li>
      <div class="new-order-item-row"><span>${qty}${escHtml(item.name)}</span><span>${price}</span></div>
      ${modLine}${label}${instruc}
    </li>`
  }).join('')

  let scheduledHtml = ''
  if (order.pickupTime) {
    const t = new Date(order.pickupTime.endsWith('Z') ? order.pickupTime : order.pickupTime + 'Z')
    const label = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    scheduledHtml = `<div class="new-order-scheduled">⏰ Scheduled pickup at <strong>${label}</strong></div>`
  }

  const notesHtml = order.notes
    ? `<div class="new-order-notes">📝 ${escHtml(order.notes)}</div>` : ''

  body.innerHTML = `
    <div class="new-order-summary-bar">
      <span class="new-order-type-badge">${typeLabel}</span>
      <span class="new-order-meta">${itemCount} item${itemCount !== 1 ? 's' : ''}${order.pickupCode ? ' · <strong>' + escHtml(order.pickupCode) + '</strong>' : ''}</span>
      <span class="new-order-total">${formatPrice(order.totalCents)}</span>
    </div>
    <div class="new-order-customer-row">${escHtml(order.customerName || 'Customer')}</div>
    ${scheduledHtml}
    ${notesHtml}
    <ul class="new-order-items">${itemsHtml}</ul>
  `

  // Wire up buttons
  const acceptBtn  = document.getElementById('new-order-accept-btn')
  const dismissBtn = document.getElementById('new-order-dismiss-btn')
  const closeBtn   = document.getElementById('new-order-dismiss')
  const prepSelect = document.getElementById('new-order-prep-select')

  function handleDismiss() { _hideNewOrderModal() }
  function handleAccept() {
    if (!acceptBtn) return
    acceptBtn.disabled = true
    acceptBtn.textContent = 'Accepting…'
    const minutes = parseInt(prepSelect?.value || '20')
    acceptOnlineOrder(orderId, minutes, null, acceptBtn).then(() => {
      _hideNewOrderModal()
      // If orders section is active, reload to reflect the change
      if (state.activeSection === 'orders') loadOrders()
    }).catch(() => {
      acceptBtn.disabled = false
      acceptBtn.textContent = 'Accept Order'
    })
  }

  // Clean up old listeners by cloning (avoids stacking handlers)
  if (acceptBtn)  { const nb = acceptBtn.cloneNode(true); acceptBtn.replaceWith(nb); nb.addEventListener('click', handleAccept) }
  if (dismissBtn) { const nb = dismissBtn.cloneNode(true); dismissBtn.replaceWith(nb); nb.addEventListener('click', handleDismiss) }
  if (closeBtn)   { const nb = closeBtn.cloneNode(true); closeBtn.replaceWith(nb); nb.addEventListener('click', handleDismiss) }

  // Focus the accept button
  document.getElementById('new-order-accept-btn')?.focus()
}

/** Hide the modal and show the next queued order if any. */
function _hideNewOrderModal() {
  const overlay = document.getElementById('new-order-overlay')
  if (overlay) overlay.hidden = true
  _newOrderModalOpen = false

  // Process the next queued order
  if (_newOrderQueue.length > 0) {
    const nextId = _newOrderQueue.shift()
    showNewOrderModal(nextId)
  }
}

// ---------------------------------------------------------------------------
// Reservation notification modal
// ---------------------------------------------------------------------------

/** Queue for reservations that arrive while modal is open. @type {object[]} */
let _resNotifyQueue = []
let _resNotifyOpen = false

/**
 * Show the reservation-received notification modal.
 * @param {{reservationId?:string, customerName?:string, partySize?:number, date?:string, time?:string, tableLabel?:string}} data
 */
function showReservationModal(data) {
  if (_resNotifyOpen) {
    _resNotifyQueue.push(data)
    return
  }
  _resNotifyOpen = true

  const overlay = document.getElementById('res-notify-overlay')
  const body    = document.getElementById('res-notify-body')
  if (!overlay || !body) { _resNotifyOpen = false; return }

  const fmtDate = (d) => {
    if (!d) return ''
    const [y, m, day] = d.split('-')
    return new Date(Number(y), Number(m) - 1, Number(day))
      .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  }

  const name  = data.customerName ? escHtml(data.customerName) : 'Guest'
  const party = data.partySize    ? `Party of <strong>${data.partySize}</strong>` : ''
  const when  = data.date && data.time
    ? `<strong>${fmtDate(data.date)}</strong> at <strong>${escHtml(data.time)}</strong>` : ''
  const table = data.tableLabel   ? `Table <strong>${escHtml(data.tableLabel)}</strong>` : ''

  const rows = [party, when, table].filter(Boolean).map(r => `<div class="notify-row">${r}</div>`).join('')

  body.innerHTML = `
    <div class="notify-customer">${name}</div>
    ${rows}
  `

  overlay.hidden = false

  function close() {
    overlay.hidden = true
    _resNotifyOpen = false
    if (_resNotifyQueue.length > 0) showReservationModal(_resNotifyQueue.shift())
  }

  const ackBtn = document.getElementById('res-notify-ack-btn')
  const xBtn   = document.getElementById('res-notify-dismiss-x')
  if (ackBtn) { const nb = ackBtn.cloneNode(true); ackBtn.replaceWith(nb); nb.addEventListener('click', close) }
  if (xBtn)   { const nb = xBtn.cloneNode(true);   xBtn.replaceWith(nb);   nb.addEventListener('click', close) }
  document.getElementById('res-notify-ack-btn')?.focus()
}

// ---------------------------------------------------------------------------
// Gift card purchase notification modal
// ---------------------------------------------------------------------------

/** Queue for gift card events that arrive while modal is open. @type {object[]} */
let _gcNotifyQueue = []
let _gcNotifyOpen = false

/**
 * Show the gift-card-sold notification modal.
 * @param {{purchaseId?:string, customerName?:string, customerEmail?:string, totalCents?:number, cardCount?:number}} data
 */
function showGiftCardModal(data) {
  if (_gcNotifyOpen) {
    _gcNotifyQueue.push(data)
    return
  }
  _gcNotifyOpen = true

  const overlay = document.getElementById('gc-notify-overlay')
  const body    = document.getElementById('gc-notify-body')
  if (!overlay || !body) { _gcNotifyOpen = false; return }

  const name   = data.customerName  ? escHtml(data.customerName)  : 'Customer'
  const email  = data.customerEmail ? escHtml(data.customerEmail) : ''
  const total  = data.totalCents    ? `<strong>${formatPrice(data.totalCents)}</strong>` : ''
  const cards  = data.cardCount     ? `${data.cardCount} card${data.cardCount !== 1 ? 's' : ''}` : ''

  const rows = [
    total && cards ? `${total} · ${cards}` : (total || cards),
    email          ? `<span style="color:var(--color-muted,#6b7280);font-size:.9rem">${email}</span>` : '',
  ].filter(Boolean).map(r => `<div class="notify-row">${r}</div>`).join('')

  body.innerHTML = `
    <div class="notify-customer">${name}</div>
    ${rows}
  `

  overlay.hidden = false

  function close() {
    overlay.hidden = true
    _gcNotifyOpen = false
    if (_gcNotifyQueue.length > 0) showGiftCardModal(_gcNotifyQueue.shift())
  }

  const ackBtn = document.getElementById('gc-notify-ack-btn')
  const xBtn   = document.getElementById('gc-notify-dismiss-x')
  if (ackBtn) { const nb = ackBtn.cloneNode(true); ackBtn.replaceWith(nb); nb.addEventListener('click', close) }
  if (xBtn)   { const nb = xBtn.cloneNode(true);   xBtn.replaceWith(nb);   nb.addEventListener('click', close) }
  document.getElementById('gc-notify-ack-btn')?.focus()
}

// ---------------------------------------------------------------------------
// Order SSE — real-time new-order notifications for the merchant dashboard
// ---------------------------------------------------------------------------

let _sseConnection = null
let _sseLastEventAt = 0
let _sseHeartbeatTimer = null

/**
 * Tear down the current SSE connection (if any) and reconnect after a delay.
 * Safe to call multiple times — only the first call per stale connection acts.
 */
function _reconnectSSE(reason) {
  if (!_sseConnection) return
  console.warn(`[sse] Reconnecting: ${reason}`)
  try { _sseConnection.close() } catch { /* ignore */ }
  _sseConnection = null
  if (_sseHeartbeatTimer) { clearInterval(_sseHeartbeatTimer); _sseHeartbeatTimer = null }
  setTimeout(() => initOrderSSE(), 2_000)
}

/**
 * Open an SSE connection to receive real-time order events.
 * Called once after authentication. Automatically reconnects on error.
 *
 * Authentication (C-01): fetches a short-lived single-use ticket via the
 * normal authenticated API (JWT in Authorization header), then opens the
 * EventSource with ?ticket=<hex>. The JWT never appears in a URL.
 *
 * Resilience: listens for server heartbeat events (every 30 s). If no event
 * arrives within 75 s the connection is considered stale and is torn down.
 * Also reconnects on network change (online event) and tab re-focus.
 */
async function initOrderSSE() {
  if (_sseConnection) return
  if (!state.merchantId || !state.accessToken) return

  // Fetch a 30-second single-use SSE ticket — JWT stays in the Authorization
  // header of this POST, never in the EventSource URL.
  let ticket
  try {
    const res = await api(`/api/merchants/${state.merchantId}/sse-ticket`, { method: 'POST' })
    if (!res.ok) throw new Error(`ticket fetch ${res.status}`)
    const data = await res.json()
    ticket = data.ticket
  } catch (err) {
    console.warn('[sse] Failed to obtain SSE ticket, retrying in 10 s', err)
    setTimeout(() => initOrderSSE(), 10_000)
    return
  }

  const url = `/api/merchants/${state.merchantId}/events?ticket=${encodeURIComponent(ticket)}`
  const es  = new EventSource(url)
  _sseConnection = es
  _sseLastEventAt = Date.now()

  // Track heartbeats from the server (sent every 30 s)
  es.addEventListener('heartbeat', () => { _sseLastEventAt = Date.now() })

  // Heartbeat watchdog: if no event arrives within 75 s, the connection is stale
  if (_sseHeartbeatTimer) clearInterval(_sseHeartbeatTimer)
  _sseHeartbeatTimer = setInterval(() => {
    if (Date.now() - _sseLastEventAt > 75_000) {
      _reconnectSSE('heartbeat timeout (>75 s)')
    }
  }, 15_000)

  es.addEventListener('new_order', (e) => {
    _sseLastEventAt = Date.now()
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }

    // Play the configured notification sound + repeat every 15 s until accepted
    playNotificationSound()
    if (data.orderId) startOrderSoundRepeat(data.orderId)

    // Show a toast so the merchant knows at a glance
    const code  = data.pickupCode   ? ` — ${data.pickupCode}`                 : ''
    const name  = data.customerName ? ` · ${data.customerName}`               : ''
    const total = data.totalCents   ? ` · $${(data.totalCents / 100).toFixed(2)}` : ''
    showToast(`New order${code}${name}${total}`, 'success')

    // If the orders tab is open, reload it so the new order appears immediately
    if (state.activeSection === 'orders') loadOrders()

    // Show the new-order accept modal if staff is NOT already looking at Online Orders
    const onOnlineTab = state.activeSection === 'orders' && ordersState.activeTab === 'online'
    if (!onOnlineTab && data.orderId) {
      showNewOrderModal(data.orderId)
    }
  })

  es.addEventListener('order_updated', (e) => {
    _sseLastEventAt = Date.now()
    // PERF-DOM-1: patch the affected card in-place instead of reloading the full list.
    // The event always carries { orderId, status } from the server.
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }

    const orderId = data.orderId

    // Stop the repeating new-order sound once the order advances past 'pending'
    if (orderId && data.status && data.status !== 'pending') {
      stopOrderSoundRepeat(orderId)
    }

    // Close the new-order modal if this order was just accepted (from any tablet)
    if (orderId && _newOrderModalOpen && data.status && data.status !== 'submitted' && data.status !== 'received') {
      // Check if the currently-open modal is for this order
      const overlay = document.getElementById('new-order-overlay')
      if (overlay && !overlay.hidden) {
        _hideNewOrderModal()
      }
    }

    if (!orderId) { if (state.activeSection === 'orders') loadOrders(); return }
    if (state.activeSection !== 'orders') return

    const card = document.querySelector(`[data-order-id="${orderId}"]`)
    if (!card) {
      // Order not currently in DOM (e.g. filtered out) — do a full reload
      loadOrders()
      return
    }

    // If the event carries only a status change, patch the status badge in-place
    // without an extra network round-trip.
    if (data.status) {
      const statusKey   = data.status
      const statusLabel = STATUS_LABELS[statusKey] ?? statusKey
      const badge = card.querySelector('.order-status')
      if (badge) {
        badge.className   = `order-status ${statusKey}`
        badge.textContent = statusLabel
      }
    } else {
      // For other updates (e.g. courseFired) that we can't patch cheaply, reload
      loadOrders()
    }
  })

  es.addEventListener('printer_warning', (e) => {
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }
    const msg = data.message ?? 'Printer warning: WebPRNT fallback active — check printer settings'
    showToast(msg, 'error')
  })

  es.addEventListener('print_error', (e) => {
    _sseLastEventAt = Date.now()
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }
    showPrintErrorModal(data)
  })

  es.addEventListener('payment_alert', (e) => {
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }

    const amountStr = data.amountCents ? `$${(data.amountCents / 100).toFixed(2)}` : ''
    showToast(`⚠ Payment unmatched${amountStr ? ' ' + amountStr : ''} — not found in processor`, 'error')

    // Show alert badge on Payments tab (unless already viewing it)
    if (ordersState.activeTab !== 'payments') {
      _paymentsAlertPending = true
      const badge = document.getElementById('payments-alert-badge')
      if (badge) badge.hidden = false
    } else {
      // Tab is open — reload to show updated status
      loadPayments()
    }
  })

  es.addEventListener('counter_status_changed', (e) => {
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }
    updateCounterStatusUI(data)
  })

  es.addEventListener('counter_payment_result', (e) => {
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }
    // Resolve the COUNTER_WAITING screen immediately — no waiting for next poll tick
    window.PaymentModal?.notifyCounterResult?.(data)
  })

  es.addEventListener('reservation_new', (e) => {
    _sseLastEventAt = Date.now()
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }
    playNotificationSound()
    showReservationModal(data)
    if (state.activeSection === 'reservations') { loadReservations(); loadResUpcoming() }
  })

  es.addEventListener('reservation_updated', (e) => {
    _sseLastEventAt = Date.now()
    if (state.activeSection === 'reservations') { loadReservations(); loadResUpcoming() }
  })

  es.addEventListener('reservation_reminder', (e) => {
    _sseLastEventAt = Date.now()
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }
    const name = data.customerName ? ` · ${escHtml(data.customerName)}` : ''
    const party = data.partySize ? `, party of ${data.partySize}` : ''
    const mins = data.minutesUntil != null ? ` in ${data.minutesUntil} min` : ''
    showToast(`Reservation${mins}${name}${party}`, 'success')
    if (state.activeSection === 'reservations') loadResUpcoming()
  })

  es.addEventListener('gift_card_purchased', (e) => {
    _sseLastEventAt = Date.now()
    let data = {}
    try { data = JSON.parse(e.data) } catch { /* ignore */ }
    playNotificationSound()
    showGiftCardModal(data)
    if (state.activeSection === 'gift-cards') loadGiftCards(true)
  })

  es.onerror = () => {
    _reconnectSSE('EventSource error')
  }
}

// Reconnect SSE when tab becomes visible after being hidden (catches stale connections
// from device sleep, screen-off, or app-switch on tablets).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (!_sseConnection) { initOrderSSE(); return }
  // If last event was >60 s ago, proactively reconnect rather than waiting for watchdog
  if (Date.now() - _sseLastEventAt > 60_000) {
    _reconnectSSE('tab re-focused after >60 s idle')
  }
})

// Expose reconnect for pwa.js network-change handler
window._reconnectSSE = _reconnectSSE

// ---------------------------------------------------------------------------
// Counter App setup panel
// ---------------------------------------------------------------------------

/** Populates the Counter App setup section with merchant ID + WS URL. */
async function loadCounterSetup() {
  const idEl = document.getElementById('counter-merchant-id')
  if (!idEl) return

  // Merchant ID is always available from state
  idEl.textContent = state.merchantId ?? '—'

  // Fetch current live connection status
  try {
    const res = await api(`/api/merchants/${state.merchantId}/counter/status`)
    if (res.ok) {
      const data = await res.json()
      updateCounterStatusUI(data)
    }
  } catch { /* non-critical */ }

  // Wire "Show" button — lazily fetches token on first click
  const showBtn  = document.getElementById('counter-show-url-btn')
  const copyBtn  = document.getElementById('counter-copy-url-btn')
  const urlEl    = document.getElementById('counter-ws-url')

  if (!showBtn || !urlEl) return

  showBtn.addEventListener('click', async () => {
    showBtn.disabled = true
    showBtn.textContent = 'Loading…'
    try {
      const res = await api(`/api/merchants/${state.merchantId}/counter/token`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { wsUrl } = await res.json()
      urlEl.textContent = wsUrl
      urlEl.dataset.url = wsUrl
      showBtn.hidden = true
      if (copyBtn) copyBtn.hidden = false
    } catch (err) {
      showBtn.disabled = false
      showBtn.textContent = 'Show'
      showToast('Failed to load counter URL — ' + (err.message ?? err), 'error')
    }
  })

  // Wire copy buttons
  document.querySelectorAll('.counter-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId  = btn.dataset.copyTarget
      const targetEl  = document.getElementById(targetId)
      const text      = targetEl?.dataset.url ?? targetEl?.textContent?.trim() ?? ''
      if (!text || text === '—') return
      navigator.clipboard.writeText(text).then(() => {
        const origHtml = btn.innerHTML
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.innerHTML = origHtml }, 1500)
      }).catch(() => showToast('Copy failed — please copy manually', 'error'))
    })
  })
}

/**
 * Updates the counter status dot + label.
 * @param {{ connected: boolean, deviceConnected: boolean }} data
 */
function updateCounterStatusUI(data) {
  const dot   = document.getElementById('counter-app-dot')
  const label = document.getElementById('counter-app-status-label')
  if (!dot || !label) return

  if (!data.connected) {
    dot.style.background   = 'var(--clr-neutral-300, #d1d5db)'
    label.textContent      = 'Counter app not connected'
    label.style.color      = 'var(--color-text-muted, #6b7280)'
  } else if (!data.deviceConnected) {
    dot.style.background   = '#f59e0b'
    label.textContent      = 'Counter app connected — terminal offline'
    label.style.color      = '#92400e'
  } else {
    dot.style.background   = '#22c55e'
    label.textContent      = 'Counter app connected — terminal ready'
    label.style.color      = 'var(--color-text, #111827)'
  }
}

// ---------------------------------------------------------------------------
// Feedback section
// ---------------------------------------------------------------------------

let _feedbackOffset = 0
const _feedbackLimit = 25
let _feedbackLoading = false
let _fbFilterType = ''   // '' | 'order' | 'app'
let _fbFilterDays = ''   // '' | '7' | '30'
let _fbFilterFrom = ''   // YYYY-MM-DD or ''
let _fbFilterTo   = ''   // YYYY-MM-DD or ''

/**
 * Escape HTML special characters for safe insertion via innerHTML.
 * @param {string} str
 * @returns {string}
 */
function escFb(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Render a filled/empty star string for a given rating.
 * @param {number} stars  1–5
 * @returns {string}
 */
function _starsHtml(stars) {
  return '★'.repeat(Math.max(0, Math.min(5, stars))) + '☆'.repeat(Math.max(0, 5 - stars))
}

/**
 * Load and render feedback entries.
 * @param {boolean} [reset=false]  Reset offset and clear list (e.g. on first load)
 */
async function loadFeedback(reset) {
  if (_feedbackLoading) return
  if (reset) {
    _feedbackOffset = 0
    const listEl = document.getElementById('feedback-list')
    if (listEl) listEl.innerHTML = ''
  }

  const loadingEl  = document.getElementById('feedback-list-loading')
  const emptyEl    = document.getElementById('feedback-list-empty')
  const loadMoreEl = document.getElementById('feedback-list-load-more')

  if (loadingEl) loadingEl.hidden = !reset
  if (emptyEl)   emptyEl.hidden   = true
  if (loadMoreEl) loadMoreEl.hidden = true

  _feedbackLoading = true

  try {
    let fbUrl = `/api/merchants/${state.merchantId}/feedback?offset=${_feedbackOffset}&limit=${_feedbackLimit}`
    if (_fbFilterType) fbUrl += `&type=${_fbFilterType}`
    if (_fbFilterDays) fbUrl += `&days=${_fbFilterDays}`
    if (_fbFilterFrom) fbUrl += `&from=${_fbFilterFrom}`
    if (_fbFilterTo)   fbUrl += `&to=${_fbFilterTo}`
    const res = await api(fbUrl)
    if (!res.ok) {
      if (res.status === 401) { clearAuth(); window.location.href = '/setup'; return }
      throw new Error(`HTTP ${res.status}`)
    }
    const { feedback, total } = await res.json()

    if (loadingEl) loadingEl.hidden = true

    const listEl = document.getElementById('feedback-list')
    if (!listEl) return

    if (feedback.length === 0 && _feedbackOffset === 0) {
      if (emptyEl) emptyEl.hidden = false
      return
    }

    feedback.forEach((item) => {
      const li = document.createElement('li')
      li.className = 'feedback-item'

      const date = item.createdAt
        ? new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : ''

      const typeLabel  = item.type === 'app' ? 'App' : 'Order'
      const typeClass  = item.type === 'app' ? 'feedback-item-type--app' : 'feedback-item-type--order'
      const orderRef   = item.pickupCode ? `#${escFb(item.pickupCode)}` : ''

      // Dish ratings chips
      let dishHtml = ''
      if (Array.isArray(item.dishRatings) && item.dishRatings.length) {
        const chips = item.dishRatings.map((d) => {
          const cls = d.thumbs === 'up' ? 'feedback-item-dish-chip--up' : 'feedback-item-dish-chip--down'
          const icon = d.thumbs === 'up' ? '👍' : '👎'
          return `<li class="feedback-item-dish-chip ${cls}">${icon} ${escFb(d.name)}</li>`
        }).join('')
        dishHtml = `<ul class="feedback-item-dish-ratings">${chips}</ul>`
      }

      const commentHtml = item.comment
        ? `<p class="feedback-item-comment">${escFb(item.comment)}</p>`
        : ''

      const contactHtml = item.contact
        ? `<p class="feedback-item-contact">📬 ${escFb(item.contact)}</p>`
        : ''

      li.innerHTML = `
        <div class="feedback-item-header">
          <span class="feedback-item-stars" aria-label="${item.stars} out of 5 stars">${_starsHtml(item.stars)}</span>
          <span class="feedback-item-type ${typeClass}">${typeLabel}</span>
          ${orderRef ? `<span class="feedback-item-order-ref">${orderRef}</span>` : ''}
          <span class="feedback-item-meta">${escFb(date)}</span>
        </div>
        ${dishHtml}
        ${commentHtml}
        ${contactHtml}
      `
      listEl.appendChild(li)
    })

    _feedbackOffset += feedback.length

    // Show "Load more" if there are more entries
    if (_feedbackOffset < total) {
      if (loadMoreEl) loadMoreEl.hidden = false
    }
  } catch (err) {
    if (loadingEl) loadingEl.hidden = true
    showToast(`Could not load feedback: ${err.message}`, 'error')
  } finally {
    _feedbackLoading = false
  }
}

/**
 * Load feedback stats (average ratings + top dishes).
 */
async function loadFeedbackStats() {
  let statsUrl = `/api/merchants/${state.merchantId}/feedback/stats?_=1`
  if (_fbFilterDays) statsUrl += `&days=${_fbFilterDays}`
  if (_fbFilterFrom) statsUrl += `&from=${_fbFilterFrom}`
  if (_fbFilterTo)   statsUrl += `&to=${_fbFilterTo}`

  // Show loading in dish table bodies while fetching
  const likedEl    = document.getElementById('fb-top-liked')
  const dislikedEl = document.getElementById('fb-top-disliked')
  const loadingRow = '<tr><td colspan="3" class="fb-dish-table-empty">Loading…</td></tr>'
  if (likedEl)    likedEl.innerHTML    = loadingRow
  if (dislikedEl) dislikedEl.innerHTML = loadingRow

  const fmtAvg = (v) => v != null ? `${v.toFixed(1)} <span class="fb-stat-star">★</span>` : '—'
  const fmtCnt = (n) => n === 1 ? '1 review' : `${n} reviews`

  /** Render dish ranking rows into a <tbody> element. */
  const renderDishTable = (tbody, items) => {
    if (!tbody) return
    if (!items?.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="fb-dish-table-empty">No data yet</td></tr>'
      return
    }
    tbody.innerHTML = items.map((d, i) =>
      `<tr>` +
        `<td class="fb-dish-td-rank">${i + 1}</td>` +
        `<td class="fb-dish-td-name">${escFb(d.name)}</td>` +
        `<td class="fb-dish-td-count">${d.count}</td>` +
      `</tr>`
    ).join('')
  }

  try {
    const res = await api(statsUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    const overallEl  = document.getElementById('fb-stat-overall')
    const orderEl    = document.getElementById('fb-stat-order')
    const appEl      = document.getElementById('fb-stat-app')
    const overallCnt = document.getElementById('fb-stat-overall-count')
    const orderCnt   = document.getElementById('fb-stat-order-count')
    const appCnt     = document.getElementById('fb-stat-app-count')

    if (overallEl)  overallEl.innerHTML     = fmtAvg(data.overall?.avg)
    if (orderEl)    orderEl.innerHTML       = fmtAvg(data.order?.avg)
    if (appEl)      appEl.innerHTML         = fmtAvg(data.app?.avg)
    if (overallCnt) overallCnt.textContent  = fmtCnt(data.overall?.count ?? 0)
    if (orderCnt)   orderCnt.textContent    = fmtCnt(data.order?.count ?? 0)
    if (appCnt)     appCnt.textContent      = fmtCnt(data.app?.count ?? 0)

    renderDishTable(likedEl,    data.topLiked)
    renderDishTable(dislikedEl, data.topDisliked)
  } catch (err) {
    console.warn('[feedback] Stats load failed:', err)
    renderDishTable(likedEl,    [])
    renderDishTable(dislikedEl, [])
  }
}

// Wire filter buttons + "Load more" — runs immediately (script is at end of body,
// DOM is already parsed; DOMContentLoaded has already fired by this point).

document.getElementById('feedback-load-more-btn')?.addEventListener('click', () => loadFeedback(false))

// Scope all feedback filter interactions inside .fb-toolbar to avoid
// colliding with the Orders tab's .date-preset-btn elements.
const _fbToolbar = document.querySelector('.fb-toolbar')

// Type filter buttons (All / Order / App)
_fbToolbar?.querySelectorAll('.date-preset-btn[data-fb-type]').forEach((btn) => {
  btn.addEventListener('click', () => {
    _fbToolbar.querySelectorAll('.date-preset-btn[data-fb-type]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    _fbFilterType = btn.dataset.fbType || ''
    loadFeedback(true)
    loadFeedbackStats()
  })
})

// Date range preset buttons (All time / Last 7 days / Last 30 days)
_fbToolbar?.querySelectorAll('.date-preset-btn[data-fb-days]').forEach((btn) => {
  btn.addEventListener('click', () => {
    _fbToolbar.querySelectorAll('.date-preset-btn[data-fb-days]').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    _fbFilterDays = btn.dataset.fbDays || ''
    _fbFilterFrom = ''
    _fbFilterTo   = ''
    const fromEl = document.getElementById('fb-from')
    const toEl   = document.getElementById('fb-to')
    if (fromEl) fromEl.value = ''
    if (toEl)   toEl.value   = ''
    loadFeedback(true)
    loadFeedbackStats()
  })
})

// Custom date range: Apply button
document.getElementById('fb-date-apply-btn')?.addEventListener('click', () => {
  const fromEl = document.getElementById('fb-from')
  const toEl   = document.getElementById('fb-to')
  const from   = fromEl?.value || ''
  const to     = toEl?.value   || ''
  if (!from && !to) return
  _fbToolbar?.querySelectorAll('.date-preset-btn[data-fb-days]').forEach((b) => b.classList.remove('active'))
  _fbFilterDays = ''
  _fbFilterFrom = from
  _fbFilterTo   = to
  loadFeedback(true)
  loadFeedbackStats()
})

// ---------------------------------------------------------------------------
// Gift Cards section
// ---------------------------------------------------------------------------

let _gcOffset = 0
const _gcLimit = 50
let _gcLoading = false
let _gcFilterStatus = ''     // '' | 'active' | 'depleted' | 'expired'
let _gcSearch = ''
let _gcHasMore = false

/**
 * Load (or reload) the gift cards list. Pass reset=true to go back to page 1.
 * @param {boolean} [reset]
 */
async function loadGiftCards(reset) {
  if (_gcLoading) return
  if (reset) _gcOffset = 0

  _gcLoading = true
  const tbody = document.getElementById('gc-table-body')
  const loadMoreWrap = document.getElementById('gc-load-more-wrap')

  if (reset && tbody) {
    tbody.innerHTML = '<tr id="gc-table-loading"><td colspan="9" class="table-empty"><span class="spinner-sm"></span> Loading…</td></tr>'
  }
  if (loadMoreWrap) loadMoreWrap.hidden = true

  try {
    const params = new URLSearchParams({ limit: String(_gcLimit), offset: String(_gcOffset) })
    if (_gcFilterStatus) params.set('status', _gcFilterStatus)
    if (_gcSearch) params.set('search', _gcSearch)

    const res = await api(`/api/merchants/${state.merchantId}/gift-cards?${params}`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    const { giftCards, stats, hasMore } = data

    _gcHasMore = !!hasMore

    if (reset && tbody) tbody.innerHTML = ''

    if (giftCards.length === 0 && _gcOffset === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No gift cards found.</td></tr>'
    } else {
      renderGiftCardRows(giftCards)
    }

    if (stats) renderGiftCardStats(stats)

    _gcOffset += giftCards.length
    if (loadMoreWrap) loadMoreWrap.hidden = !_gcHasMore

  } catch (err) {
    console.error('[gift-cards] load error:', err)
    showToast('Could not load gift cards: ' + err.message, 'error')
    if (tbody && reset) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Failed to load. Try again.</td></tr>'
    }
  } finally {
    _gcLoading = false
  }
}

/**
 * @param {{ id: string, code: string, faceValueCents: number, balanceCents: number, customerName: string, customerEmail: string, recipientName: string, status: string, expiresAt: string, issuedAt: string }[]} cards
 */
function renderGiftCardRows(cards) {
  const tbody = document.getElementById('gc-table-body')
  if (!tbody) return
  for (const card of cards) {
    const tr = document.createElement('tr')
    const statusBadge = `<span class="badge badge-${card.status}">${escHtml(card.status)}</span>`
    const expiresAt = card.expiresAt
      ? new Date(card.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—'
    const issuedAt = card.issuedAt
      ? new Date(card.issuedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—'
    tr.innerHTML = `
      <td><code class="gc-code">${escHtml(card.code)}</code></td>
      <td>${escHtml(formatDollarCents(card.faceValueCents))}</td>
      <td>${escHtml(formatDollarCents(card.balanceCents))}</td>
      <td>${escHtml(card.customerName || '—')}</td>
      <td>${escHtml(card.recipientName || '—')}</td>
      <td>${escHtml(card.customerEmail || '—')}</td>
      <td>${statusBadge}</td>
      <td>${escHtml(expiresAt)}</td>
      <td>${escHtml(issuedAt)}</td>
      <td><button type="button" class="btn-icon gc-print-btn" data-card-id="${escHtml(card.id)}" title="Print receipt" aria-label="Print gift card receipt">🖨️</button></td>
    `
    tbody.appendChild(tr)
  }
}

/**
 * Print a gift card receipt via the dashboard API.
 * @param {string} cardId
 */
async function printGiftCardReceipt(cardId) {
  if (!state.merchantId) return
  try {
    const res = await api(`/api/merchants/${state.merchantId}/gift-cards/${cardId}/print-receipt`, {
      method: 'POST',
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      showToast(body.error || `Print failed (${res.status})`, 'error')
    } else {
      showToast('Printing…', 'success')
    }
  } catch (err) {
    showToast('Print request failed', 'error')
  }
}

/**
 * @param {{ active: number, depleted: number, expired: number, outstandingCents: number }} stats
 */
function renderGiftCardStats(stats) {
  const strip = document.getElementById('gc-dash-stats')
  if (!strip) return
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
  setVal('gc-stat-active', stats.active ?? '—')
  setVal('gc-stat-depleted', stats.depleted ?? '—')
  setVal('gc-stat-expired', stats.expired ?? '—')
  setVal('gc-stat-outstanding', stats.outstandingCents != null ? formatDollarCents(stats.outstandingCents) : '—')
  strip.hidden = false
}

/** Format cents as $X or $X.YZ */
function formatDollarCents(cents) {
  return '$' + (cents / 100).toFixed(2).replace(/\.00$/, '')
}

// Gift cards section — filter buttons + print receipt buttons (event delegation)
document.getElementById('section-gift-cards')?.addEventListener('click', (e) => {
  const printBtn = e.target?.closest('.gc-print-btn')
  if (printBtn) {
    printGiftCardReceipt(printBtn.dataset.cardId)
    return
  }

  const btn = e.target?.closest('.gc-filter-btn')
  if (!btn) return
  document.querySelectorAll('.gc-filter-btn').forEach((b) => b.classList.remove('active'))
  btn.classList.add('active')
  _gcFilterStatus = btn.dataset.status ?? ''
  loadGiftCards(true)
})

// Search (debounced)
let _gcSearchTimer = null
document.getElementById('gc-search')?.addEventListener('input', (e) => {
  clearTimeout(_gcSearchTimer)
  _gcSearchTimer = setTimeout(() => {
    _gcSearch = e.target.value.trim()
    loadGiftCards(true)
  }, 300)
})

// Load more
document.getElementById('gc-load-more-btn')?.addEventListener('click', () => {
  loadGiftCards(false)
})

// ---------------------------------------------------------------------------
// Maintenance — Grease Trap Cleaning Log (F.O.G.)
// ---------------------------------------------------------------------------

/** @type {string[]} IDs of fog entries already rendered (prevents duplicates on reload) */
let _fogEntries = []

/**
 * Load and render fog entries from the API.
 * @param {boolean} [reset] — clear the table before rendering
 */
async function loadFog(reset) {
  if (!state.merchantId) return
  if (reset) _fogEntries = []

  const tbody = document.getElementById('fog-tbody')
  if (!tbody) return

  if (reset) {
    tbody.innerHTML = '<tr id="fog-empty-row"><td colspan="6" style="text-align:center;color:#888;font-style:italic;padding:1.25rem">Loading…</td></tr>'
  }

  try {
    const res = await api(`/api/merchants/${state.merchantId}/fog`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { entries } = await res.json()
    _fogEntries = []
    renderFogRows(entries)
  } catch (err) {
    console.error('[fog] load error:', err)
    if (reset) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#c00;padding:1.25rem">Failed to load records.</td></tr>'
    }
  }
}

/**
 * Render an array of fog entries into the table.
 * @param {Array<{id:string,cleaned_date:string,cleaned_by:string,grease_gallons:number,solids_gallons:number,created_at:string}>} entries
 */
function renderFogRows(entries) {
  const tbody = document.getElementById('fog-tbody')
  if (!tbody) return

  tbody.innerHTML = ''

  if (!entries.length) {
    tbody.innerHTML = '<tr id="fog-empty-row"><td colspan="6" style="text-align:center;color:#888;font-style:italic;padding:1.25rem">No cleaning records yet.</td></tr>'
    return
  }

  for (const entry of entries) {
    _appendFogRow(tbody, entry)
  }
}

/**
 * Append a single fog entry row to the tbody.
 * @param {HTMLElement} tbody
 * @param {{id:string,cleaned_date:string,cleaned_by:string,grease_gallons:number,solids_gallons:number,created_at:string}} entry
 */
function _appendFogRow(tbody, entry) {
  document.getElementById('fog-empty-row')?.remove()

  const fmtNum = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1))
  const fmtDate = (d) => {
    const [y, m, day] = d.split('-')
    return `${m}/${day}/${y}`
  }
  const loggedAt = entry.created_at
    ? new Date(entry.created_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—'

  const tr = document.createElement('tr')
  tr.className = 'fog-row'
  tr.dataset.id = entry.id
  tr.innerHTML = `
    <td>${escHtml(fmtDate(entry.cleaned_date))}</td>
    <td>${escHtml(entry.cleaned_by)}</td>
    <td style="text-align:center">${escHtml(fmtNum(entry.grease_gallons))}</td>
    <td style="text-align:center">${escHtml(fmtNum(entry.solids_gallons))}</td>
    <td style="color:#888;font-size:.85rem">${escHtml(loggedAt)}</td>
    <td><button type="button" class="btn-icon fog-delete" aria-label="Delete record" title="Delete">✕</button></td>
  `

  tr.querySelector('.fog-delete').addEventListener('click', async () => {
    if (!confirm(`Delete the cleaning record for ${fmtDate(entry.cleaned_date)}?`)) return
    try {
      const res = await api(`/api/merchants/${state.merchantId}/fog/${entry.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      tr.remove()
      const tbody = document.getElementById('fog-tbody')
      if (tbody && !tbody.querySelector('.fog-row')) {
        tbody.innerHTML = '<tr id="fog-empty-row"><td colspan="6" style="text-align:center;color:#888;font-style:italic;padding:1.25rem">No cleaning records yet.</td></tr>'
      }
    } catch (err) {
      console.error('[fog] delete error:', err)
      showToast('Failed to delete record.', 'error')
    }
  })

  tbody.appendChild(tr)
}

// Fog form submit
document.getElementById('fog-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const dateEl    = document.getElementById('fog-date')
  const byEl      = document.getElementById('fog-cleaned-by')
  const greaseEl  = document.getElementById('fog-grease')
  const solidsEl  = document.getElementById('fog-solids')
  const submitBtn = document.getElementById('fog-submit-btn')

  const cleanedDate   = dateEl?.value.trim()
  const cleanedBy     = byEl?.value.trim()
  const greaseGallons = parseFloat(greaseEl?.value)
  const solidsGallons = parseFloat(solidsEl?.value)

  if (!cleanedDate || !cleanedBy || isNaN(greaseGallons) || isNaN(solidsGallons)) return

  submitBtn.disabled = true
  submitBtn.textContent = 'Saving…'

  try {
    const res = await api(`/api/merchants/${state.merchantId}/fog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanedDate, cleanedBy, greaseGallons, solidsGallons }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    // Reload to get server-assigned id and created_at
    await loadFog(true)
    dateEl.value = ''
    byEl.value = ''
    greaseEl.value = ''
    solidsEl.value = ''
    dateEl.focus()
  } catch (err) {
    console.error('[fog] submit error:', err)
    showToast(err.message || 'Failed to save record.', 'error')
  } finally {
    submitBtn.disabled = false
    submitBtn.textContent = 'Log Grease Trap Cleaning'
  }
})

// ---------------------------------------------------------------------------
// Hood cleaning log
// ---------------------------------------------------------------------------

/** @type {string[]} IDs of hood entries already rendered */
let _hoodFogEntries = []

/**
 * Load and render hood fog entries from the API.
 * @param {boolean} [reset]
 */
async function loadHoodFog(reset) {
  if (!state.merchantId) return
  if (reset) _hoodFogEntries = []

  const tbody = document.getElementById('fog-hood-tbody')
  if (!tbody) return

  if (reset) {
    tbody.innerHTML = '<tr id="fog-hood-empty-row"><td colspan="5" style="text-align:center;color:#888;font-style:italic;padding:1.25rem">Loading…</td></tr>'
  }

  try {
    const res = await api(`/api/merchants/${state.merchantId}/fog/hood`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { entries } = await res.json()
    _hoodFogEntries = []
    renderHoodFogRows(entries)
  } catch (err) {
    console.error('[fog-hood] load error:', err)
    if (reset) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#c00;padding:1.25rem">Failed to load records.</td></tr>'
    }
  }
}

/**
 * @param {Array<{id:string,cleaned_date:string,cleaned_by:string,notes:string|null,created_at:string}>} entries
 */
function renderHoodFogRows(entries) {
  const tbody = document.getElementById('fog-hood-tbody')
  if (!tbody) return
  _hoodFogEntries = []
  if (!entries.length) {
    tbody.innerHTML = '<tr id="fog-hood-empty-row"><td colspan="5" style="text-align:center;color:#888;font-style:italic;padding:1.25rem">No hood cleaning records yet.</td></tr>'
    return
  }
  tbody.innerHTML = ''
  entries.forEach(entry => _appendHoodFogRow(tbody, entry))
}

/**
 * @param {HTMLElement} tbody
 * @param {{id:string,cleaned_date:string,cleaned_by:string,notes:string|null,created_at:string}} entry
 */
function _appendHoodFogRow(tbody, entry) {
  document.getElementById('fog-hood-empty-row')?.remove()

  const fmtDate = (d) => {
    const [y, m, day] = d.split('-')
    return `${m}/${day}/${y}`
  }
  const loggedAt = new Date(entry.created_at + (entry.created_at.includes('Z') ? '' : 'Z'))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const tr = document.createElement('tr')
  tr.className = 'fog-row'
  tr.dataset.id = entry.id
  tr.innerHTML = `
    <td>${escHtml(fmtDate(entry.cleaned_date))}</td>
    <td>${escHtml(entry.cleaned_by)}</td>
    <td style="color:#555">${entry.notes ? escHtml(entry.notes) : ''}</td>
    <td style="color:#888;font-size:.85rem">${escHtml(loggedAt)}</td>
    <td><button type="button" class="btn-icon fog-delete" aria-label="Delete record" title="Delete">✕</button></td>
  `

  tr.querySelector('.fog-delete').addEventListener('click', async () => {
    if (!confirm(`Delete the hood cleaning record for ${fmtDate(entry.cleaned_date)}?`)) return
    try {
      const res = await api(`/api/merchants/${state.merchantId}/fog/hood/${entry.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      tr.remove()
      const tbody = document.getElementById('fog-hood-tbody')
      if (tbody && !tbody.querySelector('.fog-row')) {
        tbody.innerHTML = '<tr id="fog-hood-empty-row"><td colspan="5" style="text-align:center;color:#888;font-style:italic;padding:1.25rem">No hood cleaning records yet.</td></tr>'
      }
    } catch (err) {
      console.error('[fog-hood] delete error:', err)
      showToast('Failed to delete record.', 'error')
    }
  })

  _hoodFogEntries.push(entry.id)
  tbody.appendChild(tr)
}

// Hood form submit
document.getElementById('fog-hood-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const dateEl    = document.getElementById('fog-hood-date')
  const byEl      = document.getElementById('fog-hood-cleaned-by')
  const notesEl   = document.getElementById('fog-hood-notes')
  const submitBtn = document.getElementById('fog-hood-submit-btn')

  const cleanedDate = dateEl?.value.trim()
  const cleanedBy   = byEl?.value.trim()
  const notes       = notesEl?.value.trim() || null

  if (!cleanedDate || !cleanedBy) return

  submitBtn.disabled = true
  submitBtn.textContent = 'Saving…'

  try {
    const res = await api(`/api/merchants/${state.merchantId}/fog/hood`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanedDate, cleanedBy, notes }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    await loadHoodFog(true)
    dateEl.value = ''
    byEl.value = ''
    notesEl.value = ''
    dateEl.focus()
  } catch (err) {
    console.error('[fog-hood] submit error:', err)
    showToast(err.message || 'Failed to save record.', 'error')
  } finally {
    submitBtn.disabled = false
    submitBtn.textContent = 'Log Hood Cleaning'
  }
})
