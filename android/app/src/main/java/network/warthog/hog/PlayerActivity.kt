package network.warthog.hog

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import java.util.concurrent.Executors

/**
 * Native video player for Files. Streams hog's /m/v1/files/raw with HTTP
 * range requests; the device token is added as a request header here and
 * never reaches the WebView. Plays whatever this phone's decoders support
 * (MP4, MKV, WebM, MOV, TS; H.264, HEVC, VP9, AV1 where the phone can).
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {
    private var player: ExoPlayer? = null
    private lateinit var view: PlayerView
    private lateinit var overlay: LinearLayout
    private lateinit var message: TextView
    private lateinit var keep: Button
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var title = ""
    private var warnedVideo = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root = intent.getStringExtra(EXTRA_ROOT) ?: return finish()
        val path = intent.getStringExtra(EXTRA_PATH) ?: return finish()
        title = intent.getStringExtra(EXTRA_NAME) ?: path.substringAfterLast('/')

        val frame = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        view = PlayerView(this).apply {
            setShowSubtitleButton(true)
            setShowNextButton(false)
            setShowPreviousButton(false)
            setKeepContentOnPlayerReset(true)
            setFullscreenButtonClickListener { full -> setFullscreen(full) }
        }
        frame.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        overlay = buildOverlay()
        frame.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(frame)

        val store = TokenStore(this)
        val api = HogApi(store)
        val token = store.token()
        if (token == null) {
            showError("This phone is not paired with hog. Pair it again.")
            return
        }
        // Picking hog's address may need a DNS lookup: keep it off the main thread.
        io.execute {
            val host = try { api.current() } catch (e: Exception) { "" }
            val problem = Tailnet.problem(host, store.port)
            main.post {
                if (isFinishing || isDestroyed) return@post
                if (problem != null) {
                    showError(problem)
                    return@post
                }
                val query = "root=${Uri.encode(root)}&path=${Uri.encode(path)}"
                start(api.url(host, store.port, "files/raw?$query").toString(), token)
            }
        }
    }

    private fun start(url: String, token: String) {
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("HogPhone/${BuildConfig.VERSION_NAME}")
            .setDefaultRequestProperties(mapOf("Authorization" to "Bearer $token"))
            .setAllowCrossProtocolRedirects(false)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)
        val renderers = DefaultRenderersFactory(this)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        val exo = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(http))
            .build()
        exo.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) = showError(explain(error))

            override fun onTracksChanged(tracks: Tracks) {
                val video = tracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
                if (!warnedVideo && video.isNotEmpty() && video.none { it.isSupported }) {
                    warnedVideo = true
                    showError("This phone cannot decode this video's picture format. The sound may still play. Open it in Jellyfin, which can convert it for the phone.", keepPlaying = true)
                }
            }
        })
        exo.setMediaItem(MediaItem.Builder().setUri(url).setMediaMetadata(
            androidx.media3.common.MediaMetadata.Builder().setTitle(title).build()).build())
        exo.prepare()
        exo.playWhenReady = true
        view.player = exo
        player = exo
    }

    /** Words for the user, by Media3 error code. */
    private fun explain(error: PlaybackException): String {
        val cause = error.cause
        if (cause is HttpDataSource.InvalidResponseCodeException) {
            return when (cause.responseCode) {
                401 -> "hog no longer knows this phone. Pair it again."
                403 -> "hog refused this file."
                404 -> "That file is not on hog any more."
                else -> "hog answered ${cause.responseCode}."
            }
        }
        return when (error.errorCode) {
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ->
                "This phone cannot play this video's format (${error.errorCodeName}). Open it in Jellyfin, which can convert it for the phone, or download it."
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED ->
                "The player cannot read this file type. Try Jellyfin, or download it."
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ->
                "Could not stream from hog. Is Tailscale on?"
            else -> "Could not play this file (${error.errorCodeName})."
        }
    }

    private fun buildOverlay(): LinearLayout {
        val pad = (20 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(0xE6050505.toInt())
            visibility = View.GONE
            isClickable = true
        }
        message = TextView(this).apply {
            setTextColor(0xFFF4F4F5.toInt())
            textSize = 16f
            gravity = Gravity.CENTER
        }
        box.addView(message)
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        val jellyfin = packageManager.getLaunchIntentForPackage(JELLYFIN_PACKAGE)
        if (jellyfin != null) {
            row.addView(Button(this).apply {
                text = "Open Jellyfin"
                setOnClickListener { startActivity(jellyfin.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); finish() }
            })
        }
        keep = Button(this).apply {
            text = "Keep watching"
            setOnClickListener { overlay.visibility = View.GONE }
        }
        row.addView(keep)
        row.addView(Button(this).apply { text = "Close"; setOnClickListener { finish() } })
        box.addView(row)
        return box
    }

    private fun showError(text: String, keepPlaying: Boolean = false) {
        message.text = text
        keep.visibility = if (keepPlaying) View.VISIBLE else View.GONE
        overlay.visibility = View.VISIBLE
    }

    private fun setFullscreen(full: Boolean) {
        requestedOrientation = if (full) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        window.insetsController?.let { c ->
            if (full) {
                c.hide(WindowInsets.Type.systemBars())
                c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                c.show(WindowInsets.Type.systemBars())
            }
        }
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        player?.release()
        player = null
        io.shutdownNow()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ROOT = "root"
        const val EXTRA_PATH = "path"
        const val EXTRA_NAME = "name"
        private const val JELLYFIN_PACKAGE = "org.jellyfin.mobile"
    }
}
