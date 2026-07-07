const WIRING_STORAGE_PREFIX = "distechGfxWiring_";

const wiringSubtitle = document.getElementById("wiringSubtitle");
const wiringStats = document.getElementById("wiringStats");
const printTitle = document.getElementById("printTitle");
const printMeta = document.getElementById("printMeta");
const tabCrossRef = document.getElementById("tabCrossRef");
const tabWiring = document.getElementById("tabWiring");
const crossRefPanel = document.getElementById("crossRefPanel");
const wiringPanel = document.getElementById("wiringPanel");
const xrefSearch = document.getElementById("xrefSearch");
const xrefSheetFilter = document.getElementById("xrefSheetFilter");
const xrefFocus = document.getElementById("xrefFocus");
const xrefTable = document.getElementById("xrefTable");
const xrefTableBody = document.getElementById("xrefTableBody");
const xrefEmpty = document.getElementById("xrefEmpty");
const wireSearch = document.getElementById("wireSearch");
const compositeFilter = document.getElementById("compositeFilter");
const tagFilter = document.getElementById("tagFilter");
const focusBlock = document.getElementById("focusBlock");
const focusDiagram = document.getElementById("focusDiagram");
const wiringTable = document.getElementById("wiringTable");
const wiringTableBody = document.getElementById("wiringTableBody");
const wiringEmpty = document.getElementById("wiringEmpty");
const printBtn = document.getElementById("printBtn");
const closeBtn = document.getElementById("closeBtn");

let payload = null;
let activeTab = "xref";
let selectedXrefTag = "";

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadPayload() {
  const params = new URLSearchParams(window.location.search);
  const storageKey = params.get("key") || "";
  const keysToTry = storageKey
    ? [storageKey]
    : [`${WIRING_STORAGE_PREFIX}latest`, "distechGfxWiring"];

  for (const key of keysToTry) {
    const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }
  return null;
}

function formatSites(entries) {
  if (!entries?.length) return "—";
  return entries.map((entry) => `${entry.sheet}`).join(", ");
}

function xrefMatchesSheet(row, sheet) {
  if (!sheet) return true;
  const inHubs = row.hubs.some((hub) => hub.sheet === sheet);
  const inTargets = row.targets.some((target) => target.sheet === sheet);
  return inHubs || inTargets;
}

function getFilteredCrossRefs() {
  const query = xrefSearch.value.trim().toLowerCase();
  const sheet = xrefSheetFilter.value;
  const rows = payload.wiring.crossReferences || [];
  return rows.filter((row) => {
    if (query && !row.tagName.toLowerCase().includes(query)) return false;
    if (!xrefMatchesSheet(row, sheet)) return false;
    return true;
  });
}

function renderXrefFocus(row) {
  if (!row) {
    xrefFocus.hidden = true;
    xrefFocus.innerHTML = "";
    return;
  }
  xrefFocus.hidden = false;
  const hubLines = row.hubs
    .map((hub) => `<li><strong>${escapeHtml(hub.sheet)}</strong> · ${escapeHtml(hub.role)}</li>`)
    .join("");
  const targetLines = row.targets
    .map((target) => `<li><strong>${escapeHtml(target.sheet)}</strong> · ${escapeHtml(target.role)}</li>`)
    .join("");
  xrefFocus.innerHTML = `
    <h2>Tag: ${escapeHtml(row.tagName)}</h2>
    <div class="xref-focus-grid">
      <div>
        <h3>Defined on (Reference Hub)</h3>
        <ul>${hubLines || "<li>Not found as a hub in this project</li>"}</ul>
      </div>
      <div>
        <h3>Used on (Reference Target)</h3>
        <ul>${targetLines || "<li>Not referenced elsewhere in this project</li>"}</ul>
      </div>
    </div>`;
}

