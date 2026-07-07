const WIRING_STORAGE_PREFIX = "distechGfxWiring_";

const wiringSubtitle = document.getElementById("wiringSubtitle");
const wiringStats = document.getElementById("wiringStats");
const printTitle = document.getElementById("printTitle");
const printMeta = document.getElementById("printMeta");
const tabFlow = document.getElementById("tabFlow");
const tabDiagram = document.getElementById("tabDiagram");
const tabCrossRef = document.getElementById("tabCrossRef");
const tabWiring = document.getElementById("tabWiring");
const flowPanel = document.getElementById("flowPanel");
const diagramPanel = document.getElementById("diagramPanel");
const crossRefPanel = document.getElementById("crossRefPanel");
const wiringPanel = document.getElementById("wiringPanel");
const flowSheet = document.getElementById("flowSheet");
const flowBlock = document.getElementById("flowBlock");
const flowPort = document.getElementById("flowPort");
const flowDiagram = document.getElementById("flowDiagram");
const flowEmpty = document.getElementById("flowEmpty");
const diagramSheet = document.getElementById("diagramSheet");
const diagramSearch = document.getElementById("diagramSearch");
const diagramShowLabels = document.getElementById("diagramShowLabels");
const diagramCanvas = document.getElementById("diagramCanvas");
const diagramFocus = document.getElementById("diagramFocus");
const diagramEmpty = document.getElementById("diagramEmpty");
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
let activeTab = "flow";
let selectedXrefTag = "";
let selectedBlockId = "";
let selectedPortName = "";
let diagramScale = 1;

const core = () => window.GfxCore || {};

const CATEGORY_COLORS = {
  reference: { fill: "#bbf7d0", stroke: "#15803d" },
  bacnet: { fill: "#fed7aa", stroke: "#c2410c" },
  hwout: { fill: "#bfdbfe", stroke: "#1d4ed8" },
  hwin: { fill: "#bfdbfe", stroke: "#1d4ed8" },
  pid: { fill: "#ddd6fe", stroke: "#6d28d9" },
  constant: { fill: "#f3f4f6", stroke: "#6b7280" },
  composite: { fill: "#fde68a", stroke: "#b45309" },
  logic: { fill: "#e9d5ff", stroke: "#7e22ce" },
};

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

function cleanLabel(text, fallback = "") {
  const gfx = core();
  if (gfx.sanitizeDisplayText) return gfx.sanitizeDisplayText(text, fallback);
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 80) return fallback || raw.slice(0, 77);
  return raw;
}

const GENERIC_BLOCK_NAMES = new Set([
  "",
  "Reference Target",
  "Reference Hub",
  "Reference In",
  "Reference Out",
  "Internal Constant",
  "Monitor",
]);

function isGenericBlockName(name) {
  const raw = String(name || "").trim();
  return GENERIC_BLOCK_NAMES.has(raw) || raw.startsWith("LogicConstant#");
}

