import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newKey } from "../src/mo-api.js";
import { createReceiver } from "../src/receiver.js";
import { State, StateInUse } from "../src/state.js";

const directory = mkdtempSync(join(tmpdir(), "dc-receiver-"));
const state = new State(directory);
const secretOf = () => `whsec_${randomBytes(32).toString("base64")}`;
const profiles = ["a", "b"].map((name) => {
  const made = {
    name,
    routeToken: randomBytes(24).toString("base64url"),
    signingSecret: secretOf(),
  };
  state.createProfile({
    ...made,
    server: "https://mo.example",
    label: "Test",
    keys: { credential: { ...newKey(), label: "Test" }, renewalKey: newKey() },
    joinCode: "code",
  });
  state.joined(name, {
    accountId: "acc",
    connectionId: "con",
    accessExpires: new Date().toISOString(),
  });
  return made;
});
const [a, b] = profiles as [(typeof profiles)[0], (typeof profiles)[0]];
const woken: string[] = [];
let failSaves = false;
const failing = new Proxy(state, {
  get(target, name, receiver) {
    if (name === "acceptEvent" && failSaves)
      return () => {
        throw new Error("disk full");
      };
    const value = Reflect.get(target, name, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const server = createReceiver(
  failing,
  (profile) => woken.push(profile),
  () => {},
);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  state.close();
});

function post(
  route: string,
  secret: string,
  id: string,
  body: string,
  extra: Record<string, string> = {},
  at = Math.floor(Date.now() / 1000),
) {
  const key = Buffer.from(secret.slice(6), "base64");
  return fetch(`${origin}/mo/events/${route}`, {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(at),
      "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64")}`,
      ...extra,
    },
    body,
  });
}
const event = (id: string, feedSeq: number) =>
  JSON.stringify({
    eventId: id,
    name: "mo.message.created",
    data: { feedSeq },
    cursor: `c${feedSeq}`,
  });
const generation = (name: string) => state.wake(name).wake_generation;

test("a second process cannot open the same state folder", () => {
  assert.throws(() => new State(directory), StateInUse);
});

test("a signed call is saved once, however often it is repeated", async () => {
  const before = generation("a");
  const answers = await Promise.all(
    [1, 2, 3].map(() =>
      post(a.routeToken, a.signingSecret, "evt_1", event("evt_1", 4)),
    ),
  );
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  );
  assert.equal(generation("a"), before + 1);
  assert.deepEqual(woken, ["a"]);
  assert.equal(generation("b"), 0);
});

test("the challenge is echoed and saves nothing", async () => {
  const before = generation("a");
  const answer = await post(
    a.routeToken,
    a.signingSecret,
    "msg_verification_1",
    JSON.stringify({ type: "verification", challenge: "xyz" }),
  );
  assert.deepEqual(await answer.json(), { challenge: "xyz" });
  assert.equal(generation("a"), before);
});

test("authority comes from the address and that profile's own secret, never from a header", async () => {
  const before = [generation("a"), generation("b")];
  const body = event("evt_2", 5);
  // Another profile's secret; a header naming the other profile; a stale
  // time; a body changed after signing; no signature; an unknown address.
  assert.equal(
    (await post(a.routeToken, b.signingSecret, "evt_2", body)).status,
    401,
  );
  assert.equal(
    (
      await post(a.routeToken, b.signingSecret, "evt_2", body, {
        "x-mcp-subscription-id": "b",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post(b.routeToken, a.signingSecret, "evt_2", body, {
        "x-mcp-subscription-id": "a",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post(
        a.routeToken,
        a.signingSecret,
        "evt_2",
        body,
        {},
        Math.floor(Date.now() / 1000) - 301,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await post(a.routeToken, a.signingSecret, "evt_2", body, {
        "webhook-id": "evt_other",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${origin}/mo/events/${a.routeToken}`, {
        method: "POST",
        body,
      })
    ).status,
    401,
  );
  assert.equal(
    (await post("z".repeat(32), a.signingSecret, "evt_2", body)).status,
    404,
  );
  assert.equal(
    (await fetch(`${origin}/mo/events/${a.routeToken}`)).status,
    404,
  );
  assert.deepEqual([generation("a"), generation("b")], before);
  // The forged header changes nothing for a correctly signed call either.
  assert.equal(
    (
      await post(a.routeToken, a.signingSecret, "evt_2", body, {
        "x-mcp-subscription-id": "b",
      })
    ).status,
    200,
  );
  assert.deepEqual(
    [generation("a"), generation("b")],
    [before[0]! + 1, before[1]],
  );
});

