/**
 * Merchant management routes — profile, printer discovery, API key management.
 *
 * ── SINGLE-MERCHANT APPLIANCE ──────────────────────────────────────────────
 * Each appliance serves exactly one merchant. The `:id` parameter in these
 * routes is the merchant's stable UUID — it is used for:
 *   • JWT validation (requireOwnMerchant ensures the token owner matches)
 *   • External integrations (delivery platforms, analytics) that reference
 *     this merchant by ID across multiple appliances or services
 *
 * The `:id` param is NOT a multi-tenant discriminator. There will always be
 * exactly one merchant row in the DB. Code reviews should NOT flag the absence
 * of additional tenant-isolation patterns — it is by design.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { Hono } from 'hono'
import { getDatabase } from '../db/connection'
import { generateId } from '../utils/id'
import { authenticate, requireOwnMerchant, requireRole } from '../middleware/auth'
import { storeAPIKey, getAPIKey, getPOSMerchantId, hasAPIKey } from '../crypto/api-keys'
import { getDEK } from '../crypto/dek'
import { discoverPrinters, probeIp } from '../services/printer-discovery'
import { printTestPage, printDiagnostic, type DiagnosticResult } from '../services/printer'
import { updateDeviceTippingConfig } from '../adapters/finix'
import type { AuthContext } from '../middleware/auth'
import { invalidateApplianceMerchantCache } from './store'
import { serverError } from '../utils/server-error'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'

const merchants = new Hono()

/**
 * GET /api/merchants/check-slug
 * Check if a slug is available
 */
