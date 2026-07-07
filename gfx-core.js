/**
 * Core logic for Distech EC-gfxProgram (.gfx) parameter extraction and updates.
 * A .gfx file is a ZIP archive; Main.xml holds BACnet resources and logic blocks.
 */
const GfxCore = (() => {
  const DEFAULT_VALUE_BLOCKS = {
    BacnetAnalogValueResource: "AnalogValue",
    BacnetBinaryValueResource: "BinaryValue",
    BacnetMultiStateValueResource: "MultiStateValue",
  };

  const HARDWARE_INPUT_FIELDS = [
    "SignalOffset",
    "SignalLowLimit",
    "SignalHighLimit",
    "Offset",
    "Minimum",
    "Maximum",
    "Default",
  ];

  const REGISTER_FIELDS = ["defaultValue", "unit"];
  const COM_CONFIG_PATH = "Config/Bacnet/ComSensors/CommonConfig.xml";

  function textContent(parent, tag, fallback = "") {
    const el = parent?.getElementsByTagName(tag)[0];
    if (!el || el.textContent == null) return fallback;
    return el.textContent.trim();
  }

  function paramKey(source, category, name, field) {
    return `${source}\0${category}\0${name}\0${field}`;
  }

  function splitKey(key) {
    const [source, category, name, field] = key.split("\0");
    return { source, category, name, field };
  }

  function parseParametersFromMainXml(mainXmlText, comConfigText = null) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(mainXmlText, "application/xml");
    const parseError = doc.getElementsByTagName("parsererror")[0];
    if (parseError) {
      throw new Error("Main.xml could not be parsed as XML.");
    }

    const parameters = [];

    for (const block of doc.documentElement.children) {
      const tag = block.tagName;
      if (DEFAULT_VALUE_BLOCKS[tag]) {
        parameters.push({
          source: "Main.xml",
          category: DEFAULT_VALUE_BLOCKS[tag],
          name: textContent(block, "NAME"),
          field: "DefaultValue",
          value: textContent(block, "DefaultValue"),
          index: textContent(block, "IDX"),
          controller_specific: textContent(block, "ControllerSpecific"),
        });
      } else if (tag === "BacnetHardwareInputResource") {
        const name = textContent(block, "NAME");
        for (const field of HARDWARE_INPUT_FIELDS) {
          const value = textContent(block, field);
          if (value) {
            parameters.push({
              source: "Main.xml",
              category: "HardwareInput",
              name,
              field,
              value,
              index: textContent(block, "IDX"),
              controller_specific: "",
            });
          }
        }
      } else if (tag === "InternalConstantNumeric") {
        const props = block.getElementsByTagName("Props")[0];
        const valueEl = props?.getElementsByTagName("Value")[0];
        const value = valueEl?.textContent?.trim() || "";
        if (value) {
          parameters.push({
            source: "Main.xml",
            category: "InternalConstant",
            name: textContent(block, "Name", "Internal Constant"),
            field: "Value",
            value,
            index: "",
            controller_specific: "",
          });
        }
      }
    }

    if (comConfigText) {
      parameters.push(...parseComSensorParameters(comConfigText));
    }

    return parameters.sort((a, b) => {
      const left = `${a.category}|${a.name}|${a.field}`;
      const right = `${b.category}|${b.name}|${b.field}`;
      return left.localeCompare(right);
    });
  }

  function parseComSensorParameters(comConfigText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(comConfigText, "application/xml");
    const parameters = [];

    for (const register of doc.getElementsByTagName("Register")) {
      const name = register.getAttribute("name") || "";
      for (const field of REGISTER_FIELDS) {
        if (register.hasAttribute(field)) {
          parameters.push({
            source: COM_CONFIG_PATH,
            category: "ComSensorRegister",
            name,
            field,
            value: register.getAttribute(field) || "",
            index: "",
            controller_specific: "",
          });
        }
      }
    }

    return parameters;
  }

  function applyUpdatesToMainXml(mainXmlText, updates, comConfigText = null) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(mainXmlText, "application/xml");
    const changed = [];

    for (const block of doc.documentElement.children) {
      const tag = block.tagName;
      if (DEFAULT_VALUE_BLOCKS[tag]) {
        const category = DEFAULT_VALUE_BLOCKS[tag];
        const name = textContent(block, "NAME");
        const key = paramKey("Main.xml", category, name, "DefaultValue");
        if (!(key in updates)) continue;

        let elem = block.getElementsByTagName("DefaultValue")[0];
        if (!elem) {
          elem = doc.createElement("DefaultValue");
          block.appendChild(elem);
        }
        const oldValue = elem.textContent?.trim() || "";
        const newValue = updates[key];
        if (oldValue !== newValue) {
          elem.textContent = newValue;
          changed.push(`${category}.${name}.DefaultValue: ${oldValue} -> ${newValue}`);
        }
      } else if (tag === "BacnetHardwareInputResource") {
        const name = textContent(block, "NAME");
        for (const field of HARDWARE_INPUT_FIELDS) {
          const key = paramKey("Main.xml", "HardwareInput", name, field);
          if (!(key in updates)) continue;
          let elem = block.getElementsByTagName(field)[0];
          if (!elem) {
            elem = doc.createElement(field);
            block.appendChild(elem);
          }
          const oldValue = elem.textContent?.trim() || "";
          const newValue = updates[key];
          if (oldValue !== newValue) {
            elem.textContent = newValue;
            changed.push(`HardwareInput.${name}.${field}: ${oldValue} -> ${newValue}`);
          }
        }
      } else if (tag === "InternalConstantNumeric") {
        const name = textContent(block, "Name", "Internal Constant");
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
        const newValue = updates[key];
        if (oldValue !== newValue) {
          elem.textContent = newValue;
          changed.push(`InternalConstant.${name}.Value: ${oldValue} -> ${newValue}`);
        }
      }
    }

    const mainResult = serializeXmlDocument(doc);
    let comResult = comConfigText;
    if (comConfigText) {
      const comChanged = applyUpdatesToComConfig(comConfigText, updates);
      changed.push(...comChanged.changed);
      comResult = comChanged.xml;
    }

    return { mainXml: mainResult, comConfigXml: comResult, changed };
  }

  function applyUpdatesToComConfig(comConfigText, updates) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(comConfigText, "application/xml");
    const changed = [];

    for (const register of doc.getElementsByTagName("Register")) {
      const name = register.getAttribute("name") || "";
      for (const field of REGISTER_FIELDS) {
        const key = paramKey(COM_CONFIG_PATH, "ComSensorRegister", name, field);
        if (!(key in updates)) continue;
        const oldValue = register.getAttribute(field) || "";
        const newValue = updates[key];
        if (oldValue !== newValue) {
          register.setAttribute(field, newValue);
          changed.push(`ComSensorRegister.${name}.${field}: ${oldValue} -> ${newValue}`);
        }
      }
    }

    return { xml: serializeXmlDocument(doc), changed };
  }

  function serializeXmlDocument(doc) {
    const serialized = new XMLSerializer().serializeToString(doc.documentElement);
    return `<?xml version="1.0" encoding="utf-8"?>\n${serialized}`;
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
    const parameters = parseParametersFromMainXml(mainXmlText, comConfigText);

    let projectName = "";
    const infoFile = zip.file("Info/ProjectInfo.xml");
    if (infoFile) {
      const infoText = await infoFile.async("string");
      const infoDoc = new DOMParser().parseFromString(infoText, "application/xml");
      projectName = textContent(infoDoc.documentElement, "Name");
    }

    return {
      zip,
      mainXmlText,
      comConfigText,
      parameters,
      projectName,
      originalBuffer: arrayBuffer,
    };
  }

  async function buildModifiedGfx(archiveState, parameters) {
    const updates = parametersToUpdates(parameters);
    const { mainXml, comConfigXml, changed } = applyUpdatesToMainXml(
      archiveState.mainXmlText,
      updates,
      archiveState.comConfigText,
    );

    const zip = await JSZip.loadAsync(archiveState.originalBuffer);
    zip.file("Main.xml", mainXml);
    if (archiveState.comConfigText && comConfigXml) {
      zip.file(COM_CONFIG_PATH, comConfigXml);
    }

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    return { blob, changed };
  }

  function parametersToCsv(parameters) {
    const header = "source,category,name,field,value,index,controller_specific";
    const lines = parameters.map((param) => {
      const cells = [
        param.source,
        param.category,
        param.name,
        param.field,
        param.value,
        param.index,
        param.controller_specific,
      ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`);
      return cells.join(",");
    });
    return [header, ...lines].join("\n");
  }

  return {
    COM_CONFIG_PATH,
    DEFAULT_VALUE_BLOCKS,
    HARDWARE_INPUT_FIELDS,
    paramKey,
    splitKey,
    parseParametersFromMainXml,
    applyUpdatesToMainXml,
    parametersToUpdates,
    cloneParameters,
    loadGfxArchive,
    buildModifiedGfx,
    parametersToCsv,
  };
})();

if (typeof window !== "undefined") {
  window.GfxCore = GfxCore;
}