test("during a secret change either of the profile's secrets is accepted", async () => {
  const candidate = secretOf();
  state.setCandidateSecret("a", candidate);
  assert.equal(
    (await post(a.routeToken, candidate, "evt_3", event("evt_3", 6))).status,
    200,
  );
  assert.equal(
    (await post(a.routeToken, a.signingSecret, "evt_4", event("evt_4", 7)))
      .status,
    200,
  );
  assert.equal(
    (await post(b.routeToken, candidate, "evt_5", event("evt_5", 8))).status,
    401,
  );
});

test("too large a body is refused; a save that fails answers 500 so mo tries again", async () => {
  const big = JSON.stringify({ pad: "x".repeat(70_000) });
  const refused = await post(a.routeToken, a.signingSecret, "evt_6", big).catch(
    () => ({ status: 413 }),
  );
  assert.equal(refused.status, 413);
  const before = generation("a");
  failSaves = true;
  assert.equal(
    (await post(a.routeToken, a.signingSecret, "evt_7", event("evt_7", 9)))
      .status,
    500,
  );
  failSaves = false;
  assert.equal(generation("a"), before);
  // mo's retry carries the same id and is saved this time.
  assert.equal(
    (await post(a.routeToken, a.signingSecret, "evt_7", event("evt_7", 9)))
      .status,
    200,
  );
  assert.equal(generation("a"), before + 1);
});

test("a disconnected profile's address stops answering", async () => {
  state.disconnect("b", "removed");
  assert.equal(
    (await post(b.routeToken, b.signingSecret, "evt_8", event("evt_8", 1)))
      .status,
    404,
  );
});

test("the unanswered-open marker: cleared only by its own call's answer, and it keeps its row", () => {
  const chat = "chat-1";
  assert.equal(state.startChatRead("a", chat), true);
  assert.equal(state.startChatRead("a", chat), false);
  state.openSent("a", chat, "K1");
  // A late answer from an abandoned call (another key) clears nothing.
  state.openAnswered("a", chat, "K0", 7);
  assert.equal(state.chatRead("a", chat)!.open_unanswered, "K1");
  assert.equal(state.chatRead("a", chat)!.opened_through, 7);
  // A removal notice does not drop a row whose open is unanswered.
  state.forgetChat("a", chat);
  assert.ok(state.chatRead("a", chat));
  // The observer records its own key first; its saved answer ends the duty.
  state.openSent("a", chat, "K2");
  state.openAnswered("a", chat, "K1", 9);
  assert.equal(state.chatRead("a", chat)!.open_unanswered, "K2");
  state.openAnswered("a", chat, "K2", 12);
  assert.deepEqual(
    { ...state.chatRead("a", chat)! },
    {
      handed_through: 0,
      opened_through: 12,
      unconfirmed: 1,
      open_unanswered: null,
    },
  );
  // The position never moves back, and tightening happens once at most.
  state.openAnswered("a", chat, "K2", 3, 5);
  assert.deepEqual(
    { ...state.chatRead("a", chat)! },
    {
      handed_through: 5,
      opened_through: 12,
      unconfirmed: 0,
      open_unanswered: null,
    },
  );
  state.openAnswered("a", chat, "K2", 12, 11);
  assert.equal(state.chatRead("a", chat)!.handed_through, 5);
  state.forgetChat("a", chat);
  assert.equal(state.chatRead("a", chat), undefined);
});
