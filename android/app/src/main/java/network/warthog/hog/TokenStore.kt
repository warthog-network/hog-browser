package network.warthog.hog

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Paired hogs and their device tokens. One phone can pair several computers.
 * Each token is encrypted with an AES-GCM key that lives in the Android
 * Keystore and never leaves it; only ciphertext is in SharedPreferences
 * (excluded from backups). The selected hog is what the rest of the app calls.
 *
 * An older install stored one host, ip, port, and token. The first read
 * copies that into the list so the existing pairing is kept.
 */
class TokenStore(context: Context) {
    class Hog(
        val id: String,
        val host: String,
        val ip: String,
        val port: Int,
        val label: String,
    )

    private class Stored(
        val id: String,
        var host: String,
        var ip: String,
        var port: Int,
        var tokenBlob: String,
        var label: String,
    ) {
        fun view() = Hog(id, host, ip, port, label.ifEmpty { host.ifEmpty { ip } })
    }

    private val prefs = context.getSharedPreferences("hog", Context.MODE_PRIVATE)
    private val lock = Any()
    private val profiles = mutableListOf<Stored>()
    private val tokens = mutableMapOf<String, String>()
    private var currentId: String = ""

    init {
        load()
    }

    val host: String get() = synchronized(lock) { current()?.host ?: "" }
    /** Selected hog's Tailscale IP, used when the phone cannot look up the .ts.net name. */
    val ip: String get() = synchronized(lock) { current()?.ip ?: "" }
    val port: Int get() = synchronized(lock) { current()?.port ?: 4189 }
    val paired: Boolean get() = synchronized(lock) {
        val cur = current() ?: return false
        (cur.host.isNotEmpty() || cur.ip.isNotEmpty()) && tokenUnlocked(cur) != null
    }

    fun id(): String = synchronized(lock) { currentId }

    fun list(): List<Hog> = synchronized(lock) { profiles.map { it.view() } }

    /** The paired hog the other computers mine to. Empty until the phone picks one. */
    fun nodeId(): String = synchronized(lock) {
        val id = prefs.getString(KEY_NODE, "") ?: ""
        if (id.isNotEmpty() && profiles.any { it.id == id }) id else ""
    }

    fun nodePort(): Int = synchronized(lock) {
        val port = prefs.getInt(KEY_NODE_PORT, 3456)
        if (port in 1..65535) port else 3456
    }

    /** Address shown for the node. The Tailscale IP when the phone has one. */
    fun nodeHost(): String = synchronized(lock) {
        if (nodeId().isEmpty()) return ""
        prefs.getString(KEY_NODE_HOST, "") ?: ""
    }

    /**
     * Mark a paired hog as the mining node. host is its Tailscale IP or .ts.net
     * name. An empty id clears the choice.
     */
    fun setNode(id: String, port: Int, host: String): Boolean = synchronized(lock) {
        if (id.isEmpty()) {
            prefs.edit().remove(KEY_NODE).remove(KEY_NODE_HOST).putInt(KEY_NODE_PORT, 3456).commit()
            return true
        }
        val row = profiles.find { it.id == id } ?: return false
        val picked = host.trim().lowercase()
        val allowed = picked.isEmpty() || picked == row.host || picked == row.ip || Tailnet.isIp(picked) || Tailnet.isTsName(picked)
        if (!allowed) return false
        val shown = picked.ifEmpty { row.ip.ifEmpty { row.host } }
        val stratum = if (port in 1..65535) port else 3456
        prefs.edit().putString(KEY_NODE, id).putString(KEY_NODE_HOST, shown).putInt(KEY_NODE_PORT, stratum).commit()
        true
    }

    /** True when saving this address updates one already paired, or the list still has room. */
    fun canSave(host: String, ip: String, port: Int): Boolean = synchronized(lock) {
        findMatch(host, ip, port) >= 0 || profiles.size < MAX_HOGS
    }

    fun token(): String? = synchronized(lock) { tokenUnlocked(current()) }

    /**
     * Add this hog, or refresh the token when the same computer is paired again.
     * Same computer means the same port and the same name or the same Tailscale IP.
     * The saved hog becomes the selected one. Returns its id.
     */
    fun save(host: String, ip: String, port: Int, token: String): String = synchronized(lock) {
        val h = host.trim().lowercase()
        val i = ip.trim().lowercase()
        val idx = findMatch(h, i, port)
        val blob = encrypt(token)
        val id = if (idx >= 0) {
            val row = profiles[idx]
            if (h.isNotEmpty()) row.host = h
            if (i.isNotEmpty()) row.ip = i
            row.port = port
            row.tokenBlob = blob
            row.label = row.host.ifEmpty { row.ip }
            tokens[row.id] = token
            row.id
        } else {
            if (profiles.size >= MAX_HOGS) throw IllegalStateException("too many hogs")
            val fresh = newId()
            profiles.add(Stored(fresh, h, i, port, blob, h.ifEmpty { i }))
            tokens[fresh] = token
            fresh
        }
        currentId = id
        persist()
        id
    }

