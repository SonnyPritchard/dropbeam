package com.dropbeam.app.network

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the Tailscale node alive and the HTTP receive
 * server running while the app is in the background. Started when the user
 * connects to the mesh, stopped when they sign out or force-quit.
 */
class TransferService : Service() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, "transfers")
            .setContentTitle("DropBeam")
            .setContentText("Connected to mesh — ready to receive files")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()

        startForeground(1, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
