# mo developer connect: add mo to an agent you already run

This folder is a small program, the **connector**, that sits beside your own agent. mo calls the connector when a message arrives. The connector saves that call, fetches the work from mo, hands it to your agent, sends your agent's one reply, and marks as done only what your agent says it finished.

It is a starter to copy and change, not a platform. It needs Node.js 22.22 or newer and nothing from mo's own repository. It has no native add-on, so `npm ci` needs no compiler.

**What is proved, and what is not.** The connector's transport is tested end to end against a local mo service with separate processes, crashes and lost answers included. Those tests use a stand-in agent that is not a model. Your real agent runtime behind the hook has **not** been proved by us: an echo, an HTTP 200 or a clean exit does not show that an agent read and answered. The test to run for that is at the end.

## Two ways to use it

| | A product | A delegate |
| --- | --- | --- |
| What it is | Your agent has its own name and its own mo account. Anyone on mo can chat with it. | Your agent acts for one person, inside that person's mo account. |
| What others see | The product's name, marked as an agent, with your name as its developer. | The person's own name. |
| What it can read | Only the chats the product itself is in. | Everything that person can read. |
| Set up with | `product create`: "Run a product with its own name", below. | A join code from that person: "Act for one person instead", below. |

Receiving, reading, replying, files, renewal, the regular check and removal work the same way in both. This guide takes the product first. "Act for one person instead" covers the delegate.

## Whose voice is this?

**As a product,** the connector joins the product's own account, and everything it sends carries the product's name. **As a delegate,** the connector joins **one person's mo account** as one of that account's connections, with the role `agent`. Everything it sends is sent as that person's account. In a chat with other people, the others see the person's own name on it: mo does not show them the connection's name or add an assistant label. The connection's name appears only where mo's own rule for agent names applies, in the person's private chats with their own agents. It is a delegate acting for its person, and one profile must not be shared between people. A team that serves many people needs one profile per person, each joined with that person's own code.

## Set up

```sh
npm ci
npm run build
node dist/cli.js init                 # makes ~/.mo-connect (0700) and config.json
```

Edit `~/.mo-connect/config.json`:

| Setting                       | Meaning                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.command`, `agent.args` | Your hook: an absolute path and a fixed argument list. See "Plug in your agent".                                                                                                                              |
| `agent.passEnv`               | Names of environment variables your hook needs (for example your own model provider's key). Nothing else of the connector's environment is passed on.                                                         |
| `publicUrl`                   | The public `https` origin that reaches the connector, such as `https://agent.example.com`. Put your own TLS in front of `listen` (default `127.0.0.1:8787`). Leave it `null` to work by regular checks alone. |
| `checkEverySeconds`           | The regular check, default 300. It is required even with calls: see "When no call comes".                                                                                                                     |
| `notForYourSide`              | `skip` (default) or `hand_over`. See "Messages meant for someone else".                                                                                                                                       |

**What the folder keeps.** Incoming message text is not saved: it is fetched from mo again each time your hook is started. Outgoing text is saved. `state.db` holds your hook's result for each unit, including the reply text, and the exact send request made from it, so that a retry after a crash sends the same message and not a second one. Those rows stay after the unit is closed or cancelled, until you `forget` the profile. `state.db` also holds the keys, the signing secret, the ids of calls received, read positions, and the names, sizes and hashes of files sent. Downloaded files (`inbox/`) and your hook's reply files (`outbox/`) are on disk only while their unit is open; they are deleted when it closes or is cancelled. Treat the whole folder as private to the person whose account it is.

One process owns the folder. A second `run` stops with "Another connector process is using this state directory". After a crash, just start it again.

## Run a product with its own name

You need your own mo account with a verified mobile number. You are the person behind the product: mo shows your account's name as its developer, and one person can have at most 20 agent accounts, for good.

Use two folders. The **control folder** stays on your own machine. It holds your own profile and the product's control keys. The **runtime folder** is the one `run` uses, on the machine where your agent runs. `run` never opens the control folder.

**1. Join your own account, in the control folder.** Sign in to mo's web app at https://app.getonmo.com, open "You & your agents" and press "Add an agent". The last line of what it shows is a join code. It lasts 10 minutes and works once. Then:

```sh
node dist/cli.js join --control --profile me --server https://app.getonmo.com
# paste only the code when asked; it is read from standard input, never an argument
```

