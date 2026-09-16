import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("usage: node test/bump.mjs 1.2.3");

const touched = [];
for (const name of fs.readdirSync(root)) {
  if (!/\.(html|js)$/.test(name)) continue;
  const file = path.join(root, name);
  const before = fs.readFileSync(file, "utf8");
  const after = before
    .replace(/\?v=\d+\.\d+\.\d+/g, `?v=${version}`)
    .replace(/APP_VERSION = "\d+\.\d+\.\d+"/, `APP_VERSION = "${version}"`);
  if (after !== before) {
    fs.writeFileSync(file, after);
    touched.push(name);
  }
}
console.log(`v${version} — ${touched.join(", ") || "nothing to do"}`);
