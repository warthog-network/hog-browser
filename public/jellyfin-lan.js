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
  paintFirewall(st);
  const error = $("jellyfin-lan-error");
  error.textContent = on && st.urls && st.urls.length && st.error ? st.error : (st.ok === false && st.error ? st.error : "");
}

/** What the firewall part of the card shows. Exported for tests. */
export function firewallView(st) {
  const fw = st && st.ufw;
  const on = Boolean(st && st.enabled);
  const none = { show: false, text: "", allow: false, remove: false, commands: [], manualOpen: false };
  if (!fw) return none;
  const added = Array.isArray(fw.added) ? fw.added : [];
  if (on && fw.enabled && fw.needed) {
    return {
      show: true,
      text: fw.canPrompt
        ? "The ufw firewall is on and will likely block the TV. Allow Jellyfin's port for your home network; Ubuntu asks for your password, Hog never sees it."
        : "The ufw firewall is on and will likely block the TV. Run this once in a terminal to let home devices in.",
      allow: Boolean(fw.canPrompt),
      remove: false,
      commands: fw.commands || [],
      manualOpen: !fw.canPrompt,
    };
  }
  if (on && fw.enabled) {
    return { show: true, text: "The firewall lets devices on your home network reach Jellyfin (rule added by Hog).", allow: false, remove: false, commands: [], manualOpen: false };
  }
  if (!on && added.length) {
    return {
      show: true,
      text: "Hog added a firewall rule for Jellyfin earlier. Home network access is off, so you can remove it. Nothing is removed unless you click.",
      allow: false,
      remove: Boolean(fw.canPrompt),
      commands: fw.removeCommands || [],
      manualOpen: !fw.canPrompt,
    };
  }
  return none;
}

let fwMessage = { text: "", error: false };

function paintFirewall(st) {
  const view = firewallView(st);
  $("jellyfin-lan-firewall").hidden = !view.show;
  $("jellyfin-lan-fw-text").textContent = view.text;
  const allow = $("jellyfin-lan-fw-allow");
  const remove = $("jellyfin-lan-fw-remove");
  allow.hidden = !view.allow;
  remove.hidden = !view.remove;
  allow.disabled = lanBusy;
  remove.disabled = lanBusy;
  const manual = $("jellyfin-lan-fw-manual");
  manual.hidden = view.commands.length === 0;
  if (view.manualOpen) manual.open = true;
  $("jellyfin-lan-firewall-cmd").textContent = view.commands.join("\n");
  const msg = $("jellyfin-lan-fw-msg");
  msg.textContent = view.show || fwMessage.text ? fwMessage.text : "";
  msg.classList.toggle("error", fwMessage.error);
}

async function firewallChange(action) {
  lanBusy = true;
  fwMessage = { text: "Waiting for your password in Ubuntu's prompt…", error: false };
  paintJellyfinLan();
  try {
    const payload = await lanApi({ action });
    fwMessage = payload.ok ? { text: payload.notice || "Done.", error: false } : { text: payload.error || "The firewall did not change.", error: !payload.cancelled };
  } catch (error) {
    fwMessage = { text: error instanceof Error ? error.message : String(error), error: true };
  } finally {
    lanBusy = false;
    await refreshJellyfinLan();
  }
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
  $("jellyfin-lan-toggle").addEventListener("click", () => {
    fwMessage = { text: "", error: false };
    lanChange(!(lanState && lanState.enabled));
  });
  $("jellyfin-lan-fw-allow").addEventListener("click", () => firewallChange("firewall-allow"));
  $("jellyfin-lan-fw-remove").addEventListener("click", () => firewallChange("firewall-remove"));
}
