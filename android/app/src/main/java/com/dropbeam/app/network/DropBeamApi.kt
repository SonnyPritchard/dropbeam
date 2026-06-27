package com.dropbeam.app.network

import com.dropbeam.app.data.AuthRepository
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class DropBeamApi(private val authRepo: AuthRepository) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val gson = Gson()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    data class AuthResponse(val token: String, val user: UserInfo)
    data class UserInfo(val id: String?, val name: String, val email: String)
    data class RegisterResponse(val preAuthKey: String, val headscaleUrl: String)

    suspend fun signup(name: String, email: String, password: String): Result<AuthResponse> =
        post("/auth/signup", mapOf("name" to name, "email" to email, "password" to password))

    suspend fun login(email: String, password: String): Result<AuthResponse> =
        post("/auth/login", mapOf("email" to email, "password" to password))

    suspend fun registerDevice(): Result<RegisterResponse> {
        val token = authRepo.getToken() ?: return Result.failure(Exception("Not authenticated"))
        val serverUrl = authRepo.getServerUrl()
        return withContext(Dispatchers.IO) {
            try {
                val request = Request.Builder()
                    .url("$serverUrl/devices/register")
                    .post("{}".toRequestBody(jsonType))
                    .header("Authorization", "Bearer $token")
                    .build()
                val response = client.newCall(request).execute()
                val body = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    return@withContext Result.failure(Exception("Registration failed: ${response.code} $body"))
                }
                Result.success(gson.fromJson(body, RegisterResponse::class.java))
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
    }

    private suspend inline fun <reified T> post(path: String, payload: Any): Result<T> {
        val serverUrl = authRepo.getServerUrl()
        return withContext(Dispatchers.IO) {
            try {
                val json = gson.toJson(payload)
                val request = Request.Builder()
                    .url("$serverUrl$path")
                    .post(json.toRequestBody(jsonType))
                    .build()
                val response = client.newCall(request).execute()
                val body = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    return@withContext Result.failure(Exception(extractError(body, response.code)))
                }
                Result.success(gson.fromJson(body, T::class.java))
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
    }

    private fun extractError(body: String, code: Int): String {
        return try {
            val map = gson.fromJson(body, Map::class.java)
            (map["error"] as? String) ?: "Request failed ($code)"
        } catch (_: Exception) {
            "Request failed ($code)"
        }
    }
}