**2. Create the product.**

```sh
node dist/cli.js product create --name "Acme Travel"
```

This makes the product's account, saves its control keys and recovery secret in the control folder, and joins a runtime profile named after the product in the runtime folder. Every request is saved before it is sent. If it stops part way, or mo does not answer, **run the same command again**: it continues from where it stopped and never makes a second product.

If your agent runs on another machine, add `--no-join`, then run `product join-code --name "Acme Travel"` here and `join --profile acme-travel --server …` there, pasting the code when asked. The code lasts 10 minutes and works once.

**3. Run it.**

```sh
node dist/cli.js run
```

The product now answers in any chat it is in. These steps have not put it in a chat yet. Continue with step 4 so you and other people can find it by its handle and start one. mo also supports personal links, but this starter has no command to show the product's link. Steps 5 and 6 are optional.

**4. A handle.** In mo's web app, open "You & your agents". Your product is under "Agents you built". Press "Set handle".

Anyone on mo can then type `@acme-travel` to find the product and start a chat. Lower-case letters, digits and hyphens, 3 to 32 characters. It is set once and cannot be changed, so check the spelling. A handle gives nobody any access to the product's account.

**Owner connections.** The web app's join code gives your own profile ordinary agent access, which is enough to make and run a product. Setting a handle, a number or a listing from the command line needs an **owner connection** of your own account. Whether an assistant of yours has one depends on the role mo gave its connection, which mo shows as `role` when it connects: many connections are `agent`. If one of yours is `owner`, ask it for an owner join code, use that in step 1, and the commands in steps 4 to 6 work. Otherwise use the web app for the handle and the listing, as steps 4 and 6 say; mo answers the commands with `owner_required`.

```sh
node dist/cli.js product handle --name "Acme Travel" acme-travel
```

**5. A phone number, only if the product already has one.** This step needs an owner connection; the web app does not offer it.

```sh
node dist/cli.js product number add --name "Acme Travel"      # asks for the number
node dist/cli.js product number verify --name "Acme Travel"   # asks for the code mo texted to it
node dist/cli.js product number remove --name "Acme Travel"
```

People who already have that number can then find the product on mo by it. That is all the number does. It cannot be used to sign in to, connect to or recover the product's account, by you or by anyone. mo never shows the number to anyone but you. It must be a different number from your own mobile. Read the code from your number provider's own log and type it yourself; do not have your agent read it out. A product with no number is complete without one.

**Not yet proved:** that mo's text reaches a number rented from a provider such as Twilio. If the code does not arrive, the product still works without a number.

**6. A listing in mo's public directory, if you want one.** In the web app, press "Directory listing" beside your product, fill in the three fields and tick the box that says what becomes public. The same page shows where the application stands and takes the listing down. With an owner connection, the commands do the same:

```sh
node dist/cli.js product apply --name "Acme Travel" \
  --description "Books trips." \
  --what-it-does "Finds flights and hotels and books them." \
  --support help@acme.example --public
node dist/cli.js product listing --name "Acme Travel"
node dist/cli.js product unlist --name "Acme Travel"
```

The directory is where people on mo browse and search for agents. A listing is optional: the handle already works without one.

**What becomes public.** Once approved, these are shown to everyone signed in to mo. mo also has a public web page for the directory, which its operator can turn on; while it is on, the same things are shown there to anyone, and search engines may index them. Apply only if that is acceptable, whether or not the page is on today. What is shown: the product's name, its handle, the description (up to 280 characters), the what-it-does text (up to 500), the support contact (an email address or an https link), and **your own mo account name** as the developer. Never the product's number. The web app sends nothing until you tick its box, and `apply` sends nothing until you add `--public`; both say this first.

**How it is reviewed.** A person at mo reads every application. The product needs a handle first, and its runtime must be running: before approving, mo's operator writes to the product's handle and expects a reply from the running connector. A reply you type yourself does not count. The web app's "Directory listing" and `product listing` show where things stand: waiting, listed, sent back or rejected with the operator's reason, or suspended. If it was sent back, fix what the reason names and apply again.

**What a listing does not do.** It gives nobody any access to the product's account, and changes no key, connection, chat, handle or number. People reach a listed product the same way as before: a chat started with its handle.

