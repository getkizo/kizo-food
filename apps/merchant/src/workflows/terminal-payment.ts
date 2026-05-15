/**
 * Terminal Payment Workflow (SAM Pattern + FSM)
 * Manages PAX A920 Pro card-present payment lifecycle
 *
 * State Machine:
 *
 *   IDLE ──INITIATE_PAYMENT──► INITIATING
 *              │                    │
 *   createTerminalSale()     TRANSFER_CREATED ──► AWAITING_TAP
 *    (async, setTimeout)           │                   │
 *              │               TAP_DECLINED        TAP_APPROVED ──► RECORDING ──► COMPLETED
 *              │                   │               TAP_DECLINED ──► DECLINED
 *              │                   │               CANCEL_PAYMENT
 *              │                   │                   │
 *              │                   ▼               CANCELLING
 *              │               DECLINED ──EXIT──► IDLE
 *              │                               ┌─────────┤
 *              │                        CANCEL_CONFIRMED  TAP_APPROVED ──► RECORDING
 *              │                        TAP_DECLINED      (tap beat cancel)
 *              │                               │
 *              │                           CANCELLED ──EXIT──► IDLE
 *              │
 *   Anti-glitch invariant: TAP_APPROVED / TAP_DECLINED arriving in RECORDING or
 *   COMPLETED state are silently discarded by enforceAllowedTransitions — no second
 *   DB write, no state change.
 *
 *   Partial-payment guard: if Finix SUCCEEDED but amount ≠ amountCents, the pre-FSM
 *   acceptor rewrites __actionName → TAP_DECLINED with declineCode='PARTIAL_PAYMENT'.
 *
 * SAM/sam-fsm wiring notes:
 *   - sam-fsm's `stateMachineNaps` ignores return values → NAPs wired manually.
 *   - sam-pattern reads `naps` only from inside `component` (top-level ignored).
 *   - `TRANSFER_CREATED` / `CANCEL_DECLINED` are internal actions not exposed in the
 *     public WorkflowHandle API.
 *   - CANCELLING+TAP_DECLINED is rewritten to CANCEL_DECLINED (→CANCELLED) by a
 *     pre-FSM acceptor so the same TAP_DECLINED action name maps to two different
 *     next states without breaking the FSM's deterministic mode.
 */

import { fsm } from 'sam-fsm'
import SAMPattern from 'sam-pattern'
const { createInstance } = SAMPattern
import { randomBytes } from 'node:crypto'
import { getDatabase } from '../db/connection'
import { broadcastToMerchant } from '../services/sse'
import { scheduleReconciliation } from '../services/reconcile'
import { getAPIKey } from '../crypto/api-keys'
import {
  createTerminalSale,
  getTerminalTransferStatus,
  cancelTerminalSale,
  FinixTransferCancelledError,
} from '../adapters/finix'
import type { FinixCredentials } from '../adapters/finix'
import { logPaymentEvent } from '../services/payment-log'
import { logPaymentError } from '../services/payment-error-log'
import type { PaymentErrorType } from '../services/payment-error-log'
import { releasePaymentLock } from '../services/order-locks'
import type { TerminalOutcome, TerminalOutcomeReason } from '../types/terminal-outcome'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalTxState =
  | 'IDLE'
  | 'INITIATING'
  | 'AWAITING_TAP'
  | 'AWAITING_VERIFICATION'  // createTerminalSale failed (non-422) — outcome unknown until orphan sweep resolves by idempotency_id
  | 'PROCESSING'     // reserved — no transitions yet, never entered in v1
  | 'RECORDING'
  | 'COMPLETED'
  | 'DECLINED'
  | 'CANCELLING'
  | 'CANCELLED'

/**
 * SAM model for terminal payment state.
 *
 * Field names checked against SAM reserved list:
 *   error, hasError, errorMessage, clearError, state, update, flush,
 *   clone, continue, hasNext, allow, log → ALL AVOIDED
 */
export interface TerminalPaymentModel {
  // Identity (constant for lifetime of workflow instance)
  terminalId:     string
  merchantId:     string
  finixDeviceId:  string

  // FSM program counter — NOT named 'state'
  txState:        TerminalTxState

  // Current transaction (null when IDLE)
  orderId:        string | null
  amountCents:    number | null
  transferId:     string | null
  idempotencyKey: string | null   // fresh UUID per INITIATE_PAYMENT
  startedAt:      string | null   // ISO timestamp; drives timeout NAP

  // Split metadata (null on non-split payments). Set on INITIATE_PAYMENT and used
  // by recovery-path DB writes to populate payments.split_* and decide whether
  // to mark the order paid (only on the final leg).
  splitMode:       string | null
  splitLegNumber:  number | null
  splitTotalLegs:  number | null
  // by_items only: JSON-encoded array of unit indices paid in this leg.
  // Used to populate payments.split_items_json AND to derive isLastLeg from
  // cumulative coverage rather than splitTotalLegs (which is null for by_items).
  splitItemsJson:  string | null

  // Success fields (populated in RECORDING/COMPLETED)
  cardBrand:      string | null
  cardLastFour:   string | null
  approvalCode:   string | null
  entryMode:      string | null   // CONTACTLESS | CHIP_ENTRY | SWIPED | …
  /** Finix-reported charged amount (may exceed amountCents when tip-on-terminal is enabled) */
  approvedAmountCents: number | null
  /** Finix-reported tip portion of the charged amount (0 when no on-device tip) */
  tipAmountCents: number | null
  paymentId:      string | null   // DB payments.id

  // Failure fields (DECLINED/CANCELLED)
  declineCode:    string | null
  declineMessage: string | null
}

/** Outcome reported by the orphan sweep when it resolves a verification-pending row. */
export interface VerificationOutcome {
  /**
   * 'approved' → dispatches TAP_APPROVED with the provided card details and amounts.
   * 'declined' → dispatches TAP_DECLINED with the provided declineCode / declineMessage.
   */
  outcome:         'approved' | 'declined'
  transferId?:     string | null
  approvedAmount?: number
  cardBrand?:      string | null
  cardLastFour?:   string | null
  approvalCode?:   string | null
  entryMode?:      string | null
  tipAmountCents?: number
  declineCode?:    string
  declineMessage?: string
}

/** Public handle returned by createTerminalPaymentWorkflow */
export interface TerminalPaymentWorkflowHandle {
  /**
   * Dispatch INITIATE_PAYMENT — starts a new card-present transaction.
   * `idempotencyKey` is optional: when provided, it is used verbatim as the
   * Finix `POST /transfers` idempotency key. When omitted, a random UUID is
   * generated inside the workflow's INITIATE_PAYMENT component action.
   */
  startPayment: (
    orderId:         string,
    amountCents:     number,
    idempotencyKey?: string,
    splitMeta?:      {
      splitMode:      string | null
      splitLegNumber: number | null
      splitTotalLegs: number | null
      splitItemsJson: string | null
    },
  ) => void
  /** Dispatch CANCEL_PAYMENT — aborts an in-progress transaction */
  cancelPayment: () => void
  /** Dispatch EXIT_FLOW — resets machine to IDLE after terminal state */
  exitFlow: () => void
  /** Read-only snapshot of current model */
  getStatus: () => TerminalPaymentModel
  /**
   * Resolve a pending verification (called by the reconcile orphan sweep when
   * it discovers the outcome of a previously-timed-out createTerminalSale).
   * Dispatches TAP_APPROVED or TAP_DECLINED; no-op if not in AWAITING_VERIFICATION.
   */
  resolveVerification: (outcome: VerificationOutcome) => void
}

/** Status shape compatible with CounterPaymentResult in counter-ws.ts */
export interface TerminalPaymentStatus {
  status: 'waiting' | 'approved' | 'declined' | 'error' | 'cancelled'
  message?: string
  paymentId?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2_000    // 2 s between Finix API polls
const TIMEOUT_MS       = 180_000  // 3 min before auto-cancel

// ---------------------------------------------------------------------------
// FSM definition
// ---------------------------------------------------------------------------

/**
 * Terminal payment FSM.
 *
 * CANCEL_DECLINED is an internal action that the pre-FSM acceptor inserts when
 * TAP_DECLINED arrives while in CANCELLING — allowing the same action name to
 * map to DECLINED (from AWAITING_TAP) vs CANCELLED (from CANCELLING).
 */
const terminalPaymentFSM = fsm({
  pc:  'txState',
  pc0: 'IDLE',
  actions: {
    INITIATE_PAYMENT:      ['INITIATING'],
    TRANSFER_CREATED:      ['AWAITING_TAP'],
    VERIFICATION_STARTED:  ['AWAITING_VERIFICATION'],
    TAP_APPROVED:          ['RECORDING'],
    TAP_DECLINED:          ['DECLINED'],
    CANCEL_DECLINED:       ['CANCELLED'],
    PAYMENT_RECORDED:      ['COMPLETED'],
    CANCEL_PAYMENT:        ['CANCELLING'],
    CANCEL_CONFIRMED:      ['CANCELLED'],
    EXIT_FLOW:             ['IDLE'],
  },
  states: {
    IDLE:                  { transitions: ['INITIATE_PAYMENT'],                                             naps: [] },
    INITIATING:            { transitions: ['TRANSFER_CREATED', 'VERIFICATION_STARTED', 'TAP_DECLINED', 'CANCEL_PAYMENT'], naps: [] },
    AWAITING_TAP:          { transitions: ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],               naps: [] },
    AWAITING_VERIFICATION: { transitions: ['TAP_APPROVED', 'TAP_DECLINED'],                                 naps: [] },
    PROCESSING:            { transitions: [],                                                               naps: [] },
    RECORDING:             { transitions: ['PAYMENT_RECORDED'],                                             naps: [] },
    COMPLETED:             { transitions: ['EXIT_FLOW'],                                                    naps: [] },
    DECLINED:              { transitions: ['EXIT_FLOW'],                                                    naps: [] },
    CANCELLING:            { transitions: ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],          naps: [] },
    CANCELLED:             { transitions: ['EXIT_FLOW'],                                                    naps: [] },
  },
  deterministic:             true,
  enforceAllowedTransitions: true,
})

// ---------------------------------------------------------------------------
// Module-level registry (single-appliance)
// ---------------------------------------------------------------------------

/** terminalId → workflow handle */
const _registry = new Map<string, TerminalPaymentWorkflowHandle>()

/** orderId → terminalId, for cancel routing */
const _orderToTerminal = new Map<string, string>()

/** terminalId → epoch ms when the registry entry was last set (for TTL sweep) */
const _entryAt = new Map<string, number>()

/** terminalIds currently mid-INITIATE dispatch — prevents same-tick double-fire */
const _initiating = new Set<string>()

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SAM terminal payment workflow instance for one PAX A920 Pro.
 * One instance per terminal; reused across transactions via the module registry.
 */
