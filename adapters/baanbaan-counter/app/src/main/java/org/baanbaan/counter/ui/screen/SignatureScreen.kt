package org.baanbaan.counter.ui.screen

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import java.io.ByteArrayOutputStream
import org.baanbaan.counter.ui.viewmodel.MainViewModel

private data class StrokePath(val points: List<Offset>)

private fun List<StrokePath>.toBase64(width: Int, height: Int): String {
    val bmp = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bmp)
    canvas.drawColor(android.graphics.Color.WHITE)
    val paint = Paint().apply {
        color = android.graphics.Color.BLACK
        strokeWidth = 4f
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        isAntiAlias = true
    }
    forEach { stroke ->
        if (stroke.points.size > 1) {
            val path = android.graphics.Path()
            path.moveTo(stroke.points.first().x, stroke.points.first().y)
            stroke.points.drop(1).forEach { pt -> path.lineTo(pt.x, pt.y) }
            canvas.drawPath(path, paint)
        }
    }
    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.PNG, 90, out)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

@Composable
fun SignatureScreen(viewModel: MainViewModel) {
    val ui by viewModel.ui.collectAsState()
    val session = ui.session ?: return

    val strokes = remember { mutableStateListOf<StrokePath>() }
    var currentPoints by remember { mutableStateOf<List<Offset>>(emptyList()) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Row(modifier = Modifier.fillMaxSize()) {
            // Left: order summary
            Column(
                modifier = Modifier
                    .fillMaxHeight()
                    .weight(0.35f)
                    .padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("Order Total", style = MaterialTheme.typography.headlineMedium)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    formatCents(session.amountCents),
                    style = MaterialTheme.typography.displayMedium
                )
                if (session.tipCents > 0) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("Tip: ${formatCents(session.tipCents)}", style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        "Total: ${formatCents(session.totalCents)}",
                        style = MaterialTheme.typography.headlineMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }

            // Right: signature
            Column(
                modifier = Modifier
                    .fillMaxHeight()
                    .weight(0.65f)
                    .padding(32.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text("Please sign below", style = MaterialTheme.typography.headlineMedium)

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .border(2.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(8.dp))
                        .background(Color.White, RoundedCornerShape(8.dp))
                        .onSizeChanged { canvasSize = it }
                        .pointerInput(Unit) {
                            detectDragGestures(
                                onDragStart = { offset ->
                                    currentPoints = listOf(offset)
                                },
                                onDrag = { change, _ ->
                                    currentPoints = currentPoints + change.position
                                },
                                onDragEnd = {
                                    if (currentPoints.isNotEmpty()) {
                                        strokes.add(StrokePath(currentPoints))
                                    }
                                    currentPoints = emptyList()
                                }
                            )
                        }
                ) {
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        // Signature line guide
                        drawLine(
                            color = Color.LightGray,
                            start = Offset(40f, size.height * 0.75f),
                            end = Offset(size.width - 40f, size.height * 0.75f),
                            strokeWidth = 1f
                        )

                        // Completed strokes
                        strokes.forEach { stroke ->
                            if (stroke.points.size > 1) {
                                val path = Path()
                                path.moveTo(stroke.points.first().x, stroke.points.first().y)
                                stroke.points.drop(1).forEach { pt -> path.lineTo(pt.x, pt.y) }
                                drawPath(
                                    path, Color.Black,
                                    style = Stroke(width = 4f, cap = StrokeCap.Round, join = StrokeJoin.Round)
                                )
                            }
                        }

                        // Active stroke
                        if (currentPoints.size > 1) {
                            val path = Path()
                            path.moveTo(currentPoints.first().x, currentPoints.first().y)
                            currentPoints.drop(1).forEach { pt -> path.lineTo(pt.x, pt.y) }
                            drawPath(
                                path, Color.Black,
                                style = Stroke(width = 4f, cap = StrokeCap.Round, join = StrokeJoin.Round)
                            )
                        }
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    OutlinedButton(
                        onClick = {
                            strokes.clear()
                            currentPoints = emptyList()
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error
                        )
                    ) { Text("Clear") }

                    Button(
                        onClick = {
                            val allStrokes = strokes.toList()
                            val base64 = allStrokes.toBase64(canvasSize.width, canvasSize.height)
                            viewModel.onSignatureComplete(base64)
                        },
                        modifier = Modifier.weight(2f),
                        enabled = strokes.isNotEmpty()
                    ) { Text("Confirm & Pay  ${formatCents(session.totalCents)}") }
                }
            }
        }
    }
}
