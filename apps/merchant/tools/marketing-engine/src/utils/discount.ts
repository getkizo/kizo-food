/**
 * Server-side discount computation.
 * The client sends expected_discount_cents; server recomputes and validates.
 * If they differ by more than 1 cent (rounding), the order is rejected.
 */

export type DiscountType = 'percent' | 'fixed_cents'

export interface DiscountParams {
  discountType:  DiscountType
  discountValue: number
  subtotalCents: number
  minOrderCents: number
}

/**
 * schedule_json shape: days = ISO day-of-week (0=Sun … 6=Sat).
 * windows is an array so a campaign can have, e.g., lunch + happy-hour slots.
 */
export interface ScheduleJson {
  days?:    number[]                             // [1,2,3,4,5] = weekdays only
  windows?: Array<{ start: string; end: string }> // "HH:MM" 24-hour
}

/** item-level discount target */
export interface TargetJson {
  type:      'item'
  item_name: string   // case-insensitive match against cart item names
}

/** BOGO trigger condition */
export type TriggerJson =
  | { type: 'item_quantity';     item_name: string; quantity: number }
  | { type: 'category_quantity'; category:  string; quantity: number }

/** BOGO reward definition */
export type RewardJson =
  | { type: 'free_item';     item_name: string; max_quantity?: number }
  | { type: 'item_discount'; item_name: string; discount_type: DiscountType; discount_value: number; max_quantity?: number }

/**
 * Compute discount in cents. Returns 0 if subtotal < minOrderCents.
 * percent: round half-up to nearest cent.
 * fixed_cents: min(value, subtotal).
 */
export function computeDiscount(p: DiscountParams): number {
  if (p.subtotalCents < p.minOrderCents) return 0
  if (p.discountType === 'percent') {
    return Math.round(p.subtotalCents * p.discountValue / 100)
  }
  // fixed_cents
  return Math.min(p.discountValue, p.subtotalCents)
}

/** Return true if client and server discount agree within 1 cent. */
export function discountMatches(computed: number, expected: number): boolean {
  return Math.abs(computed - expected) <= 1
}

/**
 * Return true if the campaign is active right now according to its schedule_json.
 * @param scheduleJson  Parsed schedule_json from the campaigns row (may be null).
 * @param timezone      IANA timezone string for the merchant (e.g. 'America/Los_Angeles').
 */
export function isScheduleActive(scheduleJson: ScheduleJson | null | undefined, timezone: string): boolean {
  if (!scheduleJson) return true  // no schedule restriction → always active

  const now = new Date()
  const tz  = timezone || 'UTC'

  // Day-of-week in merchant's local timezone (0=Sun … 6=Sat)
  const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const localDay = dayMap[dayStr] ?? now.getDay()

  if (scheduleJson.days?.length && !scheduleJson.days.includes(localDay)) return false

  if (!scheduleJson.windows?.length) return true  // day match, no time restriction

  // Time in merchant's local timezone as minutes-since-midnight
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).format(now)  // "HH:MM"
  const [h, m]    = timeStr.split(':').map(Number)
  const localMins = h * 60 + m

  return scheduleJson.windows.some(w => {
    const [sh, sm] = w.start.split(':').map(Number)
    const [eh, em] = w.end.split(':').map(Number)
    return localMins >= sh * 60 + sm && localMins <= eh * 60 + em
  })
}