export function createTerminalPaymentWorkflow(
  terminalId:     string,
  merchantId:     string,
  finixDeviceId:  string,
  creds:          FinixCredentials,
  onResult:       (orderId: string, result: TerminalPaymentStatus) => void,
  initialModel?:  Partial<TerminalPaymentModel>,
  options?:       { recordLocally?: boolean },
): TerminalPaymentWorkflowHandle {
  // When false, the RECORDING NAP skips writing to `payments` — the caller
  // (e.g. the dashboard payment modal) is responsible for recording the charge
  // via /record-payment after signature/receipt screens. The FSM still advances
  // through RECORDING → COMPLETED so the client's polled status transitions to
  // SUCCEEDED with full card details.
  const recordLocally = options?.recordLocally ?? true

  const instance = createInstance({ instanceName: `terminal:${terminalId}` })

  // ── Mutable intent references ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _initiatePayment:     ((data: { orderId: string; amountCents: number; idempotencyKey?: string; startedAt?: string; splitMode?: string | null; splitLegNumber?: number | null; splitTotalLegs?: number | null; splitItemsJson?: string | null }) => void) | undefined
  let _transferCreated:     ((data: { transferId: string }) => void) | undefined
  let _verificationStarted: (() => void) | undefined
  let _tapApproved:         ((data: { approvedAmount: number; cardBrand: string | null; cardLastFour: string | null; approvalCode: string | null; entryMode?: string | null; tipAmountCents?: number | null }) => void) | undefined
  let _tapDeclined:         ((data: { declineCode: string | null; declineMessage: string | null }) => void) | undefined
  let _cancelDeclined:      (() => void) | undefined
  let _paymentRecorded:     ((data: { paymentId: string | null }) => void) | undefined
  let _cancelPayment:       (() => void) | undefined
  let _cancelConfirmed:     (() => void) | undefined
  let _exitFlow:            (() => void) | undefined

  // ── Transient NAP state (not persisted — resets cleanly on rehydration) ────
  let _pollTimer:           ReturnType<typeof setInterval> | null = null
  let _createSaleInFlight = false
  let _cancelInFlight     = false
  let _recordingInFlight  = false
  // Set during rehydration fast-forward to prevent createSale NAP from firing
  // while replaying INITIATE_PAYMENT + TRANSFER_CREATED to advance the FSM.
  let _rehydrating        = false
  // Set when the server-side 180 s timeout fires so the subsequent CANCELLED
  // render doesn't double-log: timeout already writes 'terminal_timeout' to
  // payment_errors; the CANCELLED render skips 'terminal_cancelled' if true.
  // Reset to false on EXIT_FLOW (when the workflow returns to IDLE).
  let _timedOut           = false

  // ── Snapshot of the last rendered model (sam-pattern has no getState()) ───
  let _lastModel: TerminalPaymentModel = {
    terminalId, merchantId, finixDeviceId,
    txState:             (initialModel?.txState ?? 'IDLE') as TerminalTxState,
    orderId:             initialModel?.orderId             ?? null,
    amountCents:         initialModel?.amountCents         ?? null,
    transferId:          initialModel?.transferId          ?? null,
    idempotencyKey:      initialModel?.idempotencyKey      ?? null,
    startedAt:           initialModel?.startedAt           ?? null,
    splitMode:           initialModel?.splitMode           ?? null,
    splitLegNumber:      initialModel?.splitLegNumber      ?? null,
    splitTotalLegs:      initialModel?.splitTotalLegs      ?? null,
    cardBrand:            initialModel?.cardBrand            ?? null,
    cardLastFour:         initialModel?.cardLastFour         ?? null,
    approvalCode:         initialModel?.approvalCode         ?? null,
    entryMode:            initialModel?.entryMode            ?? null,
    approvedAmountCents:  initialModel?.approvedAmountCents  ?? null,
    tipAmountCents:       initialModel?.tipAmountCents       ?? null,
    paymentId:           initialModel?.paymentId           ?? null,
    declineCode:         initialModel?.declineCode         ?? null,
    declineMessage:      initialModel?.declineMessage      ?? null,
    splitItemsJson:      initialModel?.splitItemsJson      ?? null,
  }

  // ── Shared poll-interval tick ─────────────────────────────────────────────
  // Used by both the poll NAP and the rehydration boot. Checks the timeout on
  // every tick so cancellation fires even when Finix stays PENDING.
  async function pollTick(): Promise<void> {
    const m = _lastModel
    if (m.txState !== 'AWAITING_TAP' && m.txState !== 'CANCELLING') {
      clearInterval(_pollTimer!)
      _pollTimer = null
      return
    }
    // Timeout check — fires even while Finix stays PENDING
    if (m.startedAt) {
      const elapsed = Date.now() - new Date(m.startedAt).getTime()
      if (elapsed > TIMEOUT_MS) {
        clearInterval(_pollTimer!)
        _pollTimer = null
        logPaymentEvent('terminal_timeout', {
          merchantId:  m.merchantId,
          orderId:     m.orderId     ?? undefined,
          transferId:  m.transferId  ?? undefined,
          deviceId:    m.finixDeviceId,
          amountCents: m.amountCents ?? undefined,
          level:       'warn',
          message:     `Terminal payment timed out after ${Math.round(elapsed / 1000)}s`,
        })
        _timedOut = true
        logPaymentError(
          m.merchantId,
          'terminal_timeout',
          `Terminal payment timed out after ${Math.round(elapsed / 1000)}s`,
          m.orderId,
        )
        setTimeout(() => _cancelPayment?.(), 0)
        return
      }
    }
    const tId = m.transferId
    if (!tId) return
    try {
      const status = await getTerminalTransferStatus(creds, tId)
      if (status.state === 'SUCCEEDED') {
        clearInterval(_pollTimer!)
        _pollTimer = null
        // Robust tip capture: prefer Finix's amount_breakdown.tip_amount, but
        // fall back to the difference between what Finix charged (status.amount)
        // and what we sent (m.amountCents). Some Finix responses populate
        // amount but lag on amount_breakdown — without this fallback, a real
        // on-device tip would be silently dropped.
        const inferredTip = Math.max(0, status.amount - (m.amountCents ?? 0))
        const tipAmountCents = Math.max(status.tipAmountCents ?? 0, inferredTip)
        _tapApproved?.({
          approvedAmount: status.amount,
          cardBrand:      status.cardBrand,
          cardLastFour:   status.cardLastFour,
          approvalCode:   status.approvalCode,
          entryMode:      status.entryMode,
          tipAmountCents,
        })
      } else if (status.state === 'FAILED' || status.state === 'CANCELED') {
        clearInterval(_pollTimer!)
        _pollTimer = null
        _tapDeclined?.({
          declineCode:    status.failureCode,
          declineMessage: status.failureMessage,
        })
      } else if (status.state === 'UNKNOWN') {
        // Finix cannot determine the outcome yet — keep polling.
        // The 180 s timeout will auto-cancel if this persists.
        console.warn(`[terminal-payment] ${terminalId} transfer ${tId} state=UNKNOWN — Finix outcome indeterminate, continuing to poll`)
      }
      // PENDING / UNKNOWN — keep polling
    } catch {
      // Transient network error — keep polling
    }
  }

  function startPollInterval(): void {
    if (_pollTimer) return
    _pollTimer = setInterval(pollTick, POLL_INTERVAL_MS)
  }

  // ── Async createTerminalSale ──────────────────────────────────────────────
  //
  // Error-recovery flow (summary):
  //   1. 422 duplicate idempotency key → fetch the existing transfer and honour
  //      whatever state Finix reports (SUCCEEDED → record; PENDING → resume
  //      awaiting-tap; FAILED → decline).
  //   2. Non-422 error (HTTP 5xx, network timeout, abort) → retry ONCE with the
  //      SAME idempotency key. Finix's idempotency guarantee means:
  //        - if Finix never saw the first request, we create the transfer now
  //        - if Finix did, we get a 422 and the 422 path resolves it
  //      So a single retry closes almost every ambiguous-state window without
  //      risk of double-charge.
  //   3. Both attempts failed non-422 → as a last-gasp fallback, try cancelling
  //      the device (pre-existing behaviour: if the customer tapped during the
  //      network window, cancel returns the SUCCEEDED transfer).
  //   4. Nothing recovered → INSERT a pending_terminal_sales row with the
  //      idempotency_key, dispatch VERIFICATION_STARTED so the FSM moves to
  //      AWAITING_VERIFICATION. The orphan sweep then queries Finix by
  //      idempotency_id and resolves it later.
  async function runCreateSale(orderId: string, amountCents: number, idempotencyKey: string): Promise<void> {
    // Attempt createTerminalSale up to MAX_CREATE_ATTEMPTS times with the same
    // idempotency key. First attempt is the normal call; retries handle transient
    // network / HTTP timeouts where Finix may have accepted the original request
    // but our response never arrived.
    const MAX_CREATE_ATTEMPTS = 2
    let lastErr: unknown = null

    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
      try {
        const sale = await createTerminalSale(
          creds, finixDeviceId, amountCents,
          { orderId, merchantId },
          idempotencyKey,
        )

        // Finix normally returns state=PENDING for card-present sales (tap not yet
        // completed). Guard against the documented edge cases of an immediate terminal
        // state so we don't loop waiting for a tap that already happened or will never come.
        if (sale.state === 'SUCCEEDED') {
          console.warn(`[terminal-payment] ${terminalId} createTerminalSale returned immediate SUCCEEDED (attempt ${attempt}) — fetching transfer details`)
          let details: { amount: number; cardBrand: string | null; cardLastFour: string | null; approvalCode: string | null; entryMode: string | null; tipAmountCents: number }
          try {
            const status = await getTerminalTransferStatus(creds, sale.transferId)
            details = {
              amount:         status.amount,
              cardBrand:      status.cardBrand,
              cardLastFour:   status.cardLastFour,
              approvalCode:   status.approvalCode,
              entryMode:      status.entryMode,
              tipAmountCents: status.tipAmountCents,
            }
          } catch (fetchErr) {
            console.warn(
              `[terminal-payment] ${terminalId} couldn't fetch full details for immediate SUCCEEDED ` +
              `transfer ${sale.transferId}; falling back to request amount: ${(fetchErr as Error)?.message}`,
            )
            details = {
              amount:         amountCents,
              cardBrand:      null,
              cardLastFour:   null,
              approvalCode:   null,
              entryMode:      null,
              tipAmountCents: 0,
            }
          }
          await recordSucceededTransferAndAdvance(sale.transferId, details)
          return
        }
        if (sale.state === 'FAILED' || sale.state === 'CANCELED') {
          setTimeout(() => _tapDeclined?.({
            declineCode:    'IMMEDIATE_FAILURE',
            declineMessage: `Terminal sale ${sale.state} immediately after creation`,
          }), 0)
          return
        }

        // PENDING (or UNKNOWN) — normal path, poll for tap
        setTimeout(() => _transferCreated?.({ transferId: sale.transferId }), 0)
        return
      } catch (err) {
        // ── Case 1: 422 duplicate idempotency key ───────────────────────────
        // Finix returns 422 when a transfer with this idempotency key already exists.
        // This is the common outcome when our first attempt timed out after Finix
        // accepted the request — or on a deliberate retry with the same key.
        // Either way, fetch the existing transfer's actual state before deciding.
        if (err instanceof FinixTransferCancelledError) {
          await handleDuplicateKey422(err)
          return
        }

        // ── Case 2: Non-422 error — retry with SAME idempotency key ─────────
        lastErr = err
        if (attempt < MAX_CREATE_ATTEMPTS) {
          console.warn(
            `[terminal-payment] ${terminalId} createTerminalSale attempt ${attempt} failed ` +
            `(${(err as Error)?.message ?? err}); retrying with same idempotency key`,
          )
          continue
        }
      }
    }

    // ── Case 3: All retries failed non-422. Last-gasp best-effort cancel ───
    // If the customer tapped during the network window, cancel may return the
    // SUCCEEDED transfer. Preserves the pre-existing recovery path.
    try {
      console.warn(`[terminal-payment] ${terminalId} createTerminalSale retries exhausted — sending best-effort cancel to probe device`)
      const cancelResult = await cancelTerminalSale(creds, finixDeviceId)
      if (cancelResult.state === 'SUCCEEDED') {
        console.warn(`[terminal-payment] ${terminalId} cancel confirmed SUCCEEDED — customer tapped during network error window, recording charge`)
        if (!cancelResult.transferId) {
          // No transfer ID returned — can't record. Fall through to verification-pending
          // so the orphan sweep resolves it via idempotency_id.
          console.warn(`[terminal-payment] ${terminalId} cancel-SUCCEEDED returned no transfer ID; falling through to verification-pending`)
        } else {
          let details = {
            amount:         cancelResult.amount,
            cardBrand:      cancelResult.cardBrand,
            cardLastFour:   cancelResult.cardLastFour,
            approvalCode:   cancelResult.approvalCode,
            entryMode:      null as string | null,
            tipAmountCents: 0,
          }
          try {
            const status = await getTerminalTransferStatus(creds, cancelResult.transferId)
            // Only use enriched details if the re-fetch also confirms SUCCEEDED.
            // If Finix returns a different state (e.g. PENDING during brief propagation),
            // fall back to the cancel response which is the authoritative source.
            if (status.state === 'SUCCEEDED') {
              details = {
                amount:         status.amount,
                cardBrand:      status.cardBrand    ?? details.cardBrand,
                cardLastFour:   status.cardLastFour ?? details.cardLastFour,
                approvalCode:   status.approvalCode ?? details.approvalCode,
                entryMode:      status.entryMode,
                tipAmountCents: status.tipAmountCents,
              }
            }
          } catch (fetchErr) {
            console.warn(
              `[terminal-payment] ${terminalId} couldn't enrich cancel-SUCCEEDED details ` +
              `for ${cancelResult.transferId}: ${(fetchErr as Error)?.message} — using cancel response only`,
            )
          }
          await recordSucceededTransferAndAdvance(cancelResult.transferId, details)
          return
        }
      }
      // Bug #2 companion fix: cancelTerminalSale can return state=FAILED with
      // failure_code=CANCELLATION_VIA_API when the transfer was already SUCCEEDED
      // (Finix rejects the cancel but still echoes back the terminal-state
      // Transfer). Re-fetch via getTerminalTransferStatus when we have an ID.
      if (cancelResult.transferId) {
        try {
          const check = await getTerminalTransferStatus(creds, cancelResult.transferId)
          if (check.state === 'SUCCEEDED') {
            console.warn(`[terminal-payment] ${terminalId} cancel returned non-SUCCEEDED but transfer ${cancelResult.transferId} is SUCCEEDED — recording charge`)
            await recordSucceededTransferAndAdvance(cancelResult.transferId, {
              amount:         check.amount,
              cardBrand:      check.cardBrand,
              cardLastFour:   check.cardLastFour,
              approvalCode:   check.approvalCode,
              entryMode:      check.entryMode,
              tipAmountCents: check.tipAmountCents,
            })
            return
          }
        } catch {
          // Fall through to verification-pending path
        }
      }
      // FAILED/CANCELED/UNKNOWN — device idle; fall through to verification-pending
    } catch (cancelErr) {
      console.warn(`[terminal-payment] ${terminalId} best-effort cancel also failed:`, (cancelErr as Error).message ?? cancelErr)
    }

    // ── Case 4: All recovery attempts exhausted — enter AWAITING_VERIFICATION
    // Persist a pending_terminal_sales row keyed by idempotency_key so the
    // orphan sweep can query Finix authoritatively and resolve the outcome.
    // Until the sweep resolves, /terminal-sale rejects fresh attempts on this
    // order with 409 to prevent double-charge.
    try {
      const db = getDatabase()
      db.run(
        `INSERT INTO pending_terminal_sales
           (merchant_id, order_id, transfer_id, idempotency_key, device_id, amount_cents, status)
         VALUES (?, ?, NULL, ?, ?, ?, 'pending')`,
        [merchantId, orderId, idempotencyKey, finixDeviceId, amountCents],
      )
    } catch (dbErr) {
      // DB write failing here is rare (SQLite local) but must not leak into the
      // FSM error path. Log and still dispatch VERIFICATION_STARTED so the
      // client sees a clear "pending verification" state instead of a hung modal.
      console.error(`[terminal-payment] ${terminalId} failed to persist pending_terminal_sales row:`, (dbErr as Error)?.message ?? dbErr)
    }
    logPaymentEvent('terminal_verification_pending', {
      merchantId, orderId, deviceId: finixDeviceId, amountCents,
      level: 'warn',
      message: `Finix create-sale failed after ${MAX_CREATE_ATTEMPTS} attempts; awaiting orphan sweep resolution`,
      extra: { idempotencyKey, lastError: (lastErr as Error)?.message ?? String(lastErr) },
    })
    setTimeout(() => _verificationStarted?.(), 0)
  }

  // Shared 422 handler — invoked from any attempt when Finix reports a duplicate
  // idempotency_id. Fetches the existing transfer and routes to the correct FSM
  // transition based on its state.
  async function handleDuplicateKey422(err: FinixTransferCancelledError): Promise<void> {
    try {
      const existing = await getTerminalTransferStatus(creds, err.existingTransferId)
      if (existing.state === 'SUCCEEDED') {
        console.warn(
          `[terminal-payment] ${terminalId} 422 duplicate key — ` +
          `existing transfer ${err.existingTransferId} SUCCEEDED, recording charge immediately`,
        )
        await recordSucceededTransferAndAdvance(err.existingTransferId, {
          amount:         existing.amount,
          cardBrand:      existing.cardBrand,
          cardLastFour:   existing.cardLastFour,
          approvalCode:   existing.approvalCode,
          entryMode:      existing.entryMode,
          tipAmountCents: existing.tipAmountCents,
        })
        return
      }
      if (existing.state === 'PENDING') {
        // Customer hasn't tapped yet — resume awaiting-tap on the existing transfer
        // rather than declining. The poll timer picks it up.
        console.warn(`[terminal-payment] ${terminalId} 422 duplicate key — existing transfer ${err.existingTransferId} still PENDING, resuming await-tap`)
        setTimeout(() => _transferCreated?.({ transferId: err.existingTransferId }), 0)
        return
      }
      // FAILED / CANCELED — safe to decline with the actual code from Finix.
      setTimeout(() => _tapDeclined?.({
        declineCode:    existing.failureCode    ?? err.failureCode ?? 'CANCELLATION_VIA_API',
        declineMessage: existing.failureMessage ?? err.message,
      }), 0)
    } catch (fetchErr) {
      // Could not verify the existing transfer — decline conservatively and log
      // for manual review. Do NOT retry with a fresh key; the original transfer
      // may be SUCCEEDED and unknown to us.
      console.error(
        `[terminal-payment] ${terminalId} 422 duplicate key — ` +
        `could not fetch existing transfer ${err.existingTransferId} to verify outcome:`,
        (fetchErr as Error).message ?? fetchErr,
      )
      setTimeout(() => _tapDeclined?.({
        declineCode:    err.failureCode ?? 'CANCELLATION_VIA_API',
        declineMessage: err.message,
      }), 0)
    }
  }

  /**
   * Record a SUCCEEDED transfer immediately to the DB and dispatch FSM actions.
   *
   * Used by every path in runCreateSale that discovers a SUCCEEDED transfer
   * outside the normal poll-tick happy path. Bypasses recordLocally=false so
   * the charge is never lost when the frontend isn't polling the winning TTX.
   *
   * `details.amount` MUST be the actual Finix-reported charge (which includes
   * any tip the customer added on the terminal), not the original request amount.
   */
  async function recordSucceededTransferAndAdvance(
    transferId: string,
    details: {
      amount:         number
      cardBrand:      string | null
      cardLastFour:   string | null
      approvalCode:   string | null
      entryMode:      string | null
      tipAmountCents: number
    },
  ): Promise<void> {
    try {
      await recordTerminalPayment(merchantId, {
        ..._lastModel,
        amountCents:  details.amount,
        transferId,
        cardBrand:    details.cardBrand    ?? _lastModel.cardBrand,
        cardLastFour: details.cardLastFour ?? _lastModel.cardLastFour,
        approvalCode: details.approvalCode ?? _lastModel.approvalCode,
      })
    } catch (dbErr) {
      console.error(
        `[terminal-payment] ${terminalId} immediate DB write failed for ` +
        `SUCCEEDED transfer ${transferId}: ${(dbErr as Error)?.message ?? dbErr}`,
      )
      logPaymentError(
        merchantId,
        'reconcile_gap',
        `Charge succeeded at Finix (${transferId}) but local DB write failed: ` +
        `${(dbErr as Error)?.message ?? dbErr}`,
        _lastModel.orderId,
      )
    }
    setTimeout(() => _transferCreated?.({ transferId }), 0)
    setTimeout(() => _tapApproved?.({
      approvedAmount: details.amount,
      cardBrand:      details.cardBrand,
      cardLastFour:   details.cardLastFour,
      approvalCode:   details.approvalCode,
      entryMode:      details.entryMode,
      tipAmountCents: details.tipAmountCents,
    }), 0)
  }

  // ── Component actions ─────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const componentActions: [string, (...args: any[]) => unknown][] = [
    ['INITIATE_PAYMENT', (data: {
      orderId:        string
      amountCents:    number
      idempotencyKey?: string
      startedAt?:     string
      splitMode?:      string | null
      splitLegNumber?: number | null
      splitTotalLegs?: number | null
      splitItemsJson?: string | null
    }) => {
      // Side effect (createTerminalSale) fires from the createSale NAP after the
      // model transitions to INITIATING, ensuring the FSM can reject duplicate calls
      // from non-IDLE states before any Finix API call is made.
      // idempotencyKey and startedAt are optional — passed during rehydration to
      // preserve the original values rather than generating fresh ones.
      // splitMode/splitLegNumber/splitTotalLegs/splitItemsJson are passed for
      // split payments so recovery-path DB writes can record split columns and
      // only mark the order paid on the final leg.
      return {
        orderId:             data.orderId,
        amountCents:         data.amountCents,
        idempotencyKey:      data.idempotencyKey ?? crypto.randomUUID(),
        startedAt:           data.startedAt      ?? new Date().toISOString(),
        splitMode:           data.splitMode      ?? null,
        splitLegNumber:      data.splitLegNumber ?? null,
        splitTotalLegs:      data.splitTotalLegs ?? null,
        splitItemsJson:      data.splitItemsJson ?? null,
        transferId:          null,
        cardBrand:           null,
        cardLastFour:        null,
        approvalCode:        null,
        entryMode:           null,
        approvedAmountCents: null,
        tipAmountCents:      null,
        paymentId:           null,
        declineCode:         null,
        declineMessage:      null,
      }
    }],
    ['TRANSFER_CREATED',  (data: { transferId: string }) => ({ transferId: data.transferId })],
    ['VERIFICATION_STARTED', () => ({})],
    ['TAP_APPROVED',      (data: { approvedAmount: number; cardBrand: string | null; cardLastFour: string | null; approvalCode: string | null; entryMode?: string | null; tipAmountCents?: number | null }) => ({
      approvedAmount: data.approvedAmount,
      cardBrand:      data.cardBrand,
      cardLastFour:   data.cardLastFour,
      approvalCode:   data.approvalCode,
      entryMode:      data.entryMode      ?? null,
      tipAmountCents: data.tipAmountCents ?? 0,
    })],
    ['TAP_DECLINED',      (data: { declineCode: string | null; declineMessage: string | null }) => ({
      declineCode:    data.declineCode,
      declineMessage: data.declineMessage,
    })],
    ['CANCEL_DECLINED',   () => ({})],
    ['PAYMENT_RECORDED',  (data: { paymentId: string | null }) => ({ paymentId: data.paymentId })],
    ['CANCEL_PAYMENT',    () => ({})],
    ['CANCEL_CONFIRMED',  () => ({})],
    ['EXIT_FLOW',         () => ({
      orderId:             null,
      amountCents:         null,
      transferId:          null,
      idempotencyKey:      null,
      startedAt:           null,
      splitMode:           null,
      splitLegNumber:      null,
      splitTotalLegs:      null,
      splitItemsJson:      null,
      cardBrand:           null,
      cardLastFour:        null,
      approvalCode:        null,
      entryMode:           null,
      approvedAmountCents: null,
      tipAmountCents:      null,
      paymentId:           null,
      declineCode:         null,
      declineMessage:      null,
    })],
  ]

  const result = instance({
    initialState: terminalPaymentFSM.initialState({
      terminalId,
      merchantId,
      finixDeviceId,
      txState:        'IDLE' as TerminalTxState,
      orderId:        null,
      amountCents:    null,
      transferId:     null,
      idempotencyKey: null,
      startedAt:      null,
      splitMode:      null,
      splitLegNumber: null,
      splitTotalLegs: null,
      splitItemsJson: null,
      cardBrand:      null,
      cardLastFour:   null,
      approvalCode:   null,
      paymentId:      null,
      declineCode:    null,
      declineMessage: null,
      ...initialModel,
    }),

    component: {
      actions: componentActions,

      acceptors: [
        // ── Pre-FSM rewrites ───────────────────────────────────────────────
        // 1. CANCELLING + TAP_DECLINED → rewrite to CANCEL_DECLINED (→ CANCELLED)
        //    Without this, TAP_DECLINED always goes to DECLINED regardless of source state.
        // 2. Partial-payment rejection: SUCCEEDED but amount < requested → TAP_DECLINED
        (model: TerminalPaymentModel) => (proposal: Record<string, unknown>) => {
          const action = proposal.__actionName as string

          if (action === 'TAP_DECLINED' && model.txState === 'CANCELLING') {
            proposal.__actionName = 'CANCEL_DECLINED'
            return
          }

          // Reject partial authorizations (approved < requested). Overpayments
          // (approved > requested) are legitimate for tip-on-terminal flows:
          // Finix charges `amount + tip`, so approved > requested signals a tip,
          // not a partial. Use `approvedAmount < amountCents` (strict) to catch
          // the real partial case only.
          if (
            action === 'TAP_APPROVED' &&
            model.txState === 'AWAITING_TAP' &&
            typeof proposal.approvedAmount === 'number' &&
            proposal.approvedAmount < (model.amountCents ?? 0)
          ) {
            const approved = proposal.approvedAmount as number
            proposal.__actionName  = 'TAP_DECLINED'
            proposal.declineCode   = 'PARTIAL_PAYMENT'
            proposal.declineMessage =
              `Card authorized $${(approved / 100).toFixed(2)} but order total is ` +
              `$${(model.amountCents! / 100).toFixed(2)} — partial payments not accepted`
          }
        },

        // ── FSM state-machine acceptors ────────────────────────────────────
        ...terminalPaymentFSM.acceptors,

        // ── Apply action data to model ─────────────────────────────────────
        // Runs AFTER the FSM acceptors (txState already advanced). Each branch
        // is guarded by the expected post-transition txState so that silently
        // rejected actions (FSM sets __error but doesn't stop subsequent
        // acceptors) cannot corrupt the model. For example, a second
        // INITIATE_PAYMENT while AWAITING_TAP is rejected by the FSM (txState
        // stays 'AWAITING_TAP', not 'INITIATING'), so the guard below prevents
        // transferId and other fields from being clobbered.
        (model: TerminalPaymentModel) => (proposal: Record<string, unknown>) => {
          const action = proposal.__actionName as string

          if (action === 'INITIATE_PAYMENT' && model.txState === 'INITIATING') {
            model.orderId             = proposal.orderId        as string
            model.amountCents         = proposal.amountCents    as number
            model.idempotencyKey      = proposal.idempotencyKey as string
            model.startedAt           = proposal.startedAt      as string
            model.splitMode           = (proposal.splitMode      ?? null) as string | null
            model.splitLegNumber      = (proposal.splitLegNumber ?? null) as number | null
            model.splitTotalLegs      = (proposal.splitTotalLegs ?? null) as number | null
            model.splitItemsJson      = (proposal.splitItemsJson ?? null) as string | null
            model.transferId          = null
            model.cardBrand           = null
            model.cardLastFour        = null
            model.approvalCode        = null
            model.entryMode           = null
            model.approvedAmountCents = null
            model.tipAmountCents      = null
            model.paymentId           = null
            model.declineCode         = null
            model.declineMessage      = null
          }

          if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
            model.transferId = proposal.transferId as string
          }

          if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
            model.cardBrand           = (proposal.cardBrand      as string | null) ?? null
            model.cardLastFour        = (proposal.cardLastFour   as string | null) ?? null
            model.approvalCode        = (proposal.approvalCode   as string | null) ?? null
            model.entryMode           = (proposal.entryMode      as string | null) ?? null
            model.approvedAmountCents = typeof proposal.approvedAmount === 'number' ? (proposal.approvedAmount as number) : null
            model.tipAmountCents      = typeof proposal.tipAmountCents === 'number' ? (proposal.tipAmountCents as number) : 0
          }

          if ((action === 'TAP_DECLINED' && model.txState === 'DECLINED') ||
              (action === 'CANCEL_DECLINED' && model.txState === 'CANCELLED')) {
            model.declineCode    = (proposal.declineCode    as string | null) ?? null
            model.declineMessage = (proposal.declineMessage as string | null) ?? null
          }

          if (action === 'PAYMENT_RECORDED' && model.txState === 'COMPLETED') {
            model.paymentId = (proposal.paymentId as string | null) ?? null
          }

          if (action === 'EXIT_FLOW' && model.txState === 'IDLE') {
            model.orderId             = null
            model.amountCents         = null
            model.transferId          = null
            model.idempotencyKey      = null
            model.startedAt           = null
            model.cardBrand           = null
            model.cardLastFour        = null
            model.approvalCode        = null
            model.entryMode           = null
            model.approvedAmountCents = null
            model.tipAmountCents      = null
            model.paymentId           = null
            model.declineCode         = null
            model.declineMessage      = null
          }
        },
      ],

      reactors: [
        ...terminalPaymentFSM.stateMachine,

        // Dehydrate to terminal_transactions on every state change
        (model: TerminalPaymentModel) => () => {
          dehydrateTerminalTx(model)
        },

        // Log state transitions
        (model: TerminalPaymentModel) => () => {
          console.log(`[terminal-payment] ${model.terminalId} → ${model.txState}`, {
            orderId:      model.orderId,
            transferId:   model.transferId,
            declineCode:  model.declineCode,
          })
        },
      ],

      naps: [
        // ── Create sale NAP: call createTerminalSale once when in INITIATING ─
        // Side effect lives here (not in the action) so the FSM can reject
        // INITIATE_PAYMENT from non-IDLE states BEFORE any Finix call is made.
        // Suppressed during rehydration fast-forward (_rehydrating flag).
        (model: TerminalPaymentModel) => () => {
          if (model.txState === 'INITIATING' && model.orderId && model.amountCents && !_createSaleInFlight && !_rehydrating) {
            _createSaleInFlight = true
            runCreateSale(model.orderId, model.amountCents, model.idempotencyKey!)
              .finally(() => { _createSaleInFlight = false })
          }
          return false
        },

        // ── Poll NAP: start interval on AWAITING_TAP ──────────────────────
        // Polls getTerminalTransferStatus every 2 s.
        // Dispatches TAP_APPROVED / TAP_DECLINED on terminal Finix states.
        // Checks timeout on every tick so CANCEL_PAYMENT fires even if Finix
        // stays PENDING beyond TIMEOUT_MS.
        (model: TerminalPaymentModel) => () => {
          if (model.txState === 'AWAITING_TAP' && model.transferId) {
            startPollInterval()
          }
          return false
        },

        // ── Cancel NAP: call Finix cancel API once when in CANCELLING ──────
        // The cancel endpoint returns the Transfer object. If the customer tapped
        // just before the cancel reached the device, state=SUCCEEDED — we must
        // dispatch TAP_APPROVED (not CANCEL_CONFIRMED) so the payment is recorded.
        //
        // Bug #2 (fix 2026-04-19): both .then(non-SUCCEEDED) and .catch can hide a
        // real charge. Finix may return state=FAILED with failure_code=CANCELLATION_VIA_API
        // (or throw an HTTP error outright) when the transfer is already terminal
        // SUCCEEDED. Before dispatching _cancelConfirmed, re-fetch the actual transfer
        // state via getTerminalTransferStatus — if SUCCEEDED, honour the charge.
        (model: TerminalPaymentModel) => () => {
          if (model.txState === 'CANCELLING' && !_cancelInFlight) {
            _cancelInFlight = true
            const knownTransferId = model.transferId

            const verifyAndResolve = async (
              probeTransferId: string | null,
            ): Promise<void> => {
              // If we know a transferId (either from model or from the cancel response),
              // fetch the authoritative state before assuming the cancel succeeded.
              if (probeTransferId) {
                try {
                  const check = await getTerminalTransferStatus(creds, probeTransferId)
                  if (check.state === 'SUCCEEDED') {
                    console.warn(`[terminal-payment] ${terminalId} cancel rejected but transfer ${probeTransferId} is SUCCEEDED — recording charge`)
                    _tapApproved?.({
                      approvedAmount: check.amount,
                      cardBrand:      check.cardBrand,
                      cardLastFour:   check.cardLastFour,
                      approvalCode:   check.approvalCode,
                      entryMode:      check.entryMode,
                      tipAmountCents: check.tipAmountCents,
                    })
                    return
                  }
                } catch {
                  // Probe failed — fall through to _cancelConfirmed (conservative).
                }
              }
              _cancelConfirmed?.()
            }

            cancelTerminalSale(creds, finixDeviceId)
              .then(async (result) => {
                if (result.state === 'SUCCEEDED') {
                  console.warn(`[terminal-payment] ${terminalId} cancel returned SUCCEEDED — customer tapped first, recording charge`)
                  _tapApproved?.({
                    approvedAmount: result.amount,
                    cardBrand:      result.cardBrand,
                    cardLastFour:   result.cardLastFour,
                    approvalCode:   result.approvalCode,
                    entryMode:      null,
                    tipAmountCents: 0,
                  })
                  return
                }
                // Non-SUCCEEDED response — probe the transfer (prefer the ID returned
                // by cancel, fall back to the one we already had) before confirming.
                await verifyAndResolve(result.transferId ?? knownTransferId)
              })
              .catch(async () => {
                // Cancel threw — most often because Finix refuses to cancel a
                // transfer already in a terminal SUCCEEDED state. Probe the
                // transfer we were waiting on before assuming cancel-confirmed.
                await verifyAndResolve(knownTransferId)
              })
              .finally(() => { _cancelInFlight = false })
          }
          return false
        },

        // ── Record NAP: insert payments row + update order once in RECORDING ─
        //   recordLocally=false (dashboard flow): skip the DB write; the client
        //   calls POST /record-payment later (with signature etc.). We still
        //   dispatch PAYMENT_RECORDED(null) so the FSM advances to COMPLETED
        //   and the ttx row dehydrates with the full card details.
        (model: TerminalPaymentModel) => () => {
          if (model.txState === 'RECORDING' && !_recordingInFlight) {
            _recordingInFlight = true
            if (recordLocally) {
              recordTerminalPayment(merchantId, model)
                .then((paymentId) => _paymentRecorded?.({ paymentId }))
                .catch((err) => {
                  // DB write failed — log but still move to COMPLETED to avoid re-charging
                  console.error('[terminal-payment] DB record failed:', err)
                  _paymentRecorded?.({ paymentId: null })
                })
                .finally(() => { _recordingInFlight = false })
            } else {
              // Defer to next microtask so the FSM's current dispatch settles first.
              setTimeout(() => {
                _paymentRecorded?.({ paymentId: null })
                _recordingInFlight = false
              }, 0)
            }
          }
          return false
        },
      ],

      options: {
        ignoreOutdatedProposals: true,
      },
    },

    render: (state: TerminalPaymentModel) => {
      // Keep snapshot current so getStatus() / rehydration poll can read it
      _lastModel = { ...state }
      const orderId = state.orderId
      if (!orderId) return

      // ── Structured payment event log (payment_events table) ───────────────
      // One entry per state transition for post-mortem analysis.
      // All terminal fields available here; logPaymentEvent never throws.
      switch (state.txState) {
        case 'INITIATING':
          logPaymentEvent('terminal_initiated', {
            merchantId: state.merchantId,
            orderId,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            message:     'Terminal payment initiated',
            extra:       { idempotencyKey: state.idempotencyKey },
          })
          break
        case 'AWAITING_TAP':
          logPaymentEvent('terminal_initiated', {
            merchantId: state.merchantId,
            orderId,
            transferId:  state.transferId ?? undefined,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            message:     'Transfer created — waiting for customer tap',
          })
          break
        case 'AWAITING_VERIFICATION':
          // The pending_terminal_sales INSERT + payment_events entry are written
          // by runCreateSale's fallback path before dispatching VERIFICATION_STARTED,
          // so this render branch just needs to surface the status to polling clients.
          break
        case 'RECORDING':
          logPaymentEvent('terminal_succeeded', {
            merchantId: state.merchantId,
            orderId,
            transferId:  state.transferId ?? undefined,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            message:     'Card approved — recording payment',
            extra:       { cardBrand: state.cardBrand, cardLastFour: state.cardLastFour, approvalCode: state.approvalCode },
          })
          break
        case 'DECLINED': {
          logPaymentEvent('terminal_failed', {
            merchantId: state.merchantId,
            orderId,
            transferId:  state.transferId ?? undefined,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            level:       'warn',
            message:     state.declineMessage ?? state.declineCode ?? 'Payment declined',
            extra:       { declineCode: state.declineCode },
          })
          // Map declineCode to the COSA error type:
          //   INITIATION_FAILED / IMMEDIATE_FAILURE / null       → generic terminal_error
          //   CANCELLATION_VIA_API / CANCELLATION_VIA_DEVICE     → terminal_cancelled
          //     (these are customer or staff cancels, not declines — they reach
          //      the DECLINED branch because the poll tick treats state=FAILED
          //      as _tapDeclined. Classifying them as terminal_cancelled lets
          //      the supersede sweep in record-payment hide them once the retry
          //      succeeds, matching the existing _cancelPayment flow.)
          //   Everything else (processor decline codes)          → terminal_declined
          const declineErrorType: PaymentErrorType =
            (!state.declineCode ||
             state.declineCode === 'INITIATION_FAILED' ||
             state.declineCode === 'IMMEDIATE_FAILURE')
              ? 'terminal_error'
              : (state.declineCode === 'CANCELLATION_VIA_API' ||
                 state.declineCode === 'CANCELLATION_VIA_DEVICE')
                ? 'terminal_cancelled'
                : 'terminal_declined'
          logPaymentError(
            state.merchantId,
            declineErrorType,
            state.declineMessage ?? state.declineCode ?? 'Payment declined',
            orderId,
          )
          // Release the payment-in-progress lock on DECLINED so staff can edit
          // the order again (e.g. add a dessert after a declined card).
          // Edit case 2026-04-20: lock was only released by /record-payment or
          // an explicit /terminal-sale/cancel call; organic DECLINED (card
          // decline, poll sees FAILED, timeout-induced decline) left the order
          // locked for up to 10 min. Safe to release here: no payment row was
          // created, nothing to protect.
          releasePaymentLock(orderId)
          break
        }
        case 'CANCELLED':
          logPaymentEvent('terminal_cancelled', {
            merchantId: state.merchantId,
            orderId,
            transferId:  state.transferId ?? undefined,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            message:     'Terminal payment cancelled',
          })
          // Only log terminal_cancelled if this was a genuine customer cancellation.
          // If the 180 s server-side timeout fired, _timedOut=true and the timeout
          // has already been written to payment_errors — skip to avoid double-counting.
          if (!_timedOut) {
            logPaymentError(
              state.merchantId,
              'terminal_cancelled',
              'Terminal payment cancelled',
              orderId,
            )
          }
          // Release the payment-in-progress lock on CANCELLED — no payment row
          // was inserted, so the order is still modifiable. Staff can now edit
          // items (e.g. add a dessert after the customer changed their mind).
          releasePaymentLock(orderId)
          break
        case 'COMPLETED':
          logPaymentEvent('terminal_succeeded', {
            merchantId: state.merchantId,
            orderId,
            transferId:  state.transferId ?? undefined,
            paymentId:   state.paymentId  ?? undefined,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            message:     state.paymentId
              ? 'Payment recorded successfully'
              : 'Payment approved — client will record via /record-payment',
            extra:       { cardBrand: state.cardBrand, cardLastFour: state.cardLastFour, approvalCode: state.approvalCode },
          })
          break
        default:
          break
      }

      let result: TerminalPaymentStatus | null = null
      switch (state.txState) {
        case 'COMPLETED':
          result = { status: 'approved', paymentId: state.paymentId ?? undefined }
          break
        case 'DECLINED':
          result = {
            status: 'declined',
            message: state.declineMessage ?? state.declineCode ?? 'Payment declined',
          }
          break
        case 'CANCELLED':
          result = { status: 'cancelled' }
          break
        case 'INITIATING':
        case 'AWAITING_TAP':
        case 'AWAITING_VERIFICATION':
        case 'RECORDING':
        case 'CANCELLING':
          result = { status: 'waiting' }
          break
        default:
          break
      }

      // Reset the timeout flag when the FSM reaches IDLE state (via EXIT_FLOW action).
      // Guards against a subsequent payment on the same terminal inheriting stale state.
      if (state.txState === 'IDLE') {
        _timedOut = false
      }

      if (result) {
        onResult(orderId, result)
        // Broadcast SSE terminal payment update to merchant dashboard
        broadcastToMerchant(state.merchantId, 'terminal_payment_update', {
          orderId,
          txState: state.txState,
          ...result,
        })
        // Remove routing entries once the result is final.
        // _registry is also pruned here so the SAM instance (and its closures) can be
        // GC'd. startTerminalPayment holds a local reference for the duration of the
        // current call (exitFlow + startPayment), so removing from the Map is safe.
        // The next payment call will recreate a fresh handle via createTerminalPaymentWorkflow.
        if (state.txState === 'COMPLETED' || state.txState === 'DECLINED' || state.txState === 'CANCELLED') {
          _orderToTerminal.delete(orderId)
          _registry.delete(state.terminalId)
          _entryAt.delete(state.terminalId)
        }
      }
    },
  })

  // ── Wire intent references ─────────────────────────────────────────────────
  const intentMap = new Map<string, (...args: unknown[]) => void>(
    componentActions.map(([name], i) => [name, result.intents[i]])
  )
  _initiatePayment     = intentMap.get('INITIATE_PAYMENT')     as typeof _initiatePayment
  _transferCreated     = intentMap.get('TRANSFER_CREATED')     as typeof _transferCreated
  _verificationStarted = intentMap.get('VERIFICATION_STARTED') as typeof _verificationStarted
  _tapApproved         = intentMap.get('TAP_APPROVED')         as typeof _tapApproved
  _tapDeclined         = intentMap.get('TAP_DECLINED')         as typeof _tapDeclined
  _cancelDeclined      = intentMap.get('CANCEL_DECLINED')      as typeof _cancelDeclined
  _paymentRecorded     = intentMap.get('PAYMENT_RECORDED')     as typeof _paymentRecorded
  _cancelPayment       = intentMap.get('CANCEL_PAYMENT')       as typeof _cancelPayment
  _cancelConfirmed     = intentMap.get('CANCEL_CONFIRMED')     as typeof _cancelConfirmed
  _exitFlow            = intentMap.get('EXIT_FLOW')            as typeof _exitFlow

  void _cancelDeclined  // internal action, not exposed in WorkflowHandle

  // ── Rehydration boot ───────────────────────────────────────────────────────
  // sam-fsm's initialState() ALWAYS resets txState to pc0 ('IDLE'), so spreading
  // initialModel into the initial state object doesn't work. Instead we fast-forward
  // the SAM from IDLE to AWAITING_TAP by dispatching INITIATE_PAYMENT then
  // TRANSFER_CREATED via nested setTimeout(0)s, matching the order-relay pattern.
  //
  // _rehydrating = true suppresses the createSale NAP so no Finix API call is made
  // for the already-in-flight transfer from before the restart.
  if (initialModel?.txState === 'AWAITING_TAP' && initialModel?.transferId) {
    console.log(
      `[terminal-payment] Rehydrating AWAITING_TAP for ${terminalId},` +
      ` resuming poll on transfer ${initialModel.transferId}`,
    )
    _rehydrating = true
    setTimeout(() => {
      _initiatePayment?.({
        orderId:        initialModel.orderId        ?? '',
        amountCents:    initialModel.amountCents    ?? 0,
        idempotencyKey: initialModel.idempotencyKey ?? undefined,
        startedAt:      initialModel.startedAt      ?? undefined,
      })
      // Wait for INITIATE_PAYMENT microtask to complete before dispatching
      // TRANSFER_CREATED. Each setTimeout(0) ensures the prior intent's
      // microtask queue is fully drained before the next macrotask fires.
      setTimeout(() => {
        _transferCreated?.({ transferId: initialModel.transferId! })
        setTimeout(() => { _rehydrating = false }, 0)
      }, 0)
    }, 0)
  }

  // ── Public handle ──────────────────────────────────────────────────────────
  const handle: TerminalPaymentWorkflowHandle = {
    startPayment: (
      orderId:         string,
      amountCents:     number,
      idempotencyKey?: string,
      splitMeta?:      {
        splitMode:      string | null
        splitLegNumber: number | null
        splitTotalLegs: number | null
        splitItemsJson: string | null
      },
    ) => {
      _orderToTerminal.set(orderId, terminalId)
      _initiatePayment?.({
        orderId,
        amountCents,
        idempotencyKey,
        splitMode:      splitMeta?.splitMode      ?? null,
        splitLegNumber: splitMeta?.splitLegNumber ?? null,
        splitTotalLegs: splitMeta?.splitTotalLegs ?? null,
        splitItemsJson: splitMeta?.splitItemsJson ?? null,
      })
    },
    cancelPayment: () => {
      _cancelPayment?.()
    },
    exitFlow: () => {
      _exitFlow?.()
    },
    getStatus: () => ({ ..._lastModel }),
    resolveVerification: (o: VerificationOutcome) => {
      if (_lastModel.txState !== 'AWAITING_VERIFICATION') {
        console.warn(
          `[terminal-payment] ${terminalId} resolveVerification ignored — ` +
          `txState is ${_lastModel.txState}, not AWAITING_VERIFICATION`,
        )
        return
      }
      if (o.outcome === 'approved') {
        _tapApproved?.({
          approvedAmount: o.approvedAmount ?? _lastModel.amountCents ?? 0,
          cardBrand:      o.cardBrand      ?? null,
          cardLastFour:   o.cardLastFour   ?? null,
          approvalCode:   o.approvalCode   ?? null,
          entryMode:      o.entryMode      ?? null,
          tipAmountCents: o.tipAmountCents ?? 0,
        })
      } else {
        _tapDeclined?.({
          declineCode:    o.declineCode    ?? 'VERIFICATION_FAILED',
          declineMessage: o.declineMessage ?? 'Verification found no matching transfer on processor',
        })
      }
    },
  }

  return handle
}

