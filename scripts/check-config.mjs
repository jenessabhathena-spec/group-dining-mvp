// Check a production configuration without starting the server.
//   node --env-file=deploy/.env scripts/check-config.mjs
// (Values the compose file sets itself, like DB_PATH and RESTAURANTS_CSV, are filled in here the same way.)
import { checkProductionConfig } from "../server/config.js";

const env = { NODE_ENV: "production", DB_PATH: "/data/group-dining.sqlite", RESTAURANTS_CSV: "/config/restaurants.csv", BACKUP_DIR: "/data/backups", TRUST_PROXY: "1", ...process.env, NODE_ENV: "production" };
const { errors, warnings } = checkProductionConfig(env);
for (const w of warnings) console.log("WARNING: " + w);
for (const e of errors) console.log("ERROR:   " + e);
console.log(errors.length ? `\n${errors.length} error(s): the server would refuse to start.` : "\nOK: the server would start.");
process.exit(errors.length ? 1 : 0);
