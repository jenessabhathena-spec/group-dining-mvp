// Inlines src/data.js + src/engine.js + src/voting.js into prototype/template.html
// so prototype/index.html runs from a double-click (no server, no module CORS issues).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (file) =>
  readFileSync(join(root, "src", file), "utf8")
    .replace(/^import .*$/gm, "")
    .replace(/^export (const|function|let) /gm, "$1 ");

const bundle = ["data.js", "engine.js", "voting.js"].map(strip).join("\n");
const tpl = readFileSync(join(root, "prototype", "template.html"), "utf8");
if (!tpl.includes("/*__ENGINE__*/")) throw new Error("placeholder missing in template.html");
const html = tpl.replace("/*__ENGINE__*/", () => bundle);
writeFileSync(join(root, "prototype", "index.html"), html);
// GitHub Pages serves docs/ (static only: the clickable prototype, not the real app).
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "index.html"), html);
writeFileSync(join(root, "docs", ".nojekyll"), "");
console.log("Wrote prototype/index.html and docs/index.html");