function renderCrossRefTable() {
  const rows = getFilteredCrossRefs();
  xrefTableBody.innerHTML = rows
    .map((row) => {
      const selected = row.tagName === selectedXrefTag ? " selected" : "";
      return `
      <tr class="xref-row${selected}" data-tag="${escapeHtml(row.tagName)}">
        <td><strong>${escapeHtml(row.tagName)}</strong></td>
        <td>${escapeHtml(formatSites(row.hubs))}</td>
        <td>${escapeHtml(formatSites(row.targets))}</td>
      </tr>`;
    })
    .join("");
  xrefEmpty.hidden = rows.length > 0;
  xrefTable.hidden = rows.length === 0;
  const focusRow = rows.find((row) => row.tagName === selectedXrefTag) || rows[0];
  if (focusRow && !selectedXrefTag) selectedXrefTag = focusRow.tagName;
  renderXrefFocus(rows.find((row) => row.tagName === selectedXrefTag) || null);
}

function linkMatchesSearch(link, query) {
  if (!query) return true;
  const haystack = [
    link.from.label,
    link.from.tag,
    link.from.port,
    link.from.sheet,
    link.to.label,
    link.to.tag,
    link.to.port,
    link.to.sheet,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function getFilteredLinks() {
  const query = wireSearch.value.trim().toLowerCase();
  const compositeId = compositeFilter.value;
  const tag = tagFilter.value;
  const focusId = focusBlock.value;
  return (payload.wiring.links || []).filter((link) => {
    if (!linkMatchesSearch(link, query)) return false;
    if (compositeId && link.from.id !== compositeId && link.to.id !== compositeId) return false;
    if (tag && link.from.tag !== tag && link.to.tag !== tag) return false;
    if (focusId && link.from.id !== focusId && link.to.id !== focusId) return false;
    return true;
  });
}

function renderWiringDiagram(links, focusId) {
  if (!focusId || links.length === 0) {
    focusDiagram.hidden = true;
    focusDiagram.innerHTML = "";
    return;
  }
  const focusLabel = payload.wiring.focusOptions.find((b) => b.id === focusId)?.label || focusId;
  const slice = links.slice(0, 60);
  focusDiagram.hidden = false;
  focusDiagram.innerHTML = `
    <h2>Block: ${escapeHtml(focusLabel)}</h2>
    ${slice
      .map(
        (link) => `
      <div class="wire-flow">
        <div class="wire-node from">
          <strong>${escapeHtml(link.from.label)}</strong>
          <small>${escapeHtml(link.from.sheet || "—")} · ${escapeHtml(link.from.port || "—")}</small>
        </div>
        <div class="wire-arrow" aria-hidden="true">→</div>
        <div class="wire-node to">
          <strong>${escapeHtml(link.to.label)}</strong>
          <small>${escapeHtml(link.to.sheet || "—")} · ${escapeHtml(link.to.port || "—")}</small>
        </div>
      </div>`,
      )
      .join("")}
    ${links.length > slice.length ? `<p class="wiring-stats">${links.length - slice.length} more connections in the table below.</p>` : ""}`;
}

function renderWiringTable() {
  const links = getFilteredLinks();
  wiringTableBody.innerHTML = links
    .map(
      (link, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(link.from.label)}<br><small>${escapeHtml(link.from.sheet || "—")}</small></td>
      <td>${escapeHtml(link.from.port || "—")}</td>
      <td class="arrow-col">→</td>
      <td>${escapeHtml(link.to.label)}<br><small>${escapeHtml(link.to.sheet || "—")}</small></td>
      <td>${escapeHtml(link.to.port || "—")}</td>
    </tr>`,
    )
    .join("");
  wiringEmpty.hidden = links.length > 0;
  wiringTable.hidden = links.length === 0;
  if (focusBlock.value) renderWiringDiagram(links, focusBlock.value);
  else {
    focusDiagram.hidden = true;
    focusDiagram.innerHTML = "";
  }
}

function setActiveTab(tab) {
  activeTab = tab;
  const isXref = tab === "xref";
  tabCrossRef.classList.toggle("active", isXref);
  tabWiring.classList.toggle("active", !isXref);
  tabCrossRef.setAttribute("aria-selected", String(isXref));
  tabWiring.setAttribute("aria-selected", String(!isXref));
  crossRefPanel.hidden = !isXref;
  wiringPanel.hidden = isXref;
  renderStats();
}

function renderStats() {
  const w = payload.wiring;
  if (activeTab === "xref") {
    const shown = getFilteredCrossRefs().length;
    wiringStats.textContent = `Showing ${shown} of ${w.crossRefCount || 0} tags · ${w.hubCount || 0} hubs · ${w.targetCount || 0} targets across ${(w.sheets || []).length} sheets`;
  } else {
    const shown = getFilteredLinks().length;
    wiringStats.textContent = `Showing ${shown} of ${w.linkCount} local wire connections · ${w.compositeCount} logic modules`;
  }
}

function render() {
  if (activeTab === "xref") {
    renderCrossRefTable();
  } else {
    renderWiringTable();
  }
  renderStats();
}

function populateFilters() {
  for (const sheet of payload.wiring.sheets || []) {
    const option = document.createElement("option");
    option.value = sheet;
    option.textContent = sheet;
    xrefSheetFilter.appendChild(option);
  }
  for (const composite of payload.wiring.composites || []) {
    const option = document.createElement("option");
    option.value = composite.id;
    option.textContent = composite.sheet ? `${composite.name} (${composite.sheet})` : composite.name;
    compositeFilter.appendChild(option);
  }
  for (const tag of payload.wiring.blockTypes || []) {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = tag;
    tagFilter.appendChild(option);
  }
  for (const block of payload.wiring.focusOptions || []) {
    const option = document.createElement("option");
    option.value = block.id;
    option.textContent = block.label;
    focusBlock.appendChild(option);
  }
  if (payload.focusTagName) {
    xrefSearch.value = payload.focusTagName;
    selectedXrefTag = payload.focusTagName;
    setActiveTab("xref");
  }
  if (payload.focusBlockId) {
    focusBlock.value = payload.focusBlockId;
    setActiveTab("wiring");
  }
}

function init() {
  payload = loadPayload();
  if (!payload?.wiring) {
    document.body.innerHTML =
      '<main style="padding:2rem;font-family:sans-serif;max-width:40rem"><h1>No logic data</h1><p>Load a .gfx template in the main editor, then click <strong>Open wiring viewer</strong> again.</p></main>';
    return;
  }

  const title = payload.projectName || payload.fileName || "GFX project";
  document.title = `Cross-reference — ${title}`;
  wiringSubtitle.textContent = `${title} · like EC-gfxProgram Reference Hub / Target`;
  printTitle.textContent = `Logic cross-reference — ${title}`;
  printMeta.textContent = `Exported ${new Date(payload.exportedAt).toLocaleString()} · ${payload.wiring.crossRefCount || 0} tags · ${payload.wiring.linkCount} wires`;

  populateFilters();
  setActiveTab(payload.focusTagName ? "xref" : "xref");
  render();

  tabCrossRef.addEventListener("click", () => setActiveTab("xref"));
  tabWiring.addEventListener("click", () => setActiveTab("wiring"));
  xrefSearch.addEventListener("input", render);
  xrefSheetFilter.addEventListener("change", render);
  xrefTableBody.addEventListener("click", (event) => {
    const row = event.target.closest(".xref-row");
    if (!row) return;
    selectedXrefTag = row.dataset.tag || "";
    renderCrossRefTable();
  });
  wireSearch.addEventListener("input", render);
  compositeFilter.addEventListener("change", render);
  tagFilter.addEventListener("change", render);
  focusBlock.addEventListener("change", render);
  printBtn.addEventListener("click", () => window.print());
  closeBtn.addEventListener("click", () => window.close());
}

init();
