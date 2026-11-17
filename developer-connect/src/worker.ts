// One profile's worker: everything that uses that connection's keys happens
// here, one step at a time. Renewal, the subscription, fetching work, opening
// chats, running your agent, sending its one reply and completing work never
// overlap for one profile. The HTTP receiver only saves "I was called".
//
// The order of the saves below is the point of this file. Each comment that
// starts "Saved before" marks a place where the order prevents a lost or
// repeated message; keep it if you change the code around it.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  runAgent,
  validateResult,
  type AgentInput,
  type AgentMessage,
} from "./agent.js";
import type { Config } from "./config.js";
import {
  MoApi,
  MoApiError,
  MoUnreachable,
  accessToken,
  newKey,
  type ChatMessage,
  type Update,
} from "./mo-api.js";
import type { State, Unit, WorkItem } from "./state.js";
import { downloadPart, fileSha256, partRange, uploadPart } from "./transfer.js";

/** mo ended this connection. The worker stops; nothing is retried. */
export class Disconnected extends Error {}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** Waiting times. The packet's own tests shorten them; leave them alone. */
export type Timings = {
  checkMs: number;
  subscribeRetryMs: number;
  /** After the 1st, 2nd, ... failed agent run. One more failure parks the unit. */
  agentRetryMs: number[];
  /** Before work the agent left unfinished is offered to it again. */
  deferMs: number[];
  pausedMs: number;
  errorMs: number;
  livenessMs: number;
  /** How long before `refreshBefore` the subscription is renewed. */
  refreshLeadMs: number;
  /** Left out, mo's own 7 days. */
  subscriptionTtlMs?: number;
};
export const timings = (config: Config): Timings => ({
  checkMs: config.checkEverySeconds * 1000,
  subscribeRetryMs: 10 * 60_000,
  agentRetryMs: [10_000, 60_000, 300_000, 900_000],
  deferMs: [60_000, 300_000, 1_800_000],
  pausedMs: 60_000,
  errorMs: 30_000,
  livenessMs: 30_000,
  refreshLeadMs: 24 * 3_600_000,
});

