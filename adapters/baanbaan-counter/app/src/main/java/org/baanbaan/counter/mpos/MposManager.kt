package org.baanbaan.counter.mpos

import android.content.Context
import android.util.Log
import com.finix.mpos.models.Currency
import com.finix.mpos.models.EnvEnum
import com.finix.mpos.models.MerchantData
import com.finix.mpos.models.TransactionResult
import com.finix.mpos.models.TransactionType
import com.finix.mpos.sdk.MPOSConnectionCallback
import com.finix.mpos.sdk.MPOSFinix
import com.finix.mpos.sdk.MPOSTransactionCallback
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

private const val TAG = "MposManager"

sealed class MposConnectionState {
    object Disconnected : MposConnectionState()
    data class Connecting(val step: String) : MposConnectionState()
    object Connected : MposConnectionState()
    data class Error(val message: String) : MposConnectionState()
}

@Singleton
class MposManager @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private var mpos: MPOSFinix? = null

    private val _connectionState = MutableStateFlow<MposConnectionState>(MposConnectionState.Disconnected)
    val connectionState: StateFlow<MposConnectionState> = _connectionState

    private val _transactionStep = MutableStateFlow("")
    val transactionStep: StateFlow<String> = _transactionStep

    val isConnected: Boolean get() = mpos?.isConnected() == true

    fun init(
        merchantId: String,
        mid: String,
        deviceId: String,
        userId: String,
        password: String,
        environment: String
    ) {
        val env = if (environment == "PROD") EnvEnum.PROD else EnvEnum.SB
        mpos = MPOSFinix(
            context,
            MerchantData(
                merchantId = merchantId,
                mid = mid,
                deviceId = deviceId,
                currency = Currency.USD,
                env = env,
                userId = userId,
                password = password
            )
        )
        Log.i(TAG, "MPOSFinix initialized for env=$environment")
    }

    suspend fun connect(deviceName: String, deviceAddress: String): Result<Unit> =
        suspendCancellableCoroutine { cont ->
            val sdk = mpos ?: run {
                cont.resume(Result.failure(Exception("MPOS not initialized")))
                return@suspendCancellableCoroutine
            }

            _connectionState.value = MposConnectionState.Connecting("Starting...")

            sdk.connect(deviceName, deviceAddress, object : MPOSConnectionCallback {
                override fun onSuccess() {
                    Log.i(TAG, "D135 connected")
                    _connectionState.value = MposConnectionState.Connected
                    if (cont.isActive) cont.resume(Result.success(Unit))
                }

                override fun onError(errorMessage: String) {
                    Log.e(TAG, "D135 connection error: $errorMessage")
                    _connectionState.value = MposConnectionState.Error(errorMessage)
                    if (cont.isActive) cont.resume(Result.failure(Exception(errorMessage)))
                }

                override fun onProcessing(currentStepMessage: String) {
                    Log.d(TAG, "D135 connecting: $currentStepMessage")
                    _connectionState.value = MposConnectionState.Connecting(currentStepMessage)
                }
            })

            cont.invokeOnCancellation {
                _connectionState.value = MposConnectionState.Disconnected
            }
        }

    suspend fun startSale(amountCents: Long, orderId: String): Result<TransactionResult> =
        suspendCancellableCoroutine { cont ->
            val sdk = mpos ?: run {
                cont.resume(Result.failure(Exception("MPOS not initialized")))
                return@suspendCancellableCoroutine
            }

            _transactionStep.value = "Preparing terminal..."
            var resumed = false

            try {
                sdk.startTransaction(
                    amountCents,
                    TransactionType.SALE,
                    object : MPOSTransactionCallback {
                        override fun onSuccess(result: TransactionResult?) {
                            if (resumed) return
                            resumed = true
                            Log.i(TAG, "Transaction success: ${result?.id}")
                            _transactionStep.value = "Approved"
                            cont.resume(Result.success(result ?: TransactionResult()))
                        }

                        override fun onError(errorMessage: String) {
                            if (resumed) return
                            resumed = true
                            Log.e(TAG, "Transaction error: $errorMessage")
                            _transactionStep.value = ""
                            cont.resume(Result.failure(Exception(errorMessage)))
                        }

                        override fun onProcessing(currentStepMessage: String) {
                            Log.d(TAG, "Transaction processing: $currentStepMessage")
                            _transactionStep.value = currentStepMessage
                        }
                    },
                    null, // no split transfers
                    mapOf("order_id" to orderId)
                )
            } catch (e: Exception) {
                if (!resumed) {
                    resumed = true
                    cont.resume(Result.failure(e))
                }
            }

            cont.invokeOnCancellation {
                try { sdk.cancelTransaction() } catch (_: Exception) {}
                _transactionStep.value = ""
            }
        }

    fun disconnect() {
        try {
            mpos?.finishTransaction()
            mpos?.disconnect()
        } catch (e: Exception) {
            Log.w(TAG, "Error during disconnect: ${e.message}")
        }
        _connectionState.value = MposConnectionState.Disconnected
    }

    fun cancelTransaction() {
        try { mpos?.cancelTransaction() } catch (e: Exception) {
            Log.w(TAG, "Error cancelling transaction: ${e.message}")
        }
    }
}
