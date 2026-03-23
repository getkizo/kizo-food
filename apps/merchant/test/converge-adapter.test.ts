/**
 * Converge (Elavon) adapter tests
 *
 * All external HTTP calls are intercepted via `global.fetch` mock.
 * Tests cover: payment URL generation, transaction verification, and refunds.
 */

import { test, expect, describe, afterEach } from 'bun:test'
import {
  getConvergePaymentUrl,
  verifyConvergeTransaction,
  createConvergeRefund,
  type ConvergeCredentials,
} from '../src/adapters/converge'

const sandboxCreds: ConvergeCredentials = {
  sslMerchantId: '0022458',
  sslUserId:     'apiuser',
  sslPin:        'supersecretpin',
  sandbox:       true,
}

const prodCreds: ConvergeCredentials = {
  sslMerchantId: '0022458',
  sslUserId:     'apiuser',
  sslPin:        'supersecretpin',
  sandbox:       false,
}

const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch })

// ── getConvergePaymentUrl ────────────────────────────────────────────────────

describe('getConvergePaymentUrl', () => {
  test('returns a hosted payment URL with token on success (sandbox)', async () => {
    global.fetch = async () =>
      new Response('MOCK_TOKEN_12345', { status: 200 })

    const url = await getConvergePaymentUrl(sandboxCreds, '12.50', 'https://example.com/return')
    expect(url).toContain('api.demo.convergepay.com/hosted-payments')
    expect(url).toContain('ssl_txn_auth_token=MOCK_TOKEN_12345')
  })

  test('uses production URL when sandbox is false', async () => {
    global.fetch = async (input: RequestInfo | URL) => {
      expect(input.toString()).toContain('api.convergepay.com/hosted-payments/transaction_token')
      expect(input.toString()).not.toContain('demo')
      return new Response('PROD_TOKEN', { status: 200 })
    }

    const url = await getConvergePaymentUrl(prodCreds, '12.50', 'https://example.com/return')
    expect(url).toContain('api.convergepay.com/hosted-payments')
    expect(url).not.toContain('demo')
  })

  test('truncates description to 255 characters', async () => {
    let capturedParams: URLSearchParams | null = null
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedParams = new URLSearchParams(init?.body as string)
      return new Response('TOKEN', { status: 200 })
    }

    const longDesc = 'A'.repeat(300)
    await getConvergePaymentUrl(sandboxCreds, '5.00', 'https://example.com', longDesc)
    expect(capturedParams!.get('ssl_description')!.length).toBe(255)
  })

  test('omits ssl_description when no description provided', async () => {
    let capturedParams: URLSearchParams | null = null
    global.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedParams = new URLSearchParams(init?.body as string)
      return new Response('TOKEN', { status: 200 })
    }

    await getConvergePaymentUrl(sandboxCreds, '5.00', 'https://example.com')
    expect(capturedParams!.has('ssl_description')).toBe(false)
  })

  test('throws when HTTP response is not ok', async () => {
    global.fetch = async () => new Response('Server error', { status: 503 })

    await expect(
      getConvergePaymentUrl(sandboxCreds, '12.50', 'https://example.com')
    ).rejects.toThrow('HTTP 503')
  })

  test('throws when Converge returns an ERROR token', async () => {
    global.fetch = async () => new Response('ERROR: PIN is incorrect', { status: 200 })

    await expect(
      getConvergePaymentUrl(sandboxCreds, '12.50', 'https://example.com')
    ).rejects.toThrow('Converge returned error')
  })

  test('throws when token body is empty', async () => {
    global.fetch = async () => new Response('   ', { status: 200 })

    await expect(
      getConvergePaymentUrl(sandboxCreds, '12.50', 'https://example.com')
    ).rejects.toThrow('Converge returned error')
  })
})

// ── verifyConvergeTransaction ────────────────────────────────────────────────

