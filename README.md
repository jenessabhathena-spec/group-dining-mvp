# Group Dining MVP: engine, backend, prototype

Built from `PRD - Group Dining Decision App (MVP, Bengaluru).pdf`. Node 22.13+ (tested on 24), **no npm dependencies** (uses built-in `node:sqlite`).

## Deploy

See **[DEPLOY.md](DEPLOY.md)**: one server in India (DigitalOcean Bangalore or AWS Mumbai), Docker Compose with Caddy for automatic HTTPS, a production config check that refuses unsafe settings, and `node scripts/smoke.mjs https://your-domain` to verify a deploy.

## Run

```
npm test            # 132 tests
npm start           # http://localhost:3000  (SQLite file: group-dining.sqlite)
```

Environment variables:

| Variable | Effect |
|---|---|
| `RESTAURANTS_CSV` | path to the curated restaurant spreadsheet (CSV export). **Required in production**; a bad file stops the server with row-numbered errors. Unset in dev = the fictional sample list |
| `PORT`, `DB_PATH` | listen port, SQLite path |
| `PUBLIC_URL` | base URL used in the WhatsApp share link (set this in production) |
| `GOOGLE_MAPS_API_KEY` | real travel times (Distance Matrix, traffic-aware, cached) **and** start-point address search (Places API (New)). Enable both APIs on the key. Unset = straight-line travel estimates and area-name search, both labelled/working. The key stays on the server |
| `SMS_PROVIDER` | `msg91` (also set `MSG91_AUTHKEY`, `MSG91_TEMPLATE_ID`). Unset = dev mode, codes print to the console; the server refuses to start that way when `NODE_ENV=production` |
| `MSG91_REMINDER_TEMPLATE_ID`, `MSG91_REMINDER_SURPRISE_TEMPLATE_ID` | two DLT-approved reminder templates (see Day-of reminders). If either is missing the reminder channel is OFF and the server says so at startup |
| `ADMIN_KEY` | enables `/api/admin/*` (plan log A2, metrics). Unset = disabled |
| `MSG91_RATE_TEMPLATE_ID` | optional DLT template for the next-day "How was it?" text to the organiser. Without it only that text is off |
| `EVENT_RETENTION_DAYS` | how long analytics events and place reports are kept (default 365) |
| `TRUST_PROXY` | `1` behind one reverse proxy (Caddy in `deploy/`) so limits use the real client IP; otherwise `X-Forwarded-For` is ignored |
| `OTP_DAILY_CAP` | most sign-in codes sent per day for the whole service (default 300), to cap SMS bills |
| `BACKUP_DIR`, `BACKUP_KEEP` | daily database backups and how many to keep (default 7) |

## Layout

- `src/engine.js`, `src/voting.js` - fair-pick engine and vote/veto logic (PRD section 6, F9).
- `src/data.js` - **fictional sample restaurants**. Replace with the curated list (A1).
- `server/app.js` - API, `server/maps.js` - Google travel times + cache + fallback, `server/otp.js` - SMS adapter stub, `server/db.js` - schema and 90-day purge.
- `server/public/friend.html` - the real friend link `/p/:planId` (form, waiting, vote/veto, winner, rating). No sign-in.
- `server/public/organiser.html` - the organiser app at `/` (sign in, new plan, share, who-answered tracker, vote/veto, close or override, winner, rating) on the real API.
- `prototype/index.html` - the earlier standalone click-through, now served at `/prototype` (local-only, no API).

## API (JSON)

