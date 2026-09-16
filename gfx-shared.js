/*
 * gfx-shared.js — cross-page navigation and a shared "currently open .gfx".
 *
 * The tools are separate pages, so without this each one starts empty and you
 * have to pick the same file again. This keeps the opened archive in IndexedDB
 * under one well-known key; any page can publish to it or pick it up.
 *
 * Exposes window.GfxShared. Load it before the page's own script.
 */
(function () {
  "use strict";

  const DB_NAME = "distechGfxHandoff";
  const STORE = "files";
  const CURRENT_KEY = "current";

  /** Every page in the suite, in the order they appear in the picker. */
  const PAGES = [
    { id: "canvas", href: "index.html", label: "Logic Canvas", blurb: "Interactive diagram, trace and edit" },
    { id: "explorer", href: "explorer.html", label: "Parameter Explorer", blurb: "Search and bulk-edit parameters" },
    { id: "wiring", href: "wiring.html", label: "Logic Diagram Viewer", blurb: "Cross-reference of every connection" },
    { id: "rung", href: "rung-view.html", label: "Rung View", blurb: "Sequential ladder-style listing" },
    { id: "library", href: "library-view.html", label: "Library Match", blurb: "Compare sheets against the library" },
  ];

  // ------------------------------------------------------------ storage ---

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function put(key, payload) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(payload, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  function get(key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const request = tx.objectStore(STORE).get(key);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
        })
    );
  }

  /**
   * Publish the archive every other page should pick up. Buffers are cloned
   * because a detached ArrayBuffer cannot be stored, and the caller usually
   * still needs its copy.
   */
  async function setCurrentFile(fileName, buffer) {
    if (!buffer) return false;
    try {
      const copy = buffer.slice(0);
      await put(CURRENT_KEY, { fileName: fileName || "project.gfx", buffer: copy, savedAt: Date.now() });
      try {
        localStorage.setItem("distechGfxCurrentName", fileName || "project.gfx");
      } catch (_) {
        /* private mode — the IndexedDB copy is what matters */
      }
      return true;
    } catch (error) {
      console.warn("Could not share the open file:", error);
      return false;
    }
  }

  async function getCurrentFile() {
    try {
      return await get(CURRENT_KEY);
    } catch (error) {
      console.warn("Could not read the shared file:", error);
      return null;
    }
  }

  /** Name only — lets a page show "Continue with X" without loading megabytes. */
  function currentFileName() {
    try {
      return localStorage.getItem("distechGfxCurrentName") || "";
    } catch (_) {
      return "";
    }
  }

  async function takeHandoff(key) {
    try {
      const payload = await get(key);
      if (payload) {
        const db = await openDb();
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
      }
      return payload;
    } catch (error) {
      return null;
    }
  }

  // ----------------------------------------------------------------- nav ---

  /**
   * Render the page picker into [data-gfx-nav]. Kept as a <details> so it needs
   * no framework and closes on outside click via the handler below.
   */
  function renderNav(activeId) {
    const host = document.querySelector("[data-gfx-nav]");
    if (!host) return;

    const active = PAGES.find((page) => page.id === activeId) || PAGES[0];
    const items = PAGES.map((page) => {
      const current = page.id === active.id;
      return `
        <a class="gfx-nav-item${current ? " current" : ""}" href="${page.href}"${current ? ' aria-current="page"' : ""}>
          <span class="gfx-nav-label">${page.label}</span>
          <span class="gfx-nav-blurb">${page.blurb}</span>
        </a>`;
    }).join("");

    host.innerHTML = `
      <details class="gfx-nav">
        <summary class="gfx-nav-trigger" title="Switch tool">
          <span>${active.label}</span>
          <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </summary>
        <div class="gfx-nav-menu">
          <p class="gfx-nav-heading">Tools</p>
          ${items}
          <p class="gfx-nav-foot" data-gfx-nav-file></p>
        </div>
      </details>`;

    const details = host.querySelector("details");
    document.addEventListener("click", (event) => {
      if (details.open && !details.contains(event.target)) details.open = false;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && details.open) details.open = false;
    });

    updateNavFile(currentFileName());
  }

  function updateNavFile(name) {
    const foot = document.querySelector("[data-gfx-nav-file]");
    if (!foot) return;
    foot.textContent = name ? `Carrying over: ${name}` : "No file shared yet";
  }

  // --------------------------------------------------- theme and credit ---

  const THEME_KEY = "distechGfxTheme";
  const AUTHOR = "hbradroc@uwo.ca";

  /**
   * Saved choice first, otherwise whatever the operating system is set to. The
   * same logic runs from an inline snippet in each page's <head>; duplicating
   * it there is what stops a white flash before this deferred script loads.
   */
  function preferredTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "dark" || saved === "light") return saved;
    } catch (_) {
      /* private mode */
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  function applyTheme(theme, remember) {
    const next = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    if (remember) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (_) {
        /* private mode — the page still switches, it just will not persist */
      }
    }
    for (const button of document.querySelectorAll("[data-gfx-theme]")) {
      const goingTo = next === "dark" ? "light" : "dark";
      button.title = `Switch to ${goingTo} mode`;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(next === "dark"));
    }
    return next;
  }

  function toggleTheme() {
    return applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  }

  const ICONS = {
    moon: '<svg class="gfx-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></svg>',
    sun: '<svg class="gfx-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.2v2.4M12 19.4v2.4M2.2 12h2.4M19.4 12h2.4M5.1 5.1l1.7 1.7M17.2 17.2l1.7 1.7M18.9 5.1l-1.7 1.7M6.8 17.2l-1.7 1.7" /></svg>',
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 4.2-8 5.2-8-5.2V6l8 5 8-5v2.2Z" /></svg>',
  };

  /**
   * Draw the day/night toggle and the credit into [data-gfx-chrome]. Falls back
   * to whichever toolbar the page uses so a page only needs the slot if it
   * wants the cluster somewhere specific.
   */
  function renderChrome() {
    let host = document.querySelector("[data-gfx-chrome]");
    if (!host) {
      const bar = document.querySelector(
        ".topbar-controls, .rung-toolbar-actions, .lib-toolbar-actions, .wiring-toolbar-actions"
      );
      if (!bar) return;
      host = document.createElement("span");
      bar.appendChild(host);
    }

    host.innerHTML = `
      <span class="gfx-chrome">
        <button type="button" class="gfx-theme-toggle" data-gfx-theme>${ICONS.moon}${ICONS.sun}</button>
        <a class="gfx-credit" href="mailto:${AUTHOR}" title="Email ${AUTHOR}">
          ${ICONS.mail}
          <span><span class="gfx-credit-lead">developed by </span><strong>${AUTHOR}</strong></span>
        </a>
      </span>`;

    host.querySelector("[data-gfx-theme]").addEventListener("click", toggleTheme);
    applyTheme(currentTheme(), false);
  }

  // Follow the OS while the user has not made a choice of their own.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", (event) => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch (_) {
      /* private mode */
    }
    if (!saved) applyTheme(event.matches ? "dark" : "light", false);
  });

  applyTheme(preferredTheme(), false);
  document.addEventListener("DOMContentLoaded", renderChrome);

  window.GfxShared = {
    PAGES,
    renderNav,
    renderChrome,
    updateNavFile,
    setCurrentFile,
    getCurrentFile,
    currentFileName,
    takeHandoff,
    applyTheme,
    toggleTheme,
    currentTheme,
  };
})();
