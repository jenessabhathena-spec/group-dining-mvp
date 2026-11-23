// Curation tool (A1): the restaurant list lives in a spreadsheet. Export it as CSV (Google Sheets: File >
// Download > CSV) and point RESTAURANTS_CSV at it. Every row is checked; any error stops the load with the
// row number, so a typo never silently drops or mis-tags a place.
//
// Columns (header row required, any order):
//   id, name, area, lat, lng, price_per_head, cuisines, diet_options, vibes, max_group, alcohol, noise,
//   hours, partner, rating, phone, booking_url
// Lists (cuisines, diet_options, vibes) are comma- or pipe-separated inside the cell.
// hours: "daily 12:00-23:00"  or  "mon closed; tue-thu 12:00-15:00,19:00-23:00; fri-sat 12:00-01:00; sun 12:00-22:00"
//   later parts override earlier ones; days not mentioned are closed; a window may run past midnight.
// phone and booking_url are optional (they power the Call and Booking buttons on the winner card).

import { inBengaluru } from "./places.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DIETS = ["veg", "vegan", "jain", "non-veg"];
const VIBES = ["lively", "chill", "fancy", "quick", "quiet"];
const ALCOHOL = ["none", "serves", "bar"];
const NOISE = ["quiet", "medium", "loud"];
export const COLUMNS = ["id", "name", "area", "lat", "lng", "price_per_head", "cuisines", "diet_options", "vibes", "max_group", "alcohol", "noise", "hours", "partner", "rating", "phone", "booking_url"];
const REQUIRED = COLUMNS.filter((c) => !["phone", "booking_url"].includes(c));

// RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, optional BOM.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  text = text.replace(/^﻿/, "");
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function expandDays(spec) {
  if (spec === "daily") return [...DAYS];
  const out = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-");
    if (!DAYS.includes(a) || (b !== undefined && !DAYS.includes(b))) throw new Error(`unknown day "${part}"`);
    if (b === undefined) { out.push(a); continue; }
    for (let k = DAYS.indexOf(a); ; k = (k + 1) % 7) { out.push(DAYS[k]); if (DAYS[k] === b) break; } // fri-mon wraps
  }
  return out;
}

export function parseHours(text) {
  const weekly = Object.fromEntries(DAYS.map((d) => [d, []]));
  const parts = String(text || "").toLowerCase().split(";").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error("hours are empty");
  for (const p of parts) {
    const m = /^(\S+)\s+(.+)$/.exec(p);
    if (!m) throw new Error(`can't read "${p}"`);
    const days = expandDays(m[1]);
    let windows = [];
    if (m[2].trim() !== "closed") {
      windows = m[2].split(",").map((w) => {
        const [o, c] = w.trim().split("-");
        if (!TIME.test(o || "") || !TIME.test(c || "")) throw new Error(`bad time range "${w.trim()}" (use HH:MM-HH:MM)`);
        return [o, c];
      });
    }
    for (const d of days) weekly[d] = windows;
  }
  return { weekly };
}

export function hoursToText(hours) {
  if (!hours.weekly) return `daily ${hours.open}-${hours.close}`;
  return DAYS.map((d) => `${d} ${hours.weekly[d].length ? hours.weekly[d].map(([o, c]) => `${o}-${c}`).join(",") : "closed"}`).join("; ");
}

export function normalisePhoneNumber(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (!/^\+?[\d\s()-]{8,20}$/.test(s)) throw new Error(`bad phone "${s}"`);
  let d = s.replace(/\D/g, "");
  if (s.startsWith("+")) return "+" + d;
  if (d.startsWith("0")) d = d.slice(1); // 080 4123 4567 -> 80 4123 4567
  if (d.length === 10) return "+91" + d;
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  throw new Error(`bad phone "${s}" (use +91 and the number)`);
}

