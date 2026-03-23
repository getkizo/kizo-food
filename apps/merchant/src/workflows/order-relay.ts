/**
 * Order Relay Workflow (SAM Pattern + FSM)
 * Manages order lifecycle from placement through completion
 *
 * State Machine (FSM-managed states only):
 * received → submitted → confirmed → preparing → ready → picked_up (online)
 *            ↓                                             ↑
 *         pos_error → (retry) → submitted                 |
 *            ↓                                             |
 *         cancelled ----------------------------------------
 *
 * Dual code path — 'paid' and 'refunded' are NOT FSM states:
 *   In-person orders created via the dashboard (source='dashboard') never enter
 *   this FSM. Their lifecycle is managed entirely by direct SQL UPDATEs:
 *     • dashboard-payments.ts  sets status='paid'     (record-payment route)
 *     • dashboard-payments.ts  sets status='refunded' (refund route)
 *   These orders have sam_state=NULL and are excluded from rehydrateActiveOrders()
 *   so they are never picked up by the relay on server restart. The 'paid' and
 *   'refunded' values exist in the DB orders table but are outside this FSM's
 *   type system (see OrderStatus below).
 *
 * SAM/sam-fsm wiring notes:
 *   - sam-fsm's `stateMachineNaps` calls nextAction(state) but ignores the
 *     return value, so FSM-defined NAPs cannot dispatch intents. We wire NAPs
 *     manually inside `component.naps` using post-init intent references.
 *   - sam-pattern only reads `naps` from inside `component` — top-level `naps`
 *     in the instance({}) call are silently ignored.
 *   - The `transitions` option must be an object (not an array) when `states`
 *     is omitted, so sam-fsm can call flattenTransitions() and auto-compute
 *     state specs with `.transitions` arrays needed by enforceAllowedTransitions.
 *   - SUBMIT_TO_POS and RETRY both schedule a separate POS_CONFIRMED / POS_ERROR
 *     dispatch via setTimeout(0) so the FSM can process it as a distinct action
 *     AFTER the received→submitted (or pos_error→submitted) transition completes.
 */

import { fsm } from 'sam-fsm'
import SAMPattern from 'sam-pattern'
const { createInstance } = SAMPattern
import type { POSAdapter, POSOrderData } from '../adapters/types'
import { getDatabase } from '../db/connection'
import { generatePickupCode } from '../utils/id'
import { broadcastToMerchant } from '../services/sse'

/**
 * Order state model
 */
interface OrderModel {
  orderId: string
  merchantId: string
  status: OrderStatus
  order: POSOrderData
  posOrderId: string | null
  posProvider: string | null
  pickupCode: string | null
  retryCount: number
  posError: string | null
  estimatedMinutes: number | null
}

/**
 * Valid SAM FSM states for the order relay workflow.
 *
 * Note: 'paid' and 'refunded' intentionally omitted — they are written
 * directly to the DB by dashboard-payments.ts (record-payment / refund routes)
 * and never flow through this FSM. See the dual code path note in the file
 * header for the full explanation.
 */
export type OrderStatus =
  | 'received'
  | 'submitted'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'picked_up'
  | 'completed'   // legacy — kept for backward compat with historical orders
  | 'cancelled'
  | 'pos_error'

/**
 * FSM for order status transitions.
 *
 * We supply explicit `actions` and `states` so that all three internal
 * sam-fsm functions (stateMachineAcceptors, stateMachineReactor,
 * stateMachineNaps) have the data they need:
 *
 *   • stateMachineAcceptors uses `actions` for stateForAction() and `states`
 *     for the per-state allowed-transition check (enforceAllowedTransitions).
 *   • stateMachineReactor uses `states` for the same check.
 *   • stateMachineNaps receives no `transitions` arg from fsm() — it only
 *     gets `states`. With `states.*.naps = []` no FSM NAPs are generated;
 *     we register NAPs manually in `component.naps` instead.
 */
