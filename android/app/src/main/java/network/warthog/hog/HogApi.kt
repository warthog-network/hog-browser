package network.warthog.hog

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** HTTP to hog's phone API (/m/v1/...) over the tailnet. */
class HogApi(private val store: TokenStore) {
    class Resp(val status: Int, val text: String)

    fun url(host: String, port: Int, route: String): URL = URL("http://$host:$port/m/v1/$route")

    /** A connection to an authenticated route. Throws if this phone is not paired. */
    fun open(method: String, route: String, timeoutMs: Int = 15_000): HttpURLConnection {
        val token = store.token() ?: throw IOException("not paired")
        val host = store.host
        Tailnet.problem(host, store.port)?.let { throw IOException(it) }
        val conn = url(host, store.port, route).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 10_000
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Accept", "application/json, */*")
        return conn
    }

    fun read(conn: HttpURLConnection): Resp {
        val status = conn.responseCode
        val stream = if (status >= 400) conn.errorStream else conn.inputStream
        val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        return Resp(status, text)
    }

    /** POST JSON to a route that changes something. */
    fun postJson(route: String, body: String): Resp {
        val conn = open("POST", route, timeoutMs = 120_000)
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("x-hog-files", "1")
        val bytes = body.toByteArray(Charsets.UTF_8)
        conn.setFixedLengthStreamingMode(bytes.size)
        conn.outputStream.use { it.write(bytes) }
        return try { read(conn) } finally { conn.disconnect() }
    }

    /** Pairing needs no token: trade hog's one-time code for one. */
    fun pair(host: String, port: Int, code: String, deviceName: String): Resp {
        val conn = url(host, port, "pair").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 10_000
        conn.readTimeout = 20_000
        conn.instanceFollowRedirects = false
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        val body = org.json.JSONObject().put("code", code).put("name", deviceName).toString().toByteArray()
        conn.setFixedLengthStreamingMode(body.size)
        conn.outputStream.use { it.write(body) }
        return try { read(conn) } finally { conn.disconnect() }
    }
}
