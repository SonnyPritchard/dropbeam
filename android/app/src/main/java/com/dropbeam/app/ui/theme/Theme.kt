package com.dropbeam.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Bg = Color(0xFF08080F)
val BgElevated = Color(0xFF0E0E18)
val Surface = Color(0xFF14141F)
val SurfaceVariant = Color(0xFF1A1A28)
val Accent = Color(0xFF00FF88)
val AccentDim = Color(0x2400FF88)
val Accent2 = Color(0xFF00D4FF)
val Accent2Dim = Color(0x2400D4FF)
val TextPrimary = Color(0xFFE8FFE8)
val TextSecondary = Color(0xA6DCFFDC)
val TextMuted = Color(0x73C8FFC8)
val TextDim = Color(0x38C8FFC8)
val Border = Color(0x1FFFFFFF)
val Border2 = Color(0x1FFFFFFF)
val Danger = Color(0xFFFF4455)
val Warn = Color(0xFFFF6B35)
val Success = Color(0xFF00FF88)

private val DarkColorScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color.Black,
    secondary = Accent2,
    onSecondary = Color.Black,
    background = Bg,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceVariant,
    onSurfaceVariant = TextSecondary,
    error = Danger,
    onError = Color.White,
    outline = Border2,
)

private val DropBeamTypography = Typography(
    headlineLarge = TextStyle(
        fontWeight = FontWeight.Bold,
        fontSize = 28.sp,
        color = TextPrimary,
    ),
    headlineMedium = TextStyle(
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        color = TextPrimary,
    ),
    titleLarge = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        color = TextPrimary,
    ),
    titleMedium = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        color = TextPrimary,
    ),
    bodyLarge = TextStyle(
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        color = TextSecondary,
    ),
    bodyMedium = TextStyle(
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        color = TextSecondary,
    ),
    labelLarge = TextStyle(
        fontWeight = FontWeight.Bold,
        fontSize = 14.sp,
        letterSpacing = 0.8.sp,
    ),
    labelMedium = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 12.sp,
        letterSpacing = 0.5.sp,
        color = TextMuted,
    ),
    labelSmall = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 10.sp,
        letterSpacing = 0.8.sp,
        color = TextDim,
    ),
)

@Composable
fun DropBeamTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = DropBeamTypography,
        content = content,
    )
}
