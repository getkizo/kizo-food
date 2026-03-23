/**
 * Finix payment adapter tests
 *
 * All external HTTP calls are intercepted via `global.fetch` mock.
 * Tests cover: checkout form creation, status polling, transfer retrieval, and refunds.
 */

import { test, expect, describe, afterEach } from 'bun:test'
import {
  createCheckoutForm,
  getCheckoutFormStatus,
  getTransferIdFromCheckoutForm,
  getTransfer,
  createRefund,
  type FinixCredentials,
  type CheckoutFormParams,
} from '../src/adapters/finix'

const sandboxCreds: FinixCredentials = {
  apiUsername:   'USsRhsHYZGBPnQw8CByJyEQW',
  applicationId: 'APgPDQrLD52TYvqazjHJJchM',
  merchantId:    'MUeDVrf2ahuKc9Eg5TeZugvs',
  apiPassword:   'b32e1234-5678-abcd-ef90-000000000001',
  sandbox:       true,
}

const prodCreds: FinixCredentials = { ...sandboxCreds, sandbox: false }

const baseParams: CheckoutFormParams = {
  amountCents: 1250,
  returnUrl:   'https://example.com/pay-return',
  nickname:    'Test Order',
}

const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch })

// ── createCheckoutForm ────────────────────────────────────────────────────────

