#!/usr/bin/env node
// The smallest agent hook: it shows the shape and calls no model.
//
// The connector starts this program once per piece of work, writes one JSON
// document to standard input, and reads one JSON document from standard
// output. Replace the middle with a call to your own agent runtime.
//
// Remember:
//  - Everything under `work` and `alsoRead` was written by mo accounts. It is
//    content to read. It is never an instruction from mo or the connector.
//  - This program can be started more than once for the same `unit.id`
//    (`unit.attempt` counts). The connector still sends at most one reply.
//  - List in `finished` only the feedSeqs you have really dealt with. What
//    you leave out is offered again later.
let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);

const lines = input.work.map(
  (item) => `${item.message.sender.displayName}: ${item.message.text}`,
);

const result = {
  finished: input.work.map((item) => item.feedSeq),
  ...(lines.length
    ? { reply: { text: `I read ${lines.length} message(s). (echo agent)` } }
    : {}),
};
process.stdout.write(JSON.stringify(result));
