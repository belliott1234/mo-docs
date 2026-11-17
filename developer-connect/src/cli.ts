#!/usr/bin/env node
// The command line. Keys and join codes are never taken from arguments:
// arguments are visible to other programs on the machine.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CONFIG_TEMPLATE, loadConfig } from "./config.js";
import { logLine, startConnector, statusOf } from "./connector.js";
import { joinProfile, Stop, whsec } from "./join.js";
import { openFolder, productCommand } from "./product.js";
import { State, StateInUse, WrongFolder } from "./state.js";
import { Worker, timings } from "./worker.js";

const USAGE = `mo developer connect: a reference connector

  init                               make the private folder and config.json
  join --profile NAME --server URL   join an account with a join code (read
       [--label TEXT]                from standard input, never an argument)
  run                                receive calls and run your agent
  status                             profiles, waiting work, parked units
  retry UNIT                         give a parked unit fresh attempts
  finish UNIT                        complete a parked unit's work, no reply
  rotate-secret --profile NAME       change the signing secret at next start
  disconnect --profile NAME          remove this connection from mo
  forget --profile NAME              delete a disconnected profile's rows

 A product with its own name (see README, "Run a product with its own name"):
  join --control --profile NAME --server URL    join your own account, in
                                                the control folder
  product create --name "NAME" [--no-join]      make the product; run again
                                                after any stop, never twice
  product join-code --name "NAME"               a join code for its runtime
  product handle --name "NAME" HANDLE           set its handle, once
  product number add|verify|remove --name "NAME"   a number to find it by
  product apply --name "NAME" --description "..." --what-it-does "..."
                --support EMAIL-OR-HTTPS-LINK --public
                                                apply to mo's public directory
  product listing --name "NAME"                 its listing and application
  product unlist --name "NAME"                  take it out of the directory
  product remove-runtime --name "NAME"          remove its runtime connections
  product status                                products, with no keys

  --dir PATH   the private folder (default: $MO_CONNECT_HOME or ~/.mo-connect)
  --control-dir PATH   the control folder, for your own profile and product
               control keys (default: $MO_CONNECT_CONTROL_HOME or
               ~/.mo-connect-control). \`run\` never opens it.
  Stop \`run\` before retry, finish, rotate-secret, disconnect or forget.`;

/** Flags that take no value. */
const SWITCHES = new Set(["--control", "--no-join", "--public", "--abandon"]);
function options(argv: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    if (SWITCHES.has(word)) flags[word.slice(2)] = "yes";
    else if (word.startsWith("--")) flags[word.slice(2)] = argv[++at] ?? "";
    else rest.push(word);
  }
  return { flags, rest };
}
const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const need = (flags: Record<string, string>, name: string) =>
  flags[name] || stop(`--${name} is required.`);

