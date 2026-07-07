const WIRING_STORAGE_PREFIX = "distechGfxWiring_";

const wiringSubtitle = document.getElementById("wiringSubtitle");
const wiringStats = document.getElementById("wiringStats");
const printTitle = document.getElementById("printTitle");
const printMeta = document.getElementById("printMeta");
const wireSearch = document.getElementById("wireSearch");
const compositeFilter = document.getElementById("compositeFilter");
const tagFilter = document.getElementById("tagFilter");
const focusBlock = document.getElementById("focusBlock");
const diagramOnly = document.getElementById("diagramOnly");
const focusDiagram = document.getElementById("focusDiagram");
const wiringTable = document.getElementById("wiringTable");
const wiringTableBody = document.getElementById("wiringTableBody");
const wiringEmpty = document.getElementById("wiringEmpty");
const printBtn = document.getElementById("printBtn");
const closeBtn = document.getElementById("closeBtn");

let payload = null;

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
    : [WIRING_STORAGE_PREFIX + "latest", "distechGfxWiring"];

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

function linkMatchesSearch(link, query) {
  if (!query) return true;
  const haystack = [
    link.from.label,
    link.from.tag,
    link.from.port,
    link.to.label,
    link.to.tag,
    link.to.port,
    link.id,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function linkMatchesComposite(link, compositeId) {
  if (!compositeId) return true;
  return link.from.id === compositeId || link.to.id === compositeId;
}

function linkMatchesTag(link, tag) {
  if (!tag) return true;
  return link.from.tag === tag || link.to.tag === tag;
}

function linkMatchesFocus(link, focusId) {
  if (!focusId) return true;
  return link.from.id === focusId || link.to.id === focusId;
}

function getFilteredLinks() {
  const query = wireSearch.value.trim().toLowerCase();
  const compositeId = compositeFilter.value;
  const tag = tagFilter.value;
  const focusId = focusBlock.value;

  return payload.wiring.links.filter((link) => {
    if (!linkMatchesSearch(link, query)) return false;
    if (!linkMatchesComposite(link, compositeId)) return false;
    if (!linkMatchesTag(link, tag)) return false;
    if (focusId && !linkMatchesFocus(link, focusId)) return false;
    return true;
  });
}

function renderDiagram(links, focusId) {
  if (!focusId || links.length === 0) {
    focusDiagram.hidden = true;
    focusDiagram.innerHTML = "";
    return;
  }

  const focusLabel = payload.wiring.focusOptions.find((b) => b.id === focusId)?.label || focusId;
  const incoming = links.filter((l) => l.to.id === focusId);
  const outgoing = links.filter((l) => l.from.id === focusId);
  const rows = [];

  for (const link of incoming) {
    rows.push({ from: link.from, to: link.to, direction: "in" });
  }
  for (const link of outgoing) {
    if (incoming.some((l) => l.id === link.id)) continue;
    rows.push({ from: link.from, to: link.to, direction: "out" });
  }
  for (const link of links) {
    if (link.from.id !== focusId && link.to.id !== focusId) {
      rows.push({ from: link.from, to: link.to, direction: "via" });
    }
  }

  const maxDiagram = 80;
  const slice = rows.slice(0, maxDiagram);
  const more = rows.length - slice.length;

  focusDiagram.hidden = false;
  focusDiagram.innerHTML = `
    <h2>Focused: ${escapeHtml(focusLabel)}</h2>
    ${slice
      .map(
        (row) => `
      <div class="wire-flow">
        <div class="wire-node from">
          <strong>${escapeHtml(row.from.label)}</strong>
          <small>${escapeHtml(row.from.tag)} · ${escapeHtml(row.from.port || "—")}</small>
        </div>
        <div class="wire-arrow" aria-hidden="true">→</div>
        <div class="wire-node to">
          <strong>${escapeHtml(row.to.label)}</strong>
          <small>${escapeHtml(row.to.tag)} · ${escapeHtml(row.to.port || "—")}</small>
        </div>
      </div>`,
      )
      .join("")}
    ${more > 0 ? `<p class="wiring-stats">${more} more connection(s) not shown in diagram — see table below or narrow filters.</p>` : ""}`;
}

function renderTable(links) {
  wiringTableBody.innerHTML = links
    .map(
      (link, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(link.from.label)}<br><small>${escapeHtml(link.from.tag)}</small></td>
      <td>${escapeHtml(link.from.port || "—")}</td>
      <td class="arrow-col">→</td>
      <td>${escapeHtml(link.to.label)}<br><small>${escapeHtml(link.to.tag)}</small></td>
      <td>${escapeHtml(link.to.port || "—")}</td>
    </tr>`,
    )
    .join("");

  wiringEmpty.hidden = links.length > 0;
  wiringTable.hidden = links.length === 0;
}

function render() {
  const focusId = focusBlock.value;
  const links = getFilteredLinks();
  const showDiagram = Boolean(focusId) && links.length > 0;

  if (showDiagram) {
    renderDiagram(links, focusId);
  } else {
    focusDiagram.hidden = true;
    focusDiagram.innerHTML = "";
  }

  if (!diagramOnly.checked || !focusId) {
    renderTable(links);
  } else {
    wiringTable.hidden = true;
    wiringEmpty.hidden = true;
  }

  wiringStats.textContent = `Showing ${links.length} of ${payload.wiring.linkCount} connections · ${payload.wiring.blockCount} blocks · ${payload.wiring.compositeCount} logic modules`;
}

function populateFilters() {
  for (const composite of payload.wiring.composites) {
    const option = document.createElement("option");
    option.value = composite.id;
    option.textContent = composite.name;
    compositeFilter.appendChild(option);
  }
  for (const tag of payload.wiring.blockTypes) {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = tag;
    tagFilter.appendChild(option);
  }
  for (const block of payload.wiring.focusOptions) {
    const option = document.createElement("option");
    option.value = block.id;
    option.textContent = block.label;
    focusBlock.appendChild(option);
  }
  if (payload.focusBlockId) {
    focusBlock.value = payload.focusBlockId;
    diagramOnly.checked = true;
  }
}

function init() {
  payload = loadPayload();
  if (!payload?.wiring) {
    document.body.innerHTML =
      '<main style="padding:2rem;font-family:sans-serif;max-width:40rem"><h1>No wiring data</h1><p>Load a .gfx template in the main editor, then click <strong>Open wiring viewer</strong> again.</p><p>If you opened this page directly, go back to the editor first.</p></main>';
    return;
  }

  const title = payload.projectName || payload.fileName || "GFX project";
  document.title = `Wiring — ${title}`;
  wiringSubtitle.textContent = `${title} · read-only`;
  printTitle.textContent = `Logic wiring — ${title}`;
  printMeta.textContent = `Exported ${new Date(payload.exportedAt).toLocaleString()} · ${payload.wiring.linkCount} connections`;

  populateFilters();
  render();

  wireSearch.addEventListener("input", render);
  compositeFilter.addEventListener("change", render);
  tagFilter.addEventListener("change", render);
  focusBlock.addEventListener("change", () => {
    if (focusBlock.value) diagramOnly.checked = true;
    render();
  });
  diagramOnly.addEventListener("change", render);
  printBtn.addEventListener("click", () => window.print());
  closeBtn.addEventListener("click", () => window.close());
}

init();
