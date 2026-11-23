// Day-of reminder delivery (F15). Same pattern as OTP: a provider only has to deliver.
//
// Payload kinds:
//   "place"    {occasion, date, time, place, area, directionsUrl}   the normal reminder, with directions
//   "surprise" {occasion, date, time}                               for the person being surprised: NO place
//
// SMS_PROVIDER unset (dev)  -> printed to the console, never in production
// SMS_PROVIDER=msg91        -> needs MSG91_AUTHKEY, MSG91_REMINDER_TEMPLATE_ID and
//                              MSG91_REMINDER_SURPRISE_TEMPLATE_ID (a second DLT-approved template)
// Anything else / missing template -> returns null: reminders are switched OFF (the server says so at
// startup and the UI says "no reminders"). A missing reminder channel must not take sign-in down.

const MSG91_FLOW_URL = "https://control.msg91.com/api/v5/flow";

export class ReminderError extends Error {}

export const when12h = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

// The human text, used by dev mode and as the reference wording for the DLT template.
export function reminderText(p) {
  if (p.kind === "rate") return `How was ${p.place}? Tell us in one tap (did you go, 1-5): ${p.url}`;
  if (p.kind === "surprise") return `Reminder: ${p.occasion} today at ${when12h(p.time)}. The place is a surprise and will be revealed to you today.`;
  return `Reminder: ${p.occasion} today at ${when12h(p.time)}. ${p.place}, ${p.area}. Directions: ${p.directionsUrl}`;
}

// Kind "rate" (F11 next-day check) needs its own DLT template; without it only that kind is off.
// The returned function carries `supports`, so the scheduler never tries a kind it cannot send.
export function makeSendReminder({ provider = process.env.SMS_PROVIDER, env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  if (!provider) {
    if (env.NODE_ENV === "production") return null;
    const dev = async (phone, payload) => {
      log(`[dev-reminder] to ${phone}: ${reminderText(payload)}`);
    };
    dev.supports = new Set(["place", "surprise", "rate"]);
    return dev;
  }

  if (provider === "msg91") {
    const authkey = env.MSG91_AUTHKEY, placeTpl = env.MSG91_REMINDER_TEMPLATE_ID, surpriseTpl = env.MSG91_REMINDER_SURPRISE_TEMPLATE_ID, rateTpl = env.MSG91_RATE_TEMPLATE_ID;
    if (!authkey || !placeTpl || !surpriseTpl) return null;
    const send = async (phone, payload) => {
      if (payload.kind === "rate") {
        if (!rateTpl) throw new ReminderError("No MSG91_RATE_TEMPLATE_ID configured");
        return post({ template_id: rateTpl, recipients: [{ mobiles: phone.replace(/^\+/, ""), place: payload.place, url: payload.url }] });
      }
      // UNVERIFIED against MSG91's official docs (as with OTP, the pages were unreachable). From
      // third-party references: POST /api/v5/flow, `authkey` header, JSON body with template_id and
      // recipients[{mobiles, <template variables>}]. Variable names must match the DLT template exactly.
      // Pinned in test/reminders.test.js so a correction is a one-place edit.
      const surprise = payload.kind === "surprise";
      const recipient = surprise
        ? { mobiles: phone.replace(/^\+/, ""), occasion: payload.occasion, time: when12h(payload.time) }
        : { mobiles: phone.replace(/^\+/, ""), occasion: payload.occasion, time: when12h(payload.time), place: payload.place, area: payload.area, url: payload.directionsUrl };
      return post({ template_id: surprise ? surpriseTpl : placeTpl, recipients: [recipient] });
    };
    async function post(body) {
      let res, out;
      try {
        res = await fetchImpl(MSG91_FLOW_URL, {
          method: "POST",
          headers: { authkey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
        out = await res.json().catch(() => ({}));
      } catch {
        throw new ReminderError("SMS provider unreachable");
      }
      if (!res.ok || out.type !== "success") throw new ReminderError(`MSG91 rejected the reminder (${res.status}${out.message ? ": " + String(out.message).slice(0, 120) : ""})`);
    }
    send.supports = new Set(rateTpl ? ["place", "surprise", "rate"] : ["place", "surprise"]);
    return send;
  }
  return null;
}
