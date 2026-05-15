/**
 * QR code generation utilities.
 * Uses the `qrcode` npm package with error correction level M (15% recovery).
 */

import QRCode from 'qrcode'

/** Generate a QR code PNG buffer for the given URL. */
export async function generateQrPng(url: string, size = 512): Promise<Buffer> {
  const buffer = await QRCode.toBuffer(url, {
    errorCorrectionLevel: 'M',
    type: 'png',
    width: size,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  })
  return buffer
}

/** Generate a QR code as a data URL (for embedding in HTML). */
export async function generateQrDataUrl(url: string, size = 256): Promise<string> {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    width: size,
    margin: 2,
  })
}
