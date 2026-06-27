package com.dropbeam.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.dropbeam.app.data.AuthRepository
import com.dropbeam.app.network.DropBeamApi
import com.dropbeam.app.network.TailscaleManager
import com.dropbeam.app.network.FileTransferManager
import com.dropbeam.app.ui.screens.DropBeamNavHost
import com.dropbeam.app.ui.theme.DropBeamTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var authRepo: AuthRepository
    private lateinit var api: DropBeamApi
    private lateinit var tsManager: TailscaleManager
    private lateinit var transferManager: FileTransferManager

    var sharedFiles by mutableStateOf<List<Uri>>(emptyList())
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        authRepo = AuthRepository(this)
        api = DropBeamApi(authRepo)
        tsManager = TailscaleManager(this)
        transferManager = FileTransferManager(this, tsManager)

        handleIncomingIntent(intent)

        setContent {
            DropBeamTheme {
                DropBeamNavHost(
                    authRepo = authRepo,
                    api = api,
                    tsManager = tsManager,
                    transferManager = transferManager,
                    sharedFiles = sharedFiles,
                    onClearSharedFiles = { sharedFiles = emptyList() },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        when (intent.action) {
            Intent.ACTION_SEND -> {
                val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                if (uri != null) sharedFiles = listOf(uri)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                if (!uris.isNullOrEmpty()) sharedFiles = uris
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        lifecycleScope.launch { tsManager.stop() }
    }
}
