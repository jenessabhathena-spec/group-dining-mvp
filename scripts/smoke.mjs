// Post-deploy smoke test. Read-only: creates nothing, signs nobody in.
//   node scripts/smoke.mjs https://plans.example.in
const base = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.log("Usage: node scripts/smoke.mjs <base URL>");
  process.exit(2);
}
const https = base.startsWith("https://");
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };

const get = async (path, init) => { const r = await fetch(base + path, { redirect: "manual", ...init }); return { r, text: await r.text() }; };

const health = await get("/healthz");
check(health.r.status === 200 && JSON.parse(health.text).ok === true, "GET /healthz is ok");

const home = await get("/");
check(home.r.status === 200, "GET / serves the organiser app");
const csp = home.r.headers.get("content-security-policy") || "";
check(/script-src 'sha256-/.test(csp) && !csp.includes("unsafe-inline' 'sha") && !/script-src[^;]*unsafe-inline/.test(csp), "CSP allows only the page's own scripts");
check(home.r.headers.get("x-frame-options") === "DENY", "X-Frame-Options: DENY");
check(home.r.headers.get("referrer-policy") === "no-referrer", "Referrer-Policy: no-referrer");
if (https) check(/max-age=\d+/.test(home.r.headers.get("strict-transport-security") || ""), "HSTS is set");

check((await get("/privacy")).r.status === 200, "GET /privacy is served");
check((await get("/api/me")).r.status === 401, "API needs sign-in");
check((await get("/api/admin/metrics")).r.status === 403, "Admin needs the admin key");
check((await get("/p/does-not-exist")).r.status === 404, "Unknown plan links 404");
if (https) {
  check((await get("/prototype")).r.status === 404, "Fictional prototype is not served in production");
  const plain = await fetch(base.replace("https://", "http://") + "/healthz", { redirect: "manual" }).catch(() => null);
  check(plain && [301, 302, 307, 308].includes(plain.status), "http:// redirects to https://");
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
