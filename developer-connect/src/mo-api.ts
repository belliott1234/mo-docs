// The plain HTTP calls the connector makes to mo's direct API.
//
// This file keeps no state and reads no file. Every call is given the access
// token it should use; saving keys, renewing them and deciding what to retry
// belong to the receiver. The full contract is mo's /openapi.json.
import { randomBytes, randomUUID } from "node:crypto";

export type Key = { id: string; secret: string };
export type Labelled = { text: string };

/** A refusal as mo words it: a fixed code, plain words and the next step. */
export class MoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nextAction: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
/** No answer arrived, or it was not mo's. The request may have been applied. */
export class MoUnreachable extends Error {}

export const newSecret = () => randomBytes(32).toString("base64url");
export const newKey = (): Key => ({ id: randomUUID(), secret: newSecret() });
export const accessToken = (key: Key) => `Bearer mo_a_${key.id}.${key.secret}`;
export const renewalToken = (key: Key) =>
  `Renewal mo_n_${key.id}.${key.secret}`;

export type Session = {
  account: { id: string; messaging?: string };
  credential: {
    id: string;
    role: "owner" | "agent";
    expiresAt: string;
    connectionId: string;
  };
  renewal: { id: string; expiresAt: string } | null;
};
/** mo's answer to the developer about a product. Only here is the number shown. */
export type ListingView = {
  handle: string | null;
  listed: boolean;
  shown: boolean;
  hiddenBecause: string | null;
  listingId: string | null;
  listedApplicationId: string | null;
  listedAt: string | null;
  suspended: boolean;
  suspendedReason: string | null;
  application: {
    id: string;
    state: string;
    description: string;
    whatItDoes: string;
    supportContact: string;
    reason: string | null;
    submittedAt: string;
    decidedAt: string | null;
  } | null;
};
export type ProductView = {
  agentAccountId: string;
  handle: string | null;
  number: { value: string; verified: boolean } | null;
};
/** The body of a join or a renewal: the new keys, made and saved first. */
export type NewKeys = {
  credential: Key & { label: string };
  renewalKey: Key;
};

export type Attachment = {
  id: string;
  name: Labelled;
  mediaType: string;
  size: number;
};
export type UpdateMessage = {
  id: string;
  seq: number;
  senderAccountId: string;
  content: Labelled;
  attachments: Attachment[];
  truncated: boolean;
  sentByConnectionId: string | null;
  addressedTo?: "you" | "another_agent" | "your_side" | "everyone" | "others";
  handling: unknown[];
};
/** A message as history and an open return it. */
export type ChatMessage = {
  id: string;
  seq: number;
  createdAt: string;
  sender: { accountId: string; isYou: boolean; displayName: Labelled };
  sentByThisConnection: boolean;
  sentByConnectionId: string | null;
  content: Labelled;
  attachments: Attachment[];
  addressedTo?: UpdateMessage["addressedTo"];
  handling: unknown[];
};
export type Update = {
  feedSeq: number;
  kind: string;
  chatId: string | null;
  membershipId: string | null;
  reason: string;
  previouslyDelivered: boolean;
  paused: boolean;
  message: UpdateMessage | null;
  /**
   * Whether mo lets the agent answer this message (agent access). The
   * generation goes back with the answer; mo refuses an answer begun before
   * a block or another restriction.
   */
  access?: { canAnswer: boolean; reason: string | null; generation: number };
};
export type UpdatesPage = {
  nextStep: { code: string; text: string } | null;
  updates: Update[];
  nextAfterSeq: number;
  throughSeq: number;
  more: boolean;
};
export type Transfer = {
  url: string;
  bucket: string;
  objectPrefix: string;
  apiKey: string | null;
  token: string;
  expiresAt: string;
};
export type Upload = {
  uploadId: string;
  state: string;
  partSize: number;
  partCount: number;
  verifiedParts: number[];
  transfer: Transfer | null;
};
export type Download = {
  name: Labelled;
  mediaType: string;
  size: number;
  sha256: string;
  partSize: number;
  partCount: number;
  parts: { index: number; size: number; md5: string }[];
  transfer: Transfer | null;
};
export type SendInput = {
  sendId: string;
  membershipId: string;
  body: string;
  handlesUpdates: number[];
  attachments: { uploadId: string }[];
  /** The access generation of the work answered, when mo gave one. */
  accessGeneration?: number;
};

