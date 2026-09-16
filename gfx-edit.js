/*
 * gfx-edit.js
 *
 * Structural editing layer for EC-gfxProgram Main.xml documents.
 *
 * gfx-core.js reads a .gfx and rewrites scalar parameter values. This module adds the
 * missing half: creating, moving, wiring and deleting the blocks themselves, plus
 * pasting a Library .sptx snippet into a project sheet.
 *
 * Main.xml is a flat document. Every block, link and composite internal is a direct
 * child of <Root>; ownership is expressed by <Doc ref="..."> pointing at the owning
 * DrawingDocument (sheet) or SimpleCompositeBlock, and mirrored in the owner's <Shps>
 * ShapeCollection. Keeping those two representations in agreement is the whole job.
 */
(function () {
  "use strict";

  /* Namespace descriptors. Indices differ per document, so always resolve by value. */
  const NS_SHAPES = { value: "Distech.Gpl.Model.Shapes", asm: "DC.Gpl.Model" };
  const NS_BLOCKS = { value: "Distech.Gpl.Model.Shapes.Blocks", asm: "DC.Gpl.Model" };
  const NS_COLLECTIONS = { value: "System.Collections", asm: "mscorlib" };

  /* EC-gfxProgram snaps to a 12-unit grid. */
  const GRID = 12;

  const SHEET_TAGS = ["DrawingDocument", "SimpleCompositeBlock", "PageSetup"];

  /* Root children that describe the snippet envelope rather than its content. */
  const SNIPPET_ENVELOPE_TAGS = ["Namespaces", "CodeSnippetPlaceHolder"];

  // ---------------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------------

  function childElements(el) {
    if (!el) return [];
    const out = [];
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1) out.push(node);
    }
    return out;
  }

  function firstChild(el, name) {
    if (!el) return null;
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1 && node.nodeName === name) return node;
    }
    return null;
  }

  function childText(el, name) {
    const child = firstChild(el, name);
    return child ? (child.textContent || "").trim() : "";
  }

  function setChildText(doc, el, name, value) {
    let child = firstChild(el, name);
    if (!child) {
      child = doc.createElement(name);
      el.appendChild(child);
    }
    child.textContent = String(value);
    return child;
  }

  function parseXml(text) {
    let normalized = String(text).replace(/^\uFEFF/, "");
    if (/encoding=["']utf-16["']/i.test(normalized.slice(0, 160))) {
      normalized = normalized.replace(/encoding=["']utf-16["']/i, 'encoding="utf-8"');
    }
    const doc = new DOMParser().parseFromString(normalized, "application/xml");
    const failure = doc.getElementsByTagName("parsererror")[0];
    if (failure) {
      const detail = (failure.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
      throw new Error(detail ? `XML parse error: ${detail}` : "XML could not be parsed.");
    }
    return doc;
  }

  function serializeDocument(doc, encoding = "utf-8") {
    const body = new XMLSerializer().serializeToString(doc.documentElement);
    return `<?xml version="1.0" encoding="${encoding}"?>\r\n${body}`;
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  /**
   * Wrap a Main.xml document in an editable session.
   * @param {string} mainXmlText
   * @returns {object} session
   */
  function createSession(mainXmlText) {
    const doc = parseXml(mainXmlText);
    const session = {
      doc,
      root: doc.documentElement,
      idIndex: new Map(),
      maxId: 0,
      changes: [],
      warnings: [],
    };
    reindex(session);
    return session;
  }

  function reindex(session) {
    session.idIndex.clear();
    session.maxId = 0;
    const all = session.root.getElementsByTagName("*");
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      const id = el.getAttribute && el.getAttribute("id");
      if (!id) continue;
      session.idIndex.set(id, el);
      const numeric = Number(id);
      if (Number.isFinite(numeric) && numeric > session.maxId) session.maxId = numeric;
    }
  }

  function nextId(session) {
    session.maxId += 1;
    return String(session.maxId);
  }

  function elementById(session, id) {
    return session.idIndex.get(String(id)) || null;
  }

  function requireElement(session, id, what = "element") {
    const el = elementById(session, id);
    if (!el) throw new Error(`Cannot find ${what} with id ${id}.`);
    return el;
  }

  function registerElement(session, el) {
    const id = el.getAttribute("id");
    if (!id) return;
    session.idIndex.set(id, el);
    const numeric = Number(id);
    if (Number.isFinite(numeric) && numeric > session.maxId) session.maxId = numeric;
  }

  function note(session, message) {
    session.changes.push(message);
  }

  function warn(session, message) {
    if (!session.warnings.includes(message)) session.warnings.push(message);
  }

  // ---------------------------------------------------------------------------
  // Namespaces
  // ---------------------------------------------------------------------------

  function namespacesHolder(session) {
    let holder = firstChild(session.root, "Namespaces");
    if (!holder) {
      holder = session.doc.createElement("Namespaces");
      session.root.insertBefore(holder, session.root.firstChild);
    }
    return holder;
  }

  /** Resolve a namespace descriptor to this document's index, adding it when absent. */
  function namespaceIndex(session, ns) {
    const holder = namespacesHolder(session);
    const entries = childElements(holder);
    for (const entry of entries) {
      if (entry.getAttribute("value") === ns.value) return entry.getAttribute("index");
    }
    let next = 0;
    for (const entry of entries) {
      const idx = Number(entry.getAttribute("index"));
      if (Number.isFinite(idx) && idx >= next) next = idx + 1;
    }
    const created = session.doc.createElement(`Namespace${next}`);
    created.setAttribute("index", String(next));
    created.setAttribute("value", ns.value);
    created.setAttribute("asm", ns.asm);
    holder.appendChild(created);
    note(session, `Added namespace ${ns.value} at index ${next}.`);
    return String(next);
  }

  // ---------------------------------------------------------------------------
  // Bounds
  // ---------------------------------------------------------------------------

  function readBounds(el) {
    const raw = childText(el, "Bds");
    if (!raw) return null;
    const parts = raw.split(",").map((part) => Number(part.trim()));
    if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) return null;
    const [x1, y1, x2, y2] = parts;
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    return { x, y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  function writeBounds(session, el, x, y, w, h) {
    setChildText(session.doc, el, "Bds", `${Math.round(x)},${Math.round(y)},${Math.round(x + w)},${Math.round(y + h)}`);
  }

  function snap(value, grid = GRID) {
    return Math.round(value / grid) * grid;
  }

  // ---------------------------------------------------------------------------
  // Id collections (<IL>, <OL>, <Shps>, <Snippet>, ...)
  // ---------------------------------------------------------------------------

  function collectionIds(collectionEl) {
    if (!collectionEl) return [];
    const items = firstChild(collectionEl, "Items");
    const raw = items ? (items.textContent || "").trim() : "";
    if (!raw) return [];
    return raw.split(",").map((part) => part.trim()).filter(Boolean);
  }

  /**
   * Rewrite a collection element in place. Empty collections are collapsed to the
   * bare `<IL />` form EC-gfxProgram itself writes.
   */
  function writeCollection(session, collectionEl, ids, options) {
    const { et = "Link", nsIndex, collectionEt = "LinkCollection" } = options || {};
    while (collectionEl.firstChild) collectionEl.removeChild(collectionEl.firstChild);

    if (!ids.length) {
      collectionEl.removeAttribute("id");
      collectionEl.removeAttribute("ns");
      collectionEl.removeAttribute("et");
      return;
    }

    if (!collectionEl.getAttribute("id")) {
      const id = nextId(session);
      collectionEl.setAttribute("id", id);
      session.idIndex.set(id, collectionEl);
    }
    collectionEl.setAttribute("ns", nsIndex);
    collectionEl.setAttribute("et", collectionEt);

    setChildText(session.doc, collectionEl, "Cnt", String(ids.length));
    const items = session.doc.createElement("Items");
    items.setAttribute("t", "Array");
    items.setAttribute("ns", nsIndex);
    items.setAttribute("et", et);
    items.setAttribute("dim", String(ids.length));
    items.textContent = ids.join(",");
    collectionEl.appendChild(items);
    setChildText(session.doc, collectionEl, "AN", "False");
    setChildText(session.doc, collectionEl, "AMI", "True");
    setChildText(session.doc, collectionEl, "TNV", "False");
  }

  function ensureCollectionElement(session, owner, name) {
    let el = firstChild(owner, name);
    if (!el) {
      el = session.doc.createElement(name);
      owner.appendChild(el);
    }
    return el;
  }

  function addToCollection(session, owner, name, id, options) {
    const el = ensureCollectionElement(session, owner, name);
    const ids = collectionIds(el);
    if (ids.includes(String(id))) return;
    ids.push(String(id));
    writeCollection(session, el, ids, options);
  }

  function removeFromCollection(session, owner, name, id, options) {
    const el = firstChild(owner, name);
    if (!el) return;
    const ids = collectionIds(el).filter((value) => value !== String(id));
    writeCollection(session, el, ids, options);
  }

  function linkCollectionOptions(session) {
    const nsIndex = namespaceIndex(session, NS_BLOCKS);
    return { et: "Link", nsIndex, collectionEt: "LinkCollection" };
  }

  function shapeCollectionOptions(session) {
    const nsIndex = namespaceIndex(session, NS_SHAPES);
    return { et: "Shape", nsIndex, collectionEt: "ShapeCollection" };
  }

  // ---------------------------------------------------------------------------
  // Sheets
  // ---------------------------------------------------------------------------

  /** Every container a block can belong to: drawing sheets and composite bodies. */
  function listSheets(session) {
    const sheets = [];
    for (const el of childElements(session.root)) {
      if (!SHEET_TAGS.includes(el.nodeName)) continue;
      const id = el.getAttribute("id");
      if (!id) continue;
      sheets.push({
        docId: id,
        name: childText(el, "Name") || `${el.nodeName} ${id}`,
        tag: el.nodeName,
        isComposite: el.nodeName === "SimpleCompositeBlock",
      });
    }
    return sheets;
  }

  function ownerDocId(el) {
    const doc = firstChild(el, "Doc");
    return doc ? doc.getAttribute("ref") || "" : "";
  }

  function setOwnerDoc(session, el, docId) {
    let doc = firstChild(el, "Doc");
    if (!doc) {
      doc = session.doc.createElement("Doc");
      const bds = firstChild(el, "Bds");
      el.insertBefore(doc, bds || el.firstChild);
    }
    if (docId) doc.setAttribute("ref", String(docId));
    else doc.removeAttribute("ref");
  }

  /** Blocks whose <Doc ref> points at the given sheet. */
  function blocksOnSheet(session, docId) {
    return childElements(session.root).filter(
      (el) => el.getAttribute("id") && ownerDocId(el) === String(docId) && firstChild(el, "Bds")
    );
  }

  // ---------------------------------------------------------------------------
  // Port model
  // ---------------------------------------------------------------------------

  /** Port visibility strings are pipe-delimited, one field per port. */
  function portCount(el, tag) {
    const raw = childText(el, tag);
    if (!raw) return 0;
    const parts = raw.split("|");
    if (parts.length && parts[parts.length - 1] === "") parts.pop();
    return parts.length;
  }

  function parseOutputPortFormats(el) {
    const raw = childText(el, "OPF");
    if (!raw) return [];
    return raw
      .split("|")
      .map((entry) => /N="([^"]*)"/.exec(entry)?.[1] || "")
      .filter(Boolean);
  }

  /** Exported port rows carry real names and ordering for composite blocks. */
  function exportedPorts(el) {
    const dp = firstChild(el, "DP");
    if (!dp) return { inputs: [], outputs: [] };
    const items = firstChild(dp, "_items");
    const rows = childElements(items || dp).filter((row) => row.nodeName === "r");
    const inputs = [];
    const outputs = [];
    for (const row of rows) {
      const kind = row.getAttribute("et") || "";
      const bounds = readBounds(row);
      const entry = {
        name: childText(row, "Name"),
        elementId: row.getAttribute("id") || "",
        priority: Number(childText(row, "Pri")) || 0,
        order: bounds ? bounds.y : 0,
        visible: childText(row, "Vis") !== "False",
        defaultValue: childText(row, "OV"),
        connectType: childText(row, "CT"),
      };
      if (kind === "ExportedInputPort") inputs.push(entry);
      else if (kind === "ExportedOutputPort") outputs.push(entry);
    }
    const bySheetOrder = (a, b) => a.priority - b.priority || a.order - b.order;
    inputs.sort(bySheetOrder);
    outputs.sort(bySheetOrder);
    return { inputs, outputs };
  }

  /**
   * Best-effort input/output port list for a block.
   *
   * Composites declare real named ports. Primitives only declare port *counts*
   * (via <IPV>/<OPV>) plus output names in <OPF>, so input names are recovered
   * from the links that land on them and padded with positional fallbacks.
   */
  function describePorts(session, blockId, linkIndex) {
    const el = elementById(session, blockId);
    if (!el) return { inputs: [], outputs: [] };

    const exported = exportedPorts(el);
    if (exported.inputs.length || exported.outputs.length) {
      return {
        inputs: exported.inputs.map((port, i) => ({ ...port, index: i, direction: "in" })),
        outputs: exported.outputs.map((port, i) => ({ ...port, index: i, direction: "out" })),
      };
    }

    const connected = linkIndex ? linkIndex.byBlock.get(String(blockId)) : null;
    const inNames = [];
    const outNames = parseOutputPortFormats(el);
    if (connected) {
      for (const link of connected.incoming) {
        if (link.toPort && !inNames.includes(link.toPort)) inNames.push(link.toPort);
      }
      for (const link of connected.outgoing) {
        if (link.fromPort && !outNames.includes(link.fromPort)) outNames.push(link.fromPort);
      }
    }

    const inCount = Math.max(portCount(el, "IPV"), inNames.length);
    const outCount = Math.max(portCount(el, "OPV"), outNames.length, 1);

    const inputs = [];
    for (let i = 0; i < inCount; i += 1) {
      inputs.push({ name: inNames[i] || `In${i + 1}`, index: i, direction: "in", inferred: !inNames[i] });
    }
    const outputs = [];
    for (let i = 0; i < outCount; i += 1) {
      outputs.push({ name: outNames[i] || (outCount === 1 ? "Output" : `Out${i + 1}`), index: i, direction: "out", inferred: !outNames[i] });
    }
    return { inputs, outputs };
  }

  // ---------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------

  function isLink(el) {
    return el.nodeName === "Link";
  }

  function linkEndpoints(el) {
    return {
      id: el.getAttribute("id") || "",
      fromId: firstChild(el, "FB")?.getAttribute("ref") || "",
      fromPort: childText(el, "FP"),
      toId: firstChild(el, "TB")?.getAttribute("ref") || "",
      toPort: childText(el, "TP"),
    };
  }

  /** Index of every link keyed by id and by the blocks it touches. */
  function buildLinkIndex(session) {
    const byId = new Map();
    const byBlock = new Map();
    const touch = (blockId) => {
      if (!byBlock.has(blockId)) byBlock.set(blockId, { incoming: [], outgoing: [] });
      return byBlock.get(blockId);
    };
    for (const el of childElements(session.root)) {
      if (!isLink(el)) continue;
      const link = linkEndpoints(el);
      byId.set(link.id, link);
      if (link.fromId) touch(link.fromId).outgoing.push(link);
      if (link.toId) touch(link.toId).incoming.push(link);
    }
    return { byId, byBlock };
  }

  function addLink(session, { fromId, fromPort, toId, toPort }) {
    const from = requireElement(session, fromId, "source block");
    const to = requireElement(session, toId, "target block");
    const nsIndex = namespaceIndex(session, NS_BLOCKS);
    const id = nextId(session);

    const link = session.doc.createElement("Link");
    link.setAttribute("id", id);
    link.setAttribute("ns", nsIndex);
    link.setAttribute("refs", "2");

    const fb = session.doc.createElement("FB");
    fb.setAttribute("ref", String(fromId));
    link.appendChild(fb);
    setChildText(session.doc, link, "FP", fromPort || "Output");
    setChildText(session.doc, link, "FP_OUT", "True");
    const tb = session.doc.createElement("TB");
    tb.setAttribute("ref", String(toId));
    link.appendChild(tb);
    setChildText(session.doc, link, "TP", toPort || "");
    setChildText(session.doc, link, "TP_IN", "True");

    session.root.appendChild(link);
    registerElement(session, link);

    const options = linkCollectionOptions(session);
    addToCollection(session, from, "OL", id, options);
    addToCollection(session, to, "IL", id, options);

    note(session, `Linked ${fromId}.${fromPort || "Output"} -> ${toId}.${toPort || "?"} (link ${id}).`);
    return id;
  }

  function deleteLink(session, linkId) {
    const link = elementById(session, linkId);
    if (!link) return false;
    const { fromId, toId } = linkEndpoints(link);
    const options = linkCollectionOptions(session);
    const from = elementById(session, fromId);
    const to = elementById(session, toId);
    if (from) removeFromCollection(session, from, "OL", linkId, options);
    if (to) removeFromCollection(session, to, "IL", linkId, options);
    link.parentNode.removeChild(link);
    session.idIndex.delete(String(linkId));
    note(session, `Removed link ${linkId}.`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Block operations
  // ---------------------------------------------------------------------------

  function moveBlock(session, blockId, x, y, { snapToGrid = true } = {}) {
    const el = requireElement(session, blockId, "block");
    const bounds = readBounds(el);
    if (!bounds) throw new Error(`Block ${blockId} has no <Bds> to move.`);
    const nx = snapToGrid ? snap(x) : Math.round(x);
    const ny = snapToGrid ? snap(y) : Math.round(y);
    writeBounds(session, el, nx, ny, bounds.w, bounds.h);
    note(session, `Moved block ${blockId} to ${nx},${ny}.`);
    return { x: nx, y: ny, w: bounds.w, h: bounds.h };
  }

  function resizeBlock(session, blockId, w, h, { snapToGrid = true } = {}) {
    const el = requireElement(session, blockId, "block");
    const bounds = readBounds(el);
    if (!bounds) throw new Error(`Block ${blockId} has no <Bds> to resize.`);
    const nw = Math.max(GRID, snapToGrid ? snap(w) : Math.round(w));
    const nh = Math.max(GRID, snapToGrid ? snap(h) : Math.round(h));
    writeBounds(session, el, bounds.x, bounds.y, nw, nh);
    return { x: bounds.x, y: bounds.y, w: nw, h: nh };
  }

  function renameBlock(session, blockId, name) {
    const el = requireElement(session, blockId, "block");
    setChildText(session.doc, el, "Name", name);
    note(session, `Renamed block ${blockId} to "${name}".`);
  }

  /** Remove a block, everything it owns, and every link that touched it. */
  function deleteBlock(session, blockId) {
    const el = elementById(session, blockId);
    if (!el) return false;

    // Composite bodies own their internals; remove those first.
    for (const child of blocksOnSheet(session, blockId)) {
      const childId = child.getAttribute("id");
      if (childId && childId !== String(blockId)) deleteBlock(session, childId);
    }

    for (const link of childElements(session.root).filter(isLink)) {
      const endpoints = linkEndpoints(link);
      if (endpoints.fromId === String(blockId) || endpoints.toId === String(blockId)) {
        deleteLink(session, endpoints.id);
      }
    }

    const docId = ownerDocId(el);
    const owner = docId ? elementById(session, docId) : null;
    if (owner) removeFromCollection(session, owner, "Shps", blockId, shapeCollectionOptions(session));

    el.parentNode.removeChild(el);
    session.idIndex.delete(String(blockId));
    note(session, `Deleted block ${blockId}.`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Snippet insertion
  // ---------------------------------------------------------------------------

  function snippetTopLevelIds(snippetRoot) {
    const placeholder = firstChild(snippetRoot, "CodeSnippetPlaceHolder");
    const snippet = placeholder ? firstChild(placeholder, "Snippet") : null;
    return new Set(collectionIds(snippet));
  }

  function snippetResourceIds(snippetRoot) {
    const placeholder = firstChild(snippetRoot, "CodeSnippetPlaceHolder");
    const resources = placeholder ? firstChild(placeholder, "Resources") : null;
    return new Set(collectionIds(resources));
  }

  function collectIds(elements) {
    const ids = [];
    for (const el of elements) {
      if (el.getAttribute && el.getAttribute("id")) ids.push(el.getAttribute("id"));
      const nested = el.getElementsByTagName ? el.getElementsByTagName("*") : [];
      for (let i = 0; i < nested.length; i += 1) {
        const id = nested[i].getAttribute && nested[i].getAttribute("id");
        if (id) ids.push(id);
      }
    }
    return ids;
  }

  function remapTree(el, idMap, nsMap) {
    const apply = (node) => {
      const id = node.getAttribute("id");
      if (id && idMap.has(id)) node.setAttribute("id", idMap.get(id));
      const ref = node.getAttribute("ref");
      if (ref && idMap.has(ref)) node.setAttribute("ref", idMap.get(ref));
      const ns = node.getAttribute("ns");
      if (ns && nsMap.has(ns)) node.setAttribute("ns", nsMap.get(ns));

      // <Items> holds a comma-separated id list.
      if (node.nodeName === "Items" || node.nodeName === "_items") {
        const raw = (node.textContent || "").trim();
        if (raw && !/[<>]/.test(raw) && !node.getElementsByTagName("*").length) {
          const mapped = raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => idMap.get(part) || part);
          if (mapped.length) node.textContent = mapped.join(",");
        }
      }
    };
    apply(el);
    const nested = el.getElementsByTagName("*");
    for (let i = 0; i < nested.length; i += 1) apply(nested[i]);
  }

  function existingReferenceTags(session) {
    const tags = new Set();
    for (const el of childElements(session.root)) {
      const props = firstChild(el, "Props");
      const tag = props ? childText(props, "TagName") : "";
      if (tag) tags.add(tag);
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  }

  function usedResourceIndexes(session, tagName) {
    const used = new Set();
    for (const el of childElements(session.root)) {
      if (el.nodeName !== tagName) continue;
      const idx = childText(el, "IDX");
      if (idx) used.add(Number(idx));
    }
    return used;
  }

  /**
   * Paste a Library .sptx snippet onto a sheet.
   *
   * @param {object} session
   * @param {string} snippetXmlText Decoded Main.xml from the .sptx archive.
   * @param {{docId:string,x:number,y:number,title?:string}} options
   * @returns {{topLevelIds:string[], insertedIds:string[], resourceIds:string[], bounds:object, warnings:string[]}}
   */
  function insertSnippet(session, snippetXmlText, options) {
    const { docId, x = 0, y = 0, title = "" } = options || {};
    if (!docId) throw new Error("insertSnippet requires a target sheet docId.");
    const sheet = requireElement(session, docId, "target sheet");

    const snippetDoc = parseXml(snippetXmlText);
    const snippetRoot = snippetDoc.documentElement;
    const warnings = [];

    // 1. Namespace index remap (snippet index -> project index).
    const nsMap = new Map();
    const snippetNamespaces = firstChild(snippetRoot, "Namespaces");
    for (const entry of childElements(snippetNamespaces || snippetRoot)) {
      const index = entry.getAttribute("index");
      const value = entry.getAttribute("value");
      if (!index || !value) continue;
      nsMap.set(index, namespaceIndex(session, { value, asm: entry.getAttribute("asm") || "DC.Gpl.Model" }));
    }

    // 2. Content = every root child except the snippet envelope.
    const content = childElements(snippetRoot).filter((el) => !SNIPPET_ENVELOPE_TAGS.includes(el.nodeName));
    if (!content.length) throw new Error("Snippet contains no blocks.");

    const topLevel = snippetTopLevelIds(snippetRoot);
    const resources = snippetResourceIds(snippetRoot);

    // 3. Allocate fresh ids for everything the snippet defines.
    const idMap = new Map();
    for (const id of collectIds(content)) {
      if (!idMap.has(id)) idMap.set(id, nextId(session));
    }

    // 4. Import, remap, and place.
    const imported = [];
    for (const el of content) {
      const copy = session.doc.importNode(el, true);
      remapTree(copy, idMap, nsMap);
      imported.push({ copy, originalId: el.getAttribute("id") || "" });
    }

    const topLevelElements = imported.filter((entry) => topLevel.has(entry.originalId));
    const placed = topLevelElements.length ? topLevelElements : imported.filter((entry) => firstChild(entry.copy, "Bds"));

    // Offset the whole group so its top-left lands on the drop point.
    let minX = Infinity;
    let minY = Infinity;
    for (const entry of placed) {
      const bounds = readBounds(entry.copy);
      if (!bounds) continue;
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
    }
    const dx = Number.isFinite(minX) ? snap(x) - minX : 0;
    const dy = Number.isFinite(minY) ? snap(y) - minY : 0;

    const groupBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const entry of placed) {
      const bounds = readBounds(entry.copy);
      if (!bounds) continue;
      const nx = bounds.x + dx;
      const ny = bounds.y + dy;
      writeBounds(session, entry.copy, nx, ny, bounds.w, bounds.h);
      setOwnerDoc(session, entry.copy, docId);
      groupBounds.minX = Math.min(groupBounds.minX, nx);
      groupBounds.minY = Math.min(groupBounds.minY, ny);
      groupBounds.maxX = Math.max(groupBounds.maxX, nx + bounds.w);
      groupBounds.maxY = Math.max(groupBounds.maxY, ny + bounds.h);
    }

    // 5. Attach to the document.
    const insertedIds = [];
    for (const entry of imported) {
      session.root.appendChild(entry.copy);
      registerElement(session, entry.copy);
      const nested = entry.copy.getElementsByTagName("*");
      for (let i = 0; i < nested.length; i += 1) registerElement(session, nested[i]);
      const id = entry.copy.getAttribute("id");
      if (id) insertedIds.push(id);
    }

    // 6. Register placed shapes with the sheet's shape collection.
    const shapeOptions = shapeCollectionOptions(session);
    const topLevelIds = [];
    for (const entry of placed) {
      const id = entry.copy.getAttribute("id");
      if (!id) continue;
      topLevelIds.push(id);
      addToCollection(session, sheet, "Shps", id, shapeOptions);
    }

    // 7. Give imported resources unique indexes within the project.
    const resourceIds = [];
    for (const entry of imported) {
      if (!resources.has(entry.originalId)) continue;
      const id = entry.copy.getAttribute("id");
      if (id) resourceIds.push(id);
      const used = usedResourceIndexes(session, entry.copy.nodeName);
      const current = Number(childText(entry.copy, "IDX"));
      if (used.has(current)) {
        let candidate = 1;
        while (used.has(candidate)) candidate += 1;
        setChildText(session.doc, entry.copy, "IDX", String(candidate));
        warnings.push(
          `Resource "${childText(entry.copy, "NAME") || entry.copy.nodeName}" collided with an existing index and was renumbered to ${candidate}.`
        );
      }
    }

    note(session, `Inserted ${title || "snippet"} onto sheet ${docId} (${topLevelIds.length} shapes, ${insertedIds.length} elements).`);
    for (const message of warnings) warn(session, message);

    return {
      topLevelIds,
      insertedIds,
      resourceIds,
      idMap,
      bounds: Number.isFinite(groupBounds.minX) ? groupBounds : null,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Values to verify after an insert
  // ---------------------------------------------------------------------------

  const VERIFY_HINTS = {
    reference:
      "Reference tags are how this block finds signals on other sheets. The name must match a tag that already exists in your project, or the block reads nothing.",
    constant: "A fixed number baked into the logic — setpoints, deadbands, timers and limits all appear here.",
    pid: "PID loop tuning. Proportional band is in sensor units; integral and derivative times are in seconds.",
    port: "Default value used for this composite input when nothing is wired to it.",
    hardware: "Physical input/output scaling and limits. These must match the wiring and device range.",
    name: "Display name shown on the sheet.",
  };

  /**
   * Collect the values a user should confirm after inserting a snippet, each with
   * the plausible alternatives we can derive from the project.
   */
  function collectVerifiableValues(session, elementIds) {
    const ids = new Set((elementIds || []).map(String));
    const projectTags = existingReferenceTags(session);
    const rows = [];

    for (const el of childElements(session.root)) {
      const id = el.getAttribute("id");
      if (!id || !ids.has(id)) continue;
      const tag = el.nodeName;
      const label = childText(el, "Name") || tag;

      const props = firstChild(el, "Props");
      const tagName = props ? childText(props, "TagName") : "";
      if (tagName) {
        const direction = tag === "IncomingTag" ? "reads" : "writes";
        rows.push({
          elementId: id,
          blockTag: tag,
          kind: "reference",
          field: "Props/TagName",
          label: `${label} — reference tag`,
          value: tagName,
          options: projectTags,
          matchesProject: projectTags.includes(tagName),
          hint: `This block ${direction} the reference tag "${tagName}". ${VERIFY_HINTS.reference}`,
        });
      }

      if (tag === "InternalConstantNumeric" || /Constant$/.test(tag)) {
        const value = props ? childText(props, "Value") : "";
        rows.push({
          elementId: id,
          blockTag: tag,
          kind: "constant",
          field: "Props/Value",
          label: `${label} — constant`,
          value,
          options: [],
          hint: VERIFY_HINTS.constant,
        });
      }

      if (/PidResource$/.test(tag)) {
        for (const field of ["ProportionalBand", "IntegralTime", "DerivativeTime", "DeadBand", "Bias"]) {
          rows.push({
            elementId: id,
            blockTag: tag,
            kind: "pid",
            field,
            label: `${childText(el, "NAME") || label} — ${field}`,
            value: childText(el, field),
            options: [],
            hint: VERIFY_HINTS.pid,
          });
        }
      }

      if (/HardwareInputResource$|HardwareOutputResource$/.test(tag)) {
        for (const field of ["Minimum", "Maximum", "Default"]) {
          const value = childText(el, field);
          if (!value) continue;
          rows.push({
            elementId: id,
            blockTag: tag,
            kind: "hardware",
            field,
            label: `${childText(el, "NAME") || label} — ${field}`,
            value,
            options: [],
            hint: VERIFY_HINTS.hardware,
          });
        }
      }

      const ports = exportedPorts(el);
      for (const port of ports.inputs) {
        if (!port.elementId || port.defaultValue === "") continue;
        rows.push({
          elementId: port.elementId,
          blockTag: tag,
          kind: "port",
          field: "OV",
          label: `${label}.${port.name} — default`,
          value: port.defaultValue,
          options: [],
          hint: VERIFY_HINTS.port,
        });
      }
    }

    return rows;
  }

  /** Write back edited verification rows. */
  function applyVerifiedValues(session, rows) {
    let applied = 0;
    for (const row of rows || []) {
      const el = elementById(session, row.elementId);
      if (!el) continue;
      const [container, field] = row.field.includes("/") ? row.field.split("/") : [null, row.field];
      let target = el;
      if (container) {
        target = firstChild(el, container);
        if (!target) {
          target = session.doc.createElement(container);
          if (container === "Props") {
            target.setAttribute("id", nextId(session));
            target.setAttribute("ns", namespaceIndex(session, NS_SHAPES));
            target.setAttribute("et", "ShapePropertyBag");
          }
          el.appendChild(target);
        }
      }
      const current = childText(target, field);
      if (current === String(row.value)) continue;
      setChildText(session.doc, target, field, row.value);
      note(session, `${row.label}: ${current || "(empty)"} -> ${row.value}`);
      applied += 1;
    }
    return applied;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /** Cheap structural audit: dangling refs and collection/link disagreements. */
  function validate(session) {
    const errors = [];
    const warnings = [];
    const seenIds = new Set();

    const all = session.root.getElementsByTagName("*");
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      const id = el.getAttribute("id");
      if (id) {
        if (seenIds.has(id)) errors.push(`Duplicate id ${id} on <${el.nodeName}>.`);
        seenIds.add(id);
      }
      const ref = el.getAttribute("ref");
      if (ref && !session.idIndex.has(ref)) {
        errors.push(`<${el.nodeName} ref="${ref}"> points at a missing element.`);
      }
    }

    for (const el of childElements(session.root)) {
      if (!isLink(el)) continue;
      const link = linkEndpoints(el);
      const from = elementById(session, link.fromId);
      const to = elementById(session, link.toId);
      if (from && !collectionIds(firstChild(from, "OL")).includes(link.id)) {
        warnings.push(`Link ${link.id} is missing from block ${link.fromId} <OL>.`);
      }
      if (to && !collectionIds(firstChild(to, "IL")).includes(link.id)) {
        warnings.push(`Link ${link.id} is missing from block ${link.toId} <IL>.`);
      }
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  function serialize(session, encoding = "utf-8") {
    return serializeDocument(session.doc, encoding);
  }

  const GfxEdit = {
    GRID,
    createSession,
    reindex,
    serialize,
    validate,
    listSheets,
    blocksOnSheet,
    ownerDocId,
    elementById,
    readBounds,
    writeBounds,
    snap,
    buildLinkIndex,
    describePorts,
    exportedPorts,
    addLink,
    deleteLink,
    moveBlock,
    resizeBlock,
    renameBlock,
    deleteBlock,
    insertSnippet,
    collectVerifiableValues,
    applyVerifiedValues,
    existingReferenceTags,
  };

  if (typeof window !== "undefined") window.GfxEdit = GfxEdit;
  if (typeof globalThis !== "undefined") globalThis.GfxEdit = GfxEdit;
  if (typeof module !== "undefined" && module.exports) module.exports = GfxEdit;
})();
