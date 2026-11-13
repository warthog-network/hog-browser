// hog://files: a file explorer for ~/hog-shares and the folders the user
// adds. Talks only to Hog's own /api/files endpoints.
import {
  CHUNK_SIZE,
  PREVIEW_KINDS,
  SORT_KEYS,
  VIEW_MODES,
  baseName,
  crumbs,
  entryKind,
  filterEntries,
  formatBytes,
  formatDate,
  iconSvg,
  joinPath,
  keyAction,
  kindLabel,
  moveFocus,
  nameProblem,
  parentPath,
  query,
  rangeSelect,
  rawUrl,
  selectionSummary,
  smbLinks,
  sortEntries,
  spaceSummary,
  uploadId,
} from "./files-core.js";

const PREFS = "hog-files-prefs";
const DRAG_TYPE = "application/x-hog-files";
const MAX_PARALLEL = 2;
const TEXT_PREVIEW_BYTES = 512 * 1024;

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(kind) {
  const span = el("span", `fx-icon fx-kind-${kind}`);
  span.innerHTML = iconSvg(kind); // Fixed markup from files-core, no user text.
  return span;
}

export function createFilesView({ desktopCommand = () => {}, openSettings = () => {}, copyText = null } = {}) {
  const state = {
    open: false,
    root: "shares",
    rootName: "hog-shares",
    path: "",
    roots: [],
    entries: [],
    shown: [],
    selected: new Set(),
    anchor: null,
    focus: -1,
    view: "list",
    sort: "name",
    dir: "asc",
    filter: "",
    deep: false,
    trash: false,
    trashItems: [],
    history: [],
    future: [],
    clip: null,
    info: false,
    seq: 0,
    uploads: [],
    active: 0,
    samba: null,
    space: null,
    dialog: null,
    viewer: null,
    menuOpen: false,
    menuFolder: null,
  };

  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) || "{}");
    if (VIEW_MODES.includes(saved.view)) state.view = saved.view;
    if (SORT_KEYS.includes(saved.sort)) state.sort = saved.sort;
    if (saved.dir === "desc") state.dir = "desc";
    state.info = saved.info === true;
  } catch {
    // Defaults.
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS, JSON.stringify({ view: state.view, sort: state.sort, dir: state.dir, info: state.info }));
    } catch {
      // Private mode.
    }
  }

  // ---------- API ----------

  async function api(route, { method = "GET", body, params } = {}) {
    const url = `/api/files/${route}${params ? `?${query(params)}` : ""}`;
    const init = { method, headers: {}, credentials: "same-origin", cache: "no-store" };
    if (method !== "GET") init.headers["x-hog-files"] = "1";
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `Files answered ${response.status}.`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function status(message, { error = false } = {}) {
    const box = $("fx-status");
    if (!box) return;
    box.textContent = message || "";
    box.classList.toggle("is-error", Boolean(error));
  }

  function fail(error) {
    status(error && error.message ? error.message : String(error), { error: true });
  }

  function currentRoot() {
    return state.roots.find((root) => root.id === state.root) || null;
  }

  function entryPath(entry) {
    if (!entry) return "";
    if (state.trash) return entry.path;
    return entry.dir !== undefined ? joinPath(entry.dir, entry.name) : joinPath(state.path, entry.name);
  }

  function entryKey(entry) {
    return state.trash ? `${entry.root}:${entry.id}` : entryPath(entry);
  }

  function selectedEntries() {
    return state.shown.filter((entry) => state.selected.has(entryKey(entry)));
  }

  function targetEntries() {
    const picked = selectedEntries();
    if (picked.length) return picked;
    const focused = state.shown[state.focus];
    return focused ? [focused] : [];
  }

  // ---------- Loading ----------

  async function loadRoots() {
    try {
      const data = await api("roots");
      state.roots = data.roots || [];
    } catch (error) {
      state.roots = [];
      fail(error);
    }
    if (!state.roots.some((root) => root.id === state.root)) {
      state.root = "shares";
      state.path = "";
    }
    paintRoots();
  }

  async function load({ keepSelection = false, focusName = "" } = {}) {
    const seq = ++state.seq;
    const pane = $("fx-pane");
    pane?.classList.add("is-loading");
    try {
      let data;
      if (state.trash) {
        data = await api("trash");
        if (seq !== state.seq) return;
        state.trashItems = data.items || [];
        state.entries = state.trashItems;
        state.space = null;
      } else if (state.deep && state.filter.trim()) {
        data = await api("search", { params: { root: state.root, path: state.path, q: state.filter.trim() } });
        if (seq !== state.seq) return;
        state.entries = data.entries || [];
        state.space = null;
        if (data.truncated) status(`Showing the first ${state.entries.length} matches.`);
      } else {
        data = await api("list", { params: { root: state.root, path: state.path } });
        if (seq !== state.seq) return;
        state.entries = data.entries || [];
        state.rootName = data.rootName || state.rootName;
        state.space = data.space || null;
        if (data.truncated) status(`This folder is very large; showing the first ${state.entries.length} items.`);
      }
      if (!keepSelection) {
        state.selected.clear();
        state.anchor = null;
      }
      render();
      if (focusName) {
        const index = state.shown.findIndex((entry) => entry.name === focusName);
        if (index >= 0) setFocus(index, { select: true });
      }
    } catch (error) {
      if (seq !== state.seq) return;
      state.entries = [];
      render();
      fail(error);
      if (error.status === 404 && state.path) {
        state.path = parentPath(state.path);
        load();
      }
    } finally {
      if (seq === state.seq) pane?.classList.remove("is-loading");
    }
  }

  function go(root, path, { push = true, trash = false, focusName = "" } = {}) {
    if (push) {
      state.history.push({ root: state.root, path: state.path, trash: state.trash });
      if (state.history.length > 100) state.history.shift();
      state.future = [];
    }
    state.trash = trash;
    state.root = root;
    state.path = path;
    const found = state.roots.find((item) => item.id === root);
    if (found) state.rootName = found.name;
    state.filter = "";
    state.deep = false;
    const search = $("fx-search");
    if (search) search.value = "";
    const deep = $("fx-deep");
    if (deep) deep.checked = false;
    state.focus = -1;
    status("");
    paintRoots();
    return load({ focusName });
  }

  function goBack() {
    const prev = state.history.pop();
    if (!prev) return;
    state.future.push({ root: state.root, path: state.path, trash: state.trash });
    go(prev.root, prev.path, { push: false, trash: prev.trash });
  }

  function goForward() {
    const next = state.future.pop();
    if (!next) return;
    state.history.push({ root: state.root, path: state.path, trash: state.trash });
    go(next.root, next.path, { push: false, trash: next.trash });
  }

  function goUp() {
    if (state.trash) return go(state.root, "", { trash: false });
    if (!state.path) return;
    // Land on the folder we came from.
    return go(state.root, parentPath(state.path), { focusName: baseName(state.path) });
  }

  // ---------- Painting ----------

  function paintRoots() {
    const host = $("fx-roots");
    if (!host) return;
    host.replaceChildren();
    for (const root of state.roots) {
      const button = el("button");
      button.type = "button";
      button.dataset.fxRoot = root.id;
      button.setAttribute("aria-current", !state.trash && root.id === state.root ? "page" : "false");
      button.title = root.path;
      const glyph = el("span", "bm-glyph fx-glyph");
      glyph.append(icon(root.builtin ? "home" : "drive"));
      const name = el("span", "bm-name", root.name);
      const small = el("small", "", root.ok === false ? "offline" : root.space ? `${formatBytes(root.space.free)} free` : "");
      button.append(glyph, name, small);
      if (root.ok === false) button.classList.add("is-offline");
      host.append(button);
    }
    const trashCount = state.roots.reduce((sum, root) => sum + (Number(root.trash) || 0), 0);
    const count = $("fx-trash-count");
    if (count) count.textContent = trashCount ? String(trashCount) : "";
    const trashButton = $("fx-trash-btn");
    if (trashButton) trashButton.setAttribute("aria-current", state.trash ? "page" : "false");
    const glyph = $("fx-trash-glyph");
    if (glyph && !glyph.firstChild) glyph.append(icon("trash"));
    paintSpace();
  }

  function paintSpace() {
    const root = currentRoot();
    const summary = spaceSummary(state.space || root?.space);
    const box = $("fx-space");
    if (!box) return;
    box.hidden = !summary;
    if (!summary) return;
    $("fx-space-fill").style.width = `${summary.percent}%`;
    $("fx-space-fill").classList.toggle("is-full", summary.percent >= 90);
    $("fx-space-text").textContent = `${summary.text} · ${summary.percent}% used`;
  }

  function paintCrumbs() {
    const host = $("fx-crumbs");
    if (!host) return;
    host.replaceChildren();
    if (state.trash) {
      const button = el("button", "fx-crumb is-last", "Trash");
      button.type = "button";
      host.append(button);
      return;
    }
    const list = crumbs(state.rootName, state.path);
    list.forEach((crumb, index) => {
      if (index) host.append(el("span", "fx-crumb-sep", "›"));
      const button = el("button", `fx-crumb${index === list.length - 1 ? " is-last" : ""}`, crumb.label);
      button.type = "button";
      button.dataset.fxCrumb = crumb.path;
      host.append(button);
    });
  }

  function paintHead() {
    const title = $("fx-title");
    const sub = $("fx-subtitle");
    const root = currentRoot();
    if (state.trash) {
      title.textContent = "Trash";
      sub.textContent = state.trashItems.length
        ? `${state.trashItems.length} deleted item${state.trashItems.length === 1 ? "" : "s"}. Restore puts them back where they were.`
        : "Deleted files wait here until you empty the trash.";
    } else {
      title.textContent = state.path ? baseName(state.path) : state.rootName;
      const where = root ? `${root.path}${state.path ? `/${state.path}` : ""}` : "";
      const counts = state.deep && state.filter.trim()
        ? `${state.shown.length} match${state.shown.length === 1 ? "" : "es"} for “${state.filter.trim()}”`
        : `${state.shown.length} item${state.shown.length === 1 ? "" : "s"}`;
      sub.textContent = where ? `${where} · ${counts}` : counts;
    }
    for (const id of ["fx-upload", "fx-upload-dir", "fx-new-folder"]) {
      const button = $(id);
      if (button) button.disabled = state.trash;
    }
    $("fx-back").disabled = !state.history.length;
    $("fx-forward").disabled = !state.future.length;
    $("fx-up").disabled = !state.trash && !state.path;
    document.querySelectorAll("[data-fx-view]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.fxView === state.view ? "true" : "false");
    });
    $("fx-sort").value = state.sort;
    $("fx-dir").textContent = state.dir === "desc" ? "↑" : "↓";
    $("fx-dir").title = state.dir === "desc" ? "Descending (click for ascending)" : "Ascending (click for descending)";
    $("fx-info-toggle").setAttribute("aria-pressed", state.info ? "true" : "false");
    document.querySelectorAll("#fx-list-head [data-fx-sort]").forEach((cell) => {
      cell.classList.toggle("is-sorted", cell.dataset.fxSort === state.sort);
      cell.dataset.dir = cell.dataset.fxSort === state.sort ? state.dir : "";
    });
  }

  let thumbs = null;
  function thumbObserver() {
    if (thumbs || typeof IntersectionObserver !== "function") return thumbs;
    thumbs = new IntersectionObserver((seen) => {
      for (const item of seen) {
        if (!item.isIntersecting) continue;
        const box = item.target;
        thumbs.unobserve(box);
        const src = box.dataset.src;
        if (!src) continue;
        if (box.dataset.kind === "video") {
          const video = document.createElement("video");
          video.muted = true;
          video.preload = "metadata";
          video.playsInline = true;
          video.src = `${src}#t=2`;
          video.addEventListener("loadeddata", () => box.classList.add("is-ready"), { once: true });
          video.addEventListener("error", () => video.remove(), { once: true });
          box.append(video);
        } else {
          const img = document.createElement("img");
          img.alt = "";
          img.decoding = "async";
          img.src = src;
          img.addEventListener("load", () => box.classList.add("is-ready"), { once: true });
          img.addEventListener("error", () => img.remove(), { once: true });
          box.append(img);
        }
      }
    }, { root: $("fx-pane"), rootMargin: "200px" });
    return thumbs;
  }

  function thumbFor(entry, size) {
    const kind = entryKind(entry);
    const box = el("span", `fx-thumb fx-thumb-${size} fx-kind-${kind}`);
    box.append(icon(kind));
    if (!state.trash && (kind === "image" || (kind === "video" && size === "big")) && !entry.outside) {
      box.dataset.src = rawUrl(state.root, entryPath(entry));
      box.dataset.kind = kind;
      const watcher = thumbObserver();
      if (watcher) watcher.observe(box);
    }
    return box;
  }

  function render() {
    const sorted = state.trash
      ? [...state.entries]
      : sortEntries(state.deep ? state.entries : filterEntries(state.entries, state.filter), state.sort, state.dir);
    state.shown = sorted;
    const keys = new Set(sorted.map(entryKey));
    for (const key of [...state.selected]) if (!keys.has(key)) state.selected.delete(key);
    if (state.focus >= sorted.length) state.focus = sorted.length - 1;
    if (thumbs) {
      thumbs.disconnect();
      thumbs = null;
    }
    const pane = $("fx-pane");
    pane.classList.toggle("is-list", state.view === "list");
    pane.classList.toggle("is-grid", state.view === "grid");
    pane.classList.toggle("is-trash", state.trash);
    $("fx-list-head").hidden = state.view !== "list";
    const host = $("fx-items");
    host.replaceChildren();
    sorted.forEach((entry, index) => host.append(state.view === "grid" ? gridItem(entry, index) : listItem(entry, index)));
    const empty = $("fx-empty");
    empty.hidden = sorted.length > 0;
    if (!sorted.length) {
      empty.textContent = state.trash
        ? "The trash is empty."
        : state.filter.trim()
          ? "Nothing matches that filter."
          : "This folder is empty. Drop files here, or press Upload.";
    }
    paintCrumbs();
    paintHead();
    paintSelection();
    paintSpace();
    paintClip();
    paintInfo();
  }

  function itemShell(entry, index) {
    const item = el("div", "fx-item");
    item.dataset.index = String(index);
    item.setAttribute("role", "option");
    const key = entryKey(entry);
    item.setAttribute("aria-selected", state.selected.has(key) ? "true" : "false");
    if (index === state.focus) item.classList.add("is-focus");
    if (state.clip && state.clip.mode === "cut" && state.clip.root === state.root && state.clip.paths.includes(entryPath(entry))) item.classList.add("is-cut");
    if (entry.type === "dir") item.classList.add("is-dir");
    if (entry.outside || entry.broken) item.classList.add("is-outside");
    item.draggable = !state.trash;
    item.title = entry.outside ? `${entry.name}: a link to somewhere outside this folder. Hog will not open it.` : entry.name;
    return item;
  }

  function listItem(entry, index) {
    const item = itemShell(entry, index);
    const check = el("input", "fx-check");
    check.type = "checkbox";
    check.tabIndex = -1;
    check.checked = state.selected.has(entryKey(entry));
    check.setAttribute("aria-label", `Select ${entry.name}`);
    const name = el("span", "fx-name");
    name.append(thumbFor(entry, "small"));
    const text = el("span", "fx-name-text");
    text.append(el("span", "fx-title", entry.name));
    if (state.trash) text.append(el("span", "fx-sub", `from ${entry.rootName} / ${parentPath(entry.path) || "(top)"}`));
    else if (entry.dir !== undefined) text.append(el("span", "fx-sub", entry.dir ? `in ${entry.dir}` : `in ${state.rootName}`));
    name.append(text);
    const kind = el("span", "fx-col fx-type", kindLabel(entry));
    const size = el("span", "fx-col fx-size", entry.type === "file" ? formatBytes(entry.size) : entry.type === "dir" ? "—" : "");
    const when = el("span", "fx-col fx-when", formatDate(state.trash ? entry.deletedAt : entry.mtime));
    item.append(check, name, kind, size, when);
    return item;
  }

  function gridItem(entry, index) {
    const item = itemShell(entry, index);
    item.classList.add("fx-tile");
    item.append(thumbFor(entry, "big"));
    item.append(el("span", "fx-tile-name", entry.name), el("span", "fx-tile-meta", entry.type === "file" ? formatBytes(entry.size) : kindLabel(entry)));
    return item;
  }

  function paintSelection() {
    const picked = selectedEntries();
    const bar = $("fx-selbar");
    bar.classList.toggle("is-empty", picked.length === 0);
    bar.setAttribute("aria-hidden", picked.length === 0 ? "true" : "false");
    $("fx-sel-count").textContent = selectionSummary(picked);
    const one = picked.length === 1;
    const files = picked.filter((entry) => entry.type === "file");
    bar.querySelectorAll("[data-fx-act]").forEach((button) => {
      const act = button.dataset.fxAct;
      if (state.trash) {
        button.hidden = !["restore", "purge", "clear"].includes(act);
      } else {
        button.hidden = act === "restore" || act === "purge";
        if (act === "rename" || act === "open") button.hidden = !one;
        if (act === "download") button.hidden = files.length === 0;
      }
    });
    document.querySelectorAll("#fx-items .fx-item").forEach((item) => {
      const entry = state.shown[Number(item.dataset.index)];
      const on = entry ? state.selected.has(entryKey(entry)) : false;
      item.setAttribute("aria-selected", on ? "true" : "false");
      const check = item.querySelector(".fx-check");
      if (check) check.checked = on;
    });
  }

  function paintClip() {
    const box = $("fx-clip");
    if (!box) return;
    box.hidden = !state.clip || state.trash;
    if (state.clip) {
      const count = state.clip.paths.length;
      $("fx-clip-text").textContent = `${count} item${count === 1 ? "" : "s"} ${state.clip.mode === "cut" ? "to move" : "to copy"}.`;
    }
  }

  function setFocus(index, { select = false, extend = false } = {}) {
    if (index < 0 || index >= state.shown.length) return;
    state.focus = index;
    const entry = state.shown[index];
    const key = entryKey(entry);
    if (extend && state.anchor) {
      state.selected = new Set(rangeSelect(state.shown.map(entryKey), state.anchor, key));
    } else if (select) {
      state.selected = new Set([key]);
      state.anchor = key;
    }
    document.querySelectorAll("#fx-items .fx-item.is-focus").forEach((item) => item.classList.remove("is-focus"));
    const node = document.querySelector(`#fx-items .fx-item[data-index="${index}"]`);
    if (node) {
      node.classList.add("is-focus");
      node.scrollIntoView({ block: "nearest" });
    }
    paintSelection();
    paintInfo();
  }

  function gridColumns() {
    if (state.view !== "grid") return 1;
    const items = document.querySelectorAll("#fx-items .fx-item");
    if (items.length < 2) return 1;
    const top = items[0].offsetTop;
    let cols = 0;
    for (const item of items) {
      if (item.offsetTop !== top) break;
      cols += 1;
    }
    return Math.max(1, cols);
  }

  // ---------- Info panel ----------

  let infoSeq = 0;
  async function paintInfo() {
    const panel = $("fx-info");
    if (!panel) return;
    panel.hidden = !state.info;
    if (!state.info) return;
    const picked = selectedEntries();
    const entry = picked.length === 1 ? picked[0] : picked.length === 0 ? state.shown[state.focus] : null;
    const preview = $("fx-info-preview");
    const list = $("fx-info-list");
    preview.replaceChildren();
    list.replaceChildren();
    const row = (label, value) => {
      if (value === undefined || value === null || value === "") return;
      list.append(el("dt", "", label), el("dd", "", String(value)));
    };
    const actions = panel.querySelector(".fx-info-actions");
    const seq = ++infoSeq;
    if (picked.length > 1) {
      $("fx-info-name").textContent = selectionSummary(picked);
      preview.append(icon("folder"));
      row("Folders", picked.filter((item) => item.type === "dir").length);
      row("Files", picked.filter((item) => item.type === "file").length);
      actions.hidden = true;
      return;
    }
    if (!entry) {
      const root = currentRoot();
      $("fx-info-name").textContent = state.trash ? "Trash" : (state.path ? baseName(state.path) : state.rootName);
      preview.append(icon(state.trash ? "trash" : "folder"));
      row("Items", state.shown.length);
      if (root && !state.trash) row("Location", `${root.path}${state.path ? `/${state.path}` : ""}`);
      const summary = spaceSummary(state.space || root?.space);
      if (summary) row("Disk", summary.text);
      actions.hidden = true;
      return;
    }
    actions.hidden = state.trash;
    $("fx-info-name").textContent = entry.name;
    const kind = entryKind(entry);
    if (!state.trash && !entry.outside && kind === "image") {
      const img = document.createElement("img");
      img.alt = "";
      img.src = rawUrl(state.root, entryPath(entry));
      preview.append(img);
    } else if (!state.trash && !entry.outside && kind === "video") {
      const video = document.createElement("video");
      video.muted = true;
      video.controls = true;
      video.preload = "metadata";
      video.src = `${rawUrl(state.root, entryPath(entry))}#t=2`;
      preview.append(video);
    } else {
      preview.append(icon(kind));
    }
    row("Type", kindLabel(entry));
    if (entry.type === "file") row("Size", `${formatBytes(entry.size)} (${Number(entry.size).toLocaleString()} bytes)`);
    if (state.trash) {
      row("From", `${entry.rootName} / ${entry.path}`);
      row("Deleted", formatDate(entry.deletedAt));
      return;
    }
    row("Modified", formatDate(entry.mtime));
    const root = currentRoot();
    if (root) row("Location", `${root.path}/${entryPath(entry)}`);
    if (entry.outside) {
      row("Note", "This link points outside the folder, so Hog will not open it.");
      return;
    }
    try {
      const info = await api("info", { params: { root: state.root, path: entryPath(entry) } });
      if (seq !== infoSeq) return;
      if (info.type === "dir") row("Contents", `${info.items} item${info.items === 1 ? "" : "s"}, ${formatBytes(info.size)}${info.partial ? "+" : ""}`);
      if (info.mime) row("MIME", info.mime);
      if (info.mode) row("Permissions", info.mode);
    } catch {
      // The basic facts are already shown.
    }
  }

  // ---------- Actions ----------

  function copyToClipboard(text) {
    if (typeof copyText === "function") return Promise.resolve(copyText(text));
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => {});
    return Promise.resolve();
  }

  function openEntry(entry) {
    if (!entry || state.trash) return;
    if (entry.outside || entry.broken) {
      status("That link points outside this folder, so Hog will not open it.", { error: true });
      return;
    }
    if (entry.type === "dir") {
      go(state.root, entryPath(entry));
      return;
    }
    if (PREVIEW_KINDS.has(entryKind(entry))) {
      openViewer(entry);
      return;
    }
    download([entry]);
  }

  function download(entries) {
    const files = entries.filter((entry) => entry.type === "file" && !entry.outside);
    if (!files.length) {
      status("Folders cannot be downloaded as one file. Open them over the network share, or select the files inside.", { error: true });
      return;
    }
    files.forEach((entry, index) => {
      setTimeout(() => {
        const link = document.createElement("a");
        link.href = rawUrl(state.root, entryPath(entry), { download: true });
        link.download = entry.name;
        link.rel = "noopener";
        document.body.append(link);
        link.click();
        link.remove();
      }, index * 400);
    });
    status(files.length === 1 ? `Downloading ${files[0].name}…` : `Downloading ${files.length} files…`);
  }

  function setClip(mode) {
    const entries = targetEntries();
    if (!entries.length || state.trash) return;
    state.clip = { mode, root: state.root, paths: entries.map(entryPath) };
    status(`${entries.length} item${entries.length === 1 ? "" : "s"} ${mode === "cut" ? "cut" : "copied"}. Open a folder and paste (Ctrl+V).`);
    render();
  }

  async function transfer({ root, paths, dest, copy }) {
    const data = await api(copy ? "copy" : "move", { method: "POST", body: { root, paths, dest } });
    const done = data.done.length;
    const skipped = data.skipped || [];
    let message = `${copy ? "Copied" : "Moved"} ${done} item${done === 1 ? "" : "s"}.`;
    if (skipped.length) message += ` Skipped ${skipped.length}: ${skipped[0].reason}`;
    status(message, { error: done === 0 && skipped.length > 0 });
    return data;
  }

  async function paste(destPath = state.path) {
    if (!state.clip || state.trash) return;
    const clip = state.clip;
    try {
      await transfer({ root: clip.root, paths: clip.paths, dest: { root: state.root, path: destPath }, copy: clip.mode === "copy" });
      if (clip.mode === "cut") state.clip = null;
      await loadRoots();
      await load({ keepSelection: true });
    } catch (error) {
      fail(error);
    }
  }

  function showUndo(handler) {
    const box = $("fx-status");
    if (!box) return;
    const button = el("button", "bm-undo", "Undo");
    button.type = "button";
    button.addEventListener("click", () => {
      button.remove();
      handler().catch(fail);
    }, { once: true });
    box.append(" ", button);
  }

  async function trashSelected() {
    const entries = targetEntries();
    if (!entries.length || state.trash) return;
    try {
      const data = await api("trash", { method: "POST", body: { root: state.root, paths: entries.map(entryPath) } });
      const ids = data.done.map((item) => item.id);
      const root = state.root;
      await loadRoots();
      await load();
      status(`Moved ${ids.length} item${ids.length === 1 ? "" : "s"} to Trash.`);
      showUndo(async () => {
        await api("restore", { method: "POST", body: { root, ids } });
        await loadRoots();
        await load();
        status("Restored.");
      });
    } catch (error) {
      fail(error);
    }
  }

  function byRoot(entries) {
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.root)) groups.set(entry.root, []);
      groups.get(entry.root).push(entry.id);
    }
    return groups;
  }

  async function restoreSelected() {
    const entries = targetEntries();
    if (!entries.length) return;
    try {
      let count = 0;
      for (const [root, ids] of byRoot(entries)) count += (await api("restore", { method: "POST", body: { root, ids } })).done.length;
      await loadRoots();
      await load();
      status(`Restored ${count} item${count === 1 ? "" : "s"} to where they were.`);
    } catch (error) {
      fail(error);
    }
  }

  async function purgeSelected({ all = false } = {}) {
    const entries = all ? state.trashItems : targetEntries();
    if (!entries.length) return;
    const ok = await confirmDialog({
      title: all ? "Empty trash" : "Delete forever",
      text: all
        ? `Delete all ${entries.length} items in the trash for good? This cannot be undone.`
        : `Delete ${entries.length} item${entries.length === 1 ? "" : "s"} for good? This cannot be undone.`,
      okLabel: "Delete forever",
    });
    if (!ok) return;
    try {
      let count = 0;
      for (const [root, ids] of byRoot(entries)) count += (await api("purge", { method: "POST", body: { root, ids } })).removed;
      await loadRoots();
      await load();
      status(`Deleted ${count} item${count === 1 ? "" : "s"} for good.`);
    } catch (error) {
      fail(error);
    }
  }

  async function newFolder() {
    if (state.trash) return;
    const name = await promptDialog({ title: "New folder", text: `Inside ${state.path || state.rootName}`, value: "New folder", okLabel: "Create" });
    if (!name) return;
    try {
      await api("mkdir", { method: "POST", body: { root: state.root, path: state.path, name } });
      await load({ focusName: name });
      status(`Created ${name}.`);
    } catch (error) {
      fail(error);
    }
  }

  async function renameEntry() {
    const entries = targetEntries();
    if (entries.length !== 1 || state.trash) return;
    const entry = entries[0];
    const name = await promptDialog({ title: "Rename", text: entry.name, value: entry.name, okLabel: "Rename", selectStem: entry.type === "file" });
    if (!name || name === entry.name) return;
    try {
      await api("rename", { method: "POST", body: { root: state.root, path: entryPath(entry), name } });
      await load({ focusName: name });
      status(`Renamed to ${name}.`);
    } catch (error) {
      fail(error);
    }
  }

  function copyPath() {
    const entries = targetEntries();
    const root = currentRoot();
    if (!root) return;
    const paths = entries.length ? entries.map((entry) => `${root.path}/${entryPath(entry)}`) : [`${root.path}${state.path ? `/${state.path}` : ""}`];
    copyToClipboard(paths.join("\n"));
    status(paths.length === 1 ? `Copied ${paths[0]}` : `Copied ${paths.length} paths.`);
  }

  // ---------- Dialogs ----------

  function openDialog({ title, text = "", value = "", okLabel = "OK", input = true, selectStem = false }) {
    if (state.dialog) closeDialog(state.dialog.input ? "" : false);
    return new Promise((resolve) => {
      const form = $("fx-dialog");
      const field = $("fx-dialog-input");
      $("fx-dialog-title").textContent = title;
      $("fx-dialog-text").textContent = text;
      $("fx-dialog-ok").textContent = okLabel;
      $("fx-dialog-ok").classList.toggle("is-danger", !input);
      $("fx-dialog-error").textContent = "";
      field.hidden = !input;
      field.value = value;
      form.hidden = false;
      state.dialog = { resolve, input };
      requestAnimationFrame(() => {
        if (input) {
          field.focus();
          const dot = selectStem ? value.lastIndexOf(".") : -1;
          field.setSelectionRange(0, dot > 0 ? dot : value.length);
        } else {
          $("fx-dialog-ok").focus();
        }
      });
    });
  }

  function closeDialog(result) {
    const dialog = state.dialog;
    if (!dialog) return;
    state.dialog = null;
    $("fx-dialog").hidden = true;
    dialog.resolve(result);
    $("fx-pane")?.focus({ preventScroll: true });
  }

  function promptDialog(options) {
    return openDialog({ ...options, input: true });
  }

  function confirmDialog(options) {
    return openDialog({ ...options, input: false }).then((value) => value === true);
  }

  // ---------- Viewer ----------

  function previewables() {
    return state.shown.filter((entry) => entry.type === "file" && !entry.outside && PREVIEW_KINDS.has(entryKind(entry)));
  }

  async function openViewer(entry) {
    const list = previewables();
    const index = list.findIndex((item) => entryKey(item) === entryKey(entry));
    if (index < 0) return;
    state.viewer = { list, index };
    $("fx-viewer").hidden = false;
    placeViewer();
    await paintViewer();
  }

  /** Cover the page area only, so Hog's tab bar and address bar stay usable. */
  function placeViewer() {
    const viewer = $("fx-viewer");
    const area = document.getElementById("view") || $("files-view");
    if (!viewer || !area) return;
    const box = area.getBoundingClientRect();
    viewer.style.top = `${Math.round(box.top)}px`;
    viewer.style.left = `${Math.round(box.left)}px`;
    viewer.style.width = `${Math.round(box.width)}px`;
    viewer.style.height = `${Math.round(box.height)}px`;
  }

  function stopMedia(stage) {
    stage.querySelectorAll("video, audio").forEach((media) => {
      media.pause();
      media.removeAttribute("src");
      media.load();
    });
  }

  function closeViewer() {
    if (!state.viewer) return;
    state.viewer = null;
    const stage = $("fx-viewer-stage");
    stopMedia(stage);
    stage.replaceChildren();
    $("fx-viewer").hidden = true;
    $("fx-pane")?.focus({ preventScroll: true });
  }

  async function paintViewer() {
    const viewer = state.viewer;
    if (!viewer) return;
    const entry = viewer.list[viewer.index];
    const stage = $("fx-viewer-stage");
    stopMedia(stage);
    stage.replaceChildren();
    $("fx-viewer-name").textContent = entry.name;
    $("fx-viewer-meta").textContent = `${formatBytes(entry.size)} · ${viewer.index + 1} of ${viewer.list.length}`;
    $("fx-viewer-prev").disabled = viewer.index === 0;
    $("fx-viewer-next").disabled = viewer.index === viewer.list.length - 1;
    const src = rawUrl(state.root, entryPath(entry));
    const kind = entryKind(entry);
    if (kind === "image") {
      const img = document.createElement("img");
      img.alt = entry.name;
      img.src = src;
      stage.append(img);
    } else if (kind === "video") {
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.src = src;
      video.addEventListener("error", () => {
        stage.append(el("p", "note fx-viewer-note", "This video format does not play inside Hog. Download it, or play it in Jellyfin."));
      }, { once: true });
      stage.append(video);
    } else if (kind === "audio") {
      const wrap = el("div", "fx-viewer-audio");
      wrap.append(icon("audio"));
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.autoplay = true;
      audio.src = src;
      wrap.append(audio);
      stage.append(wrap);
    } else {
      const pre = el("pre", "fx-viewer-text", "Loading…");
      stage.append(pre);
      try {
        const response = await fetch(src, { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` }, credentials: "same-origin" });
        if (!response.ok) throw new Error(`Files answered ${response.status}.`);
        const text = await response.text();
        if (state.viewer !== viewer) return;
        pre.textContent = text + (entry.size > TEXT_PREVIEW_BYTES ? "\n\n… (showing the first 512 KB)" : "");
      } catch (error) {
        pre.textContent = error.message;
      }
    }
  }

  function stepViewer(delta) {
    const viewer = state.viewer;
    if (!viewer) return;
    const next = viewer.index + delta;
    if (next < 0 || next >= viewer.list.length) return;
    viewer.index = next;
    paintViewer();
  }

  // ---------- Context menu ----------

  function menuItem(label, hint, action, { danger = false, disabled = false } = {}) {
    const button = el("button", danger ? "is-danger" : "");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.fxMenu = action;
    button.disabled = disabled;
    button.append(el("span", "", label));
    if (hint) button.append(el("kbd", "", hint));
    return button;
  }

  function openMenu(x, y, { onItem = false, folder = null } = {}) {
    const menu = $("fx-menu");
    menu.replaceChildren();
    const list = el("div", "fx-menu-list");
    const picked = targetEntries();
    const one = picked.length === 1 ? picked[0] : null;
    const sep = () => list.append(el("hr"));
    if (state.trash) {
      if (onItem) list.append(menuItem("Restore", "Enter", "restore"), menuItem("Delete forever", "Del", "purge", { danger: true }));
      else list.append(menuItem("Empty trash", "", "empty-trash", { danger: true, disabled: !state.trashItems.length }), menuItem("Refresh", "", "refresh"));
    } else if (onItem) {
      if (one) list.append(menuItem(one.type === "dir" ? "Open" : PREVIEW_KINDS.has(entryKind(one)) ? "Preview" : "Open", "Enter", "open"));
      if (picked.some((entry) => entry.type === "file")) list.append(menuItem("Download", "", "download"));
      sep();
      list.append(menuItem("Cut", "Ctrl+X", "cut"), menuItem("Copy", "Ctrl+C", "copy"));
      if (folder && state.clip) list.append(menuItem(`Paste into ${folder.name}`, "", "paste-into"));
      if (one) list.append(menuItem("Rename", "F2", "rename"));
      list.append(menuItem("Copy path", "", "copy-path"), menuItem("Details", "Ctrl+I", "info"));
      sep();
      list.append(menuItem("Move to Trash", "Del", "trash", { danger: true }));
    } else {
      list.append(
        menuItem("New folder", "Ctrl+Shift+N", "new-folder"),
        menuItem("Upload files…", "Ctrl+U", "upload"),
        menuItem("Upload a folder…", "", "upload-dir"),
      );
      if (state.clip) list.append(menuItem("Paste", "Ctrl+V", "paste"));
      sep();
      list.append(
        menuItem("Select all", "Ctrl+A", "select-all"),
        menuItem(state.view === "list" ? "Grid view" : "List view", state.view === "list" ? "Ctrl+2" : "Ctrl+1", "toggle-view"),
        menuItem("Copy folder path", "", "copy-path"),
        menuItem("Refresh", "", "refresh"),
      );
    }
    menu.append(list);
    menu.hidden = false;
    state.menuOpen = true;
    state.menuFolder = folder;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }

  function closeMenu() {
    const menu = $("fx-menu");
    if (menu) menu.hidden = true;
    state.menuOpen = false;
  }

  function setView(view) {
    if (!VIEW_MODES.includes(view)) return;
    state.view = view;
    savePrefs();
    render();
  }

  function toggleInfo() {
    state.info = !state.info;
    savePrefs();
    paintHead();
    paintInfo();
  }

  function runAction(action) {
    closeMenu();
    const picked = targetEntries();
    switch (action) {
      case "open":
        if (picked.length === 1) openEntry(picked[0]);
        break;
      case "download":
        download(picked);
        break;
      case "cut":
      case "copy":
        setClip(action);
        break;
      case "paste":
        paste();
        break;
      case "paste-into":
        if (state.menuFolder) paste(entryPath(state.menuFolder));
        break;
      case "rename":
        renameEntry();
        break;
      case "copy-path":
        copyPath();
        break;
      case "info":
        toggleInfo();
        break;
      case "trash":
        trashSelected();
        break;
      case "restore":
        restoreSelected();
        break;
      case "purge":
        purgeSelected();
        break;
      case "empty-trash":
        purgeSelected({ all: true });
        break;
      case "new-folder":
        newFolder();
        break;
      case "upload":
        if (!state.trash) $("fx-file").click();
        break;
      case "upload-dir":
        if (!state.trash) $("fx-dir-input").click();
        break;
      case "select-all":
        state.selected = new Set(state.shown.map(entryKey));
        paintSelection();
        paintInfo();
        break;
      case "toggle-view":
        setView(state.view === "list" ? "grid" : "list");
        break;
      case "refresh":
        loadRoots().then(() => load({ keepSelection: true }));
        break;
      case "clear":
        state.selected.clear();
        paintSelection();
        paintInfo();
        break;
      default:
        break;
    }
  }

  // ---------- Uploads ----------

  function paintUploads() {
    const box = $("fx-uploads");
    const list = $("fx-upload-list");
    if (!box || !list) return;
    box.hidden = state.uploads.length === 0;
    list.replaceChildren();
    let sending = 0;
    for (const item of state.uploads) {
      if (item.state === "queued" || item.state === "sending") sending += 1;
      const row = el("li", `fx-up is-${item.state}`);
      const meter = el("span", "fx-meter fx-up-meter");
      const fill = el("span");
      const percent = item.size ? Math.round((item.sent / item.size) * 100) : item.state === "done" ? 100 : 0;
      fill.style.width = `${Math.min(100, percent)}%`;
      meter.append(fill);
      const label = item.state === "done"
        ? "Done"
        : item.state === "error"
          ? item.error || "Failed"
          : item.state === "cancelled"
            ? "Cancelled"
            : item.state === "queued"
              ? "Waiting"
              : `${percent}% · ${formatBytes(item.sent)} of ${formatBytes(item.size)}`;
      row.append(el("span", "fx-up-name", item.rel), meter, el("span", "fx-up-state", label));
      if (item.state === "queued" || item.state === "sending") {
        const cancel = el("button", "tiny", "✕");
        cancel.type = "button";
        cancel.title = "Cancel upload";
        cancel.addEventListener("click", () => cancelUpload(item));
        row.append(cancel);
      } else if (item.state === "error") {
        const retry = el("button", "tiny", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => {
          item.state = "queued";
          item.error = "";
          pumpUploads();
        });
        row.append(retry);
      }
      list.append(row);
    }
    $("fx-uploads-title").textContent = sending ? `Uploading ${sending} file${sending === 1 ? "" : "s"}` : "Uploads";
  }

  let paintQueued = false;
  function paintUploadsSoon() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      paintUploads();
    });
  }

  function enqueue(files, root = state.root, dir = state.path) {
    if (!files.length) return;
    for (const { file, rel } of files) {
      state.uploads.push({ id: uploadId(), file, rel, root, dir, size: file.size, sent: 0, state: "queued", error: "" });
    }
    status(`Uploading ${files.length} file${files.length === 1 ? "" : "s"} into ${dir || state.rootName}…`);
    pumpUploads();
  }

  function pumpUploads() {
    while (state.active < MAX_PARALLEL) {
      const next = state.uploads.find((item) => item.state === "queued");
      if (!next) break;
      state.active += 1;
      next.state = "sending";
      runUpload(next).finally(() => {
        state.active -= 1;
        pumpUploads();
        if (!state.uploads.some((item) => item.state === "queued" || item.state === "sending")) uploadsFinished();
      });
    }
    paintUploads();
  }

  function uploadsFinished() {
    const failed = state.uploads.filter((item) => item.state === "error").length;
    const done = state.uploads.filter((item) => item.state === "done").length;
    if (failed) status(`${failed} upload${failed === 1 ? "" : "s"} failed. Press Retry next to it.`, { error: true });
    else if (done) status(`Uploaded ${done} file${done === 1 ? "" : "s"}.`);
    loadRoots();
  }

  let refreshTimer = 0;
  function refreshSoon(root, dir) {
    if (!state.open || state.trash || root !== state.root) return;
    if (dir !== state.path && !(state.path === "" || dir.startsWith(`${state.path}/`))) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => load({ keepSelection: true }), 400);
  }

  function sendChunk(item, offset, blob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      const params = query({ root: item.root, dir: item.dir, rel: item.rel, id: item.id, offset, total: item.size });
      xhr.open("PUT", `/api/files/upload?${params}`);
      xhr.setRequestHeader("x-hog-files", "1");
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        item.sent = offset + (event.loaded || 0);
        paintUploadsSoon();
      };
      xhr.onload = () => {
        item.xhr = null;
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch {
          data = {};
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) {
          resolve(data);
          return;
        }
        const error = new Error(data.error || `Upload failed (${xhr.status}).`);
        error.status = xhr.status;
        error.data = data;
        reject(error);
      };
      xhr.onerror = () => {
        item.xhr = null;
        const error = new Error("The connection to Hog dropped.");
        error.retry = true;
        reject(error);
      };
      xhr.onabort = () => {
        item.xhr = null;
        const error = new Error("Cancelled");
        error.cancelled = true;
        reject(error);
      };
      xhr.send(blob);
    });
  }

  async function runUpload(item) {
    let offset = 0;
    let tries = 0;
    for (;;) {
      if (item.state === "cancelled") return;
      const end = Math.min(item.size, offset + CHUNK_SIZE);
      try {
        const result = await sendChunk(item, offset, item.file.slice(offset, end));
        tries = 0;
        if (result.done) {
          item.state = "done";
          item.sent = item.size;
          item.final = result.path;
          refreshSoon(item.root, parentPath(joinPath(item.dir, item.rel)));
          return;
        }
        offset = result.size;
        item.sent = offset;
      } catch (error) {
        if (error.cancelled || item.state === "cancelled") {
          item.state = "cancelled";
          return;
        }
        tries += 1;
        if (error.status === 409 && error.data && Number.isFinite(error.data.size) && tries < 4) {
          offset = Number(error.data.size);
          continue;
        }
        if (error.retry && tries < 5) {
          await new Promise((r) => setTimeout(r, 600 * tries));
          try {
            offset = (await api("upload", { params: { root: item.root, dir: item.dir, rel: item.rel, id: item.id } })).size || 0;
          } catch {
            offset = 0;
          }
          continue;
        }
        item.state = "error";
        item.error = error.message;
        return;
      }
    }
  }

  function cancelUpload(item) {
    const was = item.state;
    item.state = "cancelled";
    if (item.xhr) item.xhr.abort();
    if (was === "sending") {
      api("upload/cancel", { method: "POST", body: { root: item.root, dir: item.dir, rel: item.rel, id: item.id } }).catch(() => {});
    }
    paintUploads();
  }

  function goodFiles(files) {
    const bad = files.filter((item) => item.rel.split("/").some((part) => nameProblem(part)));
    if (bad.length) {
      const why = bad[0].rel.split("/").map(nameProblem).find(Boolean);
      status(`${bad.length} item${bad.length === 1 ? "" : "s"} skipped: ${why}`, { error: true });
    }
    return files.filter((item) => !bad.includes(item));
  }

  /** Files and folders from a drop. The entries must be read synchronously. */
  function collectDrop(dataTransfer) {
    const items = [...(dataTransfer.items || [])];
    const roots = items.map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null)).filter(Boolean);
    const plain = [...(dataTransfer.files || [])];
    return (async () => {
      if (!roots.length) return { files: plain.map((file) => ({ file, rel: file.name })), dirs: [] };
      const files = [];
      const dirs = [];
      const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      async function walk(entry, prefix) {
        if (entry.isFile) {
          const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
          files.push({ file, rel: prefix + entry.name });
          return;
        }
        if (!entry.isDirectory) return;
        const here = `${prefix}${entry.name}`;
        dirs.push(here);
        const reader = entry.createReader();
        for (;;) {
          const batch = await readBatch(reader);
          if (!batch.length) break;
          for (const child of batch) await walk(child, `${here}/`);
        }
      }
      for (const entry of roots) await walk(entry, "");
      return { files, dirs };
    })();
  }

  async function uploadDrop(dropped, root, dir) {
    try {
      const { files, dirs } = await dropped;
      const good = goodFiles(files);
      // Empty folders need making; the others appear as their files land.
      const filled = [...new Set(good.map((item) => parentPath(item.rel)))];
      for (const sub of dirs) {
        if (sub.split("/").some((part) => nameProblem(part))) continue;
        if (filled.some((path) => path === sub || path.startsWith(`${sub}/`))) continue;
        try {
          await api("mkdir", { method: "POST", body: { root, path: joinPath(dir, parentPath(sub)), name: baseName(sub) } });
        } catch (error) {
          if (error.status !== 409) fail(error);
        }
      }
      if (good.length) enqueue(good, root, dir);
      else if (dirs.length) refreshSoon(root, dir);
    } catch (error) {
      fail(error);
    }
  }

  // ---------- Drag and drop ----------

  function dragTypes(event) {
    return [...(event.dataTransfer?.types || [])];
  }

  function internalDrag(event) {
    return dragTypes(event).includes(DRAG_TYPE);
  }

  function externalDrag(event) {
    const types = dragTypes(event);
    return types.includes("Files") && !types.includes(DRAG_TYPE);
  }

  function dropTargetFrom(event) {
    const item = event.target.closest?.("#fx-items .fx-item.is-dir");
    if (item) {
      const entry = state.shown[Number(item.dataset.index)];
      if (entry && !entry.outside) return { node: item, root: state.root, path: entryPath(entry), label: entry.name };
    }
    const crumb = event.target.closest?.("[data-fx-crumb]");
    if (crumb) return { node: crumb, root: state.root, path: crumb.dataset.fxCrumb, label: crumb.textContent };
    const rootButton = event.target.closest?.("[data-fx-root]");
    if (rootButton) {
      const root = state.roots.find((entry) => entry.id === rootButton.dataset.fxRoot);
      if (root) return { node: rootButton, root: root.id, path: "", label: root.name };
    }
    if (event.target.closest?.("#fx-pane")) {
      return { node: null, root: state.root, path: state.path, label: state.path ? baseName(state.path) : state.rootName, pane: true };
    }
    return null;
  }

  function clearDropMarks() {
    document.querySelectorAll("#files-view .is-drop").forEach((node) => node.classList.remove("is-drop"));
  }

  function hideDropHint() {
    const hint = $("fx-drop");
    if (hint) hint.hidden = true;
  }

  function onDragStart(event) {
    const item = event.target.closest?.("#fx-items .fx-item");
    if (!item || state.trash) return;
    const entry = state.shown[Number(item.dataset.index)];
    if (!entry) return;
    const key = entryKey(entry);
    if (!state.selected.has(key)) {
      state.selected = new Set([key]);
      state.anchor = key;
      paintSelection();
    }
    const paths = selectedEntries().map(entryPath);
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ root: state.root, paths }));
    event.dataTransfer.setData("text/plain", paths.join("\n"));
    event.dataTransfer.effectAllowed = "copyMove";
    document.querySelectorAll("#fx-items .fx-item[aria-selected='true']").forEach((node) => node.classList.add("is-dragging"));
  }

  function onDragEnd() {
    document.querySelectorAll("#fx-items .is-dragging").forEach((node) => node.classList.remove("is-dragging"));
    clearDropMarks();
    hideDropHint();
  }

  function onDragOver(event) {
    const internal = internalDrag(event);
    const external = externalDrag(event);
    if ((!internal && !external) || state.trash) return;
    const target = dropTargetFrom(event);
    if (!target) return;
    if (internal && target.pane) return; // Same folder: nothing to do.
    event.preventDefault();
    event.dataTransfer.dropEffect = internal ? (event.ctrlKey ? "copy" : "move") : "copy";
    clearDropMarks();
    if (target.node) target.node.classList.add("is-drop");
    if (external) {
      $("fx-drop-text").textContent = `Drop to upload into ${target.label}`;
      $("fx-drop").hidden = false;
    }
  }

  function onDragLeave(event) {
    if (!event.relatedTarget || !$("files-view").contains(event.relatedTarget)) {
      clearDropMarks();
      hideDropHint();
    }
  }

  function onDrop(event) {
    const internal = internalDrag(event);
    const external = externalDrag(event);
    const target = dropTargetFrom(event);
    clearDropMarks();
    hideDropHint();
    if (!target || state.trash || (!internal && !external)) return;
    event.preventDefault();
    if (external) {
      uploadDrop(collectDrop(event.dataTransfer), target.root, target.path);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(event.dataTransfer.getData(DRAG_TYPE) || "{}");
    } catch {
      return;
    }
    if (!Array.isArray(payload.paths) || !payload.paths.length) return;
    if (payload.root === target.root && payload.paths.every((path) => parentPath(path) === target.path)) return;
    transfer({ root: payload.root, paths: payload.paths, dest: { root: target.root, path: target.path }, copy: event.ctrlKey })
      .then(() => loadRoots())
      .then(() => load())
      .catch(fail);
  }

  // ---------- Samba card ----------

  function paintSamba() {
    const box = $("fx-smb");
    if (!box) return;
    const samba = state.samba;
    const text = $("fx-smb-state");
    const list = $("fx-smb-links");
    list.replaceChildren();
    const off = "Samba is off. Turn it on to open ~/hog-shares from your phone or another computer on your tailnet.";
    if (!samba || !samba.running) {
      text.textContent = samba && samba.enabled && samba.error ? samba.error : off;
      $("fx-smb-setup").textContent = "Set up Samba…";
      return;
    }
    text.textContent = `On for your tailnet only. Sign in as ${samba.user || "your Samba user"}.`;
    for (const link of smbLinks({ dns: samba.dns, ip: samba.ip, share: samba.share || "hog-shares" })) {
      const row = el("li");
      const copy = el("button", "tiny", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => {
        copyToClipboard(link.value);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      });
      row.append(el("small", "", link.label), el("code", "", link.value), copy);
      list.append(row);
    }
    $("fx-smb-setup").textContent = "Samba settings…";
  }

  // ---------- Keyboard and pointer ----------

  function editingTarget(target) {
    return Boolean(target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) && target.type !== "checkbox");
  }

  function onKey(event) {
    if (!state.open) return false;
    if (state.dialog) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog(state.dialog.input ? "" : false);
        return true;
      }
      return false;
    }
    if (state.viewer) {
      if (event.key === "Escape" || event.key === " " && !editingTarget(event.target)) {
        event.preventDefault();
        closeViewer();
        return true;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        stepViewer(1);
        return true;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        stepViewer(-1);
        return true;
      }
      return false;
    }
    if (state.menuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return true;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [...$("fx-menu").querySelectorAll("button:not(:disabled)")];
        const at = buttons.indexOf(document.activeElement);
        const next = event.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return true;
      }
      return false;
    }
    const editing = editingTarget(event.target);
    const action = keyAction(event, { editing });
    if (!action) return false;
    if (editing && action === "escape") {
      if (event.target.id === "fx-search" && event.target.value) {
        event.target.value = "";
        state.filter = "";
        render();
      }
      event.target.blur();
      $("fx-pane")?.focus({ preventScroll: true });
      event.preventDefault();
      return true;
    }
    const focused = state.shown[state.focus];
    switch (action) {
      case "escape":
        if (state.selected.size) runAction("clear");
        else if (state.clip) {
          state.clip = null;
          render();
        } else return false;
        break;
      case "select-all":
      case "copy":
      case "cut":
      case "paste":
      case "new-folder":
      case "upload":
      case "info":
      case "rename":
      case "trash":
        if (state.trash && action === "trash") runAction("purge");
        else runAction(action);
        break;
      case "search":
        $("fx-search")?.focus();
        $("fx-search")?.select();
        break;
      case "view-list":
        setView("list");
        break;
      case "view-grid":
        setView("grid");
        break;
      case "up":
        goUp();
        break;
      case "back":
        goBack();
        break;
      case "forward":
        goForward();
        break;
      case "open":
        if (state.trash) runAction("restore");
        else if (selectedEntries().length > 1) download(selectedEntries());
        else if (focused) openEntry(focused);
        else return false;
        break;
      case "preview":
        if (focused && focused.type === "file" && PREVIEW_KINDS.has(entryKind(focused)) && !state.trash) openViewer(focused);
        else if (focused) {
          const key = entryKey(focused);
          if (state.selected.has(key)) state.selected.delete(key);
          else state.selected.add(key);
          state.anchor = key;
          paintSelection();
          paintInfo();
        }
        break;
      case "move":
      case "extend": {
        const next = moveFocus(state.focus, event.key, state.shown.length, gridColumns());
        if (next < 0) return false;
        if (action === "extend" && !state.anchor && focused) state.anchor = entryKey(focused);
        setFocus(next, { select: action === "move", extend: action === "extend" });
        break;
      }
      default:
        return false;
    }
    event.preventDefault();
    return true;
  }

  function itemFromEvent(event) {
    const node = event.target.closest?.("#fx-items .fx-item");
    if (!node) return null;
    const index = Number(node.dataset.index);
    const entry = state.shown[index];
    return entry ? { node, index, entry } : null;
  }

  function onPaneClick(event) {
    closeMenu();
    const hit = itemFromEvent(event);
    if (!hit) {
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.target.closest?.("#fx-pane")) runAction("clear");
      return;
    }
    const key = entryKey(hit.entry);
    const toggle = event.ctrlKey || event.metaKey || event.target.classList.contains("fx-check");
    if (event.shiftKey && state.anchor) {
      setFocus(hit.index, { extend: true });
      return;
    }
    if (toggle) {
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
      state.anchor = key;
      state.focus = hit.index;
      paintSelection();
      paintInfo();
      return;
    }
    setFocus(hit.index, { select: true });
  }

  // ---------- Wiring ----------

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    const view = $("files-view");
    const pane = $("fx-pane");
    $("fx-roots").addEventListener("click", (event) => {
      const button = event.target.closest("[data-fx-root]");
      if (button) go(button.dataset.fxRoot, "");
    });
    $("fx-trash-btn").addEventListener("click", () => go(state.root, "", { trash: true }));
    $("fx-add-root").addEventListener("click", () => openSettings("files"));
    $("fx-smb-setup").addEventListener("click", () => openSettings("tailscale"));
    $("fx-back").addEventListener("click", goBack);
    $("fx-forward").addEventListener("click", goForward);
    $("fx-up").addEventListener("click", () => goUp());
    $("fx-refresh").addEventListener("click", () => runAction("refresh"));
    $("fx-crumbs").addEventListener("click", (event) => {
      const crumb = event.target.closest("[data-fx-crumb]");
      if (crumb && !state.trash) go(state.root, crumb.dataset.fxCrumb);
    });
    $("fx-upload").addEventListener("click", () => runAction("upload"));
    $("fx-upload-dir").addEventListener("click", () => runAction("upload-dir"));
    $("fx-new-folder").addEventListener("click", newFolder);
    let searchTimer = 0;
    $("fx-search").addEventListener("input", (event) => {
      state.filter = event.target.value;
      clearTimeout(searchTimer);
      if (state.deep) searchTimer = setTimeout(() => load(), 300);
      else render();
    });
    $("fx-deep").addEventListener("change", (event) => {
      state.deep = event.target.checked;
      load();
    });
    $("fx-sort").addEventListener("change", (event) => {
      if (SORT_KEYS.includes(event.target.value)) state.sort = event.target.value;
      savePrefs();
      render();
    });
    $("fx-dir").addEventListener("click", () => {
      state.dir = state.dir === "asc" ? "desc" : "asc";
      savePrefs();
      render();
    });
    $("fx-list-head").addEventListener("click", (event) => {
      const cell = event.target.closest("[data-fx-sort]");
      if (!cell) return;
      const key = cell.dataset.fxSort;
      if (state.sort === key) state.dir = state.dir === "asc" ? "desc" : "asc";
      else {
        state.sort = key;
        state.dir = key === "name" || key === "kind" ? "asc" : "desc";
      }
      savePrefs();
      render();
    });
    view.querySelectorAll("[data-fx-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.fxView)));
    $("fx-info-toggle").addEventListener("click", toggleInfo);
    view.querySelectorAll("[data-fx-act]").forEach((button) => button.addEventListener("click", () => runAction(button.dataset.fxAct)));
    $("fx-copy-path").addEventListener("click", copyPath);
    $("fx-paste").addEventListener("click", () => paste());
    $("fx-clip-clear").addEventListener("click", () => {
      state.clip = null;
      render();
    });
    $("fx-uploads-clear").addEventListener("click", () => {
      state.uploads = state.uploads.filter((item) => item.state === "queued" || item.state === "sending");
      paintUploads();
    });
    const pick = (input, folder) => input.addEventListener("change", () => {
      const files = [...input.files].map((file) => ({ file, rel: folder && file.webkitRelativePath ? file.webkitRelativePath : file.name }));
      input.value = "";
      enqueue(goodFiles(files));
    });
    pick($("fx-file"), false);
    pick($("fx-dir-input"), true);

    pane.addEventListener("click", onPaneClick);
    pane.addEventListener("dblclick", (event) => {
      const hit = itemFromEvent(event);
      if (!hit) return;
      if (state.trash) {
        setFocus(hit.index, { select: true });
        restoreSelected();
      } else openEntry(hit.entry);
    });
    view.addEventListener("contextmenu", (event) => {
      if (!event.target.closest("#fx-pane")) return;
      event.preventDefault();
      const hit = itemFromEvent(event);
      if (hit && !state.selected.has(entryKey(hit.entry))) setFocus(hit.index, { select: true });
      if (!hit) runAction("clear");
      openMenu(event.clientX, event.clientY, { onItem: Boolean(hit), folder: hit && hit.entry.type === "dir" ? hit.entry : null });
    });
    $("fx-menu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-fx-menu]");
      if (button && !button.disabled) runAction(button.dataset.fxMenu);
    });
    document.addEventListener("pointerdown", (event) => {
      if (state.menuOpen && !event.target.closest("#fx-menu")) closeMenu();
    }, true);
    window.addEventListener("blur", closeMenu);

    view.addEventListener("dragstart", onDragStart);
    view.addEventListener("dragend", onDragEnd);
    view.addEventListener("dragover", onDragOver);
    view.addEventListener("dragleave", onDragLeave);
    view.addEventListener("drop", onDrop);

    $("fx-dialog").addEventListener("submit", (event) => {
      event.preventDefault();
      const dialog = state.dialog;
      if (!dialog) return;
      if (!dialog.input) {
        closeDialog(true);
        return;
      }
      const value = $("fx-dialog-input").value.trim();
      const problem = nameProblem(value);
      if (problem) {
        $("fx-dialog-error").textContent = problem;
        return;
      }
      closeDialog(value);
    });
    $("fx-dialog-cancel").addEventListener("click", () => closeDialog(state.dialog && state.dialog.input ? "" : false));
    $("fx-dialog-input").addEventListener("input", () => { $("fx-dialog-error").textContent = ""; });

    $("fx-viewer-close").addEventListener("click", closeViewer);
    $("fx-viewer-prev").addEventListener("click", () => stepViewer(-1));
    $("fx-viewer-next").addEventListener("click", () => stepViewer(1));
    $("fx-viewer-download").addEventListener("click", () => {
      const viewer = state.viewer;
      if (viewer) download([viewer.list[viewer.index]]);
    });
    $("fx-viewer").addEventListener("click", (event) => {
      if (event.target.id === "fx-viewer" || event.target.id === "fx-viewer-stage") closeViewer();
    });

    view.addEventListener("keydown", (event) => {
      if (onKey(event)) event.stopPropagation();
    });
    window.addEventListener("resize", () => {
      if (state.viewer) placeViewer();
    });
  }

  return {
    async open({ root, path } = {}) {
      bind();
      state.open = true;
      $("files-view").hidden = false;
      await loadRoots();
      const target = root && state.roots.some((item) => item.id === root) ? root : state.root;
      await go(target, typeof path === "string" ? path : target === state.root ? state.path : "", { push: false, trash: false });
      $("fx-pane")?.focus({ preventScroll: true });
      try {
        desktopCommand("containers:samba-status");
      } catch {
        // Not inside the Hog shell (tests, plain browser).
      }
      paintSamba();
    },
    close() {
      if (!state.open) return;
      state.open = false;
      closeMenu();
      closeViewer();
      if (state.dialog) closeDialog(state.dialog.input ? "" : false);
      $("files-view").hidden = true;
    },
    isOpen() {
      return state.open;
    },
    onKey,
    onSamba(payload) {
      if (payload && payload.samba) {
        state.samba = payload.samba;
        paintSamba();
      }
    },
    async refreshRoots() {
      await loadRoots();
      if (state.open && !state.roots.some((item) => item.id === state.root)) go("shares", "");
    },
    upload(files) {
      enqueue(goodFiles(files));
    },
    state,
  };
}
