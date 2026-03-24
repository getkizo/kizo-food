package org.kizo.counter.ui.screen

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun SetupScreen(
    viewModel: org.kizo.counter.ui.viewmodel.MainViewModel,
    onRequestBtPermission: () -> Unit
) {
    val ui by viewModel.ui.collectAsState()

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            // Left column: Kizo connection
            Card(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize(),
                elevation = CardDefaults.cardElevation(2.dp)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    Text("Kizo Server", style = MaterialTheme.typography.titleLarge)
                    Text(
                        "Enter the WebSocket URL of your Kizo server.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                    )
                    OutlinedTextField(
                        value = ui.setupServerUrl,
                        onValueChange = viewModel::onSetupServerUrlChanged,
                        label = { Text("WebSocket URL") },
                        placeholder = { Text("ws://192.168.1.x:3000/counter") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri)
                    )
                    OutlinedTextField(
                        value = ui.setupApiToken,
                        onValueChange = viewModel::onSetupApiTokenChanged,
                        label = { Text("API Token (optional)") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation()
                    )
                    Text(
                        "Finix credentials and restaurant name are provisioned automatically by Kizo on first connection.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                    )
                }
            }

            // Right column: D135 Bluetooth pairing
            Card(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize(),
                elevation = CardDefaults.cardElevation(2.dp)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    Text("D135 Terminal", style = MaterialTheme.typography.titleLarge)

                    if (ui.setupBtDeviceName.isNotBlank()) {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.primaryContainer
                            )
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Text("Selected device:", style = MaterialTheme.typography.labelLarge)
                                Text(ui.setupBtDeviceName, style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    ui.setupBtDeviceAddress,
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                                )
                            }
                        }
                    } else {
                        Text(
                            "Pair the D135 via Android Bluetooth settings first, then select it here.",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                        )
                    }

                    Button(
                        onClick = {
                            onRequestBtPermission()
                            viewModel.scanPairedDevices()
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Scan Paired Devices")
                    }

                    if (ui.pairedDevices.isNotEmpty()) {
                        HorizontalDivider()
                        Text("Select your D135:", style = MaterialTheme.typography.labelLarge)
                        LazyColumn(modifier = Modifier.weight(1f)) {
                            items(ui.pairedDevices) { device ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            try {
                                                viewModel.onDeviceSelected(device.name ?: "D135", device.address)
                                            } catch (_: SecurityException) {}
                                        }
                                        .padding(vertical = 12.dp, horizontal = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    val deviceName = try { device.name ?: "Unknown" } catch (_: SecurityException) { null }
                                    Column {
                                        if (deviceName != null) {
                                            Text(deviceName, style = MaterialTheme.typography.bodyLarge)
                                        }
                                        Text(device.address, style = MaterialTheme.typography.bodyLarge,
                                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f))
                                    }
                                }
                                HorizontalDivider()
                            }
                        }
                    } else {
                        Spacer(modifier = Modifier.weight(1f))
                    }

                    // Save & Connect button
                    Button(
                        onClick = viewModel::saveSetupAndConnect,
                        modifier = Modifier.fillMaxWidth(),
                        enabled = ui.setupServerUrl.isNotBlank() && ui.setupBtDeviceName.isNotBlank()
                    ) {
                        Text("Save & Connect")
                    }
                }
            }
        }
    }
}
