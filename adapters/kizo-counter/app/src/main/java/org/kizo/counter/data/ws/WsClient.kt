package org.kizo.counter.data.ws

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.kizo.counter.data.model.CounterStatusMessage
import org.kizo.counter.data.model.IncomingMessage
import org.kizo.counter.data.model.PaymentResultMessage
import org.kizo.counter.data.model.ReceiptRequestMessage
import org.kizo.counter.data.model.RawMessage
import org.kizo.counter.di.ApplicationScope
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min

private const val TAG = "WsClient"

sealed class WsState {
    object Disconnected : WsState()
    object Connecting : WsState()
    object Connected : WsState()
    data class Error(val message: String) : WsState()
}

@Singleton
class WsClient @Inject constructor(
    private val okHttpClient: OkHttpClient,
    @ApplicationScope private val scope: CoroutineScope
) {
    private val json = Json { ignoreUnknownKeys = true }

    private var webSocket: WebSocket? = null
    private var currentUrl: String = ""
    private var shouldReconnect = false
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0

    private val _state = MutableStateFlow<WsState>(WsState.Disconnected)
    val state: StateFlow<WsState> = _state

    private val _messages = MutableSharedFlow<IncomingMessage>()
    val messages: SharedFlow<IncomingMessage> = _messages

    fun connect(url: String) {
        shouldReconnect = true
        currentUrl = url
        reconnectAttempt = 0
        openSocket(url)
    }

    fun disconnect() {
        shouldReconnect = false
        reconnectJob?.cancel()
        webSocket?.close(1000, "Goodbye")
        webSocket = null
        _state.value = WsState.Disconnected
    }

    fun sendStatus(deviceConnected: Boolean) {
        val msg = json.encodeToString(CounterStatusMessage(deviceConnected = deviceConnected))
        webSocket?.send(msg)
    }

    fun sendPaymentResult(result: PaymentResultMessage) {
        val msg = json.encodeToString(result)
        webSocket?.send(msg)
    }

    fun sendReceiptRequest(receipt: ReceiptRequestMessage) {
        val msg = json.encodeToString(receipt)
        webSocket?.send(msg)
    }

    private fun openSocket(url: String) {
        _state.value = WsState.Connecting
        val request = Request.Builder().url(url).build()
        webSocket = okHttpClient.newWebSocket(request, listener)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i(TAG, "Connected to Kizo")
            reconnectAttempt = 0
            _state.value = WsState.Connected
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            Log.d(TAG, "Received: $text")
            val parsed = parseMessage(text)
            scope.launch { _messages.emit(parsed) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "Connection failure: ${t.message}")
            _state.value = WsState.Error(t.message ?: "Connection failed")
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "Closed: $reason")
            _state.value = WsState.Disconnected
            if (shouldReconnect) scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        reconnectJob?.cancel()
        val delayMs = min(30_000L, 1_000L * (1L shl reconnectAttempt))
        Log.i(TAG, "Reconnecting in ${delayMs}ms (attempt ${reconnectAttempt + 1})")
        reconnectJob = scope.launch {
            delay(delayMs)
            reconnectAttempt++
            openSocket(currentUrl)
        }
    }

    private fun parseMessage(text: String): IncomingMessage {
        return try {
            val raw = json.decodeFromString<RawMessage>(text)
            when (raw.type) {
                "config" -> IncomingMessage.Config(
                    restaurantName = raw.restaurantName,
                    finixDeviceId = raw.finixDeviceId,
                    finixMerchantId = raw.finixMerchantId,
                    finixMid = raw.finixMid,
                    finixUserId = raw.finixUserId,
                    finixPassword = raw.finixPassword,
                    environment = raw.environment
                )
                "payment_request" -> IncomingMessage.PaymentRequest(
                    orderId = raw.orderId,
                    amountCents = raw.amountCents,
                    currency = raw.currency,
                    tipOptions = raw.tipOptions
                )
                "cancel_payment" -> IncomingMessage.CancelPayment(orderId = raw.orderId)
                else -> {
                    Log.w(TAG, "Unknown message type: ${raw.type}")
                    IncomingMessage.Unknown
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse message: ${e.message}")
            IncomingMessage.Unknown
        }
    }
}
