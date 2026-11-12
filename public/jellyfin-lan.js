// Settings → Containers → Jellyfin → Home network access. Talks to
// /api/jellyfin-lan on Hog's own origin (gate cookie + x-hog-lan header on
// changes). Hog then forwards this computer's home-network addresses (never
// 0.0.0.0) to Jellyfin on 127.0.0.1:8096, for TV apps that cannot run Tailscale.

const $ = (id) => document.getElementById(id);
let lanState = null;
let lanBusy = false;

async function lanApi(body) {
  const init = body
    ? { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-hog-lan": "1" }, body: JSON.stringify(body) }
    : { credentials: "same-origin" };
  const response = await fetch("/api/jellyfin-lan", init);
  return response.json().catch(() => ({ ok: false, error: "Hog did not answer." }));
}

/** Words for the card. Exported for tests. */
export function lanStateText(st) {
  if (!st || !st.enabled) {
    const where = st && Array.isArray(st.suggested) && st.suggested.length ? ` It will be at ${st.suggested.join(" or ")}.` : "";
    return `Off. Turn it on so a TV app on your Wi-Fi, such as Roku, can reach Jellyfin without Tailscale.${where}`;
  }
  if (Array.isArray(st.urls) && st.urls.length) {
    const up = st.jellyfinUp ? "" : " Jellyfin is not answering on this computer yet. Start the jellyfin container.";
    return `On. Type this address into the TV's Jellyfin app.${up}`;
  }
  return `On, but not reachable yet. ${st.error || "Connect this computer to Wi-Fi or Ethernet."}`;
}

export function paintJellyfinLan() {
  const card = $("jellyfin-lan-card");
  if (!card) return;
  const st = lanState || {};
  const on = Boolean(st.enabled);
  const toggle = $("jellyfin-lan-toggle");
  toggle.textContent = on ? "Turn off" : "Turn on";
  toggle.setAttribute("aria-pressed", on ? "true" : "false");
  toggle.disabled = lanBusy;
  card.classList.toggle("is-on", on);
  $("jellyfin-lan-state").textContent = lanState ? lanStateText(st) : "Checking…";
  const box = $("jellyfin-lan-urls");
  const urls = on && Array.isArray(st.urls) ? st.urls : [];
  box.replaceChildren();
  box.hidden = urls.length === 0;
  for (const url of urls) {
    const strong = document.createElement("strong");
    strong.textContent = url;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      navigator.clipboard?.writeText(url).then(() => { copy.textContent = "Copied"; }, () => {});
    });
    box.append(strong, copy);
  }
  const fw = $("jellyfin-lan-firewall");
  const commands = on && st.ufw && st.ufw.enabled && Array.isArray(st.ufw.commands) ? st.ufw.commands : [];
  fw.hidden = commands.length === 0;
  $("jellyfin-lan-firewall-cmd").textContent = commands.join("\n");
  const error = $("jellyfin-lan-error");
  error.textContent = on && st.urls && st.urls.length && st.error ? st.error : (st.ok === false && st.error ? st.error : "");
}

async function lanChange(enabled) {
  lanBusy = true;
  paintJellyfinLan();
  try {
    const payload = await lanApi({ enabled });
    lanState = payload && payload.enabled !== undefined ? payload : { ...(lanState || {}), ok: false, error: payload?.error || "That did not work." };
  } catch (error) {
    lanState = { ...(lanState || {}), ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    lanBusy = false;
    paintJellyfinLan();
  }
}

export async function refreshJellyfinLan() {
  if (!$("jellyfin-lan-card")) return;
  try {
    lanState = await lanApi();
  } catch {
    // Hog's server restarts on update; the next visit refreshes.
  }
  paintJellyfinLan();
}

export function wireJellyfinLan() {
  if (!$("jellyfin-lan-card")) return;
  $("jellyfin-lan-toggle").addEventListener("click", () => lanChange(!(lanState && lanState.enabled)));
}
