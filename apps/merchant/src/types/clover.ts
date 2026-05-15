/**
 * Shared Clover payment types.
 *
 * Single source of truth for the split-leg payment request body used by both
 * `routes/counter.ts` (HTTP request body) and `services/counter-ws.ts`
 * (`startCloverLegPayment` parameter). Extending the protocol updates both
 * call sites at compile time.
 */

export interface CloverLegPaymentOpts {
  legSubtotalCents:   number
  legTaxCents:        number
  serviceChargeCents: number
  legNumber:          number
  totalLegs:          number
  splitMode:          string
}
