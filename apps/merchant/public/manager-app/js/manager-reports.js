/**
 * manager-reports.js — Report rendering module for Manager PWA
 *
 * Exposes: window.ManagerReports
 *
 * Each renderer takes (container, apiFetch, merchantId) and writes
 * directly into container.  Handles its own loading/error states.
 */
;(function () {
  'use strict'

  // ── Helpers ───────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function fmtCurrency(n) {
    if (n == null || isNaN(Number(n))) return '—'
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
  }

  /** Compact currency label for chart bars (e.g. $1.2K, $340). */
  function fmtShort(n) {
    const v = Number(n)
    if (!isFinite(v)) return '—'
    if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'K'
    return '$' + v.toFixed(0)
  }

  function fmtPct(n, plus = true) {
    if (n == null || isNaN(Number(n))) return '—'
    const s = Number(n).toFixed(1) + '%'
    return plus && Number(n) > 0 ? '+' + s : s
  }

  function fmtDateShort(iso) {
    if (!iso) return '—'
    try {
      return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    } catch { return String(iso) }
  }

  function _isoDate(d) { return d.toISOString().slice(0, 10) }

  function _loading() {
    return '<div class="mg-loading-inline"><div class="mg-spinner"></div></div>'
  }

  function _errorHtml(msg) {
    return `<div class="mg-empty-state"><p>Failed to load: ${esc(String(msg))}</p></div>`
  }

  // ── Bar chart ─────────────────────────────────────────────────────────────

  /**
   * @param {Array<{label:string, value:number}>} items
   * @param {string} [color]
   */
  function _barChart(items, color = 'var(--mg-primary)') {
    if (!items || items.length === 0) {
      return '<p class="mg-empty-sub" style="text-align:center;padding:1.5rem 0;">No data for this period.</p>'
    }
    const maxVal = Math.max(...items.map(i => Number(i.value) || 0))
    const cols = items.map(item => {
      const pct = maxVal > 0 ? Math.max(3, Math.round((Number(item.value) / maxVal) * 100)) : 3
      return `
        <div class="mg-bar-col">
          <span class="mg-bar-value">${esc(fmtShort(item.value))}</span>
          <div class="mg-bar-track">
            <div class="mg-bar" style="height:${pct}%;background:${color};"></div>
          </div>
          <span class="mg-bar-label">${esc(item.label)}</span>
        </div>`
    }).join('')
    return `<div class="mg-bar-chart">${cols}</div>`
  }

  // ── Sparkline ─────────────────────────────────────────────────────────────

  /** @param {Array<{date:string,unitPrice:number}>} history */
  function _sparkline(history, { w = 200, h = 40 } = {}) {
    if (!history || history.length < 2) return '<span class="mg-sparkline-empty">—</span>'
    const prices = history.map(p => Number(p.unitPrice ?? p.unit_price) || 0)
    const minP   = Math.min(...prices)
    const maxP   = Math.max(...prices)
    const range  = (maxP - minP) || 1
    const xStep  = w / (history.length - 1)
    const pad    = 3
    const pts    = history.map((p, i) => {
      const x = Math.round(i * xStep)
      const y = Math.round(h - pad - ((prices[i] - minP) / range) * (h - pad * 2))
      return `${x},${y}`
    }).join(' ')
    return `
      <svg class="mg-sparkline" width="${w}" height="${h}"
           viewBox="0 0 ${w} ${h}" aria-hidden="true">
        <polyline points="${pts}" fill="none"
                  stroke="var(--mg-primary)" stroke-width="1.5"
                  stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`
  }

  // ── Tab strip helper ──────────────────────────────────────────────────────

  /** Wire tab-strip clicks inside a container (uses data-tab / data-panel). */
  function _wireTabs(container) {
    container.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab
        container.querySelectorAll('[data-tab]').forEach(b => {
          b.classList.toggle('active', b.dataset.tab === tab)
          b.setAttribute('aria-selected', String(b.dataset.tab === tab))
        })
        container.querySelectorAll('[data-panel]').forEach(p => {
          p.hidden = p.dataset.panel !== tab
        })
      })
    })
  }

  // ── COGS Trend ────────────────────────────────────────────────────────────

  async function renderCogs(container, apiFetch, merchantId) {
    let granularity = 'weekly'

    async function _fetch() {
      container.innerHTML = _loading()
      try {
        const res = await apiFetch(
          `/api/merchants/${merchantId}/manager/reports/cogs?granularity=${granularity}&weeks=12`
        )
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json()
        _render(data)
      } catch (err) {
        container.innerHTML = _errorHtml(err.message)
      }
    }

    function _render(data) {
      const periods = data.periods ?? []
      const total   = periods.reduce((s, p) => s + (Number(p.total) || 0), 0)
      const items   = periods.map(p => ({ label: p.label ?? '', value: Number(p.total) || 0 }))

      container.innerHTML = `
        <div class="mg-report-section">
          <div class="mg-chart-header">
            <span class="mg-chart-total">Total: <strong>${esc(fmtCurrency(total))}</strong></span>
            <div class="mg-chart-tabs" role="group" aria-label="Chart granularity">
              <button class="mg-tab-btn${granularity === 'weekly' ? ' active' : ''}"
                      data-gran="weekly" type="button">Weekly</button>
              <button class="mg-tab-btn${granularity === 'monthly' ? ' active' : ''}"
                      data-gran="monthly" type="button">Monthly</button>
            </div>
          </div>
          <div class="mg-chart-scroll">${_barChart(items)}</div>
        </div>`

      container.querySelectorAll('.mg-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => { granularity = btn.dataset.gran; _fetch() })
      })
    }

    return _fetch()
  }

  // ── Price Changes ─────────────────────────────────────────────────────────

  async function renderPriceChanges(container, apiFetch, merchantId) {
    container.innerHTML = _loading()

    let rows = [], lastReceipt = null, lastReceiptItems = [], lastOrderItems = []
    try {
      const [pcRes, lrRes, loRes] = await Promise.all([
        apiFetch(`/api/merchants/${merchantId}/manager/reports/price-changes`),
        apiFetch(`/api/merchants/${merchantId}/manager/reports/last-receipt`),
        apiFetch(`/api/merchants/${merchantId}/manager/reports/last-order-changes`),
      ])
      if (!pcRes.ok) throw new Error(`price-changes ${pcRes.status}`)
      rows = await pcRes.json()
      if (!Array.isArray(rows)) rows = rows.items ?? rows.rows ?? []
      if (lrRes.ok) {
        const lrData = await lrRes.json()
        lastReceipt      = lrData.receipt
        lastReceiptItems = lrData.items ?? []
      }
      if (loRes.ok) lastOrderItems = await loRes.json()
    } catch (err) {
      container.innerHTML = _errorHtml(err.message)
      return
    }

    const TABS = [
      { key: 'receipt', label: 'Last Receipt', field: null,          fallback: null            },
      { key: 'last',    label: 'Last Purchase', field: null,          fallback: null            },
      { key: 'last30',  label: 'Last 30 Days', field: 'last30Delta', fallback: 'last_30_delta' },
      { key: 'ytd',     label: 'YTD',          field: 'ytdDelta',    fallback: 'ytd_delta'     },
    ]

    function _getField(row, field, fallback) {
      return row[field] ?? row[fallback]
    }

    function _tableRows(tab) {
      if (!rows.length) return '<tr><td colspan="5" class="mg-empty-cell">No price change data.</td></tr>'

      // Group by ingredient, then sort each group by tab delta desc (nulls last)
      const groups = new Map()
      for (const r of rows) {
        const key = r.ingredientId ?? r.ingredient_id ?? (r.ingredientName ?? r.ingredient_name)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(r)
      }
      // Sort vendors within each group by delta desc, then sort groups by their best delta desc
      for (const [, grp] of groups) {
        grp.sort((a, b) => {
          const da = _getField(a, tab.field, tab.fallback)
          const db = _getField(b, tab.field, tab.fallback)
          if (da == null && db == null) return 0
          if (da == null) return 1
          if (db == null) return -1
          return Number(db) - Number(da)
        })
      }

      const sortedGroups = [...groups.values()].sort((ga, gb) => {
        const topA = _getField(ga[0], tab.field, tab.fallback)
        const topB = _getField(gb[0], tab.field, tab.fallback)
        if (topA == null && topB == null) return 0
        if (topA == null) return 1
        if (topB == null) return -1
        return Number(topB) - Number(topA)
      })

      const html = []
      let rowIdx = 0
      for (const grp of sortedGroups) {
        grp.forEach((r, gi) => {
          const deltaRaw = _getField(r, tab.field, tab.fallback)
          const delta    = deltaRaw != null ? Number(deltaRaw) : null
          const cls      = delta == null ? 'mg-delta-flat'
                         : delta >  5   ? 'mg-delta-up'
                         : delta < -5   ? 'mg-delta-dn'
                         : 'mg-delta-flat'
          const name   = r.ingredientName ?? r.ingredient_name ?? '—'
          const vendor = r.vendorName ?? r.vendor_name ?? '—'
          const fromPrice = tab.key === 'ytd'
            ? (r.ytdStartUnitPrice   ?? r.ytd_start_unit_price   ?? r.previousUnitPrice ?? r.previous_unit_price)
            : tab.key === 'last30'
              ? (r.last30StartUnitPrice ?? r.last_30_start_unit_price ?? r.previousUnitPrice ?? r.previous_unit_price)
              : (r.previousUnitPrice ?? r.previous_unit_price)
          const deltaCell = delta != null
            ? `<span class="mg-delta ${cls}">${esc(fmtPct(delta))}</span>`
            : `<span class="mg-delta mg-delta-flat">—</span>`
          // Show ingredient name only on the first row of each group
          const nameCell = gi === 0 ? `<td rowspan="${grp.length}">${esc(name)}</td>` : ''
          html.push(`
            <tr class="mg-pc-row${gi > 0 ? ' mg-pc-row-vendor' : ''}" data-row-idx="${rowIdx}"
                tabindex="0" role="button" aria-expanded="false"
                aria-label="${esc(name)} — ${esc(vendor)} price history">
              ${nameCell}
              <td>${esc(vendor)}</td>
              <td class="mg-td-num">${esc(fmtCurrency(fromPrice))}</td>
              <td class="mg-td-num">${esc(fmtCurrency(r.latestUnitPrice ?? r.latest_unit_price))}</td>
              <td class="mg-td-num">${deltaCell}</td>
            </tr>
            <tr class="mg-pc-spark-row" data-spark-idx="${rowIdx}" hidden>
              <td colspan="5" class="mg-pc-spark-cell">
                ${_sparkline(r.history ?? [], { w: 220, h: 44 })}
                <span class="mg-pc-spark-label">Unit price history — ${esc(vendor)}</span>
              </td>
            </tr>`)
          rowIdx++
        })
      }
      return html.join('')
    }

    function _lastReceiptRows() {
      if (!lastReceipt) return '<tr><td colspan="5" class="mg-empty-cell">No receipts uploaded yet.</td></tr>'
      if (!lastReceiptItems.length) return '<tr><td colspan="5" class="mg-empty-cell">No line items in last receipt.</td></tr>'

      // Sort: biggest increase first, decreases after, no-prev last
      const sorted = [...lastReceiptItems].sort((a, b) => {
        if (a.delta == null && b.delta == null) return 0
        if (a.delta == null) return 1
        if (b.delta == null) return -1
        return b.delta - a.delta
      })

      return sorted.map(item => {
        const delta = item.delta
        const cls   = delta == null ? 'mg-delta-flat'
                    : delta >  5    ? 'mg-delta-up'
                    : delta < -5    ? 'mg-delta-dn'
                    : 'mg-delta-flat'
        const deltaCell = delta != null
          ? `<span class="mg-delta ${cls}">${esc(fmtPct(delta))}</span>`
          : item.prevUnitPrice != null
            ? `<span class="mg-delta mg-delta-flat">—</span>`
            : `<span class="mg-delta mg-delta-flat">new</span>`
        const prevVendorLabel = item.prevVendorName && item.prevVendorName !== lastReceipt?.vendorName
          ? `${esc(item.prevVendorName)} · ` : ''
        const prevCell = item.prevUnitPrice != null
          ? `${esc(fmtCurrency(item.prevUnitPrice))} <span class="mg-pc-prev-age">${prevVendorLabel}${esc(item.prevLabel ?? '')}</span>`
          : `<span class="mg-pc-prev-age">no prior</span>`
        const label = item.ingredientName
          ? `${esc(item.description)} <span class="mg-pc-ingr-tag">${esc(item.ingredientName)}</span>`
          : esc(item.description)
        return `<tr>
          <td>${label}</td>
          <td class="mg-td-num">${prevCell}</td>
          <td class="mg-td-num">${esc(fmtCurrency(item.unitPrice))}</td>
          <td class="mg-td-num">${deltaCell}</td>
        </tr>`
      }).join('')
    }

    function _lastOrderRows() {
      if (!lastOrderItems.length) {
        return '<tr><td colspan="5" class="mg-empty-cell">No ingredient purchase history yet.</td></tr>'
      }
      return lastOrderItems.map(item => {
        const delta = item.delta
        const cls   = delta == null ? 'mg-delta-flat'
                    : delta >  5    ? 'mg-delta-up'
                    : delta < -5    ? 'mg-delta-dn'
                    : 'mg-delta-flat'
        const deltaCell = delta != null
          ? `<span class="mg-delta ${cls}">${esc(fmtPct(delta))}</span>`
          : `<span class="mg-delta mg-delta-flat">—</span>`
        const prevCell = item.prevUnitPrice != null
          ? `${esc(fmtCurrency(item.prevUnitPrice))} <span class="mg-pc-prev-age">${esc(item.prevVendorName ?? '')}</span>`
          : `<span class="mg-pc-prev-age">no prior</span>`
        return `<tr>
          <td>${esc(item.ingredientName ?? '—')}</td>
          <td>${esc(item.latestVendorName ?? '—')}</td>
          <td class="mg-td-num">${prevCell}</td>
          <td class="mg-td-num">${esc(fmtCurrency(item.latestUnitPrice))}</td>
          <td class="mg-td-num">${deltaCell}</td>
        </tr>`
      }).join('')
    }

    const receiptHeader = lastReceipt
      ? `<div class="mg-pc-receipt-header">
           <span class="mg-pc-receipt-vendor">${esc(lastReceipt.vendorName ?? '—')}</span>
           <span class="mg-pc-receipt-date">${esc(lastReceipt.date ?? '')}</span>
         </div>`
      : ''

    container.innerHTML = `
      <div class="mg-report-section">
        <div class="mg-tab-strip" role="tablist">
          ${TABS.map((t, i) => `
            <button class="mg-tab-pill${i === 0 ? ' active' : ''}" type="button" role="tab"
                    data-tab="${t.key}" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}
        </div>

        <div class="mg-tab-panel" data-panel="receipt">
          ${receiptHeader}
          <div class="mg-detail-table-wrap">
            <table class="mg-detail-table">
              <thead><tr>
                <th>Item</th>
                <th class="mg-td-num">Prev&nbsp;$</th>
                <th class="mg-td-num">Latest&nbsp;$</th>
                <th class="mg-td-num">Change</th>
              </tr></thead>
              <tbody>${_lastReceiptRows()}</tbody>
            </table>
          </div>
        </div>

        <div class="mg-tab-panel" data-panel="last" hidden>
          <div class="mg-detail-table-wrap">
            <table class="mg-detail-table">
              <thead><tr>
                <th>Ingredient</th><th>Vendor</th>
                <th class="mg-td-num">Prev&nbsp;$</th>
                <th class="mg-td-num">Latest&nbsp;$</th>
                <th class="mg-td-num">Change</th>
              </tr></thead>
              <tbody>${_lastOrderRows()}</tbody>
            </table>
          </div>
        </div>

        ${TABS.filter(t => t.field).map(t => `
          <div class="mg-tab-panel" data-panel="${t.key}" hidden>
            <div class="mg-detail-table-wrap">
              <table class="mg-detail-table">
                <thead><tr>
                  <th>Ingredient</th><th>Vendor</th>
                  <th class="mg-td-num">Prev&nbsp;$</th>
                  <th class="mg-td-num">Latest&nbsp;$</th>
                  <th class="mg-td-num">Change</th>
                </tr></thead>
                <tbody>${_tableRows(t)}</tbody>
              </table>
            </div>
          </div>`).join('')}
      </div>`

    _wireTabs(container)

    // Sparkline row toggle (only on period tabs, not last-receipt tab)
    container.querySelectorAll('.mg-pc-row').forEach(row => {
      const activate = () => {
        const spark = container.querySelector(`[data-spark-idx="${row.dataset.rowIdx}"]`)
        if (!spark) return
        spark.hidden = !spark.hidden
        row.setAttribute('aria-expanded', String(!spark.hidden))
      }
      row.addEventListener('click', activate)
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
      })
    })
  }

  // ── Order Warnings ────────────────────────────────────────────────────────

  async function renderOrderWarnings(container, apiFetch, merchantId) {
    async function _fetch() {
      container.innerHTML = _loading()
      try {
        const res = await apiFetch(`/api/merchants/${merchantId}/manager/reports/order-warnings`)
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json()
        _render(Array.isArray(data) ? data : (data.warnings ?? []))
      } catch (err) {
        container.innerHTML = _errorHtml(err.message)
      }
    }

    async function _snooze(btn, ingredientId) {
      btn.disabled = true
      btn.textContent = 'Snoozed'
      try {
        await apiFetch(
          `/api/merchants/${merchantId}/manager/reports/order-warnings/${encodeURIComponent(ingredientId)}/snooze`,
          { method: 'POST' }
        )
        btn.closest('.mg-warning-item')?.remove()
        const list = container.querySelector('.mg-warning-list')
        if (list && !list.children.length) _fetch()
      } catch {
        btn.disabled = false
        btn.textContent = 'Snooze 7d'
      }
    }

    function _render(warnings) {
      if (!warnings.length) {
        container.innerHTML = `
          <div class="mg-report-section">
            <div class="mg-empty-state">
              <div class="mg-empty-icon">✅</div>
              <p>No order warnings.</p>
              <p class="mg-empty-sub">All tracked ingredients have been ordered recently.</p>
            </div>
          </div>`
        return
      }

      const rowsHtml = warnings.map(w => {
        const name     = w.ingredientName ?? w.ingredient_name ?? '—'
        const lastDate = fmtDateShort(w.lastOrderedDate ?? w.last_ordered_date)
        const interval = Math.round(Number(w.avgIntervalDays ?? w.avg_interval_days) || 0)
        const overdue  = Math.round(Number(w.daysOverdue ?? w.days_overdue) || 0)
        const ingId    = w.ingredientId ?? w.ingredient_id ?? ''
        return `
          <div class="mg-warning-item">
            <div class="mg-warning-info">
              <span class="mg-warning-name">${esc(name)}</span>
              <span class="mg-warning-meta">
                Last ordered ${esc(lastDate)}
                &middot; Usually every ${esc(String(interval))} days
                &middot; <span class="mg-overdue">${esc(String(overdue))} days overdue</span>
              </span>
            </div>
            <button class="mg-btn mg-btn-sm mg-btn-secondary" type="button"
                    data-ingredient-id="${esc(String(ingId))}">Snooze 7d</button>
          </div>`
      }).join('')

      container.innerHTML = `
        <div class="mg-report-section">
          <p class="mg-warnings-count">
            ${esc(String(warnings.length))} ingredient${warnings.length !== 1 ? 's' : ''} may need ordering
          </p>
          <div class="mg-warning-list">${rowsHtml}</div>
        </div>`

      container.querySelectorAll('[data-ingredient-id]').forEach(btn => {
        btn.addEventListener('click', () => _snooze(btn, btn.dataset.ingredientId))
      })
    }

    return _fetch()
  }

  // ── Vendor Spend ──────────────────────────────────────────────────────────

  async function renderVendorSpend(container, apiFetch, merchantId) {
    container.innerHTML = _loading()

    let vendors = []
    try {
      const res = await apiFetch(`/api/merchants/${merchantId}/manager/reports/vendors?months=12`)
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      vendors = Array.isArray(data) ? data : (data.vendors ?? [])
    } catch (err) {
      container.innerHTML = _errorHtml(err.message)
      return
    }

    if (!vendors.length) {
      container.innerHTML = '<div class="mg-report-section"><div class="mg-empty-state"><p>No vendor data yet.</p></div></div>'
      return
    }

    function _vendorChart(vName) {
      const vData = vendors.find(v => v.vendor === vName)
      if (!vData) return ''
      const items = (vData.months ?? []).map(m => ({
        label: (m.month ?? m.label ?? '').slice(-3),  // last 3 chars e.g. "Jan"
        value: Number(m.total) || 0,
      }))
      const tableRows = (vData.months ?? []).slice().reverse().map(m => {
        const pct = m.pctChange ?? m.pct_change ?? null
        const cls = pct == null ? '' : Number(pct) > 10 ? 'mg-delta-up' : Number(pct) < -10 ? 'mg-delta-dn' : 'mg-delta-flat'
        return `<tr>
          <td>${esc(m.month ?? m.label ?? '—')}</td>
          <td class="mg-td-num">${esc(fmtCurrency(m.total))}</td>
          <td class="mg-td-num"><span class="mg-delta ${cls}">${esc(pct != null ? fmtPct(Number(pct)) : '—')}</span></td>
        </tr>`
      }).join('')
      return `
        <div class="mg-chart-scroll">${_barChart(items, 'var(--mg-success)')}</div>
        <div class="mg-detail-table-wrap">
          <table class="mg-detail-table">
            <thead><tr>
              <th>Month</th>
              <th class="mg-td-num">Total</th>
              <th class="mg-td-num">MoM&nbsp;%</th>
            </tr></thead>
            <tbody>${tableRows || '<tr><td colspan="3" class="mg-empty-cell">No data</td></tr>'}</tbody>
          </table>
        </div>`
    }

    const opts = vendors.map(v => `<option value="${esc(v.vendor)}">${esc(v.vendor)}</option>`).join('')
    container.innerHTML = `
      <div class="mg-report-section">
        <div class="mg-vendor-select-wrap">
          <label class="mg-review-label" for="mg-vendor-sel">Vendor</label>
          <select id="mg-vendor-sel" class="mg-review-select">${opts}</select>
        </div>
        <div id="mg-vendor-chart"></div>
      </div>`

    const sel   = container.querySelector('#mg-vendor-sel')
    const chart = container.querySelector('#mg-vendor-chart')
    if (chart) chart.innerHTML = _vendorChart(vendors[0].vendor)
    sel?.addEventListener('change', () => { if (chart) chart.innerHTML = _vendorChart(sel.value) })
  }

  // ── Sales Report ──────────────────────────────────────────────────────────

  async function renderSales(container, apiFetch, merchantId) {
    const today = new Date()
    const d30   = new Date(today); d30.setDate(d30.getDate() - 29)
    let from = _isoDate(d30)
    let to   = _isoDate(today)

    function _thisMonthRange() {
      const now = new Date()
      return { from: _isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: _isoDate(now) }
    }
    function _lastMonthRange() {
      const now = new Date()
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last  = new Date(now.getFullYear(), now.getMonth(), 0)
      return { from: _isoDate(first), to: _isoDate(last) }
    }

    container.innerHTML = `
      <div class="mg-report-section">
        <div class="mg-date-range-bar">
          <button class="mg-btn mg-btn-sm mg-preset-btn" type="button" data-preset="this-month">This Month</button>
          <button class="mg-btn mg-btn-sm mg-preset-btn" type="button" data-preset="last-month">Last Month</button>
          <button class="mg-btn mg-btn-sm mg-preset-btn" type="button" data-preset="last-30">Last 30 days</button>
          <span class="mg-date-sep">&ndash;</span>
          <input type="date" id="mg-sales-from" class="mg-filter-input mg-filter-date"
                 value="${from}" aria-label="From date">
          <span class="mg-date-sep">&ndash;</span>
          <input type="date" id="mg-sales-to" class="mg-filter-input mg-filter-date"
                 value="${to}" aria-label="To date">
          <button id="mg-sales-apply" class="mg-btn mg-btn-primary mg-btn-sm" type="button">Apply</button>
        </div>
        <div class="mg-summary-grid">
          <div class="mg-summary-card">
            <span class="mg-summary-label">Revenue</span>
            <span class="mg-summary-value" id="mg-sales-revenue">—</span>
          </div>
          <div class="mg-summary-card">
            <span class="mg-summary-label">Orders</span>
            <span class="mg-summary-value" id="mg-sales-orders">—</span>
          </div>
          <div class="mg-summary-card">
            <span class="mg-summary-label">Avg Order</span>
            <span class="mg-summary-value" id="mg-sales-avg">—</span>
          </div>
        </div>
        <div class="mg-detail-table-wrap">
          <table class="mg-detail-table">
            <thead><tr>
              <th>Date</th>
              <th class="mg-td-num">Orders</th>
              <th class="mg-td-num">Revenue</th>
            </tr></thead>
            <tbody id="mg-sales-tbody"></tbody>
          </table>
        </div>
      </div>`

    container.querySelector('#mg-sales-apply')?.addEventListener('click', () => {
      from = container.querySelector('#mg-sales-from')?.value ?? from
      to   = container.querySelector('#mg-sales-to')?.value ?? to
      _fetch()
    })

    container.querySelectorAll('.mg-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        let range
        if (btn.dataset.preset === 'this-month') range = _thisMonthRange()
        else if (btn.dataset.preset === 'last-month') range = _lastMonthRange()
        else { range = { from: _isoDate(d30), to: _isoDate(today) } }
        from = range.from; to = range.to
        const fi = container.querySelector('#mg-sales-from')
        const ti = container.querySelector('#mg-sales-to')
        if (fi) fi.value = from
        if (ti) ti.value = to
        _fetch()
      })
    })

    async function _fetch() {
      const tbody = container.querySelector('#mg-sales-tbody')
      if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="mg-empty-cell"><span class="mg-spinner-sm"></span>&nbsp;Loading…</td></tr>'
      try {
        const res = await apiFetch(`/api/merchants/${merchantId}/reports/sales?from=${from}&to=${to}`)
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json()
        const summary = data.summary ?? data
        const days    = data.days ?? data.rows ?? data.data ?? []

        const totalCents = summary.amountCollectedCents ?? summary.totalRevenue ?? summary.total_revenue ?? 0
        const orderCount = summary.totalOrders ?? summary.total_orders ?? 0
        const avgCents   = orderCount > 0 ? totalCents / orderCount : null

        const rev = container.querySelector('#mg-sales-revenue')
        const ord = container.querySelector('#mg-sales-orders')
        const avg = container.querySelector('#mg-sales-avg')
        if (rev) rev.textContent = fmtCurrency(totalCents / 100)
        if (ord) ord.textContent = String(orderCount)
        if (avg) avg.textContent = avgCents != null ? fmtCurrency(avgCents / 100) : '—'

        if (tbody) {
          tbody.innerHTML = !days.length
            ? '<tr><td colspan="3" class="mg-empty-cell">No orders in this period.</td></tr>'
            : days.map(r => `<tr>
                <td>${esc(fmtDateShort(r.date))}</td>
                <td class="mg-td-num">${esc(String(r.orders ?? r.orderCount ?? r.order_count ?? 0))}</td>
                <td class="mg-td-num">${esc(fmtCurrency((r.amountCollectedCents ?? r.revenue ?? r.total ?? 0) / 100))}</td>
              </tr>`).join('')
        }
      } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" class="mg-empty-cell">${esc(err.message)}</td></tr>`
      }
    }

    return _fetch()
  }

  // ── Shifts + Tips ─────────────────────────────────────────────────────────

  async function renderShifts(container, apiFetch, merchantId) {
    const today = new Date()
    const d30   = new Date(today); d30.setDate(d30.getDate() - 29)
    let from = _isoDate(d30)
    let to   = _isoDate(today)

    container.innerHTML = `
      <div class="mg-report-section">
        <div class="mg-date-range-bar">
          <input type="date" id="mg-shifts-from" class="mg-filter-input mg-filter-date"
                 value="${from}" aria-label="From date">
          <span class="mg-date-sep">&ndash;</span>
          <input type="date" id="mg-shifts-to" class="mg-filter-input mg-filter-date"
                 value="${to}" aria-label="To date">
          <button id="mg-shifts-apply" class="mg-btn mg-btn-primary mg-btn-sm" type="button">Apply</button>
        </div>
        <div class="mg-tab-strip" role="tablist">
          <button class="mg-tab-pill active" type="button" role="tab"
                  data-tab="shifts" aria-selected="true">Shifts</button>
          <button class="mg-tab-pill" type="button" role="tab"
                  data-tab="tips" aria-selected="false">Tips</button>
        </div>
        <div class="mg-tab-panel" data-panel="shifts">
          <div class="mg-detail-table-wrap">
            <table class="mg-detail-table">
              <thead><tr>
                <th>Employee</th><th>Date</th>
                <th class="mg-td-num">In</th>
                <th class="mg-td-num">Out</th>
                <th class="mg-td-num">Hours</th>
              </tr></thead>
              <tbody id="mg-shifts-tbody"></tbody>
            </table>
          </div>
        </div>
        <div class="mg-tab-panel" data-panel="tips" hidden>
          <div class="mg-detail-table-wrap">
            <table class="mg-detail-table">
              <thead><tr>
                <th>Employee</th><th>Date</th>
                <th class="mg-td-num">Tips</th>
              </tr></thead>
              <tbody id="mg-tips-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>`

    _wireTabs(container)

    container.querySelector('#mg-shifts-apply')?.addEventListener('click', () => {
      from = container.querySelector('#mg-shifts-from')?.value ?? from
      to   = container.querySelector('#mg-shifts-to')?.value ?? to
      _fetch()
    })

    async function _fetch() {
      const shiftsTbody = container.querySelector('#mg-shifts-tbody')
      const tipsTbody   = container.querySelector('#mg-tips-tbody')
      const spinHtml = '<tr><td colspan="5" class="mg-empty-cell"><span class="mg-spinner-sm"></span>&nbsp;Loading…</td></tr>'
      if (shiftsTbody) shiftsTbody.innerHTML = spinHtml
      if (tipsTbody)   tipsTbody.innerHTML   = spinHtml.replace('colspan="5"', 'colspan="3"')

      try {
        const [sRes, tRes] = await Promise.all([
          apiFetch(`/api/merchants/${merchantId}/reports/shifts?from=${from}&to=${to}`),
          apiFetch(`/api/merchants/${merchantId}/reports/tips?from=${from}&to=${to}`),
        ])
        const shifts = sRes.ok ? ((await sRes.json()).rows ?? []) : []
        const tips   = tRes.ok ? ((await tRes.json()).rows  ?? []) : []

        if (shiftsTbody) {
          shiftsTbody.innerHTML = !shifts.length
            ? '<tr><td colspan="5" class="mg-empty-cell">No shifts in this period.</td></tr>'
            : shifts.map(s => `<tr>
                <td>${esc(s.employeeName ?? s.employee_name ?? '—')}</td>
                <td>${esc(fmtDateShort(s.date))}</td>
                <td class="mg-td-num">${esc(s.clockIn ?? s.clock_in ?? '—')}</td>
                <td class="mg-td-num">${esc(s.clockOut ?? s.clock_out ?? '—')}</td>
                <td class="mg-td-num">${s.durationHours != null || s.duration_hours != null
                  ? esc(Number(s.durationHours ?? s.duration_hours).toFixed(1)) + 'h'
                  : '—'}</td>
              </tr>`).join('')
        }

        if (tipsTbody) {
          tipsTbody.innerHTML = !tips.length
            ? '<tr><td colspan="3" class="mg-empty-cell">No tips in this period.</td></tr>'
            : tips.map(t => `<tr>
                <td>${esc(t.employeeName ?? t.employee_name ?? '—')}</td>
                <td>${esc(fmtDateShort(t.date))}</td>
                <td class="mg-td-num">${esc(fmtCurrency(t.tips ?? t.tip_total ?? t.tipTotal ?? 0))}</td>
              </tr>`).join('')
        }
      } catch (err) {
        const errHtml = `<tr><td colspan="5" class="mg-empty-cell">${esc(err.message)}</td></tr>`
        if (shiftsTbody) shiftsTbody.innerHTML = errHtml
        if (tipsTbody)   tipsTbody.innerHTML   = errHtml.replace('colspan="5"', 'colspan="3"')
      }
    }

    return _fetch()
  }

  // ── Export ────────────────────────────────────────────────────────────────

  window.ManagerReports = {
    renderCogs,
    renderPriceChanges,
    renderOrderWarnings,
    renderVendorSpend,
    renderSales,
    renderShifts,
  }
})()