const list = (s) => String(s || "").split(/[|,]/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export function loadCatalogCsv(text) {
  const rows = parseCsv(text);
  const errors = [];
  if (!rows.length) return { restaurants: [], errors: ["The file is empty"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  for (const c of REQUIRED) if (!header.includes(c)) errors.push(`Missing column "${c}"`);
  if (errors.length) return { restaurants: [], errors };
  const col = (r, name) => (header.indexOf(name) >= 0 ? (r[header.indexOf(name)] ?? "").trim() : "");

  const restaurants = [];
  const seen = new Set();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2; // spreadsheet row number (header is row 1)
    const err = (m) => errors.push(`Row ${line}: ${m}`);
    const id = col(r, "id");
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return err(`id "${id}" must be letters, digits, - or _`);
    if (seen.has(id)) return err(`duplicate id "${id}"`);
    seen.add(id);
    const name = col(r, "name");
    if (!name || name.length > 80) err("name is required (80 characters max)");
    const area = col(r, "area");
    if (!area) err("area is required");
    const lat = Number(col(r, "lat")), lng = Number(col(r, "lng"));
    if (!inBengaluru(lat, lng)) err(`lat/lng ${col(r, "lat")}, ${col(r, "lng")} is not in Bengaluru`);
    const price = Number(col(r, "price_per_head"));
    if (!Number.isInteger(price) || price < 50 || price > 20000) err("price_per_head must be a whole number of rupees (50-20000)");
    const cuisines = list(col(r, "cuisines"));
    if (!cuisines.length) err("at least one cuisine is required");
    const dietOptions = list(col(r, "diet_options"));
    if (!dietOptions.length || dietOptions.some((d) => !DIETS.includes(d))) err(`diet_options must be from ${DIETS.join(", ")}`);
    const vibes = list(col(r, "vibes"));
    if (!vibes.length || vibes.some((v) => !VIBES.includes(v))) err(`vibes must be from ${VIBES.join(", ")}`);
    const maxGroup = Number(col(r, "max_group"));
    if (!Number.isInteger(maxGroup) || maxGroup < 1 || maxGroup > 100) err("max_group must be a whole number (1-100)");
    const alcohol = col(r, "alcohol").toLowerCase();
    if (!ALCOHOL.includes(alcohol)) err(`alcohol must be one of ${ALCOHOL.join(", ")}`);
    const noise = col(r, "noise").toLowerCase();
    if (!NOISE.includes(noise)) err(`noise must be one of ${NOISE.join(", ")}`);
    let hours = null;
    try { hours = parseHours(col(r, "hours")); } catch (e) { err(`hours: ${e.message}`); }
    const partnerRaw = col(r, "partner").toLowerCase();
    if (!["yes", "no", "true", "false", "1", "0", ""].includes(partnerRaw)) err("partner must be yes or no");
    const rating = Number(col(r, "rating"));
    if (!(rating >= 1 && rating <= 5)) err("rating must be between 1 and 5");
    let phone = null;
    try { phone = normalisePhoneNumber(col(r, "phone")); } catch (e) { err(e.message); }
    const booking = col(r, "booking_url");
    let bookingUrl = null;
    if (booking) {
      try {
        const u = new URL(booking);
        if (u.protocol !== "https:") throw new Error();
        bookingUrl = u.href;
      } catch { err(`booking_url must be a full https:// link`); }
    }
    restaurants.push({
      id, name, area, lat, lng, pricePerHead: price, cuisines, dietOptions, vibes, maxGroup, alcohol, noise, hours,
      partner: ["yes", "true", "1"].includes(partnerRaw), rating, phone, bookingUrl,
    });
  });
  if (!errors.length && !restaurants.length) errors.push("No restaurants in the file");
  return { restaurants: errors.length ? [] : restaurants, errors };
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(restaurants) {
  const lines = [COLUMNS.join(",")];
  for (const r of restaurants) {
    lines.push([r.id, r.name, r.area, r.lat, r.lng, r.pricePerHead, r.cuisines.join("|"), r.dietOptions.join("|"), r.vibes.join("|"), r.maxGroup, r.alcohol, r.noise, hoursToText(r.hours), r.partner ? "yes" : "no", r.rating, r.phone || "", r.bookingUrl || ""].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