describe('verifyConvergeTransaction', () => {
  function makeXmlResponse(fields: Record<string, string>): string {
    const tags = Object.entries(fields)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('')
    return `<txn>${tags}</txn>`
  }

  test('returns approved:true when ssl_result is 0', async () => {
    const xml = makeXmlResponse({
      ssl_result: '0',
      ssl_amount: '12.50',
      ssl_txn_id: 'TXN_APPROVED_001',
    })
    global.fetch = async () => new Response(xml, { status: 200 })

    const result = await verifyConvergeTransaction(sandboxCreds, 'TXN_APPROVED_001')
    expect(result.approved).toBe(true)
    expect(result.amountDollars).toBe('12.50')
    expect(result.txnId).toBe('TXN_APPROVED_001')
    expect(result.raw).toBe(xml)
  })

  test('returns approved:false when ssl_result is non-zero', async () => {
    const xml = makeXmlResponse({ ssl_result: '1', ssl_amount: '0.00', ssl_txn_id: 'TXN_DECLINED' })
    global.fetch = async () => new Response(xml, { status: 200 })

    const result = await verifyConvergeTransaction(sandboxCreds, 'TXN_DECLINED')
    expect(result.approved).toBe(false)
  })

  test('returns null fields when XML tags are absent', async () => {
    global.fetch = async () => new Response('<txn></txn>', { status: 200 })

    const result = await verifyConvergeTransaction(sandboxCreds, 'TXN_EMPTY')
    expect(result.approved).toBe(false)
    expect(result.amountDollars).toBeNull()
    expect(result.txnId).toBeNull()
  })

  test('throws when HTTP response is not ok', async () => {
    global.fetch = async () => new Response('Unauthorized', { status: 401 })

    await expect(
      verifyConvergeTransaction(sandboxCreds, 'TXN_FAIL')
    ).rejects.toThrow('HTTP 401')
  })
})

// ── createConvergeRefund ─────────────────────────────────────────────────────

describe('createConvergeRefund', () => {
  function makeXmlResponse(fields: Record<string, string>): string {
    const tags = Object.entries(fields)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('')
    return `<txn>${tags}</txn>`
  }

  test('returns approved:true with refund transaction ID on success', async () => {
    const xml = makeXmlResponse({ ssl_result: '0', ssl_txn_id: 'REFUND_TXN_001' })
    global.fetch = async () => new Response(xml, { status: 200 })

    const result = await createConvergeRefund(sandboxCreds, 'TXN_ORIG_001', '5.00')
    expect(result.approved).toBe(true)
    expect(result.refundTxnId).toBe('REFUND_TXN_001')
    expect(result.raw).toBe(xml)
  })

  test('throws when refund is declined (ssl_result != 0)', async () => {
    const xml = makeXmlResponse({
      ssl_result:         '1',
      ssl_result_message: 'Refund declined by issuer',
    })
    global.fetch = async () => new Response(xml, { status: 200 })

    await expect(
      createConvergeRefund(sandboxCreds, 'TXN_ORIG_002', '5.00')
    ).rejects.toThrow('Converge refund declined')
  })

  test('throws when HTTP response is not ok', async () => {
    global.fetch = async () => new Response('Bad gateway', { status: 502 })

    await expect(
      createConvergeRefund(sandboxCreds, 'TXN_ORIG_003', '5.00')
    ).rejects.toThrow('HTTP 502')
  })

  test('includes errorMessage fallback in declined throw', async () => {
    const xml = makeXmlResponse({ ssl_result: '1', errorMessage: 'Unknown error code 99' })
    global.fetch = async () => new Response(xml, { status: 200 })

    await expect(
      createConvergeRefund(sandboxCreds, 'TXN_ORIG_004', '10.00')
    ).rejects.toThrow('Unknown error code 99')
  })

  test('uses sandbox API URL for sandbox credentials', async () => {
    let capturedUrl = ''
    global.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString()
      const xml = makeXmlResponse({ ssl_result: '0', ssl_txn_id: 'REF_SANDBOX' })
      return new Response(xml, { status: 200 })
    }

    await createConvergeRefund(sandboxCreds, 'TXN_SANDBOX', '1.00')
    expect(capturedUrl).toContain('demo.convergepay.com')
  })

  test('uses production API URL for non-sandbox credentials', async () => {
    let capturedUrl = ''
    global.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString()
      const xml = makeXmlResponse({ ssl_result: '0', ssl_txn_id: 'REF_PROD' })
      return new Response(xml, { status: 200 })
    }

    await createConvergeRefund(prodCreds, 'TXN_PROD', '1.00')
    expect(capturedUrl).not.toContain('demo')
    expect(capturedUrl).toContain('api.convergepay.com')
  })
})
