const APP_VERSION = "1.0.0";
const PARAM_HELP_PATH = `./param_help.json?v=${APP_VERSION}`;
const DISTECH_DOCS = "https://docs.distech-controls.com/bundle/gfx_UG/page/en-US/845626251.html";

const gfxInput = document.getElementById("gfxFile");
const loadBtn = document.getElementById("loadBtn");
const downloadBtn = document.getElementById("downloadBtn");
const readyHint = document.getElementById("readyHint");
const logEl = document.getElementById("log");

const adminMenuBtn = document.getElementById("adminMenuBtn");
const adminDropdown = document.getElementById("adminDropdown");
const openEditorBtn = document.getElementById("openEditorBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const editorBackdrop = document.getElementById("editorBackdrop");
const closeEditorBtn = document.getElementById("closeEditorBtn");
const editorCloseFooterBtn = document.getElementById("editorCloseFooterBtn");
const editorDownloadBtn = document.getElementById("editorDownloadBtn");
const paramSearch = document.getElementById("paramSearch");
const categoryFilter = document.getElementById("categoryFilter");
const showAllParams = document.getElementById("showAllParams");
const editorList = document.getElementById("editorList");
const editorMeta = document.getElementById("editorMeta");
const editorHelp = document.getElementById("editorHelp");

const appState = {
  fileName: "",
  projectName: "",
  archive: null,
  parameters: [],
  originalSnapshot: new Map(),
  manualEdits: new Set(),
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

function defaultCategories() {
  return [...document.querySelectorAll('input[name="defaultCategories"]:checked')].map(
    (el) => el.value,
  );
}

function isDefaultCategory(category) {
  return defaultCategories().includes(category);
}

function resetState() {
  appState.fileName = "";
  appState.projectName = "";
  appState.archive = null;
  appState.parameters = [];
  appState.originalSnapshot = new Map();
  appState.manualEdits = new Set();
  adminMenuBtn.disabled = true;
  downloadBtn.disabled = true;
  readyHint.hidden = true;
}

function snapshotParameters(parameters) {
  const map = new Map();
  parameters.forEach((param) => {
    map.set(GfxCore.paramKey(param.source, param.category, param.name, param.field), param.value);
  });
  return map;
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
  const composite = `${param.category}.${param.field}`;
  if (params[composite]) return params[composite];
  return null;
}

function renderParamHelpPanel(param) {
  const help = lookupParamHelp(param);
  const manualHome = paramHelpCache?.manualHome || DISTECH_DOCS;
  const label = `${param.category} · ${param.field}`;

  if (!help) {
    editorHelp.innerHTML = `
      <h3>${escapeHtml(param.name)}</h3>
      <p class="help-label">${escapeHtml(label)}</p>
      <p class="help-path">No mapped description yet. Search this point in EC-gfxProgram or the Distech docs.</p>
      <div class="help-links">
        <a href="${manualHome}" target="_blank" rel="noopener noreferrer">EC-gfxProgram constants guide</a>
      </div>`;
    return;
  }

  const title = help.label ? `<p class="help-label">${escapeHtml(help.label)}</p>` : "";
  const notes = (help.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join("");
  const notesBlock = notes ? `<ul class="help-notes">${notes}</ul>` : "";
  const docUrl = help.manualUrl || manualHome;
  editorHelp.innerHTML = `
    <h3>${escapeHtml(param.name)}</h3>
    ${title}
    <p class="help-path">${escapeHtml(label)}${param.controller_specific === "1" ? " · Controller specific" : ""}</p>
    ${notesBlock}
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
  const categories = [...new Set(appState.parameters.map((p) => p.category))].sort();
  categoryFilter.innerHTML = '<option value="">All categories</option>';
  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    categoryFilter.appendChild(option);
  });
}

function getEditorRows() {
  const query = paramSearch.value.trim().toLowerCase();
  const category = categoryFilter.value;
  const showAll = showAllParams.checked;

  return appState.parameters.filter((param) => {
    if (!showAll && !isDefaultCategory(param.category)) return false;
    if (category && param.category !== category) return false;
    if (!query) return true;
    const haystack = `${param.name} ${param.category} ${param.field}`.toLowerCase();
    if (haystack.includes(query)) return true;
    const help = lookupParamHelp(param);
    return Boolean(help?.label && help.label.toLowerCase().includes(query));
  });
}

function updateEditorMeta(count) {
  const manual = appState.manualEdits.size;
  editorMeta.textContent = `Showing ${count} parameter${count === 1 ? "" : "s"} · ${appState.parameters.length} total · ${manual} manual edit${manual === 1 ? "" : "s"}`;
}

function renderEditorList() {
  const rows = getEditorRows();
  editorList.innerHTML = "";

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "editor-empty";
    const msg = document.createElement("p");
    msg.textContent = paramSearch.value.trim()
      ? "No parameters match your search."
      : "No parameters in this view. Try Show all parameters.";
    empty.appendChild(msg);
    if (!showAllParams.checked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Show all parameters";
      btn.addEventListener("click", () => {
        showAllParams.checked = true;
        renderEditorList();
      });
      empty.appendChild(btn);
    }
    editorList.appendChild(empty);
    updateEditorMeta(0);
    return;
  }

  const fragment = document.createDocumentFragment();
  const limit = 500;
  const visible = rows.slice(0, limit);

  visible.forEach((param) => {
    const key = GfxCore.paramKey(param.source, param.category, param.name, param.field);
    const row = document.createElement("div");
    row.className = `param-row${appState.manualEdits.has(key) ? " manual-edit" : ""}`;

    const keyEl = document.createElement("div");
    keyEl.className = "param-key";
    keyEl.textContent = `${param.name} (${param.field})`;
    keyEl.title = `${param.category} · ${param.source}`;

    const input = document.createElement("input");
    input.type = "text";
    input.value = param.value;
    input.addEventListener("focus", () => selectParamRow(row, param));
    input.addEventListener("change", () => {
      setParameterValue(key, input.value);
      row.classList.toggle("manual-edit", appState.manualEdits.has(key));
      updateEditorMeta(getEditorRows().length);
    });

    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "param-info-btn";
    infoBtn.textContent = "Info";
    infoBtn.addEventListener("click", () => selectParamRow(row, param));

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "param-reset";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => {
      const original = appState.originalSnapshot.get(key);
      if (original === undefined) return;
      setParameterValue(key, original);
      input.value = original;
      row.classList.toggle("manual-edit", appState.manualEdits.has(key));
      updateEditorMeta(getEditorRows().length);
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
    renderEditorList();
  });
}

async function openEditor() {
  if (!appState.archive) {
    log("Load a .gfx file first.");
    return;
  }
  await loadParamHelp();
  paramSearch.value = "";
  categoryFilter.value = "";
  showAllParams.checked = false;
  editorHelp.innerHTML =
    '<p class="editor-help-placeholder">Click a parameter or <strong>Info</strong> for EC-gfxProgram notes.</p>';
  editorBackdrop.hidden = false;
  editorBackdrop.removeAttribute("aria-hidden");
  document.body.style.overflow = "hidden";
  renderEditorList();
  paramSearch.focus();
}

function closeEditor() {
  editorBackdrop.hidden = true;
  editorBackdrop.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  closeAdminDropdown();
}

function openAdminDropdown() {
  adminDropdown.hidden = false;
  adminMenuBtn.setAttribute("aria-expanded", "true");
}

function closeAdminDropdown() {
  adminDropdown.hidden = true;
  adminMenuBtn.setAttribute("aria-expanded", "false");
}

function outputFileName() {
  if (!appState.fileName) return "modified.gfx";
  const stem = appState.fileName.replace(/\.gfx$/i, "");
  return `${stem}_modified.gfx`;
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

async function triggerDownload() {
  if (!appState.archive) {
    log("Nothing to download. Load a .gfx file first.");
    return;
  }

  loadBtn.disabled = true;
  downloadBtn.disabled = true;
  try {
    const { blob, changed } = await GfxCore.buildModifiedGfx(appState.archive, appState.parameters);
    const filename = outputFileName();
    downloadBlob(blob, filename);
    log(`Downloaded ${filename} (${changed.length} XML change${changed.length === 1 ? "" : "s"}).`);
    if (changed.length) {
      changed.slice(0, 25).forEach((line) => log(`  - ${line}`));
      if (changed.length > 25) log(`  - ... and ${changed.length - 25} more`);
    }
    log("Import the file in EC-gfxProgram and verify before downloading to a controller.");
  } catch (error) {
    log(`Error: ${error.message}`);
  } finally {
    loadBtn.disabled = false;
    downloadBtn.disabled = false;
  }
}

function exportCsv() {
  if (!appState.parameters.length) {
    log("Load a .gfx file first.");
    return;
  }
  const csv = GfxCore.parametersToCsv(appState.parameters);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const stem = appState.fileName ? appState.fileName.replace(/\.gfx$/i, "") : "parameters";
  downloadBlob(blob, `${stem}_parameters.csv`);
  log(`Exported ${appState.parameters.length} parameters to CSV.`);
  closeAdminDropdown();
}

document.getElementById("adminMenu").addEventListener("click", (e) => e.stopPropagation());

adminMenuBtn.addEventListener("click", () => {
  if (adminMenuBtn.disabled) return;
  if (adminDropdown.hidden) openAdminDropdown();
  else closeAdminDropdown();
});

openEditorBtn.addEventListener("click", () => {
  closeAdminDropdown();
  openEditor();
});

exportCsvBtn.addEventListener("click", exportCsv);
closeEditorBtn.addEventListener("click", closeEditor);
editorCloseFooterBtn.addEventListener("click", closeEditor);
editorDownloadBtn.addEventListener("click", async () => {
  await triggerDownload();
  closeEditor();
});

downloadBtn.addEventListener("click", triggerDownload);

document.querySelector(".editor-panel")?.addEventListener("click", (e) => e.stopPropagation());
editorBackdrop.addEventListener("click", (e) => {
  if (e.target === editorBackdrop) closeEditor();
});
document.addEventListener("click", () => closeAdminDropdown());

paramSearch.addEventListener("input", scheduleEditorRender);
categoryFilter.addEventListener("change", scheduleEditorRender);
showAllParams.addEventListener("change", scheduleEditorRender);
document.querySelectorAll('input[name="defaultCategories"]').forEach((el) => {
  el.addEventListener("change", () => {
    if (!editorBackdrop.hidden) scheduleEditorRender();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !editorBackdrop.hidden) closeEditor();
});

gfxInput.addEventListener("change", resetState);

loadBtn.addEventListener("click", async () => {
  clearLog();
  if (!gfxInput.files || !gfxInput.files[0]) {
    log("Please choose a .gfx file.");
    return;
  }

  loadBtn.disabled = true;
  try {
    const file = gfxInput.files[0];
    const buffer = await file.arrayBuffer();
    const archive = await GfxCore.loadGfxArchive(buffer);

    appState.fileName = file.name;
    appState.projectName = archive.projectName;
    appState.archive = {
      originalBuffer: buffer,
      mainXmlText: archive.mainXmlText,
      comConfigText: archive.comConfigText,
    };
    appState.parameters = GfxCore.cloneParameters(archive.parameters);
    appState.originalSnapshot = snapshotParameters(appState.parameters);
    appState.manualEdits = new Set();

    populateCategoryFilter();
    adminMenuBtn.disabled = false;
    downloadBtn.disabled = false;
    readyHint.hidden = false;

    const analogCount = appState.parameters.filter((p) => p.category === "AnalogValue").length;
    const hardwareCount = appState.parameters.filter((p) => p.category === "HardwareInput").length;

    log(`App version: ${APP_VERSION}`);
    log(`File: ${file.name}`);
    if (archive.projectName) log(`Project: ${archive.projectName}`);
    log(`Parameters found: ${appState.parameters.length}`);
    log(`  Analog setpoints: ${analogCount}`);
    log(`  Hardware inputs: ${hardwareCount}`);
    log("Ready. Use Admin → Edit parameters, then Download .gfx.");
  } catch (error) {
    log(`Error: ${error.message}`);
    resetState();
  } finally {
    loadBtn.disabled = false;
  }
});
