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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TerminalTxState =
  | 'IDLE'
  | 'INITIATING'
  | 'AWAITING_TAP'
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

  // Success fields (populated in RECORDING/COMPLETED)
  cardBrand:      string | null
  cardLastFour:   string | null
  approvalCode:   string | null
  paymentId:      string | null   // DB payments.id

  // Failure fields (DECLINED/CANCELLED)
  declineCode:    string | null
  declineMessage: string | null
}

/** Public handle returned by createTerminalPaymentWorkflow */
export interface TerminalPaymentWorkflowHandle {
  /** Dispatch INITIATE_PAYMENT — starts a new card-present transaction */
  startPayment: (orderId: string, amountCents: number) => void
  /** Dispatch CANCEL_PAYMENT — aborts an in-progress transaction */
  cancelPayment: () => void
  /** Dispatch EXIT_FLOW — resets machine to IDLE after terminal state */
  exitFlow: () => void
  /** Read-only snapshot of current model */
  getStatus: () => TerminalPaymentModel
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
    INITIATE_PAYMENT:  ['INITIATING'],
    TRANSFER_CREATED:  ['AWAITING_TAP'],
    TAP_APPROVED:      ['RECORDING'],
    TAP_DECLINED:      ['DECLINED'],
    CANCEL_DECLINED:   ['CANCELLED'],
    PAYMENT_RECORDED:  ['COMPLETED'],
    CANCEL_PAYMENT:    ['CANCELLING'],
    CANCEL_CONFIRMED:  ['CANCELLED'],
    EXIT_FLOW:         ['IDLE'],
  },
  states: {
    IDLE:         { transitions: ['INITIATE_PAYMENT'],                                             naps: [] },
    INITIATING:   { transitions: ['TRANSFER_CREATED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],           naps: [] },
    AWAITING_TAP: { transitions: ['TAP_APPROVED', 'TAP_DECLINED', 'CANCEL_PAYMENT'],               naps: [] },
    PROCESSING:   { transitions: [],                                                               naps: [] },
    RECORDING:    { transitions: ['PAYMENT_RECORDED'],                                             naps: [] },
    COMPLETED:    { transitions: ['EXIT_FLOW'],                                                    naps: [] },
    DECLINED:     { transitions: ['EXIT_FLOW'],                                                    naps: [] },
    CANCELLING:   { transitions: ['CANCEL_CONFIRMED', 'TAP_APPROVED', 'CANCEL_DECLINED'],          naps: [] },
    CANCELLED:    { transitions: ['EXIT_FLOW'],                                                    naps: [] },
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
): TerminalPaymentWorkflowHandle {

  const instance = createInstance({ instanceName: `terminal:${terminalId}` })

  // ── Mutable intent references ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _initiatePayment: ((data: { orderId: string; amountCents: number; idempotencyKey?: string; startedAt?: string }) => void) | undefined
  let _transferCreated: ((data: { transferId: string }) => void) | undefined
  let _tapApproved:     ((data: { approvedAmount: number; cardBrand: string | null; cardLastFour: string | null; approvalCode: string | null }) => void) | undefined
  let _tapDeclined:     ((data: { declineCode: string | null; declineMessage: string | null }) => void) | undefined
  let _cancelDeclined:  (() => void) | undefined
  let _paymentRecorded: ((data: { paymentId: string | null }) => void) | undefined
  let _cancelPayment:   (() => void) | undefined
  let _cancelConfirmed: (() => void) | undefined
  let _exitFlow:        (() => void) | undefined

  // ── Transient NAP state (not persisted — resets cleanly on rehydration) ────
  let _pollTimer:           ReturnType<typeof setInterval> | null = null
  let _createSaleInFlight = false
  let _cancelInFlight     = false
  let _recordingInFlight  = false
  // Set during rehydration fast-forward to prevent createSale NAP from firing
  // while replaying INITIATE_PAYMENT + TRANSFER_CREATED to advance the FSM.
  let _rehydrating        = false

  // ── Snapshot of the last rendered model (sam-pattern has no getState()) ───
  let _lastModel: TerminalPaymentModel = {
    terminalId, merchantId, finixDeviceId,
    txState:        (initialModel?.txState ?? 'IDLE') as TerminalTxState,
    orderId:        initialModel?.orderId        ?? null,
    amountCents:    initialModel?.amountCents    ?? null,
    transferId:     initialModel?.transferId     ?? null,
    idempotencyKey: initialModel?.idempotencyKey ?? null,
    startedAt:      initialModel?.startedAt      ?? null,
    cardBrand:      initialModel?.cardBrand      ?? null,
    cardLastFour:   initialModel?.cardLastFour   ?? null,
    approvalCode:   initialModel?.approvalCode   ?? null,
    paymentId:      initialModel?.paymentId      ?? null,
    declineCode:    initialModel?.declineCode    ?? null,
    declineMessage: initialModel?.declineMessage ?? null,
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
        _tapApproved?.({
          approvedAmount: status.amount,
          cardBrand:      status.cardBrand,
          cardLastFour:   status.cardLastFour,
          approvalCode:   status.approvalCode,
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
  async function runCreateSale(orderId: string, amountCents: number, idempotencyKey: string): Promise<void> {
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
        console.warn(`[terminal-payment] ${terminalId} createTerminalSale returned immediate SUCCEEDED`)
        setTimeout(() => _tapApproved?.({
          approvedAmount: amountCents,
          cardBrand:      null,
          cardLastFour:   null,
          approvalCode:   null,
        }), 0)
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
    } catch (err) {
      // On network-level errors (not Finix-rejected), the terminal may still have
      // an active PENDING transfer we don't know about. Send a best-effort CANCEL to
      // return the device to idle. If the cancel response shows SUCCEEDED, the customer
      // tapped before our cancel reached the device — honour the charge.
      if (!(err instanceof FinixTransferCancelledError)) {
        try {
          console.warn(`[terminal-payment] ${terminalId} createTerminalSale threw — sending best-effort cancel to clear device`)
          const cancelResult = await cancelTerminalSale(creds, finixDeviceId)
          if (cancelResult.state === 'SUCCEEDED') {
            console.warn(`[terminal-payment] ${terminalId} cancel confirmed SUCCEEDED — customer tapped during network error window, recording charge`)
            // Must advance INITIATING→AWAITING_TAP first (setting transferId) before
            // TAP_APPROVED — the FSM only allows TAP_APPROVED from AWAITING_TAP.
            // Two consecutive setTimeout(0) fire in order; the 2s poll interval won't
            // fire between them.
            const tid = cancelResult.transferId
            if (tid) setTimeout(() => _transferCreated?.({ transferId: tid }), 0)
            setTimeout(() => _tapApproved?.({
              approvedAmount: cancelResult.amount,
              cardBrand:      cancelResult.cardBrand,
              cardLastFour:   cancelResult.cardLastFour,
              approvalCode:   cancelResult.approvalCode,
            }), 0)
            return
          }
          // FAILED/CANCELED/UNKNOWN — device is now idle; fall through to decline
        } catch (cancelErr) {
          // Cancel also failed: device offline, no active transaction, etc.
          // Fall through to decline — the terminal is either already idle or unreachable.
          console.warn(`[terminal-payment] ${terminalId} best-effort cancel also failed:`, (cancelErr as Error).message ?? cancelErr)
        }
      }

      let declineCode = 'INITIATION_FAILED'
      let declineMessage = (err instanceof Error ? err.message : String(err))
      if (err instanceof FinixTransferCancelledError) {
        declineCode = err.failureCode ?? 'CANCELLATION_VIA_API'
        declineMessage = err.message
      }
      setTimeout(() => _tapDeclined?.({ declineCode, declineMessage }), 0)
    }
  }

  // ── Component actions ─────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const componentActions: [string, (...args: any[]) => unknown][] = [
    ['INITIATE_PAYMENT', (data: { orderId: string; amountCents: number; idempotencyKey?: string; startedAt?: string }) => {
      // Side effect (createTerminalSale) fires from the createSale NAP after the
      // model transitions to INITIATING, ensuring the FSM can reject duplicate calls
      // from non-IDLE states before any Finix API call is made.
      // idempotencyKey and startedAt are optional — passed during rehydration to
      // preserve the original values rather than generating fresh ones.
      return {
        orderId:        data.orderId,
        amountCents:    data.amountCents,
        idempotencyKey: data.idempotencyKey ?? crypto.randomUUID(),
        startedAt:      data.startedAt ?? new Date().toISOString(),
        transferId:     null,
        cardBrand:      null,
        cardLastFour:   null,
        approvalCode:   null,
        paymentId:      null,
        declineCode:    null,
        declineMessage: null,
      }
    }],
    ['TRANSFER_CREATED',  (data: { transferId: string }) => ({ transferId: data.transferId })],
    ['TAP_APPROVED',      (data: { approvedAmount: number; cardBrand: string | null; cardLastFour: string | null; approvalCode: string | null }) => ({
      approvedAmount: data.approvedAmount,
      cardBrand:      data.cardBrand,
      cardLastFour:   data.cardLastFour,
      approvalCode:   data.approvalCode,
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
      orderId:        null,
      amountCents:    null,
      transferId:     null,
      idempotencyKey: null,
      startedAt:      null,
      cardBrand:      null,
      cardLastFour:   null,
      approvalCode:   null,
      paymentId:      null,
      declineCode:    null,
      declineMessage: null,
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

          if (
            action === 'TAP_APPROVED' &&
            model.txState === 'AWAITING_TAP' &&
            typeof proposal.approvedAmount === 'number' &&
            proposal.approvedAmount !== model.amountCents
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
            model.orderId        = proposal.orderId        as string
            model.amountCents    = proposal.amountCents    as number
            model.idempotencyKey = proposal.idempotencyKey as string
            model.startedAt      = proposal.startedAt      as string
            model.transferId     = null
            model.cardBrand      = null
            model.cardLastFour   = null
            model.approvalCode   = null
            model.paymentId      = null
            model.declineCode    = null
            model.declineMessage = null
          }

          if (action === 'TRANSFER_CREATED' && model.txState === 'AWAITING_TAP') {
            model.transferId = proposal.transferId as string
          }

          if (action === 'TAP_APPROVED' && model.txState === 'RECORDING') {
            model.cardBrand    = (proposal.cardBrand    as string | null) ?? null
            model.cardLastFour = (proposal.cardLastFour as string | null) ?? null
            model.approvalCode = (proposal.approvalCode as string | null) ?? null
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
            model.orderId        = null
            model.amountCents    = null
            model.transferId     = null
            model.idempotencyKey = null
            model.startedAt      = null
            model.cardBrand      = null
            model.cardLastFour   = null
            model.approvalCode   = null
            model.paymentId      = null
            model.declineCode    = null
            model.declineMessage = null
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
        (model: TerminalPaymentModel) => () => {
          if (model.txState === 'CANCELLING' && !_cancelInFlight) {
            _cancelInFlight = true
            cancelTerminalSale(creds, finixDeviceId)
              .then((result) => {
                if (result.state === 'SUCCEEDED') {
                  console.warn(`[terminal-payment] ${terminalId} cancel returned SUCCEEDED — customer tapped first, recording charge`)
                  _tapApproved?.({
                    approvedAmount: result.amount,
                    cardBrand:      result.cardBrand,
                    cardLastFour:   result.cardLastFour,
                    approvalCode:   result.approvalCode,
                  })
                } else {
                  _cancelConfirmed?.()
                }
              })
              .catch(() => _cancelConfirmed?.())   // best-effort; device may already be idle
              .finally(() => { _cancelInFlight = false })
          }
          return false
        },

        // ── Record NAP: insert payments row + update order once in RECORDING ─
        (model: TerminalPaymentModel) => () => {
          if (model.txState === 'RECORDING' && !_recordingInFlight) {
            _recordingInFlight = true
            recordTerminalPayment(merchantId, model)
              .then((paymentId) => _paymentRecorded?.({ paymentId }))
              .catch((err) => {
                // DB write failed — log but still move to COMPLETED to avoid re-charging
                console.error('[terminal-payment] DB record failed:', err)
                _paymentRecorded?.({ paymentId: null })
              })
              .finally(() => { _recordingInFlight = false })
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
        case 'DECLINED':
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
          break
        case 'CANCELLED':
          logPaymentEvent('terminal_cancelled', {
            merchantId: state.merchantId,
            orderId,
            transferId:  state.transferId ?? undefined,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            message:     'Terminal payment cancelled',
          })
          break
        case 'COMPLETED':
          logPaymentEvent('terminal_succeeded', {
            merchantId: state.merchantId,
            orderId,
            transferId:  state.transferId ?? undefined,
            paymentId:   state.paymentId  ?? undefined,
            deviceId:    state.finixDeviceId,
            amountCents: state.amountCents ?? undefined,
            message:     'Payment recorded successfully',
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
        case 'RECORDING':
        case 'CANCELLING':
          result = { status: 'waiting' }
          break
        default:
          break
      }

      if (result) {
        onResult(orderId, result)
        // Broadcast SSE terminal payment update to merchant dashboard
        broadcastToMerchant(state.merchantId, 'terminal_payment_update', {
          orderId,
          txState: state.txState,
          ...result,
        })
        // Remove order→terminal routing entry once the result is final; cancel calls
        // are no-ops on terminal states anyway and the entry would otherwise accumulate.
        if (state.txState === 'COMPLETED' || state.txState === 'DECLINED' || state.txState === 'CANCELLED') {
          _orderToTerminal.delete(orderId)
        }
      }
    },
  })

  // ── Wire intent references ─────────────────────────────────────────────────
  const intentMap = new Map<string, (...args: unknown[]) => void>(
    componentActions.map(([name], i) => [name, result.intents[i]])
  )
  _initiatePayment = intentMap.get('INITIATE_PAYMENT') as typeof _initiatePayment
  _transferCreated = intentMap.get('TRANSFER_CREATED') as typeof _transferCreated
  _tapApproved     = intentMap.get('TAP_APPROVED')     as typeof _tapApproved
  _tapDeclined     = intentMap.get('TAP_DECLINED')     as typeof _tapDeclined
  _cancelDeclined  = intentMap.get('CANCEL_DECLINED')  as typeof _cancelDeclined
  _paymentRecorded = intentMap.get('PAYMENT_RECORDED') as typeof _paymentRecorded
  _cancelPayment   = intentMap.get('CANCEL_PAYMENT')   as typeof _cancelPayment
  _cancelConfirmed = intentMap.get('CANCEL_CONFIRMED') as typeof _cancelConfirmed
  _exitFlow        = intentMap.get('EXIT_FLOW')        as typeof _exitFlow

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
    startPayment: (orderId: string, amountCents: number) => {
      _orderToTerminal.set(orderId, terminalId)
      _initiatePayment?.({ orderId, amountCents })
    },
    cancelPayment: () => {
      _cancelPayment?.()
    },
    exitFlow: () => {
      _exitFlow?.()
    },
    getStatus: () => ({ ..._lastModel }),
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
      if (persistedModel.orderId) {
        _orderToTerminal.set(persistedModel.orderId, row.terminal_id)
      }
      count++
    } catch (err) {
      console.error(`[terminal-payment] Failed to rehydrate terminal ${row.terminal_id}:`, err)
    }
  }

  console.log(`✅ Rehydrated ${count} active terminal workflow(s)`)
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Records a successful server-initiated terminal payment.
 * Inserts into `payments`, updates `orders` status to 'paid'.
 * Returns the new paymentId or null if the order is already paid.
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
    console.warn(`[terminal-payment] order ${orderId} already ${order.status} — idempotent skip`)
    return null
  }

  const paymentId = `pay_${randomBytes(16).toString('hex')}`
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
  const totalCents = model.amountCents!
  const tipCents = Math.max(0, totalCents - order.subtotal_cents - order.tax_cents)

  try {
    db.exec('BEGIN')

    db.run(
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
                 ?, 'finix_terminal', ?, ?, null, null, null, null, null, null, null, ?, ?)`,
      [
        paymentId, orderId, merchantId, totalCents,
        order.subtotal_cents, order.tax_cents, tipCents,
        model.cardBrand ?? null,
        model.cardLastFour ?? null,
        model.transferId ?? null,
        model.approvalCode ?? null,
        model.transferId ?? null,
        now, now,
      ],
    )

    db.run(
      `UPDATE orders
       SET status = 'paid', tip_cents = ?, paid_amount_cents = ?,
           payment_method = 'card', updated_at = ?
       WHERE id = ?`,
      [tipCents, totalCents, now, orderId],
    )

    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }

  scheduleReconciliation(merchantId, paymentId, 'card')
  console.log(
    `[terminal-payment] ✓ payment recorded paymentId=${paymentId} ` +
    `transferId=${model.transferId} orderId=${orderId}`,
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
          card_brand, card_last_four, approval_code,
          decline_code, decline_message, payment_id,
          started_at, completed_at, sam_state,
          created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
          tx_state          = excluded.tx_state,
          finix_transfer_id = excluded.finix_transfer_id,
          card_brand        = excluded.card_brand,
          card_last_four    = excluded.card_last_four,
          approval_code     = excluded.approval_code,
          decline_code      = excluded.decline_code,
          decline_message   = excluded.decline_message,
          payment_id        = excluded.payment_id,
          completed_at      = excluded.completed_at,
          sam_state         = excluded.sam_state,
          updated_at        = excluded.updated_at`,
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