// ---------------------------------------------------------------------------
// Higher-level API (used by counter-ws.ts)
// ---------------------------------------------------------------------------

/**
 * Loads Finix credentials and PAX A920 Pro terminal config for a merchant.
 * Returns null if credentials or A920 Pro finix_device_id are not configured.
 */
async function loadA920FinixCreds(merchantId: string): Promise<{
  creds:          FinixCredentials
  terminalId:     string
  finixDeviceId:  string
} | null> {
  const db = getDatabase()
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return null

  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`,
    )
    .get(merchantId)
  const parts = (keyRow?.pos_merchant_id ?? '').split(':')
  if (parts.length !== 3) return null

  const merchantRow = db
    .query<{ finix_sandbox: number }, [string]>(
      `SELECT finix_sandbox FROM merchants WHERE id = ?`,
    )
    .get(merchantId)
  const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

  const terminal = db
    .query<{ id: string; finix_device_id: string }, [string]>(
      `SELECT id, finix_device_id FROM terminals
       WHERE merchant_id = ? AND model IN ('pax_a920_pro', 'pax_a920_emu')
         AND finix_device_id IS NOT NULL LIMIT 1`,
    )
    .get(merchantId)
  if (!terminal?.finix_device_id) return null

  return {
    creds: {
      apiUsername:   parts[0],
      applicationId: parts[1],
      merchantId:    parts[2],
      apiPassword,
      sandbox,
    },
    terminalId:    terminal.id,
    finixDeviceId: terminal.finix_device_id,
  }
}

/**
 * Starts a PAX A920 Pro terminal payment via the SAM workflow.
 *
 * Loads credentials, creates or retrieves the workflow for this terminal,
 * and dispatches INITIATE_PAYMENT. Results flow back through `onResult`.
 *
 * @returns error string or null on success
 */
export async function startTerminalPayment(
  merchantId:  string,
  orderId:     string,
  amountCents: number,
  onResult:    (orderId: string, result: TerminalPaymentStatus) => void,
): Promise<string | null> {
  const setup = await loadA920FinixCreds(merchantId)
  if (!setup) return 'Finix credentials or PAX A920 Pro device ID not configured'

  let handle = _registry.get(setup.terminalId)
  if (!handle) {
    handle = createTerminalPaymentWorkflow(
      setup.terminalId,
      merchantId,
      setup.finixDeviceId,
      setup.creds,
      onResult,
    )
    _registry.set(setup.terminalId, handle)
    _entryAt.set(setup.terminalId, Date.now())
  }

  if (_initiating.has(setup.terminalId)) return 'Payment initiation already in progress for this terminal'

  // Auto-reset terminal states (COMPLETED/DECLINED/CANCELLED) before starting a new
  // payment leg. Without this, INITIATE_PAYMENT is rejected by the FSM from these states
  // (only EXIT_FLOW is allowed), and sam-pattern re-renders the stale COMPLETED model —
  // causing the second split leg to appear already paid with leg 1's paymentId.
  const currentTxState = handle.getStatus().txState
  if (currentTxState === 'COMPLETED' || currentTxState === 'DECLINED' || currentTxState === 'CANCELLED') {
    handle.exitFlow()
    // Yield to the event loop so SAM processes EXIT_FLOW (IDLE) before INITIATE_PAYMENT.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }

  _initiating.add(setup.terminalId)
  try {
    _orderToTerminal.set(orderId, setup.terminalId)
    handle.startPayment(orderId, amountCents)
  } finally {
    _initiating.delete(setup.terminalId)
  }
  return null
}

/**
 * Cancels an in-progress A920 Pro payment for the given orderId.
 * No-ops if the order is not tracked.
 */
export function cancelTerminalPayment(_merchantId: string, orderId: string): void {
  const terminalId = _orderToTerminal.get(orderId)
  if (!terminalId) return
  const handle = _registry.get(terminalId)
  handle?.cancelPayment()
}

/**
 * Returns the current payment status for an A920 Pro order, or null if
 * no workflow is tracking this orderId.
 *
 * Status shape is compatible with CounterPaymentResult in counter-ws.ts.
 */
export function getA920PaymentStatus(orderId: string): TerminalPaymentStatus | null {
  const terminalId = _orderToTerminal.get(orderId)
  if (!terminalId) return null
  const handle = _registry.get(terminalId)
  if (!handle) return null

  const model = handle.getStatus()
  switch (model.txState) {
    case 'COMPLETED':
      return { status: 'approved', paymentId: model.paymentId ?? undefined }
    case 'DECLINED':
      return {
        status: 'declined',
        message: model.declineMessage ?? model.declineCode ?? 'Payment declined',
      }
    case 'CANCELLED':
      return { status: 'cancelled' }
    case 'IDLE':
      return null
    default:
      return { status: 'waiting' }
  }
}

// ---------------------------------------------------------------------------
// Rehydration
// ---------------------------------------------------------------------------

/**
 * On server restart: reload all terminal_transactions rows with active
 * tx_state and recreate SAM workflow instances so polling resumes.
 */
export async function rehydrateTerminalWorkflows(): Promise<void> {
  console.log('🔄 Rehydrating terminal payment workflows...')

  const db = getDatabase()

  // Check if table exists (migration might not have run yet on first boot)
  const tableExists = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_transactions'`
  ).get()
  if (!tableExists) {
    console.log('   terminal_transactions table not yet created — skipping')
    return
  }

  // INITIATING rows older than 5 minutes can never succeed — the Finix request
  // timed out long ago. Cancel them in the DB so they don't block the terminal
  // after a server restart.
  const staleInitiatingCutoff = new Date(Date.now() - 5 * 60 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19)
  const staleRows = db
    .query<{ id: string; terminal_id: string; order_id: string | null; created_at: string }, [string]>(
      `SELECT id, terminal_id, order_id, created_at
       FROM terminal_transactions
       WHERE tx_state = 'INITIATING' AND created_at < ?`,
    )
    .all(staleInitiatingCutoff)
  if (staleRows.length > 0) {
    for (const r of staleRows) {
      console.warn(
        `[terminal-payment] Stale INITIATING row detected — cancelling:` +
        ` ttx=${r.id} terminal=${r.terminal_id} order=${r.order_id ?? 'none'} created_at=${r.created_at}`,
      )
    }
    db.run(
      `UPDATE terminal_transactions
       SET tx_state = 'CANCELLED', updated_at = datetime('now')
       WHERE tx_state = 'INITIATING' AND created_at < ?`,
      [staleInitiatingCutoff],
    )
  }

  const rows = db
    .query<{
      id:               string
      terminal_id:      string
      merchant_id:      string
      finix_device_id:  string | null
      tx_state:         string
      sam_state:        string | null
    }, []>(
      `SELECT t.id, t.terminal_id, t.merchant_id,
              term.finix_device_id,
              t.tx_state, t.sam_state
       FROM terminal_transactions t
       JOIN terminals term ON term.id = t.terminal_id
       WHERE t.tx_state NOT IN ('IDLE', 'COMPLETED', 'DECLINED', 'CANCELLED')
       ORDER BY t.created_at ASC`,
    )
    .all()

  let count = 0
  for (const row of rows) {
    try {
      if (!row.finix_device_id) continue

      const apiPassword = await getAPIKey(row.merchant_id, 'payment', 'finix').catch(() => null)
      if (!apiPassword) continue

      const keyRow = db
        .query<{ pos_merchant_id: string | null }, [string]>(
          `SELECT pos_merchant_id FROM api_keys
           WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`,
        )
        .get(row.merchant_id)
      const parts = (keyRow?.pos_merchant_id ?? '').split(':')
      if (parts.length !== 3) continue

      const merchantRow = db
        .query<{ finix_sandbox: number }, [string]>(
          `SELECT finix_sandbox FROM merchants WHERE id = ?`,
        )
        .get(row.merchant_id)
      const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

      const creds: FinixCredentials = {
        apiUsername:   parts[0],
        applicationId: parts[1],
        merchantId:    parts[2],
        apiPassword,
        sandbox,
      }

      const persistedModel: Partial<TerminalPaymentModel> = row.sam_state
        ? JSON.parse(row.sam_state) as Partial<TerminalPaymentModel>
        : { txState: row.tx_state as TerminalTxState }

      // No-op onResult for rehydrated workflows (result was already stored in DB)
      const handle = createTerminalPaymentWorkflow(
        row.terminal_id,
        row.merchant_id,
        row.finix_device_id,
        creds,
        (_orderId, _result) => {
          // SSE broadcast still fires via render; _results in counter-ws.ts will
          // be populated if the modal is still open and polling payment-status.
        },
        persistedModel,
      )

      _registry.set(row.terminal_id, handle)
      _entryAt.set(row.terminal_id, Date.now())
      if (persistedModel.orderId) {
        _orderToTerminal.set(persistedModel.orderId, row.terminal_id)
      }
      count++
    } catch (err) {
      console.error(`[terminal-payment] Failed to rehydrate terminal ${row.terminal_id}:`, err)
    }
  }

  console.log(`✅ Rehydrated ${count} active terminal workflow(s)`)

  // ── Orphan-payment sweep ──────────────────────────────────────────────────
  // Recover COMPLETED terminal_transactions that have no matching payment row.
  // This happens when the modal is closed before reaching RECEIPT_OPTIONS
  // (recordLocally=false flow) and /record-payment is never called. We write
  // the payment row directly from the TTX data so the order is not silently
  // left unpaid. Only considers rows created in the last 48 hours to avoid
  // touching stale data; only runs when the order is still in an unpaid state.
  await recoverOrphanedCompletedPayments()
}

