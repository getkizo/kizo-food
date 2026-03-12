package org.baanbaan.counter.ui.viewmodel

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.baanbaan.counter.data.model.IncomingMessage
import org.baanbaan.counter.data.model.PaymentResultMessage
import org.baanbaan.counter.data.model.PaymentSession
import org.baanbaan.counter.data.model.ReceiptRequestMessage
import org.baanbaan.counter.data.model.PaymentStatus
import org.baanbaan.counter.data.prefs.CounterPrefs
import org.baanbaan.counter.data.ws.WsClient
import org.baanbaan.counter.data.ws.WsState
import org.baanbaan.counter.mpos.MposConnectionState
import org.baanbaan.counter.mpos.MposManager
import javax.inject.Inject

private const val TAG = "MainViewModel"

enum class Screen {
    SETUP,
    IDLE,
    PAYMENT_TIP,
    PAYMENT_SIGNATURE,
    PAYMENT_PROCESSING,
    PAYMENT_RESULT
}

data class UiState(
    val screen: Screen = Screen.SETUP,
    val restaurantName: String = "",
    val wsState: WsState = WsState.Disconnected,
    val mposState: MposConnectionState = MposConnectionState.Disconnected,
    val transactionStep: String = "",
    val pairedDevices: List<BluetoothDevice> = emptyList(),
    val session: PaymentSession? = null,
    val resultSecondsRemaining: Int = 0,
    // Setup fields (transient)
    val setupServerUrl: String = "",
    val setupApiToken: String = "",
    val setupBtDeviceName: String = "",
    val setupBtDeviceAddress: String = ""
)

