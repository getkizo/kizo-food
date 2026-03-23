/**
 * Minimal AWS S3 client using Signature Version 4.
 * Pure node:crypto — zero external dependencies.
 */

import { createHmac, createHash } from 'node:crypto'

export interface S3Config {
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  region: string
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Upload an object to S3 using AWS Signature Version 4.
 * @param config   S3 credentials and target bucket
 * @param key      Object key (path inside bucket), e.g. "merchant123/orders/2026-02-22.json"
 * @param body     UTF-8 string content
 * @param contentType  MIME type (default: application/json)
 */
export async function s3PutObject(
  config: S3Config,
  key: string,
  body: string,
  contentType = 'application/json'
): Promise<void> {
  const { accessKeyId, secretAccessKey, bucket, region } = config
  const service = 's3'
  const host    = `${bucket}.s3.${region}.amazonaws.com`
  const path    = '/' + key.replace(/^\//, '')

  // AWS date strings
  const now       = new Date()
  const amzDate   = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')  // 20260222T143000Z
  const dateStamp = amzDate.slice(0, 8)                                              // 20260222

  const payloadHash = sha256Hex(body)

  // ── Canonical request ──────────────────────────────────────────────────────
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`

  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'

  const canonicalRequest = [
    'PUT',
    path,
    '',   // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // ── String to sign ─────────────────────────────────────────────────────────
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  // ── Signing key (4 rounds of HMAC) ─────────────────────────────────────────
  const kDate    = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion  = hmac(kDate,    region)
  const kService = hmac(kRegion,  service)
  const kSigning = hmac(kService, 'aws4_request')

  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  // ── PUT request ────────────────────────────────────────────────────────────
  let res: Response
  try {
    res = await fetch(`https://${host}${path}`, {
      method: 'PUT',
      headers: {
        Authorization:          authorization,
        'Content-Type':         contentType,
        'x-amz-date':           amzDate,
        'x-amz-content-sha256': payloadHash,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.error('[s3] upload timed out after 60s')
    }
    throw err
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`S3 PUT failed (${res.status}): ${text.slice(0, 300)}`)
  }
}

/**
 * Download an object from S3 using AWS Signature Version 4.
 * @param config  S3 credentials and target bucket
 * @param key     Object key (path inside bucket)
 * @returns       UTF-8 string content of the object
 */
export async function s3GetObject(
  config: S3Config,
  key: string
): Promise<string> {
  const { accessKeyId, secretAccessKey, bucket, region } = config
  const service = 's3'
  const host    = `${bucket}.s3.${region}.amazonaws.com`
  const path    = '/' + key.replace(/^\//, '')

  const now       = new Date()
  const amzDate   = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)

  const payloadHash = sha256Hex('')  // GET has no body

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`

  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'

  const canonicalRequest = [
    'GET',
    path,
    '',   // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate    = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion  = hmac(kDate,    region)
  const kService = hmac(kRegion,  service)
  const kSigning = hmac(kService, 'aws4_request')

  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  let res: Response
  try {
    res = await fetch(`https://${host}${path}`, {
      method: 'GET',
      headers: {
        Authorization:          authorization,
        'x-amz-date':           amzDate,
        'x-amz-content-sha256': payloadHash,
      },
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.error('[s3] download timed out after 60s')
    }
    throw err
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`S3 GET failed (${res.status}): ${text.slice(0, 300)}`)
  }

  return res.text()
}
