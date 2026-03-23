/**
 * Shared type definitions for all receipt printer modules.
 *
 * This is the single source of truth for printer option interfaces.
 * Import from here; do NOT redeclare or fork these interfaces in other files.
 *
 * Imported by: printer.ts, webprnt.ts, star-raster.ts, html-receipt.ts
 */

export interface PrintItem {
  quantity: number
  dishName: string
  priceCents: number
  modifiers?: Array<{ name: string; priceCents: number }>
  /** Dish label entered by the customer (e.g. "Alice", "For John") — printed on its own line */
  dishLabel?: string
  /** Per-item kitchen note entered by the customer (e.g. "no peanuts") */
  specialInstructions?: string
  /** Per-item note added by server staff at the table (e.g. "medium-rare", "sauce on side") */
  serverNotes?: string
  lineTotalCents?: number
  /** null = main/un-numbered course; number = numbered (1, 2, 3…) */
  courseOrder?: number | null
  /** true = "Last" position (e.g. Desserts) — printed last on ticket */
  isLastCourse?: boolean
  /** 'both' = kitchen+counter (default); 'kitchen' = kitchen only; 'counter' = counter only */
  printDestination?: 'both' | 'kitchen' | 'counter'
}

export interface KitchenTicketOptions {
  printerIp: string
  printerPort?: number
  /** 'star-line' (default, TSP700II) | 'star-line-tsp100' (TSP100 III) | 'webprnt' (HTTP) | 'star-graphic' (raster, TSP143 III) | 'generic-escpos' */
  printerProtocol?: 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
  /** 'classic' = receiptline monospace (default) | 'html' = Puppeteer HTML render (star-graphic/webprnt only) */
  receiptStyle?: 'classic' | 'html'
  orderId: string
  orderType: string
  printLanguage?: string
  merchantName?: string | null
  customerName?: string | null
  tableLabel?: string | null
  roomLabel?: string | null
  notes?: string | null
  utensilsNeeded?: boolean
  items: PrintItem[]
  createdAt?: string | null
  /** IANA timezone name (e.g. 'America/Los_Angeles'). Used by WebPRNT builders for locale-aware timestamp formatting. */
  timezone?: string | null
}

export interface CounterTicketOptions extends KitchenTicketOptions {
  /** Short alphanumeric code customers use to pick up their order (e.g. "JWDZ"). */
  pickupCode?: string | null
  /**
   * When present, renders a branded takeout/bag receipt with prices and payment
   * footer (star-graphic only).  When absent, renders the standard counter copy.
   */
  subtotalCents?: number
  taxCents?: number
  taxRate?: number
  /** Total charged to the card (includes tax + any tip). */
  paidAmountCents?: number
  tipCents?: number
  address?: string | null
  phoneNumber?: string | null
  website?: string | null
}

export interface CustomerReceiptOptions extends KitchenTicketOptions {
  subtotalCents: number
  taxCents: number
  taxRate?: number
  paidAmountCents: number
  /**
   * Optional tip amount in cents.
   * Rendered by the HTML and raster paths; silently ignored by text-mode builders.
   */
  tipCents?: number
  address?: string | null
  phoneNumber?: string | null
  website?: string | null
}

export interface CustomerBillOptions extends KitchenTicketOptions {
  subtotalCents: number
  taxCents: number
  taxRate?: number
  /** Discount off the subtotal, in cents (0 = no discount). */
  discountCents?: number
  /** Display label for the applied discount (e.g. "Happy Hour"). */
  discountLabel?: string | null
  /** Taxable service charge in cents (0 = none). */
  serviceChargeCents?: number
  /** Display label for the applied service charge (e.g. "Party of 6+"). */
  serviceChargeLabel?: string | null
  /** Tip percentages to show in the suggested gratuity table. Defaults to [18, 20, 22, 25]. */
  tipPercentages?: number[]
  address?: string | null
  phoneNumber?: string | null
  website?: string | null
}

export interface TestPageOptions {
  printerIp:        string
  printerPort?:     number
  printerProtocol?: 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
  /** Human-readable label printed on the ticket, e.g. "Kitchen" */
  label?:           string
}

/** Options for printing a gift card purchase receipt. */
export interface GiftCardReceiptOptions {
  printerIp:        string
  printerPort?:     number
  printerProtocol?: 'star-line' | 'star-line-tsp100' | 'webprnt' | 'star-graphic' | 'generic-escpos'
  receiptStyle?:    'classic' | 'html'
  merchantName:     string
  /** Card code(s), one per card in the purchase. */
  cards: Array<{
    code:           string
    faceValueCents: number
    balanceCents:   number
    expiresAt:      string
  }>
  purchaserName:    string
  recipientName?:   string | null
  purchasedAt?:     string | null
}