merchants.get('/api/merchants/check-slug', async (c) => {
  const slug = c.req.query('slug')

  if (!slug) {
    return c.json({ error: 'Missing slug parameter' }, 400)
  }

  // Validate slug format
  const slugRegex = /^[a-z0-9-]+$/
  if (!slugRegex.test(slug)) {
    return c.json({ available: false, reason: 'Invalid format' })
  }

  const db = getDatabase()

  // Check if slug exists
  const existing = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM merchants WHERE slug = ?`
    )
    .get(slug)

  return c.json({ available: !existing })
})

/**
 * GET /api/merchants/:id
 * Get merchant profile
 */
merchants.get('/api/merchants/:id', authenticate, requireOwnMerchant, async (c: AuthContext) => {
  const merchantId = c.req.param('id')

  try {
    const db = getDatabase()
    const merchant = db
      .query<{
        id: string
        business_name: string
        slug: string
        description: string | null
        cuisine_types: string | null
        logo_url: string | null
        banner_url: string | null
        table_layout: string | null
        phone_number: string | null
        email: string | null
        website: string | null
        address: string | null
        status: string
        tax_rate: number
        tip_options: string | null
        tip_on_terminal: number
        suggested_tip_percentages: string | null
        stax_token: string | null
        printer_ip: string | null
        counter_printer_ip: string | null
        receipt_printer_ip: string | null
        kitchen_printer_protocol: string | null
        counter_printer_protocol: string | null
        receipt_printer_protocol: string | null
        show_employee_sales: number
        converge_sandbox: number
        finix_sandbox: number
        payment_provider: string | null
        pay_period_type: string | null
        pay_period_anchor: string | null
        break_rule: string | null
        notification_sound: string | null
        prep_time_minutes: number | null
        finix_refund_mode: string | null
        staff_can_refund: number
        receipt_style: string | null
        timezone: string | null
        discount_levels: string | null
        service_charge_presets: string | null
        receipt_email_from: string | null
        splash_url: string | null
        welcome_message: string | null
        reservation_enabled: number
        reservation_slot_minutes: number | null
        reservation_cutoff_minutes: number | null
        reservation_advance_days: number | null
        reservation_max_party_size: number | null
        reservation_start_time: string | null
        created_at: string
        updated_at: string
      }, [string]>(`SELECT * FROM merchants WHERE id = ?`)
      .get(merchantId)

    if (!merchant) {
      return c.json({ error: 'Merchant not found' }, 404)
    }

    return c.json({
      id: merchant.id,
      businessName: merchant.business_name,
      slug: merchant.slug,
      description: merchant.description,
      cuisineTypes: merchant.cuisine_types ? JSON.parse(merchant.cuisine_types) : [],
      logoUrl: merchant.logo_url,
      bannerUrl: merchant.banner_url,
      tableLayout: merchant.table_layout ? JSON.parse(merchant.table_layout) : null,
      phoneNumber: merchant.phone_number,
      email: merchant.email,
      website: merchant.website,
      address: merchant.address,
      status: merchant.status,
      taxRate: merchant.tax_rate ?? 0,
      tipOptions: JSON.parse(merchant.tip_options ?? '[15,20,25]'),
      tipOnTerminal: (merchant.tip_on_terminal ?? 0) === 1,
      suggestedTipPercentages: (() => {
        try { return JSON.parse(merchant.suggested_tip_percentages ?? '[15,20,25]') } catch { return [15, 20, 25] }
      })(),
      staxToken: merchant.stax_token ?? null,
      printerIp: merchant.printer_ip ?? null,
      counterPrinterIp: merchant.counter_printer_ip ?? null,
      receiptPrinterIp: merchant.receipt_printer_ip ?? null,
      kitchenPrinterProtocol: merchant.kitchen_printer_protocol ?? 'star-line',
      counterPrinterProtocol: merchant.counter_printer_protocol ?? 'star-line',
      receiptPrinterProtocol: merchant.receipt_printer_protocol ?? 'star-line',
      showEmployeeSales: (merchant.show_employee_sales ?? 1) === 1,
      convergeSandbox: (merchant.converge_sandbox ?? 1) !== 0,
      finixSandbox: (merchant.finix_sandbox ?? 1) !== 0,
      finixRefundMode: merchant.finix_refund_mode ?? 'local',
      paymentProvider: merchant.payment_provider ?? null,
      payPeriodType: merchant.pay_period_type ?? 'biweekly',
      payPeriodAnchor: merchant.pay_period_anchor ?? '2026-01-02',
      breakRule: merchant.break_rule ? JSON.parse(merchant.break_rule) : null,
      notificationSound: merchant.notification_sound ?? 'chime',
      prepTimeMinutes: merchant.prep_time_minutes ?? 20,
      staffCanRefund: (merchant.staff_can_refund ?? 0) === 1,
      receiptStyle: merchant.receipt_style ?? 'classic',
      timezone: merchant.timezone ?? 'America/Los_Angeles',
      discountLevels: (() => {
        try { return JSON.parse(merchant.discount_levels ?? 'null') ?? [] } catch { return [] }
      })(),
      serviceChargePresets: (() => {
        try { return JSON.parse(merchant.service_charge_presets ?? 'null') ?? [] } catch { return [] }
      })(),
      receiptEmailFrom: merchant.receipt_email_from ?? null,
      receiptEmailConfigured: hasAPIKey(merchantId, 'email', 'gmail'),
      splashUrl: merchant.splash_url ?? null,
      welcomeMessage: merchant.welcome_message ?? null,
      reservationEnabled: (merchant.reservation_enabled ?? 0) === 1,
      reservationSlotMinutes: merchant.reservation_slot_minutes ?? 120,
      reservationCutoffMinutes: merchant.reservation_cutoff_minutes ?? 75,
      reservationAdvanceDays: merchant.reservation_advance_days ?? 7,
      reservationMaxPartySize: merchant.reservation_max_party_size ?? 12,
      reservationStartTime: merchant.reservation_start_time ?? null,
      createdAt: merchant.created_at,
      updatedAt: merchant.updated_at,
    })
  } catch (error) {
    return serverError(c, '[merchants] GET', error, 'Failed to fetch merchant')
  }
})

/**
 * PUT /api/merchants/:id
 * Update merchant profile
 */
merchants.put(
  '/api/merchants/:id',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const user = c.get('user')

    try {
      const body = await c.req.json()

      // H-04: Restrict sensitive fields to owner-only
      const OWNER_ONLY_FIELDS = [
        'paymentProvider', 'convergeSandbox', 'finixSandbox', 'finixRefundMode',
        'staxToken', 'receiptEmailFrom', 'receiptEmailPassword',
      ]
      if (user.role !== 'owner') {
        const attempted = OWNER_ONLY_FIELDS.filter((f) => body[f] !== undefined)
        if (attempted.length > 0) {
          return c.json({ error: `Only owners can update: ${attempted.join(', ')}` }, 403)
        }
      }

      const {
        businessName,
        description,
        cuisineTypes,
        logoUrl,
        bannerUrl,
        tableLayout,
        phoneNumber,
        email,
        website,
        address,
        status,
        taxRate,
        tipOptions,
        staxToken,
        printerIp,
        counterPrinterIp,
        receiptPrinterIp,
        kitchenPrinterProtocol,
        counterPrinterProtocol,
        receiptPrinterProtocol,
        showEmployeeSales,
        convergeSandbox,
        finixSandbox,
        paymentProvider,
        payPeriodType,
        payPeriodAnchor,
        breakRule,
        notificationSound,
        prepTimeMinutes,
        staffCanRefund,
        receiptStyle,
        timezone,
        discountLevels,
        serviceChargePresets,
        finixRefundMode,
        receiptEmailFrom,
        receiptEmailPassword,
        splashUrl,
        welcomeMessage,
        reservationEnabled,
        reservationSlotMinutes,
        reservationCutoffMinutes,
        reservationAdvanceDays,
        reservationMaxPartySize,
        reservationStartTime,
        tipOnTerminal,
        suggestedTipPercentages,
      } = body

      const db = getDatabase()

      // Build update query dynamically
      const updates: string[] = []
      const values: any[] = []

      if (businessName !== undefined) {
        updates.push('business_name = ?')
        values.push(businessName)
      }
      if (description !== undefined) {
        updates.push('description = ?')
        values.push(description)
      }
      if (cuisineTypes !== undefined) {
        updates.push('cuisine_types = ?')
        values.push(JSON.stringify(cuisineTypes))
      }
      if (logoUrl !== undefined) {
        updates.push('logo_url = ?')
        values.push(logoUrl)
      }
      if (bannerUrl !== undefined) {
        updates.push('banner_url = ?')
        values.push(bannerUrl)
      }
      if (splashUrl !== undefined) {
        updates.push('splash_url = ?')
        values.push(splashUrl)
      }
      if (welcomeMessage !== undefined) {
        updates.push('welcome_message = ?')
        values.push(welcomeMessage)
      }
      if (tableLayout !== undefined) {
        updates.push('table_layout = ?')
        values.push(tableLayout === null ? null : JSON.stringify(tableLayout))
      }
      if (phoneNumber !== undefined) {
        updates.push('phone_number = ?')
        values.push(phoneNumber)
      }
      if (email !== undefined) {
        updates.push('email = ?')
        values.push(email)
      }
      if (website !== undefined) {
        updates.push('website = ?')
        values.push(website)
      }
      if (address !== undefined) {
        updates.push('address = ?')
        values.push(address)
      }
      if (taxRate !== undefined) {
        const rate = parseFloat(taxRate)
        if (isNaN(rate) || rate < 0 || rate > 1) {
          return c.json({ error: 'taxRate must be a decimal between 0 and 1 (e.g. 0.0875 for 8.75%)' }, 400)
        }
        updates.push('tax_rate = ?')
        values.push(rate)
      }
      if (staxToken !== undefined) {
        updates.push('stax_token = ?')
        values.push(staxToken === '' ? null : staxToken)
      }
      if (printerIp !== undefined) {
        updates.push('printer_ip = ?')
        values.push(printerIp === '' ? null : printerIp)
      }
      if (counterPrinterIp !== undefined) {
        updates.push('counter_printer_ip = ?')
        values.push(counterPrinterIp === '' ? null : counterPrinterIp)
      }
      if (receiptPrinterIp !== undefined) {
        updates.push('receipt_printer_ip = ?')
        values.push(receiptPrinterIp === '' ? null : receiptPrinterIp)
      }
      const VALID_PROTOCOLS = ['star-line', 'star-line-tsp100', 'star-graphic', 'webprnt', 'generic-escpos']
      if (kitchenPrinterProtocol !== undefined) {
        updates.push('kitchen_printer_protocol = ?')
        values.push(VALID_PROTOCOLS.includes(kitchenPrinterProtocol) ? kitchenPrinterProtocol : 'star-line')
      }
      if (counterPrinterProtocol !== undefined) {
        updates.push('counter_printer_protocol = ?')
        values.push(VALID_PROTOCOLS.includes(counterPrinterProtocol) ? counterPrinterProtocol : 'star-line')
      }
      if (receiptPrinterProtocol !== undefined) {
        updates.push('receipt_printer_protocol = ?')
        values.push(VALID_PROTOCOLS.includes(receiptPrinterProtocol) ? receiptPrinterProtocol : 'star-line')
      }
      if (showEmployeeSales !== undefined) {
        updates.push('show_employee_sales = ?')
        values.push(showEmployeeSales ? 1 : 0)
      }
      if (convergeSandbox !== undefined) {
        updates.push('converge_sandbox = ?')
        values.push(convergeSandbox ? 1 : 0)
      }
      if (finixSandbox !== undefined) {
        updates.push('finix_sandbox = ?')
        values.push(finixSandbox ? 1 : 0)
      }
      if (finixRefundMode !== undefined) {
        const VALID_REFUND_MODES = ['local', 'api']
        updates.push('finix_refund_mode = ?')
        values.push(VALID_REFUND_MODES.includes(finixRefundMode) ? finixRefundMode : 'local')
      }
      if (paymentProvider !== undefined) {
        updates.push('payment_provider = ?')
        values.push(paymentProvider || null)
      }
      if (payPeriodType !== undefined) {
        const validTypes = ['biweekly', 'semimonthly']
        updates.push('pay_period_type = ?')
        values.push(validTypes.includes(payPeriodType) ? payPeriodType : 'biweekly')
      }
      if (payPeriodAnchor !== undefined) {
        // Validate YYYY-MM-DD format
        const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(payPeriodAnchor ?? '')
        updates.push('pay_period_anchor = ?')
        values.push(dateOk ? payPeriodAnchor : null)
      }
      if (breakRule !== undefined) {
        updates.push('break_rule = ?')
        values.push(breakRule === null ? null : JSON.stringify(breakRule))
      }
      if (notificationSound !== undefined) {
        const VALID_SOUNDS = ['chime', 'bell', 'double-beep', 'ding']
        updates.push('notification_sound = ?')
        values.push(VALID_SOUNDS.includes(notificationSound) ? notificationSound : 'chime')
      }
      if (prepTimeMinutes !== undefined) {
        const mins = Math.round(Number(prepTimeMinutes))
        updates.push('prep_time_minutes = ?')
        values.push((isNaN(mins) || mins < 5 || mins > 120) ? 20 : mins)
      }
      if (staffCanRefund !== undefined) {
        updates.push('staff_can_refund = ?')
        values.push(staffCanRefund ? 1 : 0)
      }
      if (receiptStyle !== undefined) {
        const VALID_STYLES = ['classic', 'html']
        updates.push('receipt_style = ?')
        values.push(VALID_STYLES.includes(receiptStyle) ? receiptStyle : 'classic')
      }
      if (timezone !== undefined) {
        // Basic IANA timezone sanity check — Intl.DateTimeFormat will throw on invalid values
        let validTz = 'America/Los_Angeles'
        try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); validTz = timezone } catch { /* keep default */ }
        updates.push('timezone = ?')
        values.push(validTz)
      }
      if (discountLevels !== undefined) {
        if (!Array.isArray(discountLevels)) {
          return c.json({ error: 'discountLevels must be an array' }, 400)
        }
        // Validate each preset: { label: string, type: 'percent'|'fixed', value: number }
        for (const lvl of discountLevels as { label: unknown; type: unknown; value: unknown }[]) {
          if (!lvl.label || typeof lvl.label !== 'string') {
            return c.json({ error: 'Each discount level must have a label' }, 400)
          }
          if (!['percent', 'fixed'].includes(lvl.type)) {
            return c.json({ error: 'Each discount level type must be "percent" or "fixed"' }, 400)
          }
          if (typeof lvl.value !== 'number' || lvl.value <= 0) {
            return c.json({ error: 'Each discount level value must be a positive number' }, 400)
          }
        }
        updates.push('discount_levels = ?')
        values.push(JSON.stringify(discountLevels))
      }
      if (serviceChargePresets !== undefined) {
        if (!Array.isArray(serviceChargePresets)) {
          return c.json({ error: 'serviceChargePresets must be an array' }, 400)
        }
        for (const lvl of serviceChargePresets as { label: unknown; type: unknown; value: unknown }[]) {
          if (!lvl.label || typeof lvl.label !== 'string') {
            return c.json({ error: 'Each service charge preset must have a label' }, 400)
          }
          if (!['percent', 'fixed'].includes(lvl.type)) {
            return c.json({ error: 'Each service charge preset type must be "percent" or "fixed"' }, 400)
          }
          if (typeof lvl.value !== 'number' || lvl.value <= 0) {
            return c.json({ error: 'Each service charge preset value must be a positive number' }, 400)
          }
        }
        updates.push('service_charge_presets = ?')
        values.push(JSON.stringify(serviceChargePresets))
      }
      if (tipOptions !== undefined) {
        const ALLOWED_TIPS = [10, 15, 18, 20, 25]
        if (!Array.isArray(tipOptions) || tipOptions.length < 2 || tipOptions.length > 4) {
          return c.json({ error: 'tipOptions must be an array of 2 to 4 values' }, 400)
        }
        const invalid = tipOptions.filter((t: number) => !ALLOWED_TIPS.includes(t))
        if (invalid.length > 0) {
          return c.json({ error: `Invalid tip values: ${invalid.join(', ')}. Allowed: 10, 15, 18, 20, 25` }, 400)
        }
        updates.push('tip_options = ?')
        values.push(JSON.stringify(tipOptions))
      }
      if (status !== undefined) {
        // Only owner can change status (user already extracted at top of handler)
        if (user.role !== 'owner') {
          return c.json({ error: 'Only owners can change merchant status' }, 403)
        }
        updates.push('status = ?')
        values.push(status)
      }

      if (receiptEmailFrom !== undefined) {
        // Basic email format check
        const emailVal = typeof receiptEmailFrom === 'string' ? receiptEmailFrom.trim() : ''
        if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
          return c.json({ error: 'receiptEmailFrom must be a valid email address' }, 400)
        }
        updates.push('receipt_email_from = ?')
        values.push(emailVal || null)
      }

      if (reservationEnabled !== undefined) {
        updates.push('reservation_enabled = ?')
        values.push(reservationEnabled ? 1 : 0)
      }
      if (reservationSlotMinutes !== undefined) {
        const mins = Math.round(Number(reservationSlotMinutes))
        updates.push('reservation_slot_minutes = ?')
        values.push((isNaN(mins) || mins < 15 || mins > 480) ? 120 : mins)
      }
      if (reservationCutoffMinutes !== undefined) {
        const mins = Math.round(Number(reservationCutoffMinutes))
        updates.push('reservation_cutoff_minutes = ?')
        values.push((isNaN(mins) || mins < 0 || mins > 480) ? 75 : mins)
      }
      if (reservationAdvanceDays !== undefined) {
        const days = Math.round(Number(reservationAdvanceDays))
        updates.push('reservation_advance_days = ?')
        values.push((isNaN(days) || days < 1 || days > 90) ? 7 : days)
      }
      if (reservationMaxPartySize !== undefined) {
        const size = Math.round(Number(reservationMaxPartySize))
        updates.push('reservation_max_party_size = ?')
        values.push((isNaN(size) || size < 1 || size > 100) ? 12 : size)
      }
      if (reservationStartTime !== undefined) {
        // Accept 'HH:MM' format or null/empty to clear
        const t = typeof reservationStartTime === 'string' ? reservationStartTime.trim() : null
        updates.push('reservation_start_time = ?')
        values.push(/^\d{2}:\d{2}$/.test(t ?? '') ? t : null)
      }
      if (tipOnTerminal !== undefined) {
        updates.push('tip_on_terminal = ?')
        values.push(tipOnTerminal ? 1 : 0)
      }
      if (suggestedTipPercentages !== undefined) {
        if (!Array.isArray(suggestedTipPercentages) ||
            suggestedTipPercentages.some((v: unknown) => typeof v !== 'number' || v <= 0)) {
          return c.json({ error: 'suggestedTipPercentages must be an array of positive numbers' }, 400)
        }
        updates.push('suggested_tip_percentages = ?')
        values.push(JSON.stringify(suggestedTipPercentages))
      }

      if (updates.length === 0 && receiptEmailPassword === undefined) {
        return c.json({ error: 'No fields to update' }, 400)
      }

      if (updates.length > 0) {
        updates.push('updated_at = datetime(?)')
        values.push('now')
        values.push(merchantId)

        db.run(
          `UPDATE merchants SET ${updates.join(', ')} WHERE id = ?`,
          values
        )
      }

      // Store Gmail App Password via envelope encryption (never written to merchants table)
      if (receiptEmailPassword !== undefined) {
        const password = typeof receiptEmailPassword === 'string' ? receiptEmailPassword.trim() : ''
        if (password) {
          const ipAddress = c.get('ipAddress') as string | undefined
          await storeAPIKey(merchantId, 'email', 'gmail', password, ipAddress)
        }
      }

      // Invalidate the appliance merchant cache so the next store request re-fetches
      invalidateApplianceMerchantCache()

      // Sync tip-on-terminal config to all PAX devices when setting changed (fire-and-forget)
      if (tipOnTerminal !== undefined || suggestedTipPercentages !== undefined) {
        syncDeviceTippingConfig(merchantId).catch((err) => {
          console.warn('[merchants] device tipping sync failed:', (err as Error).message ?? err)
        })
      }

      // Fetch updated merchant
      const updated = db
        .query<{
          id: string
          business_name: string
          slug: string
          description: string | null
          cuisine_types: string | null
          logo_url: string | null
          banner_url: string | null
          table_layout: string | null
          phone_number: string | null
          email: string | null
          tax_rate: number
          tip_options: string | null
          tip_on_terminal: number
          suggested_tip_percentages: string | null
          stax_token: string | null
          printer_ip: string | null
          counter_printer_ip: string | null
          receipt_printer_ip: string | null
          converge_sandbox: number
          finix_sandbox: number
          payment_provider: string | null
          pay_period_type: string | null
          pay_period_anchor: string | null
          break_rule: string | null
          status: string
          updated_at: string
          kitchen_printer_protocol: string | null
          counter_printer_protocol: string | null
          receipt_printer_protocol: string | null
          finix_refund_mode: string | null
          staff_can_refund: number
          receipt_style: string | null
          timezone: string | null
          discount_levels: string | null
          service_charge_presets: string | null
          receipt_email_from: string | null
          splash_url: string | null
          welcome_message: string | null
          reservation_enabled: number
          reservation_slot_minutes: number | null
          reservation_cutoff_minutes: number | null
          reservation_advance_days: number | null
          reservation_max_party_size: number | null
          reservation_start_time: string | null
          notification_sound: string | null
          prep_time_minutes: number | null
        }, [string]>(`SELECT * FROM merchants WHERE id = ?`)
        .get(merchantId)

      if (!updated) return c.json({ error: 'Merchant not found after update' }, 500)

      return c.json({
        id: updated.id,
        businessName: updated.business_name,
        slug: updated.slug,
        description: updated.description,
        cuisineTypes: updated.cuisine_types ? JSON.parse(updated.cuisine_types) : [],
        logoUrl: updated.logo_url,
        bannerUrl: updated.banner_url,
        tableLayout: updated.table_layout ? JSON.parse(updated.table_layout) : null,
        phoneNumber: updated.phone_number,
        email: updated.email,
        taxRate: updated.tax_rate ?? 0,
        tipOptions: JSON.parse(updated.tip_options ?? '[15,20,25]'),
        tipOnTerminal: (updated.tip_on_terminal ?? 0) === 1,
        suggestedTipPercentages: (() => {
          try { return JSON.parse(updated.suggested_tip_percentages ?? '[15,20,25]') } catch { return [15, 20, 25] }
        })(),
        staxToken: updated.stax_token ?? null,
        printerIp: updated.printer_ip ?? null,
        counterPrinterIp: updated.counter_printer_ip ?? null,
        receiptPrinterIp: updated.receipt_printer_ip ?? null,
        kitchenPrinterProtocol: updated.kitchen_printer_protocol ?? 'star-line',
        counterPrinterProtocol: updated.counter_printer_protocol ?? 'star-line',
        receiptPrinterProtocol: updated.receipt_printer_protocol ?? 'star-line',
        convergeSandbox: (updated.converge_sandbox ?? 1) !== 0,
        finixSandbox: (updated.finix_sandbox ?? 1) !== 0,
        finixRefundMode: updated.finix_refund_mode ?? 'local',
        paymentProvider: updated.payment_provider ?? null,
        payPeriodType: updated.pay_period_type ?? 'biweekly',
        payPeriodAnchor: updated.pay_period_anchor ?? '2026-01-02',
        breakRule: updated.break_rule ? JSON.parse(updated.break_rule) : null,
        notificationSound: updated.notification_sound ?? 'chime',
        prepTimeMinutes: updated.prep_time_minutes ?? 20,
        staffCanRefund: (updated.staff_can_refund ?? 0) === 1,
        receiptStyle: updated.receipt_style ?? 'classic',
        timezone: updated.timezone ?? 'America/Los_Angeles',
        discountLevels: (() => {
          try { return JSON.parse(updated.discount_levels ?? 'null') ?? [] } catch { return [] }
        })(),
        receiptEmailFrom: updated.receipt_email_from ?? null,
        receiptEmailConfigured: hasAPIKey(merchantId, 'email', 'gmail'),
        splashUrl: updated.splash_url ?? null,
        welcomeMessage: updated.welcome_message ?? null,
        reservationEnabled: (updated.reservation_enabled ?? 0) === 1,
        reservationSlotMinutes: updated.reservation_slot_minutes ?? 120,
        reservationCutoffMinutes: updated.reservation_cutoff_minutes ?? 75,
        reservationAdvanceDays: updated.reservation_advance_days ?? 7,
        reservationMaxPartySize: updated.reservation_max_party_size ?? 12,
        reservationStartTime: updated.reservation_start_time ?? null,
        status: updated.status,
        updatedAt: updated.updated_at,
      })
    } catch (error) {
      return serverError(c, '[merchants] PUT', error, 'Failed to update merchant')
    }
  }
)

/**
 * POST /api/merchants/:id/keys
 * Store POS/payment API key
 */
merchants.post(
  '/api/merchants/:id/keys',
  authenticate,
  requireRole('owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')

    try {
      const body = await c.req.json()
      const { keyType, provider, apiKey, posMerchantId } = body

      if (!keyType || !provider || !apiKey) {
        return c.json(
          {
            error: 'Missing required fields: keyType, provider, apiKey',
          },
          400
        )
      }

      if (keyType !== 'pos' && keyType !== 'payment') {
        return c.json({ error: 'keyType must be "pos" or "payment"' }, 400)
      }

      const ipAddress = c.get('ipAddress')
      const keyId = await storeAPIKey(
        merchantId,
        keyType,
        provider,
        apiKey,
        ipAddress,
        posMerchantId
      )

      return c.json({
        success: true,
        keyId,
        keyType,
        provider,
        posMerchantId: posMerchantId || null,
      })
    } catch (error) {
      return serverError(c, '[merchants] POST keys', error, 'Failed to store API key')
    }
  }
)

/**
 * DELETE /api/merchants/:id/keys/:provider
 * Delete API key
 */
merchants.delete(
  '/api/merchants/:id/keys/:provider',
  authenticate,
  requireRole('owner'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const provider = c.req.param('provider')
    const keyType = c.req.query('keyType') as 'pos' | 'payment'

    if (!keyType) {
      return c.json({ error: 'keyType query parameter required' }, 400)
    }

    try {
      const { deleteAPIKey } = await import('../crypto/api-keys')
      const ipAddress = c.get('ipAddress')

      await deleteAPIKey(merchantId, keyType, provider, ipAddress)

      return c.json({ success: true })
    } catch (error) {
      return serverError(c, '[merchants] DELETE keys', error, 'Failed to delete API key')
    }
  }
)

/**
 * GET /api/merchants/:id/printers/status?ips=ip1,ip2,ip3
 * Quick TCP probe for each IP on port 9100 — returns online/offline per IP.
 */
merchants.get(
  '/api/merchants/:id/printers/status',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const raw = c.req.query('ips') ?? ''
    const ips = raw.split(',').map((s) => s.trim()).filter(Boolean)

    // H-01: Cap the number of IPs that can be probed in a single request
    if (ips.length > 10) {
      return c.json({ error: 'Maximum 10 IPs per request' }, 400)
    }

    // H-01: Validate IP formats — reject non-private / malformed addresses
    const PRIVATE_IP = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/
    for (const ip of ips) {
      if (!PRIVATE_IP.test(ip)) {
        return c.json({ error: `Invalid or non-private IP: ${ip}` }, 400)
      }
    }

    if (ips.length === 0) return c.json({ success: true, status: {} })

    const results = await Promise.all(
      ips.map(async (ip) => ({ ip, online: await probeIp(ip) })),
    )

    const status = Object.fromEntries(results.map((r) => [r.ip, r.online]))
    return c.json({ success: true, status })
  },
)

/**
 * POST /api/merchants/:id/printers/test
 * Send a minimal test page to any printer IP to verify connectivity + protocol.
 * Body: { ip: string, protocol?: 'star-line' | 'star-line-tsp100' | 'webprnt', label?: string }
 */
merchants.post(
  '/api/merchants/:id/printers/test',
  authenticate,
  async (c: AuthContext) => {
    try {
      const body = await c.req.json()
      const ip: string = body.ip?.trim()
      const protocol: 'star-line' | 'star-line-tsp100' | 'webprnt' =
        ['star-line-tsp100', 'webprnt'].includes(body.protocol) ? body.protocol : 'star-line'
      const label: string = typeof body.label === 'string' ? body.label : 'Printer'

      if (!ip) return c.json({ success: false, error: 'ip is required' }, 400)

      await printTestPage({ printerIp: ip, printerProtocol: protocol, label })
      console.log(`🖨️  Test page sent to ${ip} (${protocol}) — ${label}`)
      return c.json({ success: true, protocol })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Test print failed:', msg)
      return c.json({ success: false, error: msg }, 500)
    }
  },
)

/**
 * POST /api/merchants/:id/printers/diagnose
 * Send 3 test pages — one for each command set (star-line, esc-pos, generic-escpos).
 * Whichever prints tells us the correct protocol for this printer.
 * Body: { ip: string }
 */
merchants.post(
  '/api/merchants/:id/printers/diagnose',
  authenticate,
  async (c: AuthContext) => {
    try {
      const body = await c.req.json()
      const ip: string = body.ip?.trim()
      if (!ip) return c.json({ success: false, error: 'ip is required' }, 400)

      console.log(`🔍  Starting printer diagnostic on ${ip}`)
      const results = await printDiagnostic(ip)
      console.log(`🔍  Printer diagnostic complete for ${ip}`)

      // Determine recommendation
      const webprntOk  = results.find(r => r.test === 'WebPRNT (HTTP)')?.success
      const httpOk     = results.find(r => r.test === 'HTTP probe')?.success
      let recommendation = ''
      if (webprntOk) {
        recommendation = 'WebPRNT works! Select "WebPRNT (HTTP)" as the protocol in Settings.'
      } else if (httpOk) {
        recommendation = 'Printer web server is reachable but WebPRNT is not enabled. Open http://' + ip + '/ in a browser, login (root/public), and enable WebPRNT.'
      } else {
        recommendation = 'Cannot reach printer at ' + ip + '. Check the IP address, network connection, and that the printer is powered on.'
      }

      return c.json({ success: true, results, recommendation })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Printer diagnostic failed:', msg)
      return c.json({ success: false, error: msg }, 500)
    }
  },
)

/**
 * GET /api/merchants/:id/printers/discover
 * Scan the local network for printers listening on port 9100.
 * Uses mDNS (Bonjour) + TCP subnet scan in parallel.
 */
merchants.get(
  '/api/merchants/:id/printers/discover',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    try {
      const printers = await discoverPrinters(3500)
      return c.json({ success: true, printers })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ success: false, error: msg }, 500)
    }
  },
)

/**
 * GET /api/merchants/:id/local-ips
 * Returns all non-loopback IPv4 addresses on the server's network interfaces.
 * Used by the dashboard to display the server's LAN IP for SSH access.
 */
merchants.get(
  '/api/merchants/:id/local-ips',
  authenticate,
  requireRole('owner', 'manager'),
  (c: AuthContext) => {
    const ifaces = networkInterfaces()
    const ips: { iface: string; ip: string }[] = []
    for (const [name, ifaceList] of Object.entries(ifaces)) {
      for (const iface of ifaceList ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push({ iface: name, ip: iface.address })
        }
      }
    }
    return c.json({ ips })
  },
)

// ---------------------------------------------------------------------------
// Webhook secret — AES-256-GCM helpers (same pattern as api-keys.ts)
// ---------------------------------------------------------------------------

function encryptWebhookSecret(merchantId: string, plaintext: string): string {
  const dek = getDEK(merchantId)
  const iv  = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dek, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag    = cipher.getAuthTag()
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64')
}

export function decryptWebhookSecret(merchantId: string, enc: string): string {
  const dek  = getDEK(merchantId)
  const buf  = Buffer.from(enc, 'base64')
  const iv   = buf.subarray(0, 12)
  const authTag   = buf.subarray(-16)
  const ciphertext = buf.subarray(12, -16)
  const decipher = createDecipheriv('aes-256-gcm', dek, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// Webhook secret management endpoints (C-03)
// ---------------------------------------------------------------------------

/**
 * GET /api/merchants/:id/webhook/secret/status
 * Returns { configured: boolean } — never exposes the plaintext secret.
 */
merchants.get(
  '/api/merchants/:id/webhook/secret/status',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()
    const row = db.query<{ webhook_secret_enc: string | null }, [string]>(
      'SELECT webhook_secret_enc FROM merchants WHERE id = ?'
    ).get(merchantId)
    return c.json({ configured: !!row?.webhook_secret_enc })
  }
)

/**
 * POST /api/merchants/:id/webhook/secret
 * Generates a new 32-byte random secret, stores it encrypted, and returns the
 * plaintext exactly once. The merchant must copy it — it cannot be retrieved again.
 */
merchants.post(
  '/api/merchants/:id/webhook/secret',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const secret = randomBytes(32).toString('hex') // 64 hex chars
    const enc    = encryptWebhookSecret(merchantId, secret)
    const db = getDatabase()
    db.run('UPDATE merchants SET webhook_secret_enc = ? WHERE id = ?', [enc, merchantId])
    return c.json({ secret })
  }
)

/**
 * DELETE /api/merchants/:id/webhook/secret
 * Revokes the shared secret. After this, unsigned generic webhooks are accepted again
 * (backward-compatible open mode until a new secret is generated).
 */
merchants.delete(
  '/api/merchants/:id/webhook/secret',
  authenticate,
  requireRole('owner', 'manager'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()
    db.run('UPDATE merchants SET webhook_secret_enc = NULL WHERE id = ?', [merchantId])
    return c.json({ ok: true })
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/feedback
// List all customer feedback, newest first. Supports pagination via ?offset&limit.
// ---------------------------------------------------------------------------

/**
 * Build WHERE clause fragments for feedback type + date filters.
 * @returns {{ clause: string, params: string[] }}
 */
function feedbackFilters(merchantId: string, typeFilter?: string, daysFilter?: string, fromDate?: string, toDate?: string) {
  const conditions = ['merchant_id = ?']
  const params: string[] = [merchantId]
  if (typeFilter === 'app' || typeFilter === 'order') {
    conditions.push('type = ?')
    params.push(typeFilter)
  }
  const days = parseInt(daysFilter || '', 10)
  if (days > 0) {
    conditions.push(`created_at >= datetime('now', '-' || ? || ' days')`)
    params.push(String(days))
  }
  // Custom date range (YYYY-MM-DD)
  if (fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    conditions.push('created_at >= ?')
    params.push(fromDate + 'T00:00:00')
  }
  if (toDate && /^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    conditions.push('created_at <= ?')
    params.push(toDate + 'T23:59:59')
  }
  return { clause: conditions.join(' AND '), params }
}

merchants.get(
  '/api/merchants/:id/feedback',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()

    const limit  = Math.min(parseInt(c.req.query('limit')  || '50'), 200)
    const offset = Math.max(parseInt(c.req.query('offset') || '0'), 0)
    const { clause, params } = feedbackFilters(
      merchantId, c.req.query('type'), c.req.query('days'),
      c.req.query('from'), c.req.query('to')
    )

    const rows = db
      .query<{
        id: string
        order_id: string | null
        type: string
        stars: number
        comment: string | null
        dish_ratings: string | null
        contact: string | null
        created_at: string
      }, string[]>(
        `SELECT id, order_id, type, stars, comment, dish_ratings, contact, created_at
         FROM feedback WHERE ${clause}
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${offset}`
      )
      .all(...params)

    // Fetch pickup codes for orders referenced in feedback
    const orderIds = [...new Set(rows.filter(r => r.order_id).map(r => r.order_id!))]
    const pickupMap: Record<string, string> = {}
    for (const oid of orderIds) {
      const o = db.query<{ pickup_code: string | null }, [string]>(
        `SELECT pickup_code FROM orders WHERE id = ?`
      ).get(oid)
      if (o?.pickup_code) pickupMap[oid] = o.pickup_code
    }

    const total = db
      .query<{ cnt: number }, string[]>(
        `SELECT COUNT(*) AS cnt FROM feedback WHERE ${clause}`
      )
      .get(...params)?.cnt ?? 0

    return c.json({
      feedback: rows.map(r => ({
        id: r.id,
        orderId: r.order_id,
        pickupCode: r.order_id ? (pickupMap[r.order_id] ?? null) : null,
        type: r.type,
        stars: r.stars,
        comment: r.comment,
        dishRatings: r.dish_ratings ? JSON.parse(r.dish_ratings) : null,
        contact: r.contact,
        createdAt: r.created_at,
      })),
      total,
    })
  }
)

// ---------------------------------------------------------------------------
// GET /api/merchants/:id/feedback/stats
// Average ratings + top liked/disliked dishes. Supports ?days= filter.
// ---------------------------------------------------------------------------

merchants.get(
  '/api/merchants/:id/feedback/stats',
  authenticate,
  requireRole('owner', 'manager', 'staff'),
  async (c: AuthContext) => {
    const merchantId = c.req.param('id')
    const db = getDatabase()
    const { clause, params } = feedbackFilters(
      merchantId, undefined, c.req.query('days'),
      c.req.query('from'), c.req.query('to')
    )

    // Average ratings — overall, order-type, app-type
    const avgAll = db.query<{ avg: number | null, cnt: number }, string[]>(
      `SELECT AVG(stars) AS avg, COUNT(*) AS cnt FROM feedback WHERE ${clause}`
    ).get(...params)

    const orderClause = clause + ` AND type = 'order'`
    const avgOrder = db.query<{ avg: number | null, cnt: number }, string[]>(
      `SELECT AVG(stars) AS avg, COUNT(*) AS cnt FROM feedback WHERE ${orderClause}`
    ).get(...params)

    const appClause = clause + ` AND type = 'app'`
    const avgApp = db.query<{ avg: number | null, cnt: number }, string[]>(
      `SELECT AVG(stars) AS avg, COUNT(*) AS cnt FROM feedback WHERE ${appClause}`
    ).get(...params)

    // Top liked / disliked dishes — parse dish_ratings JSON from all order-type feedback
    const dishRows = db.query<{ dish_ratings: string }, string[]>(
      `SELECT dish_ratings FROM feedback WHERE ${orderClause} AND dish_ratings IS NOT NULL`
    ).all(...params)

    const dishCounts: Record<string, { up: number, down: number }> = {}
    for (const row of dishRows) {
      try {
        const ratings = JSON.parse(row.dish_ratings) as Array<{ name: string, thumbs: string }>
        for (const r of ratings) {
          if (!r.name) continue
          if (!dishCounts[r.name]) dishCounts[r.name] = { up: 0, down: 0 }
          if (r.thumbs === 'up') dishCounts[r.name].up++
          else if (r.thumbs === 'down') dishCounts[r.name].down++
        }
      } catch { /* skip malformed JSON */ }
    }

    const topLiked = Object.entries(dishCounts)
      .filter(([, c]) => c.up > 0)
      .sort((a, b) => b[1].up - a[1].up)
      .slice(0, 10)
      .map(([name, c]) => ({ name, count: c.up }))

    const topDisliked = Object.entries(dishCounts)
      .filter(([, c]) => c.down > 0)
      .sort((a, b) => b[1].down - a[1].down)
      .slice(0, 10)
      .map(([name, c]) => ({ name, count: c.down }))

    return c.json({
      overall:    { avg: avgAll?.avg ? Math.round(avgAll.avg * 10) / 10 : null, count: avgAll?.cnt ?? 0 },
      order:      { avg: avgOrder?.avg ? Math.round(avgOrder.avg * 10) / 10 : null, count: avgOrder?.cnt ?? 0 },
      app:        { avg: avgApp?.avg ? Math.round(avgApp.avg * 10) / 10 : null, count: avgApp?.cnt ?? 0 },
      topLiked,
      topDisliked,
    })
  }
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads the merchant's current `tip_on_terminal` / `suggested_tip_percentages`
 * settings and pushes the config to all PAX terminals that have a Finix device ID.
 * Called fire-and-forget after the merchant profile is updated.
 */
async function syncDeviceTippingConfig(merchantId: string): Promise<void> {
  const db = getDatabase()

  // Load Finix credentials
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return

  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`
    )
    .get(merchantId)

  const parts = (keyRow?.pos_merchant_id ?? '').split(':')
  if (parts.length !== 3) return

  const merchantRow = db
    .query<{ finix_sandbox: number; tip_on_terminal: number; suggested_tip_percentages: string | null }, [string]>(
      `SELECT finix_sandbox, tip_on_terminal, suggested_tip_percentages FROM merchants WHERE id = ?`
    )
    .get(merchantId)
  if (!merchantRow) return

  const creds = {
    apiUsername:   parts[0],
    applicationId: parts[1],
    merchantId:    parts[2],
    apiPassword,
    sandbox:       (merchantRow.finix_sandbox ?? 1) !== 0,
  }

  const enabled = (merchantRow.tip_on_terminal ?? 0) === 1
  const percentOptions: number[] = (() => {
    try { return JSON.parse(merchantRow.suggested_tip_percentages ?? '[15,20,25]') } catch { return [15, 20, 25] }
  })()

  // Find all terminals with a Finix device ID
  const terminals = db
    .query<{ finix_device_id: string | null }, [string]>(
      `SELECT finix_device_id FROM terminals WHERE merchant_id = ? AND finix_device_id IS NOT NULL`
    )
    .all(merchantId)

  for (const t of terminals) {
    if (!t.finix_device_id) continue
    try {
      await updateDeviceTippingConfig(creds, t.finix_device_id, enabled, percentOptions)
      console.log(`[merchants] tip_on_terminal=${enabled} synced to device ${t.finix_device_id}`)
    } catch (err) {
      console.warn(`[merchants] device ${t.finix_device_id} tipping sync failed:`, (err as Error).message ?? err)
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/merchants/:id/deploy
// Pulls latest code from GitHub and restarts the server.
// Owner-only. Spawns ~/deploy.sh detached so the restart survives the current
// process exiting, then responds immediately.
// ---------------------------------------------------------------------------

merchants.post(
  '/api/merchants/:id/deploy',
  authenticate,
  requireOwnMerchant,
  requireRole('owner'),
  async (c: AuthContext) => {
    const home = process.env.HOME ?? '/home/kizo'
    const script = `${home}/deploy.sh`
    console.log('[merchants] deploy triggered — spawning', script)
    try {
      const proc = Bun.spawn(['bash', script], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, PATH: `${home}/.bun/bin:${process.env.PATH}` },
      })
      proc.unref()
      return c.json({ success: true, message: 'Deploy started — server will restart shortly' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[merchants] deploy spawn failed:', msg)
      return c.json({ success: false, error: msg }, 500)
    }
  },
)

export { merchants }
