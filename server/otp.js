// SMS one-time-code delivery.
//
// SMS_PROVIDER=msg91  -> MSG91 (needs MSG91_AUTHKEY and MSG91_TEMPLATE_ID, see README "SMS setup")
// unset               -> dev mode: the code is printed to the server console. Refused in production.
//
// We generate and verify codes ourselves (server/app.js); a provider only has to deliver the digits.

const MSG91_URL = "https://control.msg91.com/api/v5/otp";

export class SmsError extends Error {}

export function makeSendOtp({ provider = process.env.SMS_PROVIDER, env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  if (!provider) {
    if (env.NODE_ENV === "production") throw new Error("SMS_PROVIDER is not set. Dev mode prints codes to the console and is not allowed in production.");
    return async (phone, code) => {
      log(`[dev-otp] code for ${phone}: ${code}`);
    };
  }

  if (provider === "msg91") {
    const authkey = env.MSG91_AUTHKEY, templateId = env.MSG91_TEMPLATE_ID;
    if (!authkey || !templateId) throw new Error("SMS_PROVIDER=msg91 needs MSG91_AUTHKEY and MSG91_TEMPLATE_ID");
    return async (phone, code) => {
      // UNVERIFIED against MSG91's official docs (their endpoint pages were unreachable when this was
      // written). Taken from third-party references: POST /api/v5/otp, `authkey` header, query params
      // template_id / mobile (country code, no "+") / otp (our own code). Confirm in the MSG91 dashboard
      // before launch; every assumption here is covered by test/otp.test.js so a change is one edit.
      const url = new URL(MSG91_URL);
      url.searchParams.set("template_id", templateId);
      url.searchParams.set("mobile", phone.replace(/^\+/, ""));
      url.searchParams.set("otp", code);
      let res, body;
      try {
        res = await fetchImpl(url, { method: "POST", headers: { authkey, "content-type": "application/json", accept: "application/json" }, body: "{}" });
        body = await res.json().catch(() => ({}));
      } catch {
        throw new SmsError("SMS provider unreachable");
      }
      // Fail closed: anything but an explicit success means the user did not get a code.
      if (!res.ok || body.type !== "success") throw new SmsError(`MSG91 rejected the send (${res.status}${body.message ? ": " + String(body.message).slice(0, 120) : ""})`);
    };
  }

  throw new Error(`Unknown SMS_PROVIDER "${provider}". Supported: msg91`);
}
