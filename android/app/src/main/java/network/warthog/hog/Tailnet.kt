package network.warthog.hog

/**
 * Which hog addresses the app talks to: Tailscale MagicDNS names (*.ts.net)
 * and Tailscale IPs (100.64.0.0/10, fd7a:115c:a1e0::/48). Every connection
 * the app opens goes through problem() first, so plain HTTP never leaves the
 * tailnet even though the network security config cannot express IP ranges.
 */
object Tailnet {
    private val TS_NAME = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.ts\\.net$")
    private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

    fun normalizeHost(raw: String): String {
        var h = raw.trim().lowercase()
            .removePrefix("http://").removePrefix("https://").removePrefix("hogpair://")
            .substringBefore('/').trimEnd('.')
        if (h.startsWith("[")) h = h.substringAfter('[').substringBefore(']')
        else if (h.count { it == ':' } == 1) h = h.substringBefore(':')
        return h
    }

    fun isTsName(host: String): Boolean = TS_NAME.matches(host)

    /** 100.64.0.0/10 */
    fun isTailnetIpv4(host: String): Boolean {
        val m = IPV4.matchEntire(host) ?: return false
        val parts = m.groupValues.drop(1).map { it.toInt() }
        if (parts.any { it > 255 }) return false
        return parts[0] == 100 && parts[1] in 64..127
    }

    /** fd7a:115c:a1e0::/48 */
    fun isTailnetIpv6(host: String): Boolean {
        if (!host.contains(':') || !Regex("^[0-9a-f:]+$").matches(host)) return false
        val groups = host.split("::")[0].split(':')
        return groups.size >= 3 && groups[0].trimStart('0') == "fd7a" && groups[1].trimStart('0') == "115c" && groups[2].trimStart('0') == "a1e0"
    }

    fun isIp(host: String): Boolean = isTailnetIpv4(host) || isTailnetIpv6(host)

    fun allowed(host: String): Boolean = isTsName(host) || isIp(host)

    /** For URLs: IPv6 literals need brackets. */
    fun urlHost(host: String): String = if (host.contains(':')) "[$host]" else host

    /** null when allowed, otherwise the reason shown to the user. */
    fun problem(host: String, port: Int): String? {
        if (port !in 1..65535) return "Use hog's phone app port (4189 unless you changed it)."
        if (allowed(host)) return null
        return "That is not a Tailscale address. Use hog's .ts.net name or its 100.x Tailscale IP."
    }
}