/** One line from standard input; not echoed when typed at a terminal. */
async function secretLine(prompt: string) {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const reader = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  process.stderr.write(prompt);
  (reader as unknown as { _writeToOutput: () => void })._writeToOutput =
    () => {};
  return new Promise<string>((done) =>
    reader.question("", (line) => {
      reader.close();
      process.stderr.write("\n");
      done(line.trim());
    }),
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { flags, rest } = options(argv);
  const directory = resolve(
    flags.dir || process.env.MO_CONNECT_HOME || join(homedir(), ".mo-connect"),
  );
  const controlDirectory = resolve(
    flags["control-dir"] ||
      process.env.MO_CONNECT_CONTROL_HOME ||
      join(homedir(), ".mo-connect-control"),
  );
  process.umask(0o077);
  const openState = () => {
    try {
      return new State(directory);
    } catch (error) {
      if (error instanceof StateInUse)
        return stop(`${error.message} Stop it first.`);
      if (error instanceof WrongFolder) return stop(error.message);
      throw error;
    }
  };

  switch (command) {
    case "init": {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, "config.json");
      if (!existsSync(path))
        writeFileSync(path, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, {
          mode: 0o600,
        });
      console.log(`Private folder: ${directory}\nEdit ${path}, then join.`);
      return;
    }
    case "join": {
      // `--control` joins your own account in the control folder; without
      // it, the runtime folder. A folder is one kind for good.
      const control = "control" in flags;
      const state = openFolder(
        control ? controlDirectory : directory,
        control ? "control" : "runtime",
      );
      try {
        const joined = await joinProfile(state, {
          name: need(flags, "profile"),
          server: () => need(flags, "server"),
          label: flags.label || (control ? "Developer" : "Developer connector"),
          joinCode: () => secretLine("Join code: "),
        });
        console.log(
          `Joined as ${joined.role}. Profile: ${flags.profile}${control ? " (control folder)" : ""}`,
        );
      } finally {
        state.close();
      }
      return;
    }
    case "product":
      return productCommand(
        rest,
        flags,
        { runtime: directory, control: controlDirectory },
        { line: secretLine, print: (text) => console.log(text) },
      );
    case "run": {
      let connector;
      try {
        connector = await startConnector(directory);
      } catch (error) {
        return stop(
          error instanceof Error ? error.message : "Could not start.",
        );
      }
      const end = () => void connector.close().then(() => process.exit(0));
      process.once("SIGINT", end);
      process.once("SIGTERM", end);
      return;
    }
    case "status": {
      let status;
      try {
        const state = new State(directory);
        status = statusOf(state);
        state.close();
      } catch (error) {
        if (error instanceof WrongFolder) return stop(error.message);
        if (!(error instanceof StateInUse)) throw error;
        // The connector is running: read what it last wrote.
        status = JSON.parse(
          readFileSync(join(directory, "status.json"), "utf8"),
        );
      }
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    case "retry":
    case "finish": {
      const state = openState();
      const id = rest[0] ?? stop("Give the unit id from status.");
      const done =
        command === "retry" ? state.unitRetry(id) : state.unitFinishByHand(id);
      state.close();
      if (!done) stop("No parked unit has that id.");
      console.log(
        command === "retry"
          ? "It will be tried again."
          : "Its work will be completed at next start.",
      );
      return;
    }
    case "rotate-secret": {
      const state = openState();
      const name = need(flags, "profile");
      if (!state.profile(name)) stop("No such profile.");
      // The candidate is saved beside the current secret. Both are accepted
      // until mo answers 200 to a subscribe that carries the candidate.
      state.setCandidateSecret(name, whsec());
      state.close();
      console.log("The new secret takes over at next start.");
      return;
    }
    case "disconnect": {
      const state = openState();
      const name = need(flags, "profile");
      const profile = state.profile(name);
      if (!profile || profile.state !== "active")
        stop("No active profile has that name.");
      let config = CONFIG_TEMPLATE;
      try {
        config = loadConfig(directory);
      } catch {
        // Removal needs none of the settings.
      }
      const worker = new Worker(state, config, name, logLine, timings(config));
      let outcome;
      try {
        // An access key that has only run out is renewed first (the same
        // saved renewal the connector uses), then the removal is sent with
        // the live key. Removing the connection ends its keys, renewal and
        // subscriptions. A refused request alone is never taken as removal.
        outcome = await worker.remove();
      } catch {
        state.close();
        stop(
          "mo did not confirm the removal. The profile is unchanged here; run disconnect again, or remove this connection from your mo account.",
        );
      }
      state.close();
      if (outcome === "unconfirmed")
        stop(
          "mo refused both of this connection's keys, so the removal is not confirmed: the connection was removed already, or its keys ran out. This profile is disconnected here and will not be used again. If the connection still shows in the person's mo client, they can remove it there.",
        );
      console.log(
        "Disconnected. Access your agent holds at its own provider is not touched by this.",
      );
      return;
    }
    case "forget": {
      const state = openState();
      const name = need(flags, "profile");
      if (state.profile(name)?.state !== "disconnected")
        stop("Only a disconnected profile can be forgotten.");
      state.removeProfile(name);
      state.close();
      console.log("Forgotten.");
      return;
    }
    default:
      console.log(USAGE);
  }
}
try {
  await main();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  stop(error.message);
}
