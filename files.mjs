// hog://files backend: a small file manager confined to the folders the user
// picked. Every path from the page is relative to one of those roots, checked
// segment by segment, and resolved with realpath so a symlink cannot lead
// outside. Nothing here runs a shell or another program.
import { randomBytes } from "node:crypto";
import { constants as FS, createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export const TRASH_DIR = ".hog-trash";
export const PART_PREFIX = ".hog-upload-";
export const MAX_CHUNK = 64 * 1024 * 1024;
export const MAX_ROOTS = 16;
const MAX_PATH = 4096;
const MAX_LIST = 20_000;
const MAX_SEARCH_RESULTS = 400;
const MAX_SEARCH_VISITS = 60_000;
const MAX_SEARCH_DEPTH = 16;
const PART_STALE_MS = 24 * 60 * 60 * 1000;
const UPLOAD_ID_RE = /^[a-f0-9]{16,40}$/;
const TRASH_ID_RE = /^[a-z0-9]{8,40}$/;
const ROOT_ID_RE = /^[a-z0-9]{1,24}$/;
const ALLOWED_ROOT_BASES = ["/media", "/mnt", "/run/media", "/srv"];

export class FilesError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function fail(status, message, extra) {
  throw new FilesError(status, message, extra);
}

const KINDS = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico"],
  video: ["mp4", "m4v", "webm", "mkv", "mov", "avi", "ts", "m2ts", "mpg", "mpeg", "wmv", "ogv", "3gp"],
  audio: ["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "wma"],
  text: ["txt", "md", "markdown", "log", "json", "csv", "tsv", "xml", "yml", "yaml", "ini", "conf", "cfg", "toml", "srt", "vtt", "ass", "nfo", "sh", "py", "js", "mjs", "ts", "css", "html", "htm", "rs", "c", "h", "cpp", "hpp", "go", "java", "sql", "env", "gitignore"],
  archive: ["zip", "tar", "gz", "tgz", "xz", "bz2", "7z", "rar", "zst", "deb", "iso"],
  doc: ["pdf", "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub"],
};
const KIND_OF = new Map();
for (const [kind, list] of Object.entries(KINDS)) for (const ext of list) if (!KIND_OF.has(ext)) KIND_OF.set(ext, kind);

const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
  avi: "video/x-msvideo", ts: "video/mp2t", m2ts: "video/mp2t", mpg: "video/mpeg", mpeg: "video/mpeg", ogv: "video/ogg", "3gp": "video/3gpp",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  pdf: "application/pdf", zip: "application/zip", json: "application/json",
};
// Anything a browser could run on Hog's own origin is served as plain text.
const ACTIVE_TYPES = /^(text\/html|application\/xhtml|text\/xml|application\/xml|text\/javascript|application\/javascript)/;

export function kindOf(name, type = "file") {
  if (type === "dir") return "folder";
  const ext = extname(String(name || "")).slice(1).toLowerCase();
  if (!ext && /^(readme|license|changelog|makefile|dockerfile)$/i.test(String(name || ""))) return "text";
  return KIND_OF.get(ext) || "other";
}

export function mimeOf(name) {
  const ext = extname(String(name || "")).slice(1).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (KIND_OF.get(ext) === "text" || !ext) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** The content type Hog serves a file with. Active types become text. */
export function servedType(name) {
  const type = mimeOf(name);
  if (ACTIVE_TYPES.test(type)) return "text/plain; charset=utf-8";
  if (type.startsWith("text/")) return "text/plain; charset=utf-8";
  return type;
}

/** One path segment from the page. */
export function checkName(name) {
  if (typeof name !== "string" || name.length === 0) fail(400, "Use a file name.");
  if (name === "." || name === "..") fail(400, "That name is not allowed.");
  if (/[\/\\\u0000-\u001f\u007f]/.test(name)) fail(400, "Names cannot contain slashes or control characters.");
  if (Buffer.byteLength(name, "utf8") > 255) fail(400, "That name is too long.");
  if (name === TRASH_DIR || name.startsWith(PART_PREFIX)) fail(400, "That name is reserved by Hog.");
  if (name.trim() !== name || name.trim() === "") fail(400, "Names cannot start or end with a space.");
  return name;
}

/** A path relative to a root, as segments. "" is the root itself. */
export function splitRelative(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw !== "string") fail(400, "path must be text");
  if (raw.length > MAX_PATH) fail(400, "That path is too long.");
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) fail(400, "Use a path inside the folder.");
  const parts = raw.split("/");
  for (const part of parts) checkName(part);
  return parts;
}

export function joinRelative(parts) {
  return parts.join("/");
}

