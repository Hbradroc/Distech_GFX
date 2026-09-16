/*
 * Structural round-trip check for gfx-edit.js.
 *
 * There is no sample .gfx project in the repo, so the harness uses Library .sptx
 * snippets as stand-in documents: a SimpleCompositeBlock is a legal container, so
 * inserting one snippet into another exercises the same id/namespace/collection
 * plumbing an insert into a real DrawingDocument would.
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

const GfxEdit = (await import(`file://${path.join(repo, "gfx-edit.js").replace(/\\/g, "/")}`)).default
  || globalThis.GfxEdit;

let failures = 0;
function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2)).toString("utf16le");
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return Buffer.from(bytes.subarray(3)).toString("utf8");
  }
  return Buffer.from(bytes).toString("utf8");
}

async function readSnippet(relPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(repo, relPath)));
  const file = zip.file("Main.xml");
  if (!file) throw new Error(`No Main.xml in ${relPath}`);
  return decode(await file.async("uint8array"));
}

function countTag(xml, tag) {
  return (xml.match(new RegExp(`<${tag}[ />]`, "g")) || []).length;
}

const HOST = "Library/5 - Ventilation/Damper Fresh.sptx";
const GUEST = "Library/2 - Outputs/damper_condensor.sptx";

console.log(`Host : ${HOST}`);
console.log(`Guest: ${GUEST}\n`);

const hostXml = await readSnippet(HOST);
const guestXml = await readSnippet(GUEST);

// --- baseline -------------------------------------------------------------
console.log("Baseline parse");
const session = GfxEdit.createSession(hostXml);
const sheets = GfxEdit.listSheets(session);
check("sheets discovered", sheets.length > 0, `${sheets.length} containers`);
const target = sheets[0];
console.log(`  target container: ${target.tag} #${target.docId} "${target.name}"`);

const baseline = GfxEdit.validate(session);
check("baseline document validates", baseline.ok, baseline.errors.slice(0, 3).join(" | "));
const idsBefore = session.idIndex.size;
const maxIdBefore = session.maxId;

// --- port model -----------------------------------------------------------
console.log("\nPort model");
const linkIndex = GfxEdit.buildLinkIndex(session);
const ports = GfxEdit.describePorts(session, target.docId, linkIndex);
check("composite exposes named inputs", ports.inputs.length > 0, `${ports.inputs.length} inputs`);
check("composite exposes named outputs", ports.outputs.length > 0, `${ports.outputs.length} outputs`);
console.log(`  inputs : ${ports.inputs.slice(0, 6).map((p) => p.name).join(", ")}`);
console.log(`  outputs: ${ports.outputs.map((p) => p.name).join(", ")}`);
check("port names are real, not positional", ports.inputs.every((p) => !p.inferred));

const primitive = GfxEdit.blocksOnSheet(session, target.docId).find((el) => el.nodeName === "Switch");
if (primitive) {
  const pPorts = GfxEdit.describePorts(session, primitive.getAttribute("id"), linkIndex);
  check("primitive port counts derived from IPV/OPV", pPorts.inputs.length === 3 && pPorts.outputs.length === 1,
    `${pPorts.inputs.length} in / ${pPorts.outputs.length} out`);
}

// --- move -----------------------------------------------------------------
console.log("\nMove");
const movable = GfxEdit.blocksOnSheet(session, target.docId)[0];
const movableId = movable.getAttribute("id");
const moved = GfxEdit.moveBlock(session, movableId, 1003, 607);
check("move snaps to the 12-unit grid", moved.x % 12 === 0 && moved.y % 12 === 0, `${moved.x},${moved.y}`);
const reread = GfxEdit.readBounds(GfxEdit.elementById(session, movableId));
check("move preserves size", reread.w === moved.w && reread.h === moved.h, `${reread.w}x${reread.h}`);

// --- link add / remove ----------------------------------------------------
console.log("\nLink add/remove");
const blocks = GfxEdit.blocksOnSheet(session, target.docId);
const a = blocks[1].getAttribute("id");
const b = blocks[2].getAttribute("id");
const newLinkId = GfxEdit.addLink(session, { fromId: a, fromPort: "Output", toId: b, toPort: "In1" });
const afterAdd = GfxEdit.validate(session);
check("document still valid after addLink", afterAdd.ok, afterAdd.errors.slice(0, 2).join(" | "));
check("new link registered in both collections",
  !afterAdd.warnings.some((w) => w.includes(newLinkId)), afterAdd.warnings.slice(0, 2).join(" | "));

GfxEdit.deleteLink(session, newLinkId);
const afterDelete = GfxEdit.validate(session);
check("document valid after deleteLink", afterDelete.ok, afterDelete.errors.slice(0, 2).join(" | "));
check("link element is gone", !GfxEdit.elementById(session, newLinkId));
check("id count returns to baseline", session.idIndex.size === idsBefore,
  `${session.idIndex.size} vs ${idsBefore}`);

// --- snippet insertion ----------------------------------------------------
console.log("\nSnippet insertion");
const result = GfxEdit.insertSnippet(session, guestXml, {
  docId: target.docId,
  x: 2400,
  y: 120,
  title: "Damper Cond",
});
check("top-level shapes placed", result.topLevelIds.length > 0, `${result.topLevelIds.length} shapes`);
check("elements imported", result.insertedIds.length > result.topLevelIds.length,
  `${result.insertedIds.length} elements`);
check("no id collisions with host", session.maxId > maxIdBefore);

const afterInsert = GfxEdit.validate(session);
check("document valid after insert", afterInsert.ok, afterInsert.errors.slice(0, 3).join(" | "));
check("no dangling link collections", afterInsert.warnings.length === 0,
  afterInsert.warnings.slice(0, 3).join(" | "));

// placed shapes must belong to the target sheet and sit at the drop point
const placedOnSheet = result.topLevelIds.filter(
  (id) => GfxEdit.ownerDocId(GfxEdit.elementById(session, id)) === target.docId
);
check("placed shapes re-parented to target sheet", placedOnSheet.length === result.topLevelIds.length,
  `${placedOnSheet.length}/${result.topLevelIds.length}`);
check("group landed at the drop point", result.bounds && result.bounds.minX === 2400 && result.bounds.minY === 120,
  result.bounds ? `${result.bounds.minX},${result.bounds.minY}` : "no bounds");

// internals must keep pointing at their own composite, not the host sheet
const internals = result.insertedIds.filter((id) => {
  const el = GfxEdit.elementById(session, id);
  return el && el.nodeName === "Switch" && !result.topLevelIds.includes(id);
});
const strayInternals = internals.filter((id) => GfxEdit.ownerDocId(GfxEdit.elementById(session, id)) === target.docId);
check("composite internals kept their own owner", strayInternals.length === 0,
  `${strayInternals.length} stray of ${internals.length}`);

// sheet shape collection updated
const sheetEl = GfxEdit.elementById(session, target.docId);
const shpsText = sheetEl.getElementsByTagName("Shps")[0]?.textContent || "";
check("sheet <Shps> lists the new shapes", result.topLevelIds.every((id) => shpsText.includes(id)));

// --- values to verify -----------------------------------------------------
console.log("\nVerifiable values");
const rows = GfxEdit.collectVerifiableValues(session, result.insertedIds);
check("insert surfaces values to confirm", rows.length > 0, `${rows.length} rows`);
const refRows = rows.filter((r) => r.kind === "reference");
check("reference tags surfaced", refRows.length > 0, refRows.map((r) => r.value).join(", "));
check("reference rows carry project alternatives", refRows.every((r) => Array.isArray(r.options) && r.options.length > 0));
const unmatched = refRows.filter((r) => !r.matchesProject);
console.log(`  tags not found in host project: ${unmatched.map((r) => r.value).join(", ") || "(none)"}`);

if (refRows.length) {
  const edit = { ...refRows[0], value: "renamed_tag_check" };
  const applied = GfxEdit.applyVerifiedValues(session, [edit]);
  check("verified value writes back", applied === 1);
  const el = GfxEdit.elementById(session, edit.elementId);
  const written = el.getElementsByTagName("TagName")[0]?.textContent;
  check("written value readable", written === "renamed_tag_check", written);
}

// --- serialize / reparse --------------------------------------------------
console.log("\nSerialize round-trip");
const xml = GfxEdit.serialize(session);
check("declaration is well formed", /^<\?xml version="1\.0" encoding="utf-8"\?>/.test(xml), xml.slice(0, 48));
check("no stray brace in declaration", !xml.slice(0, 80).includes('"}'));

let reparsed = null;
try {
  reparsed = GfxEdit.createSession(xml);
  check("output re-parses", true);
} catch (err) {
  check("output re-parses", false, err.message);
}

if (reparsed) {
  const revalidated = GfxEdit.validate(reparsed);
  check("re-parsed document validates", revalidated.ok, revalidated.errors.slice(0, 3).join(" | "));
  check("element count survives round-trip", reparsed.idIndex.size === session.idIndex.size,
    `${reparsed.idIndex.size} vs ${session.idIndex.size}`);
  check("host blocks preserved", countTag(xml, "SimpleCompositeBlock") >= countTag(hostXml, "SimpleCompositeBlock"));
}

// --- delete ---------------------------------------------------------------
console.log("\nDelete inserted group");
const beforeDelete = session.idIndex.size;
for (const id of result.topLevelIds) GfxEdit.deleteBlock(session, id);
const afterBlockDelete = GfxEdit.validate(session);
check("valid after deleting inserted shapes", afterBlockDelete.ok, afterBlockDelete.errors.slice(0, 3).join(" | "));
check("document shrank", session.idIndex.size < beforeDelete, `${beforeDelete} -> ${session.idIndex.size}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
