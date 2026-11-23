import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (phone TEXT PRIMARY KEY, first_name TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS otps (phone TEXT PRIMARY KEY, code_hash TEXT, expires INTEGER, attempts INTEGER DEFAULT 0, sent INTEGER);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, phone TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, organiser_phone TEXT, organiser_name TEXT, organiser_budget INTEGER,
      organiser_start TEXT, data TEXT, status TEXT, picks_json TEXT, session_json TEXT,
      winner_json TEXT, log_json TEXT, created INTEGER, deadline_at INTEGER, plan_at INTEGER, shared_at INTEGER);
    CREATE TABLE IF NOT EXISTS responses (
      plan_id TEXT, name TEXT, member_key TEXT, start_lat REAL, start_lng REAL, start_label TEXT,
      budget INTEGER, dealbreakers TEXT, mood TEXT, created INTEGER, PRIMARY KEY (plan_id, name));
    CREATE TABLE IF NOT EXISTS ratings (plan_id TEXT, name TEXT, went TEXT, stars INTEGER, created INTEGER, PRIMARY KEY (plan_id, name));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, type TEXT, payload TEXT, at INTEGER);
    CREATE TABLE IF NOT EXISTS user_places (phone TEXT, restaurant_id TEXT, status TEXT, at INTEGER, PRIMARY KEY (phone, restaurant_id));
    CREATE TABLE IF NOT EXISTS travel_cache (key TEXT PRIMARY KEY, minutes INTEGER, at INTEGER);
  `);
  // Day-of reminders (F15). One row per plan per recipient: a reminder is sent at most once.
  db.exec("CREATE TABLE IF NOT EXISTS reminders (plan_id TEXT, recipient TEXT, status TEXT, attempts INTEGER DEFAULT 0, error TEXT, sent_at INTEGER, PRIMARY KEY (plan_id, recipient))");
  // A friend's opt-in number lives on their response and is erased as soon as the reminder is done.
  if (!db.prepare("PRAGMA table_info(responses)").all().some((c) => c.name === "reminder_phone")) {
    db.exec("ALTER TABLE responses ADD COLUMN reminder_phone TEXT");
  }
  if (!db.prepare("PRAGMA table_info(responses)").all().some((c) => c.name === "entered_by_organiser")) {
    db.exec("ALTER TABLE responses ADD COLUMN entered_by_organiser INTEGER DEFAULT 0");
  }
  // "Closed or changed?" reports on restaurant cards, for the weekly curation review.
  db.exec("CREATE TABLE IF NOT EXISTS place_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_id TEXT, plan_id TEXT, kind TEXT, note TEXT, at INTEGER)");
  // Admin-tunable settings (engine weights, tuned weekly from votes, vetoes and ratings).
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, at INTEGER)");
  // Migration: taste profile (F2) lives on the user row.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "profile")) {
    db.exec("ALTER TABLE users ADD COLUMN profile TEXT");
  }
  hashLegacySecrets(db);
  return db;
}

// Session tokens and member keys used to be stored in plain text. Hash any that still are (a SHA-256 hex digest
// is 64 hex characters; issued tokens and keys never look like that), so existing sign-ins and friends' links
// keep working while the database no longer holds anything usable.
const HASHED = /^[0-9a-f]{64}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export function hashLegacySecrets(db) {
  let n = 0;
  for (const r of db.prepare("SELECT rowid, token FROM sessions").all()) {
    if (!HASHED.test(r.token)) { db.prepare("UPDATE sessions SET token = ? WHERE rowid = ?").run(sha256(r.token), r.rowid); n++; }
  }
  for (const r of db.prepare("SELECT rowid, member_key FROM responses").all()) {
    if (r.member_key && !HASHED.test(r.member_key)) { db.prepare("UPDATE responses SET member_key = ? WHERE rowid = ?").run(sha256(r.member_key), r.rowid); n++; }
  }
  return n;
}

// DPDP: delete a plan's responses 90 days after the plan. Budgets live in responses and the plan log.
export function purgeExpired(db, now = Date.now(), days = 90, eventDays = Number(process.env.EVENT_RETENTION_DAYS) || 365) {
  // Analytics events and place reports (which may hold a typed note) are kept for a fixed period, then deleted.
  db.prepare("DELETE FROM events WHERE at < ?").run(now - eventDays * 86400000);
  db.prepare("DELETE FROM place_reports WHERE at < ?").run(now - eventDays * 86400000);
  const cutoff = now - days * 86400000;
  const old = db.prepare("SELECT id FROM plans WHERE plan_at < ?").all(cutoff).map((r) => r.id);
  for (const id of old) {
    db.prepare("DELETE FROM responses WHERE plan_id = ?").run(id);
    db.prepare("DELETE FROM reminders WHERE plan_id = ?").run(id);
    db.prepare("UPDATE plans SET log_json = NULL, session_json = NULL WHERE id = ?").run(id);
  }
  db.prepare("DELETE FROM sessions WHERE created < ?").run(now - 30 * 86400000);
  return old.length;
}
