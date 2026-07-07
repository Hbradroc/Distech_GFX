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
      index.set(id, {
        tag: el.tagName,
        name: textContent(el, "Name") || textContent(el, "NAME"),
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
    const name = block.name && !["Internal Constant", "Monitor"].includes(block.name) ? block.name : "";
    if (name) return `${name} (${block.tag})`;
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
      blockCount: blockIndex.size,
      linkCount: links.length,
      compositeCount: composites.length,
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

  return {
    COM_CONFIG_PATH,
    CATEGORY_SECTIONS,
    OTHER_CATEGORIES,
    DEFAULT_VALUE_BLOCKS,
    BACNET_RESOURCE_TAGS,
    isOtherCategory,
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
  };
})();

if (typeof window !== "undefined") {
  window.GfxCore = GfxCore;
}
if (typeof globalThis !== "undefined") {
  globalThis.GfxCore = GfxCore;
}
