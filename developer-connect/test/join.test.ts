// A join saved for one account (a product's runtime join) becomes active only
// as that account with the agent role. The server here is a local stand-in
// that answers the redeem with whatever the test says.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { joinProfile, Stop } from "../src/join.js";
import { State } from "../src/state.js";

const state = new State(mkdtempSync(join(tmpdir(), "dc-join-")));
let answer = { account: "", role: "agent" };
let calls = 0;
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    calls++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        session: {
          account: { id: answer.account, displayName: "Someone" },
          credential: {
            connectionId: "c1",
            role: answer.role,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      }),
    );
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  state.close();
  server.close();
});
const join1 = (name: string, expectAccount?: string) =>
  joinProfile(state, {
    name,
    server: () => url,
    label: "Developer connector",
    joinCode: async () => "code",
    ...(expectAccount === undefined ? {} : { expectAccount }),
  });

test("a join made for one account is not activated by an answer for another account, or with another role", async () => {
  for (const wrong of [
    { account: "other", role: "agent" },
    { account: "product", role: "owner" },
  ]) {
    answer = wrong;
    await assert.rejects(join1("acme", "product"), (error) => {
      assert.ok(error instanceof Stop);
      assert.match(error.message, /different account or role/);
      return true;
    });
    assert.equal(state.profile("acme"), undefined, "nothing is kept");
  }
  answer = { account: "product", role: "agent" };
  const joined = await join1("acme", "product");
  assert.equal(joined.accountId, "product");
  assert.equal(state.profile("acme")!.state, "active");
});

test("an unfinished ordinary join under the name is not sent again for a product, and an ordinary join is unbound", async () => {
  server.removeAllListeners("request");
  let refuse = true;
  server.on("request", (request, response) => {
    request.resume();
    if (refuse) return void response.destroy();
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        session: {
          account: { id: "person", displayName: "Person" },
          credential: {
            connectionId: "c2",
            role: "owner",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      }),
    );
  });
  await assert.rejects(join1("beta"), /did not answer/);
  assert.equal(state.profile("beta")!.state, "joining");
  assert.equal(state.profile("beta")!.account_id, null);
  refuse = false;
  await assert.rejects(join1("beta", "product"), /unfinished join saved/);
  assert.equal(state.profile("beta")!.state, "joining");
  // The ordinary join it was made as still finishes, as whatever mo gave.
  const done = await join1("beta");
  assert.deepEqual(done, { role: "owner", accountId: "person" });
});
