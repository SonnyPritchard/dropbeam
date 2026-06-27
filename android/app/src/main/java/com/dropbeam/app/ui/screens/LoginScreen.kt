package com.dropbeam.app.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dropbeam.app.data.AuthRepository
import com.dropbeam.app.network.DropBeamApi
import com.dropbeam.app.ui.theme.*
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(
    api: DropBeamApi,
    authRepo: AuthRepository,
    onLoginSuccess: () -> Unit,
) {
    var isSignUp by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var serverUrl by remember { mutableStateOf(AuthRepository.DEFAULT_SERVER_URL) }
    var showServerConfig by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current

    fun submit() {
        if (loading) return
        if (email.isBlank() || password.isBlank()) {
            error = "Please fill in all fields"
            return
        }
        if (isSignUp && name.isBlank()) {
            error = "Please enter your name"
            return
        }
        loading = true
        error = null
        scope.launch {
            authRepo.saveServerUrl(serverUrl)
            val result = if (isSignUp) {
                api.signup(name.trim(), email.trim(), password)
            } else {
                api.login(email.trim(), password)
            }
            result.fold(
                onSuccess = { auth ->
                    authRepo.saveAuth(auth.token, auth.user.name, auth.user.email)
                    onLoginSuccess()
                },
                onFailure = { e ->
                    error = e.message ?: "Something went wrong"
                    loading = false
                },
            )
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Bg)
            .systemBarsPadding(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 400.dp)
                .padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Logo
            Text(
                text = "⚡",
                fontSize = 40.sp,
                modifier = Modifier.padding(bottom = 8.dp),
            )
            Text(
                text = "DROPBEAM",
                style = MaterialTheme.typography.headlineMedium.copy(
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 3.sp,
                    color = Accent,
                ),
            )
            Text(
                text = "Peer-to-peer file transfer",
                style = MaterialTheme.typography.bodyMedium,
                color = TextMuted,
                modifier = Modifier.padding(top = 4.dp, bottom = 36.dp),
            )

            // Tab toggle
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = Surface,
                border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
                    brush = Brush.linearGradient(listOf(Border2, Border2))
                ),
            ) {
                Row(modifier = Modifier.fillMaxWidth()) {
                    TabButton("Sign In", !isSignUp) { isSignUp = false; error = null }
                    TabButton("Create Account", isSignUp) { isSignUp = true; error = null }
                }
            }

            Spacer(Modifier.height(24.dp))

            // Name field (sign up only)
            AnimatedVisibility(visible = isSignUp) {
                Column {
                    InputField(
                        value = name,
                        onValueChange = { name = it },
                        label = "Your Name",
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                        keyboardActions = KeyboardActions(
                            onNext = { focusManager.moveFocus(FocusDirection.Down) }
                        ),
                    )
                    Spacer(Modifier.height(14.dp))
                }
            }

            InputField(
                value = email,
                onValueChange = { email = it },
                label = "Email",
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Next,
                ),
                keyboardActions = KeyboardActions(
                    onNext = { focusManager.moveFocus(FocusDirection.Down) }
                ),
            )

            Spacer(Modifier.height(14.dp))

            InputField(
                value = password,
                onValueChange = { password = it },
                label = "Password",
                isPassword = true,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { submit() }),
            )

            Spacer(Modifier.height(20.dp))

            // Submit button
            Button(
                onClick = { submit() },
                enabled = !loading,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Accent,
                    contentColor = Color.Black,
                    disabledContainerColor = Accent.copy(alpha = 0.4f),
                ),
            ) {
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        color = Color.Black,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(
                        text = if (isSignUp) "Create Account" else "Sign In",
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                    )
                }
            }

            // Error
            AnimatedVisibility(visible = error != null) {
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 16.dp),
                    shape = RoundedCornerShape(10.dp),
                    color = Danger.copy(alpha = 0.12f),
                    border = ButtonDefaults.outlinedButtonBorder(enabled = true).copy(
                        brush = Brush.linearGradient(listOf(Danger, Danger))
                    ),
                ) {
                    Text(
                        text = error ?: "",
                        color = Danger,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            // Server config toggle
            Spacer(Modifier.height(24.dp))
            TextButton(onClick = { showServerConfig = !showServerConfig }) {
                Text(
                    text = if (showServerConfig) "Hide server settings" else "Server settings",
                    color = TextDim,
                    fontSize = 12.sp,
                )
            }
            AnimatedVisibility(visible = showServerConfig) {
                Column(modifier = Modifier.padding(top = 8.dp)) {
                    InputField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        label = "Server URL",
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Done,
                        ),
                    )
                }
            }

            Spacer(Modifier.height(20.dp))
            Text(
                text = "Your files never touch our servers · Peer-to-peer",
                style = MaterialTheme.typography.labelSmall,
                color = TextDim,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun RowScope.TabButton(label: String, selected: Boolean, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier
            .weight(1f)
            .background(if (selected) Accent else Color.Transparent),
        shape = RoundedCornerShape(0.dp),
    ) {
        Text(
            text = label,
            color = if (selected) Color.Black else TextMuted,
            fontWeight = FontWeight.SemiBold,
            fontSize = 14.sp,
        )
    }
}

@Composable
private fun InputField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    isPassword: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    Column {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = TextMuted,
            modifier = Modifier.padding(bottom = 6.dp),
        )
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = if (isPassword) PasswordVisualTransformation() else
                androidx.compose.ui.text.input.VisualTransformation.None,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Accent,
                unfocusedBorderColor = Border2,
                focusedContainerColor = SurfaceVariant,
                unfocusedContainerColor = SurfaceVariant,
                cursorColor = Accent,
                focusedTextColor = TextPrimary,
                unfocusedTextColor = TextPrimary,
            ),
        )
    }
}
