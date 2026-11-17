// Checking that a call really came from mo, for one profile.
//
// mo signs every call the Standard Webhooks way
// (https://www.standardwebhooks.com/): HMAC-SHA256 over
// `${webhook-id}.${webhook-timestamp}.${raw body}`, base64, sent as
// `webhook-signature: v1,<signature>`; while a secret is being replaced the
// header carries two entries separated by a space.
//
// Two rules a receiver must keep:
//   1. Sign over the raw bytes received. Never parse and re-serialize first.
//   2. The secret is the profile's own. mo also sends x-mcp-subscription-id,
//      which the signature does not cover: never use it to pick a profile or
//      a secret.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Standard Webhooks' default: refuse a timestamp more than 5 minutes off. */
export const TOLERANCE_SECONDS = 300;

export type SignatureRefusal =
  | "missing_headers"
  | "bad_timestamp"
  | "stale_timestamp"
  | "bad_secret"
  | "no_match";

export type Headers = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

/** The key inside `whsec_<base64 of 24 to 64 bytes>`, or undefined. */
export function signingKey(secret: string) {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return undefined;
  const key = Buffer.from(secret.slice(6), "base64");
  return key.length >= 24 && key.length <= 64 ? key : undefined;
}

export function signature(
  key: Buffer,
  id: string,
  timestamp: string,
  rawBody: Buffer,
) {
  return createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();
}

/**
 * `secrets` are this profile's own: its current one and, only while it is
 * being replaced, the candidate. Returns the webhook id on success.
 */
export function verifyCall(
  rawBody: Buffer,
  headers: Headers,
  secrets: readonly string[],
  nowMs: number = Date.now(),
): { ok: true; id: string } | { ok: false; reason: SignatureRefusal } {
  const id = one(headers["webhook-id"]);
  const timestamp = one(headers["webhook-timestamp"]);
  const sent = one(headers["webhook-signature"]);
  if (!id || !timestamp || !sent || id.length > 256 || sent.length > 1024)
    return { ok: false, reason: "missing_headers" };
  if (!/^[0-9]{1,12}$/.test(timestamp))
    return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS)
    return { ok: false, reason: "stale_timestamp" };
  const keys = secrets.map(signingKey);
  if (!keys.length || keys.some((key) => !key))
    return { ok: false, reason: "bad_secret" };
  const offered = sent
    .split(" ")
    .filter((entry) => entry.startsWith("v1,"))
    .map((entry) => Buffer.from(entry.slice(3), "base64"));
  let match = false;
  // Every pair is compared, so timing does not show which secret matched.
  for (const key of keys) {
    const expected = signature(key!, id, timestamp, rawBody);
    for (const candidate of offered)
      if (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      )
        match = true;
  }
  return match ? { ok: true, id } : { ok: false, reason: "no_match" };
}
