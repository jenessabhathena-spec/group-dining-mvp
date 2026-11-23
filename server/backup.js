// Database backups: a consistent copy with SQLite's VACUUM INTO (safe while the app is running), rotated so
// only the newest `keep` copies remain. Backups contain budgets and phone numbers: keep BACKUP_DIR on an
// encrypted volume, and remember deleted data lingers in backups until they rotate out (default 7 days).
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const NAME = /^group-dining-\d{8}T\d{6}Z\.sqlite$/;

export function backupDb(db, dir, { keep = 7, now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const file = join(dir, `group-dining-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort(); // timestamps sort chronologically
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of removed) unlinkSync(join(dir, f));
  return { file, removed };
}
