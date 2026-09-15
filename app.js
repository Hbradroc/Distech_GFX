const APP_VERSION = "1.12.0";
const PARAM_HELP_PATH = `./param_help.json?v=${APP_VERSION}`;
const DISTECH_DOCS = "https://docs.distech-controls.com/bundle/gfx_UG/page/en-US/845626251.html";
const WIRING_STORAGE_PREFIX = "distechGfxWiring_";
const LIBRARY_STORAGE_PREFIX = "distechGfxLibrary_";
const LIBRARY_CATALOG_PATH = `./library-catalog.json?v=${APP_VERSION}`;

const gfxInput = document.getElementById("gfxFile");
const libraryFolderInput = document.getElementById("libraryFolder");
const loadLibraryBtn = document.getElementById("loadLibraryBtn");
const openLibraryBtn = document.getElementById("openLibraryBtn");
const focusBlockSearchBtn = document.getElementById("focusBlockSearchBtn");
const blockSearchInput = document.getElementById("blockSearchInput");
const blockSearchResults = document.getElementById("blockSearchResults");
const blockSearchDetail = document.getElementById("blockSearchDetail");
const blockSearchSection = document.getElementById("blockSearchSection");
const loadBtn = document.getElementById("loadBtn");
const generateBtn = document.getElementById("generateBtn");
const generateBtnInline = document.getElementById("generateBtnInline");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const openWiringBtn = document.getElementById("openWiringBtn");
const wiringLaunch = document.getElementById("wiringLaunch");
const wiringLaunchText = document.getElementById("wiringLaunchText");
const readyHint = document.getElementById("readyHint");
const logEl = document.getElementById("log");
const parameterSection = document.getElementById("parameterSection");
const parameterTitle = document.getElementById("parameterTitle");
const parameterSubtitle = document.getElementById("parameterSubtitle");
const paramSearch = document.getElementById("paramSearch");
const categoryFilter = document.getElementById("categoryFilter");
const changedOnly = document.getElementById("changedOnly");
const showOtherVariables = document.getElementById("showOtherVariables");
const editorList = document.getElementById("editorList");
const editorMeta = document.getElementById("editorMeta");
const editorHelp = document.getElementById("editorHelp");

const appState = {
  fileName: "",
  projectName: "",
  archive: null,
  parameters: [],
  wiringGraph: null,
  originalSnapshot: new Map(),
  manualEdits: new Set(),
  libraryCatalog: null,
  libraryReport: null,
  searchIndex: null,
};

let paramHelpCache = null;
let editorRenderScheduled = false;

const appVersionEl = document.getElementById("appVersion");
if (appVersionEl) {
  appVersionEl.textContent = `v${APP_VERSION}`;
}

function log(message) {
  logEl.textContent += `${message}\n`;
}

