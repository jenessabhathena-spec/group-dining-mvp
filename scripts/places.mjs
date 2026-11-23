// Curation helpers (A1).
//   node scripts/places.mjs check path/to/restaurants.csv    validate a spreadsheet export
//   node scripts/places.mjs template [out.csv]               write the sample list as a starting spreadsheet
import { readFileSync, writeFileSync } from "node:fs";
import { loadCatalogCsv, toCsv } from "../server/catalog.js";
import { RESTAURANTS } from "../src/data.js";

const [cmd, file] = process.argv.slice(2);
if (cmd === "check" && file) {
  const { restaurants, errors } = loadCatalogCsv(readFileSync(file, "utf8"));
  if (errors.length) {
    console.error(`${errors.length} problem(s) in ${file}:`);
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  const byArea = restaurants.reduce((m, r) => ((m[r.area] = (m[r.area] || 0) + 1), m), {});
  console.log(`OK: ${restaurants.length} restaurants (${Object.entries(byArea).map(([a, n]) => `${a} ${n}`).join(", ")})`);
  const noPhone = restaurants.filter((r) => !r.phone).length;
  if (noPhone) console.log(`Note: ${noPhone} have no phone, so their winner card will have no Call button.`);
} else if (cmd === "template") {
  const out = file || "data/restaurants.template.csv";
  writeFileSync(out, toCsv(RESTAURANTS));
  console.log(`Wrote ${out} (${RESTAURANTS.length} SAMPLE rows; replace them with real places)`);
} else {
  console.log("Usage:\n  node scripts/places.mjs check <file.csv>\n  node scripts/places.mjs template [out.csv]");
  process.exit(cmd ? 1 : 0);
}