/** target is base or below it (both already real paths). */
export function isInside(base, target) {
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

function errnoStatus(error) {
  switch (error && error.code) {
    case "ENOENT":
    case "ENOTDIR":
      return [404, "That file or folder is not there any more."];
    case "EACCES":
    case "EPERM":
      return [403, "This computer does not allow that (permission denied)."];
    case "EEXIST":
    case "ENOTEMPTY":
      return [409, "Something with that name is already there."];
    case "ENOSPC":
      return [507, "The disk is full."];
    case "EROFS":
      return [403, "That disk is read-only."];
    case "ELOOP":
      return [403, "That link points outside this folder."];
    case "ENAMETOOLONG":
      return [400, "That name is too long."];
    default:
      return [0, ""];
  }
}

export function describeError(error) {
  if (error instanceof FilesError) return { status: error.status, message: error.message, extra: error.extra || {} };
  const [status, message] = errnoStatus(error);
  if (status) return { status, message, extra: {} };
  return { status: 500, message: error instanceof Error ? error.message : "That did not work.", extra: {} };
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

/** "name (2).ext" style name that is free in dir. */
export async function freeName(dir, name) {
  if (!(await exists(join(dir, name)))) return name;
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const keep = ext && ext !== name ? ext : "";
  const base = stem.replace(/ \((\d+)\)$/, "");
  for (let n = 2; n < 10_000; n += 1) {
    const next = `${base} (${n})${keep}`;
    if (Buffer.byteLength(next, "utf8") > 255) break;
    if (!(await exists(join(dir, next)))) return next;
  }
  fail(409, "Could not find a free name there.");
}

function expandHome(raw, home) {
  const text = String(raw || "").trim();
  if (text === "~") return home;
  if (text.startsWith("~/")) return join(home, text.slice(2));
  return text;
}

/**
 * Whether a folder may become a root. Home itself and anything holding Hog's
 * data (the wallet) are refused, so are hidden folders in home and system
 * directories.
 */
export async function rootProblem(raw, { home, dataDir }) {
  const text = expandHome(raw, home);
  if (!text || !isAbsolute(text)) return { problem: "Use a full folder path, like ~/Videos or /media/disk." };
  if (text.length > MAX_PATH || text.includes("\0")) return { problem: "That path is too long." };
  let real;
  try {
    real = await realpath(normalize(text));
  } catch {
    return { problem: "That folder does not exist." };
  }
  let info;
  try {
    info = await stat(real);
  } catch {
    return { problem: "That folder does not exist." };
  }
  if (!info.isDirectory()) return { problem: "That is a file, not a folder." };
  const homeReal = await realpath(home).catch(() => home);
  const dataReal = await realpath(dataDir).catch(() => resolve(dataDir));
  if (real === "/") return { problem: "The whole disk cannot be a Files folder." };
  if (real === homeReal) return { problem: "Pick a folder inside your home folder, not the home folder itself." };
  if (isInside(real, dataReal) || isInside(dataReal, real)) return { problem: "That folder holds Hog's own data (the wallet), so it cannot be shared." };
  if (isInside(homeReal, real)) {
    const rest = real.slice(homeReal.length + 1).split(sep);
    if (rest.some((part) => part.startsWith("."))) return { problem: "Hidden folders (names starting with a dot) cannot be Files folders." };
    return { real };
  }
  if (ALLOWED_ROOT_BASES.some((base) => real !== base && isInside(base, real))) return { real };
  return { problem: "Pick a folder in your home folder, or a disk under /media or /mnt." };
}

function sanitizeRoots(raw) {
  const list = Array.isArray(raw?.roots) ? raw.roots : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "");
    const path = String(item.path || "");
    if (!ROOT_ID_RE.test(id) || id === "shares" || !isAbsolute(path)) continue;
    if (out.some((root) => root.id === id)) continue;
    const name = String(item.name || basename(path) || path).slice(0, 60);
    out.push({ id, name, path });
    if (out.length >= MAX_ROOTS - 1) break;
  }
  return out;
}

function uploadIdOk(id) {
  return typeof id === "string" && UPLOAD_ID_RE.test(id);
}

function intParam(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value ?? "");
  if (!/^\d{1,16}$/.test(text)) fail(400, `${name} must be a whole number`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(400, `${name} is out of range`);
  return number;
}

function trashId() {
  return Date.now().toString(36) + randomBytes(5).toString("hex");
}

