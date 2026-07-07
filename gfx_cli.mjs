#!/usr/bin/env node
/**
 * CLI bridge — uses gfx-core.js (same logic as the web app).
 * Usage:
 *   node gfx_cli.mjs list project.gfx [-o parameters.csv]
 *   node gfx_cli.mjs apply project.gfx parameters.csv -o project_modified.gfx
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
globalThis.JSZip = JSZip;

const coreUrl = pathToFileURL(new URL("./gfx-core.js", import.meta.url));
await import(coreUrl.href);
const GfxCore = globalThis.GfxCore;

function parseArgs(argv) {
  const args = { command: argv[2], gfx: argv[3], output: "", csv: "" };
  for (let i = 4; i < argv.length; i += 1) {
    if (argv[i] === "-o" || argv[i] === "--output") {
      args.output = argv[i + 1] || "";
      i += 1;
    } else if (!args.csv && args.command === "apply") {
      args.csv = argv[i];
    }
  }
  return args;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

async function listGfx(gfxPath, csvPath) {
  const buffer = readFileSync(gfxPath).buffer;
  const archive = await GfxCore.loadGfxArchive(buffer);
  if (csvPath) {
    writeFileSync(csvPath, GfxCore.parametersToCsv(archive.parameters), "utf8");
    console.log(`Wrote ${archive.parameters.length} parameters to ${csvPath}`);
  } else {
    for (const param of archive.parameters) {
      console.log(`${param.category.padEnd(18)} ${param.name.padEnd(36)} ${param.field.padEnd(20)} = ${param.value}`);
    }
    console.log(`Total: ${archive.parameters.length}`);
  }
}

async function applyGfx(gfxPath, csvPath, outputPath) {
  const buffer = readFileSync(gfxPath).buffer;
  const archive = await GfxCore.loadGfxArchive(buffer);
  const csvText = readFileSync(csvPath, "utf8");
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  const idx = Object.fromEntries(header.map((name, i) => [name.trim(), i]));
  const byKey = new Map(archive.parameters.map((p) => [GfxCore.paramKey(p.source, p.category, p.name, p.field), { ...p }]));
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const key = GfxCore.paramKey(cells[idx.source], cells[idx.category], cells[idx.name], cells[idx.field]);
    if (byKey.has(key)) byKey.get(key).value = cells[idx.value];
  }
  const result = await GfxCore.buildModifiedGfx(archive, [...byKey.values()]);
  const arrayBuffer = await result.blob.arrayBuffer();
  writeFileSync(outputPath, Buffer.from(arrayBuffer));
  console.log(`Wrote ${outputPath}`);
  for (const line of result.changed) console.log(line);
  console.log(`Changed ${result.changed.length} field(s)`);
}

const args = parseArgs(process.argv);
if (args.command === "list" && args.gfx) {
  await listGfx(args.gfx, args.output);
} else if (args.command === "apply" && args.gfx && args.csv && args.output) {
  await applyGfx(args.gfx, args.csv, args.output);
} else {
  console.error("Usage:");
  console.error("  node gfx_cli.mjs list <file.gfx> [-o parameters.csv]");
  console.error("  node gfx_cli.mjs apply <file.gfx> <parameters.csv> -o <out.gfx>");
  process.exit(1);
}