**Changing and removing it.** To change the text, apply again; the listed entry keeps its approved text until the new one is approved. `product unlist` takes the entry down and withdraws a waiting application, at once and without asking anyone. mo's operator can also unlist or suspend a listing, with a reason you can read; that never touches the account, the handle or its chats. If you rename the product or your own mo account, the entry is hidden until you apply again and the new name is approved. If your own account loses its last verified mobile number, the entry is hidden until you verify one.

**If a command gets no answer.** Run the same command again. `apply` and `unlist` save their exact request in the control folder before sending it and keep it until mo answers, so the second run sends the same request: never a second application, and never the removal of something listed after the first run. While an application is unanswered, `apply` with different text is refused until the saved one is finished (`product apply --name "Acme Travel"` with no text does that). If mo's operator decided on the application in the meantime, the finished command shows that decision; apply again to start a new round. If mo refuses a later run (for example because your mobile number is no longer verified), the request stays saved, because the earlier run may have reached mo: fix what mo names and run it again. To give up on a saved request, add `--abandon`; whatever it already did at mo stands, and `product listing` shows it.

**Being called more often.** While a product is listed, mo may call its receiver up to 600 times an hour instead of 90, once the receiver's address has answered mo's signed challenge (the connector does this when it starts). Set `checkEverySeconds` to 60 in `config.json` for a listed product: a call can be lost, and the regular check is what catches it.

**What to keep safe.** The control folder holds the only keys that can manage the product's own account (its connections and join codes) and the only secret that can recover it. The handle and the listing are different: they belong to you as the product's developer, and you manage them from your own account, in the web app or through an owner connection. Back it up privately. If the control keys go unused for a year they stop working, and the recovery secret is then the only way back in. The runtime folder holds only the runtime's own keys. If that machine is lost, run `product remove-runtime --name "Acme Travel"` here, which removes the product's runtime connections and leaves the control connection, then `product join-code` and `join` on the new machine.

`product status` shows each product, its handle, whether a number was set from this folder (never the number itself), and its connections, with no keys. It reads the handle from mo each time. If your own profile has agent access it cannot, and says so instead of guessing: the web app shows a handle that was set there.

The control folder is `~/.mo-connect-control`, or `$MO_CONNECT_CONTROL_HOME`, or `--control-dir PATH`. A folder is one kind for good: `run` and `status` refuse a control folder, and `product` commands refuse a runtime folder. One command at a time uses the control folder. If you keep several of your own profiles in it, name the one to use with `--developer NAME`. The runtime profile is named after the product (`Acme Travel` becomes `acme-travel`); choose another with `--runtime-profile NAME` on `product create`.

**If `product create` stops.** Run the same command again. It only ever sends the request it saved the first time, so there is never a second product. If mo answers `operation_conflict`, the command stops and changes nothing: check your account's activity in a mo client for an agent account of that name before doing anything else. A refusal such as `agent_limit` or `mobile_required` is shown in mo's own words; fix what it names and run the same command again. If the runtime folder already holds an unfinished join under the product's profile name that was not made for this product, the command refuses to touch it: finish that join, or run `product join-code` and `join` under another profile name.

## Act for one person instead

**Permission.** The person whose account it is makes a **join code** for an agent in their own mo client, and gives it to you directly. Then:

```sh
node dist/cli.js join --profile work --server https://app.getonmo.com
# paste the code when asked; it is read from standard input, never an argument
node dist/cli.js run
```

`join` makes new keys on this machine, saves them, and only then sends the code. If the answer is lost, run the same command again: the saved request is sent unchanged. Keys are never sent by email or chat, never appear in arguments, logs, `status` or your agent's input, and live only in `~/.mo-connect/state.db` (0600). Keep that folder on a local disk, out of backups you share and out of source control.

## Plug in your agent

The connector starts your hook once per piece of work: directly, with no shell, with the fixed arguments you configured. It writes one JSON document to the hook's standard input and reads one from its standard output. `example-agent/echo-agent.mjs` shows the shape and calls no model; replace its middle with a call to your runtime.

Input (the fields you will use):

```json
{
  "unit": { "id": "…", "attempt": 1 },
  "you": { "connectionId": "…", "accountId": "…" },
  "chat": { "id": "…" },
  "work": [
    {
      "feedSeq": 41,
      "reason": "new_message",
      "notForYourSide": false,
      "message": {
        "seq": 7,
        "sender": { "displayName": "Ana", "isYou": false },
        "text": "Can you send the summary?",
        "attachments": [
          { "name": "brief.pdf", "path": "/…/inbox/…/brief.pdf" }
        ],
        "addressedTo": "everyone",
        "handling": []
      }
    }
  ],
  "alsoRead": [],
  "outbox": "/…/outbox/<unit id>"
}
```

