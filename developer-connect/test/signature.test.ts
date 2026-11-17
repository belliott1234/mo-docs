import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { verifyCall, TOLERANCE_SECONDS } from "../src/signature.js";

const secretOf = (bytes: Buffer) => `whsec_${bytes.toString("base64")}`;
// Written out independently of src/signature.ts, as mo's sender does it.
function sign(secret: string, id: string, timestamp: number, body: string) {
  const key = Buffer.from(secret.slice(6), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}
const now = 1_800_000_000_000;
const seconds = now / 1000;
const body = JSON.stringify({
  eventId: "evt_1",
  name: "mo.message.created",
  data: { feedSeq: 7 },
});
const mine = secretOf(randomBytes(32));
const other = secretOf(randomBytes(32));
const call = (secret: string, extra: Record<string, string> = {}) => ({
  "webhook-id": "evt_1",
  "webhook-timestamp": String(seconds),
  "webhook-signature": sign(secret, "evt_1", seconds, body),
  ...extra,
});

test("a call signed with the profile's secret is accepted", () => {
  assert.deepEqual(verifyCall(Buffer.from(body), call(mine), [mine], now), {
    ok: true,
    id: "evt_1",
  });
});

test("the Standard Webhooks published example verifies", () => {
  // https://www.standardwebhooks.com/ reference vector.
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const payload = '{"test": 2432232314}';
  const headers = {
    "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
    "webhook-timestamp": "1614265330",
    "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  };
  assert.equal(
    verifyCall(Buffer.from(payload), headers, [secret], 1614265330_000).ok,
    true,
  );
});

test("another profile's secret, a changed body and a changed id are refused", () => {
  const raw = Buffer.from(body);
  assert.deepEqual(verifyCall(raw, call(other), [mine], now), {
    ok: false,
    reason: "no_match",
  });
  assert.equal(
    verifyCall(Buffer.from(body + " "), call(mine), [mine], now).ok,
    false,
  );
  assert.equal(
    verifyCall(raw, { ...call(mine), "webhook-id": "evt_2" }, [mine], now).ok,
    false,
  );
});

test("the unsigned subscription header changes nothing", () => {
  const raw = Buffer.from(body);
  const forged = { "x-mcp-subscription-id": "sub_someone_elses" };
  assert.equal(verifyCall(raw, call(mine, forged), [mine], now).ok, true);
  assert.equal(verifyCall(raw, call(other, forged), [mine], now).ok, false);
});

test("a stale or future timestamp is refused, the edge is accepted", () => {
  const raw = Buffer.from(body);
  const late = now + (TOLERANCE_SECONDS + 1) * 1000;
  assert.deepEqual(verifyCall(raw, call(mine), [mine], late), {
    ok: false,
    reason: "stale_timestamp",
  });
  assert.equal(
    verifyCall(raw, call(mine), [mine], now - (TOLERANCE_SECONDS + 1) * 1000)
      .ok,
    false,
  );
  assert.equal(
    verifyCall(raw, call(mine), [mine], now + TOLERANCE_SECONDS * 1000).ok,
    true,
  );
});

test("two entries during a secret change: either of the profile's secrets matches", () => {
  const raw = Buffer.from(body);
  const candidate = secretOf(randomBytes(24));
  const both = {
    ...call(mine),
    "webhook-signature": `${sign(candidate, "evt_1", seconds, body)} ${sign(mine, "evt_1", seconds, body)}`,
  };
  assert.equal(verifyCall(raw, both, [mine], now).ok, true);
  assert.equal(
    verifyCall(raw, call(candidate), [mine, candidate], now).ok,
    true,
  );
  assert.equal(verifyCall(raw, both, [other], now).ok, false);
});

test("missing or malformed input is refused without throwing", () => {
  const raw = Buffer.from(body);
  assert.deepEqual(verifyCall(raw, {}, [mine], now), {
    ok: false,
    reason: "missing_headers",
  });
  assert.deepEqual(
    verifyCall(
      raw,
      { ...call(mine), "webhook-timestamp": "soon" },
      [mine],
      now,
    ),
    { ok: false, reason: "bad_timestamp" },
  );
  assert.deepEqual(verifyCall(raw, call(mine), ["not-a-secret"], now), {
    ok: false,
    reason: "bad_secret",
  });
  assert.deepEqual(verifyCall(raw, call(mine), [], now), {
    ok: false,
    reason: "bad_secret",
  });
  assert.equal(
    verifyCall(
      raw,
      { ...call(mine), "webhook-signature": "v1,!!!! v2,abc" },
      [mine],
      now,
    ).ok,
    false,
  );
});
