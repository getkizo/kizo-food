/**
 * SMTP transport factory
 *
 * Maps a merchant-configured provider name to explicit host/port/secure
 * options so that outbound email is not locked to Gmail.
 *
 * Supported providers (smtp_provider column on merchants):
 *   'gmail'    — smtp.gmail.com:465, TLS (App Password required)
 *   'outlook'  — smtp.office365.com:587, STARTTLS
 *   'yahoo'    — smtp.mail.yahoo.com:465, TLS
 *   'sendgrid' — smtp.sendgrid.net:587, STARTTLS (user = 'apikey')
 *   'smtp'     — generic; falls back to gmail settings (override via env)
 *
 * Any unknown value falls back to gmail settings so existing deployments
 * that pre-date the smtp_provider column keep working without changes.
 */

import nodemailer from 'nodemailer'

interface SmtpSettings {
  host: string
  port: number
  secure: boolean  // true = implicit TLS; false = STARTTLS via STARTTLS upgrade
}

const PROVIDER_SETTINGS: Record<string, SmtpSettings> = {
  gmail:    { host: 'smtp.gmail.com',        port: 465, secure: true  },
  outlook:  { host: 'smtp.office365.com',    port: 587, secure: false },
  office365:{ host: 'smtp.office365.com',    port: 587, secure: false },
  yahoo:    { host: 'smtp.mail.yahoo.com',   port: 465, secure: true  },
  sendgrid: { host: 'smtp.sendgrid.net',     port: 587, secure: false },
}

const FALLBACK: SmtpSettings = PROVIDER_SETTINGS.gmail

/**
 * Returns a nodemailer transporter for the given SMTP provider.
 *
 * @param provider - Value of the merchant's `smtp_provider` column (e.g. 'gmail')
 * @param user     - SMTP username / sender address
 * @param pass     - SMTP password / App Password / API key
 */
export function buildSmtpTransport(
  provider: string,
  user: string,
  pass: string,
): ReturnType<typeof nodemailer.createTransport> {
  const settings = PROVIDER_SETTINGS[provider.toLowerCase()] ?? FALLBACK
  return nodemailer.createTransport({
    host:   settings.host,
    port:   settings.port,
    secure: settings.secure,
    auth:   { user, pass },
  })
}
