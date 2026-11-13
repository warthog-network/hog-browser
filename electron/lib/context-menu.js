"use strict";
// Right-click menus for web pages and the Hog UI. Pure: builds an Electron
// Menu template from the "context-menu" params and a set of actions, so it is
// tested without Electron.

function short(text, max = 32) {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function webUrl(raw, allowed) {
  const url = allowed(raw);
  return url || "";
}

/**
 * params: Electron ContextMenuParams (linkURL, srcURL, mediaType, selectionText,
 *   isEditable, editFlags, misspelledWord, dictionarySuggestions, x, y).
 * actions: { openTab(url, iso), copy(text), download(url), copyImage(x, y),
 *   search(text), replaceMisspelling(word), addWord(word), back(), forward(),
 *   reload(), savePage(), print(), inspect(x, y), canBack, canForward }.
 * page: false for the Hog UI (only edit items and spelling there).
 */
function buildTemplate(params, actions, { page = true, allowed = (u) => u } = {}) {
  const groups = [];
  const p = params || {};
  const flags = p.editFlags || {};

  if (p.isEditable && p.misspelledWord) {
    const spell = [];
    for (const word of (p.dictionarySuggestions || []).slice(0, 5)) {
      spell.push({ label: word, click: () => actions.replaceMisspelling(word) });
    }
    if (!spell.length) spell.push({ label: "No spelling suggestions", enabled: false });
    spell.push({ label: "Add to dictionary", click: () => actions.addWord(p.misspelledWord) });
    groups.push(spell);
  }

  const link = page ? webUrl(p.linkURL, allowed) : "";
  if (link) {
    groups.push([
      { label: "Open link in new tab", click: () => actions.openTab(link, false) },
      { label: "Open link in Iso tab", click: () => actions.openTab(link, true) },
      { label: "Copy link address", click: () => actions.copy(link) },
      { label: "Save link to Downloads", click: () => actions.download(link) },
    ]);
  }

  const image = page && p.mediaType === "image" ? webUrl(p.srcURL, allowed) : "";
  if (image) {
    groups.push([
      { label: "Open image in new tab", click: () => actions.openTab(image, false) },
      { label: "Save image to Downloads", click: () => actions.download(image) },
      { label: "Copy image", click: () => actions.copyImage(p.x, p.y) },
      { label: "Copy image address", click: () => actions.copy(image) },
    ]);
  }

  if (p.isEditable) {
    groups.push([
      { role: "undo", enabled: flags.canUndo !== false },
      { role: "redo", enabled: flags.canRedo !== false },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut !== false },
      { role: "copy", enabled: flags.canCopy !== false },
      { role: "paste", enabled: flags.canPaste !== false },
      { role: "selectAll", enabled: flags.canSelectAll !== false },
    ]);
  } else if (p.selectionText && String(p.selectionText).trim()) {
    const text = String(p.selectionText).trim();
    const items = [{ role: "copy" }];
    if (page) items.push({ label: `Search the web for “${short(text)}”`, click: () => actions.search(text.slice(0, 500)) });
    groups.push(items);
  }

  if (page && !link && !image && !p.isEditable && !(p.selectionText && String(p.selectionText).trim())) {
    groups.push([
      { label: "Back", enabled: Boolean(actions.canBack), click: () => actions.back() },
      { label: "Forward", enabled: Boolean(actions.canForward), click: () => actions.forward() },
      { label: "Reload", click: () => actions.reload() },
      { label: "Save page as…", click: () => actions.savePage() },
      { label: "Print…", click: () => actions.print() },
    ]);
  }

  if (page) groups.push([{ label: "Inspect", click: () => actions.inspect(p.x, p.y) }]);

  const template = [];
  for (const group of groups) {
    if (!group.length) continue;
    if (template.length) template.push({ type: "separator" });
    template.push(...group);
  }
  return template;
}

function searchUrl(text) {
  return `https://duckduckgo.com/?q=${encodeURIComponent(String(text || "").slice(0, 500))}`;
}

module.exports = { buildTemplate, searchUrl, short };
