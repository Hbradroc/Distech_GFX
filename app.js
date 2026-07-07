const APP_VERSION = "1.3.0";
const PARAM_HELP_PATH = `./param_help.json?v=${APP_VERSION}`;
const DISTECH_DOCS = "https://docs.distech-controls.com/bundle/gfx_UG/page/en-US/845626251.html";

const gfxInput = document.getElementById("gfxFile");
const loadBtn = document.getElementById("loadBtn");
const generateBtn = document.getElementById("generateBtn");
const generateBtnInline = document.getElementById("generateBtnInline");
const exportCsvBtn = document.getElementById("exportCsvBtn");
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

function resetState() {
  appState.fileName = "";
  appState.projectName = "";
  appState.archive = null;
  appState.parameters = [];
  appState.originalSnapshot = new Map();
  appState.manualEdits = new Set();
  generateBtn.disabled = true;
  exportCsvBtn.disabled = true;
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
    editorHelp.innerHTML = `
      <h3>${escapeHtml(param.name)}</h3>
      <p class="help-label">${escapeHtml(label)}</p>
      ${feeds}
      ${extra}
      <p class="help-path">No mapped description in param_help.json yet.</p>
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
    input.value = param.value;

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
