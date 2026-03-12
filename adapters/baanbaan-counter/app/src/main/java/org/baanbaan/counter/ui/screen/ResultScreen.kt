package org.baanbaan.counter.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.baanbaan.counter.data.model.PaymentStatus
import org.baanbaan.counter.ui.viewmodel.MainViewModel

@Composable
fun ResultScreen(viewModel: MainViewModel) {
    val ui by viewModel.ui.collectAsState()
    val session = ui.session ?: return

    val approved = session.status == PaymentStatus.APPROVED
    var showEmailInput by remember { mutableStateOf(false) }
    var emailInput by remember { mutableStateOf("") }
    var receiptSent by remember { mutableStateOf(false) }

    val secondsRemaining = ui.resultSecondsRemaining

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(modifier = Modifier.fillMaxSize()) {
        Row(modifier = Modifier.weight(1f)) {
            // Left: result
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .padding(40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Icon(
                    imageVector = if (approved) Icons.Default.Check else Icons.Default.Close,
                    contentDescription = null,
                    modifier = Modifier.size(80.dp),
                    tint = if (approved) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
                )
                Spacer(modifier = Modifier.height(24.dp))
                Text(
                    text = if (approved) "Payment Approved" else "Payment Declined",
                    style = MaterialTheme.typography.headlineLarge,
                    color = if (approved) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(16.dp))
                if (approved) {
                    Text(formatCents(session.totalCents), style = MaterialTheme.typography.displayMedium)
                    if (session.tipCents > 0) {
                        Text(
                            "incl. tip ${formatCents(session.tipCents)}",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                        )
                    }
                } else {
                    Text(
                        session.errorMessage ?: "Please try again or use another payment method.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error.copy(alpha = 0.8f),
                        textAlign = TextAlign.Center
                    )
                }
            }

            // Right: receipt + done
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .padding(40.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                if (approved && !receiptSent) {
                    Text("Would you like a receipt?", style = MaterialTheme.typography.headlineMedium)
                    Spacer(modifier = Modifier.height(24.dp))

                    if (showEmailInput) {
                        OutlinedTextField(
                            value = emailInput,
                            onValueChange = { emailInput = it },
                            label = { Text("Email address") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Button(
                            onClick = {
                                viewModel.onReceiptRequested(emailInput)
                                receiptSent = true
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = emailInput.contains("@")
                        ) { Text("Send Receipt") }
                        Spacer(modifier = Modifier.height(8.dp))
                        OutlinedButton(
                            onClick = { showEmailInput = false },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("Back") }
                    } else {
                        Button(
                            onClick = { showEmailInput = true },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("Email Receipt") }
                        Spacer(modifier = Modifier.height(12.dp))
                        OutlinedButton(
                            onClick = { viewModel.onPaymentResultDone() },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("No Thanks") }
                    }
                } else {
                    if (receiptSent) {
                        Text(
                            "Receipt will be sent to\n${emailInput}",
                            style = MaterialTheme.typography.bodyLarge,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                        )
                        Spacer(modifier = Modifier.height(24.dp))
                    }
                    Button(
                        onClick = { viewModel.onPaymentResultDone() },
                        modifier = Modifier.fillMaxWidth(),
                        colors = if (!approved) ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error
                        ) else ButtonDefaults.buttonColors()
                    ) { Text("Done") }
                }
            }
        } // end Row

        // Countdown bar
        if (secondsRemaining > 0) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                CircularProgressIndicator(
                    progress = { secondsRemaining / 30f },
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                )
                Text(
                    "Returning to idle in ${secondsRemaining}s",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f)
                )
            }
        }
        } // end Column
    }
}
