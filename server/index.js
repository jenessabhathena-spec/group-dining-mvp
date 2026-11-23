import { readFileSync } from "node:fs";
import { openDb, purgeExpired } from "./db.js";
import { createApp } from "./app.js";
import { loadCatalogCsv } from "./catalog.js";
import { checkProductionConfig } from "./config.js";
import { backupDb } from "./backup.js";
import { RESTAURANTS } from "../src/data.js";

// Fail fast on unsafe production settings (see server/config.js).
const { errors, warnings } = checkProductionConfig(process.env);
for (const w of warnings) console.warn("WARNING: " + w);
if (errors.length) {
  console.error(`Refusing to start in production:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}

// The restaurant list (A1): a curated spreadsheet export. Refuse to start on a bad file rather than run with
// silently missing places. Without one, run on the fictional sample list and say so loudly.
let restaurants = RESTAURANTS;
if (process.env.RESTAURANTS_CSV) {
  const { restaurants: list, errors: rowErrors } = loadCatalogCsv(readFileSync(process.env.RESTAURANTS_CSV, "utf8"));
  if (rowErrors.length) {
    console.error(`Restaurant list ${process.env.RESTAURANTS_CSV} has ${rowErrors.length} problem(s):\n  - ${rowErrors.join("\n  - ")}`);
    process.exit(1);
  }
  restaurants = list;
  console.log(`Loaded ${list.length} restaurants from ${process.env.RESTAURANTS_CSV}`);
} else {
  console.log("RESTAURANTS_CSV not set: using the FICTIONAL sample restaurants (dev only)");
}

const db = openDb(process.env.DB_PATH || "group-dining.sqlite");
const app = createApp({ db, restaurants, accessLog: (line) => console.log(line) });
const port = Number(process.env.PORT || 3000);
const server = app.server();
server.listen(port, () => {
  console.log(`Group Dining server on http://localhost:${port}`);
  if (!process.env.GOOGLE_MAPS_API_KEY) console.log("GOOGLE_MAPS_API_KEY not set: using straight-line travel estimates");
  if (!process.env.SMS_PROVIDER) console.log("SMS_PROVIDER not set: one-time codes print to this console (dev only)");
});

const timers = [];
// Day-of reminders (F15) and the next-day check (F11): every minute; each is sent at most once.
if (app.hasReminders) {
  timers.push(setInterval(() => app.runReminders().catch((e) => console.error("Reminder run failed:", e.message)), 60 * 1000));
} else {
  console.log("No reminder channel configured: day-of reminders are OFF (set MSG91_REMINDER_TEMPLATE_ID and MSG91_REMINDER_SURPRISE_TEMPLATE_ID, or run without SMS_PROVIDER in dev)");
}
// DPDP retention: purge daily and on boot.
purgeExpired(db);
timers.push(setInterval(() => purgeExpired(db), 24 * 3600 * 1000));
// Backups: on boot and daily, newest BACKUP_KEEP (default 7) kept.
if (process.env.BACKUP_DIR) {
  const backup = () => {
    try {
      const { file } = backupDb(db, process.env.BACKUP_DIR, { keep: Number(process.env.BACKUP_KEEP) || 7 });
      console.log("Backup written: " + file);
    } catch (e) {
      console.error("ALERT: backup failed: " + e.message);
    }
  };
  backup();
  timers.push(setInterval(backup, 24 * 3600 * 1000));
}
for (const t of timers) t.unref();

// Graceful shutdown (docker stop / redeploy): stop taking requests, let in-flight ones finish, close the DB.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  for (const t of timers) clearInterval(t);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10000).unref(); // don't hang forever
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// A crash should restart the container cleanly rather than limp on in an unknown state.
process.on("uncaughtException", (e) => { console.error("FATAL uncaught exception:", e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error("FATAL unhandled rejection:", e); process.exit(1); });
