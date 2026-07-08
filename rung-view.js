const WIRING_STORAGE_PREFIX = "distechGfxWiring_";
const RUNG_VIEW_VERSION = "1.10.0";

const rungTitle = document.getElementById("rungTitle");
const rungSubtitle = document.getElementById("rungSubtitle");
const rungStats = document.getElementById("rungStats");
const sheetPicker = document.getElementById("sheetPicker");
const openSheetTabBtn = document.getElementById("openSheetTabBtn");
const rungCanvas = document.getElementById("rungCanvas");
const rungEmpty = document.getElementById("rungEmpty");
const printTitle = document.getElementById("printTitle");
const printMeta = document.getElementById("printMeta");
const printBtn = document.getElementById("printBtn");
const closeBtn = document.getElementById("closeBtn");

let payload = null;
let currentDocId = "";

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageParams() {
  return new URLSearchParams(window.location.search);
}

async function loadPayload() {
  const params = pageParams();
  const storageKey = params.get("key") || "";
  const preferIdb = params.get("store") === "idb";
  const gfx = window.GfxCore;
  if (gfx?.loadWiringViewerPayload) {
    return gfx.loadWiringViewerPayload(storageKey, WIRING_STORAGE_PREFIX, preferIdb);
  }
  return null;
}

function getSheet(docId) {
  return (payload?.wiring?.sheetDiagrams || []).find((sheet) => sheet.docId === docId) || null;
}

function buildRungUrl(docId) {
  const params = pageParams();
  const key = params.get("key") || "";
  const store = params.get("store") || "";
  const query = new URLSearchParams();
  query.set("v", RUNG_VIEW_VERSION);
  if (key) query.set("key", key);
  if (store) query.set("store", store);
  if (docId) query.set("sheet", docId);
  return `rung-view.html?${query.toString()}`;
}

function renderRungs(docId) {
  currentDocId = docId;
  const sheet = getSheet(docId);
  if (!sheet) {
    rungCanvas.innerHTML = "";
    rungEmpty.hidden = false;
    rungStats.textContent = "Sheet not found.";
    return;
  }

  const layout = window.GfxCore.buildSheetRungs(sheet);
  rungEmpty.hidden = layout.rungs.length > 0;
  rungTitle.textContent = `Rung view — ${layout.sheetName}`;
  rungSubtitle.textContent = payload.projectName || payload.fileName || "GFX project";
  printTitle.textContent = `Rung view — ${layout.sheetName}`;
  printMeta.textContent = `${layout.rungCount} rungs · ${layout.blockCount} blocks · ${layout.linkCount} wires`;

  rungStats.textContent = `${layout.rungCount} rungs (rows 1–${layout.rungCount}) · ${layout.blockCount} blocks · ${layout.linkCount} local wires${
    layout.orphanCount ? ` · ${layout.orphanCount} single-block rows` : ""
  }`;

  rungCanvas.innerHTML = layout.rungs
    .map((rung) => {
      const steps = rung.steps
        .map((step, index) => {
          const portHint =
            step.inPort || step.outPort
              ? `<small>${escapeHtml(step.inPort ? `in ${step.inPort}` : "")}${step.inPort && step.outPort ? " · " : ""}${step.outPort ? `out ${step.outPort}` : ""}</small>`
              : "";
          const block = `
            <div class="rung-block cat-${escapeHtml(step.category || "logic")}">
              <strong>${escapeHtml(step.title)}</strong>
              <small>${escapeHtml(step.subtitle)}</small>
              ${portHint}
            </div>`;
          return index === 0 ? block : `<span class="rung-wire" aria-hidden="true">→</span>${block}`;
        })
        .join("");

      return `
        <div class="rung-row${rung.orphan ? " orphan" : ""}" data-rung="${rung.number}">
          <div class="rung-num">${rung.number}</div>
          <div class="rung-rail" aria-hidden="true"></div>
          <div class="rung-steps">${steps}</div>
          <div class="rung-rail" aria-hidden="true"></div>
        </div>`;
    })
    .join("");
}

function populateSheetPicker(selectedDocId) {
  sheetPicker.innerHTML = "";
  for (const sheet of payload.wiring.sheetDiagrams || []) {
    const option = document.createElement("option");
    option.value = sheet.docId;
    option.textContent = `${sheet.name} (${sheet.blockCount} blocks)`;
    sheetPicker.appendChild(option);
  }
  if (selectedDocId) sheetPicker.value = selectedDocId;
}

async function init() {
  payload = await loadPayload();
  if (!payload?.wiring) {
    document.body.innerHTML =
      '<main style="padding:2rem;font-family:sans-serif;max-width:40rem"><h1>No logic data</h1><p>Open the wiring viewer from the main editor first, then click <strong>Open rung view</strong> on a sheet.</p></main>';
    return;
  }

  const params = pageParams();
  let docId = params.get("sheet") || "";
  if (!docId && payload.wiring.sheetDiagrams?.length) {
    docId = payload.wiring.sheetDiagrams[0].docId;
  }

  populateSheetPicker(docId);
  renderRungs(docId);

  sheetPicker.addEventListener("change", () => {
    renderRungs(sheetPicker.value);
    const url = buildRungUrl(sheetPicker.value);
    window.history.replaceState({}, "", url);
  });

  openSheetTabBtn.addEventListener("click", () => {
    const docId = sheetPicker.value;
    if (!docId) return;
    window.open(buildRungUrl(docId), "_blank");
  });

  printBtn.addEventListener("click", () => window.print());
  closeBtn.addEventListener("click", () => window.close());
}

init();
