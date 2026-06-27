# Keep the Go bridge JNI methods
-keep class bridge.** { *; }
-keep class go.** { *; }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }

# Gson
-keep class com.dropbeam.app.network.DropBeamApi$* { *; }