```
POST /api/auth/request-otp {phone}            POST /api/auth/verify {phone, code, firstName?} -> {token}
POST /api/plans (Bearer)                      -> {id, url, whatsapp, message}
GET  /api/me, PUT /api/me/profile (Bearer)   taste profile (F2): cuisines, diet, spice, budgetBand, vibe, home, work. All optional
POST /api/solo/picks (Bearer)                 solo "find something new" (F13): {startArea?, area?, time?}
GET  /api/me/places                           {want: [...], been: [...]}
POST /api/me/places                           {restaurantId, status: "want"|"been"|null}  (null removes)
POST /api/plans  ... candidateIds: [..]       up to 5 places from your want-to-try list
GET  /api/plans (Bearer)                      organiser's own plans
GET  /api/plans/:id                           who answered / pending, never what they said
POST /api/plans/:id/responses                 friend form (needs consent:true) -> {memberKey}
POST /api/plans/:id/picks (organiser)         early generate, needs 2+ answers
GET  /api/plans/:id/picks                     picks, votes progress, winner
POST /api/plans/:id/votes | /vetoes           Bearer (organiser) or memberKey (friend)
POST /api/plans/:id/decide (organiser)        close voting, or {overridePickId}
POST /api/plans/:id/ratings                   {went, stars}
DELETE /api/me                                delete organiser data (DPDP)
GET  /api/admin/plans/:id/log, /api/admin/metrics   x-admin-key
```

Picks generate automatically when all listed friends have answered, or lazily at the response deadline.

## SMS setup (MSG91)

Indian SMS needs DLT registration before anything can be delivered, and it is the slowest step (days, not hours). Start it first:

1. Create an MSG91 account and complete its business verification.
2. Register on the DLT portal of an operator, through MSG91 if it offers to do it for you: your entity, a 6-letter sender ID (header), and an OTP template. Template text must match what you send exactly.
3. In MSG91, create the OTP template and note its template ID and your auth key.
4. Set `SMS_PROVIDER=msg91`, `MSG91_AUTHKEY`, `MSG91_TEMPLATE_ID`, then sign in with your own number.

The adapter assumptions to confirm in the MSG91 dashboard docs before launch (all pinned in `test/otp.test.js`): `POST https://control.msg91.com/api/v5/otp`, `authkey` header, query params `template_id`, `mobile` (country code, no +), `otp` (we send our own code), success = JSON `type: "success"`. Your template must contain the variable MSG91 fills the code into. If MSG91 generates its own code instead, our verification would not match, so check that the `otp` parameter is honoured. Any non-success response fails closed with a 502.

## Couples mode (F12)

A plan with `mode: "couple"`: exactly one partner, optional `noise` (`quiet`/`medium`: maximum noise) and `ambience` (vibes, any match) as hard filters. `surprise` is `"partner"` (hide it from them) or `"organiser"` ("surprise me": the partner chooses, hidden from the organiser). With a surprise only the planning partner votes and their single vote decides. Until midnight IST on the plan date the server returns no picks, winner or restaurant data to the hidden partner, and treats an unknown viewer (no key) as hidden. Reads identify the viewer by Bearer token or an `x-member-key` header. The hidden organiser also cannot close or override. Picks generate as soon as the partner answers.

## Solo "find something new" (F13)

Three places from the profile that the person has not been to. A place counts as been-to if they marked it "Been there" or rated "went: yes" on one of their own plans. Those places are removed before the engine runs, so they can never appear as a pick, a spare or a near miss. The same marks make places less novel in that organiser's group plans. One-tap "Been there" on a card marks it and swaps in the next place. Stateless: nothing is stored per request except the marks. Wording is first person ("new to you", "8 min away").

## Want-to-try list (F14)

One status per place per person: `want` or `been`. "Been there" ends the wish; a visited place cannot be turned back into a wish without removing the mark first (409). Saved places show "Saved" on solo cards. When creating a plan the organiser can add up to 5 of their saved places as **candidates**: they join the pool even outside the chosen area, but face exactly the same hard filters and travel fairness as every other place and get **no ranking boost** (tested: scores and ranking are identical with and without candidates). A candidate that fails a filter is dropped silently on purpose, since saying why ("too expensive") would reveal someone's private budget. Picks that came from the list carry a badge and a "on <name>'s want-to-try list" line. When the organiser rates a want-to-try winner "went: yes" it moves to been-there.

## Day-of reminders (F15)

