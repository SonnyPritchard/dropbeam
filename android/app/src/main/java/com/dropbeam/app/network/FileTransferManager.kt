package com.dropbeam.app.network

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

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

        val tempFile = java.io.File.createTempFile("dropbeam_send_", "_$fileName", context.cacheDir)
        try {
            inputStream.use { input ->
                tempFile.outputStream().use { output ->
                    val buf = ByteArray(65536)
                    var totalCopied = 0L
                    var n: Int
                    while (input.read(buf).also { n = it } != -1) {
                        output.write(buf, 0, n)
                        totalCopied += n
                        _activeTransfer.value = _activeTransfer.value?.copy(bytesSent = totalCopied / 2)
                    }
                }
            }

            val error = bridge.Bridge.tsnetSendFile(
                tempFile.absolutePath,
                peer.ip,
                TailscaleManager.TRANSFER_PORT.toLong(),
                fileName
            )
            if (error.isNotEmpty()) {
                return Result.failure(Exception(error))
            }
        } finally {
            tempFile.delete()
        }

        _activeTransfer.value = _activeTransfer.value?.copy(done = true, bytesSent = fileSize)
        return Result.success(Unit)
    }

    fun clearTransfer() {
        _activeTransfer.value = null
    }
}