const UNIT_ITEMS = 20;
const HANDOVER = 200;
const OPEN_PAGES = 4;
const MEDIA: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export class Worker {
  private readonly api: MoApi;
  private wakeUp: (() => void) | null = null;
  private stopped = false;
  private stopAgent: (() => void) | null = null;
  private lapsed = false;
  /** When a subscribe that is due may next be tried. */
  private subscribeAt: number | null = null;
  /**
   * Chats whose `chat_read` row was made by this process and for which this
   * process has sent no open yet. Only such a chat's first answer may
   * tighten the boundary; after a restart this set is empty.
   */
  private readonly firstOpen = new Set<string>();

  constructor(
    private readonly state: State,
    private readonly config: Config,
    private readonly name: string,
    private readonly log: Log,
    private readonly times: Timings,
    private readonly onPass: () => void = () => {},
  ) {
    this.api = new MoApi(this.row().server);
  }

  /** Called by the receiver after it has saved an event. */
  wake() {
    this.wakeUp?.();
  }
  stop() {
    this.stopped = true;
    this.stopAgent?.();
    this.wakeUp?.();
  }

  async run() {
    let failures = 0;
    while (!this.stopped) {
      // The idle boundary: promise first, then the counter, then the work.
      // A call landing at any point either raises the counter before it is
      // read here, or leaves it above `generation` when the pass ends.
      const woken = new Promise<void>((done) => (this.wakeUp = done));
      const generation = this.state.wake(this.name).wake_generation;
      let delay = this.times.checkMs;
      try {
        const next = await this.pass();
        this.state.drained(this.name, generation);
        failures = 0;
        if (next !== null)
          delay = Math.min(delay, Math.max(next - Date.now(), 50));
        if (this.state.wake(this.name).wake_generation > generation) delay = 0;
      } catch (error) {
        if (error instanceof Disconnected || this.stopped) break;
        failures++;
        delay = Math.min(this.times.errorMs * failures, this.times.checkMs);
        this.log("pass_failed", { profile: this.name, ...describe(error) });
      }
      this.onPass();
      if (delay > 0 && !this.stopped) await Promise.race([woken, sleep(delay)]);
    }
    // Stopped or disconnected: nothing cancelled keeps its files.
    await this.sweep().catch(() => {});
    this.onPass();
  }

  /**
   * The operator's `disconnect`. An access key that has only run out is
   * renewed first, so a refused request is never mistaken for a removal.
   * "removed" is returned only when mo answered the removal itself. If mo
   * refuses the renewal key as well, the profile is disconnected here but
   * the result is "unconfirmed": two refusals do not show that mo removed
   * the connection (keys also simply run out). Anything else is thrown and
   * nothing changes here.
   */
  async remove(): Promise<"removed" | "unconfirmed"> {
    try {
      await this.call((token) =>
        this.api.removeConnection(token, this.row().access_id),
      );
    } catch (error) {
      if (!(error instanceof Disconnected)) throw error;
      await this.sweep();
      return "unconfirmed";
    }
    this.state.disconnect(this.name, "removed_here");
    await this.sweep();
    return "removed";
  }

  // Keys.

  private row() {
    const profile = this.state.profile(this.name);
    if (!profile || profile.state !== "active") throw new Disconnected();
    return profile;
  }
  private token() {
    const profile = this.row();
    return accessToken({
      id: profile.access_id,
      secret: profile.access_secret,
    });
  }
  /**
   * One call for a command (the `product` commands), with the same saved
   * renewal the connector uses. Throws Disconnected if mo refuses both keys.
   */
  withAccess<T>(request: (token: string) => Promise<T>): Promise<T> {
    return this.call(request);
  }
  /** One call with the current access key; a refused key is renewed once. */
  private async call<T>(request: (token: string) => Promise<T>): Promise<T> {
    try {
      return await request(this.token());
    } catch (error) {
      if (!(error instanceof MoApiError) || error.status !== 401) throw error;
      await this.ensureAccess(true);
      return request(this.token());
    }
  }

  /**
   * Renewal, in two saved stages.
   *   saved:    the whole request is on disk before it is sent, and is sent
   *             again unchanged after a lost answer or a restart.
   *   accepted: mo said 200; the new pair is the profile's pair. One request
   *             with the new access key confirms it, then the row goes.
   * `force` renews even when the key has time left (a refused key, or the
   * fence for an open with no answer).
   */
  private async ensureAccess(force: boolean) {
    for (let step = 0; step < 6; step++) {
      const profile = this.row();
      const pending = this.state.renewalPending(this.name);
      if (pending?.stage === "saved") {
        if (pending.old_renewal.id !== profile.renewal_id) {
          // Out of date: it must never overwrite newer keys.
          this.state.dropRenewal(this.name);
          continue;
        }
        let session;
        try {
          session = await this.api.renew(pending.old_renewal, pending.request);
        } catch (error) {
          if (error instanceof MoApiError && error.status === 401) {
            // The refused request is kept. No account recovery is started.
            this.state.disconnect(this.name, "renewal_refused");
            this.log("disconnected", { profile: this.name });
            throw new Disconnected();
          }
          throw error;
        }
        this.state.renewalAccepted(pending, session.credential.expiresAt);
        this.log("renewed", { profile: this.name });
        force = false;
        continue;
      }
      if (pending?.stage === "accepted") {
        if (pending.request.credential.id !== profile.access_id) {
          this.state.dropRenewal(this.name);
          continue;
        }
        try {
          await this.api.account(accessToken(pending.request.credential));
          this.state.dropRenewal(this.name);
        } catch (error) {
          if (!(error instanceof MoApiError) || error.status !== 401)
            throw error;
          // The accepted access key is already past its time (a late exact
          // retry returns the first result). Renew again with the accepted
          // pair's renewal key; this saved request replaces the row.
          this.saveRenewal();
        }
        continue;
      }
      const expires = Date.parse(profile.access_expires ?? "");
      if (!force && expires - Date.now() > 3_600_000) return;
      this.saveRenewal();
      force = false;
    }
    throw new Error("Renewal did not settle.");
  }
  private saveRenewal() {
    const profile = this.row();
    this.state.saveRenewal(profile, {
      credential: { ...newKey(), label: profile.label },
      renewalKey: newKey(),
      operationId: randomUUID(),
    });
  }

  // Being called.

  private async ensureSubscription() {
    if (!this.config.publicUrl) return;
    const now = Date.now();
    const sub = this.state.subscription(this.name);
    const url = `${this.config.publicUrl}/mo/events/${sub.route_token}`;
    const due =
      !sub.subscription_id ||
      sub.callback_url !== url ||
      !!sub.candidate_secret ||
      this.lapsed ||
      Date.parse(sub.refresh_before ?? "") - now < this.times.refreshLeadMs;
    this.subscribeAt = null;
    if (!due) return;
    // Not more often than the waiting time (mo allows 10 an hour). The pass
    // comes back for it then, without waiting for the regular check.
    this.subscribeAt = sub.last_attempt + this.times.subscribeRetryMs;
    if (now < this.subscribeAt) return;
    this.subscribeAt = now + this.times.subscribeRetryMs;
    this.state.subscribeAttempt(this.name, now);
    // The secret was saved before this call: mo's challenge arrives at the
    // receiver before the call returns. During a secret change both secrets
    // are accepted until a 200 makes the candidate the only one.
    const secret = sub.candidate_secret ?? sub.secret;
    try {
      if (sub.subscription_id && sub.callback_url && sub.callback_url !== url)
        await this.call((token) =>
          this.api.unsubscribe(token, sub.subscription_id!),
        ).catch(() => {});
      const answer = await this.call((token) =>
        this.api.subscribe(token, {
          url,
          secret,
          cursor: sub.cursor,
          ...(this.times.subscriptionTtlMs
            ? { ttlMs: this.times.subscriptionTtlMs }
            : {}),
        }),
      );
      this.state.subscribed(this.name, {
        id: answer.id,
        url,
        refreshBefore: answer.refreshBefore,
        secret,
      });
      this.lapsed = false;
      this.subscribeAt = null;
      this.log("subscribed", { profile: this.name });
    } catch (error) {
      if (error instanceof Disconnected) throw error;
      // Not fatal: the regular check keeps the work moving meanwhile.
      this.log("subscribe_failed", { profile: this.name, ...describe(error) });
    }
  }

  // A pass.

  /** Returns the time of the next thing that is waiting, or null. */
  private async pass(): Promise<number | null> {
    await this.ensureAccess(false);
    await this.ensureSubscription();
    await this.settleUnansweredOpens();
    for (const unit of this.state.openUnits(this.name))
      await this.advance(unit);
    await this.sweep();
    let again = false;
    for (let round = 0; round < 25; round++) {
      again = await this.drain();
      if (!again) break;
    }
    await this.ensureSubscription();
    // Before going idle, an open with no answer is dealt with first.
    await this.settleUnansweredOpens();
    this.state.pruneEvents(Date.now() - 8 * 24 * 3_600_000);
    if (again) return Date.now();
    const now = Date.now();
    const waiting = [
      ...this.state
        .openUnits(this.name)
        .filter((unit) => unit.state !== "parked")
        .map((unit) => unit.not_before),
      ...this.state.deferred(this.name, now).values(),
      ...(this.subscribeAt === null
        ? []
        : [Math.max(this.subscribeAt, now + 1)]),
    ].filter((time) => time > now);
    return waiting.length ? Math.min(...waiting) : null;
  }

  /**
   * One full fetch of the unfinished work, sorted. Returns true if a unit was
   * made, in which case the caller fetches again: a unit never grows, so
   * further items wait for the next one.
   */
  private async drain(): Promise<boolean> {
    const me = this.row().connection_id;
    const updates: Update[] = [];
    let page = await this.call((token) =>
      this.api.updates(token, {
        checkEverySeconds: this.config.checkEverySeconds,
      }),
    );
    for (;;) {
      updates.push(...page.updates);
      const code = page.nextStep?.code;
      if (code === "events_lapsed" || code === "events_stopped")
        this.lapsed = true;
      if (!page.more) break;
      const { nextAfterSeq: afterSeq, throughSeq } = page;
      // The position is never saved: fetching is not progress.
      page = await this.call((token) =>
        this.api.updates(token, { afterSeq, throughSeq }),
      );
    }
    const complete: number[] = [];
    const work = new Map<string, { update: Update; item: WorkItem }[]>();
    for (const update of updates) {
      const { message, reason } = update;
      if (reason === "wake_check") complete.push(update.feedSeq);
      else if (reason === "discard_cached_chat") {
        // Removed from the chat: its open work must not be answered.
        if (update.chatId) await this.removedFrom(update.chatId);
        complete.push(update.feedSeq);
      } else if (!message) {
        if (reason === "change" || reason === "identifier_removed")
          complete.push(update.feedSeq);
        else this.log("update_left", { profile: this.name, reason });
      } else if (update.paused || !update.chatId) continue;
      else if (message.sentByConnectionId === me) complete.push(update.feedSeq);
      else {
        const notForYourSide =
          message.addressedTo === "another_agent" ||
          message.addressedTo === "others" ||
          reason === "own_message";
        if (
          !notForYourSide &&
          !["new_message", "mentioned", "own_agent_message"].includes(reason)
        ) {
          this.log("update_left", { profile: this.name, reason });
          continue;
        }
        if (notForYourSide && this.config.notForYourSide === "skip") {
          // The operator's setting says the agent has no instruction to act
          // on these. Incoming text never changes that setting.
          complete.push(update.feedSeq);
          continue;
        }
        const list = work.get(update.chatId) ?? [];
        list.push({
          update,
          item: {
            feedSeq: update.feedSeq,
            messageSeq: message.seq,
            reason,
            previouslyDelivered: update.previouslyDelivered,
            notForYourSide,
          },
        });
        work.set(update.chatId, list);
      }
    }
    for (let at = 0; at < complete.length; at += 50)
      await this.call((token) =>
        this.api.completeUpdates(token, complete.slice(at, at + 50)),
      );
    this.state.forgetDeferred(
      this.name,
      updates.map((update) => update.feedSeq),
    );

    const deferred = this.state.deferred(this.name, Date.now());
    const busy = () =>
      new Set(this.state.openUnits(this.name).map((unit) => unit.chat_id));
    let made = false;
    const freeze = async (chat: string, items: WorkItem[] | null) => {
      // Authority first: the profile is active, the key is live, and the
      // membership is the current one with no pause.
      let controls;
      try {
        controls = await this.call((token) => this.api.controls(token, chat));
      } catch (error) {
        if (gone(error)) return this.state.forgetChat(this.name, chat);
        throw error;
      }
      if (controls.paused) return;
      const mine =
        items ??
        work
          .get(chat)!
          .filter(
            ({ update }) =>
              update.membershipId === controls.membershipId &&
              !deferred.has(update.feedSeq),
          )
          .map(({ item }) => item)
          .sort((a, b) => a.feedSeq - b.feedSeq)
          .slice(0, UNIT_ITEMS);
      if (items === null && !mine.length) return;
      const id = randomUUID();
      // Saved before anything else happens to this work: the unit, its
      // items and its sendId (dc_<unit id>) never change afterwards.
      this.state.freezeUnit({
        id,
        profile: this.name,
        chat,
        membership: controls.membershipId,
        work: mine,
        at: Date.now(),
      });
      made = true;
      // `controls` above is this unit's authority check for its first step.
      await this.advance(this.state.unit(id)!, true);
    };
    for (const chat of work.keys())
      if (!busy().has(chat)) await freeze(chat, null);
    // Messages marked read and not yet handed over, in a chat with no work:
    // a unit with no work items hands them over. It can finish nothing.
    for (const chat of this.state.owedChats(this.name))
      if (!busy().has(chat) && !work.has(chat)) await freeze(chat, []);
    return made;
  }

  /**
   * A removal notice for a chat. The notice may be older than a rejoin, so
   * mo is asked what holds now.
   *   Not a member: all open work is cancelled and the read record goes
   *   (a row with an unanswered open is kept for its duty).
   *   A member again, under a new membership: only work frozen under an
   *   earlier membership is cancelled. The read record stays, because the
   *   open that settles an unanswered one may already have marked the new
   *   membership's messages read, and those are still owed to the agent.
   *   What is handed over is fetched from mo with the current key, so
   *   history the new membership may not see is not included.
   */
  private async removedFrom(chat: string) {
    let current: string | null = null;
    try {
      current = (await this.call((token) => this.api.controls(token, chat)))
        .membershipId;
    } catch (error) {
      if (!gone(error)) throw error;
    }
    this.state.cancelChat(this.name, chat, "removed", current);
    if (current === null) this.state.forgetChat(this.name, chat);
    await this.sweep();
  }

  // Opening a chat: the intentional read.

  /**
   * One open. Saved before it is sent: which access key it carries. The
   * answer and the clearing of that marker are saved together, and the
   * marker is cleared only if it still names this call's key.
   *
   * `observing` is the open that follows the fence (see settleUnanswered).
   */
  private async open(chat: string, observing: boolean) {
    const key = this.row().access_id;
    const first = this.firstOpen.delete(chat);
    this.state.openSent(this.name, chat, key);
    let answer;
    try {
      answer = await this.api.openChat(this.token(), chat, 50);
    } catch (error) {
      // A plain refusal marked nothing, so this call itself is settled. An
      // observer's refusal settles nothing about the earlier call, so its
      // marker stays, unless the chat itself is gone.
      if (
        error instanceof MoApiError &&
        error.status < 500 &&
        (!observing || gone(error))
      )
        this.state.openAnswered(this.name, chat, key, null);
      throw error;
    }
    // Only the certain first answer may tighten the boundary: the very first
    // open this connector ever sent for the chat, answered in the same run.
    const tighten =
      first && !observing
        ? (answer.messages[0]?.seq ?? answer.readSeq + 1) - 1
        : undefined;
    this.state.openAnswered(this.name, chat, key, answer.readSeq, tighten);
    return answer;
  }

  /**
   * An open that got no answer may have done nothing, may have marked
   * messages already, or may still do so later. A plain retry settles
   * nothing. So:
   *   1. Fence: renew. Once mo accepts the renewal the old key (K1) is
   *      ended, and mo's account lock means the unanswered open has either
   *      committed already or will be refused.
   *   2. Observe: open with the new key (K2), recorded first like any open.
   *      Its answer includes everything the K1 call did.
   *   3. The observing answer, saved, ends the duty. If it does not arrive,
   *      the marker names K2 and this runs again with K2 as the key to fence.
   */
  private async settleUnanswered(chat: string) {
    for (let round = 0; round < 3; round++) {
      const unanswered = this.state.chatRead(this.name, chat)?.open_unanswered;
      if (!unanswered) return;
      // Keys change only by an accepted renewal, so a current key that is
      // not K1 is already its successor.
      if (
        this.row().access_id === unanswered ||
        this.state.renewalPending(this.name)
      )
        await this.ensureAccess(true);
      try {
        await this.open(chat, true);
      } catch (error) {
        if (error instanceof MoUnreachable) continue;
        if (gone(error)) return;
        throw error;
      }
    }
    throw new MoUnreachable("An open is still unanswered.");
  }
  private async settleUnansweredOpens() {
    for (const { chat_id } of this.state.unansweredOpens(this.name))
      await this.settleUnanswered(chat_id);
  }

  /**
   * History above `after`, through `through`, not sent by this connection,
   * oldest first, at most `limit`. `exhausted` says nothing was left out.
   */
  private async handed(
    chat: string,
    after: number,
    through: number,
    limit: number,
  ) {
    const messages: ChatMessage[] = [];
    let afterSeq = after;
    for (;;) {
      if (afterSeq >= through) return { messages, exhausted: true };
      const from = afterSeq;
      const page = await this.call((token) =>
        this.api.history(token, chat, { afterSeq: from }),
      );
      for (const message of page.messages) {
        if (message.seq > through) return { messages, exhausted: true };
        if (message.sentByThisConnection) continue;
        if (messages.length >= limit) return { messages, exhausted: false };
        messages.push(message);
      }
      if (!page.more || page.nextAfterSeq <= afterSeq)
        return { messages, exhausted: true };
      afterSeq = page.nextAfterSeq;
    }
  }

  /** `frozen` to `ready`: open, then save which messages the input holds. */
  private async openFor(unit: Unit) {
    const chat = unit.chat_id;
    // Saved before the first open of a chat: a boundary at the start of the
    // history, below anything an open can mark.
    if (this.state.startChatRead(this.name, chat)) this.firstOpen.add(chat);
    await this.settleUnanswered(chat);
    if (unit.work.length) {
      const newest = Math.max(...unit.work.map((item) => item.messageSeq));
      const before = this.state.chatRead(this.name, chat)!;
      const owed =
        before.opened_through > before.handed_through
          ? (
              await this.handed(
                chat,
                before.handed_through,
                before.opened_through,
                HANDOVER + 1,
              )
            ).messages.length
          : 0;
      // With more than 200 already owed, hand those over before reading on.
      for (let page = 0; owed <= HANDOVER && page < OPEN_PAGES; page++) {
        let answer;
        try {
          answer = await this.open(chat, false);
        } catch (error) {
          if (error instanceof MoApiError && error.status === 401) {
            await this.ensureAccess(true);
            continue;
          }
          if (!(error instanceof MoUnreachable)) throw error;
          await this.settleUnanswered(chat);
          break;
        }
        if (!answer.more || answer.readSeq >= newest) break;
      }
    }
    const read = this.state.chatRead(this.name, chat)!;
    const { messages, exhausted } = await this.handed(
      chat,
      read.handed_through,
      read.opened_through,
      HANDOVER,
    );
    const to = exhausted
      ? read.opened_through
      : (messages.at(-1)?.seq ?? read.opened_through);
    // Saved together: the input's range and the new `handed_through`. That
    // position moves in no other way (bar the certain first answer above).
    this.state.unitReady(
      unit,
      read.handed_through,
      Math.max(to, read.handed_through),
    );
  }

  // Running the agent.

  private toAgent(
    message: ChatMessage,
    paths: Map<string, string>,
  ): AgentMessage {
    return {
      id: message.id,
      seq: message.seq,
      sentAt: message.createdAt,
      sender: {
        accountId: message.sender.accountId,
        isYou: message.sender.isYou,
        displayName: message.sender.displayName.text,
      },
      sentByConnectionId: message.sentByConnectionId ?? null,
      text: message.content.text,
      attachments: message.attachments.map((file) => ({
        id: file.id,
        name: file.name.text,
        mediaType: file.mediaType,
        size: file.size,
        ...(paths.has(file.id) ? { path: paths.get(file.id)! } : {}),
      })),
      ...(message.addressedTo ? { addressedTo: message.addressedTo } : {}),
      handling: message.handling ?? [],
    };
  }

  /**
   * May this unit go on? Asked of mo with the current key: the connection
   * still exists, the membership is the one the unit was frozen under, and
   * agents are not paused. If not, the unit is cancelled or made to wait
   * here, and the caller stops.
   */
  private async allowed(unit: Unit): Promise<boolean> {
    const controls = await this.call((token) =>
      this.api.controls(token, unit.chat_id),
    );
    if (controls.membershipId !== unit.membership_id) {
      await this.cancel(unit.id, "membership_changed");
      return false;
    }
    if (controls.paused) {
      // Whatever is saved waits and goes on unchanged after the pause.
      this.state.unitWait(unit.id, Date.now() + this.times.pausedMs, "paused");
      return false;
    }
    return true;
  }
  /** Cancelled work is never run or sent, and its files do not stay. */
  private async cancel(unit: string, note: string) {
    this.state.unitCancelled(unit, note);
    await this.dropFiles(unit);
  }
  private async dropFiles(unit: string) {
    for (const folder of ["inbox", "outbox"])
      await rm(join(this.state.directory, folder, unit), {
        recursive: true,
        force: true,
      });
  }
  /** Remove the files of this profile's units that are no longer open. */
  private async sweep() {
    const open = new Set(
      this.state.openUnits(this.name).map((unit) => unit.id),
    );
    for (const folder of ["inbox", "outbox"]) {
      const names = await readdir(join(this.state.directory, folder)).catch(
        () => [] as string[],
      );
      for (const name of names)
        if (!open.has(name) && this.state.unit(name)?.profile === this.name)
          await this.dropFiles(name);
    }
  }

  /**
   * Fetch one incoming file into the unit's inbox and check it whole.
   * Returns the path, undefined when there is no file to give (too large,
   * gone, or storage would not serve it although the unit is still
   * allowed), or null when the unit may not go on.
   */
  private async download(
    unit: Unit,
    file: ChatMessage["attachments"][number],
  ): Promise<string | undefined | null> {
    if (file.size > this.config.maxDownloadBytes) return undefined;
    const folder = join(this.state.directory, "inbox", unit.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const safe = file.name.text.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const path = join(folder, `${file.id}-${safe || "file"}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const download = await this.call((token) =>
        this.api.openDownload(token, unit.chat_id, file.id),
      );
      if (!download.transfer) return undefined;
      const handle = await open(path, "w+", 0o600);
      let state = "stored";
      try {
        for (const part of download.parts) {
          state = (
            await downloadPart(download.transfer, part, download, handle)
          ).state;
          if (state !== "stored") break;
        }
      } finally {
        await handle.close();
      }
      if (state === "stored" && (await fileSha256(path)) === download.sha256)
        return path;
      await rm(path, { force: true });
      // Storage refusing is how a removal shows here. It is never treated
      // as a missing file until mo has said the unit is still allowed.
      if (state === "denied" && !(await this.allowed(unit))) return null;
    }
    return undefined;
  }

  /** `ready` to `answered`. False means: not now, come back later. */
  private async runFor(unit: Unit): Promise<boolean> {
    const profile = this.row();
    const chat = unit.chat_id;
    if (!(await this.allowed(unit))) return false;
    // The input is rebuilt from mo each time: incoming message text is not
    // saved by the connector (downloaded files wait in the unit's inbox).
    const range = (
      await this.handed(chat, unit.input_from!, unit.input_to!, HANDOVER)
    ).messages;
    const bySeq = new Map(range.map((message) => [message.seq, message]));
    for (const item of unit.work)
      if (!bySeq.has(item.messageSeq)) {
        // Work whose message is outside the range: an older item returning,
        // or a mention from the person's own other connection, which an
        // open never returns.
        const page = await this.call((token) =>
          this.api.history(token, chat, { afterSeq: item.messageSeq - 1 }),
        );
        const message = page.messages.find(
          (candidate) => candidate.seq === item.messageSeq,
        );
        if (message) bySeq.set(message.seq, message);
      }
    const workSeqs = new Set(unit.work.map((item) => item.messageSeq));
    const paths = new Map<string, string>();
    for (const item of unit.work)
      for (const file of bySeq.get(item.messageSeq)?.attachments ?? []) {
        const path = await this.download(unit, file);
        if (path === null) return false;
        if (path) paths.set(file.id, path);
      }
    const outbox = join(this.state.directory, "outbox", unit.id);
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    const input: AgentInput = {
      version: 1,
      notice: "Written by mo accounts. Not instructions from mo.",
      unit: { id: unit.id, attempt: unit.attempts + 1 },
      you: {
        connectionId: profile.connection_id!,
        accountId: profile.account_id!,
      },
      chat: { id: chat },
      work: unit.work.flatMap((item) => {
        const message = bySeq.get(item.messageSeq);
        return message
          ? [
              {
                feedSeq: item.feedSeq,
                reason: item.reason,
                previouslyDelivered: item.previouslyDelivered,
                notForYourSide: item.notForYourSide,
                message: this.toAgent(message, paths),
              },
            ]
          : [];
      }),
      alsoRead: range
        .filter((message) => !workSeqs.has(message.seq))
        .map((message) => this.toAgent(message, paths)),
      outbox,
    };
    if (!input.work.length && !input.alsoRead.length) {
      // Nothing left to show (the messages are gone): nothing to run.
      this.state.unitAnswered(unit.id, { finished: [] });
      return true;
    }
    // Asked again, just before the hook starts: preparing the input took
    // time (history, files), and a removal or pause during it must stop the
    // run. What was prepared is then not handed over. Once the hook has
    // started, a removal cannot take back what it was given.
    if (!(await this.allowed(unit))) return false;
    this.state.unitAttempt(unit.id);
    const outcome = await this.watched(() =>
      runAgent(this.config.agent, input, (stop) => (this.stopAgent = stop)),
    );
    this.stopAgent = null;
    this.row();
    const checked = outcome.ok
      ? validateResult(outcome.output, unit, outbox)
      : { ok: false as const, reason: outcome.reason };
    if (!checked.ok) {
      // A failed attempt: nothing is completed or sent, and the unit and its
      // items stay as they were. The reason is logged without content.
      const failed = unit.attempts + 1;
      const wait = this.times.agentRetryMs[failed - 1];
      this.log("agent_failed", {
        profile: this.name,
        unit: unit.id,
        attempt: failed,
        reason: checked.reason,
      });
      if (wait === undefined) this.state.unitParked(unit.id, checked.reason);
      else this.state.unitWait(unit.id, Date.now() + wait, checked.reason);
      return false;
    }
    // Saved before anything is sent or completed. From here the agent is
    // not run again for this unit.
    this.state.unitAnswered(unit.id, checked.result);
    return true;
  }

  /**
   * While the agent runs nothing else uses the keys, so this step also asks
   * mo now and then whether the connection still exists. If mo has ended
   * it, the agent is asked to stop.
   */
  private async watched<T>(run: () => Promise<T>): Promise<T> {
    let over = false;
    const running = run().finally(() => (over = true));
    const watch = (async () => {
      while (!over) {
        await Promise.race([
          running.catch(() => {}),
          sleep(this.times.livenessMs),
        ]);
        if (over) return;
        try {
          await this.call((token) => this.api.account(token));
        } catch (error) {
          if (error instanceof Disconnected) this.stopAgent?.();
        }
      }
    })();
    const result = await running;
    await watch;
    return result;
  }

  // After a valid result.

  private async upload(unit: Unit, row: ReturnType<State["uploads"]>[number]) {
    const chat = unit.chat_id;
    const request = {
      uploadId: row.upload_id,
      membershipId: unit.membership_id,
      name: row.name,
      mediaType: row.media_type,
      size: row.size,
      sha256: row.sha256,
    };
    // The same uploadId and input resume an upload that was interrupted.
    let upload = await this.call((token) =>
      this.api.createUpload(token, chat, request),
    );
    if (upload.state !== "verified") {
      const parts: { index: number; md5: string }[] = [];
      for (let index = 0; index < upload.partCount; index++) {
        const md5 = await partMd5(row.path, row.size, upload.partSize, index);
        parts.push({ index, md5 });
        if (upload.verifiedParts.includes(index)) continue;
        for (let attempt = 0; ; attempt++) {
          if (!upload.transfer) throw new MoUnreachable("No upload grant.");
          const sent = await uploadPart(upload.transfer, index, {
            path: row.path,
            size: row.size,
            partSize: upload.partSize,
          });
          if (sent.state === "stored" || sent.state === "exists") break;
          if (sent.state === "denied")
            throw new MoApiError(403, "not_a_member", "Storage refused.", "");
          if (attempt >= 2) throw new MoUnreachable("A part did not upload.");
          // The grant ran out, or the part failed: ask for the upload again.
          upload = await this.call((token) =>
            this.api.getUpload(token, chat, row.upload_id),
          );
        }
      }
      await this.call((token) =>
        this.api.completeUpload(token, chat, row.upload_id, parts),
      );
    }
    this.state.uploadVerified(unit.id, row.idx);
  }

  /** `answered` to `sending`, or straight to closed when there is no reply. */
  private async afterResult(unit: Unit) {
    const result = unit.result!;
    const files = result.reply?.files ?? [];
    for (const [idx, path] of files.entries())
      // Saved before the first part moves.
      this.state.saveUpload({
        unit_id: unit.id,
        idx,
        upload_id: `dc-${unit.id}-${idx}`,
        path,
        name: basename(path).slice(0, 200),
        media_type:
          MEDIA[extname(path).toLowerCase()] ?? "application/octet-stream",
        size: (await stat(path)).size,
        sha256: await fileSha256(path),
      });
    const uploads = this.state.uploads(unit.id);
    for (const row of uploads)
      if (row.state !== "verified") await this.upload(unit, row);
    if (result.reply) {
      // Saved before it is sent: the one exact request. Every retry sends
      // this saved request unchanged, so mo returns the first receipt and
      // never makes a second message.
      this.state.unitSending(unit.id, {
        sendId: unit.send_id,
        membershipId: unit.membership_id,
        body: result.reply.text ?? "",
        handlesUpdates: result.finished,
        attachments: uploads.map((row) => ({ uploadId: row.upload_id })),
      });
      return;
    }
    // No reply: the finished items are completed on their own. Only what
    // the agent listed is completed.
    if (result.finished.length)
      await this.call((token) =>
        this.api.completeUpdates(token, result.finished),
      );
    await this.close(unit);
  }

  /** `sending` to closed. False means: not now. */
  private async sendFor(unit: Unit): Promise<boolean> {
    const chat = unit.chat_id;
    if (!unit.receipt) {
      if (!(await this.allowed(unit))) return false;
      const receipt = await this.call((token) =>
        this.api.send(token, chat, unit.send_request!),
      );
      this.state.unitReceipt(unit.id, {
        messageId: receipt.messageId,
        seq: receipt.seq,
      });
      this.log("replied", { profile: this.name, unit: unit.id });
    }
    await this.close(unit);
    return true;
  }

  private async close(unit: Unit) {
    const finished = new Set(unit.result?.finished ?? []);
    this.state.unitClosed(
      unit,
      unit.work
        .map((item) => item.feedSeq)
        .filter((feedSeq) => !finished.has(feedSeq)),
      Date.now(),
      this.times.deferMs,
    );
    await this.dropFiles(unit.id);
  }

  /**
   * Take one unit as far as it can go now. Other chats are not held up.
   * `checked` says the caller asked mo about this unit's membership and
   * pause a moment ago (it has just frozen it).
   */
  private async advance(unit: Unit, checked = false) {
    for (;;) {
      const now = this.state.unit(unit.id);
      if (!now || now.not_before > Date.now()) return;
      try {
        if (now.state === "frozen") {
          // Before the intentional read: a unit frozen under an earlier
          // membership (left and rejoined while this connector was stopped)
          // must not open the chat, which would mark the new membership's
          // messages read and move the handover position for a unit that
          // is then cancelled. An open with no answer is a separate saved
          // duty and is not touched by this.
          if (!checked && !(await this.allowed(now))) return;
          checked = false;
          await this.openFor(now);
        } else if (now.state === "ready") {
          if (!(await this.runFor(now))) return;
        } else if (now.state === "answered") await this.afterResult(now);
        else if (now.state === "sending") {
          if (!(await this.sendFor(now))) return;
        } else return;
      } catch (error) {
        if (error instanceof Disconnected) throw error;
        if (gone(error)) {
          // Removed, or left and rejoined: never retried under a later
          // membership.
          await this.cancel(now.id, "membership_changed");
          return;
        }
        const api = error instanceof MoApiError ? error : undefined;
        const wait =
          api?.code === "agents_paused"
            ? this.times.pausedMs
            : api?.retryAfterSeconds
              ? api.retryAfterSeconds * 1000
              : this.times.errorMs;
        this.state.unitWait(now.id, Date.now() + wait, describe(error).code);
        this.log("unit_waiting", {
          profile: this.name,
          unit: now.id,
          ...describe(error),
        });
        return;
      }
    }
  }
}

/** mo says this membership or chat is not there for this connection. */
function gone(error: unknown) {
  return (
    error instanceof MoApiError &&
    ["not_a_member", "update_unavailable", "not_permitted"].includes(error.code)
  );
}
/** What a log may say about an error: a code, never a message or a header. */
function describe(error: unknown) {
  if (error instanceof MoApiError)
    return { code: error.code, status: error.status };
  if (error instanceof MoUnreachable) return { code: "mo_unreachable" };
  return { code: "error" };
}
async function partMd5(
  path: string,
  size: number,
  partSize: number,
  index: number,
) {
  const hash = createHash("md5");
  const { start, end } = partRange(size, partSize, index);
  if (end >= start)
    for await (const chunk of createReadStream(path, { start, end }))
      hash.update(chunk as Buffer);
  return hash.digest("hex");
}