A timer in `server/index.js` runs every minute. A **decided** plan is reminded once its time is within 3 hours and not yet past (so a plan decided late is reminded at once). Recipients: the organiser, plus any friend who opted in on the form with a phone number and a **separate** consent tick. Each plan/recipient is reminded **at most once**; a failed send retries up to 3 times, then stops. A friend's number is stored only for this, is never returned by any endpoint, and is erased as soon as the reminder is sent or given up on. The organiser can switch reminders off per plan. If no channel is configured, no number is collected and the UI says reminders are off.

**Surprises:** the person being surprised gets a different message with the time only and no place until the reveal (midnight IST of the plan date). That matters for plans between 00:00 and 03:00, where the 3-hour mark falls before the reveal; tested both ways.

**Channel:** the PRD leaves it open (WhatsApp Business is Version 2), so this uses SMS through the same provider as sign-in. Dev mode prints to the console. The MSG91 reminder adapter is **unverified against MSG91 official docs**, like the OTP one (`POST /api/v5/flow`, `authkey` header, `template_id` + `recipients[{mobiles, occasion, time, place, area, url}]`; variable names must match your DLT template). Needs two extra DLT templates.

## Restaurant list (A1)

Keep the list in a spreadsheet (Google Sheets or Excel), export it as CSV and set `RESTAURANTS_CSV`. Start from `data/restaurants.template.csv` (`npm run places:template` regenerates it from the sample list). Before deploying, `npm run places:check path/to/file.csv` validates every row and prints row-numbered problems.

Columns: `id, name, area, lat, lng, price_per_head, cuisines, diet_options, vibes, max_group, alcohol, noise, hours, partner, rating, phone, booking_url`. Lists use `|` or commas. **hours** are per weekday, e.g. `mon closed; tue-thu 12:00-15:00,19:00-23:00; fri-sat 12:00-01:00; sun 12:00-22:00` (later parts override earlier ones, unmentioned days are closed, a window may run past midnight). **phone** and **booking_url** (https only) are optional and power the Call and Book buttons on the winner card; without them those buttons are hidden, not broken. Restart the server after updating the file.

## Analytics and metrics

The pages report the PRD events `link_opened`, `response_abandoned` (with the last field reached), `handoff_clicked` (call, directions, booking) and `plan_shared` (only when the organiser actually taps Share or Copy link) to `POST /api/plans/:id/events`. Only allow-listed types and fields are stored, with a random per-browser id and never a name or number. The server logs `response_submitted`, `picks_generated`, `vote_cast`, `pick_vetoed`, `winner_decided`, `organiser_override`, `visit_reported` and `rating_submitted`.

`GET /api/admin/metrics` reports each PRD metric with value, numerator, denominator, target and definition: plan completion, friend response rate (plus abandons by field), median time to decision, visit rate (H3: past decided plans where most members say they went), return rate (H4: another plan within 30 days of the first decided one; organisers whose 30 days are not up are left out), pick satisfaction, veto and override rate, share at partners. "New organisers per plan" is reported as not measurable because friends have no account.

## Privacy

`/privacy` is a **draft** policy written from what the code actually stores, with [placeholders] for the legal entity, contacts, SMS and hosting providers and event-log retention. It must be completed and reviewed by a lawyer before the pilot opens. It is linked from the friend form and the organiser sign-in. A friend can tap **Delete my answers** on the plan page (from the browser that answered): their response, budget, location, reminder number, ratings and reminder rows are deleted. If picks already exist, their first name is replaced by "A friend" in the stored picks, votes, plan log and events, so the vote count stays correct. The friends list the organiser typed keeps the name the organiser wrote.

## Start-point search (F5)

The friend form and the organiser's new-plan form have a search box and a "Use my current location" pin; the area dropdown stays as a fallback. Browsers never talk to Google: they call `GET /api/places/search` and `/api/places/details`, which proxy to Places API (New) with the key kept server-side (verified against Google's docs: endpoints, `X-Goog-Api-Key`, Bengaluru rectangle restriction, response paths, session tokens). **Two details the docs do not spell out are assumed and pinned in `test/places.test.js`**: `sessionToken` as a query parameter on Place Details, and `location` returned as `{latitude, longitude}`. Not yet tried against a real key.