function clearLog() {
  logEl.textContent = "";
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resetState() {
  appState.fileName = "";
  appState.projectName = "";
  appState.archive = null;
  appState.parameters = [];
  appState.wiringGraph = null;
  appState.originalSnapshot = new Map();
  appState.manualEdits = new Set();
  appState.libraryReport = null;
  appState.searchIndex = null;
  generateBtn.disabled = true;
  exportCsvBtn.disabled = true;
  if (openWiringBtn) openWiringBtn.disabled = true;
  if (focusBlockSearchBtn) focusBlockSearchBtn.disabled = true;
  if (openLibraryBtn) openLibraryBtn.disabled = !appState.libraryCatalog;
  if (wiringLaunch) wiringLaunch.hidden = true;
  if (blockSearchInput) blockSearchInput.value = "";
  if (blockSearchResults) {
    blockSearchResults.hidden = true;
    blockSearchResults.innerHTML = "";
  }
  if (blockSearchDetail) {
    blockSearchDetail.hidden = true;
    blockSearchDetail.innerHTML = "";
  }
  readyHint.hidden = true;
  parameterSection.hidden = true;
  editorList.innerHTML = "";
  editorHelp.innerHTML =
    '<p class="editor-help-placeholder">Click a parameter or <strong>Info</strong> for EC-gfxProgram notes.</p>';
}

function snapshotParameters(parameters) {
  const map = new Map();
  parameters.forEach((param) => {
    map.set(GfxCore.paramKey(param.source, param.category, param.name, param.field), param.value);
  });
  return map;
}

function refreshLibraryReport() {
  if (!appState.wiringGraph || !appState.libraryCatalog) {
    appState.libraryReport = null;
    if (openLibraryBtn) openLibraryBtn.disabled = true;
    return null;
  }
  appState.libraryReport = GfxCore.matchLibraryToProject(appState.wiringGraph, appState.libraryCatalog);
  if (openLibraryBtn) openLibraryBtn.disabled = false;
  return appState.libraryReport;
}

function rebuildSearchIndex() {
  if (!appState.wiringGraph) {
    appState.searchIndex = null;
    if (focusBlockSearchBtn) focusBlockSearchBtn.disabled = true;
    return null;
  }
  appState.searchIndex = GfxCore.buildBlockSearchIndex(appState.wiringGraph, appState.libraryCatalog);
  if (focusBlockSearchBtn) focusBlockSearchBtn.disabled = false;
  return appState.searchIndex;
}

function renderBlockDetail(blockId, fallbackName = "", symbolUsages = null) {
  if (!blockSearchDetail) return;
  if (!blockId && !fallbackName && !symbolUsages) {
    blockSearchDetail.hidden = true;
    blockSearchDetail.innerHTML = "";
    return;
  }

  let detail = null;
  if (blockId && appState.wiringGraph) {
    detail = GfxCore.describeCustomBlock(appState.wiringGraph, blockId, appState.libraryCatalog);
  }

  if (!detail) {
    const libHits = appState.libraryCatalog?.byKey?.get(GfxCore.normalizeLibraryKey(fallbackName)) || [];
    const entry = libHits[0] || null;
    const symbol = appState.searchIndex?.byKey?.[GfxCore.normalizeLibraryKey(fallbackName)];
    if (!entry && !symbol) {
      blockSearchDetail.hidden = false;
      blockSearchDetail.innerHTML = `<h3>${escapeHtml(fallbackName || "Block")}</h3><p>No detailed description available yet.</p>`;
      return;
    }
    detail = {
      name: fallbackName || entry?.title || "Block",
      sheet: entry?.folder || symbol?.sheets?.[0] || "—",
      explanation: entry?.description || symbol?.explanation || "",
      inputs: (entry?.inputs || []).map((port) => ({ port, from: "library export" })),
      outputs: (entry?.outputs || []).map((port) => ({ port, to: "library export" })),
      library: entry,
    };
  }

  const inputLines = (detail.inputs || [])
    .slice(0, 12)
    .map((row) => `<li><strong>${escapeHtml(row.port || "—")}</strong> ← ${escapeHtml(row.from || "")}</li>`)
    .join("") || "<li>No wired inputs found</li>";
  const outputLines = (detail.outputs || [])
    .slice(0, 12)
    .map((row) => `<li><strong>${escapeHtml(row.port || "—")}</strong> → ${escapeHtml(row.to || "")}</li>`)
    .join("") || "<li>No wired outputs found</li>";
  const lib = detail.library;
  const libBlock = lib
    ? `<p><strong>Library:</strong> ${escapeHtml(lib.path || lib.title || "")}</p>
       <p>${escapeHtml(lib.description || "")}</p>`
    : `<p class="field-hint">No matching Library/.sptx snippet — explanation is inferred from this project.</p>`;
  const internals = lib?.namedBlocks?.length
    ? `<h4>Inside this library block</h4><ul>${lib.namedBlocks
        .slice(0, 16)
        .map((block) => `<li>${escapeHtml(block.name)} <small>(${escapeHtml(block.tag)})</small></li>`)
        .join("")}</ul>`
    : "";
  const usages = symbolUsages || [];
  const usageList = usages.length
    ? `<h4>Where it is used</h4><ul class="usage-list">${usages
        .slice(0, 30)
        .map(
          (usage) =>
            `<li><button type="button" class="usage-link" data-block-id="${escapeHtml(usage.blockId || "")}" data-name="${escapeHtml(usage.blockName)}"><strong>${escapeHtml(usage.blockName)}</strong> — ${escapeHtml(usage.role)} on ${escapeHtml(usage.sheet)}</button></li>`,
        )
        .join("")}</ul>`
    : "";

  blockSearchDetail.hidden = false;
  blockSearchDetail.innerHTML = `
    <h3>${escapeHtml(detail.name)}</h3>
    <p class="field-hint">Sheet: ${escapeHtml(detail.sheet || "—")}</p>
    <p>${escapeHtml(detail.explanation || "")}</p>
    ${libBlock}
    ${usageList}
    <div class="block-search-columns">
      <div><h4>What feeds it</h4><ul>${inputLines}</ul></div>
      <div><h4>What it controls</h4><ul>${outputLines}</ul></div>
    </div>
    ${internals}
    ${detail.blockId ? `<button type="button" class="secondary help-wiring-link" data-block-id="${escapeHtml(detail.blockId)}">Trace signal flow</button>` : ""}
  `;
}

function renderBlockSearch() {
  if (!blockSearchResults || !blockSearchInput) return;
  const query = blockSearchInput.value.trim();
  if (!appState.searchIndex || query.length < 2) {
    blockSearchResults.hidden = true;
    blockSearchResults.innerHTML = "";
    return;
  }

  const result = GfxCore.searchBlocks(query, appState.searchIndex, appState.libraryCatalog);
  const symbolCards = result.symbols
    .slice(0, 12)
    .map((symbol) => {
      const usagePreview = symbol.usages
        .slice(0, 4)
        .map((usage) => `${usage.role}: ${usage.blockName} (${usage.sheet})`)
        .join(" · ");
      return `<button type="button" class="block-hit" data-kind="symbol" data-name="${escapeHtml(symbol.name)}">
        <strong>${escapeHtml(symbol.name)}</strong>
        <small>${escapeHtml(symbol.explanation)}</small>
        <small>${symbol.usageCount} place(s)${usagePreview ? ` — ${escapeHtml(usagePreview)}` : ""}</small>
      </button>`;
    })
    .join("");

  const blockCards = result.blocks
    .slice(0, 12)
    .map((block) => `<button type="button" class="block-hit" data-kind="block" data-block-id="${escapeHtml(block.blockId || "")}" data-name="${escapeHtml(block.name)}">
      <strong>${escapeHtml(block.name)}</strong>
      <small>${escapeHtml(block.explanation)}</small>
      <small>Used with ${escapeHtml(block.viaSymbols.join(", "))} · ${escapeHtml(block.sheet || "—")}</small>
    </button>`)
    .join("");

  const libraryCards = result.libraryHits
    .slice(0, 8)
    .map((hit) => `<button type="button" class="block-hit" data-kind="library" data-name="${escapeHtml(hit.title)}">
      <strong>${escapeHtml(hit.title)}</strong>
      <small>${escapeHtml(hit.description)}</small>
      <small>Library · ${escapeHtml(hit.path)}</small>
    </button>`)
    .join("");

  blockSearchResults.hidden = false;
  blockSearchResults.innerHTML = `
    <div class="block-hit-group">
      <h4>Matches in this .gfx (${result.symbols.length})</h4>
      ${symbolCards || "<p class='field-hint'>No project symbols matched.</p>"}
    </div>
    <div class="block-hit-group">
      <h4>Custom blocks that use it (${result.blocks.length})</h4>
      ${blockCards || "<p class='field-hint'>No related custom blocks found.</p>"}
    </div>
    <div class="block-hit-group">
      <h4>Library snippets (${result.libraryHits.length})</h4>
      ${libraryCards || "<p class='field-hint'>No Library/.sptx matches — load the Library folder if needed.</p>"}
    </div>`;
}

async function loadBundledLibraryCatalog() {
  try {
    const response = await fetch(LIBRARY_CATALOG_PATH, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.entries?.length) return null;
    appState.libraryCatalog = GfxCore.indexLibraryCatalog(data.entries);
    log(`Loaded bundled library catalog: ${data.entries.length} snippets.`);
    refreshLibraryReport();
    rebuildSearchIndex();
    return appState.libraryCatalog;
  } catch {
    return null;
  }
}

async function loadLibraryFolder() {
  clearLog();
  if (!libraryFolderInput?.files?.length) {
    log("Choose a Library folder (contains .sptx files), then click Load library.");
    return;
  }

  loadLibraryBtn.disabled = true;
  loadLibraryBtn.textContent = "Indexing…";
  try {
    const files = [...libraryFolderInput.files].filter((file) => /\.sptx$/i.test(file.name));
    if (!files.length) {
      log("No .sptx files found in that folder.");
      return;
    }

    const entries = [];
    let failed = 0;
    for (const file of files) {
      const rel = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
      const parts = rel.split("/");
      const stem = file.name.replace(/\.sptx$/i, "");
      const folder = parts.slice(0, -1).filter((part) => part.toLowerCase() !== "library").join("/");
      try {
        const entry = await GfxCore.parseLibrarySnippetFile(file, {
          path: rel.includes("/") ? rel.replace(/^[^/]+\//, "") : file.name,
          source: "Library",
          folder,
          stem,
          id: `Library:${rel}`,
        });
        entries.push(entry);
      } catch (error) {
        failed += 1;
        if (failed <= 5) log(`Skip ${rel}: ${error.message}`);
      }
    }

    appState.libraryCatalog = GfxCore.indexLibraryCatalog(entries);
    const report = refreshLibraryReport();
    rebuildSearchIndex();
    log(`Indexed ${entries.length} library snippets${failed ? ` (${failed} skipped)` : ""}.`);
    if (report) {
      log(`Library match vs current .gfx: ${report.matchCount} matched, ${report.unmatchedCount} unmatched.`);
    } else {
      log("Load a .gfx template to see where each library function is used.");
    }
  } catch (error) {
    log(`Library index error: ${error.message}`);
  } finally {
    loadLibraryBtn.disabled = false;
    loadLibraryBtn.textContent = "Load library";
  }
}

function openLibraryViewer() {
  const report = refreshLibraryReport();
  if (!report) {
    log("Load a .gfx and a Library folder (or library-catalog.json) first.");
    return;
  }

  const payload = {
    projectName: appState.projectName || appState.fileName,
    fileName: appState.fileName,
    exportedAt: new Date().toISOString(),
    report,
  };
  const storageKey = `${LIBRARY_STORAGE_PREFIX}${Date.now()}`;
  try {
    const serialized = JSON.stringify(payload);
    localStorage.setItem(storageKey, serialized);
    localStorage.setItem(`${LIBRARY_STORAGE_PREFIX}latest`, serialized);
  } catch (error) {
    log(`Could not store library report (${error.message}).`);
    return;
  }

  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(LIBRARY_STORAGE_PREFIX) && key !== storageKey && key !== `${LIBRARY_STORAGE_PREFIX}latest`) {
      localStorage.removeItem(key);
    }
  }

  const popup = window.open(`library-view.html?v=${APP_VERSION}&key=${encodeURIComponent(storageKey)}`, "_blank", "width=1100,height=900");
  if (!popup) {
    log("Popup blocked — allow popups for this site.");
    return;
  }
  popup.focus();
}