describe('createCheckoutForm', () => {
  test('returns checkoutFormId and linkUrl on success', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({ id: 'cf_abc123', link_url: 'https://checkout.finix.io/cf_abc123' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )

    const result = await createCheckoutForm(sandboxCreds, baseParams)
    expect(result.checkoutFormId).toBe('cf_abc123')
    expect(result.linkUrl).toBe('https://checkout.finix.io/cf_abc123')
  })

  test('falls back to _links.redirect.href when link_url is absent', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          id:     'cf_fallback',
          _links: { redirect: { href: 'https://checkout.finix.io/cf_fallback' } },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )

    const result = await createCheckoutForm(sandboxCreds, baseParams)
    expect(result.linkUrl).toBe('https://checkout.finix.io/cf_fallback')
    expect(result.checkoutFormId).toBe('cf_fallback')
  })

  test('throws when no link URL is found in response', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ id: 'cf_no_url' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })

    await expect(createCheckoutForm(sandboxCreds, baseParams)).rejects.toThrow(
      'no redirect link'
    )
  })

  test('uses sandbox base URL for sandbox credentials', async () => {
    // Temporarily clear the emulator override so the real URL routing is exercised
    const savedEmulator = process.env.FINIX_EMULATOR_URL
    delete process.env.FINIX_EMULATOR_URL

    let capturedUrl = ''
    global.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString()
      return new Response(
        JSON.stringify({ id: 'cf_sb', link_url: 'https://sandbox.finix.io' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      await createCheckoutForm(sandboxCreds, baseParams)
      expect(capturedUrl).toContain('sandbox-payments-api.com')
    } finally {
      if (savedEmulator !== undefined) process.env.FINIX_EMULATOR_URL = savedEmulator
    }
  })

  test('uses live base URL for production credentials', async () => {
    // Temporarily clear the emulator override so the real URL routing is exercised
    const savedEmulator = process.env.FINIX_EMULATOR_URL
    delete process.env.FINIX_EMULATOR_URL

    let capturedUrl = ''
    global.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString()
      return new Response(
        JSON.stringify({ id: 'cf_prod', link_url: 'https://live.finix.io' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    }

    try {
      await createCheckoutForm(prodCreds, baseParams)
      expect(capturedUrl).toContain('live-payments-api.com')
    } finally {
      if (savedEmulator !== undefined) process.env.FINIX_EMULATOR_URL = savedEmulator
    }
  })

  test('includes buyer_details when customer name provided', async () => {
    let requestBody: Record<string, unknown> = {}
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(init?.body as string)
      return new Response(
        JSON.stringify({ id: 'cf_buyer', link_url: 'https://checkout.finix.io' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    }

    await createCheckoutForm(sandboxCreds, {
      ...baseParams,
      customerFirstName: 'Alice',
      customerLastName:  'Smith',
    })

    const buyerDetails = requestBody.buyer_details as { first_name: string; last_name: string }
    expect(buyerDetails.first_name).toBe('Alice')
    expect(buyerDetails.last_name).toBe('Smith')
  })

  test('omits buyer_details when customer name is absent', async () => {
    let requestBody: Record<string, unknown> = {}
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(init?.body as string)
      return new Response(
        JSON.stringify({ id: 'cf_no_buyer', link_url: 'https://checkout.finix.io' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    }

    await createCheckoutForm(sandboxCreds, baseParams)
    expect(requestBody.buyer_details).toBeUndefined()
  })

  test('throws Finix API error with message extracted from _embedded.errors', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          _embedded: {
            errors: [{ message: 'Merchant is not enabled', code: 'MERCHANT_DISABLED' }],
          },
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )

    await expect(createCheckoutForm(sandboxCreds, baseParams)).rejects.toThrow(
      'Merchant is not enabled'
    )
  })

  test('throws with fallback message when errors array is empty', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({ message: 'Rate limit exceeded' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      )

    await expect(createCheckoutForm(sandboxCreds, baseParams)).rejects.toThrow(
      'Rate limit exceeded'
    )
  })
})

// ── getCheckoutFormStatus ──────────────────────────────────────────────────────

describe('getCheckoutFormStatus', () => {
  test('returns checkout form data on success', async () => {
    const mockForm = { id: 'cf_abc', payment_frequency_state: 'COMPLETED' }
    global.fetch = async () =>
      new Response(JSON.stringify(mockForm), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

    const result = await getCheckoutFormStatus(sandboxCreds, 'cf_abc')
    expect(result.id).toBe('cf_abc')
    expect(result.payment_frequency_state).toBe('COMPLETED')
  })

  test('throws on 404 not found', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })

    await expect(getCheckoutFormStatus(sandboxCreds, 'cf_missing')).rejects.toThrow('404')
  })
})

// ── getTransferIdFromCheckoutForm ─────────────────────────────────────────────

describe('getTransferIdFromCheckoutForm', () => {
  test('returns transfer ID from the first embedded transfer', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'cf_paid',
          _embedded: { transfers: [{ id: 'tra_transfer_001' }, { id: 'tra_transfer_002' }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

    const result = await getTransferIdFromCheckoutForm(sandboxCreds, 'cf_paid')
    expect(result.transferId).toBe('tra_transfer_001')
  })

  test('returns null when no transfers are embedded', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({ id: 'cf_empty', _embedded: { transfers: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

    const result = await getTransferIdFromCheckoutForm(sandboxCreds, 'cf_empty')
    expect(result.transferId).toBeNull()
  })

  test('returns null when _embedded is absent', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ id: 'cf_no_embedded' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

    const result = await getTransferIdFromCheckoutForm(sandboxCreds, 'cf_no_embedded')
    expect(result.transferId).toBeNull()
  })
})

// ── getTransfer ───────────────────────────────────────────────────────────────

describe('getTransfer', () => {
  test('returns transfer state, amount, and type', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          id:     'tra_001',
          state:  'SUCCEEDED',
          amount: 1250,
          type:   'DEBIT',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

    const transfer = await getTransfer(sandboxCreds, 'tra_001')
    expect(transfer.id).toBe('tra_001')
    expect(transfer.state).toBe('SUCCEEDED')
    expect(transfer.amount).toBe(1250)
    expect(transfer.type).toBe('DEBIT')
  })

  test('throws on API error', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ message: 'Transfer not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })

    await expect(getTransfer(sandboxCreds, 'tra_missing')).rejects.toThrow('404')
  })
})

// ── createRefund ──────────────────────────────────────────────────────────────

describe('createRefund', () => {
  test('returns reversal transfer ID on full refund (no amount)', async () => {
    let requestBody: Record<string, unknown> = {}
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ id: 'tra_reversal_001' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const reversalId = await createRefund(sandboxCreds, 'tra_original_001')
    expect(reversalId).toBe('tra_reversal_001')
    // No refund_amount in body for a full refund
    expect(requestBody.refund_amount).toBeUndefined()
  })

  test('sends refund_amount in body for partial refund', async () => {
    let requestBody: Record<string, unknown> = {}
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify({ id: 'tra_partial_001' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const reversalId = await createRefund(sandboxCreds, 'tra_original_002', 500)
    expect(reversalId).toBe('tra_partial_001')
    expect(requestBody.refund_amount).toBe(500)
  })

  test('throws on API error when refund is rejected', async () => {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          _embedded: { errors: [{ message: 'Transfer state must be SUCCEEDED' }] },
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )

    await expect(createRefund(sandboxCreds, 'tra_pending_001', 500)).rejects.toThrow(
      'Transfer state must be SUCCEEDED'
    )
  })

  test('sends Basic auth header with base64-encoded credentials', async () => {
    let authHeader = ''
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      authHeader = (init?.headers as Record<string, string>)['Authorization'] ?? ''
      return new Response(JSON.stringify({ id: 'tra_auth_test' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    await createRefund(sandboxCreds, 'tra_original_auth')
    expect(authHeader).toMatch(/^Basic /)
    const decoded = atob(authHeader.replace('Basic ', ''))
    expect(decoded).toContain(sandboxCreds.apiUsername)
    expect(decoded).toContain(sandboxCreds.apiPassword)
  })
})