    /** Switch the hog the app talks to. Returns whether the selection changed. */
    fun select(id: String): Boolean = synchronized(lock) {
        if (profiles.none { it.id == id }) return false
        if (currentId == id) return false
        currentId = id
        persist()
        true
    }

    /**
     * Remove the selected hog. When others remain, the first one is selected.
     * Returns whether a hog is still selected.
     */
    fun forget(): Boolean = synchronized(lock) {
        val target = currentId
        if (target.isEmpty()) return profiles.isNotEmpty()
        profiles.removeAll { it.id == target }
        tokens.remove(target)
        if ((prefs.getString(KEY_NODE, "") ?: "") == target) {
            prefs.edit().remove(KEY_NODE).remove(KEY_NODE_HOST).commit()
        }
        currentId = profiles.firstOrNull()?.id ?: ""
        persist()
        currentId.isNotEmpty() && current() != null
    }

    private fun current(): Stored? = profiles.find { it.id == currentId }

    private fun load() = synchronized(lock) {
        val raw = prefs.getString(KEY_PROFILES, null)
        if (raw != null) {
            try {
                val arr = JSONArray(raw)
                for (n in 0 until arr.length()) {
                    val o = arr.getJSONObject(n)
                    val id = o.optString("id")
                    if (id.isEmpty()) continue
                    profiles.add(
                        Stored(
                            id,
                            o.optString("host").trim().lowercase(),
                            o.optString("ip").trim().lowercase(),
                            o.optInt("port", 4189),
                            o.optString("token"),
                            o.optString("label"),
                        )
                    )
                }
            } catch (e: Exception) {
                profiles.clear()
            }
            currentId = prefs.getString(KEY_CURRENT, "") ?: ""
            if (profiles.none { it.id == currentId }) currentId = profiles.firstOrNull()?.id ?: ""
            keepOneThatUnlocks()
            return
        }
        val legacyToken = prefs.getString("token", null)
        val legacyHost = prefs.getString("host", "") ?: ""
        val legacyIp = prefs.getString("ip", "") ?: ""
        val legacyPort = prefs.getInt("port", 4189)
        if (legacyToken != null && (legacyHost.isNotEmpty() || legacyIp.isNotEmpty())) {
            val id = newId()
            profiles.add(
                Stored(
                    id,
                    legacyHost.trim().lowercase(),
                    legacyIp.trim().lowercase(),
                    legacyPort,
                    legacyToken,
                    legacyHost.trim().lowercase().ifEmpty { legacyIp.trim().lowercase() },
                )
            )
            currentId = id
            persist()
        }
    }

    /** If the selected token cannot be decrypted, select another hog that can. */
    private fun keepOneThatUnlocks() {
        if (tokenUnlocked(current()) != null) return
        val next = profiles.firstOrNull { tokenUnlocked(it) != null } ?: return
        currentId = next.id
        persist()
    }

    private fun tokenUnlocked(row: Stored?): String? {
        if (row == null || row.tokenBlob.isEmpty()) return null
        tokens[row.id]?.let { return it }
        return try {
            decrypt(row.tokenBlob).also { tokens[row.id] = it }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Same port, and the same Tailscale IP or the same .ts.net name.
     * A later pair fills in whichever of the name or IP was missing.
     */
    private fun findMatch(host: String, ip: String, port: Int): Int {
        if (ip.isNotEmpty()) {
            val byIp = profiles.indexOfFirst { it.port == port && it.ip == ip }
            if (byIp >= 0) return byIp
        }
        if (host.isNotEmpty()) {
            val byHost = profiles.indexOfFirst { it.port == port && it.host == host }
            if (byHost >= 0) return byHost
        }
        return -1
    }

    private fun newId(): String {
        val bytes = ByteArray(8)
        random.nextBytes(bytes)
        val id = bytes.joinToString("") { "%02x".format(it) }
        return if (profiles.any { it.id == id }) newId() else id
    }

    private fun persist() {
        val arr = JSONArray()
        for (row in profiles) {
            arr.put(
                JSONObject()
                    .put("id", row.id)
                    .put("host", row.host)
                    .put("ip", row.ip)
                    .put("port", row.port)
                    .put("token", row.tokenBlob)
                    .put("label", row.label)
            )
        }
        prefs.edit()
            .putString(KEY_PROFILES, arr.toString())
            .putString(KEY_CURRENT, currentId)
            .remove("host")
            .remove("ip")
            .remove("port")
            .remove("token")
            .commit()
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
        const val MAX_HOGS = 8
        private const val ALIAS = "hog_device_token"
        private const val KEY_PROFILES = "profiles"
        private const val KEY_CURRENT = "current"
        private const val KEY_NODE = "node"
        private const val KEY_NODE_HOST = "nodeHost"
        private const val KEY_NODE_PORT = "nodePort"
        private val random = SecureRandom()
    }
}
