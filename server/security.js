// HTTP hardening: security headers, a strict Content Security Policy, and the real client IP behind a proxy.
import { createHash } from "node:crypto";

// The pages ship their JavaScript inline. Rather than allow any inline script ('unsafe-inline'), the CSP lists
// the SHA-256 of each inline <script> block in the page being served, so injected script cannot run.
// Inline style attributes are still allowed (style-src 'unsafe-inline'); they cannot execute code.
export function scriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
  }
  return out;
}

export function cspFor(html) {
  const hashes = scriptHashes(html);
  return [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(" ") : "'none'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Sent on every response.
export function baseHeaders({ hsts = false } = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // Plan links and claim links must not leak to Google Maps, WhatsApp or booking sites via the Referer.
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(self), camera=(), microphone=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    ...(hsts ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

// Behind exactly one reverse proxy (Caddy in deploy/), the client is the last address the proxy appended to
// X-Forwarded-For. Without TRUST_PROXY the header is ignored, so a client cannot spoof its IP to dodge limits.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || "?";
}

// Access log line. Path only: query strings can carry typed addresses (place search) and session tokens.
export const accessLine = (method, pathname, status, ms) => `${method} ${pathname} ${status} ${ms}ms`;
