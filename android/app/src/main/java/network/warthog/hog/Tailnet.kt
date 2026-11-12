package network.warthog.hog

/** Which hog addresses the app talks to: Tailscale MagicDNS names only. */
object Tailnet {
    private val TS_NAME = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.ts\\.net$")
    private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

    fun normalizeHost(raw: String): String =
        raw.trim().lowercase()
            .removePrefix("http://").removePrefix("https://").removePrefix("hogpair://")
            .substringBefore('/').trimEnd('.')

    fun isTsName(host: String): Boolean = TS_NAME.matches(host)

    /** 100.64.0.0/10, for a clearer error when someone types hog's IP. */
    fun isTailnetIpv4(host: String): Boolean {
        val m = IPV4.matchEntire(host) ?: return false
        val a = m.groupValues[1].toInt()
        val b = m.groupValues[2].toInt()
        return a == 100 && b in 64..127
    }

    /** null when allowed, otherwise the reason shown to the user. */
    fun problem(host: String, port: Int): String? {
        if (port !in 1..65535) return "Use hog's phone app port (4189 unless you changed it)."
        if (isTsName(host)) return null
        if (isTailnetIpv4(host)) return "Use hog's Tailscale name (like hog.tailxxxx.ts.net), not its IP. Find it in hog → Settings → Tailscale → Phone app."
        return "That is not a Tailscale address. Use hog's .ts.net name, like hog.tailxxxx.ts.net."
    }
}
