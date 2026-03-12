package org.baanbaan.counter.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.baanbaan.counter.data.ws.WsState
import org.baanbaan.counter.mpos.MposConnectionState
import org.baanbaan.counter.ui.viewmodel.MainViewModel

@Composable
fun IdleScreen(viewModel: MainViewModel) {
    val ui by viewModel.ui.collectAsState()

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Restaurant name
            Text(
                text = ui.restaurantName.ifBlank { "BaanBaan Counter" },
                style = MaterialTheme.typography.displayMedium,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.primary
            )

            // Ready indicator
            Box(contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "Ready for Payment",
                        style = MaterialTheme.typography.headlineLarge,
                        textAlign = TextAlign.Center
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Please proceed to the cashier.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f),
                        textAlign = TextAlign.Center
                    )
                }
            }

            // Status row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally)
            ) {
                StatusChip(
                    label = "BaanBaan",
                    connected = ui.wsState is WsState.Connected,
                    loading = ui.wsState is WsState.Connecting
                )
                StatusChip(
                    label = "D135 Terminal",
                    connected = ui.mposState is MposConnectionState.Connected,
                    loading = ui.mposState is MposConnectionState.Connecting
                )
            }
        }
    }
}

@Composable
private fun StatusChip(label: String, connected: Boolean, loading: Boolean) {
    val color = when {
        loading -> MaterialTheme.colorScheme.secondary
        connected -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.error
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = color.copy(alpha = 0.1f)),
        border = androidx.compose.foundation.BorderStroke(1.dp, color)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = color)
            }
            Text(
                text = "$label: ${if (loading) "Connecting..." else if (connected) "Connected" else "Disconnected"}",
                style = MaterialTheme.typography.labelLarge,
                color = color
            )
        }
    }
}
