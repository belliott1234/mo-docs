// Everything the connector must remember, in one SQLite file.
//
// The file is opened by exactly one process: `locking_mode=EXCLUSIVE` plus a
// committed write at start takes a lock the operating system releases when
// the process dies. A second process gets "database is locked" and stops.
// Incoming message text is not saved here: it is fetched from mo each time it
// is needed. Outgoing text is: a unit's row keeps the agent's result (with the
// reply text) and the exact send request, so a retry sends the same message.
// Those rows stay after a unit is closed or cancelled, until `forget`.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Key, NewKeys, SendInput } from "./mo-api.js";

export class StateInUse extends Error {}
/** The folder is the other kind: `run` never opens a control folder. */
export class WrongFolder extends Error {}
export type FolderKind = "runtime" | "control";
/** What the control folder keeps for one product. */
export type Product = {
  name: string;
  /** The runtime profile's name, and the start of the control profile's. */
  slug: string;
  /** The developer's own profile in the control folder. */
  developer: string;
  server: string;
  developer_account: string;
  /** The exact creation request, saved before it was first sent. */
  request: string;
  state: "creating" | "created";
  agent_account_id: string | null;
  runtime_joined: number;
  /** mo's last answer about the handle and number, for `product status`. */
  view: string | null;
};
export type CreateRequest = NewKeys & {
  operationId: string;
  displayName: string;
  recoverySecret: string;
};
/** A product's control profile sits in the control folder under this name. */
export const controlProfile = (slug: string) => `${slug}.control`;

export type Profile = {
  name: string;
  server: string;
  label: string;
  account_id: string | null;
  connection_id: string | null;
  access_id: string;
  access_secret: string;
  access_expires: string | null;
  renewal_id: string;
  renewal_secret: string;
  /** `joining` holds keys that were saved before the join code was sent. */
  state: "joining" | "active" | "disconnected";
  reason: string | null;
  join_code: string | null;
};
export type RenewalPending = {
  profile: string;
  stage: "saved" | "accepted";
  request: NewKeys & { operationId: string };
  old_access_id: string;
  old_renewal: Key;
};
export type Subscription = {
  profile: string;
  route_token: string;
  secret: string;
  candidate_secret: string | null;
  subscription_id: string | null;
  callback_url: string | null;
  refresh_before: string | null;
  cursor: string | null;
  cursor_seq: number;
  last_attempt: number;
};
export type ChatRead = {
  handed_through: number;
  opened_through: number;
  unconfirmed: number;
  open_unanswered: string | null;
};
export type WorkItem = {
  feedSeq: number;
  messageSeq: number;
  reason: string;
  previouslyDelivered: boolean;
  notForYourSide: boolean;
  /** The access generation mo gave the update (agent access). */
  accessGeneration?: number;
};
export type AgentResult = {
  finished: number[];
  reply?: { text?: string; files?: string[] };
  personAskedForThis?: boolean;
};
export type UnitState =
  | "frozen" // saved; the chat is not opened yet
  | "ready" // its input range is saved; the agent may run
  | "answered" // a valid result is saved; the agent is not run again
  | "sending" // the exact send request is saved
  | "closed"
  | "cancelled"
  | "parked";
export type Unit = {
  id: string;
  profile: string;
  chat_id: string;
  membership_id: string;
  work: WorkItem[];
  send_id: string;
  state: UnitState;
  /** The agent's input holds the messages above `input_from`, through `input_to`. */
  input_from: number | null;
  input_to: number | null;
  result: AgentResult | null;
  send_request: SendInput | null;
  receipt: { messageId: string; seq: number } | null;
  attempts: number;
  not_before: number;
  note: string | null;
};
export type UploadRow = {
  unit_id: string;
  idx: number;
  upload_id: string;
  path: string;
  name: string;
  media_type: string;
  size: number;
  sha256: string;
  state: "saved" | "verified";
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, started TEXT);
CREATE TABLE IF NOT EXISTS profile(
  name TEXT PRIMARY KEY, server TEXT NOT NULL, label TEXT NOT NULL,
  account_id TEXT, connection_id TEXT,
  access_id TEXT NOT NULL, access_secret TEXT NOT NULL, access_expires TEXT,
  renewal_id TEXT NOT NULL, renewal_secret TEXT NOT NULL,
  state TEXT NOT NULL, reason TEXT, join_code TEXT);
