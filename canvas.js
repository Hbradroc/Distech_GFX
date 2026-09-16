/*
 * canvas.js — interactive logic canvas for EC-gfxProgram .gfx projects.
 *
 * Reads the real block geometry out of Main.xml so a sheet looks the way it does
 * in EC-gfxProgram, lets you move blocks and drop in Library snippets, explains
 * what each block controls, and writes the result back into the .gfx archive.
 *
 * Editing goes through GfxEdit, which owns the XML. The scene rebuilt here is a
 * read model derived from that session, never a second source of truth.
 */
(function () {
  "use strict";

  const APP_VERSION = "1.20.1";
  const GRID = 12;
  const MIN_ZOOM = 0.15;
  const MAX_ZOOM = 4;

  // --------------------------------------------------------------- state ---

  const state = {
    fileName: "",
    projectName: "",
    originalBuffer: null,
    session: null,
    sheets: [],
    activeDocId: "",
    scene: null,
    selectedId: "",
    dirty: false,
    view: { tx: 0, ty: 0, k: 1 },
    trail: [], // breadcrumb from the drawing sheet down into nested composites
    projectIndex: null, // whole-project block/link index, rebuilt after any edit
    currentTrace: null,
    windows: new Map(), // floating block windows, keyed by block id
    catalog: null,
    knowledge: null,
    placement: null,
    pendingInsert: null,
    snippetCache: new Map(),
  };

  const svgNs = "http://www.w3.org/2000/svg";
  const nodes = new Map(); // blockId -> { group, body }
  const wires = new Map(); // linkId -> { path, link }

  let svg = null;
  let viewportGroup = null;
  let wireLayer = null;
  let blockLayer = null;
  let overlayLayer = null;

  const el = {};

  // ------------------------------------------------------------- helpers ---

  function $(id) {
    return document.getElementById(id);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }

  let toastTimer = 0;
  function toast(message, isError = false) {
    const node = el.toast;
    node.textContent = message;
    node.classList.toggle("error", Boolean(isError));
    node.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      node.hidden = true;
    }, isError ? 6000 : 3200);
  }

  function markDirty(dirty = true) {
    state.dirty = dirty;
    el.dirtyBadge.hidden = !dirty;
    el.exportBtn.disabled = !state.session;
  }

  // ------------------------------------------------------- block styling ---

  const CATEGORY_STYLE = {
    io: { fill: "#bfdbfe", stroke: "#1d4ed8", label: "Hardware I/O" },
    bacnet: { fill: "#fed7aa", stroke: "#c2410c", label: "BACnet object" },
    reference: { fill: "#bbf7d0", stroke: "#15803d", label: "Reference tag" },
    control: { fill: "#ddd6fe", stroke: "#6d28d9", label: "PID / control" },
    composite: { fill: "#fde68a", stroke: "#b45309", label: "Custom block" },
    constant: { fill: "#e5e7eb", stroke: "#6b7280", label: "Constant" },
    logic: { fill: "#e9d5ff", stroke: "#7e22ce", label: "Logic" },
  };

  function categoryForTag(tag) {
    if (tag === "IncomingTag" || tag === "OutgoingTag") return "reference";
    if (/Pid|JPID/.test(tag)) return "control";
    if (/HardwareInput|HardwareOutput/.test(tag)) return "io";
    if (/^Bacnet/.test(tag)) return "bacnet";
    if (tag === "SimpleCompositeBlock") return "composite";
    if (/Constant$/.test(tag)) return "constant";
    return "logic";
  }

  /** Split a CamelCase XML tag into readable words. */
  function humanizeTag(tag) {
    return String(tag)
      .replace(/^Bacnet/, "BACnet ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .trim();
  }

  function blockLabels(block) {
    const friendly = humanizeTag(block.tag);
    const name = block.name && block.name !== block.tag ? block.name : "";
    if (block.tagName) return { title: block.tagName, subtitle: friendly };
    if (name) return { title: name, subtitle: friendly };
    return { title: friendly, subtitle: "" };
  }

  // ---------------------------------------------------------- scene model ---

  function textOf(element, name) {
    if (!element) return "";
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1 && node.nodeName === name) return (node.textContent || "").trim();
    }
    return "";
  }

  function buildScene(docId) {
    const session = state.session;
    const linkIndex = window.GfxEdit.buildLinkIndex(session);
    const blocks = [];
    const byId = new Map();

    for (const element of window.GfxEdit.blocksOnSheet(session, docId)) {
      const id = element.getAttribute("id");
      const bounds = window.GfxEdit.readBounds(element);
      if (!id || !bounds) continue;
      let props = null;
      for (let n = element.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n.nodeName === "Props") props = n;
      }
      const block = {
        id,
        tag: element.nodeName,
        name: textOf(element, "Name"),
        tagName: props ? textOf(props, "TagName") : "",
        x: bounds.x,
        y: bounds.y,
        w: Math.max(bounds.w, GRID * 2),
        h: Math.max(bounds.h, GRID),
        category: categoryForTag(element.nodeName),
        ports: window.GfxEdit.describePorts(session, id, linkIndex),
      };
      // Blocks with real port names get an EC-gfxProgram style title band so the
      // name does not sit on top of the port list.
      const named = block.ports.inputs.concat(block.ports.outputs).some((port) => !port.inferred);
      block.headerHeight = named && block.h >= 44 ? 20 : 0;
      blocks.push(block);
      byId.set(id, block);
    }

    const links = [];
    for (const link of linkIndex.byId.values()) {
      if (!byId.has(link.fromId) || !byId.has(link.toId)) continue;
      links.push(link);
    }

    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const block of blocks) {
      bounds.minX = Math.min(bounds.minX, block.x);
      bounds.minY = Math.min(bounds.minY, block.y);
      bounds.maxX = Math.max(bounds.maxX, block.x + block.w);
      bounds.maxY = Math.max(bounds.maxY, block.y + block.h);
    }
    if (!blocks.length) Object.assign(bounds, { minX: 0, minY: 0, maxX: 1200, maxY: 800 });

    return { docId, blocks, byId, links, bounds, linkIndex };
  }

  function portIndex(block, portName, direction) {
    const list = direction === "in" ? block.ports.inputs : block.ports.outputs;
    if (!list.length) return { index: 0, count: 1 };
    const found = list.findIndex((port) => port.name === portName);
    return { index: found >= 0 ? found : 0, count: list.length };
  }

  function portPoint(block, index, count, direction) {
    const top = block.headerHeight || 0;
    const usable = block.h - top;
    const y = block.y + top + (usable * (index + 1)) / (count + 1);
    const x = direction === "in" ? block.x : block.x + block.w;
    return { x, y };
  }

  function linkGeometry(link) {
    const from = state.scene.byId.get(link.fromId);
    const to = state.scene.byId.get(link.toId);
    if (!from || !to) return null;
    const out = portIndex(from, link.fromPort, "out");
    const into = portIndex(to, link.toPort, "in");
    const a = portPoint(from, out.index, out.count, "out");
    const b = portPoint(to, into.index, into.count, "in");
    const dx = Math.max(24, Math.abs(b.x - a.x) * 0.45);
    return `M${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  // -------------------------------------------------------------- render ---

  function createSvg() {
    el.canvasHost.innerHTML = "";
    svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("xmlns", svgNs);

    const defs = document.createElementNS(svgNs, "defs");
    defs.innerHTML = `
      <pattern id="gridPattern" width="${GRID * 4}" height="${GRID * 4}" patternUnits="userSpaceOnUse">
        <path d="M ${GRID * 4} 0 L 0 0 0 ${GRID * 4}" class="grid-line" fill="none" />
      </pattern>
      <marker id="arrowHead" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 7 4 L 0 7 z" fill="#94a3b8" />
      </marker>`;
    svg.appendChild(defs);

    viewportGroup = document.createElementNS(svgNs, "g");
    svg.appendChild(viewportGroup);

    const background = document.createElementNS(svgNs, "rect");
    background.setAttribute("class", "sheet-bg");
    background.setAttribute("id", "sheetBackground");
    viewportGroup.appendChild(background);

    wireLayer = document.createElementNS(svgNs, "g");
    blockLayer = document.createElementNS(svgNs, "g");
    overlayLayer = document.createElementNS(svgNs, "g");
    viewportGroup.append(wireLayer, blockLayer, overlayLayer);
    el.canvasHost.appendChild(svg);

    attachCanvasEvents();
    el.canvasLegend.hidden = false;
    return svg;
  }

  function renderScene() {
    nodes.clear();
    wires.clear();
    createSvg();

    const { bounds } = state.scene;
    const pad = 240;
    const background = svg.querySelector("#sheetBackground");
    background.setAttribute("x", bounds.minX - pad);
    background.setAttribute("y", bounds.minY - pad);
    background.setAttribute("width", bounds.maxX - bounds.minX + pad * 2);
    background.setAttribute("height", bounds.maxY - bounds.minY + pad * 2);
    background.setAttribute("fill", "url(#gridPattern)");

    for (const link of state.scene.links) renderWire(link);
    for (const block of state.scene.blocks) renderBlock(block);
  }

  function renderWire(link) {
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("class", "wire");
    path.setAttribute("marker-end", "url(#arrowHead)");
    const d = linkGeometry(link);
    if (d) path.setAttribute("d", d);
    wireLayer.appendChild(path);
    wires.set(link.id || `${link.fromId}:${link.fromPort}:${link.toId}:${link.toPort}`, { path, link });
  }

  function truncate(text, maxWidth, fontSize) {
    const perChar = fontSize * 0.56;
    const max = Math.floor(maxWidth / perChar);
    if (max <= 1) return "";
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
  }

  function renderBlock(block) {
    const style = CATEGORY_STYLE[block.category] || CATEGORY_STYLE.logic;
    const group = document.createElementNS(svgNs, "g");
    group.setAttribute("class", "block");
    group.setAttribute("transform", `translate(${block.x},${block.y})`);
    group.dataset.id = block.id;

    const body = document.createElementNS(svgNs, "rect");
    body.setAttribute("class", "block-body");
    body.setAttribute("width", block.w);
    body.setAttribute("height", block.h);
    body.setAttribute("rx", 4);
    body.setAttribute("fill", style.fill);
    body.setAttribute("stroke", style.stroke);
    group.appendChild(body);

    const labels = blockLabels(block);
    const header = block.headerHeight || 0;

    if (header) {
      const divider = document.createElementNS(svgNs, "line");
      divider.setAttribute("class", "block-divider");
      divider.setAttribute("x1", 0);
      divider.setAttribute("y1", header);
      divider.setAttribute("x2", block.w);
      divider.setAttribute("y2", header);
      divider.setAttribute("stroke", style.stroke);
      group.appendChild(divider);
    }

    // Reference-tag bars are only one grid unit tall, so height drives the size.
    const band = header || block.h;
    const hasSub = Boolean(labels.subtitle) && !header && block.h >= 34;
    const fontSize = clamp(Math.min(block.w / 7, hasSub ? block.h / 3 : band * 0.72), 5, 11);

    if (block.w >= 24 && block.h >= 8) {
      const title = document.createElementNS(svgNs, "text");
      title.setAttribute("class", "block-title");
      title.setAttribute("x", block.w / 2);
      title.setAttribute("y", header ? header / 2 : hasSub ? block.h / 2 - fontSize * 0.6 : block.h / 2);
      title.setAttribute("text-anchor", "middle");
      title.setAttribute("font-size", fontSize);
      title.setAttribute("font-weight", "500");
      title.textContent = truncate(labels.title, block.w - 8, fontSize);
      group.appendChild(title);

      if (hasSub) {
        const subtitle = document.createElementNS(svgNs, "text");
        subtitle.setAttribute("class", "block-subtitle");
        subtitle.setAttribute("x", block.w / 2);
        subtitle.setAttribute("y", block.h / 2 + fontSize * 0.75);
        subtitle.setAttribute("text-anchor", "middle");
        subtitle.setAttribute("font-size", fontSize * 0.82);
        subtitle.textContent = truncate(labels.subtitle, block.w - 8, fontSize * 0.82);
        group.appendChild(subtitle);
      }
    }

    const connected = state.scene.linkIndex.byBlock.get(block.id);
    renderPorts(group, block, "in", connected);
    renderPorts(group, block, "out", connected);

    blockLayer.appendChild(group);
    nodes.set(block.id, { group, body });
  }

  function renderPorts(group, block, direction, connected) {
    const list = direction === "in" ? block.ports.inputs : block.ports.outputs;
    if (!list.length) return;
    const used = new Set(
      direction === "in"
        ? (connected?.incoming || []).map((link) => link.toPort)
        : (connected?.outgoing || []).map((link) => link.fromPort)
    );
    const usable = block.h - (block.headerHeight || 0);
    const showLabels = usable / (list.length + 1) >= 9 && block.w >= 70;

    list.forEach((port, index) => {
      const point = portPoint(block, index, list.length, direction);
      const localX = direction === "in" ? 0 : block.w;
      const localY = point.y - block.y;

      const dot = document.createElementNS(svgNs, "circle");
      dot.setAttribute("class", used.has(port.name) ? "port connected" : "port");
      dot.setAttribute("cx", localX);
      dot.setAttribute("cy", localY);
      dot.setAttribute("r", 2.4);
      const title = document.createElementNS(svgNs, "title");
      title.textContent = `${direction === "in" ? "Input" : "Output"}: ${port.name}`;
      dot.appendChild(title);
      group.appendChild(dot);

      if (showLabels && !port.inferred) {
        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("class", "port-label");
        label.setAttribute("x", direction === "in" ? 4 : block.w - 4);
        label.setAttribute("y", localY);
        label.setAttribute("text-anchor", direction === "in" ? "start" : "end");
        label.setAttribute("font-size", 6.5);
        label.textContent = truncate(port.name, block.w * 0.44, 6.5);
        group.appendChild(label);
      }
    });
  }

  function updateBlockPosition(block) {
    const node = nodes.get(block.id);
    if (node) node.group.setAttribute("transform", `translate(${block.x},${block.y})`);
    for (const { path, link } of wires.values()) {
      if (link.fromId !== block.id && link.toId !== block.id) continue;
      const d = linkGeometry(link);
      if (d) path.setAttribute("d", d);
    }
  }

  // ------------------------------------------------------------ viewport ---

  function applyView() {
    const { tx, ty, k } = state.view;
    viewportGroup.setAttribute("transform", `translate(${tx},${ty}) scale(${k})`);
    el.zoomLabel.textContent = `${Math.round(k * 100)}%`;
  }

  function screenToWorld(clientX, clientY) {
    const rect = el.canvasHost.getBoundingClientRect();
    const { tx, ty, k } = state.view;
    return { x: (clientX - rect.left - tx) / k, y: (clientY - rect.top - ty) / k };
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = el.canvasHost.getBoundingClientRect();
    const k = clamp(state.view.k * factor, MIN_ZOOM, MAX_ZOOM);
    if (k === state.view.k) return;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const world = screenToWorld(clientX, clientY);
    state.view.k = k;
    state.view.tx = px - world.x * k;
    state.view.ty = py - world.y * k;
    applyView();
  }

  function fitToSheet() {
    if (!state.scene) return;
    const rect = el.canvasHost.getBoundingClientRect();
    const { bounds } = state.scene;
    const pad = 60;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const k = clamp(Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height), MIN_ZOOM, MAX_ZOOM);
    state.view.k = k;
    state.view.tx = (rect.width - width * k) / 2 - bounds.minX * k;
    state.view.ty = (rect.height - height * k) / 2 - bounds.minY * k;
    applyView();
  }

  function centerOnBlock(blockId, zoomLevel) {
    const block = state.scene?.byId.get(blockId);
    if (!block) return;
    const rect = el.canvasHost.getBoundingClientRect();
    const k = zoomLevel || state.view.k;
    state.view.k = k;
    state.view.tx = rect.width / 2 - (block.x + block.w / 2) * k;
    state.view.ty = rect.height / 2 - (block.y + block.h / 2) * k;
    applyView();
  }

  /** Zoom so the block fills a comfortable share of the viewport, never absurdly. */
  function zoomLevelFor(block) {
    const rect = el.canvasHost.getBoundingClientRect();
    const margin = 3.2; // show the block plus its immediate surroundings
    const fit = Math.min(rect.width / (block.w * margin), rect.height / (block.h * margin));
    return clamp(fit, 0.8, 3);
  }

  /** Briefly pulse a block so the eye lands on it after the view moves. */
  function flashBlock(blockId) {
    const node = nodes.get(String(blockId));
    if (!node) return;
    node.group.classList.remove("flash");
    void node.group.getBoundingClientRect(); // restart the animation
    node.group.classList.add("flash");
    window.setTimeout(() => node.group.classList.remove("flash"), 1600);
  }

  /**
   * The single way to go look at a block: hop sheets or composites if needed,
   * select it, zoom in on it and flash it. Every "show me" affordance uses this.
   */
  function focusBlock(blockId) {
    const id = String(blockId);
    if (!id) return false;

    if (!state.scene?.byId.has(id)) {
      if (!revealBlock(id)) return false; // reveal already selects and centres
    } else {
      selectBlock(id);
    }

    const block = state.scene?.byId.get(id);
    if (!block) return false;
    centerOnBlock(id, zoomLevelFor(block));
    flashBlock(id);
    return true;
  }

  // ------------------------------------------------------------- pointer ---

  function attachCanvasEvents() {
    let pan = null;
    let drag = null;

    svg.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 1 / 1.12);
        return;
      }
      event.preventDefault();
      if (event.shiftKey) state.view.tx -= event.deltaY;
      else {
        state.view.tx -= event.deltaX;
        state.view.ty -= event.deltaY;
      }
      applyView();
    }, { passive: false });

    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const world = screenToWorld(event.clientX, event.clientY);

      if (state.placement) {
        commitPlacement(world);
        return;
      }

      const group = event.target.closest?.(".block");
      if (group) {
        const block = state.scene.byId.get(group.dataset.id);
        if (!block) return;
        selectBlock(block.id);
        drag = {
          id: block.id,
          startX: block.x,
          startY: block.y,
          originX: world.x,
          originY: world.y,
          moved: false,
        };
        group.classList.add("dragging");
        svg.setPointerCapture(event.pointerId);
        return;
      }

      selectBlock("");
      pan = { x: event.clientX, y: event.clientY, tx: state.view.tx, ty: state.view.ty };
      el.canvasHost.classList.add("panning");
      svg.setPointerCapture(event.pointerId);
    });

    svg.addEventListener("pointermove", (event) => {
      if (pan) {
        state.view.tx = pan.tx + (event.clientX - pan.x);
        state.view.ty = pan.ty + (event.clientY - pan.y);
        applyView();
        return;
      }
      if (!drag) return;
      const world = screenToWorld(event.clientX, event.clientY);
      const block = state.scene.byId.get(drag.id);
      if (!block) return;
      const nx = window.GfxEdit.snap(drag.startX + (world.x - drag.originX));
      const ny = window.GfxEdit.snap(drag.startY + (world.y - drag.originY));
      if (nx === block.x && ny === block.y) return;
      block.x = nx;
      block.y = ny;
      drag.moved = true;
      updateBlockPosition(block);
    });

    const endPointer = (event) => {
      if (pan) {
        pan = null;
        el.canvasHost.classList.remove("panning");
      }
      if (drag) {
        nodes.get(drag.id)?.group.classList.remove("dragging");
        if (drag.moved) {
          const block = state.scene.byId.get(drag.id);
          window.GfxEdit.moveBlock(state.session, drag.id, block.x, block.y);
          markDirty(true);
        }
        drag = null;
      }
      if (event.pointerId !== undefined && svg.hasPointerCapture?.(event.pointerId)) {
        svg.releasePointerCapture(event.pointerId);
      }
    };

    svg.addEventListener("pointerup", endPointer);
    svg.addEventListener("pointercancel", endPointer);

    // Selection also runs off `click` so keyboard, touch and synthetic events work.
    svg.addEventListener("click", (event) => {
      if (state.placement) return;
      const group = event.target.closest?.(".block");
      if (group && group.dataset.id !== state.selectedId) selectBlock(group.dataset.id);
    });

    svg.addEventListener("dblclick", (event) => {
      const group = event.target.closest?.(".block");
      if (!group) return;
      const block = state.scene.byId.get(group.dataset.id);
      if (block && canOpenInside(block)) openInside(block);
    });

    svg.addEventListener("pointermove", (event) => {
      if (!state.placement) return;
      const world = screenToWorld(event.clientX, event.clientY);
      drawPlacementGhost(world);
    });
  }

  function drawPlacementGhost(world) {
    let ghost = overlayLayer.querySelector(".ghost-block");
    if (!ghost) {
      ghost = document.createElementNS(svgNs, "rect");
      ghost.setAttribute("class", "ghost-block");
      ghost.setAttribute("rx", 4);
      overlayLayer.appendChild(ghost);
    }
    const size = state.placement.size || { w: 156, h: 120 };
    ghost.setAttribute("x", window.GfxEdit.snap(world.x));
    ghost.setAttribute("y", window.GfxEdit.snap(world.y));
    ghost.setAttribute("width", size.w);
    ghost.setAttribute("height", size.h);
  }

  function clearPlacement() {
    state.placement = null;
    el.placementBanner.hidden = true;
    el.canvasHost.classList.remove("placing");
    overlayLayer?.querySelector(".ghost-block")?.remove();
    renderLibraryResults();
  }

  // ------------------------------------------------------ drilling in/out ---

  /** A composite can be opened when it owns blocks of its own. */
  function internalsOf(blockId) {
    return window.GfxEdit.blocksOnSheet(state.session, blockId).filter(
      (element) => element.getAttribute("id") !== String(blockId)
    );
  }

  function canOpenInside(block) {
    return block.tag === "SimpleCompositeBlock" && internalsOf(block.id).length > 0;
  }

  function openInside(block) {
    if (!canOpenInside(block)) return;
    state.trail.push({ docId: block.id, name: blockLabels(block).title, isComposite: true });
    state.activeDocId = block.id;
    state.selectedId = "";
    refreshScene();
    fitToSheet();
    renderBreadcrumb();
    renderCompositeOverview(block.id);
  }

  function goToTrail(index) {
    state.trail = state.trail.slice(0, index + 1);
    state.activeDocId = state.trail[state.trail.length - 1].docId;
    state.selectedId = "";
    refreshScene();
    fitToSheet();
    renderBreadcrumb();
  }

  function renderBreadcrumb() {
    const bar = el.breadcrumbBar;
    if (state.trail.length <= 1) {
      bar.hidden = true;
      bar.innerHTML = ""; // otherwise stale crumbs flash on the next drill-in
      return;
    }
    const crumbs = state.trail
      .map((step, index) => {
        const isLast = index === state.trail.length - 1;
        const button = `<button type="button" class="crumb${isLast ? " current" : ""}" data-crumb="${index}">${escapeHtml(step.name)}</button>`;
        return index === 0 ? button : `<span class="crumb-sep">›</span>${button}`;
      })
      .join("");
    bar.innerHTML = `${crumbs}<span class="crumb-note">Inside a custom block — click a name above or press Esc to go back</span>`;
    bar.hidden = false;
  }

  /** Summarise a composite the moment you step inside it. */
  function renderCompositeOverview(blockId) {
    const session = state.session;
    const element = window.GfxEdit.elementById(session, blockId);
    if (!element) return;
    const name = textOf(element, "Name") || "Custom block";
    const ports = window.GfxEdit.exportedPorts(element);
    const entry = state.catalog?.entries?.find((candidate) =>
      [candidate.title, candidate.stem, ...(candidate.aliases || [])].map(normalizeKey).includes(normalizeKey(name))
    );

    const counts = new Map();
    for (const child of internalsOf(blockId)) {
      counts.set(child.nodeName, (counts.get(child.nodeName) || 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);

    const describe = ranked
      .slice(0, 10)
      .map(([tag, count]) => {
        const info = knowledgeFor(tag);
        return `<li><strong>${escapeHtml(humanizeTag(tag))}</strong> ×${count}${info?.summary ? ` — ${escapeHtml(info.summary)}` : ""}</li>`;
      })
      .join("");

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

    el.inspector.innerHTML = `
      <div class="inspector-header">
        <p class="inspector-kicker">Inside a custom block</p>
        <h3 class="inspector-title">${escapeHtml(name)}</h3>
        <p class="inspector-meta">${total} internal block${total === 1 ? "" : "s"} · ${ports.inputs.length} inputs · ${ports.outputs.length} outputs</p>
      </div>
      ${entry?.description ? `<div class="inspector-section"><h4>What it does</h4><p>${escapeHtml(entry.description)}</p></div>` : ""}
      ${ports.inputs.length ? `<div class="inspector-section"><h4>Inputs it accepts</h4><p>${escapeHtml(ports.inputs.map((port) => port.name).join(", "))}</p></div>` : ""}
      ${ports.outputs.length ? `<div class="inspector-section"><h4>Outputs it produces</h4><p>${escapeHtml(ports.outputs.map((port) => port.name).join(", "))}</p></div>` : ""}
      <div class="inspector-section">
        <h4>What is happening inside</h4>
        <ul>${describe}</ul>
      </div>
      `;

    renderInspectorActions(null);
  }

  // ----------------------------------------------------------- selection ---

  function selectBlock(blockId) {
    state.selectedId = blockId;
    for (const [id, node] of nodes) node.group.classList.toggle("selected", id === blockId);

    for (const { path, link } of wires.values()) {
      const isRelated = Boolean(blockId) && (link.fromId === blockId || link.toId === blockId);
      path.classList.toggle("related", isRelated);
      path.classList.toggle("dimmed", Boolean(blockId) && !isRelated);
    }

    renderInspector(blockId);
    renderSheetBlockList();
  }

  // ---------------------------------------------------------- explaining ---

  function knowledgeFor(tag) {
    return state.knowledge?.blocks?.[tag] || null;
  }

  function normalizeKey(value) {
    return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function libraryEntryFor(block) {
    if (!state.catalog || block.tag !== "SimpleCompositeBlock") return null;
    const key = normalizeKey(block.name);
    if (!key) return null;
    let best = null;
    for (const entry of state.catalog.entries) {
      const aliases = [entry.title, entry.stem, ...(entry.aliases || [])].map(normalizeKey);
      if (!aliases.includes(key)) continue;
      if (!best || (entry.linkCount || 0) < (best.linkCount || 0)) best = entry;
    }
    return best;
  }

  /** Values on this block (and anything it owns) that a user may want to change. */
  function editableValuesFor(block) {
    const ids = [block.id];
    if (block.tag === "SimpleCompositeBlock") {
      for (const child of window.GfxEdit.blocksOnSheet(state.session, block.id)) {
        const id = child.getAttribute("id");
        if (id) ids.push(id);
      }
    }
    return window.GfxEdit.collectVerifiableValues(state.session, ids);
  }

  function renderInspector(blockId) {
    const host = el.inspector;
    if (!blockId) {
      host.innerHTML =
        '<p class="panel-placeholder">Select a block on the sheet to see what it controls, how it works, and what you can change.</p>';
      renderInspectorActions(null);
      return;
    }

    const block = state.scene.byId.get(blockId);
    if (!block) return;
    const labels = blockLabels(block);
    const info = knowledgeFor(block.tag);
    const entry = libraryEntryFor(block);
    const style = CATEGORY_STYLE[block.category] || CATEGORY_STYLE.logic;
    const connected = state.scene.linkIndex.byBlock.get(block.id) || { incoming: [], outgoing: [] };

    const parts = [];

    parts.push(`
      <div class="inspector-header">
        <p class="inspector-kicker">${escapeHtml(style.label)}</p>
        <h3 class="inspector-title">${escapeHtml(labels.title)}</h3>
        <p class="inspector-meta">${escapeHtml(humanizeTag(block.tag))} · id ${escapeHtml(block.id)} · ${block.w}×${block.h} at ${block.x},${block.y}</p>
      </div>`);

    const summary = entry?.description || info?.summary;
    if (summary) {
      parts.push(`<div class="inspector-section"><h4>What it does</h4><p>${escapeHtml(summary)}</p></div>`);
    }

    if (info?.plain) {
      parts.push(`<div class="inspector-section"><h4>In plain terms</h4><p class="plain-line">${escapeHtml(info.plain)}</p></div>`);
    }

    if (info?.steps?.length) {
      parts.push(`
        <div class="inspector-section">
          <h4>How it runs, step by step</h4>
          <ol class="step-list">${info.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
        </div>`);
    }

    if (info?.table) {
      parts.push(`
        <div class="inspector-section">
          <h4>${escapeHtml(info.table.caption || "Behaviour")}</h4>
          <table class="behaviour-table">
            <thead><tr>${info.table.headers.map((head) => `<th>${escapeHtml(head)}</th>`).join("")}</tr></thead>
            <tbody>${info.table.rows
              .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
              .join("")}</tbody>
          </table>
        </div>`);
    }

    if (info?.example) {
      parts.push(`<div class="inspector-section"><h4>Worked example</h4><p class="worked-example">${escapeHtml(info.example)}</p></div>`);
    }

    if (info?.how) {
      parts.push(`<div class="inspector-section"><h4>How it works</h4><p>${escapeHtml(info.how)}</p></div>`);
    }

    if (info?.nullRule) {
      parts.push(`<div class="inspector-section"><h4>If an input is missing</h4><p class="null-rule">${escapeHtml(info.nullRule)}</p></div>`);
    }

    if (info?.ports) {
      parts.push(`<div class="inspector-section"><h4>Ports</h4><p>${escapeHtml(info.ports)}</p></div>`);
    }

    if (info?.controls) {
      parts.push(`<div class="inspector-section"><h4>What it controls</h4><p>${escapeHtml(info.controls)}</p></div>`);
    }

    if (entry) {
      parts.push(`
        <div class="inspector-section">
          <h4>Library source</h4>
          <p>${escapeHtml(entry.path)}</p>
        </div>`);
    }

    parts.push(renderSignalSection("Inputs", connected.incoming, "in"));
    parts.push(renderSignalSection("Outputs", connected.outgoing, "out"));

    const values = editableValuesFor(block);
    if (values.length) {
      const fields = values
        .slice(0, 24)
        .map((row, index) => {
          const options = row.options && row.options.length
            ? `<select data-value-index="${index}">${row.options
                .map((option) => `<option value="${escapeHtml(option)}"${option === row.value ? " selected" : ""}>${escapeHtml(option)}</option>`)
                .join("")}${row.options.includes(row.value) ? "" : `<option value="${escapeHtml(row.value)}" selected>${escapeHtml(row.value)} (not in project)</option>`}</select>`
            : `<input type="text" data-value-index="${index}" value="${escapeHtml(row.value)}" />`;
          return `
            <div class="value-field">
              <label>${escapeHtml(row.label)}</label>
              ${options}
              <p class="value-hint">${escapeHtml(row.hint)}</p>
            </div>`;
        })
        .join("");
      parts.push(`
        <div class="inspector-section">
          <h4>What you can change</h4>
          ${fields}
          <button type="button" id="applyValuesBtn" class="primary">Apply changes</button>
        </div>`);
      host.dataset.valueCount = String(values.length);
      state.inspectorValues = values;
    } else {
      state.inspectorValues = [];
    }

    if (info?.tuning?.length) {
      parts.push(`
        <div class="inspector-section">
          <h4>Commonly adjusted</h4>
          <ul>${info.tuning.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>`);
    }

    if (info?.watchOut) {
      parts.push(`<div class="inspector-section"><div class="callout">${escapeHtml(info.watchOut)}</div></div>`);
    }

    if (info?.docTopic) {
      parts.push(`<p class="doc-source">Source: EC-gfxProgram Help › ${escapeHtml(info.docTopic.replace(/^Block Objects › /, ""))}</p>`);
    }

    host.innerHTML = parts.join("");
    host.scrollTop = 0;
    host.querySelector("#applyValuesBtn")?.addEventListener("click", () => applyInspectorValues(host));

    renderInspectorActions(block);
  }

  /**
   * Kept out of the scrolling body so the actions never scroll off-screen. The
   * back-out button is rebuilt on every render so it survives selecting blocks
   * while you are down inside a composite.
   */
  function renderInspectorActions(block) {
    const bar = el.inspectorActions;
    const nested = state.trail.length > 1;
    const parent = nested ? state.trail[state.trail.length - 2] : null;

    const back = nested
      ? `<button type="button" id="backOutBtn" class="primary">↑ Back to ${escapeHtml(parent.name)}</button>`
      : "";

    if (!block) {
      bar.innerHTML = back;
      bar.hidden = !nested;
      bar.querySelector("#backOutBtn")?.addEventListener("click", () => goToTrail(state.trail.length - 2));
      return;
    }

    const openable = canOpenInside(block);
    bar.innerHTML = `
      ${back}
      ${openable ? `<button type="button" id="openInsideBtn" class="${nested ? "secondary" : "primary"}">Open inside</button>` : ""}
      ${block.tagName ? `<button type="button" id="traceSignalBtn" class="${!nested && !openable ? "primary" : "secondary"}">Trace ${escapeHtml(block.tagName)}</button>` : ""}
      <button type="button" id="centerBlockBtn" class="secondary">Center</button>
      <button type="button" id="deleteBlockBtn" class="secondary">Delete</button>`;
    bar.hidden = false;

    bar.querySelector("#backOutBtn")?.addEventListener("click", () => goToTrail(state.trail.length - 2));
    bar.querySelector("#openInsideBtn")?.addEventListener("click", () => openInside(block));
    bar.querySelector("#traceSignalBtn")?.addEventListener("click", () => openTrace(block.tagName));
    bar.querySelector("#centerBlockBtn")?.addEventListener("click", () => centerOnBlock(block.id));
    bar.querySelector("#deleteBlockBtn")?.addEventListener("click", () => deleteSelectedBlock(block));
  }

  function renderSignalSection(title, links, direction) {
    if (!links.length) {
      return `<div class="inspector-section"><h4>${title}</h4><p class="panel-hint">Nothing wired.</p></div>`;
    }
    const rows = links
      .map((link) => {
        const peerId = direction === "in" ? link.fromId : link.toId;
        const peer = state.scene.byId.get(peerId);
        const port = direction === "in" ? link.toPort : link.fromPort;
        const peerName = peer ? blockLabels(peer).title : `Block ${peerId}`;
        return `
          <div class="signal-row">
            <span class="signal-port">${escapeHtml(port || "—")}</span>
            <button type="button" class="peer-link" data-peer="${escapeHtml(peerId)}" title="Open in a window without leaving this view — shift-click to jump the canvas there instead">${escapeHtml(peerName)}</button>
          </div>`;
      })
      .join("");
    return `<div class="inspector-section"><h4>${title}</h4>${rows}</div>`;
  }

  function applyInspectorValues(host) {
    const rows = state.inspectorValues || [];
    const edits = [];
    host.querySelectorAll("[data-value-index]").forEach((field) => {
      const row = rows[Number(field.dataset.valueIndex)];
      if (!row) return;
      if (String(field.value) !== String(row.value)) edits.push({ ...row, value: field.value });
    });
    if (!edits.length) {
      toast("No values changed.");
      return;
    }
    const applied = window.GfxEdit.applyVerifiedValues(state.session, edits);
    markDirty(true);
    refreshScene();
    toast(`Applied ${applied} change${applied === 1 ? "" : "s"}.`);
  }

  function deleteSelectedBlock(block) {
    const labels = blockLabels(block);
    if (!window.confirm(`Delete "${labels.title}" and every wire attached to it?`)) return;
    window.GfxEdit.deleteBlock(state.session, block.id);
    markDirty(true);
    state.selectedId = "";
    refreshScene();
    toast(`Deleted ${labels.title}.`);
  }

  // ----------------------------------------------------------- left panel ---

  function renderLibraryResults() {
    const host = el.libraryResults;
    if (!state.catalog) {
      host.innerHTML = '<p class="result-empty">Loading library…</p>';
      return;
    }
    const query = normalizeKey(el.librarySearch.value);
    const entries = state.catalog.entries.filter((entry) => {
      if (!query) return true;
      const haystack = normalizeKey(
        [entry.title, entry.stem, entry.folder, entry.description, (entry.aliases || []).join(" "),
         (entry.inputs || []).join(" "), (entry.outputs || []).join(" ")].join(" ")
      );
      return query.split(" ").every((term) => haystack.includes(term));
    });

    if (!entries.length) {
      host.innerHTML = '<p class="result-empty">No library blocks match that search.</p>';
      return;
    }

    const grouped = new Map();
    for (const entry of entries.slice(0, 120)) {
      const folder = entry.folder || "Other";
      if (!grouped.has(folder)) grouped.set(folder, []);
      grouped.get(folder).push(entry);
    }

    const chunks = [];
    for (const [folder, items] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
      chunks.push(`<p class="result-group-label">${escapeHtml(folder)}</p>`);
      for (const entry of items) {
        const ports = [];
        if (entry.inputs?.length) ports.push(`in: ${entry.inputs.slice(0, 4).join(", ")}`);
        if (entry.outputs?.length) ports.push(`out: ${entry.outputs.slice(0, 4).join(", ")}`);
        const selected = state.placement?.entry?.id === entry.id;
        chunks.push(`
          <button type="button" class="result-item${selected ? " selected" : ""}" data-library-id="${escapeHtml(entry.id)}">
            <span class="result-title"><span>${escapeHtml(entry.title || entry.stem)}</span></span>
            <span class="result-desc">${escapeHtml(entry.description || "")}</span>
            ${ports.length ? `<span class="result-ports">${escapeHtml(ports.join(" · "))}</span>` : ""}
          </button>`);
      }
    }
    host.innerHTML = chunks.join("");
  }

  function renderSheetBlockList() {
    const host = el.sheetBlockList;
    if (!state.scene) {
      host.innerHTML = '<p class="result-empty">No sheet loaded.</p>';
      return;
    }
    const query = normalizeKey(el.sheetSearch.value);
    const blocks = state.scene.blocks
      .filter((block) => {
        if (!query) return true;
        const labels = blockLabels(block);
        const info = knowledgeFor(block.tag);
        const haystack = normalizeKey(
          [labels.title, labels.subtitle, block.tag, block.name, block.tagName, info?.summary, (info?.keywords || []).join(" ")].join(" ")
        );
        return query.split(" ").every((term) => haystack.includes(term));
      })
      .sort((a, b) => a.y - b.y || a.x - b.x);

    if (!blocks.length) {
      host.innerHTML = '<p class="result-empty">No blocks match that filter.</p>';
      return;
    }

    host.innerHTML = blocks
      .slice(0, 300)
      .map((block) => {
        const labels = blockLabels(block);
        const info = knowledgeFor(block.tag);
        return `
          <button type="button" class="result-item${block.id === state.selectedId ? " selected" : ""}" data-block-id="${escapeHtml(block.id)}">
            <span class="result-title"><span>${escapeHtml(labels.title)}</span><span class="result-folder">${escapeHtml(labels.subtitle || block.tag)}</span></span>
            ${info?.summary ? `<span class="result-desc">${escapeHtml(info.summary)}</span>` : ""}
          </button>`;
      })
      .join("");
  }

  // -------------------------------------------------- project-wide index ---

  function rootChildren() {
    const out = [];
    for (let node = state.session.root.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1) out.push(node);
    }
    return out;
  }

  function childElement(element, name) {
    if (!element) return null;
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1 && node.nodeName === name) return node;
    }
    return null;
  }

  /**
   * Whole-project view of blocks and links.
   *
   * Main.xml is flat, so a block's sheet is only discoverable by walking its
   * <Doc ref> chain upwards: an internal block points at its composite, which
   * points at the DrawingDocument it sits on.
   */
  function projectIndex() {
    if (state.projectIndex) return state.projectIndex;

    const containers = new Map();
    for (const sheet of window.GfxEdit.listSheets(state.session)) containers.set(sheet.docId, sheet);

    const blocks = new Map();
    const links = [];
    const outgoing = new Map();
    const incoming = new Map();

    for (const element of rootChildren()) {
      const id = element.getAttribute("id");
      if (!id) continue;

      if (element.nodeName === "Link") {
        const link = {
          id,
          fromId: childElement(element, "FB")?.getAttribute("ref") || "",
          fromPort: textOf(element, "FP"),
          toId: childElement(element, "TB")?.getAttribute("ref") || "",
          toPort: textOf(element, "TP"),
        };
        links.push(link);
        if (!outgoing.has(link.fromId)) outgoing.set(link.fromId, []);
        if (!incoming.has(link.toId)) incoming.set(link.toId, []);
        outgoing.get(link.fromId).push(link);
        incoming.get(link.toId).push(link);
        continue;
      }

      const props = childElement(element, "Props");
      blocks.set(id, {
        id,
        tag: element.nodeName,
        name: textOf(element, "Name"),
        tagName: props ? textOf(props, "TagName") : "",
        ownerId: window.GfxEdit.ownerDocId(element),
        placed: Boolean(childElement(element, "Bds")),
      });
    }

    /** Container chain from the drawing sheet down to the block's direct owner. */
    function ancestry(blockId) {
      const chain = [];
      let ownerId = blocks.get(String(blockId))?.ownerId || "";
      let guard = 0;
      while (ownerId && guard < 24) {
        guard += 1;
        const container = containers.get(ownerId);
        chain.unshift({ docId: ownerId, name: container?.name || `Block ${ownerId}`, tag: container?.tag || "" });
        ownerId = blocks.get(ownerId)?.ownerId || "";
      }
      return chain;
    }

    function sheetNameFor(blockId) {
      const chain = ancestry(blockId);
      if (!chain.length) return "";
      const sheet = chain[0].name;
      const nested = chain.slice(1).map((step) => step.name);
      return nested.length ? `${sheet} › ${nested.join(" › ")}` : sheet;
    }

    // Reference tags are the only cross-sheet edges in the document.
    const tagProducers = new Map();
    const tagConsumers = new Map();
    for (const block of blocks.values()) {
      if (!block.tagName) continue;
      const bucket = block.tag === "OutgoingTag" ? tagProducers : tagConsumers;
      if (!bucket.has(block.tagName)) bucket.set(block.tagName, []);
      bucket.get(block.tagName).push(block);
    }

    state.projectIndex = {
      blocks, links, outgoing, incoming, containers,
      tagProducers, tagConsumers, ancestry, sheetNameFor,
    };
    return state.projectIndex;
  }

  function describeBlock(block) {
    if (!block) return "an unknown block";
    if (block.tagName) return `${block.tagName} (${humanizeTag(block.tag)})`;
    if (block.name && block.name !== block.tag) return `${block.name} (${humanizeTag(block.tag)})`;
    return humanizeTag(block.tag);
  }

  // ------------------------------------------------------- signal tracing ---

  /** Distinct reference-tag names, with how many places publish and read each. */
  function listSignals() {
    const index = projectIndex();
    const names = new Set([...index.tagProducers.keys(), ...index.tagConsumers.keys()]);
    return [...names]
      .map((name) => ({
        name,
        producers: index.tagProducers.get(name) || [],
        consumers: index.tagConsumers.get(name) || [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const MAX_PATHS = 10;
  const MAX_DEPTH = 24;

  function isSource(block) {
    return Boolean(block) && (/HardwareInput/.test(block.tag) || /Constant/.test(block.tag) || /Schedule|Calendar/.test(block.tag));
  }

  function isSink(block) {
    return Boolean(block) && /HardwareOutput/.test(block.tag);
  }

  /**
   * Neighbours of a block, treating a matching OutgoingTag/IncomingTag pair as a
   * real edge. Without that hop a trace stops dead at every sheet boundary.
   */
  function stepsFrom(blockId, direction) {
    const index = projectIndex();
    const block = index.blocks.get(String(blockId));
    const out = [];

    if (direction === "next") {
      for (const link of index.outgoing.get(String(blockId)) || []) {
        out.push({ id: link.toId, port: link.toPort, hop: "" });
      }
      if (block?.tag === "OutgoingTag" && block.tagName) {
        for (const reader of index.tagConsumers.get(block.tagName) || []) {
          out.push({ id: reader.id, port: "", hop: block.tagName });
        }
      }
    } else {
      for (const link of index.incoming.get(String(blockId)) || []) {
        out.push({ id: link.fromId, port: link.fromPort, hop: "" });
      }
      if (block?.tag === "IncomingTag" && block.tagName) {
        for (const writer of index.tagProducers.get(block.tagName) || []) {
          out.push({ id: writer.id, port: "", hop: block.tagName });
        }
      }
    }
    return out;
  }

  /** Depth-first enumeration of complete paths away from a block. */
  function walkPaths(startId, direction) {
    const index = projectIndex();
    const paths = [];

    const visit = (id, path, seen) => {
      if (paths.length >= MAX_PATHS) return;
      const candidates = stepsFrom(id, direction).filter((step) => !seen.has(step.id) && index.blocks.has(step.id));

      if (!candidates.length || path.length >= MAX_DEPTH) {
        if (path.length) paths.push(path);
        return;
      }
      for (const candidate of candidates) {
        if (paths.length >= MAX_PATHS) return;
        const block = index.blocks.get(candidate.id);
        const next = [...path, { ...candidate, block }];
        const stop = direction === "next" ? isSink(block) : isSource(block);
        if (stop) {
          paths.push(next);
          continue;
        }
        visit(candidate.id, next, new Set([...seen, candidate.id]));
      }
    };

    visit(String(startId), [], new Set([String(startId)]));
    return paths;
  }

  function nodeRole(block, position) {
    if (isSource(block)) return "Source";
    if (isSink(block)) return "Output";
    if (block.tag === "IncomingTag") return "Reads reference";
    if (block.tag === "OutgoingTag") return "Publishes reference";
    if (block.tag === "SimpleCompositeBlock") return "Custom block";
    return position === "anchor" ? "The signal" : "Logic";
  }

  function nodeDetail(block, step) {
    const info = knowledgeFor(block.tag);
    if (block.tag === "IncomingTag") return `Reads the reference tag "${block.tagName}" from another sheet.`;
    if (block.tag === "OutgoingTag") return `Publishes the value as the reference tag "${block.tagName}" so other sheets can read it.`;
    const base = info?.summary || `${humanizeTag(block.tag)} block.`;
    return step?.port ? `${base} The signal arrives on port ${step.port}.` : base;
  }

  /**
   * Two publishers of the same tag, or two branches that rejoin, routinely yield
   * the identical route. Drop exact repeats, and drop any route that is merely
   * the opening stretch of a longer one already being shown.
   */
  function dedupePaths(paths) {
    const signature = (path) => path.steps.map((step) => step.blockId).join(">");
    const byLength = [...paths].sort((a, b) => b.steps.length - a.steps.length);
    const kept = [];
    const keptSignatures = [];

    for (const path of byLength) {
      const sig = signature(path);
      if (keptSignatures.some((existing) => existing === sig || existing.startsWith(`${sig}>`))) continue;
      kept.push(path);
      keptSignatures.push(sig);
    }
    return kept.sort((a, b) => b.steps.length - a.steps.length);
  }

  /**
   * Full input-to-output story for a signal: walk backwards to the sources that
   * create it, forwards to the outputs it ends up driving, and join the two so
   * each result reads as one continuous path through the logic.
   */
  function traceSignal(name) {
    const index = projectIndex();
    const producers = index.tagProducers.get(name) || [];
    const consumers = index.tagConsumers.get(name) || [];
    const anchors = producers.length ? producers : consumers;

    if (!anchors.length) {
      return { name, producerCount: 0, consumerCount: 0, paths: [], orphan: true };
    }

    const paths = [];
    for (const anchor of anchors) {
      const upstream = walkPaths(anchor.id, "prev");
      const downstream = walkPaths(anchor.id, "next");
      const backbone = upstream.length ? upstream[0].slice().reverse() : [];

      const branches = downstream.length ? downstream : [[]];
      for (const branch of branches) {
        if (paths.length >= MAX_PATHS) break;

        const nodes = [];
        for (const step of backbone) {
          nodes.push({ block: step.block, port: "", hop: step.hop, position: "upstream" });
        }
        nodes.push({ block: anchor, port: "", hop: "", position: "anchor" });
        for (const step of branch) {
          nodes.push({ block: step.block, port: step.port, hop: step.hop, position: "downstream" });
        }

        const steps = nodes.map((node, i) => ({
          number: i + 1,
          kind: node.position === "anchor" ? "origin" : isSink(node.block) ? "terminal" : "use",
          kicker: node.position === "anchor" ? `The signal "${name}"` : nodeRole(node.block, node.position),
          headline: describeBlock(node.block),
          detail: nodeDetail(node.block, node),
          where: index.sheetNameFor(node.block.id),
          hop: node.hop,
          blockId: node.block.id,
        }));

        const first = nodes[0].block;
        const last = nodes[nodes.length - 1].block;
        paths.push({
          from: describeBlock(first),
          to: describeBlock(last),
          complete: isSource(first) && isSink(last),
          steps,
        });
      }
    }

    const unique = dedupePaths(paths);
    return {
      name,
      producerCount: producers.length,
      consumerCount: consumers.length,
      paths: unique,
      truncated: paths.length >= MAX_PATHS,
      orphan: false,
    };
  }

  // ------------------------------------------------------------ trace UI ---

  function traceStepHtml(step, withButtons) {
    const hop = step.hop
      ? `<div class="trace-chain">Crosses sheets through the reference tag <span>${escapeHtml(step.hop)}</span></div>`
      : "";
    const goTo = withButtons && step.blockId
      ? `<button type="button" class="trace-goto" data-trace-block="${escapeHtml(step.blockId)}">Show me on the sheet</button>`
      : "";
    return `
      <div class="trace-step ${step.kind}">
        <div class="trace-marker">${step.number}</div>
        <div>
          <p class="trace-kicker">Step ${step.number} · ${escapeHtml(step.kicker)}</p>
          <p class="trace-headline">${escapeHtml(step.headline)}</p>
          <p class="trace-detail">${escapeHtml(step.detail)}</p>
          <p class="trace-where">On sheet: ${escapeHtml(step.where || "unknown")}</p>
          ${hop}
          ${goTo}
        </div>
      </div>`;
  }

  /**
   * One collapsible heading per route. Collapsed by default so every path is
   * visible at once and you can open just the one you care about; the printable
   * pop-out opens them all instead.
   */
  function tracePathHtml(path, pathIndex, pathCount, withButtons) {
    const heading = pathCount > 1 ? `Path ${pathIndex + 1} of ${pathCount}` : "Signal path";
    const openByDefault = !withButtons || pathCount === 1 || pathIndex === 0;
    return `
      <details class="trace-path"${openByDefault ? " open" : ""}>
        <summary class="trace-path-head">
          <span class="trace-path-chevron" aria-hidden="true">
            <svg viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          </span>
          <span class="trace-path-text">
            <span class="trace-path-kicker">${heading} · ${path.steps.length} step${path.steps.length === 1 ? "" : "s"}</span>
            <span class="trace-path-route">${escapeHtml(path.from)} <span class="trace-arrow">→</span> ${escapeHtml(path.to)}</span>
          </span>
          ${path.complete
            ? '<span class="trace-badge ok">Input to output</span>'
            : '<span class="trace-badge">Partial</span>'}
        </summary>
        <div class="trace-path-body">
          ${path.steps.map((step) => traceStepHtml(step, withButtons)).join("")}
        </div>
      </details>`;
  }

  function traceBodyHtml(trace, withButtons) {
    if (trace.orphan || !trace.paths.length) {
      return `<p class="trace-empty">Nothing in this project publishes or reads <strong>${escapeHtml(trace.name)}</strong>.</p>`;
    }
    const longest = Math.max(...trace.paths.map((path) => path.steps.length));
    const summary = `
      <div class="trace-summary">
        <span>Published in <strong>${trace.producerCount}</strong> place${trace.producerCount === 1 ? "" : "s"}</span>
        <span>Read in <strong>${trace.consumerCount}</strong> place${trace.consumerCount === 1 ? "" : "s"}</span>
        <span><strong>${trace.paths.length}</strong> path${trace.paths.length === 1 ? "" : "s"} through the logic</span>
        <span>Longest is <strong>${longest}</strong> step${longest === 1 ? "" : "s"}</span>
        ${withButtons && trace.paths.length > 1
          ? `<span class="trace-toggles">
               <button type="button" data-trace-expand>Expand all</button>
               <button type="button" data-trace-collapse>Collapse all</button>
             </span>`
          : ""}
      </div>
      ${trace.truncated
        ? `<p class="trace-note">This signal branches widely. These are the distinct routes found in the first ${MAX_PATHS} explored — there may be more.</p>`
        : ""}`;
    return summary + trace.paths.map((path, i) => tracePathHtml(path, i, trace.paths.length, withButtons)).join("");
  }

  // ------------------------------------------------ floating block windows ---

  // Sized so the diagram renders at 1:1 inside the window rather than shrinking
  // the labels: 3 boxes + 2 gaps + padding must match .block-window-body width.
  const MINI = { boxW: 128, boxH: 32, gapY: 10, colGap: 44, pad: 12, maxPeers: 5 };

  /**
   * Resolve a block anywhere in the project along with its immediate wiring,
   * building the owning sheet's scene when the block is not on screen. This is
   * what lets a peer window show a block that lives on another sheet.
   */
  function neighbourhood(blockId) {
    const id = String(blockId);
    let scene = state.scene;
    if (!scene?.byId.has(id)) {
      const ownerId = projectIndex().blocks.get(id)?.ownerId;
      if (!ownerId) return null;
      try {
        scene = buildScene(ownerId);
      } catch (_) {
        return null;
      }
    }
    const block = scene.byId.get(id);
    if (!block) return null;

    const connected = scene.linkIndex.byBlock.get(id) || { incoming: [], outgoing: [] };
    const toPeer = (link, direction) => {
      const peerId = direction === "in" ? link.fromId : link.toId;
      const peer = scene.byId.get(peerId) || projectIndex().blocks.get(peerId);
      return {
        id: peerId,
        label: peer ? blockLabels(peer).title : `Block ${peerId}`,
        port: direction === "in" ? link.toPort : link.fromPort,
      };
    };

    return {
      block,
      scene,
      incoming: connected.incoming.map((link) => toPeer(link, "in")),
      outgoing: connected.outgoing.map((link) => toPeer(link, "out")),
    };
  }

  /** Purpose-built layout — original sheet coordinates are far too sparse here. */
  function miniDiagramSvg(view) {
    const ins = view.incoming.slice(0, MINI.maxPeers);
    const outs = view.outgoing.slice(0, MINI.maxPeers);
    const rows = Math.max(ins.length, outs.length, 1);
    const height = rows * (MINI.boxH + MINI.gapY) + MINI.pad * 2;
    const width = MINI.boxW * 3 + MINI.colGap * 2 + MINI.pad * 2;

    const colX = { in: MINI.pad, self: MINI.pad + MINI.boxW + MINI.colGap, out: MINI.pad + (MINI.boxW + MINI.colGap) * 2 };
    const rowY = (index, count) => MINI.pad + ((rows - count) / 2 + index) * (MINI.boxH + MINI.gapY);
    const selfY = MINI.pad + ((rows - 1) / 2) * (MINI.boxH + MINI.gapY);

    const box = (x, y, label, cls, id, port) => `
      <g class="mini-node ${cls}"${id ? ` data-mini-block="${escapeHtml(id)}" tabindex="0" role="button"` : ""}>
        <rect x="${x}" y="${y}" width="${MINI.boxW}" height="${MINI.boxH}" rx="5" />
        <text x="${x + MINI.boxW / 2}" y="${y + (port ? 13 : MINI.boxH / 2 + 4)}" text-anchor="middle">${escapeHtml(truncate(label, MINI.boxW - 10, 11))}</text>
        ${port ? `<text class="mini-port" x="${x + MINI.boxW / 2}" y="${y + 25}" text-anchor="middle">${escapeHtml(truncate(port, MINI.boxW - 10, 9))}</text>` : ""}
      </g>`;

    const wire = (x1, y1, x2, y2) => {
      const mid = (x1 + x2) / 2;
      return `<path class="mini-wire" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" />`;
    };

    const parts = [];
    ins.forEach((peer, i) => {
      const y = rowY(i, ins.length);
      parts.push(wire(colX.in + MINI.boxW, y + MINI.boxH / 2, colX.self, selfY + MINI.boxH / 2));
      parts.push(box(colX.in, y, peer.label, "upstream", peer.id, peer.port));
    });
    outs.forEach((peer, i) => {
      const y = rowY(i, outs.length);
      parts.push(wire(colX.self + MINI.boxW, selfY + MINI.boxH / 2, colX.out, y + MINI.boxH / 2));
      parts.push(box(colX.out, y, peer.label, "downstream", peer.id, peer.port));
    });
    parts.push(box(colX.self, selfY, blockLabels(view.block).title, "self", "", ""));

    const more = [];
    if (view.incoming.length > ins.length) more.push(`${view.incoming.length - ins.length} more input${view.incoming.length - ins.length === 1 ? "" : "s"}`);
    if (view.outgoing.length > outs.length) more.push(`${view.outgoing.length - outs.length} more output${view.outgoing.length - outs.length === 1 ? "" : "s"}`);

    return `
      <svg class="mini-diagram" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Immediate connections">
        ${parts.join("")}
      </svg>
      ${more.length ? `<p class="mini-more">Not shown: ${more.join(" and ")}.</p>` : ""}`;
  }

  let windowSeq = 0;
  let windowZ = 60;

  function openBlockWindow(blockId) {
    const id = String(blockId);
    const existing = state.windows.get(id);
    if (existing) {
      restoreWindow(id);
      existing.el.style.zIndex = String((windowZ += 1));
      return;
    }

    const view = neighbourhood(id);
    if (!view) {
      toast("That block could not be found in this project.", true);
      return;
    }

    const labels = blockLabels(view.block);
    const info = knowledgeFor(view.block.tag);
    const where = projectIndex().sheetNameFor(id) || "this sheet";

    const el = document.createElement("section");
    el.className = "block-window";
    el.style.zIndex = String((windowZ += 1));
    // Cascade so several windows stay individually reachable.
    const offset = (windowSeq += 1) % 6;
    el.style.left = `${90 + offset * 26}px`;
    el.style.top = `${90 + offset * 22}px`;

    el.innerHTML = `
      <header class="block-window-bar">
        <span class="block-window-title" title="${escapeHtml(labels.title)}">${escapeHtml(labels.title)}</span>
        <span class="block-window-sub">${escapeHtml(labels.subtitle || humanizeTag(view.block.tag))}</span>
        <span class="block-window-actions">
          <button type="button" data-win-min title="Minimise to the bar at the bottom">–</button>
          <button type="button" data-win-close title="Close">×</button>
        </span>
      </header>
      <div class="block-window-body">
        <p class="block-window-where">On sheet: ${escapeHtml(where)}</p>
        ${miniDiagramSvg(view)}
        ${info?.plain ? `<p class="block-window-plain">${escapeHtml(info.plain)}</p>` : ""}
        ${info?.summary && !info?.plain ? `<p class="block-window-plain">${escapeHtml(info.summary)}</p>` : ""}
      </div>
      <footer class="block-window-foot">
        <button type="button" class="primary" data-win-goto>Go to it on the sheet</button>
        <span class="block-window-hint">Click a neighbour to open it too</span>
      </footer>`;

    el.addEventListener("pointerdown", () => {
      el.style.zIndex = String((windowZ += 1));
    });
    el.querySelector("[data-win-close]").addEventListener("click", () => closeBlockWindow(id));
    el.querySelector("[data-win-min]").addEventListener("click", () => minimizeWindow(id));
    el.querySelector("[data-win-goto]").addEventListener("click", () => focusBlock(id));
    el.addEventListener("click", (event) => {
      const node = event.target.closest("[data-mini-block]");
      if (node) openBlockWindow(node.dataset.miniBlock);
    });
    el.addEventListener("keydown", (event) => {
      const node = event.target.closest?.("[data-mini-block]");
      if (node && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openBlockWindow(node.dataset.miniBlock);
      }
    });

    makeWindowDraggable(el, el.querySelector(".block-window-bar"));
    el.querySelector(".block-window-title").textContent = labels.title;

    el.dataset.blockId = id;
    el.dataset.label = labels.title;
    document.getElementById("windowLayer").appendChild(el);
    state.windows.set(id, { el, minimized: false });
  }

  function minimizeWindow(id) {
    const win = state.windows.get(id);
    if (!win || win.minimized) return;
    win.minimized = true;
    win.el.hidden = true;

    const dock = document.getElementById("windowDock");
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dock-chip";
    chip.textContent = win.el.dataset.label || `Block ${id}`;
    chip.title = `Restore ${chip.textContent}`;
    chip.addEventListener("click", () => restoreWindow(id));
    dock.appendChild(chip);
    win.chip = chip;
    dock.hidden = false;
  }

  function restoreWindow(id) {
    const win = state.windows.get(id);
    if (!win) return;
    win.minimized = false;
    win.el.hidden = false;
    win.el.style.zIndex = String((windowZ += 1));
    win.chip?.remove();
    win.chip = null;
    syncDock();
  }

  function closeBlockWindow(id) {
    const win = state.windows.get(id);
    if (!win) return;
    win.chip?.remove();
    win.el.remove();
    state.windows.delete(id);
    syncDock();
  }

  /** The visible window sitting on top, which is what Esc should dismiss. */
  function topmostWindowId() {
    let best = "";
    let bestZ = -1;
    for (const [id, win] of state.windows) {
      if (win.minimized) continue;
      const z = Number(win.el.style.zIndex) || 0;
      if (z > bestZ) {
        bestZ = z;
        best = id;
      }
    }
    return best;
  }

  function syncDock() {
    const dock = document.getElementById("windowDock");
    dock.hidden = !dock.children.length;
  }

  function makeWindowDraggable(el, handle) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      drag = { dx: event.clientX - el.offsetLeft, dy: event.clientY - el.offsetTop };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const maxX = window.innerWidth - 120;
      const maxY = window.innerHeight - 60;
      el.style.left = `${clamp(event.clientX - drag.dx, -40, maxX)}px`;
      el.style.top = `${clamp(event.clientY - drag.dy, 0, maxY)}px`;
    });
    const stop = (event) => {
      drag = null;
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  // ------------------------------------------------- does this block fit? ---

  /**
   * Before placing anything: compare a library entry's declared reference tags
   * against the tags the open project already has, so you can tell whether the
   * block would actually hook into this program or land as a dead island.
   */
  function auditEntryFit(entry) {
    if (!state.session) return null;
    const index = projectIndex();
    const reads = new Set();
    const writes = new Set();
    for (const tag of entry.tags || []) {
      if (!tag.tagName) continue;
      (tag.kind === "out" ? writes : reads).add(tag.tagName);
    }

    const satisfied = [];
    const missing = [];
    for (const tag of reads) {
      if ((index.tagProducers.get(tag) || []).length) satisfied.push(tag);
      else missing.push(tag);
    }

    const fresh = [];
    const duplicate = [];
    const wanted = [];
    for (const tag of writes) {
      if ((index.tagProducers.get(tag) || []).length) duplicate.push(tag);
      else if ((index.tagConsumers.get(tag) || []).length) wanted.push(tag);
      else fresh.push(tag);
    }

    const clashes = [];
    for (const piece of entry.hardware || []) {
      if (!piece.name) continue;
      for (const block of index.blocks.values()) {
        if (block.tag === piece.tag && block.name === piece.name) {
          clashes.push(piece.name);
          break;
        }
      }
    }

    return { satisfied, missing, fresh, duplicate, wanted, clashes };
  }

  /** One-line verdict used in the palette and the placement banner. */
  function fitHeadline(fit) {
    if (!fit) return "";
    const bits = [];
    if (fit.satisfied.length) bits.push(`hooks into ${fit.satisfied.length} existing signal${fit.satisfied.length === 1 ? "" : "s"}`);
    if (fit.wanted.length) bits.push(`fills ${fit.wanted.length} signal${fit.wanted.length === 1 ? "" : "s"} this project is waiting for`);
    if (fit.missing.length) bits.push(`needs ${fit.missing.length} signal${fit.missing.length === 1 ? "" : "s"} nothing publishes yet`);
    if (fit.duplicate.length) bits.push(`${fit.duplicate.length} tag${fit.duplicate.length === 1 ? "" : "s"} already published elsewhere`);
    if (fit.clashes.length) bits.push(`${fit.clashes.length} hardware name clash${fit.clashes.length === 1 ? "" : "es"}`);
    return bits.length ? bits.join(" · ") : "no reference tags — it will stand alone";
  }

  /**
   * After placing: audit the blocks that actually landed in the document. This
   * is the stronger check because it walks the real wiring rather than the
   * catalog's declared tags, so it can tell whether the new logic reaches an
   * output or dead-ends.
   */
  function auditInsertion(result) {
    state.projectIndex = null;
    const index = projectIndex();
    const inserted = new Set((result.insertedIds || []).map(String));
    const issues = [];

    const reads = new Map();
    const writes = new Map();
    for (const id of inserted) {
      const block = index.blocks.get(id);
      if (!block?.tagName) continue;
      (block.tag === "OutgoingTag" ? writes : reads).set(block.tagName, block);
    }

    // Sort every tag into a bucket first, then report one line per bucket.
    // Listing 16 unconnected inputs individually buries the things that matter.
    const connected = [];
    const unfed = [];
    const clashing = [];
    const awaited = [];
    const dangling = [];

    for (const [tag, block] of reads) {
      const producers = (index.tagProducers.get(tag) || []).filter((p) => !inserted.has(String(p.id)));
      (producers.length ? connected : unfed).push({ tag, block });
    }
    for (const [tag, block] of writes) {
      const consumers = (index.tagConsumers.get(tag) || []).filter((c) => !inserted.has(String(c.id)));
      const rivals = (index.tagProducers.get(tag) || []).filter((p) => !inserted.has(String(p.id)));
      if (rivals.length) clashing.push({ tag, block });
      else if (consumers.length) awaited.push({ tag, block });
      else dangling.push({ tag, block });
    }

    const namesOf = (group) => group.map((item) => item.tag).join(", ");
    const soleBlock = (group) => (group.length === 1 ? group[0].block.id : "");

    if (unfed.length) {
      issues.push({
        level: "blocker",
        title: `${unfed.length} input${unfed.length === 1 ? "" : "s"} nothing in this project feeds`,
        detail: `The block reads ${namesOf(unfed)}, but no block anywhere in this project publishes ${unfed.length === 1 ? "that tag" : "those tags"}. Each one stays at its default until you add a source or repoint it at a tag this project already has.`,
        blockId: soleBlock(unfed),
      });
    }
    if (clashing.length) {
      issues.push({
        level: "blocker",
        title: `${clashing.length} tag${clashing.length === 1 ? "" : "s"} already published elsewhere`,
        detail: `${namesOf(clashing)} ${clashing.length === 1 ? "is" : "are"} already written by another block. Two sources writing one tag makes the result depend on execution order. Rename this copy or remove the other writer.`,
        blockId: soleBlock(clashing),
      });
    }
    if (dangling.length) {
      issues.push({
        level: "warn",
        title: `${dangling.length} output${dangling.length === 1 ? "" : "s"} nothing reads yet`,
        detail: `The block publishes ${namesOf(dangling)}, which nothing currently consumes. It will run, but ${dangling.length === 1 ? "that result goes" : "those results go"} nowhere until something reads ${dangling.length === 1 ? "it" : "them"}.`,
        blockId: soleBlock(dangling),
      });
    }
    if (connected.length) {
      issues.push({
        level: "ok",
        title: `${connected.length} input${connected.length === 1 ? "" : "s"} already wired up`,
        detail: `${namesOf(connected)} ${connected.length === 1 ? "is" : "are"} published elsewhere in this project, so ${connected.length === 1 ? "it feeds" : "they feed"} this block with live values straight away.`,
        blockId: soleBlock(connected),
      });
    }
    if (awaited.length) {
      issues.push({
        level: "ok",
        title: `${awaited.length} output${awaited.length === 1 ? "" : "s"} this project was waiting for`,
        detail: `Other blocks already read ${namesOf(awaited)} but nothing was publishing ${awaited.length === 1 ? "it" : "them"}. This block fills that gap.`,
        blockId: soleBlock(awaited),
      });
    }

    // Does the new logic ever reach something physical?
    let reachesOutput = false;
    for (const id of inserted) {
      if (reachesOutput) break;
      for (const path of walkPaths(id, "next")) {
        const last = path[path.length - 1];
        if (last && isSink(last.block)) {
          reachesOutput = true;
          break;
        }
      }
    }
    issues.push(
      reachesOutput
        ? {
            level: "ok",
            title: "Reaches a physical output",
            detail: "Following the wiring forward from this block leads to a hardware output, so it can affect equipment.",
            blockId: "",
          }
        : {
            level: "warn",
            title: "Does not reach a physical output",
            detail:
              "No path forward from this block ends at a hardware output. That is normal for a calculation stage, but if you expected it to drive equipment, something downstream is still missing.",
            blockId: "",
          }
    );

    const blockers = issues.filter((issue) => issue.level === "blocker").length;
    const warnings = issues.filter((issue) => issue.level === "warn").length;

    let verdict;
    if (clashing.length) {
      verdict = `This block conflicts with logic already in the project — ${clashing.length} tag${clashing.length === 1 ? "" : "s"} would have two writers.`;
    } else if (unfed.length && !connected.length) {
      verdict = `This block does not connect to anything here yet — all ${unfed.length} of its inputs are unpublished in this project.`;
    } else if (unfed.length) {
      verdict = `Partly connected: ${connected.length} input${connected.length === 1 ? "" : "s"} feed${connected.length === 1 ? "s" : ""} from this project, ${unfed.length} still ${unfed.length === 1 ? "has" : "have"} no source.`;
    } else if (warnings) {
      verdict = "Wired up correctly, with a couple of loose ends worth checking.";
    } else {
      verdict = "This block fits the project cleanly.";
    }

    return { issues, blockers, warnings, verdict };
  }

  function fitReportHtml(audit) {
    const order = { blocker: 0, warn: 1, ok: 2 };
    const rows = [...audit.issues]
      .sort((a, b) => order[a.level] - order[b.level])
      .map(
        (issue) => `
        <li class="fit-item ${issue.level}">
          <span class="fit-badge">${issue.level === "blocker" ? "Fix" : issue.level === "warn" ? "Check" : "Good"}</span>
          <div>
            <p class="fit-title">${escapeHtml(issue.title)}</p>
            <p class="fit-detail">${escapeHtml(issue.detail)}</p>
            ${issue.blockId ? `<button type="button" class="fit-goto" data-fit-block="${escapeHtml(issue.blockId)}">Show me on the sheet</button>` : ""}
          </div>
        </li>`
      )
      .join("");
    return `
      <div class="fit-report ${audit.blockers ? "has-blockers" : audit.warnings ? "has-warnings" : "clean"}">
        <p class="fit-verdict">${escapeHtml(audit.verdict)}</p>
        <ul class="fit-list">${rows}</ul>
      </div>`;
  }

  function openTrace(name) {
    const trace = traceSignal(name);
    state.currentTrace = trace;
    el.traceTitle.textContent = `Signal trace — ${name}`;
    el.traceSubtitle.textContent = `Traced through ${state.fileName || "the open project"} (${state.sheets.length} sheet${state.sheets.length === 1 ? "" : "s"}) — where "${name}" is created and everywhere it is used, in order.`;
    el.traceBody.innerHTML = traceBodyHtml(trace, true);
    el.traceOverlay.hidden = false;
  }

  function closeTrace() {
    el.traceOverlay.hidden = true;
  }

  /** Self-contained window so a trace can be read beside the canvas or printed. */
  function popOutTrace() {
    const trace = state.currentTrace;
    if (!trace) return;
    const win = window.open("", "_blank", "width=820,height=900");
    if (!win) {
      toast("Your browser blocked the pop-up window.", true);
      return;
    }
    win.document.write(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Signal trace — ${escapeHtml(trace.name)}</title>
<link rel="stylesheet" href="${new URL("canvas.css?v=" + APP_VERSION, window.location.href).href}" />
<style>
  body { background:#fff; display:block; overflow:auto; padding:28px 32px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .lead { color:#55637a; font-size:13px; margin:0 0 20px; }
  @media print { .trace-step { break-inside: avoid; } }
</style>
</head><body>
<h1>Signal trace — ${escapeHtml(trace.name)}</h1>
<p class="lead">${escapeHtml(state.projectName || "")} · generated ${new Date().toLocaleString()}</p>
${traceBodyHtml(trace, false)}
</body></html>`);
    win.document.close();
  }

  function revealBlock(blockId) {
    const index = projectIndex();
    const chain = index.ancestry(blockId);
    if (!chain.length) {
      toast("That block is not placed on a sheet.", true);
      return false;
    }
    el.sheetSelect.value = chain[0].docId;
    state.trail = chain.map((step) => ({ docId: step.docId, name: step.name }));
    state.activeDocId = chain[chain.length - 1].docId;
    state.selectedId = String(blockId);
    refreshScene();
    renderBreadcrumb();
    centerOnBlock(String(blockId));
    return true;
  }

  function renderSignalList() {
    const host = el.signalList;
    if (!state.session) {
      host.innerHTML = '<p class="result-empty">Open a .gfx project first.</p>';
      return;
    }
    const query = normalizeKey(el.signalSearch.value);
    const signals = listSignals().filter((signal) => !query || normalizeKey(signal.name).includes(query));

    if (!signals.length) {
      host.innerHTML = '<p class="result-empty">No signals match that search.</p>';
      return;
    }

    host.innerHTML = signals
      .slice(0, 400)
      .map((signal) => {
        const uses = signal.consumers.length;
        const made = signal.producers.length;
        return `
          <button type="button" class="result-item" data-signal="${escapeHtml(signal.name)}">
            <span class="result-title"><span>${escapeHtml(signal.name)}</span><span class="signal-count">${uses} use${uses === 1 ? "" : "s"}</span></span>
            <span class="result-desc">${made ? `Published in ${made} place${made === 1 ? "" : "s"}` : "No publisher found"} · read in ${uses} place${uses === 1 ? "" : "s"}</span>
          </button>`;
      })
      .join("");
  }

  // -------------------------------------------------------------- insert ---

  async function snippetXmlFor(entry) {
    if (state.snippetCache.has(entry.id)) return state.snippetCache.get(entry.id);
    const url = `Library/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${entry.path} (${response.status}).`);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const file = zip.file("Main.xml");
    if (!file) throw new Error(`${entry.path} has no Main.xml.`);
    const bytes = await file.async("uint8array");
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      let out = "";
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      text = out;
    } else {
      text = new TextDecoder("utf-8").decode(bytes);
    }
    state.snippetCache.set(entry.id, text);
    return text;
  }

  function beginPlacement(entry) {
    if (!state.session) {
      toast("Open a .gfx project first.", true);
      return;
    }
    state.placement = { entry, size: { w: 156, h: 120 } };
    const fit = auditEntryFit(entry);
    el.placementText.textContent = fit
      ? `Click the sheet to place “${entry.title || entry.stem}” — ${fitHeadline(fit)}.`
      : `Click the sheet to place “${entry.title || entry.stem}”.`;
    el.placementBanner.hidden = false;
    el.canvasHost.classList.add("placing");
    renderLibraryResults();
  }

  async function commitPlacement(world) {
    const { entry } = state.placement;
    clearPlacement();
    try {
      const xml = await snippetXmlFor(entry);
      const result = window.GfxEdit.insertSnippet(state.session, xml, {
        docId: state.activeDocId,
        x: world.x,
        y: world.y,
        title: entry.title || entry.stem,
      });

      const audit = window.GfxEdit.validate(state.session);
      if (!audit.ok) {
        for (const id of result.topLevelIds) window.GfxEdit.deleteBlock(state.session, id);
        toast(`Insert rejected: ${audit.errors[0]}`, true);
        return;
      }

      markDirty(true);
      refreshScene();
      const placed = result.topLevelIds.find((id) => state.scene.byId.has(id));
      if (placed) {
        selectBlock(placed);
        centerOnBlock(placed);
      }

      state.pendingInsert = result;
      const rows = window.GfxEdit.collectVerifiableValues(state.session, result.insertedIds);
      const fit = auditInsertion(result);
      openVerifyOverlay(entry, rows, result, fit);
      toast(
        fit.blockers ? `Inserted ${entry.title || entry.stem} — check the connection report.` : `Inserted ${entry.title || entry.stem}.`,
        Boolean(fit.blockers)
      );
    } catch (error) {
      toast(error.message, true);
    }
  }

  // ------------------------------------------------------ verify overlay ---

  function openVerifyOverlay(entry, rows, result, fit) {
    if (!rows.length && !fit) return;
    state.verifyRows = rows;
    el.verifySubtitle.textContent = fit
      ? `${entry.title || entry.stem}${rows.length ? ` — ${rows.length} value${rows.length === 1 ? "" : "s"} came from the library snippet.` : ""}`
      : `${entry.title || entry.stem} — ${rows.length} value${rows.length === 1 ? "" : "s"} came from the library snippet.`;

    el.verifyFit.innerHTML = fit ? fitReportHtml(fit) : "";
    el.verifyFit.hidden = !fit;

    el.verifyRows.innerHTML = rows
      .map((row, index) => {
        const needsAttention = row.kind === "reference" && !row.matchesProject;
        const control = row.options && row.options.length
          ? `<select data-verify-index="${index}">
               ${row.options.map((option) => `<option value="${escapeHtml(option)}"${option === row.value ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}
               ${row.options.includes(row.value) ? "" : `<option value="${escapeHtml(row.value)}" selected>${escapeHtml(row.value)} (new tag)</option>`}
             </select>`
          : `<input type="text" data-verify-index="${index}" value="${escapeHtml(row.value)}" />`;
        return `
          <div class="verify-row${needsAttention ? " needs-attention" : ""}">
            <div class="verify-row-head">
              <span class="verify-label">${escapeHtml(row.label)}</span>
              ${row.kind === "reference"
                ? `<span class="verify-flag${row.matchesProject ? " ok" : ""}">${row.matchesProject ? "Matches a project tag" : "Not found in this project"}</span>`
                : ""}
            </div>
            <div class="verify-controls">${control}</div>
            <p class="verify-hint">${escapeHtml(row.hint)}</p>
          </div>`;
      })
      .join("");
    el.verifyOverlay.hidden = false;
    state.pendingInsert = result;
  }

  function closeVerifyOverlay() {
    el.verifyOverlay.hidden = true;
    state.verifyRows = null;
    state.pendingInsert = null;
  }

  function applyVerifyOverlay() {
    const rows = state.verifyRows || [];
    const edits = [];
    el.verifyRows.querySelectorAll("[data-verify-index]").forEach((field) => {
      const row = rows[Number(field.dataset.verifyIndex)];
      if (!row) return;
      if (String(field.value) !== String(row.value)) edits.push({ ...row, value: field.value });
    });
    const applied = window.GfxEdit.applyVerifiedValues(state.session, edits);
    closeVerifyOverlay();
    if (applied) {
      markDirty(true);
      refreshScene();
    }
    toast(applied ? `Confirmed values, ${applied} updated.` : "Values confirmed as-is.");
  }

  function undoInsert() {
    const result = state.pendingInsert;
    closeVerifyOverlay();
    if (!result) return;
    for (const id of result.topLevelIds) window.GfxEdit.deleteBlock(state.session, id);
    state.selectedId = "";
    refreshScene();
    toast("Removed the inserted block.");
  }

  // ---------------------------------------------------------------- load ---

  async function loadCatalog() {
    try {
      const response = await fetch(`library-catalog.json?v=${APP_VERSION}`);
      state.catalog = await response.json();
    } catch {
      state.catalog = { entries: [] };
    }
    renderLibraryResults();
  }

  async function loadKnowledge() {
    try {
      const response = await fetch(`block-knowledge.json?v=${APP_VERSION}`);
      state.knowledge = await response.json();
    } catch {
      state.knowledge = { blocks: {} };
    }
  }

  const HANDOFF_DB = "distechGfxHandoff";
  const HANDOFF_STORE = "files";

  /** Pick up a project staged by index.html rather than making the user re-pick it. */
  function readHandoff(key) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(HANDOFF_DB, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(HANDOFF_STORE);
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB unavailable"));
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(HANDOFF_STORE, "readonly");
        const get = tx.objectStore(HANDOFF_STORE).get(key);
        get.onsuccess = () => {
          db.close();
          resolve(get.result || null);
        };
        get.onerror = () => {
          db.close();
          reject(get.error);
        };
      };
    });
  }

  async function loadProject(file) {
    try {
      const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
      const name = file instanceof ArrayBuffer ? state.fileName || "project.gfx" : file.name;
      const archive = await window.GfxCore.loadGfxArchive(buffer);
      state.originalBuffer = buffer;
      state.fileName = name;
      state.projectName = archive.projectName || name.replace(/\.gfx$/i, "");
      state.session = window.GfxEdit.createSession(archive.mainXmlText);
      for (const id of Array.from(state.windows.keys())) closeBlockWindow(id);

      // Drawing sheets are the useful targets; composite bodies are internals.
      const all = window.GfxEdit.listSheets(state.session);
      state.sheets = all.filter((sheet) => sheet.tag === "DrawingDocument");
      if (!state.sheets.length) state.sheets = all;

      el.projectName.textContent = `${state.projectName} — ${state.sheets.length} sheet${state.sheets.length === 1 ? "" : "s"}`;
      el.sheetSelect.disabled = false;
      el.sheetSelect.innerHTML = state.sheets
        .map((sheet) => `<option value="${escapeHtml(sheet.docId)}">${escapeHtml(sheet.name)}</option>`)
        .join("");

      const first = state.sheets[0];
      state.activeDocId = first?.docId || "";
      state.trail = first ? [{ docId: first.docId, name: first.name }] : [];
      el.emptyState?.remove();
      markDirty(false);
      refreshScene();
      fitToSheet();
      renderBreadcrumb();
      dismissResume();

      // Publish it so the other tools open the same project without re-picking.
      window.GfxShared?.setCurrentFile(state.fileName, buffer).then(() => {
        window.GfxShared?.updateNavFile(state.fileName);
      });

      toast(`Loaded ${state.fileName}.`);
    } catch (error) {
      toast(`Could not open the file: ${error.message}`, true);
    }
  }

  function refreshScene() {
    if (!state.session || !state.activeDocId) return;
    state.projectIndex = null; // the session may have changed underneath it
    const keepView = { ...state.view };
    state.scene = buildScene(state.activeDocId);
    renderScene();
    state.view = keepView;
    applyView();
    selectBlock(state.selectedId && state.scene.byId.has(state.selectedId) ? state.selectedId : "");
    renderSheetBlockList();
    renderSignalList();
  }

  // -------------------------------------------------------------- export ---

  async function exportProject() {
    if (!state.session) return;
    const audit = window.GfxEdit.validate(state.session);
    if (!audit.ok) {
      toast(`Cannot export: ${audit.errors[0]}`, true);
      return;
    }
    if (audit.warnings.length && !window.confirm(`${audit.warnings.length} consistency warning(s) found:\n\n${audit.warnings.slice(0, 5).join("\n")}\n\nExport anyway?`)) {
      return;
    }
    try {
      const zip = await JSZip.loadAsync(state.originalBuffer);
      zip.file("Main.xml", window.GfxEdit.serialize(state.session));
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = state.fileName.replace(/\.gfx$/i, "") + "_edited.gfx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      markDirty(false);
      toast("Exported. Open it in EC-gfxProgram and verify before downloading to a controller.");
    } catch (error) {
      toast(`Export failed: ${error.message}`, true);
    }
  }

  // ---------------------------------------------------------------- init ---

  function cacheElements() {
    const ids = [
      "gfxFile", "sheetSelect", "zoomInBtn", "zoomOutBtn", "zoomFitBtn", "zoomLabel",
      "exportBtn", "dirtyBadge", "projectName", "canvasHost", "canvasLegend", "emptyState",
      "librarySearch", "libraryResults", "sheetSearch", "sheetBlockList", "inspector",
      "inspectorActions", "signalSearch", "signalList", "traceOverlay", "traceBody", "traceTitle", "traceSubtitle",
      "tracePopOut", "traceClose",
      "breadcrumbBar", "placementBanner", "placementText", "placementCancel", "verifyOverlay", "verifyRows", "verifyFit",
      "verifySubtitle", "verifyApply", "verifyLater", "verifyUndo", "toast",
    ];
    for (const id of ids) el[id] = $(id);
  }

  function attachUiEvents() {
    el.gfxFile.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) loadProject(file);
    });

    el.sheetSelect.addEventListener("change", () => {
      const sheet = state.sheets.find((candidate) => candidate.docId === el.sheetSelect.value);
      state.activeDocId = el.sheetSelect.value;
      state.trail = sheet ? [{ docId: sheet.docId, name: sheet.name }] : [];
      state.selectedId = "";
      refreshScene();
      fitToSheet();
      renderBreadcrumb();
    });

    el.breadcrumbBar.addEventListener("click", (event) => {
      const crumb = event.target.closest("[data-crumb]");
      if (crumb) goToTrail(Number(crumb.dataset.crumb));
    });

    el.zoomInBtn.addEventListener("click", () => {
      const rect = el.canvasHost.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.2);
    });
    el.zoomOutBtn.addEventListener("click", () => {
      const rect = el.canvasHost.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.2);
    });
    el.zoomFitBtn.addEventListener("click", fitToSheet);
    el.exportBtn.addEventListener("click", exportProject);

    document.querySelectorAll("[data-left-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll("[data-left-tab]").forEach((other) => {
          const active = other === tab;
          other.classList.toggle("active", active);
          other.setAttribute("aria-selected", String(active));
        });
        $("leftLibrary").hidden = tab.dataset.leftTab !== "library";
        $("leftSheet").hidden = tab.dataset.leftTab !== "sheet";
        $("leftSignals").hidden = tab.dataset.leftTab !== "signals";
      });
    });

    el.librarySearch.addEventListener("input", renderLibraryResults);
    el.sheetSearch.addEventListener("input", renderSheetBlockList);
    el.signalSearch.addEventListener("input", renderSignalList);

    el.signalList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-signal]");
      if (button) openTrace(button.dataset.signal);
    });

    el.traceBody.addEventListener("click", (event) => {
      if (event.target.closest("[data-trace-expand]") || event.target.closest("[data-trace-collapse]")) {
        const open = Boolean(event.target.closest("[data-trace-expand]"));
        el.traceBody.querySelectorAll("details.trace-path").forEach((node) => {
          node.open = open;
        });
        return;
      }
      const button = event.target.closest("[data-trace-block]");
      if (!button) return;
      closeTrace();
      focusBlock(button.dataset.traceBlock);
    });

    el.verifyFit.addEventListener("click", (event) => {
      const button = event.target.closest("[data-fit-block]");
      if (!button) return;
      closeVerifyOverlay();
      focusBlock(button.dataset.fitBlock);
    });

    el.tracePopOut.addEventListener("click", popOutTrace);
    el.traceClose.addEventListener("click", closeTrace);
    el.traceOverlay.querySelector("[data-trace-dismiss]").addEventListener("click", closeTrace);

    el.libraryResults.addEventListener("click", (event) => {
      const button = event.target.closest("[data-library-id]");
      if (!button) return;
      const entry = state.catalog.entries.find((candidate) => candidate.id === button.dataset.libraryId);
      if (entry) beginPlacement(entry);
    });

    el.sheetBlockList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-block-id]");
      if (!button) return;
      focusBlock(button.dataset.blockId);
    });

    // Peer links open a window rather than navigating, so the sheet you are
    // reading stays put. The window itself has a "Go to it" button.
    el.inspector.addEventListener("click", (event) => {
      const peer = event.target.closest("[data-peer]");
      if (!peer) return;
      if (event.shiftKey) focusBlock(peer.dataset.peer);
      else openBlockWindow(peer.dataset.peer);
    });

    el.placementCancel.addEventListener("click", clearPlacement);
    el.verifyApply.addEventListener("click", applyVerifyOverlay);
    el.verifyLater.addEventListener("click", closeVerifyOverlay);
    el.verifyUndo.addEventListener("click", undoInsert);
    el.verifyOverlay.querySelector("[data-verify-dismiss]").addEventListener("click", closeVerifyOverlay);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (state.placement) clearPlacement();
        else if (!el.traceOverlay.hidden) closeTrace();
        else if (topmostWindowId()) closeBlockWindow(topmostWindowId());
        else if (!el.verifyOverlay.hidden) closeVerifyOverlay();
        else if (state.selectedId) selectBlock("");
        else if (state.trail.length > 1) goToTrail(state.trail.length - 2); // step out of a composite
      }
      if (event.key === "Delete" && state.selectedId && el.verifyOverlay.hidden) {
        const block = state.scene?.byId.get(state.selectedId);
        if (block) deleteSelectedBlock(block);
      }
    });

    window.addEventListener("beforeunload", (event) => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function consumeHandoff() {
    const params = new URLSearchParams(window.location.search);

    const url = params.get("file");
    if (url) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.fileName = url.split("/").pop() || "project.gfx";
        await loadProject(await response.arrayBuffer());
      } catch (error) {
        toast(`Could not fetch ${url}: ${error.message}`, true);
      }
      return;
    }

    const key = params.get("handoff");
    if (key) {
      try {
        const payload = await readHandoff(key);
        if (payload?.buffer) {
          state.fileName = payload.fileName || "project.gfx";
          await loadProject(payload.buffer);
          return;
        }
      } catch (error) {
        toast(`Could not read the project handed over from the editor: ${error.message}`, true);
        return;
      }
    }

    await offerSharedFile();
  }

  /**
   * Nothing was passed in explicitly, so if another tool has a project open,
   * offer it rather than silently loading megabytes the user did not ask for.
   */
  async function offerSharedFile() {
    const name = window.GfxShared?.currentFileName();
    if (!name || state.session) return;

    const banner = document.createElement("div");
    banner.className = "gfx-resume";
    banner.id = "resumeBanner";
    banner.innerHTML = `
      <span><strong>${escapeHtml(name)}</strong> is open in another tool.</span>
      <button type="button" data-resume-open>Open it here</button>
      <button type="button" class="ghost" data-resume-dismiss>Start fresh</button>`;
    el.canvasHost.parentElement.insertBefore(banner, el.canvasHost);

    banner.querySelector("[data-resume-dismiss]").addEventListener("click", dismissResume);
    banner.querySelector("[data-resume-open]").addEventListener("click", async () => {
      const payload = await window.GfxShared?.getCurrentFile();
      if (!payload?.buffer) {
        toast("That project is no longer available.", true);
        dismissResume();
        return;
      }
      state.fileName = payload.fileName || name;
      await loadProject(payload.buffer);
    });
  }

  function dismissResume() {
    document.getElementById("resumeBanner")?.remove();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    cacheElements();
    window.GfxShared?.renderNav("canvas");
    attachUiEvents();
    loadCatalog();
    await loadKnowledge();
    await consumeHandoff();
  });
})();