const orderRelayFSM = fsm({
  pc:  'status',
  pc0: 'received',
  // Explicit action → [nextState] map consumed by stateMachineAcceptors
  actions: {
    SUBMIT_TO_POS:  ['submitted'],
    POS_CONFIRMED:  ['confirmed'],
    POS_ERROR:      ['pos_error'],
    RETRY:          ['submitted'],
    CANCEL:         ['cancelled'],
    MARK_PREPARING:  ['preparing'],
    MARK_READY:      ['ready'],
    MARK_PICKED_UP:  ['picked_up'],
  },
  // Explicit per-state specs with allowed-action arrays and empty nap lists
  states: {
    received:  { transitions: ['SUBMIT_TO_POS', 'CANCEL'],     naps: [] },
    submitted: { transitions: ['POS_CONFIRMED', 'POS_ERROR'],  naps: [] },
    pos_error: { transitions: ['RETRY', 'CANCEL'],             naps: [] },
    confirmed: { transitions: ['MARK_PREPARING', 'CANCEL'],    naps: [] },
    preparing: { transitions: ['MARK_READY'],                   naps: [] },
    ready:     { transitions: ['MARK_PICKED_UP'],               naps: [] },
    cancelled: { transitions: [],                               naps: [] },
    picked_up: { transitions: [],                               naps: [] },
    completed: { transitions: [],                               naps: [] }, // legacy terminal
  },
  deterministic:             true,
  enforceAllowedTransitions: true,
})

/**
 * Creates a SAM order workflow instance
 */
