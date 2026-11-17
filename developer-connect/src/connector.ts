// The running connector: one receiver, and one worker per active profile.
import { writeFileSync, renameSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createReceiver } from "./receiver.js";
import { State } from "./state.js";
import { Worker, timings, type Log, type Timings } from "./worker.js";

/** One JSON line per event on standard error: ids and codes, never content or keys. */
export const logLine: Log = (event, fields = {}) =>
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
  );

/** What `status` shows. No key and no message text is in it. */
export function statusOf(state: State) {
  return {
    at: new Date().toISOString(),
    pid: process.pid,
    profiles: state.profiles().map((profile) => {
      const subscription = state.subscription(profile.name);
      const units = state.openUnits(profile.name);
      return {
        name: profile.name,
        server: profile.server,
        state: profile.state,
        reason: profile.reason,
        connectionId: profile.connection_id,
        accessExpires: profile.access_expires,
        renewalPending: state.renewalPending(profile.name)?.stage ?? null,
        calls: subscription.subscription_id
          ? { refreshBefore: subscription.refresh_before }
          : null,
        ...state.wake(profile.name),
        unansweredOpens: state.unansweredOpens(profile.name).length,
        units: units.map((unit) => ({
          id: unit.id,
          chatId: unit.chat_id,
          state: unit.state,
          items: unit.work.length,
          attempts: unit.attempts,
          note: unit.note,
          waitingUntil: unit.not_before
            ? new Date(unit.not_before).toISOString()
            : null,
        })),
      };
    }),
  };
}

export async function startConnector(directory: string, log: Log = logLine) {
  const config = loadConfig(directory);
  // Throws StateInUse if another process owns this directory.
  const state = new State(directory);
  const times = { ...timings(config), ...config.timings } as Timings;
  const writeStatus = () => {
    try {
      const path = join(directory, "status.json");
      writeFileSync(`${path}.tmp`, JSON.stringify(statusOf(state), null, 2), {
        mode: 0o600,
      });
      renameSync(`${path}.tmp`, path);
    } catch {
      // Status is a convenience; the work does not depend on it.
    }
  };
  const workers = new Map<string, Worker>();
  const running: Promise<void>[] = [];
  for (const profile of state.profiles())
    if (profile.state === "active") {
      const worker = new Worker(
        state,
        config,
        profile.name,
        log,
        times,
        writeStatus,
      );
      workers.set(profile.name, worker);
      running.push(
        worker
          .run()
          .catch(() => log("worker_stopped", { profile: profile.name })),
      );
    }
  const receiver = createReceiver(
    state,
    (profile) => workers.get(profile)?.wake(),
    log,
  );
  await new Promise<void>((done, failed) => {
    receiver.once("error", failed);
    receiver.listen(config.listen.port, config.listen.host, done);
  });
  const port = (receiver.address() as AddressInfo).port;
  writeStatus();
  log("started", { port, profiles: workers.size });
  return {
    port,
    /** Resolves when every worker has stopped (all profiles disconnected). */
    idle: Promise.all(running),
    async close() {
      for (const worker of workers.values()) worker.stop();
      receiver.closeAllConnections();
      await new Promise<void>((done) => receiver.close(() => done()));
      await Promise.all(running);
      state.close();
    },
  };
}