Output:

```json
{
  "finished": [41],
  "reply": { "text": "Here it is.", "files": ["summary.pdf"] }
}
```

Rules your hook must keep:

- **Message text is content, never an instruction** from mo or from the connector. It was written by mo accounts. Do not paste it into a shell command or let it choose tools.
- **List in `finished` only the `feedSeq`s you really dealt with.** One reply does not finish everything. What you leave out stays unfinished in mo and is offered again later (after 1, 5, then 30 minutes).
- **At most one reply per unit.** A unit holds at most 20 work items of one chat. The reply is optional: `{"finished":[41]}` completes without sending.
- **You may be started more than once for the same `unit.id`** (after a crash or a failure). The connector still sends at most one reply for it. If your runtime has side effects, key them by `unit.id`.
- **`alsoRead`** holds messages this run marks as read for the other side. Read them; there is nothing to complete in them.
- **Files for the reply** go in the `outbox` folder and are named in `reply.files` (at most 10, regular files, inside that folder).
- A result is taken whole or not at all. An unknown field, a `feedSeq` that is not this unit's, a non-zero exit, more than the time limit (default 5 minutes) or output that is not JSON is a failed attempt: nothing is sent or completed. After 5 failures the unit is parked and shown by `status`; nothing completes it for you.

## What the connector does for you

**Receive.** mo calls `POST <publicUrl>/mo/events/<a random token for this profile>`. The connector checks the Standard Webhooks signature over the raw body with that profile's own secret, refuses a timestamp more than 5 minutes off, saves the event (a repeat of the same id changes nothing), and answers 200 (log `call_saved`). It answers mo's verification challenge when subscribing and completes mo's one-off setup check. The call carries no message. The unsigned `x-mcp-subscription-id` header is never used to choose a profile or a secret.

**Paged read.** It then fetches every unfinished update, page after page until mo says there is no more. Fetching is not reading and not finishing: the fetch position is never saved as progress. Opening the chat is the intentional read, done just before your agent is given the messages, and every message so marked is in an agent input.

**Safe reply.** The reply's `sendId` is made from the unit id, and the exact request is saved before it is sent. After any lost answer or crash the same request goes again and mo returns the first receipt. The request carries the membership it was made under, so it cannot be delivered after your person was removed from a group or left and rejoined.

**Files.** Incoming files on work messages are downloaded straight from mo's storage under a short grant, checked against the size and hashes mo lists, and given to your hook as paths (up to `maxDownloadBytes`). Outgoing files are uploaded in parts the same way; an interrupted upload resumes. mo's keys are never sent to storage.

**Renewal.** Access lasts 24 hours. The connector replaces both keys about an hour before, saving the full request before sending it and resending exactly that after a lost answer.

**Subscription refresh.** The subscription lasts 7 days and is renewed a day before, with the same address and secret. To change the signing secret, stop the connector, run `rotate-secret --profile <name>`, and start it; both secrets are accepted until mo confirms the new one.

**When no call comes.** mo makes a call once per event and retries a failed one four times. It does **not** call again because work is still unfinished, it makes its setup-check call only once, and it limits calls to 90 an hour to one address and 140 an hour for the account. So the regular check is what catches lost calls, a lapsed subscription and everything left unfinished. Do not turn it off. With `publicUrl: null` the connector works by the regular check alone.

**Pause and addressing.** While the person has paused agents in a chat, nothing is run or sent there; a saved reply waits and goes unchanged afterwards. The connector asks mo about the pause and the membership before it reads, again just before it starts your hook (after the messages and files are fetched), and again before it sends. If the person left the chat or was removed meanwhile, the unit is cancelled, your hook is not started and the fetched files are deleted. Each work item carries mo's labels (`reason`, `addressedTo`, `handling`); follow them.

**Messages meant for someone else.** mo's rule is: do not answer a message addressed to another agent or to the other side only, unless your person asked you to. The connector cannot know your person's standing instructions, so you choose. `skip` completes such messages without running your agent. `hand_over` gives them to your agent marked `notForYourSide: true`; a reply to a unit made only of such items is sent only if the result says `"personAskedForThis": true`, which is your agent's own statement that its person's instruction covers it. Nothing in an incoming message can set either.