async function loadParamHelp() {
  if (paramHelpCache) return paramHelpCache;
  try {
    const response = await fetch(PARAM_HELP_PATH, { cache: "no-store" });
    if (!response.ok) throw new Error("param_help.json not found");
    paramHelpCache = await response.json();
  } catch {
    paramHelpCache = { manualHome: DISTECH_DOCS, parameters: {} };
  }
  return paramHelpCache;
}

function lookupParamHelp(param) {
  const params = paramHelpCache?.parameters || {};
  if (params[param.name]) return params[param.name];
  if (param.category === "ComSensorBinding" && params.ComSensorBinding) return params.ComSensorBinding;
  if (param.category === "InternalConstant" && params.InternalConstant) return params.InternalConstant;
  const portName = param.name.includes(".") ? param.name.split(".").pop() : param.name;
  if (params[portName]) return params[portName];
  const composite = `${param.category}.${param.field}`;
  if (params[composite]) return params[composite];
  return null;
}

function renderParamHelpPanel(param) {
  const help = lookupParamHelp(param);
  const manualHome = paramHelpCache?.manualHome || DISTECH_DOCS;
  const label = `${param.category} · ${param.field}`;

  if (!help) {
    const extra = param.hint ? `<p class="help-path">${escapeHtml(param.hint)}</p>` : "";
    const feeds = param.context ? `<p class="help-path"><strong>Connected to:</strong> ${escapeHtml(param.context)}</p>` : "";
    const blockId = blockIdFromParam(param);
    const wiringLink = blockId
      ? `<button type="button" class="help-wiring-link" data-block-id="${escapeHtml(blockId)}">View block wiring</button>`
      : "";
    const crossRefHelp = renderCrossRefHelp(param);
    const signalHelp = renderSignalFlowHelp(param);
    editorHelp.innerHTML = `
      <h3>${escapeHtml(param.name)}</h3>
      <p class="help-label">${escapeHtml(label)}</p>
      ${feeds}
      ${extra}
      ${signalHelp}
      ${crossRefHelp}
      ${wiringLink}
      <p class="help-path">No mapped description in param_help.json yet.</p>
      <div class="help-links">
        <a href="${manualHome}" target="_blank" rel="noopener noreferrer">EC-gfxProgram constants guide</a>
      </div>`;
    return;
  }

  const title = help.label ? `<p class="help-label">${escapeHtml(help.label)}</p>` : "";
  const notes = (help.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join("");
  const notesBlock = notes ? `<ul class="help-notes">${notes}</ul>` : "";
  const feeds = param.context ? `<p class="help-path"><strong>Connected to:</strong> ${escapeHtml(param.context)}</p>` : "";
  const hint = param.hint ? `<p class="help-path">${escapeHtml(param.hint)}</p>` : "";
  const blockId = blockIdFromParam(param);
  const wiringLink = blockId
    ? `<button type="button" class="help-wiring-link" data-block-id="${escapeHtml(blockId)}">View block wiring</button>`
    : "";
  const crossRefHelp = renderCrossRefHelp(param);
  const signalHelp = renderSignalFlowHelp(param);
  const docUrl = help.manualUrl || manualHome;
  editorHelp.innerHTML = `
    <h3>${escapeHtml(param.name)}</h3>
    ${title}
    <p class="help-path">${escapeHtml(label)}${param.controller_specific === "1" ? " · Controller specific" : ""}</p>
    ${feeds}
    ${hint}
    ${notesBlock}
    ${signalHelp}
    ${crossRefHelp}
    ${wiringLink}
    <div class="help-links">
      <a href="${docUrl}" target="_blank" rel="noopener noreferrer">Open Distech documentation</a>
    </div>`;
}

function selectParamRow(rowEl, param) {
  editorList.querySelectorAll(".param-row.selected").forEach((el) => el.classList.remove("selected"));
  if (rowEl) rowEl.classList.add("selected");
  renderParamHelpPanel(param);
}

function getParamByKey(key) {
  return appState.parameters.find(
    (param) => GfxCore.paramKey(param.source, param.category, param.name, param.field) === key,
  );
}

function setParameterValue(key, rawValue) {
  const param = getParamByKey(key);
  if (!param) return false;

  const trimmed = String(rawValue).trim();
  param.value = trimmed;

  const original = appState.originalSnapshot.get(key);
  if (original !== undefined && original === trimmed) {
    appState.manualEdits.delete(key);
  } else {
    appState.manualEdits.add(key);
  }
  return true;
}

function populateCategoryFilter() {
  categoryFilter.innerHTML = '<option value="">All sections</option>';
  const present = new Set(appState.parameters.map((p) => p.category));

  for (const section of GfxCore.CATEGORY_SECTIONS) {
    const categories = section.categories.filter((category) => present.has(category));
    if (!categories.length) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = section.label;
    categories.forEach((category) => {
      const count = appState.parameters.filter((p) => p.category === category).length;
      const option = document.createElement("option");
      option.value = category;
      option.textContent = `${category} (${count})`;
      optgroup.appendChild(option);
    });
    categoryFilter.appendChild(optgroup);
  }
}

function getVisibleParameters() {
  const query = paramSearch.value.trim().toLowerCase();
  const category = categoryFilter.value;
  const onlyChanged = changedOnly.checked;

  return appState.parameters.filter((param) => {
    const key = GfxCore.paramKey(param.source, param.category, param.name, param.field);
    if (!showOtherVariables.checked && param.tier === "other") return false;
    if (onlyChanged && !appState.manualEdits.has(key)) return false;
    if (category && param.category !== category) return false;
    if (!query) return true;
    const haystack = `${param.name} ${param.category} ${param.field} ${param.value}`.toLowerCase();
    if (haystack.includes(query)) return true;
    const help = lookupParamHelp(param);
    return Boolean(help?.label && help.label.toLowerCase().includes(query));
  });
}

function updateEditorMeta(count) {
  const manual = appState.manualEdits.size;
  const otherCount = appState.parameters.filter((p) => p.tier === "other").length;
  const otherNote = showOtherVariables.checked
    ? ""
    : ` · ${otherCount} other variable${otherCount === 1 ? "" : "s"} hidden`;
  editorMeta.textContent = `Showing ${count} of ${appState.parameters.length} parameters · ${manual} changed${otherNote}`;
}

function renderParameterList() {
  const rows = getVisibleParameters();
  editorList.innerHTML = "";

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "editor-empty";
    const msg = document.createElement("p");
    msg.textContent = changedOnly.checked
      ? "No changed parameters yet. Edit a value above."
      : paramSearch.value.trim()
        ? "No parameters match your search."
        : "No parameters found in this template.";
    empty.appendChild(msg);
    editorList.appendChild(empty);
    updateEditorMeta(0);
    return;
  }

  const fragment = document.createDocumentFragment();
  const limit = 800;
  const visible = rows.slice(0, limit);
  let currentSection = "";

  visible.forEach((param) => {
    const sectionLabel = param.section || GfxCore.sectionForCategory(param.category);
    if (sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      const header = document.createElement("div");
      header.className = "section-header";
      const count = rows.filter((row) => (row.section || GfxCore.sectionForCategory(row.category)) === sectionLabel).length;
      header.innerHTML = `<h3>${escapeHtml(sectionLabel)}</h3><span>${count} item${count === 1 ? "" : "s"}</span>`;
      fragment.appendChild(header);
    }

    const key = GfxCore.paramKey(param.source, param.category, param.name, param.field);
    const row = document.createElement("div");
    row.className = `param-row${appState.manualEdits.has(key) ? " manual-edit" : ""}`;

    const keyEl = document.createElement("div");
    keyEl.className = "param-key";
    const contextLine = param.hint || param.context;
    keyEl.innerHTML = `<strong>${escapeHtml(param.name)}</strong><span>${escapeHtml(param.category)} · ${escapeHtml(param.field)}</span>${contextLine ? `<em class="param-context">${escapeHtml(contextLine)}</em>` : ""}`;
    keyEl.title = [param.source, param.context, param.hint].filter(Boolean).join(" | ");

    const input = document.createElement("input");
    input.type = "text";
    const formattedValue = GfxCore.formatParameterValue(param.value);
    input.value = formattedValue;
    if (formattedValue !== param.value) {
      input.title = param.value;
      input.classList.add("param-value-summary");
    }

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "param-reset";
    resetBtn.textContent = "Reset";
    resetBtn.disabled = !appState.manualEdits.has(key);

    input.addEventListener("focus", () => selectParamRow(row, param));
    input.addEventListener("change", () => {
      setParameterValue(key, input.value);
      row.classList.toggle("manual-edit", appState.manualEdits.has(key));
      resetBtn.disabled = !appState.manualEdits.has(key);
      updateEditorMeta(getVisibleParameters().length);
    });

    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "param-info-btn";
    infoBtn.textContent = "Info";
    infoBtn.addEventListener("click", () => selectParamRow(row, param));

    resetBtn.addEventListener("click", () => {
      const original = appState.originalSnapshot.get(key);
      if (original === undefined) return;
      setParameterValue(key, original);
      input.value = original;
      row.classList.toggle("manual-edit", appState.manualEdits.has(key));
      resetBtn.disabled = !appState.manualEdits.has(key);
      updateEditorMeta(getVisibleParameters().length);
    });

    keyEl.addEventListener("click", () => selectParamRow(row, param));
    row.appendChild(keyEl);
    row.appendChild(input);
    row.appendChild(infoBtn);
    row.appendChild(resetBtn);
    fragment.appendChild(row);
  });

  if (rows.length > limit) {
    const more = document.createElement("p");
    more.className = "editor-empty";
    more.textContent = `${rows.length - limit} more parameters match — refine your search.`;
    fragment.appendChild(more);
  }

  editorList.appendChild(fragment);
  updateEditorMeta(visible.length);
}

