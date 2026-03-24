package org.kizo.counter

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import dagger.hilt.android.AndroidEntryPoint
import org.kizo.counter.ui.screen.IdleScreen
import org.kizo.counter.ui.screen.PaymentScreen
import org.kizo.counter.ui.screen.ProcessingScreen
import org.kizo.counter.ui.screen.ResultScreen
import org.kizo.counter.ui.screen.SetupScreen
import org.kizo.counter.ui.screen.SignatureScreen
import org.kizo.counter.ui.theme.KizoCounterTheme
import org.kizo.counter.ui.viewmodel.Screen

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    private val viewModel: org.kizo.counter.ui.viewmodel.MainViewModel by viewModels()

    private val btPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* permissions result handled; scan triggered by user anyway */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            KizoCounterTheme {
                val ui by viewModel.ui.collectAsState()

                when (ui.screen) {
                    Screen.SETUP -> SetupScreen(
                        viewModel = viewModel,
                        onRequestBtPermission = ::requestBtPermissions
                    )
                    Screen.IDLE -> IdleScreen(viewModel)
                    Screen.PAYMENT_TIP -> PaymentScreen(viewModel)
                    Screen.PAYMENT_SIGNATURE -> SignatureScreen(viewModel)
                    Screen.PAYMENT_PROCESSING -> ProcessingScreen(viewModel)
                    Screen.PAYMENT_RESULT -> ResultScreen(viewModel)
                }
            }
        }
    }

    private fun requestBtPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            btPermissionLauncher.launch(
                arrayOf(
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT
                )
            )
        } else {
            btPermissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.BLUETOOTH,
                    Manifest.permission.BLUETOOTH_ADMIN
                )
            )
        }
    }

    override fun onDestroy() {
        super.onDestroy()
    }
}