export function createFilesService({
  home = homedir(),
  dataDir = join(home, ".local", "share", "hog-browser"),
  configFile = join(dataDir, "files.json"),
  sharesDir = join(home, "hog-shares"),
} = {}) {
  let extra = null;

  async function loadExtra() {
    if (extra) return extra;
    try {
      extra = sanitizeRoots(JSON.parse(await readFile(configFile, "utf8")));
    } catch {
      extra = [];
    }
    return extra;
  }

  async function saveExtra(list) {
    extra = sanitizeRoots({ roots: list });
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    const temp = `${configFile}.tmp`;
    await writeFile(temp, JSON.stringify({ roots: extra }, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, configFile);
    return extra;
  }

  async function allRoots() {
    return [{ id: "shares", name: "hog-shares", path: sharesDir, builtin: true }, ...(await loadExtra())];
  }

  async function getRoot(id) {
    const key = String(id || "shares");
    if (!ROOT_ID_RE.test(key)) fail(400, "Unknown folder.");
    const root = (await allRoots()).find((item) => item.id === key);
    if (!root) fail(404, "That folder is not in Files any more.");
    if (root.builtin) await mkdir(root.path, { recursive: true, mode: 0o755 });
    let real;
    try {
      real = await realpath(root.path);
    } catch {
      fail(404, `${root.name} is not available (is the disk plugged in?).`);
    }
    if (!root.builtin) {
      // Re-check on every use: the folder could have been swapped for a link.
      const check = await rootProblem(root.path, { home, dataDir });
      if (check.problem) fail(403, check.problem);
    } else {
      const dataReal = await realpath(dataDir).catch(() => resolve(dataDir));
      if (real === "/" || isInside(real, dataReal) || isInside(dataReal, real)) fail(403, "That folder holds Hog's own data.");
    }
    return { ...root, real };
  }

  /** An existing entry, following links, which must stay inside the root. */
  async function resolveExisting(rootId, rel) {
    const root = await getRoot(rootId);
    const parts = splitRelative(rel);
    const full = join(root.real, ...parts);
    let real;
    try {
      real = await realpath(full);
    } catch (error) {
      const [status, message] = errnoStatus(error);
      fail(status || 404, message || "That file or folder is not there any more.");
    }
    if (!isInside(root.real, real)) fail(403, "That link points outside this folder.");
    const info = await stat(real);
    return { root, parts, full, real, info };
  }

  /** The entry itself (a link is not followed); its parent must be inside. */
  async function resolveEntry(rootId, rel) {
    const root = await getRoot(rootId);
    const parts = splitRelative(rel);
    if (!parts.length) fail(400, "That is the top of the folder.");
    const parentFull = join(root.real, ...parts.slice(0, -1));
    let parentReal;
    try {
      parentReal = await realpath(parentFull);
    } catch {
      fail(404, "That folder is not there any more.");
    }
    if (!isInside(root.real, parentReal)) fail(403, "That link points outside this folder.");
    const name = parts[parts.length - 1];
    const full = join(parentReal, name);
    const info = await lstat(full).catch(() => null);
    if (!info) fail(404, "That file or folder is not there any more.");
    return { root, parts, name, parentReal, full, info };
  }

  async function resolveDir(rootId, rel) {
    const found = await resolveExisting(rootId, rel);
    if (!found.info.isDirectory()) fail(400, "That is a file, not a folder.");
    return found;
  }

  /** mkdir -p below dir, refusing anything that resolves outside the root. */
  async function ensureDirs(root, dirReal, parts) {
    let current = dirReal;
    for (const part of parts) {
      checkName(part);
      const next = join(current, part);
      try {
        await mkdir(next, { mode: 0o755 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const real = await realpath(next);
      if (!isInside(root.real, real)) fail(403, "That link points outside this folder.");
      const info = await stat(real);
      if (!info.isDirectory()) fail(409, `${part} is a file, not a folder.`);
      current = real;
    }
    return current;
  }

  async function space(real) {
    try {
      const info = await statfs(real);
      const total = Number(info.blocks) * Number(info.bsize);
      const free = Number(info.bavail) * Number(info.bsize);
      const used = total - Number(info.bfree) * Number(info.bsize);
      return { total, free, used };
    } catch {
      return null;
    }
  }

  async function describe(dirReal, name, root) {
    const full = join(dirReal, name);
    let info;
    try {
      info = await lstat(full);
    } catch {
      return null;
    }
    const entry = { name, type: "file", size: 0, mtime: info.mtimeMs, link: false };
    if (info.isSymbolicLink()) {
      entry.link = true;
      try {
        const real = await realpath(full);
        if (!isInside(root.real, real)) {
          entry.type = "link";
          entry.outside = true;
          entry.kind = "link";
          return entry;
        }
        info = await stat(real);
      } catch {
        entry.type = "link";
        entry.broken = true;
        entry.kind = "link";
        return entry;
      }
    }
    if (info.isDirectory()) entry.type = "dir";
    else if (!info.isFile()) entry.type = "special";
    entry.size = info.isFile() ? info.size : 0;
    entry.mtime = info.mtimeMs;
    entry.kind = entry.type === "special" ? "other" : kindOf(name, entry.type);
    return entry;
  }

  async function cleanParts(dirReal, names) {
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith(PART_PREFIX)) continue;
      try {
        const info = await lstat(join(dirReal, name));
        if (info.isFile() && now - info.mtimeMs > PART_STALE_MS) await rm(join(dirReal, name), { force: true });
      } catch {
        // Gone already.
      }
    }
  }

  async function trashCount(root) {
    try {
      return (await readdir(join(root.real, TRASH_DIR))).filter((name) => name.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  const service = {
    async roots() {
      const out = [];
      for (const root of await allRoots()) {
        try {
          const found = await getRoot(root.id);
          out.push({
            id: root.id,
            name: root.name,
            path: root.path,
            builtin: Boolean(root.builtin),
            ok: true,
            space: await space(found.real),
            trash: await trashCount(found),
          });
        } catch (error) {
          out.push({ id: root.id, name: root.name, path: root.path, builtin: Boolean(root.builtin), ok: false, error: describeError(error).message });
        }
      }
      return { ok: true, roots: out };
    },

    async addRoot({ path, name } = {}) {
      const list = await loadExtra();
      if (list.length >= MAX_ROOTS - 1) fail(400, `Files can show ${MAX_ROOTS} folders at most.`);
      const check = await rootProblem(path, { home, dataDir });
      if (check.problem) fail(400, check.problem);
      const shares = await realpath(sharesDir).catch(() => sharesDir);
      for (const root of list) {
        const real = await realpath(root.path).catch(() => root.path);
        if (real === check.real) fail(409, "That folder is already in Files.");
      }
      if (check.real === shares) fail(409, "That folder is already in Files.");
      const label = String(name || basename(check.real)).trim().slice(0, 60) || basename(check.real);
      const id = randomBytes(4).toString("hex");
      await saveExtra([...list, { id, name: label, path: check.real }]);
      return { ...(await service.roots()), added: id };
    },

    async removeRoot({ id } = {}) {
      const key = String(id || "");
      if (key === "shares") fail(400, "hog-shares always stays in Files.");
      const list = await loadExtra();
      if (!list.some((root) => root.id === key)) fail(404, "That folder is not in Files.");
      await saveExtra(list.filter((root) => root.id !== key));
      return service.roots();
    },

    async list({ root: rootId, path } = {}) {
      const found = await resolveDir(rootId, path);
      const names = await readdir(found.real);
      await cleanParts(found.real, names);
      const entries = [];
      let truncated = false;
      for (const name of names) {
        if (name === TRASH_DIR || name.startsWith(PART_PREFIX)) continue;
        if (entries.length >= MAX_LIST) {
          truncated = true;
          break;
        }
        try {
          checkName(name);
        } catch {
          continue; // Names Hog cannot address (control characters, slashes).
        }
        const entry = await describe(found.real, name, found.root);
        if (entry) entries.push(entry);
      }
      return {
        ok: true,
        root: found.root.id,
        rootName: found.root.name,
        path: joinRelative(found.parts),
        entries,
        truncated,
        space: await space(found.real),
      };
    },

    async search({ root: rootId, path, q } = {}) {
      const query = String(q || "").trim().toLowerCase();
      if (!query) return service.list({ root: rootId, path });
      if (query.length > 200) fail(400, "That search is too long.");
      const found = await resolveDir(rootId, path);
      const results = [];
      const queue = [{ real: found.real, parts: found.parts, depth: 0 }];
      let visits = 0;
      let truncated = false;
      while (queue.length) {
        const { real, parts, depth } = queue.shift();
        let names;
        try {
          names = await readdir(real, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const dirent of names) {
          const name = dirent.name;
          if (name === TRASH_DIR || name.startsWith(PART_PREFIX)) continue;
          visits += 1;
          if (visits > MAX_SEARCH_VISITS || results.length >= MAX_SEARCH_RESULTS) {
            truncated = true;
            break;
          }
          try {
            checkName(name);
          } catch {
            continue;
          }
          if (name.toLowerCase().includes(query)) {
            const entry = await describe(real, name, found.root);
            if (entry) results.push({ ...entry, dir: joinRelative(parts) });
          }
          // Links are never followed while searching.
          if (dirent.isDirectory() && depth < MAX_SEARCH_DEPTH) queue.push({ real: join(real, name), parts: [...parts, name], depth: depth + 1 });
        }
        if (truncated) break;
      }
      return { ok: true, root: found.root.id, rootName: found.root.name, path: joinRelative(found.parts), query, entries: results, truncated, search: true };
    },

    async info({ root: rootId, path } = {}) {
      const entry = await resolveEntry(rootId, path).catch(async (error) => {
        if (splitRelative(path).length === 0) return null;
        throw error;
      });
      if (!entry) {
        const found = await resolveDir(rootId, "");
        return { ok: true, name: found.root.name, path: "", type: "dir", kind: "folder", mtime: found.info.mtimeMs, size: 0, items: (await readdir(found.real)).filter((n) => n !== TRASH_DIR && !n.startsWith(PART_PREFIX)).length, space: await space(found.real) };
      }
      const described = await describe(entry.parentReal, entry.name, entry.root);
      if (!described) fail(404, "That file or folder is not there any more.");
      const out = { ok: true, ...described, path: joinRelative(entry.parts), mode: (entry.info.mode & 0o777).toString(8).padStart(3, "0"), mime: described.type === "file" ? mimeOf(entry.name) : "" };
      out.ctime = entry.info.ctimeMs;
      if (described.type === "dir") {
        // Folder size, with a cap so a huge tree does not stall Hog.
        let total = 0;
        let count = 0;
        let partial = false;
        const started = Date.now();
        const stack = [entry.full];
        while (stack.length) {
          const dir = stack.pop();
          let names;
          try {
            names = await readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const dirent of names) {
            if (dirent.name === TRASH_DIR || dirent.name.startsWith(PART_PREFIX)) continue;
            count += 1;
            if (count > 50_000 || Date.now() - started > 1500) {
              partial = true;
              break;
            }
            const child = join(dir, dirent.name);
            if (dirent.isDirectory()) stack.push(child);
            else if (dirent.isFile()) {
              try {
                total += (await lstat(child)).size;
              } catch {
                // Skip.
              }
            }
          }
          if (partial) break;
        }
        out.size = total;
        out.items = (await readdir(entry.full).catch(() => [])).filter((n) => n !== TRASH_DIR && !n.startsWith(PART_PREFIX)).length;
        out.partial = partial;
      }
      return out;
    },

    async mkdir({ root: rootId, path, name } = {}) {
      const dir = await resolveDir(rootId, path);
      checkName(name);
      await mkdir(join(dir.real, name), { mode: 0o755 });
      return { ok: true, name, path: joinRelative([...dir.parts, name]) };
    },

    async rename({ root: rootId, path, name } = {}) {
      const entry = await resolveEntry(rootId, path);
      checkName(name);
      if (name === entry.name) return { ok: true, name, path: joinRelative(entry.parts) };
      const target = join(entry.parentReal, name);
      const caseOnly = name.toLowerCase() === entry.name.toLowerCase();
      if (!caseOnly && (await exists(target))) fail(409, `${name} is already there.`);
      await rename(entry.full, target);
      return { ok: true, name, path: joinRelative([...entry.parts.slice(0, -1), name]) };
    },

    async transfer({ root: rootId, paths, dest, copy = false } = {}) {
      if (!Array.isArray(paths) || paths.length === 0) fail(400, "Pick something first.");
      if (paths.length > 2000) fail(400, "That is too many items at once.");
      const destRootId = dest && typeof dest === "object" ? dest.root : rootId;
      const destPath = dest && typeof dest === "object" ? dest.path : dest;
      const target = await resolveDir(destRootId, destPath);
      const done = [];
      const skipped = [];
      for (const rel of paths) {
        const entry = await resolveEntry(rootId, rel);
        if (entry.info.isDirectory()) {
          const real = await realpath(entry.full);
          if (isInside(real, target.real)) {
            skipped.push({ path: rel, reason: "A folder cannot go inside itself." });
            continue;
          }
        }
        if (!copy && entry.parentReal === target.real && entry.root.id === target.root.id) {
          skipped.push({ path: rel, reason: "Already in that folder." });
          continue;
        }
        const name = await freeName(target.real, entry.name);
        const to = join(target.real, name);
        if (copy) {
          await cp(entry.full, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
        } else {
          try {
            await rename(entry.full, to);
          } catch (error) {
            if (error.code !== "EXDEV") throw error;
            await cp(entry.full, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
            await rm(entry.full, { recursive: true, force: true });
          }
        }
        done.push({ from: rel, name, path: joinRelative([...target.parts, name]) });
      }
      return { ok: true, done, skipped, dest: { root: target.root.id, path: joinRelative(target.parts) } };
    },

    async trash({ root: rootId, paths } = {}) {
      if (!Array.isArray(paths) || paths.length === 0) fail(400, "Pick something first.");
      if (paths.length > 2000) fail(400, "That is too many items at once.");
      const root = await getRoot(rootId);
      const bin = join(root.real, TRASH_DIR);
      await mkdir(bin, { recursive: true, mode: 0o700 });
      const binInfo = await lstat(bin);
      if (!binInfo.isDirectory() || binInfo.isSymbolicLink()) fail(403, "Hog's trash folder is not a plain folder.");
      const done = [];
      for (const rel of paths) {
        const entry = await resolveEntry(rootId, rel);
        const id = trashId();
        const slot = join(bin, id);
        await mkdir(slot, { mode: 0o700 });
        const meta = {
          name: entry.name,
          path: joinRelative(entry.parts),
          deletedAt: Date.now(),
          type: entry.info.isDirectory() ? "dir" : entry.info.isSymbolicLink() ? "link" : "file",
          size: entry.info.isFile() ? entry.info.size : 0,
        };
        try {
          await rename(entry.full, join(slot, entry.name));
        } catch (error) {
          if (error.code !== "EXDEV") {
            await rm(slot, { recursive: true, force: true });
            throw error;
          }
          await cp(entry.full, join(slot, entry.name), { recursive: true, errorOnExist: true, verbatimSymlinks: true, preserveTimestamps: true });
          await rm(entry.full, { recursive: true, force: true });
        }
        await writeFile(join(bin, `${id}.json`), JSON.stringify(meta) + "\n", { mode: 0o600 });
        done.push({ id, ...meta });
      }
      return { ok: true, done };
    },

    async trashList({ root: rootId } = {}) {
      const roots = rootId ? [await getRoot(rootId)] : await Promise.all((await allRoots()).map((root) => getRoot(root.id).catch(() => null)));
      const items = [];
      for (const root of roots) {
        if (!root) continue;
        const bin = join(root.real, TRASH_DIR);
        let names;
        try {
          names = await readdir(bin);
        } catch {
          continue;
        }
        for (const file of names) {
          if (!file.endsWith(".json")) continue;
          const id = file.slice(0, -5);
          if (!TRASH_ID_RE.test(id)) continue;
          try {
            const meta = JSON.parse(await readFile(join(bin, file), "utf8"));
            items.push({
              id,
              root: root.id,
              rootName: root.name,
              name: String(meta.name || ""),
              path: String(meta.path || ""),
              deletedAt: Number(meta.deletedAt) || 0,
              type: ["dir", "file", "link"].includes(meta.type) ? meta.type : "file",
              size: Number(meta.size) || 0,
              kind: kindOf(meta.name, meta.type),
            });
          } catch {
            // Unreadable note; leave it.
          }
        }
      }
      items.sort((a, b) => b.deletedAt - a.deletedAt);
      return { ok: true, items };
    },

    async restore({ root: rootId, ids } = {}) {
      if (!Array.isArray(ids) || !ids.length) fail(400, "Pick something first.");
      const root = await getRoot(rootId);
      const bin = join(root.real, TRASH_DIR);
      const done = [];
      for (const id of ids) {
        if (!TRASH_ID_RE.test(String(id))) fail(400, "Unknown trash item.");
        const metaFile = join(bin, `${id}.json`);
        let meta;
        try {
          meta = JSON.parse(await readFile(metaFile, "utf8"));
        } catch {
          fail(404, "That item is not in the trash any more.");
        }
        const parts = splitRelative(String(meta.path || ""));
        if (!parts.length) fail(400, "That trash note is damaged.");
        const name = parts[parts.length - 1];
        const source = join(bin, id, name);
        if (!(await exists(source))) fail(404, "That item is not in the trash any more.");
        const parent = await ensureDirs(root, root.real, parts.slice(0, -1));
        const free = await freeName(parent, name);
        await rename(source, join(parent, free));
        await rm(join(bin, id), { recursive: true, force: true });
        await rm(metaFile, { force: true });
        done.push({ id, name: free, path: joinRelative([...parts.slice(0, -1), free]) });
      }
      return { ok: true, done };
    },

    async purge({ root: rootId, ids, all = false } = {}) {
      const root = await getRoot(rootId);
      const bin = join(root.real, TRASH_DIR);
      let list = Array.isArray(ids) ? ids.map(String) : [];
      if (all === true) {
        list = (await readdir(bin).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
      }
      if (!list.length) fail(400, "Pick something first.");
      let removed = 0;
      for (const id of list) {
        if (!TRASH_ID_RE.test(id)) continue;
        await rm(join(bin, id), { recursive: true, force: true });
        await rm(join(bin, `${id}.json`), { force: true });
        removed += 1;
      }
      return { ok: true, removed };
    },

    /** Where an upload chunk lands, and its current size. */
    async uploadTarget({ root: rootId, dir, rel, id }) {
      if (!uploadIdOk(id)) fail(400, "Bad upload id.");
      const found = await resolveDir(rootId, dir);
      const parts = splitRelative(rel);
      if (!parts.length) fail(400, "Use a file name.");
      return { found, parts, id };
    },

    async uploadStatus({ root: rootId, dir, rel, id } = {}) {
      const { found, parts } = await service.uploadTarget({ root: rootId, dir, rel, id });
      const parentFull = join(found.real, ...parts.slice(0, -1));
      const info = await lstat(join(parentFull, PART_PREFIX + id)).catch(() => null);
      return { ok: true, size: info && info.isFile() ? info.size : 0 };
    },

    /**
     * Write one chunk. body is an async iterable of Buffers (the request).
     * offset has to match what is already on disk, so chunks cannot overlap.
     */
    async uploadChunk({ root: rootId, dir, rel, id, offset, total, length }, body) {
      const at = intParam(offset, "offset");
      const size = intParam(total, "total", { max: 2 ** 50 });
      if (length !== undefined && length !== null && Number(length) > MAX_CHUNK) fail(413, "That chunk is too big.");
      if (at > size) fail(400, "offset is past the end of the file");
      const { found, parts } = await service.uploadTarget({ root: rootId, dir, rel, id });
      const parent = at === 0
        ? await ensureDirs(found.root, found.real, parts.slice(0, -1))
        : await (async () => {
          const real = await realpath(join(found.real, ...parts.slice(0, -1)));
          if (!isInside(found.root.real, real)) fail(403, "That link points outside this folder.");
          return real;
        })();
      const name = parts[parts.length - 1];
      const part = join(parent, PART_PREFIX + id);
      let handle;
      if (at === 0) {
        handle = await open(part, FS.O_CREAT | FS.O_WRONLY | FS.O_TRUNC | FS.O_NOFOLLOW, 0o644);
      } else {
        const info = await lstat(part).catch(() => null);
        if (!info || !info.isFile()) fail(409, "That upload has to start again.", { size: 0 });
        if (info.size !== at) fail(409, "That chunk does not follow the last one.", { size: info.size });
        handle = await open(part, FS.O_WRONLY | FS.O_NOFOLLOW);
      }
      let written = 0;
      async function* counted(source) {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > MAX_CHUNK) throw new FilesError(413, "That chunk is too big.");
          if (at + written > size) throw new FilesError(400, "The upload is bigger than it said.");
          yield chunk;
        }
      }
      try {
        await pipeline(body, counted, createWriteStream(null, { fd: handle.fd, start: at, autoClose: false }));
      } catch (error) {
        // A chunk that broke the rules leaves nothing behind; a dropped
        // connection keeps what arrived so the upload can resume.
        if (error instanceof FilesError) await rm(part, { force: true }).catch(() => {});
        throw error;
      } finally {
        await handle.close().catch(() => {});
      }
      const now = at + written;
      if (now < size) return { ok: true, done: false, size: now };
      const final = await freeName(parent, name);
      await rename(part, join(parent, final));
      const relDir = joinRelative([...found.parts, ...parts.slice(0, -1)]);
      return { ok: true, done: true, size: now, name: final, path: relDir ? `${relDir}/${final}` : final };
    },

    async uploadCancel({ root: rootId, dir, rel, id } = {}) {
      const { found, parts } = await service.uploadTarget({ root: rootId, dir, rel, id });
      const parentFull = join(found.real, ...parts.slice(0, -1));
      const real = await realpath(parentFull).catch(() => null);
      if (real && isInside(found.root.real, real)) await rm(join(real, PART_PREFIX + id), { force: true });
      return { ok: true };
    },

    /** A regular file to stream out. */
    async openFile({ root: rootId, path } = {}) {
      const found = await resolveExisting(rootId, path);
      if (!found.info.isFile()) fail(400, "That is not a file.");
      return { real: found.real, size: found.info.size, mtime: found.info.mtimeMs, name: found.parts[found.parts.length - 1] || found.root.name };
    },
  };
  return service;
}

// ---------- HTTP ----------

/**
 * Only Hog's own window may use these endpoints: same host as the wallet
 * (checked by the caller with the gate cookie), no cross-site fetches, and
 * a custom header on anything that changes files so a plain form or image
 * from another page cannot.
 */
export function filesRequestProblem(req, expectedOrigin) {
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site && site !== "same-origin" && site !== "none") return "Only Hog's own Files page can do that.";
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== expectedOrigin) return "Only Hog's own Files page can do that.";
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && req.headers["x-hog-files"] !== "1") return "Only Hog's own Files page can do that.";
  return "";
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 512_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    fail(400, "That request was not JSON.");
  }
}

export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === "" && match[2] === "")) return { invalid: true };
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

export function contentDisposition(kind, name) {
  const plain = String(name || "file").replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(String(name || "file"))}`;
}

async function sendFile(service, req, res, url) {
  const file = await service.openFile({ root: url.searchParams.get("root"), path: url.searchParams.get("path") });
  const download = url.searchParams.get("download") === "1";
  const etag = `"${file.size.toString(16)}-${Math.floor(file.mtime).toString(16)}"`;
  const headers = {
    "content-type": download ? "application/octet-stream" : servedType(file.name),
    "accept-ranges": "bytes",
    "cache-control": "private, no-cache",
    etag,
    "last-modified": new Date(file.mtime).toUTCString(),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    // A file opened on its own runs in a sandbox, never as Hog's page.
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    "content-disposition": contentDisposition(download ? "attachment" : "inline", file.name),
  };
  if (req.headers["if-none-match"] === etag && !req.headers.range) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const range = parseRange(req.headers.range, file.size);
  if (range && range.invalid) {
    res.writeHead(416, { ...headers, "content-range": `bytes */${file.size}` });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : file.size - 1;
  const length = file.size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "content-length": length,
    ...(range ? { "content-range": `bytes ${start}-${end}/${file.size}` } : {}),
  });
  if (req.method === "HEAD" || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file.real, { start, end });
  await new Promise((resolveSend) => {
    stream.on("error", () => {
      res.destroy();
      resolveSend();
    });
    res.on("close", () => {
      stream.destroy();
      resolveSend();
    });
    stream.pipe(res);
  });
}

/** Handle /api/files/*. The caller has already checked the gate cookie. */
export async function handleFilesRequest(service, req, res, url, { origin }) {
  try {
    const problem = filesRequestProblem(req, origin);
    if (problem) fail(403, problem);
    const route = url.pathname.replace(/^\/api\/files\/?/, "");
    const method = String(req.method || "GET").toUpperCase();
    const q = (key) => url.searchParams.get(key);
    if ((method === "GET" || method === "HEAD") && route === "raw") return await sendFile(service, req, res, url);
    if (method === "GET") {
      if (route === "roots") return sendJson(res, 200, await service.roots());
      if (route === "list") return sendJson(res, 200, await service.list({ root: q("root"), path: q("path") || "" }));
      if (route === "search") return sendJson(res, 200, await service.search({ root: q("root"), path: q("path") || "", q: q("q") || "" }));
      if (route === "info") return sendJson(res, 200, await service.info({ root: q("root"), path: q("path") || "" }));
      if (route === "trash") return sendJson(res, 200, await service.trashList({ root: q("root") || "" }));
      if (route === "upload") return sendJson(res, 200, await service.uploadStatus({ root: q("root"), dir: q("dir") || "", rel: q("rel"), id: q("id") }));
      fail(404, "Not found");
    }
    if (method === "PUT" && route === "upload") {
      const length = req.headers["content-length"];
      if (length !== undefined && Number(length) > MAX_CHUNK) fail(413, "That chunk is too big.");
      return sendJson(res, 200, await service.uploadChunk({
        root: q("root"), dir: q("dir") || "", rel: q("rel"), id: q("id"), offset: q("offset"), total: q("total"), length,
      }, req));
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      if (route === "roots") {
        if (body.action === "add") return sendJson(res, 200, await service.addRoot(body));
        if (body.action === "remove") return sendJson(res, 200, await service.removeRoot(body));
        fail(400, "action must be add or remove");
      }
      if (route === "mkdir") return sendJson(res, 200, await service.mkdir(body));
      if (route === "rename") return sendJson(res, 200, await service.rename(body));
      if (route === "move") return sendJson(res, 200, await service.transfer({ ...body, copy: false }));
      if (route === "copy") return sendJson(res, 200, await service.transfer({ ...body, copy: true }));
      if (route === "trash") return sendJson(res, 200, await service.trash(body));
      if (route === "restore") return sendJson(res, 200, await service.restore(body));
      if (route === "purge") return sendJson(res, 200, await service.purge(body));
      if (route === "upload/cancel") return sendJson(res, 200, await service.uploadCancel(body));
      fail(404, "Not found");
    }
    fail(405, "Method not allowed");
  } catch (error) {
    const { status, message, extra } = describeError(error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, status, { ok: false, error: message, ...extra });
  }
}
