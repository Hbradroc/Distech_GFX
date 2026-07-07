/**
 * Distech EC-gfxProgram (.gfx) parameter extraction and updates.
 */
const GfxCore = (() => {
  const COM_CONFIG_PATH = "Config/Bacnet/ComSensors/CommonConfig.xml";

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

  const CATEGORY_SECTIONS = [
    { id: "setpoints", label: "Analog / binary setpoints", categories: ["AnalogValue", "BinaryValue", "MultiStateValue"] },
    { id: "hardware", label: "Hardware inputs & outputs", categories: ["HardwareInput", "HardwareOutput"] },
    { id: "pid", label: "PID tuning", categories: ["PidTuning"] },
    { id: "logic", label: "Logic module ports", categories: ["CompositeInput", "CompositeOutput"] },
    { id: "bacnet", label: "BACnet COV, alarms & metadata", categories: ["BacnetMetadata"] },
    { id: "schedules", label: "Schedules & calendars", categories: ["Schedule", "ScheduleTime"] },
    { id: "programming", label: "Programming sheet constants", categories: ["ProgrammingConstant"] },
    { id: "internal", label: "Internal logic constants", categories: ["InternalConstant"] },
    { id: "sensor", label: "Com sensor registers", categories: ["ComSensorRegister"] },
  ];

  function textContent(parent, tag, fallback = "") {
    const el = parent?.getElementsByTagName(tag)[0];
    if (!el || el.textContent == null) return fallback;
    return el.textContent.trim();
  }

  function directChild(parent, tag) {
    if (!parent) return null;
    return Array.from(parent.children).find((child) => child.tagName === tag) || null;
  }

  function paramKey(source, category, name, field) {
    return `${source}\0${category}\0${name}\0${field}`;
  }

  function makeParam({ source, category, name, field, value, index = "", controller_specific = "", section = "" }) {
    return { source, category, name, field, value, index, controller_specific, section };
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

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const parseError = doc.getElementsByTagName("parsererror")[0];
    if (parseError) {
      throw new Error("XML could not be parsed.");
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
    const internalConstantCounts = new Map();

    for (const block of doc.documentElement.children) {
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
        const count = internalConstantCounts.get(baseName) || 0;
        internalConstantCounts.set(baseName, count + 1);
        const name = `${baseName}#${blockId}`;
        const props = block.getElementsByTagName("Props")[0];
        const valueEl = props?.getElementsByTagName("Value")[0];
        const value = valueEl?.textContent?.trim() || "";
        if (!value) continue;
        parameters.push(
          makeParam({
            source: "Main.xml",
            category: "InternalConstant",
            name,
            field: "Value",
            value,
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

  function parseAllParameters(mainXmlText, comConfigText, scheduleFiles) {
    const parameters = parseMainXmlParameters(mainXmlText);
    if (comConfigText) {
      parameters.push(...parseComSensorParameters(comConfigText));
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

    for (const block of doc.documentElement.children) {
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
          changed.push(`InternalConstant.${name}.Value: ${oldValue} -> ${updates[key]}`);
        }
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

  async function loadGfxArchive(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const mainFile = zip.file("Main.xml");
    if (!mainFile) {
      throw new Error("Main.xml not found inside .gfx archive.");
    }

    const mainXmlText = await mainFile.async("string");
    const comFile = zip.file(COM_CONFIG_PATH);
    const comConfigText = comFile ? await comFile.async("string") : null;

    const scheduleFiles = {};
    for (const path of Object.keys(zip.files)) {
      if (!path.startsWith("Config/Bacnet/Schedules/") || !path.endsWith(".xml")) continue;
      const text = await zip.file(path).async("string");
      scheduleFiles[path] = { text, encoding: detectXmlEncoding(text) };
    }

    const parameters = parseAllParameters(mainXmlText, comConfigText, scheduleFiles);

    let projectName = "";
    const infoFile = zip.file("Info/ProjectInfo.xml");
    if (infoFile) {
      const infoText = await infoFile.async("string");
      const infoDoc = parseXml(infoText);
      projectName = textContent(infoDoc.documentElement, "Name");
    }

    return {
      mainXmlText,
      comConfigText,
      scheduleFiles,
      parameters,
      projectName,
      originalBuffer: arrayBuffer,
    };
  }

  async function buildModifiedGfx(archiveState, parameters) {
    const updates = parametersToUpdates(parameters);
    const changed = [];

    const mainResult = applyMainXmlUpdates(archiveState.mainXmlText, updates);
    changed.push(...mainResult.changed);

    let comConfigXml = archiveState.comConfigText;
    if (archiveState.comConfigText) {
      const comResult = applyComConfigUpdates(archiveState.comConfigText, updates);
      comConfigXml = comResult.xml;
      changed.push(...comResult.changed);
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
    const header = "source,category,name,field,value,index,controller_specific,section";
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
    DEFAULT_VALUE_BLOCKS,
    BACNET_RESOURCE_TAGS,
    paramKey,
    sectionForCategory,
    parseAllParameters,
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
