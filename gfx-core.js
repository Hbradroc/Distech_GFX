/**
 * Distech EC-gfxProgram (.gfx) parameter extraction and updates.
 */
const GfxCore = (() => {
  const COM_CONFIG_PATH = "Config/Bacnet/ComSensors/CommonConfig.xml";
  const INTERNAL_POINTS_PATH = "Info/InternalPoints.xml";

  const BACNET_TYPE_FROM_POINT = {
    AnalogInput: 0,
    AnalogOutput: 1,
    AnalogValue: 2,
    BinaryInput: 3,
    BinaryOutput: 4,
    BinaryValue: 5,
    MultiStateInput: 13,
    MultiStateOutput: 14,
    MultiStateValue: 19,
  };

  const DEFAULT_VALUE_BLOCKS = {
    BacnetAnalogValueResource: "AnalogValue",
    BacnetBinaryValueResource: "BinaryValue",
    BacnetMultiStateValueResource: "MultiStateValue",
  };

  const BACNET_RESOURCE_TAGS = [
    "BacnetAnalogValueResource",
    "BacnetBinaryValueResource",
    "BacnetMultiStateValueResource",
    "BacnetHardwareInputResource",
    "BacnetHardwareOutputResource",
    "BacnetPidResource",
  ];

  const BACNET_METADATA_FIELDS = [
    "ObjectName",
    "TAG",
    "ObjectUnit",
    "CovPeriod",
    "CovMinSendTime",
    "CovIncrement",
    "Visible",
    "ControllerSpecific",
    "AlarmEnable",
    "AlarmParameters",
  ];

  const HARDWARE_INPUT_FIELDS = [
    "SignalOffset",
    "SignalLowLimit",
    "SignalHighLimit",
    "Offset",
    "Minimum",
    "Maximum",
    "Default",
  ];

  const HARDWARE_OUTPUT_FIELDS = [
    "Minimum",
    "Maximum",
    "Default",
    "WarmUpTime",
    "CoolDownTime",
    "PwmPeriod",
    "NumberOfStates",
  ];

  const PID_TUNING_FIELDS = [
    "ProportionalBand",
    "IntegralTime",
    "DerivativeTime",
    "DeadBand",
    "Bias",
    "RampTime",
    "SaturationTime",
  ];

  const COMPOSITE_INPUT_FIELDS = ["OV", "CT"];
  const COMPOSITE_OUTPUT_FIELDS = ["IV", "CT"];

  const PROGRAMMING_CONSTANT_TAGS = {
    SetpointConstant: "ProgrammingConstant",
    NumericConstant: "ProgrammingConstant",
    EnumConstant: "ProgrammingConstant",
    BooleanConstant: "ProgrammingConstant",
  };

  const REGISTER_FIELDS = ["defaultValue", "unit"];

  /** Hidden by default — enable "Other variables" checkbox in the UI. */
  const OTHER_CATEGORIES = new Set([
    "InternalConstant",
    "ComSensorRegister",
    "ComSensorBinding",
    "BacnetMetadata",
    "ProgrammingConstant",
  ]);

  const CATEGORY_SECTIONS = [
    { id: "setpoints", label: "Analog / binary setpoints", categories: ["AnalogValue", "BinaryValue", "MultiStateValue"], tier: "primary" },
    { id: "hardware", label: "Hardware inputs & outputs", categories: ["HardwareInput", "HardwareOutput"], tier: "primary" },
    { id: "pid", label: "PID tuning", categories: ["PidTuning"], tier: "primary" },
    { id: "logic", label: "Logic module ports", categories: ["CompositeInput", "CompositeOutput"], tier: "primary" },
    { id: "schedules", label: "Schedules & calendars", categories: ["Schedule", "ScheduleTime"], tier: "primary" },
    { id: "bacnet", label: "BACnet COV, alarms & metadata", categories: ["BacnetMetadata"], tier: "other" },
    { id: "programming", label: "Programming sheet constants", categories: ["ProgrammingConstant"], tier: "other" },
    { id: "internal", label: "Internal logic constants", categories: ["InternalConstant"], tier: "other" },
    { id: "sensor", label: "Com sensor registers", categories: ["ComSensorRegister"], tier: "other" },
    { id: "bindings", label: "Com sensor bindings", categories: ["ComSensorBinding"], tier: "other" },
  ];

  function textContent(parent, tag, fallback = "") {
    const el = parent?.getElementsByTagName(tag)[0];
    if (!el || el.textContent == null) return fallback;
    return el.textContent.trim();
  }

  function childElements(parent) {
    if (!parent) return [];
    if (parent.children) return Array.from(parent.children);
    return Array.from(parent.childNodes || []).filter((node) => node.nodeType === 1);
  }

  function directChild(parent, tag) {
    if (!parent) return null;
    return childElements(parent).find((child) => child.tagName === tag) || null;
  }

  function isCorruptDisplayText(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return false;
    if (raw.length > 48 && /(.)\1{8,}/.test(raw)) return true;
    if (/[`\]\[]/.test(raw) && /\d{8,}/.test(raw)) return true;
    if (raw.length > 120) return true;
    return false;
  }

  function sanitizeDisplayText(text, fallback = "") {
    const raw = String(text ?? "").trim();
    if (!raw) return fallback;
    if (isCorruptDisplayText(raw)) return fallback;
    if (raw.length > 80) return `${raw.slice(0, 77)}…`;
    return raw;
  }

  function formatParameterValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    if (isCorruptDisplayText(raw)) return "(corrupt value in template)";
    if (raw.includes("=") && raw.includes("|")) {
      const pairs = raw.split("|").filter(Boolean);
      if (pairs.length > 2 && pairs.every((part) => part.includes("="))) {
        const preview = pairs.slice(0, 3).join(", ");
        return pairs.length > 3 ? `${preview}… (${pairs.length} BACnet properties)` : preview;
      }
    }
    if (raw.includes("|") && !raw.includes("=")) {
      const first = raw.split("|")[0];
      if (first !== "") return first;
    }
    return sanitizeDisplayText(raw, raw);
  }

  function sanitizeBlockName(name, tag, blockId) {
    const cleaned = sanitizeDisplayText(name, "");
    if (cleaned && !["Internal Constant", "Monitor"].includes(cleaned)) return cleaned;
    if (tag === "InternalConstantNumeric") return `LogicConstant#${blockId}`;
    return `${tag}#${blockId}`;
  }

  function paramKey(source, category, name, field) {
    return `${source}\0${category}\0${name}\0${field}`;
  }

  function makeParam({ source, category, name, field, value, index = "", controller_specific = "", section = "", context = "", hint = "" }) {
    return {
      source,
      category,
      name,
      field,
      value,
      index,
      controller_specific,
      section: section || sectionForCategory(category),
      context,
      hint,
      tier: OTHER_CATEGORIES.has(category) ? "other" : "primary",
    };
  }

  function buildBlockIndex(doc) {
    const index = new Map();
    for (const el of doc.getElementsByTagName("*")) {
      const id = el.getAttribute("id");
      if (!id) continue;
      const tag = el.tagName;
      const rawName = textContent(el, "Name") || textContent(el, "NAME");
      index.set(id, {
        tag,
        name: sanitizeBlockName(rawName, tag, id),
      });
    }
    return index;
  }

  function buildOutgoingLinks(doc) {
    const links = new Map();
    for (const link of doc.getElementsByTagName("Link")) {
      const fb = link.getElementsByTagName("FB")[0]?.getAttribute("ref");
      const tb = link.getElementsByTagName("TB")[0]?.getAttribute("ref");
      const tp = textContent(link, "TP");
      const fp = textContent(link, "FP");
      if (!fb || !tb) continue;
      if (!links.has(fb)) links.set(fb, []);
      links.get(fb).push({ targetId: tb, port: tp, fromPort: fp });
    }
    return links;
  }

  function wiringBlockLabel(blockIndex, blockId) {
    const block = blockIndex.get(blockId);
    if (!block) return `Block#${blockId}`;
    const name = sanitizeDisplayText(block.name, "");
    if (name && !["Internal Constant", "Monitor"].includes(name)) {
      return name.includes(block.tag) ? name : `${name} (${block.tag})`;
    }
    if (block.tag === "InternalConstantNumeric") return `LogicConstant#${blockId}`;
    return `${block.tag}#${blockId}`;
  }

  function buildSheetMap(doc) {
    const map = new Map();
    for (const el of doc.getElementsByTagName("*")) {
      const id = el.getAttribute("id");
      if (!id) continue;
      if (!["DrawingDocument", "SimpleCompositeBlock", "PageSetup"].includes(el.tagName)) continue;
      const name = textContent(el, "Name");
      if (name) map.set(id, name);
    }
    return map;
  }

  function resolveSheet(block, sheetMap) {
    const docRef = block.getElementsByTagName("Doc")[0]?.getAttribute("ref");
    if (docRef && sheetMap.has(docRef)) return sheetMap.get(docRef);
    return docRef ? `Sheet #${docRef}` : "Unknown sheet";
  }

  function tagNameFromBlock(block) {
    const props = block.getElementsByTagName("Props")[0];
    const tagNameEl = props?.getElementsByTagName("TagName")[0];
    return tagNameEl?.textContent?.trim() || "";
  }

  function buildBlockSheetMap(doc, sheetMap) {
    const blockSheets = new Map();
    for (const el of doc.getElementsByTagName("*")) {
      const id = el.getAttribute("id");
      if (!id || !el.getElementsByTagName("Doc")[0]) continue;
      blockSheets.set(id, resolveSheet(el, sheetMap));
    }
    return blockSheets;
  }

  function parseCrossReferences(doc, sheetMap) {
    const crossRefMap = new Map();

    function addCrossRef(tagName, kind, entry) {
      if (!tagName) return;
      if (!crossRefMap.has(tagName)) {
        crossRefMap.set(tagName, { tagName, hubs: [], targets: [] });
      }
      crossRefMap.get(tagName)[kind].push(entry);
    }

    for (const block of doc.getElementsByTagName("OutgoingTag")) {
      const tagName = tagNameFromBlock(block);
      addCrossRef(tagName, "hubs", {
        blockId: block.getAttribute("id") || "",
        sheet: resolveSheet(block, sheetMap),
        role: textContent(block, "Name") || "Reference Hub",
      });
    }

    for (const block of doc.getElementsByTagName("IncomingTag")) {
      const tagName = tagNameFromBlock(block);
      addCrossRef(tagName, "targets", {
        blockId: block.getAttribute("id") || "",
        sheet: resolveSheet(block, sheetMap),
        role: textContent(block, "Name") || "Reference Target",
      });
    }

    const crossReferences = [...crossRefMap.values()].sort((a, b) => a.tagName.localeCompare(b.tagName));
    const crossRefByTag = {};
    for (const entry of crossReferences) {
      crossRefByTag[entry.tagName] = entry;
    }
    return { crossReferences, crossRefByTag };
  }

  function lookupCrossReference(wiringGraph, name) {
    if (!wiringGraph?.crossRefByTag || !name) return null;
    const candidates = [name];
    if (name.includes(".")) candidates.push(name.split(".").pop());
    if (name.includes("#")) candidates.push(name.split("#")[0]);
    for (const candidate of candidates) {
      if (wiringGraph.crossRefByTag[candidate]) return wiringGraph.crossRefByTag[candidate];
    }
    return null;
  }

  function portsForBlock(wiringGraph, blockId, sheetDocId = "") {
    const ports = new Set();
    const sheetBlocks = sheetDocId
      ? new Set(
          (wiringGraph.sheetDiagrams || [])
            .find((sheet) => sheet.docId === sheetDocId)
            ?.blocks.map((block) => block.id) || [],
        )
      : null;

    for (const link of wiringGraph.links || []) {
      if (sheetBlocks && !sheetBlocks.has(link.from.id) && !sheetBlocks.has(link.to.id)) continue;
      if (link.from.id === blockId && link.from.port) ports.add(link.from.port);
      if (link.to.id === blockId && link.to.port) ports.add(link.to.port);
    }
    return [...ports].sort((a, b) => a.localeCompare(b));
  }

  function tracePortFlow(wiringGraph, blockId, portName = "") {
    const norm = (value) => String(value || "").toLowerCase();
    const targetPort = norm(portName);
    const inputs = [];
    const outputs = [];
    for (const link of wiringGraph.links || []) {
      if (link.to.id === blockId && (!targetPort || norm(link.to.port) === targetPort)) {
        inputs.push({
          port: link.to.port,
          from: {
            id: link.from.id,
            label: link.from.label,
            port: link.from.port,
            sheet: link.from.sheet,
            tag: link.from.tag,
          },
        });
      }
      if (link.from.id === blockId && (!targetPort || norm(link.from.port) === targetPort)) {
        outputs.push({
          port: link.from.port,
          to: {
            id: link.to.id,
            label: link.to.label,
            port: link.to.port,
            sheet: link.to.sheet,
            tag: link.to.tag,
          },
        });
      }
    }
    return { blockId, portName, inputs, outputs };
  }

  function traceSignalChain(wiringGraph, blockId, portName, direction = "down", maxDepth = 4) {
    const steps = [];
    const visited = new Set();

    function walk(currentId, currentPort, depth) {
      const key = `${direction}:${currentId}:${currentPort}:${depth}`;
      if (visited.has(key) || depth >= maxDepth) return;
      visited.add(key);
      const flow = tracePortFlow(wiringGraph, currentId, currentPort);
      const links = direction === "down" ? flow.outputs : flow.inputs;
      for (const link of links) {
        const endpoint = direction === "down" ? link.to : link.from;
        const step = {
          depth,
          port: direction === "down" ? link.port : link.port,
          from: direction === "down" ? { id: currentId, port: currentPort } : endpoint,
          to: direction === "down" ? endpoint : { id: currentId, port: currentPort },
        };
        steps.push(step);
        walk(endpoint.id, endpoint.port, depth + 1);
      }
    }

    walk(blockId, portName, 0);
    return steps;
  }

  function resolveParamSignal(wiringGraph, param) {
    if (!wiringGraph || !param) return null;
    if (param.category === "CompositeInput" || param.category === "CompositeOutput") {
      const dot = param.name.lastIndexOf(".");
      if (dot < 0) return null;
      const compositeName = param.name.slice(0, dot);
      const portName = param.name.slice(dot + 1);
      const composite = (wiringGraph.composites || []).find((entry) => entry.name === compositeName);
      if (!composite) return null;
      return {
        blockId: composite.id,
        portName,
        sheet: composite.sheet,
        role: param.category === "CompositeInput" ? "input" : "output",
        label: param.name,
      };
    }
    const blockMatch = param.name.match(/#(\d+)$/);
    if (blockMatch) {
      return {
        blockId: blockMatch[1],
        portName: "",
        sheet: "",
        role: "block",
        label: param.name,
      };
    }
    const crossRef = lookupCrossReference(wiringGraph, param.name);
    if (crossRef) {
      const hub = crossRef.hubs[0];
      return {
        blockId: hub?.blockId || "",
        portName: crossRef.tagName,
        sheet: hub?.sheet || "",
        role: "tag",
        label: crossRef.tagName,
      };
    }
    return null;
  }

  function blockLabelFromGraph(wiringGraph, blockId) {
    const option = (wiringGraph.focusOptions || []).find((entry) => entry.id === blockId);
    return option?.label || `Block#${blockId}`;
  }

  function parseBds(bdsText) {
    const parts = (bdsText || "").split(",").map((part) => Number(part.trim()));
    if (parts.length < 4 || parts.some((value) => Number.isNaN(value))) return null;
    const [x1, y1, x2, y2] = parts;
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.max(Math.abs(x2 - x1), 8),
      h: Math.max(Math.abs(y2 - y1), 8),
      cx: (x1 + x2) / 2,
      cy: (y1 + y2) / 2,
    };
  }

  function blockVisualCategory(tag) {
    if (tag === "OutgoingTag" || tag === "IncomingTag") return "reference";
    if (tag.includes("HardwareOutput")) return "hwout";
    if (tag.includes("HardwareInput")) return "hwin";
    if (tag.includes("Pid") || tag.includes("JPID")) return "pid";
    if (tag.startsWith("BacnetAnalog") || tag.startsWith("BacnetBinary") || tag.startsWith("BacnetMultiState")) {
      return "bacnet";
    }
    if (tag === "InternalConstantNumeric") return "constant";
    if (tag === "SimpleCompositeBlock") return "composite";
    return "logic";
  }

  function parseSheetDiagrams(doc, sheetMap, blockIndex) {
    const sheets = new Map();

    function getSheet(docId) {
      if (!sheets.has(docId)) {
        sheets.set(docId, {
          docId,
          name: sheetMap.get(docId) || `Sheet #${docId}`,
          blocks: new Map(),
          links: [],
          bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        });
      }
      return sheets.get(docId);
    }

    function expandBounds(sheet, bds) {
      sheet.bounds.minX = Math.min(sheet.bounds.minX, bds.x);
      sheet.bounds.minY = Math.min(sheet.bounds.minY, bds.y);
      sheet.bounds.maxX = Math.max(sheet.bounds.maxX, bds.x + bds.w);
      sheet.bounds.maxY = Math.max(sheet.bounds.maxY, bds.y + bds.h);
    }

    for (const el of doc.getElementsByTagName("*")) {
      const id = el.getAttribute("id");
      const docRef = el.getElementsByTagName("Doc")[0]?.getAttribute("ref");
      const bdsEl = el.getElementsByTagName("Bds")[0];
      if (!id || !docRef || !bdsEl) continue;
      const bds = parseBds(bdsEl.textContent?.trim() || "");
      if (!bds) continue;
      const tag = el.tagName;
      const rawName = textContent(el, "Name") || textContent(el, "NAME") || "";
      const name = sanitizeBlockName(rawName, tag, id);
      const sheet = getSheet(docRef);
      sheet.blocks.set(id, {
        id,
        tag,
        name,
        tagName: tagNameFromBlock(el),
        label: wiringBlockLabel(blockIndex, id),
        category: blockVisualCategory(tag),
        x: bds.x,
        y: bds.y,
        w: bds.w,
        h: bds.h,
        cx: bds.cx,
        cy: bds.cy,
      });
      expandBounds(sheet, bds);
    }

    const blockDoc = new Map();
    for (const [docId, sheet] of sheets) {
      for (const blockId of sheet.blocks.keys()) {
        blockDoc.set(blockId, docId);
      }
    }

    for (const link of doc.getElementsByTagName("Link")) {
      const fromId = link.getElementsByTagName("FB")[0]?.getAttribute("ref");
      const toId = link.getElementsByTagName("TB")[0]?.getAttribute("ref");
      if (!fromId || !toId) continue;
      const docFrom = blockDoc.get(fromId);
      const docTo = blockDoc.get(toId);
      if (!docFrom || docFrom !== docTo) continue;
      const sheet = sheets.get(docFrom);
      if (!sheet?.blocks.has(fromId) || !sheet.blocks.has(toId)) continue;
      sheet.links.push({
        fromId,
        toId,
        fromPort: textContent(link, "FP"),
        toPort: textContent(link, "TP"),
      });
    }

    return [...sheets.values()]
      .filter((sheet) => sheet.blocks.size > 0)
      .map((sheet) => ({
        docId: sheet.docId,
        name: sheet.name,
        blockCount: sheet.blocks.size,
        linkCount: sheet.links.length,
        bounds:
          sheet.bounds.minX === Infinity
            ? { minX: 0, minY: 0, maxX: 1200, maxY: 900 }
            : sheet.bounds,
        blocks: [...sheet.blocks.values()],
        links: sheet.links,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function wiringEndpoint(blockIndex, blockId, port, blockSheets) {
    const block = blockIndex.get(blockId);
    return {
      id: blockId,
      tag: block?.tag || "?",
      name: block?.name || "",
      label: wiringBlockLabel(blockIndex, blockId),
      port: port || "",
      sheet: blockSheets?.get(blockId) || "",
    };
  }

  function parseWiringGraph(mainXmlText) {
    const doc = parseXml(mainXmlText);
    const blockIndex = buildBlockIndex(doc);
    const sheetMap = buildSheetMap(doc);
    const blockSheets = buildBlockSheetMap(doc, sheetMap);
    const { crossReferences, crossRefByTag } = parseCrossReferences(doc, sheetMap);
    const sheetDiagrams = parseSheetDiagrams(doc, sheetMap, blockIndex);
    const composites = [];
    const blockTypes = new Set();

    for (const block of childElements(doc.documentElement)) {
      if (block.tagName !== "SimpleCompositeBlock") continue;
      const id = block.getAttribute("id") || "";
      const name = textContent(block, "Name") || `Composite#${id}`;
      composites.push({ id, name, label: `${name} (${id})`, sheet: resolveSheet(block, sheetMap) });
    }
    composites.sort((a, b) => a.name.localeCompare(b.name));

    const links = [];
    for (const link of doc.getElementsByTagName("Link")) {
      const linkId = link.getAttribute("id") || "";
      const fromId = link.getElementsByTagName("FB")[0]?.getAttribute("ref") || "";
      const toId = link.getElementsByTagName("TB")[0]?.getAttribute("ref") || "";
      const fromPort = textContent(link, "FP");
      const toPort = textContent(link, "TP");
      if (!fromId || !toId) continue;
      const from = wiringEndpoint(blockIndex, fromId, fromPort, blockSheets);
      const to = wiringEndpoint(blockIndex, toId, toPort, blockSheets);
      blockTypes.add(from.tag);
      blockTypes.add(to.tag);
      links.push({ id: linkId, from, to });
    }

    links.sort((a, b) => {
      const left = `${a.from.label}|${a.from.port}|${a.to.label}|${a.to.port}`;
      const right = `${b.from.label}|${b.from.port}|${b.to.label}|${b.to.port}`;
      return left.localeCompare(right);
    });

    const focusBlocks = new Map();
    for (const wire of links) {
      focusBlocks.set(wire.from.id, wire.from.label);
      focusBlocks.set(wire.to.id, wire.to.label);
    }
    const focusOptions = [...focusBlocks.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const sheets = [...new Set([...sheetMap.values(), ...blockSheets.values()])].sort();

    return {
      links,
      composites,
      focusOptions,
      blockTypes: [...blockTypes].sort(),
      sheets,
      crossReferences,
      crossRefByTag,
      sheetDiagrams,
      blockCount: blockIndex.size,
      linkCount: links.length,
      compositeCount: composites.length,
      sheetDiagramCount: sheetDiagrams.length,
      crossRefCount: crossReferences.length,
      hubCount: crossReferences.reduce((sum, row) => sum + row.hubs.length, 0),
      targetCount: crossReferences.reduce((sum, row) => sum + row.targets.length, 0),
    };
  }

  function describeConstantUsage(blockId, blockIndex, outgoingLinks) {
    const targets = outgoingLinks.get(blockId) || [];
    const parts = [];
    const seen = new Set();
    for (const { targetId, port } of targets) {
      const target = blockIndex.get(targetId);
      if (!target) continue;
      const label = target.name ? `${target.name} (${target.tag})` : target.tag;
      const full = port && !["Output", "Input"].includes(port) ? `${label} · port ${port}` : label;
      if (seen.has(full)) continue;
      seen.add(full);
      parts.push(full);
      if (parts.length >= 4) break;
    }
    return parts.join(" → ");
  }

  function inferConstantHint(value, usage) {
    const numeric = Number(value);
    const hints = [];
    const usageLower = usage.toLowerCase();

    if (usageLower.includes("start delay") || usageLower.includes("startdelay")) {
      hints.push(`Start delay of ${value} (typically seconds)`);
    }
    if (usageLower.includes("min on off") || usageLower.includes("minofftime")) {
      hints.push(`Minimum on/off time = ${value}`);
    }
    if (usageLower.includes("multiplexer")) {
      hints.push(numeric === 1 ? "Multiplexer enable/select flag (1 = active)" : `Multiplexer input value ${value}`);
    }
    if (usageLower.includes("greaterthan") || usageLower.includes("lessthan") || usageLower.includes("equal")) {
      hints.push(`Comparison threshold: ${value}`);
    }
    if (usageLower.includes("multiply") || usageLower.includes("divide") || usageLower.includes("subtract")) {
      hints.push(`Math block factor/offset: ${value}`);
    }
    if (usageLower.includes("switch")) {
      hints.push(numeric === 1 ? "Switch selector (1 = true/on path)" : `Switch value ${value}`);
    }
    if (numeric === 1 && !hints.length) {
      hints.push("Logic flag (1 = enabled/true)");
    }
    if (!Number.isNaN(numeric) && numeric > 1 && numeric <= 120 && !hints.length) {
      hints.push(`Likely a timer/delay (${value} sec or min — verify in EC-gfxProgram)`);
    }
    if (String(value).startsWith("0.1") || numeric === 0.1) {
      hints.push("Fraction multiplier (0.1 = 10%)");
    }
    if (!hints.length && usage) {
      hints.push(`Feeds: ${usage}`);
    }
    if (!hints.length) {
      hints.push("Fixed number inside the programming sheet logic (not a named BACnet setpoint)");
    }
    return hints.join(". ");
  }

  function buildInternalConstantContext(blockId, value, blockIndex, outgoingLinks) {
    const usage = describeConstantUsage(blockId, blockIndex, outgoingLinks);
    const hint = inferConstantHint(value, usage);
    return { usage, hint };
  }

  function isOtherCategory(category) {
    return OTHER_CATEGORIES.has(category);
  }

  function readInternalConstantValue(block) {
    const props = block.getElementsByTagName("Props")[0];
    const valueEl = props?.getElementsByTagName("Value")[0];
    const propsValue = valueEl?.textContent?.trim();
    if (propsValue) {
      return { value: propsValue, storage: "Props" };
    }
    const opv = textContent(block, "OPV");
    if (opv) {
      const first = opv.split("|")[0];
      if (first !== "") {
        return { value: first, storage: "OPV" };
      }
    }
    return null;
  }

  function writeInternalConstantValue(block, doc, newValue) {
    const current = readInternalConstantValue(block);
    const oldValue = current?.value || "";

    if (!current || current.storage === "OPV") {
      let opvEl = block.getElementsByTagName("OPV")[0];
      if (!opvEl) {
        opvEl = doc.createElement("OPV");
        block.appendChild(opvEl);
        opvEl.textContent = `${newValue}|`;
        return `OPV: -> ${newValue}`;
      }
      const parts = opvEl.textContent.split("|");
      parts[0] = newValue;
      opvEl.textContent = parts.join("|");
      return oldValue !== newValue ? `OPV: ${oldValue} -> ${newValue}` : null;
    }

    let props = block.getElementsByTagName("Props")[0];
    if (!props) {
      props = doc.createElement("Props");
      block.appendChild(props);
    }
    let elem = props.getElementsByTagName("Value")[0];
    if (!elem) {
      elem = doc.createElement("Value");
      props.appendChild(elem);
    }
    if (elem.textContent?.trim() !== newValue) {
      const prior = elem.textContent?.trim() || "";
      elem.textContent = newValue;
      return `Value: ${prior} -> ${newValue}`;
    }
    return null;
  }

  function sortParameters(parameters) {
    const order = new Map();
    CATEGORY_SECTIONS.forEach((section, index) => {
      section.categories.forEach((category) => order.set(category, index));
    });
    return parameters.sort((a, b) => {
      const sectionDiff = (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99);
      if (sectionDiff !== 0) return sectionDiff;
      const left = `${a.name}|${a.field}`;
      const right = `${b.name}|${b.field}`;
      return left.localeCompare(right);
    });
  }

  function sectionForCategory(category) {
    const match = CATEGORY_SECTIONS.find((section) => section.categories.includes(category));
    return match ? match.label : category;
  }

  function normalizeXmlText(text) {
    let normalized = String(text).replace(/^\uFEFF/, "");
    if (/encoding=["']utf-16["']/i.test(normalized.slice(0, 160))) {
      normalized = normalized.replace(/encoding=["']utf-16["']/i, 'encoding="utf-8"');
    }
    return normalized;
  }

  function decodeUtf16Le(bytes) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return out;
  }

  function decodeXmlBytes(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return normalizeXmlText(decodeUtf16Le(bytes.subarray(2)));
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return normalizeXmlText(new TextDecoder("utf-8").decode(bytes.subarray(3)));
    }
    return normalizeXmlText(new TextDecoder("utf-8").decode(bytes));
  }

  async function readZipXmlText(zip, path) {
    const file = zip.file(path);
    if (!file) return null;
    const bytes = await file.async("uint8array");
    return decodeXmlBytes(bytes);
  }

  function parseXml(text) {
    const normalized = normalizeXmlText(text);
    const doc = new DOMParser().parseFromString(normalized, "application/xml");
    const parseError = doc.getElementsByTagName("parsererror")[0];
    if (parseError) {
      const detail = parseError.textContent?.trim().replace(/\s+/g, " ").slice(0, 180);
      throw new Error(detail ? `XML parse error: ${detail}` : "XML could not be parsed.");
    }
    return doc;
  }

  function detectXmlEncoding(text) {
    const match = text.match(/encoding=["']([^"']+)["']/i);
    return match ? match[1].toLowerCase() : "utf-8";
  }

  function serializeXmlDocument(doc, encoding = "utf-8") {
    const serialized = new XMLSerializer().serializeToString(doc.documentElement);
    return `<?xml version="1.0" encoding="${encoding}"}?>\n${serialized}`;
  }

  function encodeXmlText(text, encoding) {
    const normalized = encoding.toLowerCase();
    if (normalized.includes("utf-16")) {
      const bom = new Uint8Array([0xff, 0xfe]);
      const buffer = new ArrayBuffer(text.length * 2);
      const view = new Uint16Array(buffer);
      for (let i = 0; i < text.length; i += 1) {
        view[i] = text.charCodeAt(i);
      }
      const body = new Uint8Array(buffer);
      const out = new Uint8Array(bom.length + body.length);
      out.set(bom, 0);
      out.set(body, bom.length);
      return out;
    }
    return text;
  }

  function addBacnetMetadata(parameters, block, resourceTag) {
    const name = textContent(block, "NAME");
    for (const field of BACNET_METADATA_FIELDS) {
      const value = textContent(block, field);
      if (value === "") continue;
      parameters.push(
        makeParam({
          source: "Main.xml",
          category: "BacnetMetadata",
          name,
          field: `${resourceTag}.${field}`,
          value,
          index: textContent(block, "IDX"),
          controller_specific: textContent(block, "ControllerSpecific"),
          section: sectionForCategory("BacnetMetadata"),
        }),
      );
    }
  }

  function parseMainXmlParameters(mainXmlText) {
    const doc = parseXml(mainXmlText);
    const parameters = [];
    const blockIndex = buildBlockIndex(doc);
    const outgoingLinks = buildOutgoingLinks(doc);

    for (const block of childElements(doc.documentElement)) {
      const tag = block.tagName;

      if (DEFAULT_VALUE_BLOCKS[tag]) {
        const category = DEFAULT_VALUE_BLOCKS[tag];
        parameters.push(
          makeParam({
            source: "Main.xml",
            category,
            name: textContent(block, "NAME"),
            field: "DefaultValue",
            value: textContent(block, "DefaultValue"),
            index: textContent(block, "IDX"),
            controller_specific: textContent(block, "ControllerSpecific"),
            section: sectionForCategory(category),
          }),
        );
        addBacnetMetadata(parameters, block, tag);
      } else if (tag === "BacnetHardwareInputResource") {
        const name = textContent(block, "NAME");
        for (const field of HARDWARE_INPUT_FIELDS) {
          const value = textContent(block, field);
          if (!value) continue;
          parameters.push(
            makeParam({
              source: "Main.xml",
              category: "HardwareInput",
              name,
              field,
              value,
              index: textContent(block, "IDX"),
              section: sectionForCategory("HardwareInput"),
            }),
          );
        }
        addBacnetMetadata(parameters, block, tag);
      } else if (tag === "BacnetHardwareOutputResource") {
        const name = textContent(block, "NAME");
        for (const field of HARDWARE_OUTPUT_FIELDS) {
          const value = textContent(block, field);
          if (value === "") continue;
          parameters.push(
            makeParam({
              source: "Main.xml",
              category: "HardwareOutput",
              name,
              field,
              value,
              index: textContent(block, "IDX"),
              section: sectionForCategory("HardwareOutput"),
            }),
          );
        }
        addBacnetMetadata(parameters, block, tag);
      } else if (tag === "BacnetPidResource") {
        const name = textContent(block, "NAME");
        for (const field of PID_TUNING_FIELDS) {
          const value = textContent(block, field);
          if (value === "") continue;
          parameters.push(
            makeParam({
              source: "Main.xml",
              category: "PidTuning",
              name,
              field,
              value,
              index: textContent(block, "IDX"),
              section: sectionForCategory("PidTuning"),
            }),
          );
        }
        addBacnetMetadata(parameters, block, tag);
      } else if (tag === "SimpleCompositeBlock") {
        const compositeName = directChild(block, "Name")?.textContent?.trim() || "";
        if (!compositeName) continue;
        for (const row of block.getElementsByTagName("r")) {
          const rowType = row.getAttribute("et") || "";
          const portName = textContent(row, "Name");
          if (!portName) continue;
          const displayName = `${compositeName}.${portName}`;
          if (rowType === "ExportedInputPort") {
            for (const field of COMPOSITE_INPUT_FIELDS) {
              const value = textContent(row, field);
              if (value === "") continue;
              parameters.push(
                makeParam({
                  source: "Main.xml",
                  category: "CompositeInput",
                  name: displayName,
                  field,
                  value,
                  section: sectionForCategory("CompositeInput"),
                }),
              );
            }
          } else if (rowType === "ExportedOutputPort") {
            for (const field of COMPOSITE_OUTPUT_FIELDS) {
              const value = textContent(row, field);
              if (value === "") continue;
              parameters.push(
                makeParam({
                  source: "Main.xml",
                  category: "CompositeOutput",
                  name: displayName,
                  field,
                  value,
                  section: sectionForCategory("CompositeOutput"),
                }),
              );
            }
          }
        }
      } else if (tag === "InternalConstantNumeric") {
        const blockId = block.getAttribute("id") || "unknown";
        const rawName = textContent(block, "Name", "");
        const baseName = rawName && rawName !== "Internal Constant" ? rawName : "LogicConstant";
        const name = `${baseName}#${blockId}`;
        const read = readInternalConstantValue(block);
        if (!read) continue;
        const { usage, hint } = buildInternalConstantContext(blockId, read.value, blockIndex, outgoingLinks);
        parameters.push(
          makeParam({
            source: "Main.xml",
            category: "InternalConstant",
            name,
            field: "Value",
            value: read.value,
            context: usage,
            hint,
            section: sectionForCategory("InternalConstant"),
          }),
        );
      } else if (PROGRAMMING_CONSTANT_TAGS[tag]) {
        const blockId = block.getAttribute("id") || "unknown";
        const name = textContent(block, "Name") || `${tag}#${blockId}`;
        const props = block.getElementsByTagName("Props")[0];
        const valueEl = props?.getElementsByTagName("Value")[0];
        const value = valueEl?.textContent?.trim() || textContent(block, "IPV");
        if (!value) continue;
        parameters.push(
          makeParam({
            source: "Main.xml",
            category: "ProgrammingConstant",
            name: `${name} (${tag})`,
            field: "Value",
            value,
            section: sectionForCategory("ProgrammingConstant"),
          }),
        );
      }
    }

    return parameters;
  }

  function decodeBacnetObjectId(numericObjectId) {
    const id = Number(numericObjectId);
    return { type: id >> 22, instance: id & 0x3fffff };
  }

  function buildInternalPointMaps(internalPointsText) {
    const mapByOid = new Map();
    if (!internalPointsText) return { mapByOid };
    const doc = parseXml(internalPointsText);
    for (const point of doc.getElementsByTagName("Point")) {
      const name = textContent(point, "Name");
      const index = textContent(point, "Index");
      const type = point.getAttribute("type") || "";
      const bacnetType = BACNET_TYPE_FROM_POINT[type];
      if (!name || index === "" || bacnetType === undefined) continue;
      const oid = (bacnetType << 22) | Number(index);
      mapByOid.set(oid, name);
    }
    return { mapByOid };
  }

  function buildRegisterSectionMap(comConfigText) {
    const sections = new Map();
    if (!comConfigText) return sections;
    const doc = parseXml(comConfigText);
    for (const register of doc.getElementsByTagName("Register")) {
      const section = register.getAttribute("section") || "0";
      const name = register.getAttribute("name") || "";
      if (!sections.has(section)) sections.set(section, []);
      sections.get(section).push(name);
    }
    return sections;
  }

  function resolvePointName(numericObjectId, pointMap) {
    const oid = Number(numericObjectId);
    if (pointMap.mapByOid.has(oid)) return pointMap.mapByOid.get(oid);
    const { type, instance } = decodeBacnetObjectId(oid);
    return `BACnet type ${type} instance ${instance}`;
  }

  function parseBindingParameters(bindingPath, bindingText, registerSections, pointMap) {
    const doc = parseXml(bindingText);
    const parameters = [];
    for (const binding of doc.getElementsByTagName("Binding")) {
      const section = binding.getAttribute("registerSection") || "0";
      const regIndex = binding.getAttribute("registerIndex") || "0";
      const numericObjectId = binding.getAttribute("numericObjectId") || "";
      const writePriority = binding.getAttribute("writePriority") || "";
      const regs = registerSections.get(section) || [];
      const registerName = regs[Number(regIndex)] || `register${regIndex}`;
      const pointName = resolvePointName(numericObjectId, pointMap);
      const stableName = `sec${section}[${regIndex}].${registerName}`;
      const displayContext = `${registerName} → ${pointName}`;
      const hint = `Com sensor register mapped to BACnet point (priority ${writePriority || "?"})`;
      for (const [field, value] of [
        ["numericObjectId", numericObjectId],
        ["writePriority", writePriority],
      ]) {
        if (value === "") continue;
        parameters.push(
          makeParam({
            source: bindingPath,
            category: "ComSensorBinding",
            name: stableName,
            field,
            value,
            index: displayContext,
            context: displayContext,
            hint,
            section: sectionForCategory("ComSensorBinding"),
          }),
        );
      }
    }
    return parameters;
  }

  function parseComSensorParameters(comConfigText) {
    const doc = parseXml(comConfigText);
    const parameters = [];
    for (const register of doc.getElementsByTagName("Register")) {
      const name = register.getAttribute("name") || "";
      for (const field of REGISTER_FIELDS) {
        if (!register.hasAttribute(field)) continue;
        parameters.push(
          makeParam({
            source: COM_CONFIG_PATH,
            category: "ComSensorRegister",
            name,
            field,
            value: register.getAttribute(field) || "",
            section: sectionForCategory("ComSensorRegister"),
          }),
        );
      }
    }
    return parameters;
  }

  function parseScheduleParameters(path, scheduleText) {
    const doc = parseXml(scheduleText);
    const schedule = doc.documentElement;
    const scheduleName = schedule.getAttribute("name") || path.split("/").pop().replace(".xml", "");
    const parameters = [];

    const defaultValue = schedule.getElementsByTagName("DefaultValue")[0];
    if (defaultValue) {
      parameters.push(
        makeParam({
          source: path,
          category: "Schedule",
          name: scheduleName,
          field: "DefaultValue.numeric",
          value: defaultValue.getAttribute("value") || defaultValue.getAttribute("numeric") || "",
          index: schedule.getAttribute("index") || "",
          section: sectionForCategory("Schedule"),
        }),
      );
      parameters.push(
        makeParam({
          source: path,
          category: "Schedule",
          name: scheduleName,
          field: "DefaultValue.label",
          value: defaultValue.getAttribute("value") || "",
          section: sectionForCategory("Schedule"),
        }),
      );
    }

    const eventDefault = schedule.getElementsByTagName("EventDefaultValue")[0];
    if (eventDefault) {
      parameters.push(
        makeParam({
          source: path,
          category: "Schedule",
          name: scheduleName,
          field: "EventDefaultValue.numeric",
          value: eventDefault.getAttribute("numeric") || "",
          section: sectionForCategory("Schedule"),
        }),
      );
    }

    for (const day of schedule.getElementsByTagName("Day")) {
      const dayName = day.getAttribute("name") || `Day${day.getAttribute("index") || ""}`;
      for (const timeValue of day.getElementsByTagName("TimeValue")) {
        const time = timeValue.getElementsByTagName("Time")[0];
        const value = timeValue.getElementsByTagName("Value")[0];
        if (!time || !value) continue;
        const hh = time.getAttribute("h") || "0";
        const mm = time.getAttribute("m") || "0";
        const label = `${scheduleName}.${dayName}.${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
        parameters.push(
          makeParam({
            source: path,
            category: "ScheduleTime",
            name: label,
            field: "occupancy.label",
            value: value.getAttribute("value") || "",
            section: sectionForCategory("ScheduleTime"),
          }),
        );
        parameters.push(
          makeParam({
            source: path,
            category: "ScheduleTime",
            name: label,
            field: "occupancy.numeric",
            value: value.getAttribute("bacnetNumeric") || value.getAttribute("lonNumeric") || "",
            section: sectionForCategory("ScheduleTime"),
          }),
        );
      }
    }

    return parameters;
  }

  function parseAllParameters(mainXmlText, comConfigText, scheduleFiles, bindingFiles = {}, internalPointsText = null) {
    const parameters = parseMainXmlParameters(mainXmlText);
    const registerSections = buildRegisterSectionMap(comConfigText);
    const pointMap = buildInternalPointMaps(internalPointsText);
    if (comConfigText) {
      parameters.push(...parseComSensorParameters(comConfigText));
    }
    for (const [path, file] of Object.entries(bindingFiles)) {
      parameters.push(...parseBindingParameters(path, file.text, registerSections, pointMap));
    }
    for (const [path, file] of Object.entries(scheduleFiles)) {
      parameters.push(...parseScheduleParameters(path, file.text));
    }
    return sortParameters(parameters);
  }

  function setChildText(block, doc, tag, value) {
    let elem = block.getElementsByTagName(tag)[0];
    if (!elem) {
      elem = doc.createElement(tag);
      block.appendChild(elem);
    }
    const oldValue = elem.textContent?.trim() || "";
    if (oldValue !== value) {
      elem.textContent = value;
      return `${tag}: ${oldValue} -> ${value}`;
    }
    return null;
  }

  function applyMainXmlUpdates(mainXmlText, updates) {
    const doc = parseXml(mainXmlText);
    const changed = [];
    const internalConstantCounts = new Map();

    for (const block of childElements(doc.documentElement)) {
      const tag = block.tagName;

      if (DEFAULT_VALUE_BLOCKS[tag]) {
        const category = DEFAULT_VALUE_BLOCKS[tag];
        const name = textContent(block, "NAME");
        const key = paramKey("Main.xml", category, name, "DefaultValue");
        if (key in updates) {
          const diff = setChildText(block, doc, "DefaultValue", updates[key]);
          if (diff) changed.push(`${category}.${name}.${diff}`);
        }
        for (const field of BACNET_METADATA_FIELDS) {
          const metaKey = paramKey("Main.xml", "BacnetMetadata", name, `${tag}.${field}`);
          if (!(metaKey in updates)) continue;
          const diff = setChildText(block, doc, field, updates[metaKey]);
          if (diff) changed.push(`BacnetMetadata.${name}.${field}: ${diff}`);
        }
      } else if (tag === "BacnetHardwareInputResource" || tag === "BacnetHardwareOutputResource") {
        const name = textContent(block, "NAME");
        const fieldList = tag === "BacnetHardwareInputResource" ? HARDWARE_INPUT_FIELDS : HARDWARE_OUTPUT_FIELDS;
        const category = tag === "BacnetHardwareInputResource" ? "HardwareInput" : "HardwareOutput";
        for (const field of fieldList) {
          const key = paramKey("Main.xml", category, name, field);
          if (!(key in updates)) continue;
          const diff = setChildText(block, doc, field, updates[key]);
          if (diff) changed.push(`${category}.${name}.${diff}`);
        }
        for (const field of BACNET_METADATA_FIELDS) {
          const metaKey = paramKey("Main.xml", "BacnetMetadata", name, `${tag}.${field}`);
          if (!(metaKey in updates)) continue;
          const diff = setChildText(block, doc, field, updates[metaKey]);
          if (diff) changed.push(`BacnetMetadata.${name}.${field}: ${diff}`);
        }
      } else if (tag === "BacnetPidResource") {
        const name = textContent(block, "NAME");
        for (const field of PID_TUNING_FIELDS) {
          const key = paramKey("Main.xml", "PidTuning", name, field);
          if (!(key in updates)) continue;
          const diff = setChildText(block, doc, field, updates[key]);
          if (diff) changed.push(`PidTuning.${name}.${diff}`);
        }
        for (const field of BACNET_METADATA_FIELDS) {
          const metaKey = paramKey("Main.xml", "BacnetMetadata", name, `${tag}.${field}`);
          if (!(metaKey in updates)) continue;
          const diff = setChildText(block, doc, field, updates[metaKey]);
          if (diff) changed.push(`BacnetMetadata.${name}.${field}: ${diff}`);
        }
      } else if (tag === "SimpleCompositeBlock") {
        const compositeName = directChild(block, "Name")?.textContent?.trim() || "";
        for (const row of block.getElementsByTagName("r")) {
          const rowType = row.getAttribute("et") || "";
          const portName = textContent(row, "Name");
          if (!portName || !compositeName) continue;
          const displayName = `${compositeName}.${portName}`;
          const category = rowType === "ExportedInputPort" ? "CompositeInput" : rowType === "ExportedOutputPort" ? "CompositeOutput" : "";
          if (!category) continue;
          const fields = category === "CompositeInput" ? COMPOSITE_INPUT_FIELDS : COMPOSITE_OUTPUT_FIELDS;
          for (const field of fields) {
            const key = paramKey("Main.xml", category, displayName, field);
            if (!(key in updates)) continue;
            const diff = setChildText(row, doc, field, updates[key]);
            if (diff) changed.push(`${category}.${displayName}.${diff}`);
          }
        }
      } else if (tag === "InternalConstantNumeric") {
        const blockId = block.getAttribute("id") || "unknown";
        const rawName = textContent(block, "Name", "");
        const baseName = rawName && rawName !== "Internal Constant" ? rawName : "LogicConstant";
        const name = `${baseName}#${blockId}`;
        const key = paramKey("Main.xml", "InternalConstant", name, "Value");
        if (!(key in updates)) continue;
        const diff = writeInternalConstantValue(block, doc, updates[key]);
        if (diff) changed.push(`InternalConstant.${name}.${diff}`);
      } else if (PROGRAMMING_CONSTANT_TAGS[tag]) {
        const blockId = block.getAttribute("id") || "unknown";
        const baseName = textContent(block, "Name") || `${tag}#${blockId}`;
        const name = `${baseName} (${tag})`;
        const key = paramKey("Main.xml", "ProgrammingConstant", name, "Value");
        if (!(key in updates)) continue;
        let props = block.getElementsByTagName("Props")[0];
        if (!props) {
          props = doc.createElement("Props");
          block.appendChild(props);
        }
        let elem = props.getElementsByTagName("Value")[0];
        if (!elem) {
          elem = doc.createElement("Value");
          props.appendChild(elem);
        }
        const oldValue = elem.textContent?.trim() || "";
        if (oldValue !== updates[key]) {
          elem.textContent = updates[key];
          changed.push(`ProgrammingConstant.${name}.Value: ${oldValue} -> ${updates[key]}`);
        }
      }
    }

    return { xml: serializeXmlDocument(doc, "utf-8"), changed };
  }

  function applyComConfigUpdates(comConfigText, updates) {
    const doc = parseXml(comConfigText);
    const changed = [];
    for (const register of doc.getElementsByTagName("Register")) {
      const name = register.getAttribute("name") || "";
      for (const field of REGISTER_FIELDS) {
        const key = paramKey(COM_CONFIG_PATH, "ComSensorRegister", name, field);
        if (!(key in updates)) continue;
        const oldValue = register.getAttribute(field) || "";
        if (oldValue !== updates[key]) {
          register.setAttribute(field, updates[key]);
          changed.push(`ComSensorRegister.${name}.${field}: ${oldValue} -> ${updates[key]}`);
        }
      }
    }
    return { xml: serializeXmlDocument(doc, "utf-8"), changed };
  }

  function applyScheduleUpdates(path, scheduleText, updates, encoding) {
    const doc = parseXml(scheduleText);
    const schedule = doc.documentElement;
    const scheduleName = schedule.getAttribute("name") || path.split("/").pop().replace(".xml", "");
    const changed = [];

    const defaultValue = schedule.getElementsByTagName("DefaultValue")[0];
    if (defaultValue) {
      for (const [field, attr] of [
        ["DefaultValue.numeric", "numeric"],
        ["DefaultValue.label", "value"],
      ]) {
        const key = paramKey(path, "Schedule", scheduleName, field);
        if (!(key in updates)) continue;
        const oldValue = defaultValue.getAttribute(attr) || "";
        if (oldValue !== updates[key]) {
          defaultValue.setAttribute(attr, updates[key]);
          changed.push(`Schedule.${scheduleName}.${field}: ${oldValue} -> ${updates[key]}`);
        }
      }
    }

    const eventDefault = schedule.getElementsByTagName("EventDefaultValue")[0];
    if (eventDefault) {
      const key = paramKey(path, "Schedule", scheduleName, "EventDefaultValue.numeric");
      if (key in updates) {
        const oldValue = eventDefault.getAttribute("numeric") || "";
        if (oldValue !== updates[key]) {
          eventDefault.setAttribute("numeric", updates[key]);
          changed.push(`Schedule.${scheduleName}.EventDefaultValue.numeric: ${oldValue} -> ${updates[key]}`);
        }
      }
    }

    for (const day of schedule.getElementsByTagName("Day")) {
      const dayName = day.getAttribute("name") || `Day${day.getAttribute("index") || ""}`;
      for (const timeValue of day.getElementsByTagName("TimeValue")) {
        const time = timeValue.getElementsByTagName("Time")[0];
        const value = timeValue.getElementsByTagName("Value")[0];
        if (!time || !value) continue;
        const hh = time.getAttribute("h") || "0";
        const mm = time.getAttribute("m") || "0";
        const label = `${scheduleName}.${dayName}.${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
        for (const [field, attr] of [
          ["occupancy.label", "value"],
          ["occupancy.numeric", "bacnetNumeric"],
        ]) {
          const key = paramKey(path, "ScheduleTime", label, field);
          if (!(key in updates)) continue;
          const oldValue = value.getAttribute(attr) || "";
          if (oldValue !== updates[key]) {
            value.setAttribute(attr, updates[key]);
            if (field === "occupancy.label" && !value.getAttribute("value")) {
              value.setAttribute("value", updates[key]);
            }
            changed.push(`ScheduleTime.${label}.${field}: ${oldValue} -> ${updates[key]}`);
          }
        }
      }
    }

    return { xml: serializeXmlDocument(doc, encoding), changed };
  }

  function parametersToUpdates(parameters) {
    const updates = {};
    for (const param of parameters) {
      updates[paramKey(param.source, param.category, param.name, param.field)] = param.value;
    }
    return updates;
  }

  function cloneParameters(parameters) {
    return parameters.map((param) => ({ ...param }));
  }

  function applyBindingUpdates(bindingPath, bindingText, updates, encoding, registerSections) {
    const doc = parseXml(bindingText);
    const changed = [];
    for (const binding of doc.getElementsByTagName("Binding")) {
      const section = binding.getAttribute("registerSection") || "0";
      const regIndex = binding.getAttribute("registerIndex") || "0";
      const regs = registerSections.get(section) || [];
      const registerName = regs[Number(regIndex)] || `register${regIndex}`;
      const stableName = `sec${section}[${regIndex}].${registerName}`;
      for (const field of ["numericObjectId", "writePriority"]) {
        const key = paramKey(bindingPath, "ComSensorBinding", stableName, field);
        if (!(key in updates)) continue;
        const oldValue = binding.getAttribute(field) || "";
        const newValue = updates[key];
        if (oldValue !== newValue) {
          binding.setAttribute(field, newValue);
          changed.push(`ComSensorBinding.${stableName}.${field}: ${oldValue} -> ${newValue}`);
        }
      }
    }
    return { xml: serializeXmlDocument(doc, encoding), changed };
  }

  async function loadGfxArchive(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const mainXmlText = await readZipXmlText(zip, "Main.xml");
    if (!mainXmlText) {
      throw new Error("Main.xml not found inside .gfx archive.");
    }
    const comConfigText = await readZipXmlText(zip, COM_CONFIG_PATH);

    const scheduleFiles = {};
    const bindingFiles = {};
    for (const path of Object.keys(zip.files)) {
      if (path.startsWith("Config/Bacnet/Schedules/") && path.endsWith(".xml")) {
        const text = await readZipXmlText(zip, path);
        if (text) scheduleFiles[path] = { text, encoding: detectXmlEncoding(text) };
      }
      if (path.startsWith("Config/Bacnet/ComSensors/") && /Bindings.*\.xml$/i.test(path)) {
        const text = await readZipXmlText(zip, path);
        if (text) bindingFiles[path] = { text, encoding: detectXmlEncoding(text) };
      }
    }

    const internalPointsText = await readZipXmlText(zip, INTERNAL_POINTS_PATH);

    const parameters = parseAllParameters(mainXmlText, comConfigText, scheduleFiles, bindingFiles, internalPointsText);
    const wiringGraph = parseWiringGraph(mainXmlText);

    let projectName = "";
    const infoText = await readZipXmlText(zip, "Info/ProjectInfo.xml");
    if (infoText) {
      try {
        const infoDoc = parseXml(infoText);
        projectName = textContent(infoDoc.documentElement, "Name");
      } catch {
        projectName = "";
      }
    }

    return {
      mainXmlText,
      comConfigText,
      scheduleFiles,
      bindingFiles,
      internalPointsText,
      wiringGraph,
      parameters,
      projectName,
      originalBuffer: arrayBuffer,
    };
  }

  async function buildModifiedGfx(archiveState, parameters) {
    const updates = parametersToUpdates(parameters);
    const changed = [];
    const registerSections = buildRegisterSectionMap(archiveState.comConfigText);

    const mainResult = applyMainXmlUpdates(archiveState.mainXmlText, updates);
    changed.push(...mainResult.changed);

    let comConfigXml = archiveState.comConfigText;
    if (archiveState.comConfigText) {
      const comResult = applyComConfigUpdates(archiveState.comConfigText, updates);
      comConfigXml = comResult.xml;
      changed.push(...comResult.changed);
    }

    const bindingOutputs = {};
    for (const [path, file] of Object.entries(archiveState.bindingFiles || {})) {
      const bindingResult = applyBindingUpdates(path, file.text, updates, file.encoding, registerSections);
      bindingOutputs[path] = bindingResult.xml;
      changed.push(...bindingResult.changed);
    }

    const scheduleOutputs = {};
    for (const [path, file] of Object.entries(archiveState.scheduleFiles || {})) {
      const scheduleResult = applyScheduleUpdates(path, file.text, updates, file.encoding);
      scheduleOutputs[path] = scheduleResult.xml;
      changed.push(...scheduleResult.changed);
    }

    const zip = await JSZip.loadAsync(archiveState.originalBuffer);
    zip.file("Main.xml", mainResult.xml);
    if (archiveState.comConfigText && comConfigXml) {
      zip.file(COM_CONFIG_PATH, comConfigXml);
    }
    for (const [path, xml] of Object.entries(bindingOutputs)) {
      const encoding = archiveState.bindingFiles[path]?.encoding || "utf-8";
      zip.file(path, encodeXmlText(xml, encoding));
    }
    for (const [path, xml] of Object.entries(scheduleOutputs)) {
      const encoding = archiveState.scheduleFiles[path]?.encoding || "utf-8";
      zip.file(path, encodeXmlText(xml, encoding));
    }

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    return { blob, changed };
  }

  function parametersToCsv(parameters) {
    const header = "source,category,name,field,value,index,controller_specific,section,context,tier";
    const lines = parameters.map((param) => {
      const cells = [
        param.source,
        param.category,
        param.name,
        param.field,
        param.value,
        param.index || "",
        param.controller_specific || "",
        param.section || "",
        param.context || "",
        param.tier || "",
      ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`);
      return cells.join(",");
    });
    return [header, ...lines].join("\n");
  }

  function countByCategory(parameters) {
    const counts = {};
    for (const param of parameters) {
      counts[param.category] = (counts[param.category] || 0) + 1;
    }
    return counts;
  }

  const WIRING_IDB_NAME = "distechGfxWiring";
  const WIRING_IDB_STORE = "payloads";
  const WIRING_LOCAL_BYTE_LIMIT = 1_800_000;

  function labelFromBlockMeta(meta, blockId) {
    if (!meta) return `Block#${blockId}`;
    const name = sanitizeDisplayText(meta.n, "");
    const tag = meta.t || "?";
    if (name && !["Internal Constant", "Monitor"].includes(name)) {
      return name.includes(tag) ? name : `${name} (${tag})`;
    }
    if (tag === "InternalConstantNumeric") return `LogicConstant#${blockId}`;
    return `${tag}#${blockId}`;
  }

  function registerBlockMeta(registry, id, tag, name, sheet, tagName) {
    if (!id) return;
    const existing = registry[id];
    if (!existing) {
      registry[id] = { t: tag || "?", n: name || "", s: sheet || "", g: tagName || "" };
      return;
    }
    if (tag && existing.t === "?") existing.t = tag;
    if (name && !existing.n) existing.n = name;
    if (sheet && !existing.s) existing.s = sheet;
    if (tagName && !existing.g) existing.g = tagName;
  }

  function compactWiringForViewer(wiring) {
    const blocks = {};
    for (const link of wiring.links || []) {
      registerBlockMeta(blocks, link.from.id, link.from.tag, link.from.name, link.from.sheet);
      registerBlockMeta(blocks, link.to.id, link.to.tag, link.to.name, link.to.sheet);
    }
    for (const sheet of wiring.sheetDiagrams || []) {
      for (const block of sheet.blocks || []) {
        registerBlockMeta(blocks, block.id, block.tag, block.name, sheet.name, block.tagName);
      }
    }

    return {
      _c: 1,
      blocks,
      links: (wiring.links || []).map((link) => [
        link.from.id,
        link.from.port || "",
        link.to.id,
        link.to.port || "",
      ]),
      crossReferences: wiring.crossReferences || [],
      composites: (wiring.composites || []).map((composite) => [composite.id, composite.name, composite.sheet || ""]),
      sheets: wiring.sheets || [],
      blockTypes: wiring.blockTypes || [],
      sheetDiagrams: (wiring.sheetDiagrams || []).map((sheet) => ({
        i: sheet.docId,
        n: sheet.name,
        b: sheet.bounds,
        k: (sheet.blocks || []).map((block) => [block.id, block.category, block.x, block.y, block.w, block.h]),
        l: (sheet.links || []).map((link) => [link.fromId, link.fromPort || "", link.toId, link.toPort || ""]),
      })),
      blockCount: wiring.blockCount || 0,
      linkCount: wiring.linkCount || 0,
      compositeCount: wiring.compositeCount || 0,
      sheetDiagramCount: wiring.sheetDiagramCount || 0,
      crossRefCount: wiring.crossRefCount || 0,
      hubCount: wiring.hubCount || 0,
      targetCount: wiring.targetCount || 0,
    };
  }

  function isCompactWiring(wiring) {
    return Boolean(wiring && wiring._c === 1);
  }

  function expandWiringForViewer(compact) {
    if (!compact) return compact;
    if (!isCompactWiring(compact)) return compact;

    const blocks = compact.blocks || {};
    function endpoint(id, port) {
      const meta = blocks[id] || { t: "?", n: "", s: "", g: "" };
      return {
        id,
        tag: meta.t,
        name: meta.n,
        label: labelFromBlockMeta(meta, id),
        port: port || "",
        sheet: meta.s || "",
      };
    }

    const links = (compact.links || []).map(([fromId, fromPort, toId, toPort]) => ({
      id: "",
      from: endpoint(fromId, fromPort),
      to: endpoint(toId, toPort),
    }));

    const focusBlocks = new Map();
    for (const wire of links) {
      focusBlocks.set(wire.from.id, wire.from.label);
      focusBlocks.set(wire.to.id, wire.to.label);
    }
    const focusOptions = [...focusBlocks.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const composites = (compact.composites || []).map(([id, name, sheet]) => ({
      id,
      name,
      label: `${name} (${id})`,
      sheet,
    }));

    const sheetDiagrams = (compact.sheetDiagrams || []).map((sheet) => {
      const sheetBlocks = (sheet.k || []).map(([id, category, x, y, w, h]) => {
        const meta = blocks[id] || { t: "?", n: "", g: "" };
        return {
          id,
          tag: meta.t,
          name: meta.n,
          tagName: meta.g || "",
          label: labelFromBlockMeta(meta, id),
          category,
          x,
          y,
          w,
          h,
          cx: x + w / 2,
          cy: y + h / 2,
        };
      });
      const sheetLinks = (sheet.l || []).map(([fromId, fromPort, toId, toPort]) => ({
        fromId,
        toId,
        fromPort,
        toPort,
      }));
      return {
        docId: sheet.i,
        name: sheet.n,
        bounds: sheet.b,
        blockCount: sheetBlocks.length,
        linkCount: sheetLinks.length,
        blocks: sheetBlocks,
        links: sheetLinks,
      };
    });

    return {
      links,
      composites,
      focusOptions,
      blockTypes: compact.blockTypes || [],
      sheets: compact.sheets || [],
      crossReferences: compact.crossReferences || [],
      sheetDiagrams,
      blockCount: compact.blockCount || 0,
      linkCount: compact.linkCount || links.length,
      compositeCount: compact.compositeCount || composites.length,
      sheetDiagramCount: compact.sheetDiagramCount || sheetDiagrams.length,
      crossRefCount: compact.crossRefCount || 0,
      hubCount: compact.hubCount || 0,
      targetCount: compact.targetCount || 0,
    };
  }

  function openWiringDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(WIRING_IDB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(WIRING_IDB_STORE)) {
          db.createObjectStore(WIRING_IDB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key) {
    const db = await openWiringDb();
    try {
      const tx = db.transaction(WIRING_IDB_STORE, "readonly");
      return await idbRequest(tx.objectStore(WIRING_IDB_STORE).get(key));
    } finally {
      db.close();
    }
  }

  async function idbSet(key, value) {
    const db = await openWiringDb();
    try {
      const tx = db.transaction(WIRING_IDB_STORE, "readwrite");
      tx.objectStore(WIRING_IDB_STORE).put(value, key);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function pruneWiringStorage(prefix, keepKey) {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix) && key !== keepKey) {
        localStorage.removeItem(key);
      }
    }

    if (typeof indexedDB === "undefined") return;
    const db = await openWiringDb();
    try {
      const tx = db.transaction(WIRING_IDB_STORE, "readwrite");
      const store = tx.objectStore(WIRING_IDB_STORE);
      const keys = await idbRequest(store.getAllKeys());
      for (const key of keys) {
        const keyText = String(key);
        if (keyText.startsWith(prefix) && keyText !== keepKey) {
          store.delete(key);
        }
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async function saveWiringViewerPayload(storageKey, payload, prefix) {
    const slim = {
      ...payload,
      wiring: compactWiringForViewer(payload.wiring),
    };
    const json = JSON.stringify(slim);
    const sizeMb = (json.length / (1024 * 1024)).toFixed(1);

    if (json.length <= WIRING_LOCAL_BYTE_LIMIT) {
      try {
        localStorage.setItem(storageKey, json);
        await pruneWiringStorage(prefix, storageKey);
        return { storage: "local", bytes: json.length, sizeMb };
      } catch {
        // Fall through to IndexedDB for quota errors on large-but-under-limit payloads.
      }
    }

    if (typeof indexedDB === "undefined") {
      throw new Error(`Wiring data is ${sizeMb} MB — browser storage is full. Close other tabs for this site.`);
    }

    await idbSet(storageKey, json);
    localStorage.removeItem(storageKey);
    await pruneWiringStorage(prefix, storageKey);
    return { storage: "idb", bytes: json.length, sizeMb };
  }

  async function loadWiringViewerPayload(storageKey, prefix, preferIdb = false) {
    const keysToTry = storageKey ? [storageKey] : [`${prefix}latest`];

    for (const key of keysToTry) {
      const readers = preferIdb
        ? [
            async () => idbGet(key),
            async () => localStorage.getItem(key),
          ]
        : [
            async () => localStorage.getItem(key),
            async () => idbGet(key),
          ];

      for (const read of readers) {
        let raw = null;
        try {
          raw = await read();
        } catch {
          continue;
        }
        if (!raw) continue;
        try {
          const payload = JSON.parse(raw);
          if (payload.wiring) {
            payload.wiring = expandWiringForViewer(payload.wiring);
          }
          return payload;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  const UTILITY_STUB_PATTERN =
    /\b(valid|validated|validation|backup|connected|connectivity|monitor|spare|dummy|fault|fail|failed|inhibit|alarm|interlock|outofservice|out_of_service)\b/i;

  const UTILITY_ROLE_HELP = {
    dead_output: "Input is wired in but the output goes nowhere — often backup validation or an unfinished branch.",
    no_effect_path: "Not on any path to hardware output or a shared reference tag — no effect on real control.",
    validation_name: "Block name suggests input validation, fault handling, or backup logic.",
    monitor: "Monitor block — usually watches a signal without driving control outputs.",
    isolated: "Not connected to any wires on the project.",
    bacnet_sidecar: "BACnet mapping/register block — may be intentional metadata, not main control logic.",
  };

  function buildWiringBlockMeta(wiring) {
    const meta = new Map();
    function ingest(id, tag, name, label, sheet, tagName = "") {
      if (!id) return;
      const existing = meta.get(id);
      if (!existing) {
        meta.set(id, {
          id,
          tag: tag || "?",
          name: name || "",
          label: label || "",
          sheet: sheet || "",
          tagName: tagName || "",
        });
        return;
      }
      if (tag && existing.tag === "?") existing.tag = tag;
      if (name && !existing.name) existing.name = name;
      if (label && !existing.label) existing.label = label;
      if (sheet && !existing.sheet) existing.sheet = sheet;
      if (tagName && !existing.tagName) existing.tagName = tagName;
    }

    for (const link of wiring.links || []) {
      ingest(link.from.id, link.from.tag, link.from.name, link.from.label, link.from.sheet);
      ingest(link.to.id, link.to.tag, link.to.name, link.to.label, link.to.sheet);
    }
    for (const sheet of wiring.sheetDiagrams || []) {
      for (const block of sheet.blocks || []) {
        ingest(block.id, block.tag, block.name, block.label, sheet.name, block.tagName);
      }
    }
    return meta;
  }

  function isControlEffectSink(tag) {
    if (tag === "OutgoingTag") return true;
    if (tag.includes("HardwareOutput")) return true;
    return false;
  }

  function isBenignSourceTag(tag) {
    return tag === "IncomingTag" || tag === "InternalConstantNumeric";
  }

  function isBacnetSidecarTag(tag) {
    return tag.includes("SmartVue") || tag.includes("BacnetRegister") || tag === "BacnetSmartVueCondition";
  }

  function scoreUtilityRoles(roles) {
    const weights = {
      isolated: 4,
      dead_output: 3,
      no_effect_path: 2,
      validation_name: 2,
      monitor: 2,
      bacnet_sidecar: 1,
    };
    return roles.reduce((sum, role) => sum + (weights[role] || 1), 0);
  }

  function analyzeNonFunctionalBlocks(wiring) {
    if (!wiring?.links?.length) {
      return { entries: [], summary: { total: 0, highConfidence: 0, monitor: 0, deadOutput: 0 } };
    }

    const meta = buildWiringBlockMeta(wiring);
    const outgoing = new Map();
    const incoming = new Map();
    const blockIds = new Set();

    for (const link of wiring.links) {
      blockIds.add(link.from.id);
      blockIds.add(link.to.id);
      if (!outgoing.has(link.from.id)) outgoing.set(link.from.id, []);
      if (!incoming.has(link.to.id)) incoming.set(link.to.id, []);
      outgoing.get(link.from.id).push(link);
      incoming.get(link.to.id).push(link);
    }

    const reachesEffect = new Set();
    const queue = [...blockIds].filter((id) => isControlEffectSink(meta.get(id)?.tag || ""));
    for (const id of queue) reachesEffect.add(id);
    while (queue.length) {
      const id = queue.shift();
      for (const link of incoming.get(id) || []) {
        if (!reachesEffect.has(link.from.id)) {
          reachesEffect.add(link.from.id);
          queue.push(link.from.id);
        }
      }
    }

    const entries = [];
    for (const id of blockIds) {
      const block = meta.get(id) || { id, tag: "?", name: "", label: `Block#${id}`, sheet: "", tagName: "" };
      const inCount = (incoming.get(id) || []).length;
      const outCount = (outgoing.get(id) || []).length;
      const roles = [];
      const haystack = `${block.name} ${block.tagName} ${block.label}`;

      if (inCount === 0 && outCount === 0) roles.push("isolated");
      if (outCount === 0 && !isControlEffectSink(block.tag)) roles.push("dead_output");
      if (!reachesEffect.has(id) && !isBenignSourceTag(block.tag)) roles.push("no_effect_path");
      if (UTILITY_STUB_PATTERN.test(haystack)) roles.push("validation_name");
      if (block.tag === "Monitor" || block.name === "Monitor") roles.push("monitor");
      if (roles.includes("dead_output") && isBacnetSidecarTag(block.tag)) roles.push("bacnet_sidecar");

      if (!roles.length) continue;

      const score = scoreUtilityRoles(roles);
      const confidence = score >= 5 ? "high" : score >= 3 ? "medium" : "low";
      const displayName = sanitizeDisplayText(
        block.tagName || block.name || block.label,
        labelFromBlockMeta({ t: block.tag, n: block.name, g: block.tagName }, id),
      );

      entries.push({
        blockId: id,
        tag: block.tag,
        name: displayName,
        sheet: block.sheet || "—",
        roles,
        roleHelp: roles.map((role) => UTILITY_ROLE_HELP[role] || role),
        score,
        confidence,
        inputCount: inCount,
        outputCount: outCount,
        likelyBackup: roles.includes("monitor") || (roles.includes("dead_output") && roles.includes("no_effect_path")),
      });
    }

    entries.sort((a, b) => b.score - a.score || a.sheet.localeCompare(b.sheet) || a.name.localeCompare(b.name));

    return {
      entries,
      summary: {
        total: entries.length,
        highConfidence: entries.filter((entry) => entry.confidence === "high").length,
        monitor: entries.filter((entry) => entry.roles.includes("monitor")).length,
        deadOutput: entries.filter((entry) => entry.roles.includes("dead_output")).length,
        likelyBackup: entries.filter((entry) => entry.likelyBackup).length,
      },
    };
  }

  return {
    COM_CONFIG_PATH,
    CATEGORY_SECTIONS,
    OTHER_CATEGORIES,
    DEFAULT_VALUE_BLOCKS,
    BACNET_RESOURCE_TAGS,
    isOtherCategory,
    sanitizeDisplayText,
    formatParameterValue,
    sanitizeBlockName,
    tracePortFlow,
    traceSignalChain,
    resolveParamSignal,
    portsForBlock,
    blockLabelFromGraph,
    paramKey,
    sectionForCategory,
    parseAllParameters,
    parseWiringGraph,
    lookupCrossReference,
    parametersToUpdates,
    cloneParameters,
    loadGfxArchive,
    buildModifiedGfx,
    parametersToCsv,
    countByCategory,
    compactWiringForViewer,
    expandWiringForViewer,
    saveWiringViewerPayload,
    loadWiringViewerPayload,
    analyzeNonFunctionalBlocks,
    UTILITY_ROLE_HELP,
  };
})();

if (typeof window !== "undefined") {
  window.GfxCore = GfxCore;
}
if (typeof globalThis !== "undefined") {
  globalThis.GfxCore = GfxCore;
}