export class MoApi {
  readonly server: string;
  constructor(
    server: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(server);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    // Keys are only ever sent over https, or to this machine for local tests.
    if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      throw new Error("The mo address must be https.");
    this.server = url.origin;
  }

  private async call<T>(
    method: string,
    path: string,
    authorization: string | undefined,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(`${this.server}${path}`, {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          ...(authorization ? { authorization } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
    } catch {
      // Never the cause: an error's text can carry a request's headers.
      throw new MoUnreachable("mo did not answer.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MoUnreachable(`mo's answer was not JSON (${response.status}).`);
    }
    if (response.ok) return parsed as T;
    const error = (parsed as { error?: Record<string, unknown> }).error ?? {};
    throw new MoApiError(
      response.status,
      String(error.code ?? "unknown"),
      String(error.message ?? "mo refused the request."),
      String(error.nextAction ?? ""),
      typeof error.retryAfterSeconds === "number"
        ? error.retryAfterSeconds
        : undefined,
    );
  }

  // Access. Save `keys` privately BEFORE calling either of these, and after a
  // lost answer send exactly the saved request again.
  async redeemJoinCode(inviteCode: string, keys: NewKeys) {
    return (
      await this.call<{ session: Session }>(
        "POST",
        "/v1/link-invites/redeem",
        undefined,
        { inviteCode, ...keys },
      )
    ).session;
  }
  renew(oldRenewal: Key, request: NewKeys & { operationId: string }) {
    return this.call<Session>(
      "POST",
      "/v1/access/renew",
      renewalToken(oldRenewal),
      request,
    );
  }
  account(token: string) {
    return this.call<Session>("GET", "/v1/account", token);
  }
  /** Removes this connection itself, renewal included. */
  removeConnection(token: string, credentialId: string) {
    return this.call<{ revoked: true }>(
      "DELETE",
      `/v1/credentials/${credentialId}`,
      token,
    );
  }

  // A product with its own name. `request` is saved privately BEFORE the
  // first send and sent again unchanged; mo answers a repeat from its receipt.
  createAgentAccount(
    token: string,
    request: NewKeys & {
      operationId: string;
      displayName: string;
      recoverySecret: string;
    },
  ) {
    return this.call<{ agentAccountId: string; session: Session }>(
      "POST",
      "/v1/agent-accounts",
      token,
      request,
    );
  }
  /** A join code for one more connection. Owner connections only. */
  joinCode(token: string, role: "agent" | "owner") {
    return this.call<{ inviteCode: string; expiresAt: string }>(
      "POST",
      "/v1/link-invites",
      token,
      { role },
    );
  }
  connections(token: string) {
    return this.call<{
      credentials: {
        id: string;
        connectionId: string | null;
        label: string;
        role: string;
        revokedAt?: string | null;
        wakeRoute: string | null;
      }[];
    }>("GET", "/v1/credentials", token);
  }
  // The developer's own key, never the product's: a handle, and a number
  // people can find the product by. Neither gives any access.
  setAgentHandle(token: string, agentAccountId: string, handle: string) {
    return this.call<ProductView>(
      "PUT",
      `/v1/agent-accounts/${agentAccountId}/handle`,
      token,
      { handle },
    );
  }
  addAgentNumber(token: string, agentAccountId: string, phone: string) {
    return this.call<ProductView & { status: "code_sent"; expiresAt: string }>(
      "POST",
      `/v1/agent-accounts/${agentAccountId}/number`,
      token,
      { phone },
    );
  }
  verifyAgentNumber(token: string, agentAccountId: string, code: string) {
    return this.call<ProductView>(
      "POST",
      `/v1/agent-accounts/${agentAccountId}/number/verify`,
      token,
      { code },
    );
  }
  removeAgentNumber(token: string, agentAccountId: string) {
    return this.call<ProductView>(
      "DELETE",
      `/v1/agent-accounts/${agentAccountId}/number`,
      token,
    );
  }

  // The directory listing. The developer's own key again. Nothing here gives
  // any access; an approved listing makes the entry public.
  applyAgentListing(
    token: string,
    agentAccountId: string,
    application: {
      applicationId: string;
      description: string;
      whatItDoes: string;
      supportContact: string;
    },
  ) {
    return this.call<ListingView>(
      "PUT",
      `/v1/agent-accounts/${agentAccountId}/listing`,
      token,
      application,
    );
  }
  agentListing(token: string, agentAccountId: string) {
    return this.call<ListingView>(
      "GET",
      `/v1/agent-accounts/${agentAccountId}/listing`,
      token,
    );
  }
  /** Names exactly what it withdraws, as the view showed it. */
  withdrawAgentListing(
    token: string,
    agentAccountId: string,
    named: { applicationId?: string; listingId?: string },
  ) {
    const query = new URLSearchParams(
      Object.entries(named).filter((e): e is [string, string] => !!e[1]),
    );
    return this.call<
      ListingView & { withdrew: { application: boolean; listing: boolean } }
    >("DELETE", `/v1/agent-accounts/${agentAccountId}/listing?${query}`, token);
  }

  // Being called.
  subscribe(
    token: string,
    input: {
      url: string;
      secret: string;
      cursor?: string | null;
      /** 5 minutes to 7 days; left out, mo gives 7 days. */
      ttlMs?: number;
    },
  ) {
    return this.call<{
      id: string;
      refreshBefore: string;
      cursor: string | null;
      truncated: boolean;
    }>("POST", "/v1/events/subscriptions", token, {
      name: "mo.message.created",
      delivery: { mode: "webhook", url: input.url, secret: input.secret },
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
    });
  }
  unsubscribe(token: string, subscriptionId: string) {
    return this.call<{ ended: true }>(
      "DELETE",
      `/v1/events/subscriptions/${subscriptionId}`,
      token,
    );
  }

  // Work. Fetching a page completes nothing and reads nothing.
  updates(
    token: string,
    input: {
      afterSeq?: number;
      throughSeq?: number;
      checkEverySeconds?: number;
    },
  ) {
    const query = new URLSearchParams({ limit: "50", mode: "unfinished" });
    for (const [name, value] of Object.entries(input))
      if (value !== undefined) query.set(name, String(value));
    return this.call<UpdatesPage>("GET", `/v1/updates?${query}`, token);
  }
  completeUpdates(token: string, feedSeqs: number[]) {
    return this.call<{ state: "handled" }>(
      "POST",
      "/v1/updates/complete",
      token,
      { feedSeqs },
    );
  }
  controls(token: string, chatId: string) {
    return this.call<{ membershipId: string; paused: boolean }>(
      "GET",
      `/v1/chats/${chatId}/controls`,
      token,
    );
  }
  /** The intentional read: this is what shows the other side "read". */
  openChat(token: string, chatId: string, limit = 50) {
    return this.call<{
      messages: ChatMessage[];
      more: boolean;
      readSeq: number;
    }>("POST", `/v1/chats/${chatId}/open`, token, { limit });
  }
  /** History in pages; changes no read state. */
  history(
    token: string,
    chatId: string,
    input: { afterSeq: number; throughSeq?: number },
  ) {
    const query = new URLSearchParams({ limit: "50" });
    for (const [name, value] of Object.entries(input))
      if (value !== undefined) query.set(name, String(value));
    return this.call<{
      messages: ChatMessage[];
      more: boolean;
      nextAfterSeq: number;
      throughSeq: number;
    }>("GET", `/v1/chats/${chatId}/messages?${query}`, token);
  }
  /** Repeat with the same sendId and the same input after a lost answer. */
  send(token: string, chatId: string, input: SendInput) {
    return this.call<{ state: "accepted"; messageId: string; seq: number }>(
      "POST",
      `/v1/chats/${chatId}/messages`,
      token,
      { ...input, mentions: [] },
    );
  }

  // Files. mo hands out a short grant; the bytes go straight to storage.
  createUpload(
    token: string,
    chatId: string,
    input: {
      uploadId: string;
      membershipId: string;
      name: string;
      mediaType: string;
      size: number;
      sha256: string;
    },
  ) {
    return this.call<Upload>(
      "POST",
      `/v1/chats/${chatId}/uploads`,
      token,
      input,
    );
  }
  getUpload(token: string, chatId: string, uploadId: string) {
    return this.call<Upload>(
      "GET",
      `/v1/chats/${chatId}/uploads/${encodeURIComponent(uploadId)}`,
      token,
    );
  }
  completeUpload(
    token: string,
    chatId: string,
    uploadId: string,
    parts: { index: number; md5: string }[],
  ) {
    return this.call<Upload>(
      "POST",
      `/v1/chats/${chatId}/uploads/${encodeURIComponent(uploadId)}/complete`,
      token,
      { parts },
    );
  }
  openDownload(token: string, chatId: string, attachmentId: string) {
    return this.call<Download>(
      "POST",
      `/v1/chats/${chatId}/attachments/${attachmentId}/transfer`,
      token,
      {},
    );
  }
}
