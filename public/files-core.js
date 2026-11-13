// Pure helpers for hog://files. No DOM here, so the Node tests can load it.

export const CHUNK_SIZE = 8 * 1024 * 1024;
export const SORT_KEYS = ["name", "mtime", "size", "kind"];
export const VIEW_MODES = ["list", "grid"];
export const PREVIEW_KINDS = new Set(["image", "video", "audio", "text"]);

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(value) {
  let size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "";
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatDate(ms, now = Date.now()) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return `Today ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** Same rules as the server: plain names only. */
export function nameProblem(name) {
  const text = String(name ?? "");
  if (!text) return "Type a name.";
  if (text === "." || text === "..") return "That name is not allowed.";
  if (/[\/\\\u0000-\u001f\u007f]/.test(text)) return "Names cannot contain slashes.";
  if (text.trim() !== text) return "Names cannot start or end with a space.";
  if (new TextEncoder().encode(text).length > 255) return "That name is too long.";
  if (text === ".hog-trash" || text.startsWith(".hog-upload-")) return "That name is reserved by Hog.";
  return "";
}

export function joinPath(dir, name) {
  const base = String(dir || "");
  return base ? `${base}/${name}` : String(name);
}

export function parentPath(path) {
  const text = String(path || "");
  const cut = text.lastIndexOf("/");
  return cut < 0 ? "" : text.slice(0, cut);
}

export function baseName(path) {
  const text = String(path || "");
  return text.slice(text.lastIndexOf("/") + 1);
}

export function crumbs(rootName, path) {
  const out = [{ label: rootName || "Files", path: "" }];
  const parts = String(path || "").split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, path: acc });
  }
  return out;
}

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
function compareNames(a, b) {
  return collator ? collator.compare(a, b) : String(a).localeCompare(String(b));
}

/** Folders first, then the chosen key; name breaks ties. */
export function sortEntries(entries, key = "name", direction = "asc") {
  const sign = direction === "desc" ? -1 : 1;
  const sortKey = SORT_KEYS.includes(key) ? key : "name";
  return [...(entries || [])].sort((a, b) => {
    const aDir = a.type === "dir" ? 0 : 1;
    const bDir = b.type === "dir" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    let diff = 0;
    if (sortKey === "mtime") diff = (a.mtime || 0) - (b.mtime || 0);
    else if (sortKey === "size") diff = (a.size || 0) - (b.size || 0);
    else if (sortKey === "kind") diff = compareNames(String(a.kind || ""), String(b.kind || ""));
    if (diff === 0) diff = compareNames(a.name, b.name);
    return diff * sign;
  });
}

export function filterEntries(entries, text) {
  const needle = String(text || "").trim().toLowerCase();
  if (!needle) return [...(entries || [])];
  return (entries || []).filter((entry) => String(entry.name || "").toLowerCase().includes(needle));
}

/** Shift-click: everything between the anchor and the clicked item. */
export function rangeSelect(order, anchor, target) {
  const from = order.indexOf(anchor);
  const to = order.indexOf(target);
  if (to < 0) return [];
  if (from < 0) return [target];
  const [lo, hi] = from < to ? [from, to] : [to, from];
  return order.slice(lo, hi + 1);
}

/** Next focus index for an arrow key in list or grid view. */
export function moveFocus(index, key, count, columns = 1) {
  if (count <= 0) return -1;
  const cols = Math.max(1, columns);
  let next = index < 0 ? 0 : index;
  if (index >= 0) {
    if (key === "ArrowDown") next = index + cols;
    else if (key === "ArrowUp") next = index - cols;
    else if (key === "ArrowRight") next = cols > 1 ? index + 1 : index;
    else if (key === "ArrowLeft") next = cols > 1 ? index - 1 : index;
    else if (key === "Home") next = 0;
    else if (key === "End") next = count - 1;
    else if (key === "PageDown") next = index + cols * 8;
    else if (key === "PageUp") next = index - cols * 8;
  }
  return Math.max(0, Math.min(count - 1, next));
}

/** Byte ranges for a chunked upload. A zero-byte file is one empty chunk. */
export function chunkPlan(size, chunk = CHUNK_SIZE, from = 0) {
  const total = Math.max(0, Number(size) || 0);
  const step = Math.max(1, Number(chunk) || CHUNK_SIZE);
  const plan = [];
  if (total === 0) return [{ start: 0, end: 0 }];
  for (let start = Math.max(0, from); start < total; start += step) plan.push({ start, end: Math.min(total, start + step) });
  return plan;
}

export function uploadId(random = () => Math.random()) {
  let out = "";
  while (out.length < 24) out += Math.floor(random() * 16).toString(16);
  return out.slice(0, 24);
}

/** Query string for an API call. */
export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export function rawUrl(root, path, { download = false } = {}) {
  return `/api/files/raw?${query({ root, path, ...(download ? { download: 1 } : {}) })}`;
}

/** Which action a key press means on the Files page. */
export function keyAction(event, { editing = false } = {}) {
  const key = String(event.key || "");
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  const shift = Boolean(event.shiftKey);
  const alt = Boolean(event.altKey);
  if (key === "Escape") return "escape";
  if (editing) return "";
  if (ctrl && !alt) {
    const lower = key.toLowerCase();
    if (lower === "a") return "select-all";
    if (lower === "c") return "copy";
    if (lower === "x") return "cut";
    if (lower === "v") return "paste";
    if (lower === "f") return "search";
    if (lower === "n" && shift) return "new-folder";
    if (lower === "u") return "upload";
    if (lower === "i") return "info";
    if (key === "1") return "view-list";
    if (key === "2") return "view-grid";
    return "";
  }
  if (alt && !ctrl) {
    if (key === "ArrowUp") return "up";
    if (key === "ArrowLeft") return "back";
    if (key === "ArrowRight") return "forward";
    return "";
  }
  if (key === "Enter") return "open";
  if (key === "Backspace") return "up";
  if (key === "Delete") return "trash";
  if (key === "F2") return "rename";
  if (key === " ") return "preview";
  if (key === "/") return "search";
  if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(key)) return shift ? "extend" : "move";
  return "";
}

/** Addresses for the tailnet Samba share. */
export function smbLinks({ dns = "", ip = "", share = "hog-shares" } = {}) {
  const links = [];
  const host = String(dns || "").replace(/\.$/, "");
  const short = host.split(".")[0] || "";
  if (host) links.push({ label: "Phone, Mac, Linux", value: `smb://${host}/${share}` });
  if (short) links.push({ label: "Windows", value: `\\\\${short}\\${share}` });
  if (ip) {
    links.push({ label: "By IP", value: `smb://${ip}/${share}` });
    links.push({ label: "Windows by IP", value: `\\\\${ip}\\${share}` });
  }
  return links;
}

