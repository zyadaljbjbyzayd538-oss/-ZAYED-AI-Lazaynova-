package com.zayedai.lazaynova.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

enum class LazaynovaThemeMode(val label: String) {
    DARK("داكن"),
    LIGHT("فاتح"),
    CYBERPUNK("Cyberpunk"),
}

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF7C3AED),
    onPrimary = Color.White,
    primaryContainer = Color(0xFF38235F),
    onPrimaryContainer = Color(0xFFE9DDFF),
    secondary = Color(0xFF3B82F6),
    onSecondary = Color(0xFF07182D),
    tertiary = Color(0xFF5EEAD4),
    background = Color(0xFF0A0C14),
    onBackground = Color(0xFFF4F2FA),
    surface = Color(0xFF121526),
    onSurface = Color(0xFFF4F2FA),
    surfaceVariant = Color(0xFF20243A),
    onSurfaceVariant = Color(0xFFB7B9CC),
    outline = Color(0xFF555B75),
)

private val CyberpunkScheme = darkColorScheme(
    primary = Color(0xFFC084FC),
    onPrimary = Color(0xFF241137),
    primaryContainer = Color(0xFF42205F),
    onPrimaryContainer = Color(0xFFF4E7FF),
    secondary = Color(0xFF38BDF8),
    onSecondary = Color(0xFF07182D),
    tertiary = Color(0xFFF472B6),
    background = Color(0xFF0A0C14),
    onBackground = Color(0xFFF4F2FA),
    surface = Color(0xFF101020),
    onSurface = Color(0xFFF4F2FA),
    surfaceVariant = Color(0xFF211B3A),
    onSurfaceVariant = Color(0xFFC3BCD5),
    outline = Color(0xFF65537E),
)

private val LightScheme = lightColorScheme(
    primary = Color(0xFF6D28D9),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEBDDFF),
    onPrimaryContainer = Color(0xFF26005A),
    secondary = Color(0xFF2563EB),
    onSecondary = Color.White,
    tertiary = Color(0xFF0F766E),
    background = Color(0xFFF5F4FA),
    onBackground = Color(0xFF181622),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF181622),
    surfaceVariant = Color(0xFFE9E7F2),
    onSurfaceVariant = Color(0xFF545365),
    outline = Color(0xFF777587),
)

@Composable
fun LazaynovaTheme(mode: LazaynovaThemeMode, content: @Composable () -> Unit) {
    val colors = when (mode) {
        LazaynovaThemeMode.DARK -> DarkScheme
        LazaynovaThemeMode.LIGHT -> LightScheme
        LazaynovaThemeMode.CYBERPUNK -> CyberpunkScheme
    }
    MaterialTheme(colorScheme = colors, content = content)
}
