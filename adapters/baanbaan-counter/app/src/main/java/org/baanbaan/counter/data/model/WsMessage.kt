package org.baanbaan.counter.data.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * BaanBaan Counter ↔ BaanBaan Bun WebSocket Protocol
 *
 * Connection URL: ws://<host>:<port>/counter?token=<api_token>
 *
 * == INCOMING (BaanBaan → Counter) ==
 *
 * 1. config — sent on connect and when merchant settings change
 *    { "type": "config", "restaurantName": "...", "finixDeviceId": "DV...",
 *      "finixMerchantId": "MU...", "finixMid": "...", "finixUserId": "US...",
 *      "finixPassword": "...", "environment": "PROD" | "SB" }
 *
 * 2. payment_request — initiate payment flow
 *    { "type": "payment_request", "orderId": "...", "amountCents": 2500,
 *      "currency": "USD", "tipOptions": [15, 18, 20] }
 *
 * 3. cancel_payment — cancel the current payment
 *    { "type": "cancel_payment", "orderId": "..." }
 *
 * == OUTGOING (Counter → BaanBaan) ==
 *
 * 1. counter_status — sent on connect and on device state changes
 *    { "type": "counter_status", "deviceConnected": true }
 *
 * 2. payment_result — sent immediately when the transaction resolves
 *    { "type": "payment_result", "orderId": "...", "transactionId": "...",
 *      "status": "approved" | "declined" | "error" | "cancelled",
 *      "amountCents": 2500, "tipCents": 375, "totalCents": 2875,
 *      "signatureBase64": "..." }
 *
 * 3. receipt_request — sent after payment_result if the customer requests an email receipt
 *    { "type": "receipt_request", "orderId": "...", "transactionId": "...", "email": "..." }
 */

// ─── Incoming ────────────────────────────────────────────────────────────────

sealed class IncomingMessage {

    data class Config(
        val restaurantName: String,
        val finixDeviceId: String,
        val finixMerchantId: String,
        val finixMid: String,
        val finixUserId: String,
        val finixPassword: String,
        val environment: String = "PROD"
    ) : IncomingMessage()

    data class PaymentRequest(
        val orderId: String,
        val amountCents: Long,
        val currency: String = "USD",
        val tipOptions: List<Int> = emptyList()
    ) : IncomingMessage()

    data class CancelPayment(val orderId: String) : IncomingMessage()

    object Unknown : IncomingMessage()
}

// ─── Outgoing ─────────────────────────────────────────────────────────────────

@Serializable
data class CounterStatusMessage(
    val type: String = "counter_status",
    val deviceConnected: Boolean
)

@Serializable
data class PaymentResultMessage(
    val type: String = "payment_result",
    val orderId: String,
    val transactionId: String?,
    val status: String, // "approved" | "declined" | "error" | "cancelled"
    val amountCents: Long,
    val tipCents: Long,
    val totalCents: Long,
    val signatureBase64: String?
)

@Serializable
data class ReceiptRequestMessage(
    val type: String = "receipt_request",
    val orderId: String,
    val transactionId: String?,
    val email: String
)

// ─── Raw parsing ──────────────────────────────────────────────────────────────

@Serializable
data class RawMessage(
    val type: String = "",
    val restaurantName: String = "",
    val finixDeviceId: String = "",
    val finixMerchantId: String = "",
    val finixMid: String = "",
    val finixUserId: String = "",
    val finixPassword: String = "",
    val environment: String = "PROD",
    val orderId: String = "",
    val amountCents: Long = 0L,
    val currency: String = "USD",
    val tipOptions: List<Int> = emptyList()
)