export function createOrderWorkflow(
  orderId: string,
  orderData: POSOrderData,
  posAdapter: POSAdapter,
  merchantId: string,
  initialModel?: Partial<OrderModel>
) {
  const instance = createInstance({ instanceName: `order:${orderId}` })

  // ---------------------------------------------------------------------------
  // Mutable intent references — wired up after instance init (chicken-and-egg)
  // ---------------------------------------------------------------------------
  let _submitToPOS:  ((orderId: string) => void) | undefined
  let _retry:        ((orderId: string) => void) | undefined
  let _cancel:       ((orderId: string) => void) | undefined
  let _posConfirmed: ((data: { posOrderId?: string | null; estimatedMinutes?: number | null }) => void) | undefined
  let _posError:     ((data: { posError: string; errorCode?: string }) => void) | undefined

  // Shared POS call — used by both SUBMIT_TO_POS and RETRY.
  // Schedules the POS_CONFIRMED / POS_ERROR dispatch via setTimeout(0) so it
  // fires AFTER the current action's own proposal (received→submitted or
  // pos_error→submitted) has already been accepted by the FSM.
  async function runPOSCall(): Promise<Record<string, unknown>> {
    try {
      const result = await posAdapter.submitOrder(orderData)
      if (result.success) {
        setTimeout(
          () => _posConfirmed?.({ posOrderId: result.posOrderId, estimatedMinutes: result.estimatedMinutes }),
          0
        )
      } else {
        setTimeout(
          () => _posError?.({ posError: result.error || 'Unknown POS error', errorCode: result.errorCode }),
          0
        )
      }
    } catch (err) {
      setTimeout(
        () => _posError?.({ posError: err instanceof Error ? err.message : 'Unknown error' }),
        0
      )
    }
    // Return an empty proposal — the FSM uses __actionName (SUBMIT_TO_POS or
    // RETRY) for the transition; the POS result arrives as a separate dispatch.
    return {}
  }

  // Actions extracted to a named constant so that intent references below can be
  // looked up by name rather than by numeric index. Reordering this array
  // automatically adjusts the name→intent mapping — there is no separate index
  // list to keep in sync.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const componentActions: [string, (...args: any[]) => unknown][] = [
    ['SUBMIT_TO_POS',  async (_orderId: string) => runPOSCall()],
    ['RETRY',          async (_orderId: string) => runPOSCall()],
    ['MARK_PREPARING', (_orderId: string) => ({})],
    ['MARK_READY',     (_orderId: string) => ({})],
    ['MARK_PICKED_UP', (_orderId: string) => ({})],
    ['CANCEL',         (_orderId: string) => ({})],
    ['POS_CONFIRMED',  (data: { posOrderId?: string | null; estimatedMinutes?: number | null }) => ({
      posOrderId:       data?.posOrderId       ?? null,
      estimatedMinutes: data?.estimatedMinutes ?? null,
    })],
    ['POS_ERROR',      (data: { posError: string; errorCode?: string }) => ({
      posError:  data?.posError ?? 'Unknown error',
      errorCode: data?.errorCode,
    })],
  ]

  const result = instance({
    /**
     * SAM reserved field names — NEVER use as application state keys:
     *   error, hasError, errorMessage, clearError, state, update, flush,
     *   clone, continue, hasNext, allow, log
     *
     * These names collide with Model methods. Model.update() does
     * Object.assign(this, state), so any matching field overwrites the method
     * reference, silently breaking the SAM instance.
     *
     * NOTE: `posError` replaces the previously-used `error` field.
     * The migration guard in rehydrateActiveOrders() handles persisted rows
     * written before the rename and must remain in place permanently.
     */
    initialState: orderRelayFSM.initialState({
      orderId,
      merchantId,
      status: 'received' as OrderStatus,
      order: orderData,
      posOrderId: null,
      posProvider: posAdapter.posType,
      pickupCode: null,
      retryCount: 0,
      posError: null,       // ← was `error`; renamed to avoid SAM Model collision
      estimatedMinutes: null,
      ...initialModel,
    }),
    component: {
      actions: componentActions,

      acceptors: [
        ...orderRelayFSM.acceptors,

        // Handle POS confirmation — set result fields on model
        (model: OrderModel) => (proposal: Record<string, unknown>) => {
          if (proposal.__actionName === 'POS_CONFIRMED') {
            model.posOrderId       = (proposal.posOrderId       as string | null)  ?? null
            model.estimatedMinutes = (proposal.estimatedMinutes as number | null)  ?? null
            model.pickupCode       = generatePickupCode()
            model.posError         = null
            if (model.retryCount > 0) model.retryCount = 0
          }
        },

        // Handle POS error — record error, increment retry counter
        (model: OrderModel) => (proposal: Record<string, unknown>) => {
          if (proposal.__actionName === 'POS_ERROR') {
            model.posError   = (proposal.posError as string) || 'Unknown error'
            model.retryCount = (model.retryCount ?? 0) + 1
          }
        },
      ],

      reactors: [
        ...orderRelayFSM.stateMachine,

        // Dehydrate to database after every state change
        (model: OrderModel) => () => {
          dehydrateOrder(model)
        },

        // Log state transitions
        (model: OrderModel) => () => {
          console.log(`📊 Order ${model.orderId} → ${model.status}`, {
            posOrderId:  model.posOrderId,
            pickupCode:  model.pickupCode,
            posError:    model.posError,
          })
        },
      ],

      // NAPs must be inside `component` — top-level `naps` in instance({}) are
      // silently ignored by sam-pattern. We also avoid sam-fsm's stateMachineNaps
      // because it calls nextAction() but discards the return value (never dispatches).
      naps: [
        // pos_error: retry with exponential backoff; cancel after 3 failures.
        // delayMs uses retryCount-1 as the exponent so delays are 2s, 4s, 8s.
        (model: OrderModel) => () => {
          if (model.status === 'pos_error') {
            if (model.retryCount < 3) {
              const delayMs = Math.pow(2, Math.max(0, model.retryCount - 1)) * 2000
              setTimeout(() => _retry?.(model.orderId), delayMs)
            } else {
              _cancel?.(model.orderId)
            }
            return true  // block render until next action resolves
          }
          return false
        },
      ],

      options: {
        ignoreOutdatedProposals: true,
        retry: { delay: 2000, max: 3 },
      },
    },

    render: (state: OrderModel) => {
      // Broadcast order update to clients (SSE)
      broadcastOrderUpdate(state.orderId, {
        orderId:          state.orderId,
        status:           state.status,
        pickupCode:       state.pickupCode,
        estimatedMinutes: state.estimatedMinutes,
        posError:         state.posError,
      })
    },
  })

  // ---------------------------------------------------------------------------
  // Wire intent references — looked up by name, not by numeric index.
  // componentActions is the single source of truth for ordering; any reorder
  // there automatically adjusts this mapping.
  // ---------------------------------------------------------------------------
  const intentMap = new Map<string, (...args: unknown[]) => void>(
    componentActions.map(([name], i) => [name, result.intents[i]])
  )
  _submitToPOS  = intentMap.get('SUBMIT_TO_POS')  as typeof _submitToPOS
  _retry        = intentMap.get('RETRY')           as typeof _retry
  _cancel       = intentMap.get('CANCEL')          as typeof _cancel
  _posConfirmed = intentMap.get('POS_CONFIRMED')   as typeof _posConfirmed
  _posError     = intentMap.get('POS_ERROR')       as typeof _posError

  // ---------------------------------------------------------------------------
  // Kick off the workflow for the initial (or rehydrated) state.
  // NAPs only evaluate during state(), which only runs after present() — there
  // is no automatic initial render in sam-pattern. We trigger via setTimeout(0)
  // so the current call stack (intent wiring above) completes first.
  // ---------------------------------------------------------------------------
  const startStatus = (initialModel?.status ?? 'received') as OrderStatus
  if (startStatus === 'received') {
    setTimeout(() => _submitToPOS?.(orderId), 0)
  } else if (startStatus === 'pos_error') {
    // Rehydrated pos_error: resume retry or cancel
    const rc = (initialModel as OrderModel | undefined)?.retryCount ?? 0
    if (rc < 3) {
      const delayMs = Math.pow(2, Math.max(0, rc - 1)) * 2000
      setTimeout(() => _retry?.(orderId), delayMs)
    } else {
      setTimeout(() => _cancel?.(orderId), 0)
    }
  }

  return result
}