CREATE TABLE IF NOT EXISTS renewal_pending(
  profile TEXT PRIMARY KEY, stage TEXT NOT NULL, request TEXT NOT NULL,
  old_access_id TEXT NOT NULL, old_renewal_id TEXT NOT NULL, old_renewal_secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscription(
  profile TEXT PRIMARY KEY, route_token TEXT NOT NULL UNIQUE, secret TEXT NOT NULL,
  candidate_secret TEXT, subscription_id TEXT, callback_url TEXT, refresh_before TEXT,
  cursor TEXT, cursor_seq INTEGER NOT NULL DEFAULT 0, last_attempt INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS event(
  profile TEXT NOT NULL, event_id TEXT NOT NULL, name TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (profile, event_id));
CREATE TABLE IF NOT EXISTS wake(
  profile TEXT PRIMARY KEY, wake_generation INTEGER NOT NULL DEFAULT 0,
  drained_generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_read(
  profile TEXT NOT NULL, chat_id TEXT NOT NULL,
  handed_through INTEGER NOT NULL, opened_through INTEGER NOT NULL DEFAULT 0,
  unconfirmed INTEGER NOT NULL DEFAULT 1, open_unanswered TEXT,
  PRIMARY KEY (profile, chat_id));
CREATE TABLE IF NOT EXISTS unit(
  id TEXT PRIMARY KEY, profile TEXT NOT NULL, chat_id TEXT NOT NULL, membership_id TEXT NOT NULL,
  work TEXT NOT NULL, send_id TEXT NOT NULL, state TEXT NOT NULL,
  input_from INTEGER, input_to INTEGER, result TEXT, send_request TEXT, receipt TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0, note TEXT,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS unit_open ON unit(profile, chat_id, state);
CREATE TABLE IF NOT EXISTS upload(
  unit_id TEXT NOT NULL, idx INTEGER NOT NULL, upload_id TEXT NOT NULL, path TEXT NOT NULL,
  name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  state TEXT NOT NULL, PRIMARY KEY (unit_id, idx));
-- Work the agent did not list as finished: not offered to it again before this time.
CREATE TABLE IF NOT EXISTS deferred(
  profile TEXT NOT NULL, feed_seq INTEGER NOT NULL, times INTEGER NOT NULL, not_before INTEGER NOT NULL,
  PRIMARY KEY (profile, feed_seq));
`;
// Which kind of folder this is, and (control folder only) its products.
const FOLDER_SCHEMA = `
CREATE TABLE IF NOT EXISTS folder(id INTEGER PRIMARY KEY CHECK (id = 1), kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS product(
  name TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, developer TEXT NOT NULL, server TEXT NOT NULL,
  developer_account TEXT NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
  agent_account_id TEXT, runtime_joined INTEGER NOT NULL DEFAULT 0, view TEXT);
-- A listing request (an application, or a withdrawal) saved before it is
-- first sent and kept until its outcome is known. One of each kind a
-- product. "unknown" counts the attempts that ended, or may have ended,
-- without mo's answer: any of them may have reached mo.
CREATE TABLE IF NOT EXISTS listing_request(
  product TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('apply','unlist')),
  request TEXT NOT NULL, unknown INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (product, kind));
`;
const OPEN = `state IN ('frozen','ready','answered','sending','parked')`;
const json = <T>(text: unknown): T | null =>
  typeof text === "string" ? (JSON.parse(text) as T) : null;

export class State {
  private readonly db: DatabaseSync;

  /** Opens the state directory, or throws StateInUse if a process owns it. */
  constructor(
    readonly directory: string,
    readonly kind: FolderKind = "runtime",
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, "state.db");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;");
      this.db.exec(SCHEMA);
      // The committed write is what takes, and keeps, the lock.
      this.db
        .prepare(
          "INSERT INTO owner(id,pid,started) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, started=excluded.started",
        )
        .run(process.pid, new Date().toISOString());
      this.db.exec(FOLDER_SCHEMA);
      // A folder is one kind for good. One made before kinds existed, with
      // profiles in it, is a runtime folder.
      const marked = this.get<{ kind: FolderKind }>(
        "SELECT kind FROM folder WHERE id=1",
      )?.kind;
      const found =
        marked ??
        (this.get("SELECT 1 FROM profile LIMIT 1") ? "runtime" : kind);
      if (!marked) this.run("INSERT INTO folder(id,kind) VALUES (1,?)", found);
      if (found !== kind)
        throw new WrongFolder(
          found === "control"
            ? "This is a control folder: it holds control keys, and only `join --control` and `product` commands open it."
            : "This is a runtime folder, not a control folder.",
        );
    } catch (error) {
      this.db.close();
      if ((error as { errcode?: number }).errcode === 5)
        throw new StateInUse(
          "Another connector process is using this state directory.",
        );
      throw error;
    }
    chmodSync(path, 0o600);
  }
  close() {
    this.db.close();
  }
  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private get<T>(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).get(...values) as T | undefined;
  }
  private all<T>(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).all(...values) as T[];
  }
  private run(sql: string, ...values: (string | number | null)[]) {
    return this.db.prepare(sql).run(...values);
  }

  // Profiles and keys.
  profiles() {
    return this.all<Profile>("SELECT * FROM profile ORDER BY name");
  }
  profile(name: string) {
    return this.get<Profile>("SELECT * FROM profile WHERE name=?", name);
  }
  /** Saves new keys, the join code and the signing secret before any call. */
  createProfile(input: {
    name: string;
    server: string;
    label: string;
    keys: NewKeys;
    joinCode: string;
    routeToken: string;
    signingSecret: string;
    /**
     * A join made for one known account (a product's runtime join). Kept in
     * account_id while the profile is still joining, so the saved join stays
     * bound to that account. An ordinary join leaves it empty.
     */
    expectAccount?: string;
  }) {
    this.tx(() => {
      this.run(
        "INSERT INTO profile(name,server,label,account_id,access_id,access_secret,renewal_id,renewal_secret,state,join_code) VALUES (?,?,?,?,?,?,?,?,'joining',?)",
        input.name,
        input.server,
        input.label,
        input.expectAccount ?? null,
        input.keys.credential.id,
        input.keys.credential.secret,
        input.keys.renewalKey.id,
        input.keys.renewalKey.secret,
        input.joinCode,
      );
      this.run(
        "INSERT INTO subscription(profile,route_token,secret) VALUES (?,?,?)",
        input.name,
        input.routeToken,
        input.signingSecret,
      );
      this.run("INSERT INTO wake(profile) VALUES (?)", input.name);
    });
  }
  joined(
    name: string,
    session: {
      accountId: string;
      connectionId: string;
      accessExpires: string;
    },
  ) {
    this.run(
      "UPDATE profile SET state='active', join_code=NULL, account_id=?, connection_id=?, access_expires=? WHERE name=?",
      session.accountId,
      session.connectionId,
      session.accessExpires,
      name,
    );
  }

  // Products (control folder only).
  products() {
    return this.all<Product>("SELECT * FROM product ORDER BY name");
  }
  product(name: string) {
    return this.get<Product>("SELECT * FROM product WHERE name=?", name);
  }
  productBySlug(slug: string) {
    return this.get<Product>("SELECT * FROM product WHERE slug=?", slug);
  }
  /** Saves the exact creation request before it is sent. Never replaced. */
  createProduct(input: {
    name: string;
    slug: string;
    developer: string;
    server: string;
    developerAccount: string;
    request: CreateRequest;
  }) {
    this.run(
      "INSERT INTO product(name,slug,developer,server,developer_account,request,state) VALUES (?,?,?,?,?,?,'creating')",
      input.name,
      input.slug,
      input.developer,
      input.server,
      input.developerAccount,
      JSON.stringify(input.request),
    );
  }
  /** mo answered the creation: its keys become the product's control profile. */
  productCreated(
    name: string,
    answer: {
      agentAccountId: string;
      connectionId: string;
      accessExpires: string;
    },
  ) {
    this.tx(() => {
      const product = this.product(name)!;
      const request = JSON.parse(product.request) as CreateRequest;
      this.run(
        "INSERT INTO profile(name,server,label,account_id,connection_id,access_id,access_secret,access_expires,renewal_id,renewal_secret,state) VALUES (?,?,?,?,?,?,?,?,?,?,'active')",
        controlProfile(product.slug),
        product.server,
        request.credential.label,
        answer.agentAccountId,
        answer.connectionId,
        request.credential.id,
        request.credential.secret,
        answer.accessExpires,
        request.renewalKey.id,
        request.renewalKey.secret,
      );
      this.run(
        "UPDATE product SET state='created', agent_account_id=? WHERE name=?",
        answer.agentAccountId,
        name,
      );
    });
  }
  productRuntimeJoined(name: string) {
    this.run("UPDATE product SET runtime_joined=1 WHERE name=?", name);
  }
  productRuntimeRemoved(name: string) {
    this.run("UPDATE product SET runtime_joined=0 WHERE name=?", name);
  }
  /** The saved listing request of this kind whose answer has not arrived. */
  listingRequest<T>(product: string, kind: "apply" | "unlist") {
    return json<T>(
      this.get<{ request: string }>(
        "SELECT request FROM listing_request WHERE product=? AND kind=?",
        product,
        kind,
      )?.request,
    );
  }
  /** Saved before it is sent. Never replaced while it is unanswered. */
  saveListingRequest(
    product: string,
    kind: "apply" | "unlist",
    request: unknown,
  ) {
    this.run(
      "INSERT INTO listing_request(product,kind,request) VALUES (?,?,?)",
      product,
      kind,
      JSON.stringify(request),
    );
  }
  /** How many attempts of the saved request have no known outcome. */
  listingRequestUnknown(product: string, kind: "apply" | "unlist") {
    return (
      this.get<{ unknown: number }>(
        "SELECT unknown FROM listing_request WHERE product=? AND kind=?",
        product,
        kind,
      )?.unknown ?? 0
    );
  }
  /** Written before an attempt is sent (one more unknown) and after mo refuses it (one fewer). */
  setListingRequestUnknown(
    product: string,
    kind: "apply" | "unlist",
    unknown: number,
  ) {
    this.run(
      "UPDATE listing_request SET unknown=? WHERE product=? AND kind=?",
      unknown,
      product,
      kind,
    );
  }
  /** Its outcome is known, or the developer dropped it. */
  listingRequestAnswered(product: string, kind: "apply" | "unlist") {
    this.run(
      "DELETE FROM listing_request WHERE product=? AND kind=?",
      product,
      kind,
    );
  }
  productView(name: string, view: unknown) {
    this.run(
      "UPDATE product SET view=? WHERE name=?",
      JSON.stringify(view),
      name,
    );
  }
  removeProfile(name: string) {
    this.tx(() => {
      for (const table of [
        "renewal_pending",
        "subscription",
        "event",
        "wake",
        "chat_read",
        "deferred",
      ])
        this.run(`DELETE FROM ${table} WHERE profile=?`, name);
      this.run(
        "DELETE FROM upload WHERE unit_id IN (SELECT id FROM unit WHERE profile=?)",
        name,
      );
      this.run("DELETE FROM unit WHERE profile=?", name);
      this.run("DELETE FROM profile WHERE name=?", name);
    });
  }
  /** The connection is gone: stop for good and cancel what was open. */
  disconnect(name: string, reason: string) {
    this.tx(() => {
      this.run(
        "UPDATE profile SET state='disconnected', reason=? WHERE name=?",
        reason,
        name,
      );
      this.run(
        `UPDATE unit SET state='cancelled', note='disconnected' WHERE profile=? AND ${OPEN}`,
        name,
      );
    });
  }

  // Renewal: the full request is saved before it is sent.
  renewalPending(profile: string): RenewalPending | undefined {
    const row = this.get<{
      stage: "saved" | "accepted";
      request: string;
      old_access_id: string;
      old_renewal_id: string;
      old_renewal_secret: string;
    }>("SELECT * FROM renewal_pending WHERE profile=?", profile);
    return (
      row && {
        profile,
        stage: row.stage,
        request: JSON.parse(row.request) as RenewalPending["request"],
        old_access_id: row.old_access_id,
        old_renewal: { id: row.old_renewal_id, secret: row.old_renewal_secret },
      }
    );
  }
  /** Replaces any earlier row: an accepted one is only replaced by its successor. */
  saveRenewal(profile: Profile, request: RenewalPending["request"]) {
    this.run(
      "INSERT OR REPLACE INTO renewal_pending(profile,stage,request,old_access_id,old_renewal_id,old_renewal_secret) VALUES (?,'saved',?,?,?,?)",
      profile.name,
      JSON.stringify(request),
      profile.access_id,
      profile.renewal_id,
      profile.renewal_secret,
    );
  }
  renewalAccepted(pending: RenewalPending, accessExpires: string) {
    this.tx(() => {
      this.run(
        "UPDATE profile SET access_id=?, access_secret=?, access_expires=?, renewal_id=?, renewal_secret=? WHERE name=?",
        pending.request.credential.id,
        pending.request.credential.secret,
        accessExpires,
        pending.request.renewalKey.id,
        pending.request.renewalKey.secret,
        pending.profile,
      );
      this.run(
        "UPDATE renewal_pending SET stage='accepted' WHERE profile=?",
        pending.profile,
      );
    });
  }
  dropRenewal(profile: string) {
    this.run("DELETE FROM renewal_pending WHERE profile=?", profile);
  }

  // Being called.
  subscription(profile: string) {
    return this.get<Subscription>(
      "SELECT * FROM subscription WHERE profile=?",
      profile,
    )!;
  }
  subscriptionByRoute(token: string) {
    return this.get<Subscription>(
      "SELECT s.* FROM subscription s JOIN profile p ON p.name=s.profile WHERE s.route_token=? AND p.state='active'",
      token,
    );
  }
  subscribeAttempt(profile: string, at: number) {
    this.run(
      "UPDATE subscription SET last_attempt=? WHERE profile=?",
      at,
      profile,
    );
  }
  /** A validated 200: the secret that was sent becomes the only one. */
  subscribed(
    profile: string,
    input: { id: string; url: string; refreshBefore: string; secret: string },
  ) {
    this.run(
      "UPDATE subscription SET subscription_id=?, callback_url=?, refresh_before=?, secret=?, candidate_secret=NULL WHERE profile=?",
      input.id,
      input.url,
      input.refreshBefore,
      input.secret,
      profile,
    );
  }
  setCandidateSecret(profile: string, secret: string) {
    this.run(
      "UPDATE subscription SET candidate_secret=? WHERE profile=? AND candidate_secret IS NULL",
      secret,
      profile,
    );
  }
  /**
   * Accepting a call: one transaction saves the event, ignoring a repeat,
   * and counts a new one. Returns whether it was new.
   */
  acceptEvent(
    profile: string,
    event: { id: string; name: string; cursor?: string; feedSeq?: number },
    at: number,
  ) {
    return this.tx(() => {
      const added = this.run(
        "INSERT OR IGNORE INTO event(profile,event_id,name,received_at) VALUES (?,?,?,?)",
        profile,
        event.id,
        event.name,
        at,
      ).changes;
      if (!added) return false;
      this.run(
        "UPDATE wake SET wake_generation=wake_generation+1 WHERE profile=?",
        profile,
      );
      if (event.cursor && event.feedSeq !== undefined)
        this.run(
          "UPDATE subscription SET cursor=?, cursor_seq=? WHERE profile=? AND cursor_seq<?",
          event.cursor,
          event.feedSeq,
          profile,
          event.feedSeq,
        );
      return true;
    });
  }
  pruneEvents(before: number) {
    this.run("DELETE FROM event WHERE received_at<?", before);
  }
  wake(profile: string) {
    return this.get<{ wake_generation: number; drained_generation: number }>(
      "SELECT wake_generation, drained_generation FROM wake WHERE profile=?",
      profile,
    )!;
  }
  drained(profile: string, generation: number) {
    this.run(
      "UPDATE wake SET drained_generation=? WHERE profile=?",
      generation,
      profile,
    );
  }

  // How far each chat is opened, and how far it is handed to the agent.
  chatRead(profile: string, chat: string) {
    return this.get<ChatRead>(
      "SELECT handed_through, opened_through, unconfirmed, open_unanswered FROM chat_read WHERE profile=? AND chat_id=?",
      profile,
      chat,
    );
  }
  /** Before the first open of a chat. Returns true if the row is new. */
  startChatRead(profile: string, chat: string) {
    return (
      this.run(
        "INSERT OR IGNORE INTO chat_read(profile,chat_id,handed_through) VALUES (?,?,0)",
        profile,
        chat,
      ).changes === 1
    );
  }
  /** Before an open is sent: which access key it carries. */
  openSent(profile: string, chat: string, accessId: string) {
    this.run(
      "UPDATE chat_read SET open_unanswered=? WHERE profile=? AND chat_id=?",
      accessId,
      profile,
      chat,
    );
  }
  /**
   * An open's answer, in one transaction. The marker is cleared only if it
   * still names this call's own key, so a late answer clears nothing newer.
   * `tightenTo` is given only for the certain first answer.
   */
  openAnswered(
    profile: string,
    chat: string,
    accessId: string,
    readSeq: number | null,
    tightenTo?: number,
  ) {
    this.tx(() => {
      if (readSeq !== null)
        this.run(
          "UPDATE chat_read SET opened_through=MAX(opened_through,?) WHERE profile=? AND chat_id=?",
          readSeq,
          profile,
          chat,
        );
      if (tightenTo !== undefined)
        this.run(
          "UPDATE chat_read SET handed_through=MAX(handed_through,?), unconfirmed=0 WHERE profile=? AND chat_id=? AND unconfirmed=1",
          tightenTo,
          profile,
          chat,
        );
      this.run(
        "UPDATE chat_read SET open_unanswered=NULL WHERE profile=? AND chat_id=? AND open_unanswered=?",
        profile,
        chat,
        accessId,
      );
    });
  }
  unansweredOpens(profile: string) {
    return this.all<{ chat_id: string; open_unanswered: string }>(
      "SELECT chat_id, open_unanswered FROM chat_read WHERE profile=? AND open_unanswered IS NOT NULL",
      profile,
    );
  }
  /** Chats with messages marked read and not yet in any agent input. */
  owedChats(profile: string) {
    return this.all<{ chat_id: string }>(
      "SELECT chat_id FROM chat_read WHERE profile=? AND opened_through>handed_through",
      profile,
    ).map((row) => row.chat_id);
  }
  /**
   * After a removal from the chat. A row with an unanswered open is kept:
   * that call may still arrive, so its duty must run before the row can go.
   */
  forgetChat(profile: string, chat: string) {
    this.run(
      "DELETE FROM chat_read WHERE profile=? AND chat_id=? AND open_unanswered IS NULL",
      profile,
      chat,
    );
  }

  // Units.
  private unitOf(row: Record<string, unknown>): Unit {
    return {
      ...(row as unknown as Unit),
      work: json<WorkItem[]>(row.work)!,
      result: json<AgentResult>(row.result),
      send_request: json<SendInput>(row.send_request),
      receipt: json<Unit["receipt"] & object>(row.receipt),
    };
  }
  unit(id: string) {
    const row = this.get<Record<string, unknown>>(
      "SELECT * FROM unit WHERE id=?",
      id,
    );
    return row && this.unitOf(row);
  }
  openUnits(profile: string) {
    return this.all<Record<string, unknown>>(
      `SELECT * FROM unit WHERE profile=? AND ${OPEN} ORDER BY created, id`,
      profile,
    ).map((row) => this.unitOf(row));
  }
  /** Frozen before anything else happens; it never grows. */
  freezeUnit(input: {
    id: string;
    profile: string;
    chat: string;
    membership: string;
    work: WorkItem[];
    at: number;
  }) {
    this.run(
      "INSERT INTO unit(id,profile,chat_id,membership_id,work,send_id,state,created) VALUES (?,?,?,?,?,?,'frozen',?)",
      input.id,
      input.profile,
      input.chat,
      input.membership,
      JSON.stringify(input.work),
      `dc_${input.id}`,
      input.at,
    );
  }
  /** Save the input's range and move `handed_through`, together. */
  unitReady(unit: Unit, from: number, to: number) {
    this.tx(() => {
      this.run(
        "UPDATE unit SET state='ready', input_from=?, input_to=? WHERE id=? AND state='frozen'",
        from,
        to,
        unit.id,
      );
      this.run(
        "UPDATE chat_read SET handed_through=MAX(handed_through,?) WHERE profile=? AND chat_id=?",
        to,
        unit.profile,
        unit.chat_id,
      );
    });
  }
  unitAttempt(id: string) {
    this.run("UPDATE unit SET attempts=attempts+1 WHERE id=?", id);
  }
  unitWait(id: string, notBefore: number, note: string) {
    this.run(
      "UPDATE unit SET not_before=?, note=? WHERE id=?",
      notBefore,
      note,
      id,
    );
  }
  unitParked(id: string, note: string) {
    this.run("UPDATE unit SET state='parked', note=? WHERE id=?", note, id);
  }
  unitAnswered(id: string, result: AgentResult) {
    this.run(
      "UPDATE unit SET state='answered', result=?, not_before=0, note=NULL WHERE id=? AND state IN ('ready','parked')",
      JSON.stringify(result),
      id,
    );
  }
  unitSending(id: string, request: SendInput) {
    this.run(
      "UPDATE unit SET state='sending', send_request=? WHERE id=? AND state='answered'",
      JSON.stringify(request),
      id,
    );
  }
  unitReceipt(id: string, receipt: { messageId: string; seq: number }) {
    this.run(
      "UPDATE unit SET receipt=? WHERE id=?",
      JSON.stringify(receipt),
      id,
    );
  }
  /** Closes the unit; what the agent left unfinished waits before it returns. */
  unitClosed(unit: Unit, unfinished: number[], at: number, waits: number[]) {
    this.tx(() => {
      this.run("UPDATE unit SET state='closed', note=NULL WHERE id=?", unit.id);
      for (const seq of unfinished) {
        const times =
          (this.get<{ times: number }>(
            "SELECT times FROM deferred WHERE profile=? AND feed_seq=?",
            unit.profile,
            seq,
          )?.times ?? 0) + 1;
        const wait = waits[Math.min(times, waits.length) - 1] ?? 0;
        this.run(
          "INSERT OR REPLACE INTO deferred(profile,feed_seq,times,not_before) VALUES (?,?,?,?)",
          unit.profile,
          seq,
          times,
          at + wait,
        );
      }
    });
  }
  unitCancelled(id: string, note: string) {
    this.run(
      `UPDATE unit SET state='cancelled', note=? WHERE id=? AND ${OPEN}`,
      note,
      id,
    );
  }
  /** Cancels a chat's open work; with `keep`, only work of other memberships. */
  cancelChat(
    profile: string,
    chat: string,
    note: string,
    keep: string | null = null,
  ) {
    this.run(
      `UPDATE unit SET state='cancelled', note=? WHERE profile=? AND chat_id=? AND membership_id IS NOT ? AND ${OPEN}`,
      note,
      profile,
      chat,
      keep,
    );
  }
  /** The operator's `retry`: a parked unit gets fresh attempts. */
  unitRetry(id: string) {
    return (
      this.run(
        "UPDATE unit SET state='ready', attempts=0, not_before=0, note=NULL WHERE id=? AND state='parked'",
        id,
      ).changes === 1
    );
  }
  /** The operator's `finish`: a parked unit's work is completed with no reply. */
  unitFinishByHand(id: string) {
    const unit = this.unit(id);
    if (unit?.state !== "parked") return false;
    this.unitAnswered(id, { finished: unit.work.map((item) => item.feedSeq) });
    return true;
  }
  deferred(profile: string, at: number) {
    return new Map(
      this.all<{ feed_seq: number; not_before: number }>(
        "SELECT feed_seq, not_before FROM deferred WHERE profile=? AND not_before>?",
        profile,
        at,
      ).map((row) => [row.feed_seq, row.not_before]),
    );
  }
  forgetDeferred(profile: string, keep: number[]) {
    const kept = new Set(keep);
    for (const row of this.all<{ feed_seq: number }>(
      "SELECT feed_seq FROM deferred WHERE profile=?",
      profile,
    ))
      if (!kept.has(row.feed_seq))
        this.run(
          "DELETE FROM deferred WHERE profile=? AND feed_seq=?",
          profile,
          row.feed_seq,
        );
  }

  // Files in a reply: the uploadId is saved before the first part moves.
  uploads(unit: string) {
    return this.all<UploadRow>(
      "SELECT * FROM upload WHERE unit_id=? ORDER BY idx",
      unit,
    );
  }
  saveUpload(row: Omit<UploadRow, "state">) {
    this.run(
      "INSERT OR IGNORE INTO upload(unit_id,idx,upload_id,path,name,media_type,size,sha256,state) VALUES (?,?,?,?,?,?,?,?,'saved')",
      row.unit_id,
      row.idx,
      row.upload_id,
      row.path,
      row.name,
      row.media_type,
      row.size,
      row.sha256,
    );
  }
  uploadVerified(unit: string, idx: number) {
    this.run(
      "UPDATE upload SET state='verified' WHERE unit_id=? AND idx=?",
      unit,
      idx,
    );
  }
}
