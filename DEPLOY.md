# Deploying the pilot

One small Linux server in India, running two containers: the app and Caddy (automatic HTTPS). SQLite lives on a
Docker volume on that server, with daily backups. This fits a pilot of a few hundred plans. Run **one** app
container only: rate limits and the reminder scheduler live inside the process.

## 1. Before you start (things only you can do)

- [ ] **Server in India** (PRD: India data region if possible). Either works:
  - DigitalOcean Droplet in **Bangalore (BLR1)**, Ubuntu LTS, 1 GB RAM.
  - AWS Lightsail or EC2 in **Mumbai (ap-south-1)**, Ubuntu LTS, 1 GB RAM.
  Turn on the provider's disk encryption and automatic snapshots if offered.
- [ ] **Domain** with an A record pointing at the server's IP.
- [ ] **MSG91 account with DLT registration** done and templates approved (README, "SMS setup"): sign-in code,
      day-of reminder, surprise reminder, and optionally the next-day "How was it?" text.
- [ ] **Google Maps Platform key** with Distance Matrix and Places API (New) enabled, restricted to the server's IP
      and to those two APIs. Set a budget alert in Google Cloud.
- [ ] **Restaurant spreadsheet** exported as CSV and checked: `npm run places:check restaurants.csv`.
- [ ] **Privacy policy** placeholders filled in and reviewed by a lawyer (`server/public/privacy.html`).

## 2. Set up the server

```bash
# Firewall: SSH, HTTP, HTTPS only
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
# Install Docker Engine + the compose plugin: follow https://docs.docker.com/engine/install/ubuntu/
```

Copy the project to the server (git clone, or scp the `group-dining` folder), then:

```bash
cd group-dining/deploy
cp .env.example .env        # fill it in; keep it off git
cp /path/to/restaurants.csv ./restaurants.csv
node --env-file=.env ../scripts/check-config.mjs   # optional, if Node is installed on the server
docker compose up -d --build
docker compose logs -f app   # look for "Loaded N restaurants" and no "Refusing to start"
```

The app refuses to start in production if anything essential is missing or unsafe (no https PUBLIC_URL, no SMS
provider, no restaurant list, a short ADMIN_KEY) and prints exactly what to fix.

## 3. Check it

```bash
node scripts/smoke.mjs https://your-domain    # from your laptop
```

It checks the health endpoint, HTTPS redirect, security headers (strict Content Security Policy, HSTS,
no-referrer, no framing), that the API and admin need credentials, and that the fictional prototype is not served.
Then sign in with your own number and run one plan end to end with a friend.

## 4. Running it

| Task | How |
|---|---|
| Update the restaurant list | Replace `deploy/restaurants.csv`, then `docker compose restart app`. A bad file stops the app with row numbers: fix it and restart. |
| Deploy new code | `git pull && docker compose up -d --build` (in-flight requests finish first; the app shuts down gracefully). |
| Logs | `docker compose logs app`. Access lines are `METHOD /path STATUS ms`: no query strings, no bodies, no numbers. Watch for `ALERT:` lines (backup failed, daily SMS cap reached). |
| Backups | Written to the `appdata` volume at `/data/backups` on boot and daily, newest 7 kept. Copy them off the server regularly (they hold budgets and phone numbers: store encrypted). Deleted data stays in backups until they rotate out (7 days); the privacy policy should say so. |
| Restore | Stop the app, copy a backup over `/data/group-dining.sqlite` in the volume, start the app. |
| Metrics, logs, reports | `curl -H "x-admin-key: $ADMIN_KEY" https://your-domain/api/admin/metrics` (also `/api/admin/reports`, `/api/admin/weights`, `/api/admin/plans/<id>/log`). |
| Rotate the admin key | Change `ADMIN_KEY` in `.env`, `docker compose up -d`. |
| SMS bill protection | `OTP_DAILY_CAP` (default 300 codes a day). When reached, sign-in pauses until midnight IST and the log says `ALERT`. |

## What the hardening covers

- **HTTPS** everywhere via Caddy, HSTS on, http redirected.
- **Content Security Policy** that allows only each page's own inline script (by SHA-256 hash), so injected
  script can't run; no framing; `no-referrer`, so plan and claim links never leak to Maps, WhatsApp or booking sites.
- **Abuse limits:** sign-in codes per IP and per day (SMS pumping), verification attempts per code and per IP,
  plans per organiser per day, answers per IP and per plan (8 people max), searches, events and reports per IP.
  Behind Caddy the real client IP is used (`TRUST_PROXY=1`); without it, a forged `X-Forwarded-For` is ignored.
- **Secrets at rest:** session tokens and friends' member keys are stored only as SHA-256 hashes; sign-in codes
  too. Sessions expire after 30 days; Sign out ends the session on the server.
- **Container:** non-root user, read-only filesystem except the data volume, all Linux capabilities dropped,
  no privilege escalation, app port not exposed to the internet, health check, log rotation.
- **Request limits:** 100 KB bodies, 15 s request timeout, 10 s header timeout (slow-client attacks).
- **Data:** responses deleted 90 days after each plan, events and place reports after 365 days, daily backups.

## Not covered (decide before scaling past the pilot)

- More than one app container (needs shared rate limits and a single scheduler).
- Off-site backup copying (scripted with your provider's tools) and alerting on `ALERT:` log lines.
- A web application firewall or DDoS protection (for example, putting Cloudflare in front of Caddy).
- Penetration testing, and the device and 200% text-size testing the PRD asks for.
