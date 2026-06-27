package com.dropbeam.app.network

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Manages the embedded Tailscale node via the Go bridge library (libtailscale.aar).
 *
 * The Go bridge exposes these JNI functions (see tailscale-bridge/bridge.go):
 *   - TsnetStart(dataDir, controlURL, authKey, hostname) -> error string
 *   - TsnetStop()
 *   - TsnetGetIP() -> string (this node's Tailscale IP)
 *   - TsnetGetPeers() -> JSON string of [{name, ip, online, os}]
 *   - TsnetStartHTTPServer(port) -> error string (file receive server)
 *
 * Until the .aar is built, this class provides the integration structure
 * with TODO markers where native calls go.
 */
class TailscaleManager(private val context: Context) {

    data class MeshPeer(
        val name: String,
        val ip: String,
        val online: Boolean,
        val os: String,
    )

    enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

    data class Status(
        val state: ConnectionState = ConnectionState.DISCONNECTED,
        val selfIp: String = "",
        val error: String? = null,
    )

    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _peers = MutableStateFlow<List<MeshPeer>>(emptyList())
    val peers: StateFlow<List<MeshPeer>> = _peers.asStateFlow()

    private var pollJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    suspend fun start(controlUrl: String, authKey: String, hostname: String) {
        _status.value = Status(state = ConnectionState.CONNECTING)

        withContext(Dispatchers.IO) {
            try {
                val dataDir = context.filesDir.resolve("tailscale").absolutePath

                // --- Go bridge call ---
                // val error = Tailscale.tsnetStart(dataDir, controlUrl, authKey, hostname)
                // if (error.isNotEmpty()) throw Exception(error)
                // val selfIp = Tailscale.tsnetGetIP()
                // Tailscale.tsnetStartHTTPServer(TRANSFER_PORT)
                // TODO: Replace above with actual JNI calls once libtailscale.aar is built

                val selfIp = "" // placeholder
                _status.value = Status(state = ConnectionState.CONNECTED, selfIp = selfIp)

                startPeerPolling()
            } catch (e: Exception) {
                _status.value = Status(state = ConnectionState.ERROR, error = e.message)
            }
        }
    }

    suspend fun stop() {
        pollJob?.cancel()
        pollJob = null
        withContext(Dispatchers.IO) {
            try {
                // Tailscale.tsnetStop()
                // TODO: JNI call
            } catch (_: Exception) {}
        }
        _status.value = Status()
        _peers.value = emptyList()
    }

    private fun startPeerPolling() {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                try {
                    // val json = Tailscale.tsnetGetPeers()
                    // val peers = parsePeers(json)
                    // _peers.value = peers
                    // TODO: JNI call — parse JSON array of peers
                } catch (_: Exception) {}
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    companion object {
        const val POLL_INTERVAL_MS = 8_000L
        const val TRANSFER_PORT = 47822
    }
}
