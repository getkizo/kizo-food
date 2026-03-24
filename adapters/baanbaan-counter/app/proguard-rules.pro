-keep class com.finix.** { *; }
-keep class com.pax.** { *; }
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes Exceptions

# Retrofit
-dontwarn retrofit2.**
-keep class retrofit2.** { *; }

# OkHttp
-dontwarn okhttp3.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# Kotlinx Serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class org.baanbaan.counter.**$$serializer { *; }
-keepclassmembers class org.baanbaan.counter.** {
    *** Companion;
}
-keepclasseswithmembers class org.baanbaan.counter.** {
    kotlinx.serialization.KSerializer serializer(...);
}
