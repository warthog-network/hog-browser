// Settings → Tailscale → Phone app (tailnet). Talks to /api/mobile on Hog's
// own origin (gate cookie + x-hog-mobile header on changes). Tokens never
// reach this page; it sees device names, the pairing code and its QR only.

const $ = (id) => document.getElementById(id);
let phoneState = null;
let phoneBusy = false;
let phoneTimer = null;

async function phoneApi(body) {
  const init = body
    ? { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-hog-mobile": "1" }, body: JSON.stringify(body) }
    : { credentials: "same-origin" };
  const response = await fetch("/api/mobile", init);
  const payload = await response.json().catch(() => ({ ok: false, error: "Hog did not answer." }));
  return payload;
}

function phoneMessage(text, error = false) {
  const box = $("phone-error");
  if (!box) return;
  box.textContent = text || "";
  box.classList.toggle("is-error", Boolean(error));
}

function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function paintPhoneCard() {
  const card = $("phone-card");
  if (!card) return;
  const st = phoneState || {};
  const toggle = $("phone-toggle");
  const stateText = $("phone-state");
  toggle.textContent = st.enabled ? "Turn off" : "Turn on";
  toggle.disabled = phoneBusy;
  card.classList.toggle("is-on", Boolean(st.enabled));
  $("phone-pair").disabled = phoneBusy || !st.enabled;
  if (!st.enabled) {
    stateText.textContent = "Off. Turn it on to use the Hog phone app over your tailnet.";
  } else if (st.tailnetListening && st.tailnetListening.length) {
    stateText.textContent = `On. The phone app reaches hog at ${st.address || st.tailnetListening[0]} port ${st.port}, on your tailnet only.`;
  } else {
    stateText.textContent = `On, but only on this computer for now. ${st.error || "Start Tailscale to reach it from your phone."}`;
  }
  const pairBox = $("phone-pairing");
  const pair = st.pairing;
  pairBox.hidden = !pair;
  if (pair) {
    const img = document.createElement("img");
    img.alt = "Pairing QR code";
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pair.qr)}`;
    $("phone-qr").replaceChildren(img);
    $("phone-code").textContent = pair.code;
    $("phone-host").textContent = st.dnsName && st.ip
      ? `${st.dnsName}:${st.port}  or  ${st.ip}:${st.port}`
      : `${st.address || "(no tailnet address yet)"}:${st.port}`;
    const left = Math.max(0, Math.round((pair.expiresAt - Date.now()) / 60000));
    $("phone-expiry").textContent = `Works once, for about ${left || 1} more minute${left === 1 ? "" : "s"}.`;
  }
  const list = $("phone-devices");
  list.replaceChildren();
  const devices = Array.isArray(st.devices) ? st.devices : [];
  $("phone-devices-empty").hidden = devices.length > 0;
  for (const device of devices) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${device.name} · paired ${ago(device.createdAt)} · last used ${ago(device.lastSeenAt)}`;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.textContent = "Remove";
    revoke.className = "danger";
    revoke.addEventListener("click", () => phoneChange({ action: "revoke", id: device.id }, `${device.name} can no longer reach hog.`));
    li.append(label, revoke);
    list.append(li);
  }
}

async function phoneChange(body, notice = "") {
  phoneBusy = true;
  paintPhoneCard();
  try {
    const payload = await phoneApi(body);
    if (payload && payload.enabled !== undefined) phoneState = payload;
    phoneMessage(payload.ok ? notice : payload.error || "That did not work.", !payload.ok);
  } catch (error) {
    phoneMessage(error instanceof Error ? error.message : String(error), true);
  } finally {
    phoneBusy = false;
    paintPhoneCard();
    schedulePhone();
  }
}

function schedulePhone() {
  clearTimeout(phoneTimer);
  if (phoneState && phoneState.pairing) phoneTimer = setTimeout(refreshPhoneApp, 3000);
}

export async function refreshPhoneApp() {
  if (!$("phone-card")) return;
  try {
    const before = phoneState?.devices?.length || 0;
    phoneState = await phoneApi();
    if (before && phoneState.devices && phoneState.devices.length > before) phoneMessage("Phone paired.");
  } catch {
    // Hog's server restarts on update; the next visit refreshes.
  }
  paintPhoneCard();
  schedulePhone();
}

export function wirePhoneCard() {
  if (!$("phone-card")) return;
  $("phone-toggle").addEventListener("click", () => phoneChange({ enabled: !(phoneState && phoneState.enabled) }));
  $("phone-pair").addEventListener("click", () => phoneChange({ action: "pair" }, "Scan the code with the Hog app, or type the code in it."));
  $("phone-pair-cancel").addEventListener("click", () => phoneChange({ action: "cancel-pair" }));
}
