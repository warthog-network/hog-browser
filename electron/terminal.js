const api = window.hogTerm;
const tabsEl = document.getElementById("tabs");
const panes = document.getElementById("panes");
const menu = document.getElementById("menu");
const newBtn = document.getElementById("new");
const closePanel = document.getElementById("close-panel");
const grip = document.getElementById("grip");

const terms = new Map();
let state = { tabs: [], active: "", containers: [], assets: {}, open: false };
let xtermMod = null;

async function loadXterm(assets) {
  if (xtermMod) return xtermMod;
  const css = assets && assets.css;
  const js = assets && assets.js;
  if (!js) throw new Error("xterm bundle was not found");
  if (css && !document.querySelector("link[data-xterm]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = css;
    link.dataset.xterm = "1";
    document.head.append(link);
  }
  xtermMod = await import(js);
  return xtermMod;
}

function ensurePane(tab) {
  let pane = panes.querySelector(`[data-id="${tab.id}"]`);
  if (!pane) {
    pane = document.createElement("div");
    pane.className = "pane";
    pane.dataset.id = tab.id;
    const host = document.createElement("div");
    host.className = "shell-term";
    pane.append(host);
    panes.append(pane);
  }
  pane.hidden = tab.id !== state.active;
  return pane;
}

async function ensureTerm(tab) {
  if (terms.has(tab.id)) return terms.get(tab.id);
  const { Terminal, FitAddon } = await loadXterm(state.assets);
  const pane = ensurePane(tab);
  const host = pane.querySelector(".shell-term");
  const term = new Terminal({
    cursorBlink: tab.kind !== "log",
    disableStdin: tab.kind === "log",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    scrollback: tab.kind === "log" ? 4000 : 2000,
    theme: {
      background: "#0b0b0d",
      foreground: "#f4f4f5",
      cursor: "#fdb913",
      selectionBackground: "#fdb91355",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((data) => {
    if (tab.kind !== "log") api.input(tab.id, data);
  });
  term.onResize(({ cols, rows }) => api.resize(tab.id, cols, rows));
  const ro = new ResizeObserver(() => {
    try { fit.fit(); } catch { /* not sized yet */ }
  });
  ro.observe(host);
  requestAnimationFrame(() => {
    try { fit.fit(); } catch { /* ignore */ }
    if (tab.id === state.active && tab.kind !== "log") term.focus();
  });
  const rec = { term, fit, ro };
  terms.set(tab.id, rec);
  return rec;
}

function paintTabs() {
  tabsEl.replaceChildren();
  for (const tab of state.tabs) {
    const wrap = document.createElement("div");
    wrap.className = `tab${tab.id === state.active ? " is-active" : ""}`;
    wrap.setAttribute("role", "tab");
    wrap.setAttribute("aria-selected", String(tab.id === state.active));
    wrap.dataset.id = tab.id;
    const title = document.createElement("button");
    title.type = "button";
    title.className = "tab-title";
    title.textContent = tab.title || tab.kind;
    title.addEventListener("click", () => api.select(tab.id));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-x";
    close.setAttribute("aria-label", `Close ${tab.title || tab.kind}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      api.close(tab.id);
    });
    wrap.append(title, close);
    tabsEl.append(wrap);
    ensurePane(tab);
  }
  for (const pane of [...panes.children]) {
    if (!state.tabs.some((t) => t.id === pane.dataset.id)) {
      const rec = terms.get(pane.dataset.id);
      if (rec) {
        rec.ro.disconnect();
        rec.term.dispose();
        terms.delete(pane.dataset.id);
      }
      pane.remove();
    }
  }
  for (const tab of state.tabs) {
    const pane = ensurePane(tab);
    pane.hidden = tab.id !== state.active;
    ensureTerm(tab).then((rec) => {
      if (tab.id === state.active && tab.kind !== "log") rec.term.focus();
    }).catch((err) => {
      const paneHost = panes.querySelector(`[data-id="${tab.id}"] .shell-term`);
      if (paneHost && !paneHost.dataset.err) {
        paneHost.dataset.err = "1";
        paneHost.textContent = err.message || String(err);
      }
    });
  }
}

function paintMenu() {
  menu.replaceChildren();
  const add = (label, kind, name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.hidden = true;
      newBtn.setAttribute("aria-expanded", "false");
      api.open(kind, name);
    });
    menu.append(b);
  };
  add("Host shell", "host", "");
  add("Hog log", "log", "");
  if (state.containers && state.containers.length) {
    for (const item of state.containers) add(`Container: ${item.name}`, "container", item.name);
  } else {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "No running containers.";
    menu.append(hint);
  }
}

function setMenu(open) {
  menu.hidden = !open;
  newBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    api.list();
    paintMenu();
  }
}

newBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenu(menu.hidden);
});
closePanel.addEventListener("click", () => api.hide());
document.addEventListener("click", () => setMenu(false));
menu.addEventListener("click", (event) => event.stopPropagation());

let dragging = false;
grip.addEventListener("pointerdown", (event) => {
  dragging = true;
  grip.setPointerCapture(event.pointerId);
  api.drag("start", event.screenY);
  event.preventDefault();
});
grip.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  api.drag("move", event.screenY);
});
grip.addEventListener("pointerup", (event) => {
  if (!dragging) return;
  dragging = false;
  api.drag("end", event.screenY);
});

api.onState((next) => {
  state = next && typeof next === "object" ? next : state;
  paintTabs();
  if (!menu.hidden) paintMenu();
});
api.onData((message) => {
  if (!message || !message.id) return;
  const rec = terms.get(message.id);
  if (rec) rec.term.write(message.data || "");
  else {
    const tab = (state.tabs || []).find((t) => t.id === message.id);
    if (tab) {
      ensureTerm(tab).then((r) => r.term.write(message.data || "")).catch(() => {});
    }
  }
});
api.ready();
