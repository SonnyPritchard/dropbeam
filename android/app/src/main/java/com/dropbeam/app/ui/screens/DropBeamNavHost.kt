package com.dropbeam.app.ui.screens

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.dropbeam.app.data.AuthRepository
import com.dropbeam.app.network.DropBeamApi
import com.dropbeam.app.network.TailscaleManager
import com.dropbeam.app.network.FileTransferManager

@Composable
fun DropBeamNavHost(
    authRepo: AuthRepository,
    api: DropBeamApi,
    tsManager: TailscaleManager,
    transferManager: FileTransferManager,
    sharedFiles: List<Uri>,
    onClearSharedFiles: () -> Unit,
) {
    val navController = rememberNavController()
    val isLoggedIn by authRepo.isLoggedIn.collectAsState(initial = false)

    val startDest = if (isLoggedIn) "main" else "login"

    NavHost(navController = navController, startDestination = startDest) {
        composable("login") {
            LoginScreen(
                api = api,
                authRepo = authRepo,
                onLoginSuccess = {
                    navController.navigate("main") {
                        popUpTo("login") { inclusive = true }
                    }
                },
            )
        }
        composable("main") {
            MainScreen(
                authRepo = authRepo,
                api = api,
                tsManager = tsManager,
                transferManager = transferManager,
                sharedFiles = sharedFiles,
                onClearSharedFiles = onClearSharedFiles,
                onSignOut = {
                    navController.navigate("login") {
                        popUpTo("main") { inclusive = true }
                    }
                },
            )
        }
    }
}
