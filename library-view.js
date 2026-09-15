const LIBRARY_STORAGE_PREFIX = "distechGfxLibrary_";

const libSubtitle = document.getElementById("libSubtitle");
const libStats = document.getElementById("libStats");
const libSearch = document.getElementById("libSearch");
const showUnmatched = document.getElementById("showUnmatched");
const matchList = document.getElementById("matchList");
const detailPanel = document.getElementById("detailPanel");
const libEmpty = document.getElementById("libEmpty");
const printBtn = document.getElementById("printBtn");
const closeBtn = document.getElementById("closeBtn");

let payload = null;
let selectedKey = "";

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadPayload() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("key") || `${LIBRARY_STORAGE_PREFIX}latest`;
  const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getRows() {
  const query = libSearch.value.trim().toLowerCase();
  const rows = [...(payload.report?.matches || [])];
  if (showUnmatched.checked) {
    for (const entry of payload.report?.unmatched || []) {
      rows.push({
        projectName: entry.name,
        projectSheet: entry.sheet,
        projectKind: entry.kind,
        unmatched: true,
        library: null,
      });
    }
  }
  return rows.filter((row) => {
    if (!query) return true;
    const hay = [
      row.projectName,
      row.projectSheet,
      row.library?.title,
      row.library?.path,
      row.library?.description,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(query);
  });
}

function renderList() {
  const rows = getRows();
  libEmpty.hidden = rows.length > 0;
  matchList.innerHTML = rows
    .map((row) => {
      const key = row.projectName;
      const selected = key === selectedKey ? " selected" : "";
      if (row.unmatched) {
        return `<button type="button" class="lib-card${selected}" data-key="${escapeHtml(key)}">
          <strong>${escapeHtml(row.projectName)}</strong>
          <small>No Library/.sptx match · ${escapeHtml(row.projectSheet || "project module")}</small>
        </button>`;
      }
      return `<button type="button" class="lib-card${selected}" data-key="${escapeHtml(key)}">
        <strong>${escapeHtml(row.projectName)}</strong>
        <small>Used on ${escapeHtml(row.projectSheet || "—")} · matches <em>${escapeHtml(row.library.path)}</em></small>
      </button>`;
    })
    .join("");

  const report = payload.report || {};
  libStats.textContent = `${report.matchCount || 0} matched · ${report.unmatchedCount || 0} unmatched · catalog ${report.catalogSize || 0} snippets`;
}

function renderDetail(row) {
  if (!row || row.unmatched || !row.library) {
    detailPanel.hidden = true;
    detailPanel.innerHTML = "";
    return;
  }
  const lib = row.library;
  const inputs = (lib.inputs || []).map((port) => `<li>${escapeHtml(port)}</li>`).join("") || "<li>None exported</li>";
  const outputs = (lib.outputs || []).map((port) => `<li>${escapeHtml(port)}</li>`).join("") || "<li>None exported</li>";
  const tags = (lib.tags || [])
    .map((tag) => `<li>${tag.kind === "in" ? "Reads" : "Defines"} <strong>${escapeHtml(tag.tagName)}</strong></li>`)
    .join("") || "<li>No reference tags</li>";
  const blocks = Object.entries(lib.blockSummary || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, count]) => `<li>${escapeHtml(tag)} × ${count}</li>`)
    .join("") || "<li>—</li>";
  const named = (lib.namedBlocks || [])
    .slice(0, 20)
    .map((block) => `<li>${escapeHtml(block.name)} <small>(${escapeHtml(block.tag)})</small></li>`)
    .join("") || "<li>—</li>";

  detailPanel.hidden = false;
  detailPanel.innerHTML = `
    <h2>${escapeHtml(row.projectName)}</h2>
    <p><strong>Library file:</strong> ${escapeHtml(lib.source)} / ${escapeHtml(lib.path)}</p>
    <p>${escapeHtml(lib.description || "")}</p>
    <p><strong>Used in project as:</strong> ${escapeHtml(row.projectKind)} on sheet ${escapeHtml(row.projectSheet || "—")}</p>
    <div class="lib-columns">
      <div><h3>Inputs</h3><ul>${inputs}</ul></div>
      <div><h3>Outputs</h3><ul>${outputs}</ul></div>
      <div><h3>Reference tags</h3><ul>${tags}</ul></div>
      <div><h3>Internal block types</h3><ul>${blocks}</ul></div>
      <div><h3>Named internals</h3><ul>${named}</ul></div>
    </div>`;
}

function init() {
  payload = loadPayload();
  if (!payload?.report) {
    document.body.innerHTML =
      '<main style="padding:2rem;font-family:sans-serif;max-width:40rem"><h1>No library data</h1><p>Load a .gfx and a Library folder in the main editor, then open Library match again.</p></main>';
    return;
  }

  libSubtitle.textContent = `${payload.projectName || payload.fileName || "GFX project"} · ${payload.report.catalogSize} library snippets indexed`;
  selectedKey = payload.report.matches?.[0]?.projectName || "";
  renderList();
  renderDetail(getRows().find((row) => row.projectName === selectedKey));

  matchList.addEventListener("click", (event) => {
    const card = event.target.closest(".lib-card");
    if (!card) return;
    selectedKey = card.dataset.key || "";
    renderList();
    renderDetail(getRows().find((row) => row.projectName === selectedKey));
  });
  libSearch.addEventListener("input", () => {
    renderList();
    renderDetail(getRows().find((row) => row.projectName === selectedKey) || getRows()[0]);
  });
  showUnmatched.addEventListener("change", () => {
    renderList();
  });
  printBtn.addEventListener("click", () => window.print());
  closeBtn.addEventListener("click", () => window.close());
}

init();
