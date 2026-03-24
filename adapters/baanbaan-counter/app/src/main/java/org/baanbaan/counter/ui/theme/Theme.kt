package org.baanbaan.counter.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColorScheme = lightColorScheme(
    primary = BaanBaanGreen,
    onPrimary = androidx.compose.ui.graphics.Color.White,
    primaryContainer = BaanBaanGreenLight,
    secondary = BaanBaanAmber,
    background = SurfaceLight,
    surface = androidx.compose.ui.graphics.Color.White,
    onBackground = OnSurfaceDark,
    onSurface = OnSurfaceDark,
    error = BaanBaanRed
)

@Composable
fun BaanBaanCounterTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColorScheme,
        typography = BaanBaanTypography,
        content = content
    )
}
