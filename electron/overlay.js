"use strict";
// Hog's overlay views. They sit above every web page (WebContentsView order),
// so a site's own stacking, Trusted Types, or fullscreen layouts cannot hide
// them. mode=menu draws copies of the open Hog menus with Hog's own CSS;
// mode=grip draws one page-edge grip. Clicks go back as the same strings the
// WebKit shell's in-page grips posted.
(function () {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode");
  const side = params.get("side") === "wallet" ? "wallet" : "tabs";
  const root = document.getElementById("root");
  const post = (message) => window.hogOverlay && window.hogOverlay.post(message);

  let cssKey = "";
  function ensureCss(list) {
    const key = (list || []).join("|");
    if (key === cssKey) return;
    cssKey = key;
    document.querySelectorAll("link[data-hog]").forEach((node) => node.remove());
    const base = document.getElementById("hog-base");
    for (const href of list || []) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.hog = "1";
      document.head.insertBefore(link, base);
    }
  }

  // ------------------------------------------------------------ menus
  function renderMenus(state) {
    ensureCss(state.css);
    document.documentElement.className = state.htmlClass || "";
    if (state.theme) document.documentElement.dataset.theme = state.theme;
    else delete document.documentElement.dataset.theme;
    document.body.className = state.bodyClass || "";
    root.replaceChildren();
    for (const menu of state.menus || []) {
      const wrap = document.createElement("div");
      wrap.className = "menu-wrap";
      wrap.dataset.kind = menu.kind;
      wrap.style.left = `${Math.round(menu.rect.x - state.origin.x)}px`;
      wrap.style.top = `${Math.round(menu.rect.y - state.origin.y)}px`;
      wrap.style.width = `${Math.round(menu.rect.w)}px`;
      wrap.style.height = `${Math.round(menu.rect.h)}px`;
      // Rebuild the ancestor chain as box-less elements so selectors like
      // ".omnibox .suggestions li" still match the copy.
      let holder = wrap;
      for (const link of menu.chain || []) {
        const node = document.createElement(link.tag);
        if (link.id) node.id = link.id;
        if (link.cls) node.className = link.cls;
        node.style.setProperty("display", "contents", "important");
        holder.append(node);
        holder = node;
      }
      holder.innerHTML = menu.html;
      const el = holder.firstElementChild;
      if (el) {
        el.removeAttribute("hidden");
        el.classList.add("hog-copy");
      }
      root.append(wrap);
      const list = wrap.querySelector("ul");
      if (list && menu.scroll) list.scrollTop = menu.scroll;
    }
  }

  function menuButtons(wrap, kind) {
    if (kind === "settings") return [...wrap.querySelectorAll("[data-settings]")];
    if (kind === "history") return [...wrap.querySelectorAll("ul button")];
    return [...wrap.querySelectorAll("button")];
  }

  if (mode === "toasts") {
    window.__hogOverlay = renderMenus;
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        const button = event.target.closest && event.target.closest("button");
        if (!button) return;
        event.preventDefault();
        const index = [...root.querySelectorAll("button")].indexOf(button);
        if (index >= 0) post(`menu:toasts:${index}`);
      },
      true,
    );
    document.addEventListener("contextmenu", (event) => event.preventDefault());
    return;
  }

  if (mode === "pill") {
    // The floating "Tabs ›" / "‹ Wallet" label (EdgePill in the WebKit shell).
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill-label";
    root.append(pill);
    window.__hogOverlay = (state) => {
      pill.textContent = state.label || "";
      pill.className = `pill-label ${state.side === "wallet" ? "wallet" : "tabs"}`;
    };
    pill.addEventListener("pointerenter", () => post("enter"));
    pill.addEventListener("pointerleave", () => post("leave"));
    pill.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      post("click");
    });
    document.addEventListener("contextmenu", (event) => event.preventDefault());
    return;
  }

  if (mode === "menu") {
    window.__hogOverlay = renderMenus;
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        const wrap = event.target.closest && event.target.closest(".menu-wrap");
        if (!wrap) {
          event.preventDefault();
          post("menu:dismiss");
          return;
        }
        const button = event.target.closest("button");
        if (!button) return;
        event.preventDefault();
        const kind = wrap.dataset.kind;
        if (kind === "history" && button.id === "clear-history") {
          post("menu:clear");
          return;
        }
        const index = menuButtons(wrap, kind).indexOf(button.closest("[data-settings]") || button);
        if (index >= 0) post(`menu:${kind}:${index}`);
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") post("menu:dismiss");
    });
    document.addEventListener("contextmenu", (event) => event.preventDefault());
    return;
  }

  // ------------------------------------------------------------ grip
  // Same messages as the WebKit shell's EdgeSpot widget: in/out/down/move/up.
  // Hover shows the Hog UI's floating label (the pill overlay).
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `grip ${side}`;
  btn.innerHTML = '<span class="dots"><i></i><i></i><i></i><i></i></span>';
  root.append(btn);
  let top = 72;
  let active = false;
  let moved = false;
  let originScreenY = 0;
  let originTop = 0;
  window.__hogOverlay = (state) => {
    if (!active && state && Number.isFinite(state.top)) top = state.top;
  };
  btn.addEventListener("pointerenter", () => {
    if (!active) post(`in:${side}`);
  });
  btn.addEventListener("pointerleave", () => {
    if (!active) post(`out:${side}`);
  });
  btn.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    active = true;
    moved = false;
    originScreenY = event.screenY;
    originTop = top;
    try {
      btn.setPointerCapture(event.pointerId);
    } catch (e) {
      /* fine */
    }
    btn.classList.add("drag");
    post(`down:${side}`);
    event.preventDefault();
  });
  btn.addEventListener("pointermove", (event) => {
    if (!active) return;
    const dy = event.screenY - originScreenY;
    if (!moved && Math.abs(dy) < 4) return;
    moved = true;
    post(`move:${side}:${Math.round(originTop + dy)}`);
    event.preventDefault();
  });
  function stop(event) {
    if (!active) return;
    active = false;
    btn.classList.remove("drag");
    post(`up:${side}:${moved ? 1 : 0}`);
    if (event) event.preventDefault();
  }
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointercancel", stop);
  btn.addEventListener("contextmenu", (event) => event.preventDefault());
})();
