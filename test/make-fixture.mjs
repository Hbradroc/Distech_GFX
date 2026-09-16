/*
 * Build a synthetic multi-sheet .gfx from Library snippets for local development.
 *
 * The repo ships no sample project, so this assembles one: a bare Main.xml with a
 * few DrawingDocument sheets, then pastes snippets onto them through the same
 * GfxEdit.insertSnippet path the canvas uses. Snippets are chosen so their
 * reference tags line up, which produces real cross-sheet signal chains to trace.
 *
 * This is a development fixture, not a controller-ready project.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
await import(`file://${path.join(repo, "gfx-edit.js").replace(/\\/g, "/")}`);
const GfxEdit = globalThis.GfxEdit;

const OUT = process.argv[2] || path.join(here, "fixture-project.gfx");

function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return Buffer.from(bytes.subarray(2)).toString("utf16le");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return Buffer.from(bytes.subarray(3)).toString("utf8");
  return Buffer.from(bytes).toString("utf8");
}

async function snippetXml(relPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(repo, relPath)));
  return decode(await zip.file("Main.xml").async("uint8array"));
}

// --- choose snippets whose reference tags interlock ------------------------

const catalog = JSON.parse(fs.readFileSync(path.join(repo, "library-catalog.json"), "utf8"));

const defines = new Map(); // tag -> entries publishing it
for (const entry of catalog.entries) {
  for (const tag of entry.tags || []) {
    if (tag.kind !== "out") continue;
    if (!defines.has(tag.tagName)) defines.set(tag.tagName, []);
    defines.get(tag.tagName).push(entry);
  }
}

/** Score an entry by how many of its reads are satisfied by an already-picked set. */
function connectedness(entry, picked) {
  const published = new Set();
  for (const chosen of picked) {
    for (const tag of chosen.tags || []) if (tag.kind === "out") published.add(tag.tagName);
  }
  let hits = 0;
  for (const tag of entry.tags || []) {
    if (tag.kind === "in" && published.has(tag.tagName)) hits += 1;
  }
  return hits;
}

// Seed with a hardware input and a hardware output so paths have real endpoints.
const inputs = catalog.entries.filter((e) => e.folder === "1 - Inputs" && (e.tags || []).some((t) => t.kind === "out"));
const outputs = catalog.entries.filter((e) => e.folder === "2 - Outputs" && (e.hardware || []).length);

const picked = [];
const seed = inputs.sort((a, b) => (b.tags?.length || 0) - (a.tags?.length || 0))[0];
if (seed) picked.push(seed);

// Greedily add whichever remaining entry consumes the most of what we publish.
const pool = catalog.entries.filter((e) => e !== seed && (e.tags || []).length);
for (let round = 0; round < 5; round += 1) {
  let best = null;
  let bestScore = 0;
  for (const entry of pool) {
    if (picked.includes(entry)) continue;
    const score = connectedness(entry, picked);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  if (!best) break;
  picked.push(best);
}

// Always include an output stage so at least one path reaches hardware.
for (const output of outputs) {
  if (picked.length >= 7) break;
  if (!picked.includes(output) && connectedness(output, picked) > 0) picked.push(output);
}
if (picked.length < 2) picked.push(...catalog.entries.slice(0, 3));

// --- assemble the project --------------------------------------------------

const sheetNames = [...new Set(picked.map((entry) => entry.folder || "Logic"))];
const sheetXml = sheetNames
  .map(
    (name, i) =>
      `  <DrawingDocument id="${i + 1}" ns="0">\n    <Name>${name}</Name>\n    <Bds>0,0,3600,2400</Bds>\n    <Shps />\n  </DrawingDocument>`
  )
  .join("\n");

const baseXml = `<?xml version="1.0" encoding="utf-8"?>
<Root>
  <Namespaces>
    <Namespace0 index="0" value="Distech.Gpl.Model.Shapes" asm="DC.Gpl.Model" />
  </Namespaces>
${sheetXml}
</Root>`;

const session = GfxEdit.createSession(baseXml);
const sheetIds = new Map(sheetNames.map((name, i) => [name, String(i + 1)]));
const cursor = new Map(sheetNames.map((name) => [name, { x: 120, y: 120 }]));

for (const entry of picked) {
  const sheetName = entry.folder || "Logic";
  const docId = sheetIds.get(sheetName);
  const at = cursor.get(sheetName);
  const xml = await snippetXml(`Library/${entry.path}`);
  const result = GfxEdit.insertSnippet(session, xml, {
    docId,
    x: at.x,
    y: at.y,
    title: entry.title,
  });
  const height = result.bounds ? result.bounds.maxY - result.bounds.minY : 400;
  at.y += Math.max(height, 240) + 120;
  console.log(`  placed ${entry.title.padEnd(26)} on "${sheetName}" (${result.topLevelIds.length} shapes)`);
}

const audit = GfxEdit.validate(session);
if (!audit.ok) {
  console.error("Fixture failed validation:", audit.errors.slice(0, 5));
  process.exit(1);
}

const zip = new JSZip();
zip.file("Main.xml", GfxEdit.serialize(session));
zip.file(
  "Info/ProjectInfo.xml",
  `<?xml version="1.0" encoding="utf-8"?>\r\n<ProjectInfo><Name>Canvas Fixture</Name></ProjectInfo>`
);
fs.writeFileSync(OUT, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

// --- report what can be traced ---------------------------------------------

const producers = new Map();
const consumers = new Map();
for (const element of Array.from(session.root.childNodes).filter((n) => n.nodeType === 1)) {
  let props = null;
  for (let n = element.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === "Props") props = n;
  const tagName = props?.getElementsByTagName("TagName")[0]?.textContent?.trim();
  if (!tagName) continue;
  const bucket = element.nodeName === "OutgoingTag" ? producers : consumers;
  bucket.set(tagName, (bucket.get(tagName) || 0) + 1);
}
const linked = [...producers.keys()].filter((tag) => consumers.has(tag));

console.log(`\nWrote ${OUT}`);
console.log(`  sheets: ${sheetNames.join(", ")}`);
console.log(`  ${producers.size} published tags, ${consumers.size} read tags`);
console.log(`  ${linked.length} tag(s) wired end to end across sheets: ${linked.slice(0, 12).join(", ") || "(none)"}`);
