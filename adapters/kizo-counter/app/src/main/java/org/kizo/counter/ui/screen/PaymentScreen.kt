package org.kizo.counter.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
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
import org.kizo.counter.ui.viewmodel.MainViewModel


@Composable
fun PaymentScreen(viewModel: MainViewModel) {
    val ui by viewModel.ui.collectAsState()
    val session = ui.session ?: return

    var showCustomTip by remember { mutableStateOf(false) }
    var customTipInput by remember { mutableStateOf("") }
    var customTipError by remember { mutableStateOf(false) }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Row(modifier = Modifier.fillMaxSize()) {
            // Left: Order summary
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .padding(40.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = ui.restaurantName.ifBlank { "Kizo" },
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(modifier = Modifier.height(32.dp))
                Text("Order Total", style = MaterialTheme.typography.headlineMedium)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = formatCents(session.amountCents),
                    style = MaterialTheme.typography.displayLarge,
                    color = MaterialTheme.colorScheme.onSurface
                )
            }

            HorizontalDivider(
                modifier = Modifier
                    .width(1.dp)
                    .fillMaxSize()
            )

            // Right: Tip selection
            Column(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxSize()
                    .padding(40.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("Would you like to add a tip?", style = MaterialTheme.typography.headlineMedium)
                Spacer(modifier = Modifier.height(32.dp))

                // Percentage tip buttons from Kizo
                session.tipOptions.chunked(2).forEach { chunk ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        chunk.forEach { pct ->
                            val tipCents = (session.amountCents * pct / 100.0).toLong()
                            TipButton(
                                label = "$pct%",
                                subLabel = formatCents(tipCents),
                                modifier = Modifier.weight(1f),
                                onClick = { viewModel.onTipSelected(tipCents) }
                            )
                        }
                        // Fill empty slot if odd number
                        if (chunk.size == 1) Spacer(modifier = Modifier.weight(1f))
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                }

                // Custom tip
                if (showCustomTip) {
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = customTipInput,
                        onValueChange = {
                            customTipInput = it
                            customTipError = false
                        },
                        label = { Text("Custom tip amount") },
                        prefix = { Text("$") },
                        isError = customTipError,
                        supportingText = if (customTipError) ({ Text("Enter a valid amount") }) else null,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Button(
                        onClick = {
                            val tipCents = customTipInput.toDoubleOrNull()?.let { (it * 100).toLong() }
                            if (tipCents != null && tipCents >= 0) {
                                viewModel.onTipSelected(tipCents)
                            } else {
                                customTipError = true
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Confirm Custom Tip") }
                } else {
                    OutlinedButton(
                        onClick = { showCustomTip = true },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Custom Amount") }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // No tip
                OutlinedButton(
                    onClick = { viewModel.onTipSelected(0L) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                    )
                ) { Text("No Tip") }
            }
        }
    }
}

@Composable
private fun TipButton(
    label: String,
    subLabel: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Button(
        onClick = onClick,
        modifier = modifier.height(72.dp)
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, style = MaterialTheme.typography.titleLarge)
            Text(subLabel, style = MaterialTheme.typography.bodyLarge)
        }
    }
}
