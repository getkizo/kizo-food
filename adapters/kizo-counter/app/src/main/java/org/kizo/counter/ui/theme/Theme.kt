package org.kizo.counter.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColorScheme = lightColorScheme(
    primary = KizoGreen,
    onPrimary = androidx.compose.ui.graphics.Color.White,
    primaryContainer = KizoGreenLight,
    secondary = KizoAmber,
    background = SurfaceLight,
    surface = androidx.compose.ui.graphics.Color.White,
    onBackground = OnSurfaceDark,
    onSurface = OnSurfaceDark,
    error = KizoRed
)

@Composable
fun KizoCounterTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColorScheme,
        typography = KizoTypography,
        content = content
    )
}