async function recoverOrphanedCompletedPayments(): Promise<void> {
  const db = getDatabase()
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19)

  const orphans = db
    .query<{
      id:               string
      merchant_id:      string
      order_id:         string | null
      finix_transfer_id: string | null
      approved_amount_cents: number | null
      amount_cents:     number | null
      tip_amount_cents:  number | null
      card_brand:       string | null
      card_last_four:   string | null
      approval_code:    string | null
      completed_at:     string | null
      order_status:     string
      subtotal_cents:   number
      tax_cents:        number
    }, [string]>(
      `SELECT ttx.id, ttx.merchant_id, ttx.order_id, ttx.finix_transfer_id,
              ttx.approved_amount_cents, ttx.amount_cents, ttx.tip_amount_cents,
              ttx.card_brand, ttx.card_last_four, ttx.approval_code, ttx.completed_at,
              o.status AS order_status, o.subtotal_cents, o.tax_cents
       FROM terminal_transactions ttx
       JOIN orders o ON o.id = ttx.order_id
       WHERE ttx.tx_state = 'COMPLETED'
         AND ttx.payment_id IS NULL
         AND ttx.finix_transfer_id IS NOT NULL
         AND ttx.created_at >= ?
         AND o.status NOT IN ('paid', 'cancelled', 'refunded')`,
    )
    .all(cutoff)

  if (orphans.length === 0) return

  console.warn(`[terminal-payment] Orphan sweep: found ${orphans.length} COMPLETED TTX row(s) with no payment record`)

  for (const row of orphans) {
    if (!row.order_id || !row.finix_transfer_id) continue
    try {
      const totalCents   = row.approved_amount_cents ?? row.amount_cents ?? 0
      const tipCents     = Math.max(0, totalCents - row.subtotal_cents - row.tax_cents)
      const paymentId    = `pay_${randomBytes(16).toString('hex')}`
      const now          = new Date().toISOString().replace('T', ' ').substring(0, 19)
      const completedAt  = row.completed_at ?? now

      db.exec('BEGIN')
      const ins = db.run(
        `INSERT INTO payments (
            id, order_id, merchant_id, payment_type, amount_cents,
            subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
            card_type, card_last_four, transaction_id, processor, auth_code,
            finix_transfer_id, created_at, completed_at
         ) VALUES (?, ?, ?, 'card', ?, ?, ?, ?, 0, null, ?, ?, ?, 'finix_terminal', ?, ?, ?, ?)
         ON CONFLICT (order_id, finix_transfer_id) DO NOTHING`,
        [
          paymentId, row.order_id, row.merchant_id, totalCents,
          row.subtotal_cents, row.tax_cents, tipCents,
          row.card_brand ?? null, row.card_last_four ?? null,
          row.finix_transfer_id, row.approval_code ?? null,
          row.finix_transfer_id, completedAt, completedAt,
        ],
      )
      if (ins.changes === 0) {
        db.exec('ROLLBACK')
        console.warn(`[terminal-payment] Orphan sweep: duplicate suppressed for transfer ${row.finix_transfer_id}`)
        continue
      }
      db.run(
        `UPDATE orders SET status = 'paid', paid_amount_cents = ?, tip_cents = ?,
            payment_method = 'card', updated_at = ?
         WHERE id = ?`,
        [totalCents, tipCents, now, row.order_id],
      )
      db.run(
        `UPDATE terminal_transactions SET payment_id = ? WHERE id = ?`,
        [paymentId, row.id],
      )
      db.exec('COMMIT')

      console.warn(
        `[terminal-payment] Orphan sweep: recovered payment for order ${row.order_id}` +
        ` transfer=${row.finix_transfer_id} amount=${totalCents} tip=${tipCents} paymentId=${paymentId}`,
      )
      logPaymentEvent('terminal_succeeded', {
        merchantId: row.merchant_id,
        orderId:    row.order_id,
        transferId: row.finix_transfer_id,
        paymentId,
        amountCents: totalCents,
        level: 'warn',
        message: 'Orphan sweep: recovered unrecorded payment from COMPLETED TTX',
        extra:   { cardBrand: row.card_brand, cardLastFour: row.card_last_four, approvalCode: row.approval_code },
      })
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      console.error(`[terminal-payment] Orphan sweep: failed to recover ttx ${row.id}:`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// TTL sweep — prunes handles that never reached a terminal state
// ---------------------------------------------------------------------------

const _TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

/**
 * Removes registry entries that have been alive for more than 24 hours without
 * completing.  Handles in COMPLETED/DECLINED/CANCELLED are already pruned in the
 * render callback; this sweep is a safety net for handles stuck in INITIATING,
 * AWAITING_TAP, RECORDING, or CANCELLING (e.g. Finix API down, process restart
 * edge cases, or a crashed payment that was never cleaned up).
 *
 * Call once at startup to start the hourly background timer.  Returns a cleanup
 * function that stops the interval (useful in tests).
 */
export function startTerminalPaymentSweep(): () => void {
  const sweep = () => {
    const cutoff = Date.now() - _TTL_MS
    for (const [tid, ts] of _entryAt) {
      if (ts < cutoff) {
        _registry.delete(tid)
        _entryAt.delete(tid)
        // Also clean up any stale orderId entry pointing to this terminal
        for (const [oid, t] of _orderToTerminal) {
          if (t === tid) _orderToTerminal.delete(oid)
        }
        console.warn(`[terminal-payment] TTL sweep: pruned stale handle for terminal ${tid} (age >${_TTL_MS / 3_600_000}h)`)
      }
    }
  }

  const interval = setInterval(sweep, 60 * 60 * 1000)  // hourly
  return () => clearInterval(interval)
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Records a successful server-initiated terminal payment.
 * Inserts into `payments`. Marks `orders.status='paid'` only on the final leg
 * of a split payment (or the only leg of a non-split payment). Intermediate
 * split legs leave the order in `confirmed` so subsequent legs can record
 * cleanly via /record-payment.
 *
 * Returns the new paymentId, or the existing paymentId on idempotent retry,
 * or null when the order is in a terminal state with no matching transfer row.
 */
async function recordTerminalPayment(
  merchantId: string,
  model:      TerminalPaymentModel,
): Promise<string | null> {
  const db = getDatabase()
  const orderId = model.orderId!

  const order = db
    .query<{ subtotal_cents: number; tax_cents: number; status: string }, [string, string]>(
      `SELECT subtotal_cents, tax_cents, status FROM orders WHERE id = ? AND merchant_id = ?`,
    )
    .get(orderId, merchantId)

  if (!order) {
    console.warn(`[terminal-payment] payment for unknown order ${orderId}`)
    return null
  }
  if (['paid', 'cancelled', 'refunded'].includes(order.status)) {
    // If the order is already paid and we have the transfer ID that paid it,
    // return the existing paymentId so the FSM gets a valid paymentId on
    // the RECORDING NAP's second call (when recordSucceededTransferAndAdvance
    // already wrote the row and the RECORDING NAP fires again idempotently).
    if (order.status === 'paid' && model.transferId) {
      const existing = db.query<{ id: string }, [string, string]>(
        `SELECT id FROM payments WHERE order_id = ? AND finix_transfer_id = ? LIMIT 1`,
      ).get(orderId, model.transferId)
      if (existing) return existing.id
    }
    console.warn(`[terminal-payment] order ${orderId} already ${order.status} — idempotent skip`)
    return null
  }

  const splitMode      = model.splitMode      ?? null
  const splitLegNumber = model.splitLegNumber ?? null
  const splitTotalLegs = model.splitTotalLegs ?? null
  const splitItemsJson = model.splitItemsJson ?? null

  const paymentId = `pay_${randomBytes(16).toString('hex')}`
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  const totalCents = model.amountCents!
  // Split legs cannot infer tip from the order's subtotal/tax (each leg pays a
  // share of the bill). When split metadata is present the leg amount IS the
  // tipless leg total; any extra Finix-reported amount comes from tipAmountCents.
  // For non-split, fall back to (legAmount - orderSubtotal - orderTax) for back-compat.
  const tipCents = splitMode
    ? Math.max(0, model.tipAmountCents ?? 0)
    : Math.max(0, totalCents - order.subtotal_cents - order.tax_cents)

  let isLastLeg: boolean = true

  try {
    db.exec('BEGIN')

    // ── by_items: derive isLastLeg from cumulative item coverage ─────────
    // Mirrors dashboard-payments.ts record-payment. The terminal flow used
    // to derive isLastLeg from splitTotalLegs which is null for by_items,
    // so a single leg would (always-incorrectly) mark the order paid.
    let byItemsLegIndices: number[] = []
    if (!splitMode) {
      isLastLeg = true
    } else if (splitMode === 'by_items') {
      // Parse and validate this leg's indices (best-effort — caller validated
      // at the route layer, but defense in depth at the persistence layer).
      const itemsRow = db
        .query<{ items: string }, [string]>(`SELECT items FROM orders WHERE id = ?`)
        .get(orderId)
      const totalUnits = itemsRow
        ? (JSON.parse(itemsRow.items) as Array<{ quantity?: number }>)
            .reduce((s, it) => s + Math.max(1, it.quantity ?? 1), 0)
        : 0
      try {
        const parsed = splitItemsJson ? JSON.parse(splitItemsJson) : []
        if (Array.isArray(parsed)) byItemsLegIndices = parsed as number[]
      } catch { /* leave empty */ }

      const priorIndices = new Set<number>()
      const priorLegs = db
        .query<{ split_items_json: string | null }, [string]>(
          `SELECT split_items_json FROM payments
           WHERE order_id = ? AND split_mode = 'by_items' AND split_items_json IS NOT NULL`,
        )
        .all(orderId)
      for (const leg of priorLegs) {
        try {
          const arr = JSON.parse(leg.split_items_json ?? '[]') as number[]
          for (const i of arr) priorIndices.add(i)
        } catch { /* skip malformed */ }
      }
      for (const idx of byItemsLegIndices) priorIndices.add(idx)
      isLastLeg = totalUnits > 0 && priorIndices.size === totalUnits
    } else {
      isLastLeg = (splitLegNumber ?? 1) >= (splitTotalLegs ?? 1)
    }

    const insertResult = db.run(
      `INSERT INTO payments (
          id, order_id, merchant_id, payment_type, amount_cents,
          subtotal_cents, tax_cents, tip_cents, amex_surcharge_cents, gratuity_percent,
          card_type, card_last_four, cardholder_name,
          transaction_id, processor, auth_code,
          finix_transfer_id,
          signature_base64, signature_captured_at,
          split_mode, split_leg_number, split_total_legs, split_items_json,
          receipt_email, created_at, completed_at
       ) VALUES (?, ?, ?, 'card', ?, ?, ?, ?, 0, null, ?, ?, null,
                 ?, 'finix_terminal', ?, ?, null, null, ?, ?, ?, ?, null, ?, ?)
       ON CONFLICT (order_id, finix_transfer_id) DO NOTHING`,
      [
        paymentId, orderId, merchantId, totalCents,
        order.subtotal_cents, order.tax_cents, tipCents,
        model.cardBrand ?? null,
        model.cardLastFour ?? null,
        model.transferId ?? null,
        model.approvalCode ?? null,
        model.transferId ?? null,
        splitMode, splitLegNumber, splitTotalLegs, splitItemsJson,
        now, now,
      ],
    )

    if (insertResult.changes === 0) {
      // Duplicate transfer ID — another recovery path already wrote this payment row.
      // Roll back and return the existing paymentId to avoid double-charge.
      db.exec('ROLLBACK')
      const existing = db.query<{ id: string }, [string, string]>(
        `SELECT id FROM payments WHERE order_id = ? AND finix_transfer_id = ? LIMIT 1`,
      ).get(orderId, model.transferId!)
      console.warn(
        `[terminal-payment] duplicate INSERT suppressed for transferId=${model.transferId} — existing paymentId=${existing?.id}`,
      )
      return existing?.id ?? paymentId
    }

    // ── UPSERT order_split_sessions for multi-leg splits ─────────────────
    // Mirrors dashboard-payments.ts. Without this, a split paid via the
    // Finix terminal would never get a session row, breaking pause/resume,
    // EOD writeoff, and the in-modal "Customer Left" flow.
    if (splitMode === 'equal' || splitMode === 'by_items' || splitMode === 'custom') {
      // legBase = this leg's pre-tip charge (subtotal + tax of the leg's
      // share). Mirrors record-payment's `subtotalCents + taxCents` from the
      // body. The terminal-sale endpoint sends `totalCents = leg subtotal +
      // tax + tip + surcharge`; tipCents is computed above; amex surcharge
      // is hardcoded 0 for the terminal flow.
      const legBase = totalCents - tipCents
      const sessionStatus = isLastLeg ? 'completed' : 'in_progress'
      const expectedTotal = splitMode === 'by_items' ? null : (splitTotalLegs ?? null)

      const existing = db
        .query<{ paid_leg_bases_json: string; paid_indices_json: string; status: string }, [string]>(
          `SELECT paid_leg_bases_json, paid_indices_json, status
           FROM order_split_sessions WHERE order_id = ?`,
        )
        .get(orderId)

      if (existing) {
        if (existing.status !== 'completed') {
          const bases: number[] = JSON.parse(existing.paid_leg_bases_json)
          bases.push(legBase)
          const indices: number[] = JSON.parse(existing.paid_indices_json)
          if (splitMode === 'by_items') {
            for (const i of byItemsLegIndices) indices.push(i)
          }
          const nextLegNumber = bases.length + 1
          db.run(
            `UPDATE order_split_sessions
             SET paid_leg_bases_json = ?, paid_indices_json = ?,
                 current_leg_number  = ?, status = ?,
                 paused_at = NULL, paused_by_employee_id = NULL,
                 updated_at = ?
             WHERE order_id = ?`,
            [JSON.stringify(bases), JSON.stringify(indices), nextLegNumber, sessionStatus, now, orderId],
          )
        }
      } else {
        db.run(
          `INSERT INTO order_split_sessions
             (order_id, merchant_id, split_mode, expected_total_legs,
              current_leg_number, paid_leg_bases_json, paid_indices_json,
              status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            orderId, merchantId, splitMode, expectedTotal,
            2,
            JSON.stringify([legBase]),
            JSON.stringify(splitMode === 'by_items' ? byItemsLegIndices : []),
            sessionStatus, now, now,
          ],
        )
      }
    }

    if (isLastLeg) {
      // Sum across all legs so the order's totals reflect every payments row,
      // not just this leg. Mirrors the formula in dashboard-payments.ts.
      const totals = db
        .query<{ total_paid: number; total_tips: number }, [string]>(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total_paid,
                  COALESCE(SUM(tip_cents),    0) AS total_tips
           FROM payments WHERE order_id = ?`,
        )
        .get(orderId)
      const finalPaid = totals?.total_paid ?? totalCents
      const finalTips = totals?.total_tips ?? tipCents

      db.run(
        `UPDATE orders
         SET status = 'paid', tip_cents = ?, paid_amount_cents = ?,
             payment_method = 'card', updated_at = ?
         WHERE id = ?`,
        [finalTips, finalPaid, now, orderId],
      )
    }

    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }

  scheduleReconciliation(merchantId, paymentId, 'card')
  console.log(
    `[terminal-payment] ✓ payment recorded paymentId=${paymentId} ` +
    `transferId=${model.transferId} orderId=${orderId}` +
    (splitMode ? ` (leg ${splitLegNumber}/${splitTotalLegs}${isLastLeg ? ' — order paid' : ' — order still confirmed'})` : ''),
  )
  return paymentId
}

/**
 * Upserts the current terminal transaction state into terminal_transactions.
 * Called from the reactor on every state change.
 */
function dehydrateTerminalTx(model: TerminalPaymentModel): void {
  if (model.txState === 'IDLE') return  // No active transaction to persist

  // Generate a stable row ID on first entry into a transaction
  // (model enters INITIATING when INITIATE_PAYMENT fires)
  let ttxId = _getTtxId(model.terminalId)
  if (!ttxId) {
    ttxId = `ttx_${randomBytes(8).toString('hex')}`
    _setTtxId(model.terminalId, ttxId)
  }

  const db = getDatabase()
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  const isTerminal = ['COMPLETED', 'DECLINED', 'CANCELLED'].includes(model.txState)

  try {
    db.run(
      `INSERT INTO terminal_transactions (
          id, terminal_id, merchant_id, order_id,
          tx_state, amount_cents, finix_transfer_id, idempotency_key,
          card_brand, card_last_four, approval_code, entry_mode,
          tip_amount_cents, approved_amount_cents,
          decline_code, decline_message, payment_id,
          started_at, completed_at, sam_state,
          created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
          tx_state              = excluded.tx_state,
          finix_transfer_id     = excluded.finix_transfer_id,
          card_brand            = excluded.card_brand,
          card_last_four        = excluded.card_last_four,
          approval_code         = excluded.approval_code,
          entry_mode            = excluded.entry_mode,
          tip_amount_cents      = excluded.tip_amount_cents,
          approved_amount_cents = excluded.approved_amount_cents,
          decline_code          = excluded.decline_code,
          decline_message       = excluded.decline_message,
          payment_id            = excluded.payment_id,
          completed_at          = excluded.completed_at,
          sam_state             = excluded.sam_state,
          updated_at            = excluded.updated_at`,
      [
        ttxId,
        model.terminalId,
        model.merchantId,
        model.orderId,
        model.txState,
        model.amountCents,
        model.transferId,
        model.idempotencyKey,
        model.cardBrand,
        model.cardLastFour,
        model.approvalCode,
        model.entryMode,
        model.tipAmountCents,
        model.approvedAmountCents,
        model.declineCode,
        model.declineMessage,
        model.paymentId,
        model.startedAt,
        isTerminal ? now : null,
        JSON.stringify(model),
        now,
        now,
      ],
    )

    // Clear ttx row ID on terminal states so the next transaction gets a fresh row
    if (isTerminal) {
      _clearTtxId(model.terminalId)
    }
  } catch (err) {
    console.error('[terminal-payment] dehydrate failed:', err)
  }
}

// ── Per-terminal ttx ID tracker (module-level, not persisted) ────────────────
const _ttxIds = new Map<string, string>()

function _getTtxId(terminalId: string): string | undefined {
  return _ttxIds.get(terminalId)
}

function _setTtxId(terminalId: string, ttxId: string): void {
  _ttxIds.set(terminalId, ttxId)
}

function _clearTtxId(terminalId: string): void {
  _ttxIds.delete(terminalId)
}

// ---------------------------------------------------------------------------
// Dashboard-facing API (async-polling terminal sale)
// ---------------------------------------------------------------------------

/**
 * Loads Finix credentials and resolves a terminal row for a merchant. Not
 * restricted to a specific hardware model (unlike `loadA920FinixCreds`).
 *
 * @param terminalId When provided, resolves that specific terminal; otherwise
 *                   returns the first terminal with a cached `finix_device_id`.
 */
export async function loadFinixCredsForTerminal(
  merchantId: string,
  terminalId?: string,
): Promise<{
  creds:         FinixCredentials
  terminalId:    string
  finixDeviceId: string
} | null> {
  // Emulator bypass — same behaviour as dashboard-payments.loadFinixCreds.
  if (process.env.FINIX_EMULATOR_URL) {
    const db = getDatabase()
    const term = terminalId
      ? db.query<{ id: string; finix_device_id: string | null }, [string, string]>(
          `SELECT id, finix_device_id FROM terminals WHERE id = ? AND merchant_id = ?`,
        ).get(terminalId, merchantId)
      : db.query<{ id: string; finix_device_id: string | null }, [string]>(
          `SELECT id, finix_device_id FROM terminals
           WHERE merchant_id = ? AND finix_device_id IS NOT NULL LIMIT 1`,
        ).get(merchantId)
    if (!term?.finix_device_id) return null
    return {
      creds: {
        apiUsername:   'emulator',
        applicationId: 'APemulator000000000000000000000',
        merchantId:    'MUemulator000000000000000000000',
        apiPassword:   'emulator-secret',
        sandbox:       true,
      },
      terminalId:    term.id,
      finixDeviceId: term.finix_device_id,
    }
  }

  const db = getDatabase()
  const apiPassword = await getAPIKey(merchantId, 'payment', 'finix').catch(() => null)
  if (!apiPassword) return null

  const keyRow = db
    .query<{ pos_merchant_id: string | null }, [string]>(
      `SELECT pos_merchant_id FROM api_keys
       WHERE merchant_id = ? AND key_type = 'payment' AND provider = 'finix' LIMIT 1`,
    )
    .get(merchantId)
  const parts = (keyRow?.pos_merchant_id ?? '').split(':')
  if (parts.length !== 3) return null

  const merchantRow = db
    .query<{ finix_sandbox: number }, [string]>(
      `SELECT finix_sandbox FROM merchants WHERE id = ?`,
    )
    .get(merchantId)
  const sandbox = (merchantRow?.finix_sandbox ?? 1) !== 0

  const term = terminalId
    ? db.query<{ id: string; finix_device_id: string | null }, [string, string]>(
        `SELECT id, finix_device_id FROM terminals WHERE id = ? AND merchant_id = ?`,
      ).get(terminalId, merchantId)
    : db.query<{ id: string; finix_device_id: string | null }, [string]>(
        `SELECT id, finix_device_id FROM terminals
         WHERE merchant_id = ? AND finix_device_id IS NOT NULL LIMIT 1`,
      ).get(merchantId)
  if (!term?.finix_device_id) return null

  return {
    creds: {
      apiUsername:   parts[0],
      applicationId: parts[1],
      merchantId:    parts[2],
      apiPassword,
      sandbox,
    },
    terminalId:    term.id,
    finixDeviceId: term.finix_device_id,
  }
}

/** Returns the active ttx_* row ID for a terminal's in-flight transaction. */
export function getActiveTtxId(terminalId: string): string | undefined {
  return _ttxIds.get(terminalId)
}

/**
 * Pre-sets the ttxId for a terminal so the next `dehydrateTerminalTx` call uses
 * this ID instead of generating a fresh one. Used by the dashboard entry point
 * to keep the row ID returned to the client in sync with the workflow's
 * persisted row, avoiding a race between the synchronous return and the SAM
 * dispatch's asynchronous reactor pipeline.
 */
export function setActiveTtxId(terminalId: string, ttxId: string): void {
  _ttxIds.set(terminalId, ttxId)
}

/**
 * Starts a card-present sale on the given terminal and returns immediately,
 * before Finix responds. The caller receives a `ttxId` which is used to poll
 * `GET /terminal-sale/by-ttx/:ttxId` for the outcome.
 *
 * Flow:
 *   1. Load creds and resolve the terminal.
 *   2. Generate a timestamp-suffixed idempotency key (fresh for every call —
 *      the workflow's _initiating Set + FSM guard prevent double-dispatch).
 *   3. Create or reuse the workflow; auto-reset if the previous txn was
 *      COMPLETED/DECLINED/CANCELLED so a fresh INITIATE_PAYMENT is accepted.
 *   4. Dispatch INITIATE_PAYMENT. The Finix call runs in a detached promise;
 *      the FSM polls for state via getTerminalTransferStatus every 2 s.
 *   5. Read the ttxId (generated synchronously by the dehydrate reactor).
 *
 * Returns synchronously as soon as steps 1-5 complete (<100 ms). `recordLocally`
 * defaults to `false` for this entry point — the client's /record-payment call
 * writes the payment row after signature/receipt screens.
 */
export async function startTerminalPaymentForDashboard(params: {
  merchantId:       string
  orderId:          string
  amountCents:      number
  terminalId?:      string
  splitMode?:       string | null
  splitLegNumber?:  number | null
  splitTotalLegs?:  number | null
  splitItemsJson?:  string | null
  recordLocally?:   boolean
  onResult?:        (orderId: string, result: TerminalPaymentStatus) => void
}): Promise<
  | { ok: true; ttxId: string; idempotencyKey: string; deviceId: string; terminalId: string }
  | { ok: false; error: string; statusCode: number; activeTtxId?: string }
> {
  const setup = await loadFinixCredsForTerminal(params.merchantId, params.terminalId)
  if (!setup) {
    return { ok: false, error: 'Finix credentials or terminal device ID not configured', statusCode: 400 }
  }

  // Verification-pending guard: if a previous terminal-sale for this order timed
  // out on the Finix API and is awaiting orphan-sweep resolution, refuse a new
  // attempt. Without this, staff could re-tap and double-charge the customer
  // (the exact incident mode from 2026-04-19 on order 1e1b277e).
  const db = getDatabase()
  const pending = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM pending_terminal_sales
        WHERE merchant_id = ? AND order_id = ? AND status = 'pending'
        LIMIT 1`,
    )
    .get(params.merchantId, params.orderId)
  if (pending) {
    return {
      ok: false,
      error: 'Payment verification is in progress for this order — the processor outcome is being confirmed. Please wait a moment and refresh.',
      statusCode: 409,
    }
  }

  // Timestamp-suffixed to force a fresh Finix transfer on every call. Double-tap
  // protection comes from the _initiating Set + FSM INITIATE_PAYMENT guard (not
  // from idempotency key collision), so we do not need a deterministic key here.
  const legSuffix = params.splitLegNumber != null ? `-leg${params.splitLegNumber}` : ''
  const idempotencyKey = `${params.orderId}-terminal-${setup.finixDeviceId}${legSuffix}-${Date.now()}`

  let handle = _registry.get(setup.terminalId)
  if (!handle) {
    handle = createTerminalPaymentWorkflow(
      setup.terminalId,
      params.merchantId,
      setup.finixDeviceId,
      setup.creds,
      params.onResult ?? (() => { /* dashboard uses SSE broadcast + client polling */ }),
      undefined,
      { recordLocally: params.recordLocally ?? false },
    )
    _registry.set(setup.terminalId, handle)
    _entryAt.set(setup.terminalId, Date.now())
  }

  if (_initiating.has(setup.terminalId)) {
    return { ok: false, error: 'Payment initiation already in progress for this terminal', statusCode: 409 }
  }

  // If the previous transaction reached a terminal state, reset to IDLE first so
  // INITIATE_PAYMENT is accepted (FSM only allows INITIATE_PAYMENT from IDLE).
  // COMPLETED is treated the same as DECLINED/CANCELLED — exitFlow() resets to IDLE
  // for the next leg. Double-charge protection comes from the _initiating Set and the
  // pending_terminal_sales guard above, not from blocking COMPLETED here.
  const currentTxState = handle.getStatus().txState
  if (currentTxState === 'COMPLETED' || currentTxState === 'DECLINED' || currentTxState === 'CANCELLED') {
    handle.exitFlow()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  } else if (currentTxState !== 'IDLE') {
    return {
      ok: false,
      error: `Terminal is busy (${currentTxState}) — cancel the current transaction first`,
      statusCode: 409,
      activeTtxId: getActiveTtxId(setup.terminalId),
    }
  }

  // Pre-generate the ttxId BEFORE dispatching. The SAM dispatch is asynchronous
  // (queued to the next event-loop tick), so reading `_ttxIds` immediately after
  // `handle.startPayment(...)` returns would race with the dehydrate reactor.
  // We:
  //   1. Synchronously INSERT the initial row so the client's first poll of
  //      /terminal-sale/by-ttx/:ttxId finds something even if the dispatch
  //      hasn't run yet (a few ms window).
  //   2. Pre-set _ttxIds[terminalId] so the dispatch's dehydrate reactor uses
  //      this same ID (UPSERT) rather than generating a fresh one.
  const ttxId = `ttx_${randomBytes(8).toString('hex')}`
  const now   = new Date().toISOString().replace('T', ' ').substring(0, 19)
  try {
    db.run(
      `INSERT INTO terminal_transactions (
          id, terminal_id, merchant_id, order_id,
          tx_state, amount_cents, idempotency_key,
          started_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ttxId, setup.terminalId, params.merchantId, params.orderId,
        'INITIATING', params.amountCents, idempotencyKey,
        now, now, now,
      ],
    )
  } catch (err) {
    console.error('[startTerminalPaymentForDashboard] Failed to insert initial ttx row:', err)
    return { ok: false, error: 'Failed to create terminal transaction record', statusCode: 500 }
  }
  setActiveTtxId(setup.terminalId, ttxId)

  _initiating.add(setup.terminalId)
  try {
    _orderToTerminal.set(params.orderId, setup.terminalId)
    handle.startPayment(params.orderId, params.amountCents, idempotencyKey, {
      splitMode:      params.splitMode      ?? null,
      splitLegNumber: params.splitLegNumber ?? null,
      splitTotalLegs: params.splitTotalLegs ?? null,
      splitItemsJson: params.splitItemsJson ?? null,
    })
  } finally {
    _initiating.delete(setup.terminalId)
  }

  return {
    ok:             true,
    ttxId,
    idempotencyKey,
    deviceId:       setup.finixDeviceId,
    terminalId:     setup.terminalId,
  }
}

/**
 * Cancels an in-progress dashboard-initiated payment by orderId.
 * Returns true if a workflow was routed; false if no active workflow found.
 */
export function cancelTerminalPaymentByOrder(orderId: string): boolean {
  const terminalId = _orderToTerminal.get(orderId)
  if (!terminalId) return false
  const handle = _registry.get(terminalId)
  if (!handle) return false
  handle.cancelPayment()
  return true
}

/**
 * Invoked by the reconcile orphan sweep when it finds a pending_terminal_sales
 * row with `transfer_id IS NULL` and resolves it by querying Finix with the
 * row's `idempotency_key`. Dispatches the outcome to the workflow so the FSM
 * leaves AWAITING_VERIFICATION and clients polling on ttxId see the final state.
 *
 * Returns false when no active workflow is found for the order (e.g. the
 * appliance restarted and the workflow hasn't been rehydrated yet). The sweep
 * can still write the recovery directly to the DB in that case.
 */
export function resolveTerminalVerificationForOrder(
  orderId: string,
  outcome: VerificationOutcome,
): boolean {
  const terminalId = _orderToTerminal.get(orderId)
  if (!terminalId) return false
  const handle = _registry.get(terminalId)
  if (!handle) return false
  handle.resolveVerification(outcome)
  return true
}

/**
 * Maps a Finix decline_code into the dashboard-facing outcome vocabulary.
 *
 * The `retryable` flag is authoritative here — clients should never re-derive
 * it from the code string. Card-side hard declines (insufficient funds, lost
 * card, bad PIN, etc.) and explicit device cancels are non-retryable; generic
 * bad reads, technical errors, and API-initiated timeouts are retryable.
 *
 * Status split within DECLINED tx rows:
 *   - cancel code → 'cancelled' (staff-initiated API cancel, customer pressed cancel)
 *   - infra code  → 'error'     (initiation failed, pre-card-read failure)
 *   - card code   → 'declined'  (issuer rejection)
 */
type FinixDeclineOutcome = {
  status:    Extract<TerminalOutcome['status'], 'declined' | 'cancelled' | 'error'>
  reason:    TerminalOutcomeReason
  retryable: boolean
}
function finixDeclineCodeToOutcome(code: string | null): FinixDeclineOutcome {
  switch (code) {
    case 'CANCELLATION_VIA_API':
      return { status: 'cancelled', reason: 'cancelled_by_staff',    retryable: true  }
    case 'CANCELLATION_VIA_DEVICE':
      return { status: 'cancelled', reason: 'cancelled_by_customer', retryable: false }

    case 'INITIATION_FAILED':
    case 'IMMEDIATE_FAILURE':
      return { status: 'error',     reason: 'initiation_failed',     retryable: true  }

    case 'INSUFFICIENT_FUNDS':
      return { status: 'declined',  reason: 'insufficient_funds',    retryable: false }
    case 'DO_NOT_HONOR':
      return { status: 'declined',  reason: 'do_not_honor',          retryable: false }
    case 'DECLINED':
      return { status: 'declined',  reason: 'card_declined',         retryable: false }
    case 'CARD_NOT_SUPPORTED':
      return { status: 'declined',  reason: 'card_not_supported',    retryable: false }
    case 'LOST_CARD':
      return { status: 'declined',  reason: 'lost_card',             retryable: false }
    case 'STOLEN_CARD':
      return { status: 'declined',  reason: 'stolen_card',           retryable: false }
    case 'RESTRICTED_CARD':
      return { status: 'declined',  reason: 'restricted_card',       retryable: false }
    case 'INVALID_CARD':
      return { status: 'declined',  reason: 'invalid_card',          retryable: false }
    case 'EXPIRED_CARD':
      return { status: 'declined',  reason: 'expired_card',          retryable: false }
    case 'SECURITY_VIOLATION':
      return { status: 'declined',  reason: 'security_violation',    retryable: false }
    case 'EXCEEDS_WITHDRAWAL_LIMIT':
      return { status: 'declined',  reason: 'exceeds_withdrawal_limit', retryable: false }
    case 'INVALID_PIN':
      return { status: 'declined',  reason: 'invalid_pin',           retryable: false }
    case 'PIN_TRIES_EXCEEDED':
      return { status: 'declined',  reason: 'pin_tries_exceeded',    retryable: false }

    // Null or unknown code — generic retryable bad read
    default:
      return { status: 'declined',  reason: 'unknown',               retryable: true  }
  }
}

/**
 * Returns the dashboard-facing terminal outcome for a ttx row.
 *
 * This is the server boundary for `/terminal-sale/by-ttx/:ttxId`. Every Finix
 * detail (SUCCEEDED/FAILED, decline_code, decline_message) is folded into the
 * four-status vocabulary + semantic reason; clients only branch on `status`
 * and `reason`, never on processor-specific strings.
 */
export function getTerminalTxStatus(merchantId: string, ttxId: string): TerminalOutcome | null {
  const db = getDatabase()
  const row = db
    .query<{
      tx_state:              string
      amount_cents:          number | null
      approved_amount_cents: number | null
      finix_transfer_id:     string | null
      card_brand:            string | null
      card_last_four:        string | null
      approval_code:         string | null
      entry_mode:            string | null
      tip_amount_cents:      number | null
      decline_code:          string | null
      decline_message:       string | null
      payment_id:            string | null
      split_leg_number:      number | null
      split_total_legs:      number | null
      order_status:          string | null
    }, [string, string]>(
      `SELECT ttx.tx_state, ttx.amount_cents, ttx.approved_amount_cents, ttx.finix_transfer_id,
              ttx.card_brand, ttx.card_last_four, ttx.approval_code, ttx.entry_mode,
              ttx.tip_amount_cents, ttx.decline_code, ttx.decline_message,
              p.id AS payment_id, p.split_leg_number, p.split_total_legs,
              o.status AS order_status
         FROM terminal_transactions ttx
         LEFT JOIN payments p
           ON ttx.finix_transfer_id IS NOT NULL
          AND p.finix_transfer_id = ttx.finix_transfer_id
         LEFT JOIN orders o ON o.id = ttx.order_id
        WHERE ttx.id = ? AND ttx.merchant_id = ?`,
    )
    .get(ttxId, merchantId)

  if (!row) return null

  const amountSent = row.amount_cents          ?? 0
  const tipCents   = row.tip_amount_cents      ?? 0
  const approved   = row.approved_amount_cents ?? (amountSent + tipCents)

  // Pending states
  switch (row.tx_state) {
    case 'INITIATING':
    case 'AWAITING_TAP':
    case 'AWAITING_VERIFICATION':
    case 'CANCELLING':
      return {
        status:      'waiting',
        transferId:  row.finix_transfer_id,
      }
    case 'RECORDING':
    case 'COMPLETED':
      return {
        status:         'approved',
        transferId:     row.finix_transfer_id,
        amountCents:    approved,
        tipAmountCents: tipCents,
        cardBrand:      row.card_brand,
        cardLastFour:   row.card_last_four,
        approvalCode:   row.approval_code,
        entryMode:      row.entry_mode,
        // Present when the payment row has already been recorded server-side
        // (normal completion path). The client uses these to skip /record-payment.
        // isLastLeg is derived from order.status — recordTerminalPayment marks
        // the order paid only on the actually-final leg (by_items completion is
        // determined by cumulative item coverage, not splitTotalLegs which is
        // null for by_items).
        ...(row.payment_id ? {
          paymentId:  row.payment_id,
          isLastLeg:  row.order_status === 'paid',
        } : {}),
      }
    case 'CANCELLED':
      // Workflow-driven cancel — the `decline_code` column is not populated on
      // this path, so staff/timeout/customer can't be distinguished at query
      // time. `reason` is therefore omitted; dashboards should fall back to
      // the generic `message`. 3 s cooldown matches the CANCELLATION_VIA_API
      // path so staff can't smash-retry after an explicit cancel.
      return {
        status:       'cancelled',
        retryable:    true,
        retryDelayMs: 3000,
        message:      row.decline_message ?? 'Payment cancelled',
      }
    case 'DECLINED': {
      const { status, reason, retryable } = finixDeclineCodeToOutcome(row.decline_code)
      return {
        status,
        reason,
        retryable,
        retryDelayMs: reason === 'cancelled_by_staff' ? 3000 : 0,
        message:      row.decline_message ?? row.decline_code ?? 'Payment failed on terminal',
      }
    }
    default:
      return {
        status:  'error',
        reason:  'unknown',
        message: `Unknown terminal state: ${row.tx_state}`,
      }
  }
}