@HiltViewModel
class MainViewModel @Inject constructor(
    private val prefs: CounterPrefs,
    private val wsClient: WsClient,
    private val mposManager: MposManager
) : ViewModel() {

    private var resultTimeoutJob: Job? = null

    private val _ui = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> = _ui

    init {
        // Load persisted setup values into UI state
        _ui.update {
            it.copy(
                restaurantName = prefs.restaurantName,
                setupServerUrl = prefs.serverUrl,
                setupApiToken = prefs.apiToken,
                setupBtDeviceName = prefs.btDeviceName,
                setupBtDeviceAddress = prefs.btDeviceAddress
            )
        }

        // Observe WebSocket state
        viewModelScope.launch {
            wsClient.state.collectLatest { wsState ->
                _ui.update { it.copy(wsState = wsState) }
                if (wsState is WsState.Connected) {
                    wsClient.sendStatus(mposManager.isConnected)
                }
            }
        }

        // Observe incoming WebSocket messages
        viewModelScope.launch {
            wsClient.messages.collect { msg -> handleWsMessage(msg) }
        }

        // Observe MPOS connection state
        viewModelScope.launch {
            mposManager.connectionState.collectLatest { mposState ->
                _ui.update { it.copy(mposState = mposState) }
                // Notify BaanBaan whenever device connection changes
                if (_ui.value.wsState is WsState.Connected) {
                    wsClient.sendStatus(mposState is MposConnectionState.Connected)
                }
            }
        }

        // Observe transaction step messages
        viewModelScope.launch {
            mposManager.transactionStep.collectLatest { step ->
                _ui.update { it.copy(transactionStep = step) }
            }
        }

        // Start up: go to setup if not configured, otherwise connect
        if (prefs.isConnectionConfigured && prefs.isDeviceConfigured) {
            startUp()
        }
        // else stay on SETUP screen (default)
    }

    // ─── Setup ───────────────────────────────────────────────────────────────

    fun onSetupServerUrlChanged(url: String) = _ui.update { it.copy(setupServerUrl = url) }
    fun onSetupApiTokenChanged(token: String) = _ui.update { it.copy(setupApiToken = token) }

    fun scanPairedDevices() {
        try {
            val adapter = BluetoothAdapter.getDefaultAdapter()
            val devices = adapter?.bondedDevices?.toList() ?: emptyList()
            _ui.update { it.copy(pairedDevices = devices) }
        } catch (e: SecurityException) {
            Log.e(TAG, "Bluetooth permission denied: ${e.message}")
        }
    }

    fun onDeviceSelected(name: String, address: String) {
        _ui.update { it.copy(setupBtDeviceName = name, setupBtDeviceAddress = address, pairedDevices = emptyList()) }
    }

    fun saveSetupAndConnect() {
        val state = _ui.value
        prefs.serverUrl = state.setupServerUrl.trim()
        prefs.apiToken = state.setupApiToken.trim()
        prefs.btDeviceName = state.setupBtDeviceName
        prefs.btDeviceAddress = state.setupBtDeviceAddress
        startUp()
    }

    private fun startUp() {
        _ui.update { it.copy(screen = Screen.IDLE) }
        connectWebSocket()
        initAndConnectMpos()
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    private fun connectWebSocket() {
        val token = prefs.apiToken
        val baseUrl = prefs.serverUrl.trimEnd('/')
        val url = if (token.isNotBlank()) "$baseUrl?token=$token" else baseUrl
        Log.i(TAG, "Connecting WebSocket: $url")
        wsClient.connect(url)
    }

    // ─── MPOS / D135 ─────────────────────────────────────────────────────────

    private fun initAndConnectMpos() {
        if (prefs.isFinixConfigured) {
            mposManager.init(
                merchantId = prefs.finixMerchantId,
                mid = prefs.finixMid,
                deviceId = prefs.finixDeviceId,
                userId = prefs.finixUserId,
                password = prefs.finixPassword,
                environment = prefs.finixEnvironment
            )
            connectMpos()
        }
        // If Finix creds not yet received, wait for config message from BaanBaan
    }

    private fun connectMpos() {
        if (prefs.btDeviceName.isBlank() || prefs.btDeviceAddress.isBlank()) return
        viewModelScope.launch(Dispatchers.IO) {
            mposManager.connect(prefs.btDeviceName, prefs.btDeviceAddress)
                .onFailure { Log.e(TAG, "D135 connect failed: ${it.message}") }
        }
    }

    // ─── WebSocket message handling ───────────────────────────────────────────

    private fun handleWsMessage(msg: IncomingMessage) {
        when (msg) {
            is IncomingMessage.Config -> applyConfig(msg)
            is IncomingMessage.PaymentRequest -> startPaymentSession(msg)
            is IncomingMessage.CancelPayment -> cancelCurrentPayment(msg.orderId)
            is IncomingMessage.Unknown -> Unit
        }
    }

    private fun applyConfig(config: IncomingMessage.Config) {
        Log.i(TAG, "Config received: restaurant=${config.restaurantName}")
        prefs.restaurantName = config.restaurantName
        prefs.finixDeviceId = config.finixDeviceId
        prefs.finixMerchantId = config.finixMerchantId
        prefs.finixMid = config.finixMid
        prefs.finixUserId = config.finixUserId
        prefs.finixPassword = config.finixPassword
        prefs.finixEnvironment = config.environment
        _ui.update { it.copy(restaurantName = config.restaurantName) }

        // Re-init MPOS with new credentials if needed
        if (!mposManager.isConnected) {
            mposManager.init(
                merchantId = config.finixMerchantId,
                mid = config.finixMid,
                deviceId = config.finixDeviceId,
                userId = config.finixUserId,
                password = config.finixPassword,
                environment = config.environment
            )
            connectMpos()
        }
    }

    private fun startPaymentSession(req: IncomingMessage.PaymentRequest) {
        val currentScreen = _ui.value.screen
        if (currentScreen != Screen.IDLE && currentScreen != Screen.PAYMENT_RESULT) {
            Log.w(TAG, "Received payment_request while on $currentScreen — ignoring")
            return
        }
        resultTimeoutJob?.cancel()
        val session = PaymentSession(
            orderId = req.orderId,
            amountCents = req.amountCents,
            currency = req.currency,
            tipOptions = req.tipOptions
        )
        _ui.update { it.copy(session = session, screen = Screen.PAYMENT_TIP, resultSecondsRemaining = 0) }
    }

    private fun cancelCurrentPayment(orderId: String) {
        val session = _ui.value.session ?: return
        if (session.orderId != orderId) return

        mposManager.cancelTransaction()

        val cancelled = session.copy(status = PaymentStatus.CANCELLED)
        sendResult(cancelled)
        _ui.update { it.copy(session = null, screen = Screen.IDLE) }
    }

    // ─── Payment flow ─────────────────────────────────────────────────────────

    fun onTipSelected(tipCents: Long) {
        _ui.update { state ->
            val updated = state.session?.copy(tipCents = tipCents) ?: return
            state.copy(session = updated, screen = Screen.PAYMENT_SIGNATURE)
        }
    }

    fun onSignatureComplete(signatureBase64: String) {
        _ui.update { state ->
            val updated = state.session?.copy(signatureBase64 = signatureBase64) ?: return
            state.copy(session = updated, screen = Screen.PAYMENT_PROCESSING)
        }
        runTransaction()
    }

    private fun runTransaction() {
        val session = _ui.value.session ?: return
        viewModelScope.launch(Dispatchers.IO) {
            mposManager.startSale(session.totalCents, session.orderId)
                .onSuccess { result ->
                    val approved = session.copy(
                        status = PaymentStatus.APPROVED,
                        transactionId = result.id?.takeIf { it.isNotBlank() }
                    )
                    // Send result immediately — BaanBaan should not wait for customer to tap Done
                    sendResult(approved)
                    _ui.update { it.copy(session = approved, screen = Screen.PAYMENT_RESULT) }
                    startResultTimeout()
                }
                .onFailure { err ->
                    val failed = session.copy(
                        status = PaymentStatus.DECLINED,
                        errorMessage = err.message
                    )
                    sendResult(failed)
                    _ui.update { it.copy(session = failed, screen = Screen.PAYMENT_RESULT) }
                    startResultTimeout()
                }
        }
    }

    fun onReceiptRequested(email: String) {
        val session = _ui.value.session ?: return
        val trimmedEmail = email.trim()
        if (trimmedEmail.isBlank()) return
        wsClient.sendReceiptRequest(
            ReceiptRequestMessage(
                orderId = session.orderId,
                transactionId = session.transactionId,
                email = trimmedEmail
            )
        )
        _ui.update { state ->
            state.copy(session = state.session?.copy(receiptRequested = true, receiptEmail = trimmedEmail))
        }
    }

    fun onPaymentResultDone() {
        resultTimeoutJob?.cancel()
        _ui.update { it.copy(session = null, screen = Screen.IDLE, resultSecondsRemaining = 0) }
    }

    private fun startResultTimeout() {
        resultTimeoutJob?.cancel()
        resultTimeoutJob = viewModelScope.launch {
            for (remaining in 30 downTo 1) {
                _ui.update { it.copy(resultSecondsRemaining = remaining) }
                delay(1_000)
            }
            onPaymentResultDone()
        }
    }

    private fun sendResult(session: PaymentSession) {
        val status = when (session.status) {
            PaymentStatus.APPROVED -> "approved"
            PaymentStatus.DECLINED -> "declined"
            PaymentStatus.CANCELLED -> "cancelled"
            else -> "error"
        }
        wsClient.sendPaymentResult(
            PaymentResultMessage(
                orderId = session.orderId,
                transactionId = session.transactionId,
                status = status,
                amountCents = session.amountCents,
                tipCents = session.tipCents,
                totalCents = session.totalCents,
                signatureBase64 = session.signatureBase64
            )
        )
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    override fun onCleared() {
        super.onCleared()
        wsClient.disconnect()
        mposManager.disconnect()
    }
}