- **Access:** friends have no account, so the endpoints need a plan that is still collecting answers (or an organiser login); otherwise 403. Limited to 60 requests/min per client and 200/min per plan.
- **Fails soft:** no key, a Google outage, an error status or an unreadable reply all fall back to the built-in area list (`degraded: true`), so the form always works.
- **Privacy:** start points are stored as coordinates rounded to about 110 m with **no address text** (the label is dropped); must be inside Bengaluru. Only the chosen place's rounded location is returned to the page, never the full address. Typed searches go to Google, so the privacy policy should say so. "Powered by Google" is shown with Google results.
- **Billing:** one session token per search covers its autocomplete calls and the final lookup.

## Taste profile

Stored on the user. Diet becomes a must-have (veg/vegan/Jain) for every plan; cuisines and vibes feed scoring; home or work area is the default start point; the budget band sets the private ceiling (`1200+` adds none); places rated "went: yes" count as not new. A plan snapshots the profile when created, so later edits never change a running plan.

## PRD details (second pass)

- **Post-visit check (F11):** ratings open at the plan's time (409 before). At 11:00 IST the next day the organiser gets one text with a link straight to the rating (`/?plan=<id>`); needs `PUBLIC_URL` and the rate template, skipped if they already rated. Friends' numbers are erased by then, so the organiser's winner screen has **Ask the group on WhatsApp**.
- **"Closed or changed?"** on every card (picks, winner, solo). `GET /api/admin/reports?days=7` groups reports by restaurant for the weekly curation.
- **Organiser answers for a friend** (PRD risk mitigation): "Answer for them" on the plan status screen, with a tick confirming the friend agreed. The organiser gets a claim link (`/p/<id>#claim=...`) to forward, never a vote key. These answers don't count towards the friend response rate.
- **Shared budget range** on the picks screens, built from the cards: "₹600-900 a head works for all" only when everyone gave a budget, "within every budget given" when some didn't, nothing when the budget was stretched.
- **Waiting screen** shows the actual deadline time.
- **Engine weights** are tunable without a deploy: `GET/PUT /api/admin/weights` (0-5 each); every plan log records the weights used.
- **Optional veto reason** (PRD open question): too far, too pricey, not my food, other. Never shown to the group; summed in the metrics.
- **Budget secrecy in groups of 2-3** (a PRD contradiction resolved): the budget is never stretched, and budget near misses read "Doesn't suit everyone", because in a small group those labels reveal another member's budget. Groups of 4+ and solo keep the PRD behaviour.
- **Retention:** events and place reports are deleted after `EVENT_RETENTION_DAYS`.

**Deliberate deviations:** plan statuses are `open`, `no_picks`, `voting`, `decided`; the PRD's `picking` lasts under 10 seconds (an in-memory guard) and `closed` is just "decided and past". The PRD wants every screen to fit a phone without scrolling; three pick cards with vote buttons don't fit 360x640, so the picks screen scrolls. 200% text size and the target phones (Android 10+, iOS 15+) are untested.

## Not done yet

- SMS: MSG91 adapter is written but **unverified against MSG91's official docs** (see SMS setup). Not tested with a real account.
- Spice is stored in the profile but not used yet: the restaurant tags (A1) have no spice level. All P1 items (F12-F15) are built.
- Scheduling is lazy (checked when someone loads or polls the plan), so there is no push when a deadline passes.
- Hosting is packaged (DEPLOY.md) but not provisioned; the Docker image has not been built or run (no Docker on the development machine). Privacy policy completion and lawyer review; device and accessibility testing.
- Check Google's terms on caching travel results before relying on `travel_cache` (7-day TTL, configurable in `maps.js`).
