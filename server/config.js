// Production configuration check. Errors stop the server at startup; warnings are printed.
// Run on its own with: NODE_ENV=production node scripts/check-config.mjs
export function checkProductionConfig(env = process.env) {
  const errors = [], warnings = [];
  if (env.NODE_ENV !== "production") return { errors, warnings };

  if (!env.PUBLIC_URL) errors.push("PUBLIC_URL is required (the https:// address friends' links will use)");
  else if (!/^https:\/\/[^/\s]+$/.test(env.PUBLIC_URL)) errors.push("PUBLIC_URL must be https://your-domain with no trailing slash or path");
  if (!env.RESTAURANTS_CSV) errors.push("RESTAURANTS_CSV is required (the curated restaurant list)");
  if (!env.SMS_PROVIDER) errors.push("SMS_PROVIDER is required (dev mode prints sign-in codes to the log)");
  else if (env.SMS_PROVIDER === "msg91" && (!env.MSG91_AUTHKEY || !env.MSG91_TEMPLATE_ID)) errors.push("SMS_PROVIDER=msg91 needs MSG91_AUTHKEY and MSG91_TEMPLATE_ID");
  if (env.ADMIN_KEY && env.ADMIN_KEY.length < 24) errors.push("ADMIN_KEY must be at least 24 random characters (or unset to disable admin)");
  if (!env.DB_PATH) errors.push("DB_PATH is required (put it on the persistent volume, e.g. /data/group-dining.sqlite)");

  if (env.TRUST_PROXY !== "1") warnings.push("TRUST_PROXY is not 1: behind a reverse proxy every visitor shares one IP, so per-IP limits will hit everyone at once");
  if (!env.GOOGLE_MAPS_API_KEY) warnings.push("GOOGLE_MAPS_API_KEY is not set: travel times are straight-line estimates and address search falls back to area names");
  if (!env.BACKUP_DIR) warnings.push("BACKUP_DIR is not set: no automatic database backups");
  if (!env.ADMIN_KEY) warnings.push("ADMIN_KEY is not set: metrics, plan logs, reports and weights are unavailable");
  if (env.SMS_PROVIDER === "msg91" && (!env.MSG91_REMINDER_TEMPLATE_ID || !env.MSG91_REMINDER_SURPRISE_TEMPLATE_ID)) warnings.push("Reminder templates are not set: day-of reminders are off");
  return { errors, warnings };
}
