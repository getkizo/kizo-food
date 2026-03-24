package org.kizo.counter.data.prefs

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CounterPrefs @Inject constructor(@ApplicationContext private val context: Context) {

    private val prefs: SharedPreferences by lazy {
        context.getSharedPreferences("counter_prefs", Context.MODE_PRIVATE)
    }

    // ─── Kizo connection ──────────────────────────────────────────────────

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    var apiToken: String
        get() = prefs.getString(KEY_API_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_API_TOKEN, value).apply()

    // ─── Restaurant (provisioned by Kizo config message) ─────────────────

    var restaurantName: String
        get() = prefs.getString(KEY_RESTAURANT_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_RESTAURANT_NAME, value).apply()

    // ─── Finix credentials (provisioned by Kizo config message) ──────────

    var finixDeviceId: String
        get() = prefs.getString(KEY_FINIX_DEVICE_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FINIX_DEVICE_ID, value).apply()

    var finixMerchantId: String
        get() = prefs.getString(KEY_FINIX_MERCHANT_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FINIX_MERCHANT_ID, value).apply()

    var finixMid: String
        get() = prefs.getString(KEY_FINIX_MID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FINIX_MID, value).apply()

    var finixUserId: String
        get() = prefs.getString(KEY_FINIX_USER_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FINIX_USER_ID, value).apply()

    var finixPassword: String
        get() = prefs.getString(KEY_FINIX_PASSWORD, "") ?: ""
        set(value) = prefs.edit().putString(KEY_FINIX_PASSWORD, value).apply()

    var finixEnvironment: String
        get() = prefs.getString(KEY_FINIX_ENV, "PROD") ?: "PROD"
        set(value) = prefs.edit().putString(KEY_FINIX_ENV, value).apply()

    // ─── Bluetooth device ─────────────────────────────────────────────────────

    var btDeviceName: String
        get() = prefs.getString(KEY_BT_DEVICE_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BT_DEVICE_NAME, value).apply()

    var btDeviceAddress: String
        get() = prefs.getString(KEY_BT_DEVICE_ADDRESS, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BT_DEVICE_ADDRESS, value).apply()

    // ─── Helpers ──────────────────────────────────────────────────────────────

    val isConnectionConfigured: Boolean
        get() = serverUrl.isNotBlank()

    val isFinixConfigured: Boolean
        get() = finixDeviceId.isNotBlank() && finixMerchantId.isNotBlank() &&
                finixMid.isNotBlank() && finixUserId.isNotBlank() && finixPassword.isNotBlank()

    val isDeviceConfigured: Boolean
        get() = btDeviceName.isNotBlank() && btDeviceAddress.isNotBlank()

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_API_TOKEN = "api_token"
        private const val KEY_RESTAURANT_NAME = "restaurant_name"
        private const val KEY_FINIX_DEVICE_ID = "finix_device_id"
        private const val KEY_FINIX_MERCHANT_ID = "finix_merchant_id"
        private const val KEY_FINIX_MID = "finix_mid"
        private const val KEY_FINIX_USER_ID = "finix_user_id"
        private const val KEY_FINIX_PASSWORD = "finix_password"
        private const val KEY_FINIX_ENV = "finix_env"
        private const val KEY_BT_DEVICE_NAME = "bt_device_name"
        private const val KEY_BT_DEVICE_ADDRESS = "bt_device_address"
    }
}
