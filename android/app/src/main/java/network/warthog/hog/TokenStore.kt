package network.warthog.hog

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Hog address and the device token. The token is encrypted with an AES-GCM
 * key that lives in the Android Keystore and never leaves it; only the
 * ciphertext is in SharedPreferences (excluded from backups).
 */
class TokenStore(context: Context) {
    private val prefs = context.getSharedPreferences("hog", Context.MODE_PRIVATE)
    @Volatile private var cached: String? = null

    val host: String get() = prefs.getString("host", "") ?: ""
    /** hog's Tailscale IP, used when the phone cannot look up the .ts.net name. */
    val ip: String get() = prefs.getString("ip", "") ?: ""
    val port: Int get() = prefs.getInt("port", 4189)
    val paired: Boolean get() = token() != null && (host.isNotEmpty() || ip.isNotEmpty())

    @Synchronized
    fun token(): String? {
        cached?.let { return it }
        val blob = prefs.getString("token", null) ?: return null
        return try {
            decrypt(blob).also { cached = it }
        } catch (e: Exception) {
            null
        }
    }

    @Synchronized
    fun save(host: String, ip: String, port: Int, token: String) {
        prefs.edit().putString("host", host).putString("ip", ip).putInt("port", port).putString("token", encrypt(token)).apply()
        cached = token
    }

    @Synchronized
    fun forget() {
        prefs.edit().remove("token").apply()
        cached = null
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String {
        val (iv, ct) = blob.split(":", limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(ct), Charsets.UTF_8)
    }

    companion object {
        private const val ALIAS = "hog_device_token"
    }
}
