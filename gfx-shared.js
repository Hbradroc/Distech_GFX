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

  window.GfxShared = {
    PAGES,
    renderNav,
    updateNavFile,
    setCurrentFile,
    getCurrentFile,
    currentFileName,
    takeHandoff,
  };
})();
