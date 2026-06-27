package com.dropbeam.app.network

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.util.concurrent.TimeUnit

/**
 * Sends files to mesh peers over HTTP and receives files via an embedded HTTP server.
 *
 * Send: POST http://<peerTailscaleIP>:47822/receive  (multipart/form-data)
 * Receive: The Go bridge runs an HTTP server on :47822 that accepts POSTs
 *          and writes files to the Downloads directory.
 *
 * This replaces the old WebRTC transfer and the Tailscale `file cp` CLI approach.
 * Both PC and Android will use this HTTP protocol once the PC app is updated.
 */
class FileTransferManager(
    private val context: Context,
    private val tsManager: TailscaleManager,
) {
    data class TransferProgress(
        val fileName: String,
        val peerName: String,
        val bytesSent: Long,
        val totalBytes: Long,
        val done: Boolean = false,
        val error: String? = null,
    ) {
        val percent: Int get() = if (totalBytes > 0) ((bytesSent * 100) / totalBytes).toInt() else 0
    }

    private val _activeTransfer = MutableStateFlow<TransferProgress?>(null)
    val activeTransfer: StateFlow<TransferProgress?> = _activeTransfer.asStateFlow()

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    suspend fun sendFiles(uris: List<Uri>, peer: TailscaleManager.MeshPeer): Result<Unit> {
        return withContext(Dispatchers.IO) {
            try {
                for (uri in uris) {
                    sendSingleFile(uri, peer).getOrThrow()
                }
                Result.success(Unit)
            } catch (e: Exception) {
                _activeTransfer.value = _activeTransfer.value?.copy(error = e.message, done = true)
                Result.failure(e)
            }
        }
    }

    private suspend fun sendSingleFile(uri: Uri, peer: TailscaleManager.MeshPeer): Result<Unit> {
        val resolver = context.contentResolver
        val cursor = resolver.query(uri, null, null, null, null)
        var fileName = "file"
        var fileSize = 0L
        cursor?.use {
            if (it.moveToFirst()) {
                val nameIdx = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIdx = it.getColumnIndex(OpenableColumns.SIZE)
                if (nameIdx >= 0) fileName = it.getString(nameIdx) ?: "file"
                if (sizeIdx >= 0) fileSize = it.getLong(sizeIdx)
            }
        }

        _activeTransfer.value = TransferProgress(
            fileName = fileName,
            peerName = peer.name,
            bytesSent = 0,
            totalBytes = fileSize,
        )

        val inputStream = resolver.openInputStream(uri)
            ?: return Result.failure(Exception("Cannot read file"))

        val requestBody = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = fileSize

            override fun writeTo(sink: BufferedSink) {
                inputStream.source().use { source ->
                    var totalSent = 0L
                    val buffer = okio.Buffer()
                    var read: Long
                    while (source.read(buffer, CHUNK_SIZE).also { read = it } != -1L) {
                        sink.write(buffer, read)
                        totalSent += read
                        _activeTransfer.value = _activeTransfer.value?.copy(bytesSent = totalSent)
                    }
                }
            }
        }

        val multipartBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, requestBody)
            .build()

        val url = "http://${peer.ip}:${TailscaleManager.TRANSFER_PORT}/receive"
        val request = Request.Builder()
            .url(url)
            .post(multipartBody)
            .header("X-DropBeam-Sender", tsManager.status.value.selfIp)
            .build()

        val response = client.newCall(request).execute()
        if (!response.isSuccessful) {
            return Result.failure(Exception("Transfer failed: ${response.code}"))
        }

        _activeTransfer.value = _activeTransfer.value?.copy(done = true, bytesSent = fileSize)
        return Result.success(Unit)
    }

    fun clearTransfer() {
        _activeTransfer.value = null
    }

    companion object {
        private const val CHUNK_SIZE = 65_536L
    }
}
