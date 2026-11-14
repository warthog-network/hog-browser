"use strict";
// In-memory ring of log text for the preview's read-only "Hog log" tab.
function toLine(text) {
  const s = String(text ?? "");
  if (!s) return "";
  return s.endsWith("\n") ? s : `${s}\n`;
}

class LogBuffer {
  constructor(maxChars = 200000) {
    this.maxChars = Math.max(4000, maxChars);
    this.chunks = [];
    this.listeners = new Set();
  }

  append(text) {
    const line = toLine(text);
    if (!line) return;
    this.chunks.push(line);
    let size = 0;
    for (const chunk of this.chunks) size += chunk.length;
    while (this.chunks.length > 1 && size > this.maxChars) size -= this.chunks.shift().length;
    for (const fn of this.listeners) {
      try {
        fn(line);
      } catch {
        /* listener failed */
      }
    }
  }

  text() {
    return this.chunks.join("");
  }

  on(fn) {
    if (typeof fn !== "function") return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { LogBuffer, toLine };
