package com.dropbeam.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "dropbeam_auth")

class AuthRepository(private val context: Context) {

    private val tokenKey = stringPreferencesKey("jwt_token")
    private val userNameKey = stringPreferencesKey("user_name")
    private val userEmailKey = stringPreferencesKey("user_email")
    private val serverUrlKey = stringPreferencesKey("server_url")

    val isLoggedIn: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[tokenKey] != null
    }

    val userName: Flow<String?> = context.dataStore.data.map { it[userNameKey] }

    suspend fun getToken(): String? =
        context.dataStore.data.first()[tokenKey]

    suspend fun getServerUrl(): String =
        context.dataStore.data.first()[serverUrlKey] ?: DEFAULT_SERVER_URL

    suspend fun saveAuth(token: String, name: String, email: String) {
        context.dataStore.data.first()
        context.dataStore.edit { prefs ->
            prefs[tokenKey] = token
            prefs[userNameKey] = name
            prefs[userEmailKey] = email
        }
    }

    suspend fun saveServerUrl(url: String) {
        context.dataStore.edit { prefs ->
            prefs[serverUrlKey] = url.trimEnd('/')
        }
    }

    suspend fun clear() {
        context.dataStore.edit { it.clear() }
    }

    companion object {
        const val DEFAULT_SERVER_URL = "http://109.155.116.11:3001"
    }
}
