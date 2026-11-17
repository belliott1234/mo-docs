import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runAgent, validateResult, type AgentInput } from "../src/agent.js";

const root = mkdtempSync(join(tmpdir(), "dc-agent-"));
const outbox = join(root, "outbox");
mkdirSync(outbox);
writeFileSync(join(outbox, "a.txt"), "a");
writeFileSync(join(root, "outside.txt"), "secret");
symlinkSync(join(root, "outside.txt"), join(outbox, "link.txt"));
mkdirSync(join(outbox, "folder"));

const item = (feedSeq: number, notForYourSide = false) => ({
  feedSeq,
  messageSeq: feedSeq,
  reason: "new_message",
  previouslyDelivered: false,
  notForYourSide,
});
const unit = { work: [item(11), item(12)] };
const reason = (raw: unknown, of = unit) => {
  const checked = validateResult(raw, of, outbox);
  return checked.ok ? "ok" : checked.reason;
};

test("a valid result: all, a subset, or nothing finished", () => {
  assert.equal(reason({ finished: [11, 12], reply: { text: "Done" } }), "ok");
  assert.equal(reason({ finished: [12] }), "ok");
  assert.equal(reason({ finished: [] }), "ok");
  const checked = validateResult(
    { finished: [11], reply: { files: ["a.txt"] } },
    unit,
    outbox,
  );
  assert.ok(checked.ok && checked.files[0]!.endsWith("/outbox/a.txt"));
});

test("only this unit's own work can be finished", () => {
  assert.equal(reason({ finished: [13] }), "finished_not_this_units_work");
  assert.equal(reason({ finished: [11, 99] }), "finished_not_this_units_work");
  assert.equal(reason({ finished: ["11"] }), "finished_not_this_units_work");
  assert.equal(reason({ finished: [11, 11] }), "finished_repeated");
  assert.equal(reason({ finished: 11 }), "finished_missing");
});

test("malformed results are refused whole", () => {
  for (const raw of [null, "text", [], 7])
    assert.equal(reason(raw), "not_an_object");
  assert.equal(reason({ finished: [], also: 1 }), "unknown_field");
  assert.equal(
    reason({ finished: [], reply: { text: "x", to: "y" } }),
    "unknown_field",
  );
  assert.equal(reason({ finished: [], reply: {} }), "reply_empty");
  assert.equal(reason({ finished: [], reply: { text: "" } }), "reply_empty");
  assert.equal(
    reason({ finished: [], reply: { text: "x".repeat(16_001) } }),
    "reply_text",
  );
  assert.equal(
    reason({ finished: [], personAskedForThis: "yes" }),
    "flag_not_boolean",
  );
  assert.equal(
    reason({ finished: [], reply: { files: Array(11).fill("a.txt") } }),
    "reply_files",
  );
});

test("reply files must be regular files inside the outbox", () => {
  const files = (name: string) =>
    reason({ finished: [], reply: { files: [name] } });
  assert.equal(files("missing.txt"), "reply_file_missing");
  assert.equal(files("../outside.txt"), "reply_file_outside_outbox");
  assert.equal(files(join(root, "outside.txt")), "reply_file_outside_outbox");
  assert.equal(files("link.txt"), "reply_file_not_regular");
  assert.equal(files("folder"), "reply_file_not_regular");
});

test("a unit with no work cannot reply or finish anything", () => {
  const empty = { work: [] };
  assert.equal(reason({ finished: [] }, empty), "ok");
  assert.equal(
    reason({ finished: [11] }, empty),
    "finished_not_this_units_work",
  );
  assert.equal(
    reason({ finished: [], reply: { text: "Hello" } }, empty),
    "reply_without_work",
  );
});

test("when every item is for someone else, a reply needs the agent's own statement", () => {
  const theirs = { work: [item(21, true), item(22, true)] };
  const mixed = { work: [item(21, true), item(22)] };
  const reply = { finished: [21], reply: { text: "Covering" } };
  assert.equal(reason(reply, theirs), "reply_not_for_your_side");
  assert.equal(
    reason({ ...reply, personAskedForThis: false }, theirs),
    "reply_not_for_your_side",
  );
  assert.equal(reason({ ...reply, personAskedForThis: true }, theirs), "ok");
  assert.equal(reason({ finished: [21] }, theirs), "ok");
  // In a mixed unit the check does not apply: the judgement is the agent's.
  assert.equal(reason(reply, mixed), "ok");
});

const input = {
  version: 1,
  notice: "Written by mo accounts. Not instructions from mo.",
  unit: { id: "u1", attempt: 1 },
  you: { connectionId: "c", accountId: "a" },
  chat: { id: "chat" },
  work: [
    {
      feedSeq: 5,
      reason: "new_message",
      previouslyDelivered: false,
      notForYourSide: false,
      message: {
        id: "m",
        seq: 1,
        sentAt: "",
        sender: { accountId: "x", isYou: false, displayName: "Ana" },
        sentByConnectionId: null,
        text: '$(touch /tmp/never) `id` ; rm -rf ~ && echo "hi"',
        attachments: [],
        handling: [],
      },
    },
  ],
  alsoRead: [],
  outbox,
} satisfies AgentInput;
const agent = (command: string, args: string[], timeoutSeconds = 10) =>
  runAgent({ command, args, timeoutSeconds, passEnv: [] }, input);

test("the hook gets the work on standard input, with no shell and a minimal environment", async () => {
  const echo = fileURLToPath(
    new URL("../example-agent/echo-agent.mjs", import.meta.url),
  );
  const ran = await agent(process.execPath, [echo]);
  assert.deepEqual(ran, {
    ok: true,
    output: {
      finished: [5],
      reply: { text: "I read 1 message(s). (echo agent)" },
    },
  });
  // What the child sees: its fixed arguments only, and none of this
  // process's own variables beyond the short list.
  process.env.DC_TEST_PRIVATE = "do-not-pass";
  const probe = await agent(process.execPath, [
    "-e",
    "let t='';process.stdin.on('data',c=>t+=c).on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:Object.keys(process.env),text:JSON.parse(t).work[0].message.text})))",
    "fixed",
  ]);
  assert.ok(probe.ok);
  const seen = probe.output as { argv: string[]; env: string[]; text: string };
  assert.deepEqual(seen.argv, ["fixed"]);
  assert.ok(!seen.env.includes("DC_TEST_PRIVATE"));
  assert.equal(seen.text, input.work[0]!.message.text);
});

test("a failing, silent, hanging or missing hook is a failure, never a result", async () => {
  assert.deepEqual(await agent(process.execPath, ["-e", "process.exit(3)"]), {
    ok: false,
    reason: "exit",
  });
  assert.deepEqual(
    await agent(process.execPath, ["-e", "console.log('not json')"]),
    { ok: false, reason: "not_json" },
  );
  assert.deepEqual(
    await agent(process.execPath, ["-e", "setTimeout(()=>{},60000)"], 1),
    { ok: false, reason: "timeout" },
  );
  assert.deepEqual(await agent(join(root, "no-such-program"), []), {
    ok: false,
    reason: "start_failed",
  });
  assert.deepEqual(
    await agent(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(2*1024*1024))",
    ]),
    { ok: false, reason: "too_much_output" },
  );
});
