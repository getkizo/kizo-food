/**
 * Clover reconciliation fast-poll signal.
 *
 * Call `notifyCloverPaymentInitiated()` whenever a Clover order is pushed to
 * a device.  The reconciliation loop in server.ts reads `lastCloverPaymentAt`
 * to decide whether to use the fast (15 s) or default (120 s) interval.
 */

let _lastCloverPaymentAt = 0

/** Mark the current moment as "a Clover payment was just initiated". */
export function notifyCloverPaymentInitiated(): void {
  _lastCloverPaymentAt = Date.now()
}

/** Returns the timestamp (ms) of the last Clover payment initiation, or 0. */
export function lastCloverPaymentAt(): number {
  return _lastCloverPaymentAt
}
