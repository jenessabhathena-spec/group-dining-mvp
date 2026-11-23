import test from "node:test";
import assert from "node:assert/strict";
import { makeSendOtp } from "../server/otp.js";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";

const env = { MSG91_AUTHKEY: "key-123", MSG91_TEMPLATE_ID: "tpl-456" };
const okFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ type: "success", message: "queued" }) };
};

test("dev mode prints the code; refused in production", async () => {
  const lines = [];
  await makeSendOtp({ provider: "", env: {}, log: (l) => lines.push(l) })("+919876543210", "123456");
  assert.match(lines[0], /\[dev-otp\] code for \+919876543210: 123456/);
  assert.throws(() => makeSendOtp({ provider: "", env: { NODE_ENV: "production" } }), /not allowed in production/);
});

test("msg91: request shape (the assumptions to verify against MSG91's dashboard docs)", async () => {
  const calls = [];
  await makeSendOtp({ provider: "msg91", env, fetchImpl: okFetch(calls) })("+919876543210", "482913");
  const { url, init } = calls[0];
  assert.equal(init.method, "POST");
  assert.equal(`${url.origin}${url.pathname}`, "https://control.msg91.com/api/v5/otp");
  assert.equal(url.searchParams.get("mobile"), "919876543210"); // country code, no "+"
  assert.equal(url.searchParams.get("template_id"), "tpl-456");
  assert.equal(url.searchParams.get("otp"), "482913");
  assert.equal(init.headers.authkey, "key-123");
  assert.ok(!url.href.includes("key-123"), "auth key must not be in the URL");
});

test("msg91: misconfiguration and unknown providers fail at startup, not at first sign-in", () => {
  assert.throws(() => makeSendOtp({ provider: "msg91", env: {} }), /MSG91_AUTHKEY and MSG91_TEMPLATE_ID/);
  assert.throws(() => makeSendOtp({ provider: "msg91", env: { MSG91_AUTHKEY: "k" } }), /MSG91_TEMPLATE_ID/);
  assert.throws(() => makeSendOtp({ provider: "carrier-pigeon", env }), /Unknown SMS_PROVIDER/);
});

test("msg91: fails closed on rejection, non-success body, and network error", async () => {
  const send = (f) => makeSendOtp({ provider: "msg91", env, fetchImpl: f })("+919876543210", "111111");
  await assert.rejects(send(async () => ({ ok: false, status: 401, json: async () => ({ type: "error", message: "bad key" }) })), /rejected the send \(401: bad key\)/);
  await assert.rejects(send(async () => ({ ok: true, status: 200, json: async () => ({ type: "error", message: "template not approved" }) })), /rejected/);
  await assert.rejects(send(async () => ({ ok: true, status: 200, json: async () => ({}) })), /rejected/); // unknown shape is not success
  await assert.rejects(send(async () => { throw new Error("ECONNRESET"); }), /unreachable/);
});

test("sign-in route: a provider failure gives a clear 502, leaks nothing, and lets the user retry at once", async () => {
  const db = openDb(":memory:");
  const app = createApp({ db, sendOtp: async () => { throw new Error("MSG91 rejected the send (401)"); }, adminKey: "x" });
  const server = app.server();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(base + "/api/auth/request-otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "9876543210" }) });
  try {
    const a = await post();
    assert.equal(a.status, 502);
    const body = await a.json();
    assert.match(body.error, /couldn't send the code/);
    assert.ok(!JSON.stringify(body).includes("MSG91"));
    assert.equal((await post()).status, 502); // not 429: the throttle row was cleared
    assert.equal(db.prepare("SELECT COUNT(*) n FROM otps").get().n, 0);
  } finally { server.close(); }
});