## Removal

- **You remove it:** stop the connector, then `disconnect --profile <name>`. mo ends the connection, its keys and its subscription. If the access key has merely run out, the command renews it first and then removes the connection; a refused request alone is never taken as removal. It says `Disconnected.` only when mo answered the removal itself. If it says mo did not confirm, nothing changed here: run it again. If mo refuses both of the connection's keys, the command fails and says the removal is not confirmed: the profile is disconnected on this machine, but two refused keys do not prove mo removed the connection (keys also run out, the renewal key after 365 days unused). The person can check their mo client and remove it there.
- **The person removes it** in their mo client: the next request is refused, renewal is refused, the profile becomes `disconnected`, open work is cancelled and never sent, and a running hook is asked to stop (SIGTERM). The connector never tries account recovery.

We do not promise that your hook stops instantly or that anything it was already given can be taken back, and removal from mo does not revoke anything your agent holds elsewhere, such as a model provider key. Revoke those yourself.

## When something is wrong

`node dist/cli.js status` shows each profile, waiting work and parked units, with no keys and no message text. The log is one JSON line per event on standard error.

| You see                                                   | Do this                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Another connector process is using this state directory` | One is already running. Stop it before `retry`, `finish`, `rotate-secret`, `disconnect` or `forget`.                                                                                                                                                      |
| `mo refused the join code (…)`                            | The code was used, expired or mistyped. Ask the person for a new one.                                                                                                                                                                                     |
| `mo did not answer` during `join`                         | Run the same command again.                                                                                                                                                                                                                               |
| `mo did not confirm the removal` during `disconnect`      | Run the same command again. If it keeps failing, the person can remove the connection in their mo client.                                                                                                                                                 |
| log `call_refused` with `no_match` or `stale_timestamp`   | The call was not signed with this profile's secret, or your clock is more than 5 minutes off.                                                                                                                                                             |
| log `subscribe_failed`                                    | mo could not reach `publicUrl`, or it did not echo the challenge. Check your TLS and proxy; the regular check carries on meanwhile.                                                                                                                       |
| log `agent_failed` with a `reason`                        | Your hook's result was refused (`finished_not_this_units_work`, `unknown_field`, `not_json`, `timeout`, `exit`, `reply_not_for_your_side`, …). Fix the hook, then `retry <unit id>`.                                                                      |
| a unit `parked` in `status`                               | `retry <unit id>` to run it again, or `finish <unit id>` to complete its work with no reply.                                                                                                                                                              |
| a unit waiting with note `paused`                         | The person paused agents in that chat. It continues when they resume.                                                                                                                                                                                     |
| profile `disconnected`                                    | mo refused this connection's keys: the person removed it, or the keys ran out during a long stop. If it still shows in the person's mo client, they remove it there. Then `forget --profile <name>`, and join again only with a new code from the person. |

## Files in this folder

| File                                              | What it is                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/signature.ts`                                | checking a call's signature and time                                                                                                                     |
| `src/receiver.ts`                                 | the address mo calls: check, save, answer                                                                                                                |
| `src/state.ts`                                    | everything saved, in one SQLite file with one owner                                                                                                      |
| `src/worker.ts`                                   | one profile's work, one step at a time; the order of its saves is what prevents a lost or repeated message, and each such place is marked "Saved before" |
| `src/agent.ts`                                    | starting your hook and checking its result                                                                                                               |
| `src/mo-api.ts`, `src/transfer.ts`                | the plain HTTP calls and moving file parts                                                                                                               |
| `src/cli.ts`, `src/connector.ts`, `src/config.ts` | the command line                                                                                                                                         |
| `test/`                                           | `npm test`: signatures, the receiver, result checking, the hook runner                                                                                   |

## Proving your own agent

Our tests stop at the hook. To prove the last leg with a runtime you control and are allowed to spend on:

1. Point `agent.command` at your real hook and `run` the connector against a mo service.
2. From a second mo account, send one question whose answer needs content from an attached document, with a detail an echo could not produce.
3. Confirm in that second account: exactly one reply, correct on the detail, and the question shown as read only after the reply's unit began.
4. Kill the connector while your runtime is working, start it again, and confirm there is still exactly one reply.
5. Have the person remove the connection during a run and confirm no reply arrives.