function friendlyBlockType(tag) {
  const map = {
    IncomingTag: "Reference in",
    OutgoingTag: "Reference out",
    InternalConstantNumeric: "Constant",
    SimpleCompositeBlock: "Logic module",
    And: "And",
    Or: "Or",
    Not: "Not",
    Switch: "Switch",
    Add: "Add",
    Subtract: "Subtract",
    Multiply: "Multiply",
    Divide: "Divide",
    LessThan: "Less than",
    GreaterThan: "Greater than",
    Equal: "Equal",
    Hysteresis: "Hysteresis",
    Ramp: "Ramp",
    PID: "PID",
    JPID: "JPID",
  };
  if (map[tag]) return map[tag];
  if (tag.startsWith("Bacnet")) return tag.replace(/^Bacnet/, "BACnet ");
  if (tag.includes("HardwareOutput")) return "Hardware output";
  if (tag.includes("HardwareInput")) return "Hardware input";
  if (tag.includes("Pid") || tag.includes("JPID")) return "PID";
  return tag.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function blockDisplayLabels(block) {
  const tag = block.tag || "";
  const tagName = cleanLabel(block.tagName, "");
  const name = cleanLabel(block.name, "");
  const typeLabel = friendlyBlockType(tag);

  if (tag === "IncomingTag") {
    const title = tagName || (!isGenericBlockName(name) ? name : "Reference in");
    return {
      title,
      subtitle: tagName ? "From another sheet" : "Reads a shared tag",
      tooltip: tagName
        ? `Reference in: uses the value of "${tagName}" defined elsewhere in the project`
        : "Reference in block — reads a tag value from another programming sheet",
    };
  }

  if (tag === "OutgoingTag") {
    const title = tagName || (!isGenericBlockName(name) ? name : "Reference out");
    return {
      title,
      subtitle: tagName ? "Defined on this sheet" : "Publishes a shared tag",
      tooltip: tagName
        ? `Reference out: defines "${tagName}" here for other sheets to read`
        : "Reference out block — defines a tag other sheets can use",
    };
  }

  if (tag === "InternalConstantNumeric") {
    const title = !isGenericBlockName(name) ? name : `Constant #${block.id}`;
    return {
      title,
      subtitle: "Fixed value",
      tooltip: `Internal constant (${title}) wired into logic on this sheet`,
    };
  }

  if (tag === "SimpleCompositeBlock") {
    return {
      title: name || `Module #${block.id}`,
      subtitle: "Logic module",
      tooltip: name ? `Composite logic module: ${name}` : `Logic module #${block.id}`,
    };
  }

  if (tagName && (isGenericBlockName(name) || name === tag)) {
    return {
      title: tagName,
      subtitle: typeLabel,
      tooltip: `${tagName} · ${typeLabel}`,
    };
  }

  if (!isGenericBlockName(name)) {
    return {
      title: name,
      subtitle: name !== typeLabel ? typeLabel : "",
      tooltip: `${name} · ${typeLabel}`,
    };
  }

  return {
    title: typeLabel || `${tag} #${block.id}`,
    subtitle: "",
    tooltip: `${typeLabel || tag} #${block.id}`,
  };
}

function getSheetDiagramByDocId(docId) {
  return (payload.wiring.sheetDiagrams || []).find((sheet) => sheet.docId === docId) || null;
}

function getSheetDiagramByName(name) {
  return (payload.wiring.sheetDiagrams || []).find((sheet) => sheet.name === name) || null;
}

function blocksOnSheet(docId) {
  const sheet = getSheetDiagramByDocId(docId);
  if (!sheet) return [];
  return [...sheet.blocks].sort((a, b) => cleanLabel(a.name || a.label).localeCompare(cleanLabel(b.name || b.label)));
}

function setFlowSelection(docId, blockId, portName = "") {
  if (docId) flowSheet.value = docId;
  populateFlowBlocks();
  if (blockId) flowBlock.value = blockId;
  populateFlowPorts();
  if (portName) flowPort.value = portName;
  selectedBlockId = flowBlock.value;
  selectedPortName = flowPort.value;
  diagramSheet.value = docId || diagramSheet.value;
}

function populateFlowSheets() {
  for (const sheet of payload.wiring.sheetDiagrams || []) {
    const option = document.createElement("option");
    option.value = sheet.docId;
    option.textContent = `${sheet.name} (${sheet.blockCount} blocks)`;
    flowSheet.appendChild(option);
  }
}

function populateFlowBlocks() {
  const current = flowBlock.value;
  flowBlock.innerHTML = '<option value="">Select block…</option>';
  for (const block of blocksOnSheet(flowSheet.value)) {
    const option = document.createElement("option");
    option.value = block.id;
    option.textContent = blockDisplayLabels(block).title;
    flowBlock.appendChild(option);
  }
  if (current && [...flowBlock.options].some((option) => option.value === current)) {
    flowBlock.value = current;
  }
}

function populateFlowPorts() {
  const blockId = flowBlock.value;
  const docId = flowSheet.value;
  flowPort.innerHTML = '<option value="">All ports on this block</option>';
  if (!blockId) return;
  const ports = core().portsForBlock
    ? core().portsForBlock(payload.wiring, blockId, docId)
    : [];
  for (const port of ports) {
    const option = document.createElement("option");
    option.value = port;
    option.textContent = port;
    flowPort.appendChild(option);
  }
  if (selectedPortName && ports.includes(selectedPortName)) {
    flowPort.value = selectedPortName;
  }
}

function renderEndpoint(endpoint, direction) {
  const sheetBlock = (payload.wiring.sheetDiagrams || [])
    .flatMap((sheet) => sheet.blocks)
    .find((block) => block.id === endpoint.id);
  const display = sheetBlock
    ? blockDisplayLabels(sheetBlock)
    : { title: cleanLabel(endpoint.label, endpoint.tag || "Block"), subtitle: "", tooltip: endpoint.label };
  const label = display.title;
  const hint = display.subtitle || friendlyBlockType(endpoint.tag || "");
  return `
    <button type="button" class="flow-endpoint" data-block-id="${escapeHtml(endpoint.id)}" data-port="${escapeHtml(endpoint.port || "")}" data-direction="${direction}">
      <strong>${escapeHtml(label)}</strong>
      <small>${escapeHtml(endpoint.sheet || "—")}${hint ? ` · ${escapeHtml(hint)}` : ""}${endpoint.port ? ` · port <em>${escapeHtml(endpoint.port)}</em>` : ""}</small>
    </button>`;
}

function findDiagramBlock(blockId) {
  for (const sheet of payload?.wiring?.sheetDiagrams || []) {
    const block = sheet.blocks.find((entry) => entry.id === blockId);
    if (block) return block;
  }
  return null;
}

function displayTitleForBlockId(blockId, fallback = "") {
  const block = findDiagramBlock(blockId);
  if (block) return blockDisplayLabels(block).title;
  const gfx = core();
  return cleanLabel(
    gfx.blockLabelFromGraph ? gfx.blockLabelFromGraph(payload.wiring, blockId) : fallback || blockId,
    fallback || `Block#${blockId}`,
  );
}

function renderFlowChain(blockId, portName) {
  const gfx = core();
  if (!gfx.traceSignalChain) return "";
  const steps = gfx.traceSignalChain(payload.wiring, blockId, portName, "down", 4);
  if (!steps.length) return "";
  const lines = steps.map((step) => {
    return `
      <div class="flow-chain-step" style="margin-left:${step.depth * 18}px">
        <span class="flow-chain-arrow">→</span>
        <button type="button" class="flow-endpoint compact" data-block-id="${escapeHtml(step.to.id)}" data-port="${escapeHtml(step.to.port || "")}" data-direction="down">
          <strong>${escapeHtml(displayTitleForBlockId(step.to.id))}</strong>
          <small>port ${escapeHtml(step.to.port || "—")} · ${escapeHtml(step.to.sheet || "—")}</small>
        </button>
        <span class="flow-chain-from">from ${escapeHtml(displayTitleForBlockId(step.from.id))} · ${escapeHtml(step.port || "—")}</span>
      </div>`;
  });
  return `
    <div class="flow-chain-block">
      <h3>Then used at (downstream)</h3>
      ${lines.join("")}
    </div>`;
}

function renderSignalFlow(blockId, portName = "") {
  if (!blockId) {
    flowDiagram.hidden = true;
    flowDiagram.innerHTML = "";
    flowEmpty.hidden = false;
    return;
  }
  flowEmpty.hidden = true;
  flowDiagram.hidden = false;

  const blockLabel = displayTitleForBlockId(blockId);
  const blockDisplay = findDiagramBlock(blockId);
  const blockHint = blockDisplay ? blockDisplayLabels(blockDisplay).subtitle : "";
  const gfx = core();
  const flow = gfx.tracePortFlow ? gfx.tracePortFlow(payload.wiring, blockId, portName) : { inputs: [], outputs: [] };
  const portLabel = portName ? ` · port <em>${escapeHtml(portName)}</em>` : "";

  const inputRows = flow.inputs.length
    ? flow.inputs.map((row) => `
        <div class="flow-row">
          ${renderEndpoint(row.from, "input")}
          <div class="flow-arrow" aria-hidden="true">→</div>
          <div class="flow-node flow-node-target">
            <strong>${escapeHtml(blockLabel)}</strong>
            <small>input port <em>${escapeHtml(row.port || "—")}</em></small>
          </div>
        </div>`).join("")
    : `<p class="flow-none">No wired inputs${portName ? ` on port ${escapeHtml(portName)}` : ""}.</p>`;

  const outputRows = flow.outputs.length
    ? flow.outputs.map((row) => `
        <div class="flow-row">
          <div class="flow-node flow-node-source">
            <strong>${escapeHtml(blockLabel)}</strong>
            <small>output port <em>${escapeHtml(row.port || "—")}</em></small>
          </div>
          <div class="flow-arrow" aria-hidden="true">→</div>
          ${renderEndpoint(row.to, "output")}
        </div>`).join("")
    : `<p class="flow-none">No wired outputs${portName ? ` on port ${escapeHtml(portName)}` : ""}.</p>`;

  const chain = portName ? renderFlowChain(blockId, portName) : "";

  flowDiagram.innerHTML = `
    <h2>${escapeHtml(blockLabel)}${portLabel}</h2>
    ${blockHint ? `<p class="flow-hint">${escapeHtml(blockHint)}</p>` : ""}
    <p class="flow-hint">Follow wires on this sheet: inputs feed the block; outputs go to the next logic block or hardware.</p>
    <div class="flow-columns">
      <div class="flow-col">
        <h3>Inputs — what feeds this</h3>
        ${inputRows}
      </div>
      <div class="flow-col">
        <h3>Outputs — what this controls</h3>
        ${outputRows}
      </div>
    </div>
    ${chain}`;
}

function renderDiagramFocus() {
  if (!selectedBlockId || activeTab !== "diagram") {
    diagramFocus.hidden = true;
    diagramFocus.innerHTML = "";
    return;
  }
  const blockLabel = displayTitleForBlockId(selectedBlockId);
  const flow = core().tracePortFlow
    ? core().tracePortFlow(payload.wiring, selectedBlockId, selectedPortName)
    : { inputs: [], outputs: [] };
  diagramFocus.hidden = false;
  diagramFocus.innerHTML = `
    <h2>Selected: ${escapeHtml(blockLabel)}${selectedPortName ? ` · ${escapeHtml(selectedPortName)}` : ""}</h2>
    <p class="flow-hint">Click a block above, or use the <strong>Signal flow</strong> tab for the full trace. Outputs (${flow.outputs.length}) control other blocks; inputs (${flow.inputs.length}) come from other blocks.</p>
    <button type="button" class="flow-open-btn" id="openFlowFromDiagram">Open full signal flow</button>`;
}

function handleFlowEndpointClick(event) {
  const button = event.target.closest(".flow-endpoint");
  if (!button) return;
  const blockId = button.dataset.blockId || "";
  const port = button.dataset.port || "";
  if (!blockId) return;
  const sheet = (payload.wiring.sheetDiagrams || []).find((entry) => entry.blocks.some((block) => block.id === blockId));
  if (sheet) setFlowSelection(sheet.docId, blockId, port);
  selectedBlockId = blockId;
  selectedPortName = port;
  setActiveTab("flow");
  render();
}

function getCurrentSheetDiagram() {
  const docId = diagramSheet.value;
  if (!docId) return null;
  return (payload.wiring.sheetDiagrams || []).find((sheet) => sheet.docId === docId) || null;
}

function blockMatchesHighlight(block, query) {
  if (!query) return false;
  const haystack = [block.label, block.name, block.tagName, block.tag].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function estimateCharWidth(fontSize) {
  return fontSize * 0.58;
}

function truncateToWidth(text, maxWidth, fontSize) {
  const raw = String(text || "").trim();
  if (!raw || maxWidth <= 0) return "";
  const maxChars = Math.max(2, Math.floor(maxWidth / estimateCharWidth(fontSize)));
  if (raw.length <= maxChars) return raw;
  if (maxChars <= 1) return "…";
  return `${raw.slice(0, maxChars - 1)}…`;
}

function blockLabelLines(block, display) {
  const main = display.title;
  let sub = display.subtitle;
  if (!sub || sub === main) sub = "";
  if (block.category === "reference" && main) return block.h < 30 ? [main] : sub ? [main, sub] : [main];
  if (block.category === "composite" && main) return [main];
  if (block.w < 52 || block.h < 22) return main ? [main] : [];
  if (sub && block.h >= 32) return [main, sub];
  return main ? [main] : [];
}

function buildBlockLabelSvg(block, display, showLabels) {
  const pad = 5;
  const innerW = Math.max(0, block.w - pad * 2);
  const innerH = Math.max(0, block.h - pad * 2);
  const tooltip = display.tooltip;
  const lines = blockLabelLines(block, display);

  if (!showLabels || !lines.length || innerW < 18 || innerH < 12) {
    return `<title>${escapeHtml(tooltip)}</title>`;
  }

  const lineCount = lines.length;
  const fontSize = Math.min(11, Math.max(6, Math.min(innerW / 8.5, innerH / (lineCount === 1 ? 2.2 : 3.4))));
  const subFontSize = Math.max(5, fontSize - 1);
  const lineGap = Math.max(subFontSize + 1, fontSize * 1.05);
  const totalTextH = fontSize + (lineCount > 1 ? lineGap : 0);
  const clipId = `clip-block-${block.id}`;
  const centerX = block.x + block.w / 2;
  const firstY = block.y + pad + (innerH - totalTextH) / 2 + fontSize * 0.78;

  const tspans = lines
    .map((line, index) => {
      const isSub = index > 0;
      const fs = isSub ? subFontSize : fontSize;
      const text = truncateToWidth(line, innerW, fs);
      if (!text) return "";
      const dy = index === 0 ? 0 : lineGap;
      const attrs = isSub ? ' fill="#4b5563"' : ' font-weight="600"';
      return `<tspan x="${centerX}" dy="${dy}" font-size="${fs}"${attrs}>${escapeHtml(text)}</tspan>`;
    })
    .filter(Boolean)
    .join("");

  if (!tspans) {
    return `<title>${escapeHtml(tooltip)}</title>`;
  }

  return `
    <defs>
      <clipPath id="${clipId}">
        <rect x="${block.x + pad}" y="${block.y + pad}" width="${innerW}" height="${innerH}" rx="2" />
      </clipPath>
    </defs>
    <title>${escapeHtml(tooltip)}</title>
    <text
      x="${centerX}"
      y="${firstY}"
      text-anchor="middle"
      clip-path="url(#${clipId})"
      class="diagram-block-label"
    >${tspans}</text>`;
}

function renderSheetDiagram() {
  const sheet = getCurrentSheetDiagram();
  const query = diagramSearch.value.trim();
  if (!sheet) {
    diagramCanvas.innerHTML = "";
    diagramEmpty.hidden = false;
    return;
  }
  diagramEmpty.hidden = true;

  const pad = 48;
  const b = sheet.bounds;
  const viewW = b.maxX - b.minX + pad * 2;
  const viewH = b.maxY - b.minY + pad * 2;
  const offsetX = b.minX - pad;
  const offsetY = b.minY - pad;
  const blockById = Object.fromEntries(sheet.blocks.map((block) => [block.id, block]));

  let linksSvg = "";
  for (const link of sheet.links) {
    const from = blockById[link.fromId];
    const to = blockById[link.toId];
    if (!from || !to) continue;
    const x1 = from.x + from.w;
    const y1 = from.cy;
    const x2 = to.x;
    const y2 = to.cy;
    const mx = (x1 + x2) / 2;
    const highlighted =
      link.fromId === selectedBlockId ||
      link.toId === selectedBlockId ||
      blockMatchesHighlight(from, query) ||
      blockMatchesHighlight(to, query) ||
      (link.fromPort && link.fromPort.toLowerCase().includes(query.toLowerCase())) ||
      (link.toPort && link.toPort.toLowerCase().includes(query.toLowerCase()));
    linksSvg += `<path class="wire-link${highlighted ? " highlighted" : ""}" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" />`;
  }

  let blocksSvg = "";
  for (const block of sheet.blocks) {
    const colors = CATEGORY_COLORS[block.category] || CATEGORY_COLORS.logic;
    const highlighted =
      block.id === selectedBlockId ||
      blockMatchesHighlight(block, query);
    const display = blockDisplayLabels(block);
    const showLabels =
      highlighted ||
      diagramShowLabels.checked ||
      (!query && (block.w >= 64 && block.h >= 28));
    const labelSvg = buildBlockLabelSvg(block, display, showLabels);
    blocksSvg += `
      <g class="diagram-block${highlighted ? " highlighted" : ""}" data-block-id="${escapeHtml(block.id)}" role="button" tabindex="0" style="cursor:pointer">
        <rect x="${block.x}" y="${block.y}" width="${block.w}" height="${block.h}" rx="5"
          fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="${highlighted ? 2.8 : 1.4}" />
        ${labelSvg}
      </g>`;
  }

  diagramCanvas.innerHTML = `
    <div class="diagram-scroll" style="--diagram-scale:${diagramScale}">
      <svg class="sheet-diagram" viewBox="${offsetX} ${offsetY} ${viewW} ${viewH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(sheet.name)} block diagram">
        <rect x="${offsetX}" y="${offsetY}" width="${viewW}" height="${viewH}" class="diagram-bg" />
        <g class="wire-layer">${linksSvg}</g>
        <g class="block-layer">${blocksSvg}</g>
      </svg>
    </div>`;
  renderDiagramFocus();
}

function setActiveTab(tab) {
  activeTab = tab;
  tabFlow.classList.toggle("active", tab === "flow");
  tabDiagram.classList.toggle("active", tab === "diagram");
  tabCrossRef.classList.toggle("active", tab === "xref");
  tabWiring.classList.toggle("active", tab === "wiring");
  tabFlow.setAttribute("aria-selected", String(tab === "flow"));
  tabDiagram.setAttribute("aria-selected", String(tab === "diagram"));
  tabCrossRef.setAttribute("aria-selected", String(tab === "xref"));
  tabWiring.setAttribute("aria-selected", String(tab === "wiring"));
  flowPanel.hidden = tab !== "flow";
  diagramPanel.hidden = tab !== "diagram";
  crossRefPanel.hidden = tab !== "xref";
  wiringPanel.hidden = tab !== "wiring";
  renderStats();
}

function renderStats() {
  const w = payload.wiring;
  if (activeTab === "flow") {
    const blockId = flowBlock.value;
    if (blockId) {
      const flow = core().tracePortFlow ? core().tracePortFlow(payload.wiring, blockId, flowPort.value) : { inputs: [], outputs: [] };
      wiringStats.textContent = `${flow.inputs.length} input wire(s) · ${flow.outputs.length} output wire(s) — click an output to follow further`;
    } else {
      wiringStats.textContent = `Select a sheet and block to trace inputs → block → outputs`;
    }
  } else if (activeTab === "diagram") {
    const sheet = getCurrentSheetDiagram();
    if (sheet) {
      wiringStats.textContent = `${sheet.name} · ${sheet.blockCount} blocks · ${sheet.linkCount} wires on this sheet`;
    } else {
      wiringStats.textContent = `${w.sheetDiagramCount || 0} programming sheets available · pick one from the dropdown`;
    }
  } else if (activeTab === "xref") {
    const shown = getFilteredCrossRefs().length;
    wiringStats.textContent = `Showing ${shown} of ${w.crossRefCount || 0} tags · ${w.hubCount || 0} hubs · ${w.targetCount || 0} targets`;
  } else {
    const shown = getFilteredLinks().length;
    wiringStats.textContent = `Showing ${shown} of ${w.linkCount} local wire connections · ${w.compositeCount} logic modules`;
  }
}

function render() {
  if (activeTab === "flow") {
    renderSignalFlow(flowBlock.value, flowPort.value);
  } else if (activeTab === "diagram") {
    renderSheetDiagram();
  } else if (activeTab === "xref") {
    renderCrossRefTable();
  } else {
    renderWiringTable();
  }
  renderStats();
}

function applyInitialFocus() {
  const w = payload.wiring;
  if (payload.focusBlockId || payload.focusPortName) {
    let docId = payload.focusSheetDocId || "";
    const blockId = payload.focusBlockId || "";
    if (!docId && blockId) {
      const sheet = (w.sheetDiagrams || []).find((entry) => entry.blocks.some((block) => block.id === blockId));
      docId = sheet?.docId || "";
    }
    setFlowSelection(docId, blockId, payload.focusPortName || "");
    setActiveTab("flow");
    return;
  }
  if (payload.focusTagName) {
    xrefSearch.value = payload.focusTagName;
    diagramSearch.value = payload.focusTagName;
    selectedXrefTag = payload.focusTagName;
    const xref = (w.crossReferences || []).find((row) => row.tagName === payload.focusTagName);
    const hub = xref?.hubs[0];
    if (hub?.blockId) {
      const sheet = getSheetDiagramByName(hub.sheet);
      if (sheet) setFlowSelection(sheet.docId, hub.blockId, payload.focusTagName);
      setActiveTab("flow");
      return;
    }
    setActiveTab("xref");
    return;
  }
  if (payload.focusSheetDocId) {
    setFlowSelection(payload.focusSheetDocId, "", "");
    diagramSheet.value = payload.focusSheetDocId;
    setActiveTab("flow");
    return;
  }
  if ((w.sheetDiagrams || []).length > 0) {
    setFlowSelection(w.sheetDiagrams[0].docId, "", "");
  }
  setActiveTab("flow");
}

function populateFilters() {
  populateFlowSheets();
  for (const sheet of payload.wiring.sheetDiagrams || []) {
    const option = document.createElement("option");
    option.value = sheet.docId;
    option.textContent = `${sheet.name} (${sheet.blockCount} blocks)`;
    diagramSheet.appendChild(option);
  }
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
    option.textContent = displayTitleForBlockId(block.id, `Block#${block.id}`);
    focusBlock.appendChild(option);
  }
  applyInitialFocus();
}

function init() {
  payload = loadPayload();
  if (!payload?.wiring) {
    document.body.innerHTML =
      '<main style="padding:2rem;font-family:sans-serif;max-width:40rem"><h1>No logic data</h1><p>Load a .gfx template in the main editor, then click <strong>Open wiring viewer</strong> again.</p></main>';
    return;
  }

  const title = payload.projectName || payload.fileName || "GFX project";
  document.title = `Signal flow — ${title}`;
  wiringSubtitle.textContent = `${title} · follow inputs → block → outputs (read-only)`;
  printTitle.textContent = `Logic signal flow — ${title}`;
  printMeta.textContent = `Exported ${new Date(payload.exportedAt).toLocaleString()} · ${payload.wiring.sheetDiagramCount || 0} sheets · ${payload.wiring.linkCount} wires`;

  populateFilters();
  render();

  tabFlow.addEventListener("click", () => {
    setActiveTab("flow");
    render();
  });
  tabDiagram.addEventListener("click", () => {
    setActiveTab("diagram");
    render();
  });
  tabCrossRef.addEventListener("click", () => {
    setActiveTab("xref");
    render();
  });
  tabWiring.addEventListener("click", () => {
    setActiveTab("wiring");
    render();
  });
  diagramSheet.addEventListener("change", () => {
    selectedBlockId = "";
    selectedPortName = "";
    render();
  });
  diagramSearch.addEventListener("input", render);
  diagramShowLabels.addEventListener("change", render);
  diagramCanvas.addEventListener("click", (event) => {
    const block = event.target.closest(".diagram-block");
    if (!block) return;
    selectedBlockId = block.dataset.blockId || "";
    selectedPortName = "";
    const sheet = getCurrentSheetDiagram();
    if (sheet) setFlowSelection(sheet.docId, selectedBlockId, "");
    render();
  });
  diagramFocus.addEventListener("click", (event) => {
    if (event.target.closest("#openFlowFromDiagram")) {
      setActiveTab("flow");
      render();
    }
  });
  flowSheet.addEventListener("change", () => {
    flowBlock.value = "";
    flowPort.value = "";
    selectedBlockId = "";
    selectedPortName = "";
    populateFlowBlocks();
    populateFlowPorts();
    diagramSheet.value = flowSheet.value;
    render();
  });
  flowBlock.addEventListener("change", () => {
    selectedBlockId = flowBlock.value;
    selectedPortName = "";
    populateFlowPorts();
    render();
  });
  flowPort.addEventListener("change", () => {
    selectedPortName = flowPort.value;
    render();
  });
  flowDiagram.addEventListener("click", handleFlowEndpointClick);
  diagramCanvas.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    diagramScale = Math.min(2.5, Math.max(0.4, diagramScale + (event.deltaY < 0 ? 0.1 : -0.1)));
    renderSheetDiagram();
  }, { passive: false });
  xrefTableBody.addEventListener("click", (event) => {
    const row = event.target.closest(".xref-row");
    if (!row) return;
    selectedXrefTag = row.dataset.tag || "";
    diagramSearch.value = selectedXrefTag;
    const xref = (payload.wiring.crossReferences || []).find((entry) => entry.tagName === selectedXrefTag);
    const sheetName = xref?.hubs[0]?.sheet || xref?.targets[0]?.sheet;
    if (sheetName) {
      const diagram = getSheetDiagramByName(sheetName);
      if (diagram) {
        const hub = xref?.hubs[0];
        setFlowSelection(diagram.docId, hub?.blockId || "", selectedXrefTag);
        setActiveTab("flow");
      }
    }
    renderCrossRefTable();
    render();
  });
  xrefSearch.addEventListener("input", render);
  xrefSheetFilter.addEventListener("change", render);
  wireSearch.addEventListener("input", render);
  compositeFilter.addEventListener("change", render);
  tagFilter.addEventListener("change", render);
  focusBlock.addEventListener("change", render);
  printBtn.addEventListener("click", () => window.print());
  closeBtn.addEventListener("click", () => window.close());
}

init();
