package com.zayedai.lazaynova.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** Stores only an authenticated session token and API origin, encrypted with a non-exportable Keystore key. */
class EncryptedSessionStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun save(baseUrl: String, bearerToken: String) {
        require(baseUrl.startsWith("https://"))
        require(bearerToken.isNotBlank())
        val payload = JSONObject()
            .put("baseUrl", baseUrl)
            .put("bearerToken", bearerToken)
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(payload)
        val packed = cipher.iv + encrypted
        check(preferences.edit().putString(ENCRYPTED_SESSION, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
            "Could not securely store the Lazaynova session."
        }
    }

    @Synchronized
    fun load(): StoredSession? {
        val encoded = preferences.getString(ENCRYPTED_SESSION, null) ?: return null
        return try {
            val packed = Base64.decode(encoded, Base64.NO_WRAP)
            require(packed.size > GCM_IV_BYTES)
            val iv = packed.copyOfRange(0, GCM_IV_BYTES)
            val ciphertext = packed.copyOfRange(GCM_IV_BYTES, packed.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            val cleartext = cipher.doFinal(ciphertext).toString(StandardCharsets.UTF_8)
            val json = JSONObject(cleartext)
            val baseUrl = json.getString("baseUrl")
            val bearerToken = json.getString("bearerToken")
            if (!baseUrl.startsWith("https://") || bearerToken.isBlank()) throw IllegalStateException("Invalid stored session.")
            StoredSession(baseUrl, bearerToken)
        } catch (_: Exception) {
            runCatching { clear() }
            null
        }
    }

    @Synchronized
    fun clear() {
        check(preferences.edit().remove(ENCRYPTED_SESSION).commit()) {
            "Could not clear the stored Lazaynova session."
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    data class StoredSession(val baseUrl: String, val bearerToken: String)

    private companion object {
        const val PREFERENCES = "lazaynova_secure_session"
        const val ENCRYPTED_SESSION = "encrypted_session_v1"
        const val KEY_ALIAS = "com.zayedai.lazaynova.session.v1"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_IV_BYTES = 12
        const val GCM_TAG_BITS = 128
    }
}