/**
 * Dehydrates order state to SQLite
 */
function dehydrateOrder(model: OrderModel): void {
  const db = getDatabase()

  db.run(
    `UPDATE orders
     SET status = ?,
         sam_state = ?,
         pos_order_id = ?,
         pos_provider = ?,
         pickup_code = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
    [
      model.status,
      JSON.stringify(model),
      model.posOrderId,
      model.posProvider,
      model.pickupCode,
      model.orderId,
    ]
  )
}

/**
 * Rehydrates order workflows on server restart.
 *
 * On restart, all orders in non-terminal states (i.e. not 'picked_up',
 * 'completed', or 'cancelled') are reloaded from SQLite and their SAM workflow instances are
 * recreated in memory. The persisted `sam_state` JSON becomes the initial
 * model for each recreated workflow, so in-flight orders resume from exactly
 * the state they were in when the process exited.
 *
 * NAPs fire automatically after the SAM instance is created — if an order was
 * mid-flight (e.g. status='submitted' waiting for POS confirmation), the NAP
 * will re-dispatch SUBMIT_TO_POS and retry the POS call without operator
 * intervention.
 *
 * Edge cases handled here:
 *   - Missing sam_state: synthesised from DB columns with sensible defaults
 *   - Legacy 'error' field: migrated to 'posError' (avoids SAM method clash)
 *   - Legacy merchantId === orderId bug: corrected from merchant_id column
 *   - Clover-sourced orders: skipped (managed by Clover, not this relay)
 */
export async function rehydrateActiveOrders(posAdapter: POSAdapter): Promise<void> {
  console.log('🔄 Rehydrating active orders...')

  const db = getDatabase()
  const rows = db
    .query<{
      id: string
      merchant_id: string
      sam_state: string | null
      items: string
      customer_name: string
      customer_phone: string
      customer_email: string | null
      subtotal_cents: number
      tax_cents: number
      total_cents: number
      order_type: 'pickup' | 'delivery' | 'dine_in'
      source: string
    }, []>(
      `SELECT id, merchant_id, sam_state, items, customer_name, customer_phone, customer_email,
              subtotal_cents, tax_cents, total_cents, order_type, COALESCE(source, 'local') AS source
       FROM orders
       WHERE status NOT IN ('picked_up', 'completed', 'cancelled', 'paid', 'refunded')
         AND COALESCE(source, 'local') != 'clover'
       ORDER BY created_at ASC`
    )
    .all()

  let rehydratedCount = 0

  for (const row of rows) {
    try {
      // Dashboard-created orders (source='dashboard') never go through the SAM workflow.
      // If they have no sam_state, rehydrating them would create a phantom POS submission
      // that resets their status (e.g. 'ready' → 'confirmed'). Skip them entirely.
      if (row.source === 'dashboard' && !row.sam_state) continue

      // Parse SAM state
      const rawParsed = row.sam_state ? JSON.parse(row.sam_state) : null
      // Migrate legacy 'error' field (collides with SAM Model.error() method) to 'posError'
      if (rawParsed && 'error' in rawParsed) {
        rawParsed.posError = rawParsed.posError ?? rawParsed.error
        delete rawParsed.error
      }
      // Migrate legacy merchantId bug: was set to orderId instead of merchant's ID
      if (rawParsed && rawParsed.merchantId === row.id) {
        rawParsed.merchantId = row.merchant_id
      }
      const persistedModel: OrderModel = rawParsed ?? {
            orderId: row.id,
            merchantId: row.merchant_id,
            status: 'received' as OrderStatus,
            order: null as unknown as POSOrderData,
            posOrderId: null,
            posProvider: null,
            pickupCode: null,
            retryCount: 0,
            posError: null,
            estimatedMinutes: null,
          }

      // Reconstruct order data
      const orderData: POSOrderData = {
        orderId: row.id,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        customerEmail: row.customer_email || undefined,
        items: (() => { try { const p = JSON.parse(row.items); return Array.isArray(p) ? p : [] } catch { return [] } })(),
        subtotalCents: row.subtotal_cents,
        taxCents: row.tax_cents,
        totalCents: row.total_cents,
        orderType: row.order_type,
      }

      // Create workflow with persisted state
      createOrderWorkflow(
        row.id,
        orderData,
        posAdapter,
        row.merchant_id,
        persistedModel
      )

      // NAPs will automatically resume processing
      rehydratedCount++
    } catch (error) {
      console.error(`Failed to rehydrate order ${row.id}:`, error)
    }
  }

  console.log(`✅ Rehydrated ${rehydratedCount} active orders`)
}

/**
 * Broadcasts order update to all connected SSE clients for the order's merchant.
 */
function broadcastOrderUpdate(orderId: string, update: unknown): void {
  const db = getDatabase()
  const row = db.query<{ merchant_id: string }, [string]>(
    'SELECT merchant_id FROM orders WHERE id = ?'
  ).get(orderId)
  if (row) {
    broadcastToMerchant(row.merchant_id, 'order_updated', update)
  } else {
    console.warn(`[order-relay] broadcastOrderUpdate: order ${orderId} not found`)
  }
}

/**
 * Gets FSM state diagram in GraphViz format (for debugging)
 */
export function getOrderFSMDiagram(): string {
  // sam-fsm exposes graphviz() as an undocumented diagnostic utility — not in .d.ts
  const fsm = orderRelayFSM as typeof orderRelayFSM & { graphviz?: () => string }
  return fsm.graphviz?.() ?? 'GraphViz not available'
}
