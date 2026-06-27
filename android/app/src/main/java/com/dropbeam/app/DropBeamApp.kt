package com.dropbeam.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class DropBeamApp : Application() {
    override fun onCreate() {
        super.onCreate()

        val channel = NotificationChannel(
            "transfers",
            "File Transfers",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Active file transfer progress"
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }
}
