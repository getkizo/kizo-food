/**
 * Dashboard-facing terminal payment outcome.
 *
 * Single contract for payment terminals that the appliance drives directly
 * — PAX A920 Pro (Finix cloud) and D135 + Android app (counter WebSocket).
 *
 * This deliberately hides every Finix detail (PENDING/SUCCEEDED/FAILED,
 * decline_code strings, HTTP errors) behind four terminal statuses plus
 * `waiting`. The dashboard only branches on these.
 *
 * ## Not for Clover
 * Clover has a fundamentally different model: the appliance provisions
 * an order, Clover owns the full payment handshake, and we only observe
 * whether the order was paid. No error/decline/cancel propagates back
 * from Clover — an unpaid order simply stays unpaid. Clover status lives
 * elsewhere and is intentionally unrelated to this type.
 */

export type TerminalOutcomeStatus =
  | 'waiting'    // still in progress — client should keep polling
  | 'approved'   // card charged; proceed to signature / receipt
  | 'declined'   // card rejected by issuer/processor
  | 'cancelled'  // cancelled by staff, customer on terminal, or timeout
  | 'error'      // infrastructure failure (network, offline terminal, processor unreachable)

export type TerminalOutcomeReason =
  // declined — card-side reasons
  | 'insufficient_funds'
  | 'card_declined'
  | 'card_not_supported'
  | 'expired_card'
  | 'invalid_card'
  | 'invalid_pin'
  | 'pin_tries_exceeded'
  | 'lost_card'
  | 'stolen_card'
  | 'restricted_card'
  | 'security_violation'
  | 'exceeds_withdrawal_limit'
  | 'do_not_honor'
  // cancelled — who/what triggered the cancel
  | 'cancelled_by_staff'     // staff pressed cancel / "Take cash instead"
  | 'cancelled_by_customer'  // customer pressed cancel on the terminal
  | 'timeout'                // customer never tapped within the workflow's window
  // error — infrastructure level
  | 'network_error'          // couldn't reach the processor
  | 'terminal_offline'       // terminal unreachable
  | 'processor_unreachable'  // processor HTTP 5xx / timeout
  | 'initiation_failed'      // sale creation failed before card read
  | 'unknown'                // unclassified

export interface TerminalOutcome {
  status:           TerminalOutcomeStatus

  /** Semantic reason — present for declined / cancelled / error. */
  reason?:          TerminalOutcomeReason

  /**
   * Whether a silent auto-retry is safe for this outcome. Server-computed
   * so the client never has to branch on processor-specific codes. Absent
   * for `approved` and `waiting`.
   */
  retryable?:       boolean

  /** Suggested delay before the client retries, in milliseconds. */
  retryDelayMs?:    number

  /** Human-readable message, safe to show to staff. */
  message?:         string

  // ── Success-only fields ──────────────────────────────────────────────────
  /** Processor transaction id (Finix transfer id). Available once issued. */
  transferId?:      string | null
  paymentId?:       string
  /** True when this leg is the final (or only) leg and the order is now paid. */
  isLastLeg?:       boolean
  /** Total captured amount in cents (base + tip), from the processor. */
  amountCents?:     number
  tipAmountCents?:  number
  cardBrand?:       string | null
  cardLastFour?:    string | null
  approvalCode?:    string | null
  entryMode?:       string | null
}