const PATHS = {
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 2.5-2.5L20 18"/>',
  video: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M10 9.5v5l4.5-2.5z"/>',
  audio: '<path d="M9 17.5V6.5l10-2v11"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  text: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 15h6M9 18h4"/>',
  archive: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M12 4v3M12 9v2M12 13v2M10.5 16.5h3v2h-3z"/>',
  doc: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 13h6M9 16h6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
  other: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  drive: '<rect x="3.5" y="13" width="17" height="6" rx="1.5"/><path d="M5 13l2.5-7.5h9L19 13"/><circle cx="16.5" cy="16" r="0.9"/>',
  home: '<path d="M4 11l8-6.5 8 6.5M6.5 9.5V19h11V9.5"/>',
};

export function iconSvg(kind) {
  const body = PATHS[kind] || PATHS.other;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="fx-svg fx-svg-${PATHS[kind] ? kind : "other"}">${body}</svg>`;
}

export function entryKind(entry) {
  if (!entry) return "other";
  if (entry.type === "dir") return "folder";
  if (entry.type === "link") return "link";
  return entry.kind || "other";
}

export function kindLabel(entry) {
  const kind = entryKind(entry);
  if (entry && entry.outside) return "Link outside this folder";
  if (entry && entry.broken) return "Broken link";
  return {
    folder: "Folder", image: "Image", video: "Video", audio: "Audio", text: "Text", archive: "Archive", doc: "Document", link: "Link", other: "File",
  }[kind] || "File";
}

/** "3 items, 1.2 GB" for the selection bar. */
export function selectionSummary(entries) {
  const list = entries || [];
  if (!list.length) return "";
  const size = list.reduce((sum, entry) => sum + (entry.type === "file" ? Number(entry.size) || 0 : 0), 0);
  const label = list.length === 1 ? "1 item" : `${list.length} items`;
  return size ? `${label}, ${formatBytes(size)}` : label;
}

export function spaceSummary(space) {
  if (!space || !space.total) return null;
  const used = Math.max(0, Number(space.used) || 0);
  const total = Number(space.total);
  return {
    percent: Math.min(100, Math.round((used / total) * 100)),
    text: `${formatBytes(space.free)} free of ${formatBytes(total)}`,
  };
}
