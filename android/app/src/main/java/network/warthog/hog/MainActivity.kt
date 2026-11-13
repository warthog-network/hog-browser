package network.warthog.hog

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import com.google.zxing.integration.android.IntentIntegrator
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.SecureRandom
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var store: TokenStore
    private lateinit var api: HogApi
    private lateinit var assets: WebViewAssetLoader
    private val io = Executors.newFixedThreadPool(4)
    private val main = Handler(Looper.getMainLooper())
    private var pageReady = false
    private var pendingScan: String? = null
    private var uploadTarget: Pair<String, String>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = TokenStore(this)
        api = HogApi(store)
        assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this)
        web.setBackgroundColor(0xFF050505.toInt())
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.scheme != "https" || url.host != APP_HOST) return blocked()
                val path = url.path ?: ""
                if (path.startsWith("/hog/")) return proxy(request)
                return assets.shouldInterceptRequest(url) ?: blocked()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == APP_HOST) return false
                openExternal(url.toString())
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pendingScan?.let { deliverScan(it) }
                pendingScan = null
            }
        }
        web.addJavascriptInterface(Bridge(), "HogNative")
        setContentView(web)
        web.loadUrl("https://$APP_HOST/assets/web/index.html")
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (pageReady) js("window.hogNative && window.hogNative.resume()")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.hogBack ? window.hogBack() : false") { handled ->
            if (handled != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    override fun onDestroy() {
        io.shutdownNow()
        web.destroy()
        super.onDestroy()
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "hogpair") {
            if (pageReady) deliverScan(data.toString()) else pendingScan = data.toString()
        }
    }

    private fun deliverScan(text: String) = js("window.hogNative.scanned(${JSONObject.quote(text)})")

    // ---------- WebView <-> hog ----------

    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun jsonResponse(status: Int, error: String): WebResourceResponse {
        val body = JSONObject().put("ok", false).put("error", error).toString().toByteArray()
        return WebResourceResponse("application/json", "utf-8", status, if (status == 401) "Unauthorized" else "Error", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(body))
    }

    /** GET/HEAD from the page to /hog/<route> goes to hog with this phone's token. */
    private fun proxy(request: WebResourceRequest): WebResourceResponse {
        if (request.method != "GET" && request.method != "HEAD") return jsonResponse(405, "Use the app bridge for changes.")
        if (!store.paired) return jsonResponse(401, "This phone is not paired.")
        val route = (request.url.encodedPath ?: "").removePrefix("/hog/")
        if (!ROUTE_GET.matches(route)) return jsonResponse(404, "Not found")
        val query = request.url.encodedQuery?.let { "?$it" } ?: ""
        return try {
            val conn = api.open(request.method, route + query, timeoutMs = 60_000)
            request.requestHeaders.entries.firstOrNull { it.key.equals("range", true) }?.let { conn.setRequestProperty("Range", it.value) }
            val status = conn.responseCode
            if (status in 300..399 || status < 200) return jsonResponse(502, "hog answered $status")
            val stream: InputStream = (if (status >= 400) conn.errorStream else conn.inputStream) ?: ByteArrayInputStream(ByteArray(0))
            val type = conn.contentType ?: "application/octet-stream"
            val mime = type.substringBefore(';').trim()
            val charset = Regex("charset=([^;]+)", RegexOption.IGNORE_CASE).find(type)?.groupValues?.get(1)?.trim()
            val headers = mutableMapOf<String, String>()
            for (name in listOf("Content-Range", "Content-Length", "Accept-Ranges", "Content-Disposition", "Cache-Control", "ETag", "Last-Modified")) {
                conn.getHeaderField(name)?.let { headers[name] = it }
            }
            WebResourceResponse(mime, charset, status, conn.responseMessage?.ifBlank { null } ?: "OK", headers, stream)
        } catch (e: IOException) {
            jsonResponse(502, "Could not reach hog. Is Tailscale on? (${e.message ?: "network error"})")
        }
    }

    private fun js(script: String) = main.post { if (!isDestroyed) web.evaluateJavascript(script, null) }

    private fun done(id: Int, status: Int, text: String) =
        js("window.hogNative.done($id, ${status in 200..299}, $status, ${JSONObject.quote(text)})")

    private fun event(obj: JSONObject) = js("window.hogNative.event(${JSONObject.quote(obj.toString())})")

    private fun toast(text: String) = main.post { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() }

    private fun openExternal(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme != "http" && uri.scheme != "https") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            toast("No app can open $url")
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun state(): String = JSONObject()
            .put("paired", store.paired)
            .put("host", store.host)
            .put("ip", store.ip)
            .put("via", if (store.paired) api.current() else "")
            .put("port", store.port)
            .put("device", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            .toString()

        @JavascriptInterface
        fun pair(id: Int, rawHost: String, rawIp: String, port: Int, code: String) {
            var host = Tailnet.normalizeHost(rawHost)
            var ip = Tailnet.normalizeHost(rawIp)
            // Someone typed the IP into the address box.
            if (Tailnet.isIp(host)) { if (ip.isEmpty()) ip = host; host = "" }
            if (ip.isNotEmpty() && !Tailnet.isIp(ip)) ip = ""
            val shown = host.ifEmpty { ip }
            (if (shown.isEmpty()) "Type hog's address." else Tailnet.problem(shown, port))?.let {
                done(id, 0, JSONObject().put("ok", false).put("error", it).toString())
                return
            }
            io.execute {
                try {
                    val resp = api.pair(host, ip, port, code, "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    if (resp.status == 200) {
                        val body = JSONObject(resp.text)
                        val token = body.getString("token")
                        store.save(host, ip, port, token)
                        // The token stays on the Kotlin side; the page only learns it worked.
                        done(id, 200, JSONObject().put("ok", true).put("device", body.optJSONObject("device")).toString())
                    } else {
                        done(id, resp.status, resp.text)
                    }
                } catch (e: java.net.UnknownHostException) {
                    done(id, 0, JSONObject().put("ok", false).put("error", "This phone cannot look up $host. In the Tailscale app turn on Use Tailscale DNS, or type hog's Tailscale IP (100.x) as the address.").toString())
                } catch (e: Exception) {
                    done(id, 0, JSONObject().put("ok", false).put("error", "Could not reach hog at ${api.pick(host, ip)}:$port. Is Tailscale on, and Phone app turned on in hog? (${e.message ?: "network error"})").toString())
                }
            }
        }

        @JavascriptInterface
        fun post(id: Int, route: String, body: String) {
            if (!ROUTE_POST.matches(route)) {
                done(id, 404, JSONObject().put("ok", false).put("error", "Not available from the phone.").toString())
                return
            }
            io.execute {
                try {
                    val resp = api.postJson(route, body)
                    done(id, resp.status, resp.text)
                } catch (e: Exception) {
                    done(id, 0, JSONObject().put("ok", false).put("error", "Could not reach hog. (${e.message ?: "network error"})").toString())
                }
            }
        }

        @JavascriptInterface
        fun scan() = main.post {
            IntentIntegrator(this@MainActivity)
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false)
                .initiateScan()
        }

        @JavascriptInterface
        fun upload(root: String, dir: String) = main.post {
            uploadTarget = root to dir
            val pick = Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            @Suppress("DEPRECATION")
            startActivityForResult(pick, REQ_UPLOAD)
        }

        @JavascriptInterface
        fun download(root: String, path: String, name: String) {
            io.execute { saveToDownloads(root, path, name) }
        }

        @JavascriptInterface
        fun share(root: String, path: String, name: String) {
            io.execute { shareFile(root, path, name) }
        }

        /** Native player for videos; the token stays on this side. */
        @JavascriptInterface
        fun play(root: String, path: String, name: String) = main.post {
            startActivity(Intent(this@MainActivity, PlayerActivity::class.java)
                .putExtra(PlayerActivity.EXTRA_ROOT, root)
                .putExtra(PlayerActivity.EXTRA_PATH, path)
                .putExtra(PlayerActivity.EXTRA_NAME, name))
        }

        @JavascriptInterface
        fun openUrl(url: String) = main.post { openExternal(url) }

        @JavascriptInterface
        fun openJellyfin(url: String) = main.post {
            if (url.startsWith("http")) {
                val clip = getSystemService(ClipboardManager::class.java)
                clip?.setPrimaryClip(ClipData.newPlainText("Jellyfin server", url))
            }
            val launch = packageManager.getLaunchIntentForPackage(JELLYFIN_PACKAGE)
            if (launch != null) {
                toast("Server address copied. Paste it if Jellyfin asks.")
                startActivity(launch)
            } else {
                openExternal(url)
            }
        }

        @JavascriptInterface
        fun forget() = store.forget()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_UPLOAD) {
            val target = uploadTarget ?: return
            uploadTarget = null
            if (resultCode != RESULT_OK || data == null) return
            val uris = mutableListOf<Uri>()
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
            io.execute { for (uri in uris) uploadOne(uri, target.first, target.second) }
            return
        }
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan != null) {
            scan.contents?.let { deliverScan(it) }
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    // ---------- files ----------

    private fun q(vararg pairs: Pair<String, String>) = pairs.joinToString("&") { "${it.first}=${Uri.encode(it.second)}" }

    private fun uploadOne(uri: Uri, root: String, dir: String) {
        var name = "upload"
        var size = -1L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        name = name.replace('/', '_').replace('\\', '_').ifBlank { "upload" }
        val key = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val report = { sent: Long, total: Long, isDone: Boolean, error: String? ->
            event(JSONObject().put("type", "upload").put("key", key).put("name", name).put("sent", sent).put("total", total).put("done", isDone).apply { if (error != null) put("error", error) })
        }
        var source: File? = null
        try {
            if (size < 0) {
                // Unknown size: copy to the cache first so chunks can say the total.
                source = File(cacheDir, "up-$key").also { f -> contentResolver.openInputStream(uri)!!.use { input -> f.outputStream().use { input.copyTo(it) } } }
                size = source.length()
            }
            val input = source?.inputStream() ?: contentResolver.openInputStream(uri) ?: throw IOException("Cannot read that file.")
            input.use { stream ->
                val buf = ByteArray(CHUNK)
                var offset = 0L
                report(0, size, false, null)
                do {
                    var n = 0
                    while (n < buf.size) {
                        val r = stream.read(buf, n, buf.size - n)
                        if (r < 0) break
                        n += r
                    }
                    putChunk(root, dir, name, key, offset, size, buf, n)
                    offset += n
                    report(offset, size, offset >= size, null)
                } while (offset < size)
            }
        } catch (e: Exception) {
            report(0, size, false, e.message ?: "Upload failed")
            try { api.postJson("files/upload/cancel", JSONObject().put("root", root).put("dir", dir).put("rel", name).put("id", key).toString()) } catch (_: Exception) {}
        } finally {
            source?.delete()
        }
    }

    private fun putChunk(root: String, dir: String, name: String, id: String, offset: Long, total: Long, buf: ByteArray, n: Int) {
        var attempt = 0
        while (true) {
            try {
                val conn = api.open("PUT", "files/upload?" + q("root" to root, "dir" to dir, "rel" to name, "id" to id, "offset" to offset.toString(), "total" to total.toString()), timeoutMs = 120_000)
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/octet-stream")
                conn.setRequestProperty("x-hog-files", "1")
                conn.setFixedLengthStreamingMode(n)
                conn.outputStream.use { it.write(buf, 0, n) }
                val resp = api.read(conn)
                conn.disconnect()
                if (resp.status == 200) return
                throw HogError(errorText(resp))
            } catch (e: HogError) {
                throw IOException(e.message)
            } catch (e: IOException) {
                attempt += 1
                // A dropped connection may still have landed the chunk; ask hog.
                val landed = try {
                    val conn = api.open("GET", "files/upload?" + q("root" to root, "dir" to dir, "rel" to name, "id" to id))
                    val resp = api.read(conn)
                    conn.disconnect()
                    JSONObject(resp.text).optLong("size", -1)
                } catch (_: Exception) { -1L }
                if (landed == offset + n) return
                if (attempt >= 3 || landed != offset) throw e
                Thread.sleep(1500L * attempt)
            }
        }
    }

    private class HogError(message: String) : Exception(message)

    private fun errorText(resp: HogApi.Resp): String = try {
        JSONObject(resp.text).optString("error").ifBlank { "hog answered ${resp.status}" }
    } catch (_: Exception) { "hog answered ${resp.status}" }

    private fun mimeFor(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    private fun fetchRaw(root: String, path: String) =
        api.open("GET", "files/raw?" + q("root" to root, "path" to path, "download" to "1"), timeoutMs = 120_000)

    private fun saveToDownloads(root: String, path: String, rawName: String) {
        val name = rawName.replace('/', '_').ifBlank { "download" }
        event(JSONObject().put("type", "download").put("name", name).put("done", false))
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mimeFor(name))
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Hog")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        var item: Uri? = null
        try {
            val conn = fetchRaw(root, path)
            if (conn.responseCode != 200) throw IOException(errorText(api.read(conn)))
            val target = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException("Android would not make the file.")
            item = target
            conn.inputStream.use { input -> (contentResolver.openOutputStream(target) ?: throw IOException("Cannot write to Downloads.")).use { input.copyTo(it, 256 * 1024) } }
            conn.disconnect()
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            contentResolver.update(target, values, null, null)
            event(JSONObject().put("type", "download").put("name", name).put("done", true))
        } catch (e: Exception) {
            item?.let { contentResolver.delete(it, null, null) }
            event(JSONObject().put("type", "download").put("name", name).put("error", "Download failed: ${e.message ?: "network error"}"))
        }
    }

    private fun shareFile(root: String, path: String, rawName: String) {
        val name = rawName.replace('/', '_').ifBlank { "file" }
        try {
            val dir = File(cacheDir, "shared").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val out = File(dir, name)
            event(JSONObject().put("type", "toast").put("text", "Getting $name…"))
            val conn = fetchRaw(root, path)
            if (conn.responseCode != 200) throw IOException(errorText(api.read(conn)))
            conn.inputStream.use { input -> out.outputStream().use { input.copyTo(it, 256 * 1024) } }
            conn.disconnect()
            val uri = FileProvider.getUriForFile(this, "$packageName.files", out)
            val send = Intent(Intent.ACTION_SEND)
                .setType(mimeFor(name))
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            main.post { startActivity(Intent.createChooser(send, name)) }
        } catch (e: Exception) {
            event(JSONObject().put("type", "toast").put("text", "Share failed: ${e.message ?: "network error"}").put("error", true))
        }
    }

    companion object {
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val REQ_UPLOAD = 4101
        private const val CHUNK = 4 * 1024 * 1024
        private const val JELLYFIN_PACKAGE = "org.jellyfin.mobile"
        private val ROUTE_GET = Regex("^(session|containers|mining|files/(roots|list|search|info|raw|upload))$")
        private val ROUTE_POST = Regex("^(containers|files/(mkdir|rename|trash|upload/cancel))$")
    }
}