function scheduleEditorRender() {
  if (editorRenderScheduled) return;
  editorRenderScheduled = true;
  requestAnimationFrame(() => {
    editorRenderScheduled = false;
    renderParameterList();
  });
}

function outputFileName() {
  if (!appState.fileName) return "generated.gfx";
  const stem = appState.fileName.replace(/\.gfx$/i, "");
  return `${stem}_generated.gfx`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function setGenerating(isGenerating) {
  loadBtn.disabled = isGenerating;
  generateBtn.disabled = isGenerating || !appState.archive;
  generateBtnInline.disabled = isGenerating || !appState.archive;
  exportCsvBtn.disabled = isGenerating || !appState.archive;
  generateBtn.textContent = isGenerating ? "Generating…" : "Generate .gfx";
  generateBtnInline.textContent = isGenerating ? "Generating…" : "Generate .gfx";
}

async function generateGfx() {
  if (!appState.archive) {
    log("Load a template .gfx file first.");
    return;
  }

  clearLog();
  setGenerating(true);
  try {
    const { blob, changed } = await GfxCore.buildModifiedGfx(appState.archive, appState.parameters);
    const filename = outputFileName();
    downloadBlob(blob, filename);

    log(`Generated ${filename}`);
    log(`Template: ${appState.fileName}`);
    if (appState.projectName) log(`Project: ${appState.projectName}`);
    log(`Total parameters: ${appState.parameters.length}`);
    log(`Values written: ${changed.length}`);
    if (changed.length) {
      changed.slice(0, 30).forEach((line) => log(`  - ${line}`));
      if (changed.length > 30) log(`  - ... and ${changed.length - 30} more`);
    } else {
      log("No values were changed from the template defaults.");
    }
    log("Import the generated file in EC-gfxProgram and verify before downloading to a controller.");
  } catch (error) {
    log(`Error: ${error.message}`);
  } finally {
    setGenerating(false);
  }
}

function exportCsv() {
  if (!appState.parameters.length) {
    log("Load a template first.");
    return;
  }
  const csv = GfxCore.parametersToCsv(appState.parameters);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const stem = appState.fileName ? appState.fileName.replace(/\.gfx$/i, "") : "parameters";
  downloadBlob(blob, `${stem}_parameters.csv`);
  log(`Exported ${appState.parameters.length} parameters to CSV.`);
}

function renderCrossRefHelp(param) {
  const crossRef = GfxCore.lookupCrossReference(appState.wiringGraph, param.name);
  if (!crossRef) return "";
  const hubs = crossRef.hubs.map((hub) => hub.sheet).join(", ") || "—";
  const targets = crossRef.targets.map((target) => target.sheet).join(", ") || "—";
  return `
    <div class="help-crossref">
      <p class="help-path"><strong>Defined on:</strong> ${escapeHtml(hubs)}</p>
      <p class="help-path"><strong>Used on:</strong> ${escapeHtml(targets)}</p>
      <button type="button" class="help-wiring-link" data-tag-name="${escapeHtml(crossRef.tagName)}">Open cross-reference viewer</button>
    </div>`;
}

function renderSignalFlowHelp(param) {
  if (!appState.wiringGraph) return "";
  const signal = GfxCore.resolveParamSignal(appState.wiringGraph, param);
  if (!signal?.blockId) return "";
  const flow = GfxCore.tracePortFlow(appState.wiringGraph, signal.blockId, signal.portName || "");
  const inputSummary = flow.inputs.length
    ? flow.inputs.map((row) => `${row.from.label} → ${row.port}`).slice(0, 3).join("; ")
    : "none on this sheet";
  const outputSummary = flow.outputs.length
    ? flow.outputs.map((row) => `${row.port} → ${row.to.label}`).slice(0, 3).join("; ")
    : "none on this sheet";
  const portAttr = signal.portName ? ` data-port-name="${escapeHtml(signal.portName)}"` : "";
  return `
    <div class="help-signal-flow">
      <p class="help-path"><strong>Inputs:</strong> ${escapeHtml(inputSummary)}</p>
      <p class="help-path"><strong>Outputs:</strong> ${escapeHtml(outputSummary)}</p>
      <button type="button" class="help-wiring-link" data-block-id="${escapeHtml(signal.blockId)}"${portAttr}>Trace signal flow</button>
    </div>`;
}

async function openWiringViewer(focusBlockId = "", focusTagName = "", focusPortName = "") {
  if (!appState.wiringGraph) {
    log("Load a template first to view wiring.");
    return;
  }
  if (typeof GfxCore.buildRunSequence !== "function") {
    log("Run order unavailable — hard-refresh the page (Ctrl+F5) to load gfx-core v1.11+.");
  }
  const runSequence =
    typeof GfxCore.buildRunSequence === "function"
      ? GfxCore.buildRunSequence(appState.wiringGraph, appState.parameters, {
          mainXmlText: appState.archive?.mainXmlText || "",
        })
      : { detected: false, reason: "buildRunSequence missing — hard-refresh the page." };

  const sequenceParams = (appState.parameters || []).filter((param) => {
    if (param.category === "InternalConstant") return true;
    if (!["test_mode", "econo_delta", "dmp_min"].includes(param.name)) return false;
    return param.field === "DefaultValue" || param.field === "Default";
  });
  const testModeMatch = (appState.archive?.mainXmlText || "").match(/TEST\s+MODES[\s\S]{0,900}/i);
  const payload = {
    projectName: appState.projectName || appState.fileName,
    fileName: appState.fileName,
    exportedAt: new Date().toISOString(),
    focusBlockId: focusBlockId || "",
    focusTagName: focusTagName || "",
    focusPortName: focusPortName || "",
    wiring: appState.wiringGraph,
    runSequence,
    sequenceParams,
    testModeText: testModeMatch ? testModeMatch[0] : "",
  };

  const storageKey = `${WIRING_STORAGE_PREFIX}${Date.now()}`;
  let storageResult;
  try {
    storageResult = await GfxCore.saveWiringViewerPayload(storageKey, payload, WIRING_STORAGE_PREFIX);
  } catch (error) {
    log(`Could not store wiring data (${error.message})`);
    return;
  }

  const storeParam = storageResult.storage === "idb" ? "&store=idb" : "";
  const url = `wiring.html?v=${APP_VERSION}&key=${encodeURIComponent(storageKey)}${storeParam}`;
  const popup = window.open(url, "_blank", "width=1280,height=900");
  if (!popup) {
    log("Popup blocked — allow popups for this site, then click Open wiring viewer again.");
    return;
  }
  popup.focus();
  if (runSequence?.detected) {
    log(`Wiring viewer opened with Run order (${runSequence.scenarios?.length || 0} test modes, ${storageResult.sizeMb} MB).`);
  } else {
    log(`Wiring viewer opened (${storageResult.sizeMb} MB). Run order not detected: ${runSequence?.reason || "unknown"}.`);
  }
}

function blockIdFromParam(param) {
  const match = param.name.match(/#(\d+)$/);
  return match ? match[1] : "";
}

async function loadTemplate() {
  clearLog();
  if (!gfxInput.files || !gfxInput.files[0]) {
    log("Please choose a template .gfx file.");
    return;
  }

  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";
  try {
    await loadParamHelp();
    const file = gfxInput.files[0];
    const buffer = await file.arrayBuffer();
    const archive = await GfxCore.loadGfxArchive(buffer);

    appState.fileName = file.name;
    appState.projectName = archive.projectName;
    appState.archive = {
      originalBuffer: buffer,
      mainXmlText: archive.mainXmlText,
      comConfigText: archive.comConfigText,
      scheduleFiles: archive.scheduleFiles,
    };
    appState.parameters = GfxCore.cloneParameters(archive.parameters);
    appState.wiringGraph = archive.wiringGraph;
    appState.originalSnapshot = snapshotParameters(appState.parameters);
    appState.manualEdits = new Set();

    populateCategoryFilter();
    paramSearch.value = "";
    categoryFilter.value = "";
    changedOnly.checked = false;
    showOtherVariables.checked = false;

    parameterTitle.textContent = "All parameters";
    parameterSubtitle.textContent = appState.projectName || file.name;
    parameterSection.hidden = false;
    readyHint.hidden = false;
    generateBtn.disabled = false;
    exportCsvBtn.disabled = false;
    if (openWiringBtn) openWiringBtn.disabled = false;
    if (wiringLaunch) wiringLaunch.hidden = false;
    if (wiringLaunchText && archive.wiringGraph) {
      const sequence = GfxCore.buildRunSequence
        ? GfxCore.buildRunSequence(archive.wiringGraph, appState.parameters, {
            mainXmlText: archive.mainXmlText || "",
          })
        : null;
      if (sequence?.detected) {
        wiringLaunchText.textContent = `Run order available · ${sequence.scenarios?.length || 0} test modes · ${archive.wiringGraph.crossRefCount || 0} tags`;
      } else {
        wiringLaunchText.textContent = `${archive.wiringGraph.crossRefCount || 0} tags · ${archive.wiringGraph.linkCount} wires`;
      }
    }
    rebuildSearchIndex();
    if (blockSearchInput?.value.trim()) renderBlockSearch();

    renderParameterList();
    parameterSection.scrollIntoView({ behavior: "smooth", block: "start" });

    const counts = GfxCore.countByCategory(appState.parameters);
    log(`App version: ${APP_VERSION}`);
    log(`Template loaded: ${file.name}`);
    if (archive.projectName) log(`Project: ${archive.projectName}`);
    log(`Listed ${appState.parameters.length} parameters:`);
    GfxCore.CATEGORY_SECTIONS.forEach((section) => {
      const sectionCount = section.categories.reduce((sum, category) => sum + (counts[category] || 0), 0);
      if (!sectionCount) return;
      log(`  ${section.label}: ${sectionCount}`);
      section.categories.forEach((category) => {
        if (counts[category]) log(`    - ${category}: ${counts[category]}`);
      });
    });
    log(`Logic: ${archive.wiringGraph.crossRefCount || 0} cross-reference tags, ${archive.wiringGraph.linkCount} wire connections.`);
    const sequence = GfxCore.buildRunSequence
      ? GfxCore.buildRunSequence(archive.wiringGraph, appState.parameters, {
          mainXmlText: archive.mainXmlText || "",
        })
      : null;
    if (sequence?.detected) {
      log(
        `Run order: Testing → Economizer → heat_cool → ventilate (${sequence.scenarios.length} test modes). Open wiring viewer → Run order tab.`,
      );
    }
    const audit = GfxCore.analyzeNonFunctionalBlocks(archive.wiringGraph);
    if (audit.summary.total) {
      log(
        `Logic audit: ${audit.summary.likelyBackup} likely backup/Monitor blocks, ${audit.summary.highConfidence} high-confidence dead paths — open wiring viewer → Logic audit tab.`,
      );
    }
    const libraryReport = refreshLibraryReport();
    if (libraryReport) {
      log(
        `Library match: ${libraryReport.matchCount} of ${libraryReport.matchCount + libraryReport.unmatchedCount} modules matched to Library/.sptx — click Open library match.`,
      );
    } else {
      log("Optional: Load library folder (.sptx) to see which modules come from your Library.");
    }
    log("Edit job setpoints below. Enable Other variables for logic constants, BACnet metadata, and com sensor registers.");
  } catch (error) {
    log(`Error: ${error.message}`);
    resetState();
  } finally {
    loadBtn.disabled = false;
    loadBtn.textContent = "Load template";
  }
}

generateBtn.addEventListener("click", generateGfx);
generateBtnInline.addEventListener("click", generateGfx);
exportCsvBtn.addEventListener("click", exportCsv);
if (openWiringBtn) openWiringBtn.addEventListener("click", () => openWiringViewer());
if (loadLibraryBtn) loadLibraryBtn.addEventListener("click", loadLibraryFolder);
if (openLibraryBtn) openLibraryBtn.addEventListener("click", openLibraryViewer);
if (focusBlockSearchBtn) {
  focusBlockSearchBtn.addEventListener("click", () => {
    blockSearchSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    blockSearchInput?.focus();
  });
}
if (blockSearchInput) {
  blockSearchInput.addEventListener("input", () => {
    renderBlockSearch();
  });
}
if (blockSearchResults) {
  blockSearchResults.addEventListener("click", (event) => {
    const hit = event.target.closest(".block-hit");
    if (!hit) return;
    const kind = hit.dataset.kind;
    const name = hit.dataset.name || "";
    const blockId = hit.dataset.blockId || "";
    if (kind === "block" && blockId) {
      renderBlockDetail(blockId, name);
      return;
    }
    if (kind === "symbol") {
      const symbol = appState.searchIndex?.byKey?.[GfxCore.normalizeLibraryKey(name)];
      renderBlockDetail("", name, symbol?.usages || []);
      return;
    }
    renderBlockDetail("", name);
  });
}
if (blockSearchDetail) {
  blockSearchDetail.addEventListener("click", (event) => {
    const usage = event.target.closest(".usage-link");
    if (usage) {
      renderBlockDetail(usage.dataset.blockId || "", usage.dataset.name || "");
      return;
    }
    const wiring = event.target.closest(".help-wiring-link[data-block-id]");
    if (wiring) openWiringViewer(wiring.dataset.blockId || "");
  });
}
editorHelp.addEventListener("click", (event) => {
  const tagBtn = event.target.closest("[data-tag-name]");
  if (tagBtn?.dataset.tagName) {
    openWiringViewer("", tagBtn.dataset.tagName);
    return;
  }
  const btn = event.target.closest(".help-wiring-link[data-block-id]");
  if (!btn) return;
  openWiringViewer(btn.dataset.blockId || "", "", btn.dataset.portName || "");
});
loadBtn.addEventListener("click", loadTemplate);

paramSearch.addEventListener("input", scheduleEditorRender);
categoryFilter.addEventListener("change", scheduleEditorRender);
changedOnly.addEventListener("change", scheduleEditorRender);
showOtherVariables.addEventListener("change", scheduleEditorRender);

gfxInput.addEventListener("change", () => {
  resetState();
  if (gfxInput.files && gfxInput.files[0]) {
    loadTemplate();
  }
});

loadBundledLibraryCatalog();
loadParamHelp();