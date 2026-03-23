#!/usr/bin/env bun
/**
 * Finix Payment Emulator
 *
 * A development/demo server that mirrors the Finix Payments API exactly.
 * Runs on port 9333 (hard-coded).
 *
 * Accepted card:  4111 1111 1111 1111  (any expiry / CVV / name / zip)
 * Declined cards: everything else
 *
 * Supported Finix API endpoints:
 *   POST /checkout_forms
 *   GET  /checkout_forms/:id
 *   GET  /transfers/:id
 *   POST /transfers/:id/reversals
 *
 * Hosted checkout page (opened by the browser):
 *   GET  /checkout/:id          — card entry form
 *   POST /checkout/:id/pay      — form submission handler
 *
 * Usage:
 *   bun run v2/scripts/finix-emulator.ts
 *
 * Configure the main server to point at the emulator:
 *   FINIX_EMULATOR_URL=http://localhost:9333   (in v2/.env)
 */

const PORT       = 9333
const BASE_URL   = `http://localhost:${PORT}`
const MAGIC_CARD = '4111111111111111'  // any spaces stripped before comparison

// Safety guard — this tool must NEVER run in production or on a shared host.
// It binds to localhost only (not 0.0.0.0), but belt-and-suspenders warning:
if (process.env.NODE_ENV === 'production') {
  console.error('[finix-emulator] ERROR: This tool must not run in production. Exiting.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// In-memory state  (no persistence — reset on restart, fine for dev/demo)
// ---------------------------------------------------------------------------

interface StoredCheckoutForm {
  id: string
  merchantId: string
  amountCents: number
  currency: string
  nickname: string
  description: string
  successReturnUrl: string
  cartReturnUrl: string
  status: 'PENDING' | 'COMPLETED' | 'FAILED'
  createdAt: string
  transferId?: string
  buyerFirstName?: string
  buyerLastName?: string
}

interface StoredTransfer {
  id: string
  checkoutFormId: string
  state: 'SUCCEEDED' | 'PENDING' | 'FAILED'
  amountCents: number
  currency: string
  type: 'DEBIT' | 'REVERSAL'
  createdAt: string
}

const checkoutForms = new Map<string, StoredCheckoutForm>()
const transfers     = new Map<string, StoredTransfer>()

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  const hex   = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}_emu${hex}`
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function finixError(message: string, code: string, status: number): Response {
  return jsonRes({ _embedded: { errors: [{ message, code }] } }, status)
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
}

function withCors(r: Response): Response {
  const out = new Response(r.body, r)
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v)
  return out
}

// ---------------------------------------------------------------------------
// Finix-shaped response builders
// ---------------------------------------------------------------------------

function checkoutFormShape(form: StoredCheckoutForm): Record<string, unknown> {
  return {
    id:                      form.id,
    merchant_id:             form.merchantId,
    nickname:                form.nickname,
    payment_frequency:       'ONE_TIME',
    payment_frequency_state: form.status,
    created_at:              form.createdAt,
    updated_at:              form.createdAt,
    link_url:                `${BASE_URL}/checkout/${form.id}`,
    amount_details: {
      total_amount: form.amountCents,
      currency:     form.currency,
      amount_type:  'FIXED',
    },
    additional_details: {
      success_return_url: form.successReturnUrl,
      cart_return_url:    form.cartReturnUrl,
    },
    _embedded: {
      transfers: form.transferId ? [{ id: form.transferId }] : [],
    },
    _links: {
      self:     { href: `${BASE_URL}/checkout_forms/${form.id}` },
      redirect: { href: `${BASE_URL}/checkout/${form.id}` },
    },
  }
}

function transferShape(t: StoredTransfer): Record<string, unknown> {
  return {
    id:         t.id,
    state:      t.state,
    amount:     t.amountCents,
    currency:   t.currency,
    type:       t.type,
    created_at: t.createdAt,
    updated_at: t.createdAt,
    _links: {
      self: { href: `${BASE_URL}/transfers/${t.id}` },
    },
  }
}

// ---------------------------------------------------------------------------
// Checkout page HTML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function checkoutPage(form: StoredCheckoutForm, errorMsg?: string): Response {
  const amtStr = `$${(form.amountCents / 100).toFixed(2)}`

  const html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pay ${esc(amtStr)} — ${esc(form.nickname)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .card{background:#1e293b;border-radius:16px;padding:2rem;width:100%;max-width:440px;box-shadow:0 25px 50px rgba(0,0,0,.5)}
    .brand{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem}
    .brand-icon{width:40px;height:40px;background:#0ea5e9;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;font-weight:900;color:#fff}
    .brand-name{font-size:.95rem;font-weight:700;color:#f1f5f9}
    .brand-sub{font-size:.7rem;color:#64748b;margin-top:.1rem}
    .demo-pill{display:inline-block;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);color:#fbbf24;font-size:.65rem;font-weight:700;padding:.1rem .4rem;border-radius:4px;letter-spacing:.06em;text-transform:uppercase;vertical-align:middle;margin-left:.35rem}
    hr{border:none;border-top:1px solid #334155;margin:.25rem 0 1.5rem}
    .amount-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1.5rem}
    .amount-label{font-size:.8rem;color:#94a3b8}
    .amount-value{font-size:1.75rem;font-weight:800;color:#f8fafc;letter-spacing:-.02em}
    .error{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);border-radius:8px;color:#fca5a5;padding:.75rem 1rem;font-size:.875rem;margin-bottom:1.25rem}
    .field{margin-bottom:.875rem}
    .field label{display:block;font-size:.7rem;font-weight:700;color:#64748b;margin-bottom:.35rem;letter-spacing:.07em;text-transform:uppercase}
    .field input{width:100%;background:#0f172a;border:1.5px solid #334155;border-radius:8px;padding:.7rem .875rem;color:#f8fafc;font-size:.95rem;outline:none;transition:border-color .15s}
    .field input:focus{border-color:#0ea5e9}
    .field input::placeholder{color:#334155}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
    .card-hint{font-size:.68rem;color:#475569;margin-top:.35rem;line-height:1.4}
    .pay-btn{width:100%;background:#0ea5e9;color:#fff;border:none;border-radius:8px;padding:.9rem;font-size:1rem;font-weight:700;cursor:pointer;margin-top:.625rem;transition:background .15s;letter-spacing:.01em}
    .pay-btn:hover{background:#38bdf8}
    .pay-btn:disabled{background:#1e3a4a;color:#475569;cursor:not-allowed}
    .secure-note{display:flex;align-items:center;justify-content:center;gap:.4rem;color:#475569;font-size:.72rem;margin-top:.875rem}
    .cancel-link{display:block;text-align:center;color:#475569;font-size:.8rem;margin-top:.875rem;text-decoration:none;transition:color .15s}
    .cancel-link:hover{color:#94a3b8}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="brand-icon">F</div>
      <div>
        <div class="brand-name">Finix Payments <span class="demo-pill">Emulator</span></div>
        <div class="brand-sub">Development &amp; demo environment</div>
      </div>
    </div>
    <hr>
    <div class="amount-row">
      <span class="amount-label">${esc(form.nickname)}</span>
      <span class="amount-value">${esc(amtStr)}</span>
    </div>

    ${errorMsg ? `<div class="error">⚠️ ${esc(errorMsg)}</div>` : ''}

    <form method="POST" action="/checkout/${esc(form.id)}/pay" id="form">
      <div class="field">
        <label>Card Number</label>
        <input type="text" name="card_number" placeholder="4111 1111 1111 1111"
               maxlength="19" autocomplete="cc-number" inputmode="numeric" required>
        <p class="card-hint">
          ✅ Approve: <strong>4111 1111 1111 1111</strong> &nbsp;·&nbsp;
          ❌ Decline: any other number
        </p>
      </div>
      <div class="row2">
        <div class="field">
          <label>Expiry</label>
          <input type="text" name="expiry" placeholder="MM/YY"
                 maxlength="5" autocomplete="cc-exp" required>
        </div>
        <div class="field">
          <label>CVV</label>
          <input type="text" name="cvv" placeholder="123"
                 maxlength="4" autocomplete="cc-csc" inputmode="numeric" required>
        </div>
      </div>
      <div class="field">
        <label>Name on Card</label>
        <input type="text" name="name" placeholder="Alice Smith" autocomplete="cc-name">
      </div>
      <div class="field">
        <label>Billing ZIP</label>
        <input type="text" name="zip" placeholder="98101" maxlength="10" autocomplete="postal-code" inputmode="numeric">
      </div>
      <button type="submit" class="pay-btn" id="pay-btn">Pay ${esc(amtStr)}</button>
    </form>

    <div class="secure-note">
      <svg width="11" height="13" viewBox="0 0 12 14" fill="none">
        <rect x="1" y="5" width="10" height="8" rx="1.5" stroke="#475569" stroke-width="1.3"/>
        <path d="M3.5 5V3.5a2.5 2.5 0 015 0V5" stroke="#475569" stroke-width="1.3"/>
      </svg>
      Secured by Finix Payments (emulator)
    </div>
    <a href="${esc(form.cartReturnUrl)}" class="cancel-link">← Return to merchant</a>
  </div>

  <script>
    // Auto-format card number with spaces
    const cardEl = document.querySelector('[name=card_number]')
    cardEl.addEventListener('input', e => {
      let v = e.target.value.replace(/\D/g, '').slice(0, 16)
      e.target.value = v.replace(/(\d{4})(?=\d)/g, '$1 ')
    })
    // Auto-format expiry MM/YY
    const expEl = document.querySelector('[name=expiry]')
    expEl.addEventListener('input', e => {
      let v = e.target.value.replace(/\D/g, '').slice(0, 4)
      if (v.length >= 3) v = v.slice(0,2) + '/' + v.slice(2)
      e.target.value = v
    })
    // Disable button while submitting
    document.getElementById('form').addEventListener('submit', () => {
      const btn = document.getElementById('pay-btn')
      btn.disabled = true
      btn.textContent = 'Processing…'
    })
  </script>
</body>
</html>`

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    const url      = new URL(req.url)
    const path     = url.pathname
    const method   = req.method

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // ── POST /checkout_forms ───────────────────────────────────────────────
    if (method === 'POST' && path === '/checkout_forms') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>

      const amountCents = (body.amount_details as Record<string,unknown>)?.total_amount
      if (typeof amountCents !== 'number' || amountCents <= 0) {
        return withCors(finixError('amount_details.total_amount is required', 'VALIDATION_ERROR', 400))
      }

      const details   = (body.additional_details as Record<string,unknown>) ?? {}
      const buyerInfo = (body.buyer_details     as Record<string,unknown>) ?? {}
      const id        = genId('cf')
      const now       = new Date().toISOString()

      const form: StoredCheckoutForm = {
        id,
        merchantId:       (body.merchant_id as string) ?? 'emulator',
        amountCents,
        currency:         (body.amount_details as Record<string,unknown>)?.currency as string ?? 'USD',
        nickname:         (body.nickname as string) ?? 'Payment',
        description:      ((body.items as unknown[])?.[0] as Record<string,unknown>)?.description as string ?? 'Order Payment',
        successReturnUrl: (details.success_return_url as string) ?? '/',
        cartReturnUrl:    (details.cart_return_url    as string) ?? '/',
        status:           'PENDING',
        createdAt:        now,
        buyerFirstName:   (buyerInfo.first_name as string) || undefined,
        buyerLastName:    (buyerInfo.last_name  as string) || undefined,
      }

      checkoutForms.set(id, form)

      console.log(
        `[finix-emu] ✦ Created checkout form ${id}` +
        ` amount=$${(amountCents / 100).toFixed(2)}` +
        ` merchant=${form.merchantId}`
      )

      return withCors(jsonRes(checkoutFormShape(form), 201))
    }

    // ── GET /checkout_forms/:id ────────────────────────────────────────────
    const cfMatch = path.match(/^\/checkout_forms\/([^/]+)$/)
    if (method === 'GET' && cfMatch) {
      const form = checkoutForms.get(cfMatch[1])
      if (!form) return withCors(finixError('Checkout form not found', 'NOT_FOUND', 404))
      return withCors(jsonRes(checkoutFormShape(form)))
    }

    // ── GET /transfers/:id ─────────────────────────────────────────────────
    const trMatch = path.match(/^\/transfers\/([^/]+)$/)
    if (method === 'GET' && trMatch) {
      const t = transfers.get(trMatch[1])
      if (!t) return withCors(finixError('Transfer not found', 'NOT_FOUND', 404))
      return withCors(jsonRes(transferShape(t)))
    }

    // ── POST /transfers/:id/reversals ──────────────────────────────────────
    const revMatch = path.match(/^\/transfers\/([^/]+)\/reversals$/)
    if (method === 'POST' && revMatch) {
      const original = transfers.get(revMatch[1])
      if (!original) return withCors(finixError('Transfer not found', 'NOT_FOUND', 404))

      if (original.state !== 'SUCCEEDED') {
        return withCors(finixError(
          `Transfer state must be SUCCEEDED, was ${original.state}`,
          'TRANSFER_NOT_SETTLED',
          422,
        ))
      }

      const body          = await req.json().catch(() => ({})) as Record<string, unknown>
      const refundCents   = typeof body.refund_amount === 'number'
        ? body.refund_amount
        : original.amountCents

      const reversalId = genId('tra')
      const now        = new Date().toISOString()

      const reversal: StoredTransfer = {
        id:             reversalId,
        checkoutFormId: original.checkoutFormId,
        state:          'SUCCEEDED',
        amountCents:    refundCents,
        currency:       original.currency,
        type:           'REVERSAL',
        createdAt:      now,
      }
      transfers.set(reversalId, reversal)

      console.log(
        `[finix-emu] ↩ Reversal ${reversalId}` +
        ` for transfer ${revMatch[1]}` +
        ` amount=$${(refundCents / 100).toFixed(2)}`
      )

      return withCors(jsonRes(transferShape(reversal), 201))
    }

    // ── GET /checkout/:id  — hosted card entry page ────────────────────────
    const checkoutMatch = path.match(/^\/checkout\/([^/]+)$/)
    if (method === 'GET' && checkoutMatch) {
      const form = checkoutForms.get(checkoutMatch[1])
      if (!form) {
        return new Response('Payment session not found or expired.', { status: 404 })
      }
      if (form.status !== 'PENDING') {
        return new Response('This payment link has already been used.', { status: 410 })
      }
      return checkoutPage(form)
    }

    // ── POST /checkout/:id/pay  — card submission ──────────────────────────
    const payMatch = path.match(/^\/checkout\/([^/]+)\/pay$/)
    if (method === 'POST' && payMatch) {
      const form = checkoutForms.get(payMatch[1])
      if (!form) {
        return new Response('Payment session not found.', { status: 404 })
      }
      if (form.status !== 'PENDING') {
        return new Response('This payment link has already been used.', { status: 410 })
      }

      const formData = await req.formData().catch(() => null)
      if (!formData) {
        return checkoutPage(form, 'Could not read submitted card details.')
      }

      const rawCard = ((formData.get('card_number') as string) ?? '').replace(/\s/g, '')

      if (rawCard !== MAGIC_CARD) {
        const masked = rawCard.length >= 4
          ? rawCard.slice(0, 4).padEnd(rawCard.length, '•')
          : rawCard
        console.log(`[finix-emu] ✗ DECLINED card ${masked}`)
        return checkoutPage(form, 'Your card was declined. Please check the number and try again.')
      }

      // ✅ Approved — create a SUCCEEDED transfer
      const transferId = genId('tra')
      const now        = new Date().toISOString()

      const transfer: StoredTransfer = {
        id:             transferId,
        checkoutFormId: form.id,
        state:          'SUCCEEDED',
        amountCents:    form.amountCents,
        currency:       form.currency,
        type:           'DEBIT',
        createdAt:      now,
      }
      transfers.set(transferId, transfer)

      form.status     = 'COMPLETED'
      form.transferId = transferId

      console.log(
        `[finix-emu] ✓ APPROVED — transfer ${transferId}` +
        ` amount=$${(form.amountCents / 100).toFixed(2)}`
      )

      // Redirect browser to the merchant's success return URL
      return Response.redirect(form.successReturnUrl, 303)
    }

    // ── Health / fallthrough ───────────────────────────────────────────────
    if (path === '/' || path === '/health') {
      return withCors(jsonRes({
        status:  'ok',
        service: 'finix-emulator',
        port:    PORT,
        note:    'Approve card: 4111 1111 1111 1111 · Decline: any other',
      }))
    }

    return withCors(finixError('Endpoint not found', 'NOT_FOUND', 404))
  },
})

console.log(`
╔══════════════════════════════════════════════════════╗
║         Finix Payment Emulator  (dev/demo)           ║
╠══════════════════════════════════════════════════════╣
║  Listening on  http://localhost:${PORT}                ║
║                                                      ║
║  ✅  Approve:  4111 1111 1111 1111                   ║
║      (any expiry / CVV / name / zip)                 ║
║  ❌  Decline:  any other card number                 ║
╠══════════════════════════════════════════════════════╣
║  Add to v2/.env:                                     ║
║    FINIX_EMULATOR_URL=http://localhost:${PORT}         ║
╚══════════════════════════════════════════════════════╝
`)
