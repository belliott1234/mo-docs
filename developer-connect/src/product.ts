// A product with its own name: an agent account you control.
//
// Two folders. The CONTROL folder holds your own profile and, per product,
// the product account's first owner connection and its recovery secret. The
// RUNTIME folder is the one `run` uses; `run` refuses to open a control
// folder, so the runtime never holds control keys.
//
// Creation is never done twice: the exact request is saved before it is
// first sent, and from then on this file only ever sends that saved request
// again. Nothing here makes a new operation id while one is unfinished.
import { randomUUID } from "node:crypto";
import { CONFIG_TEMPLATE } from "./config.js";
import { joinProfile, profileName, Stop } from "./join.js";
import {
  MoApi,
  MoApiError,
  newKey,
  newSecret,
  type ListingView,
} from "./mo-api.js";
import {
  controlProfile,
  State,
  StateInUse,
  WrongFolder,
  type CreateRequest,
  type Product,
} from "./state.js";
import { Disconnected, Worker, timings } from "./worker.js";

export type ProductIo = {
  /** One line from standard input, not echoed at a terminal. */
  line: (prompt: string) => Promise<string>;
  print: (text: string) => void;
};
type Flags = Record<string, string>;

const need = (flags: Flags, name: string) => {
  if (!flags[name]) throw new Stop(`--${name} is required.`);
  return flags[name];
};
export function openFolder(directory: string, kind: "runtime" | "control") {
  try {
    return new State(directory, kind);
  } catch (error) {
    if (error instanceof StateInUse)
      throw new Stop(
        kind === "runtime"
          ? "The runtime folder is in use by a running connector. Stop it, then run the same command again."
          : "Another command is using the control folder. Wait for it to end.",
      );
    if (error instanceof WrongFolder) throw new Stop(error.message);
    throw error;
  }
}
/** Calls as one profile, with the connector's own saved renewal. */
const as = (state: State, profile: string) =>
  new Worker(
    state,
    CONFIG_TEMPLATE,
    profile,
    () => {},
    timings(CONFIG_TEMPLATE),
  );

/** mo's own words for a refusal; never a key, never a guess. */
function said(error: unknown) {
  if (error instanceof MoApiError && error.code === "owner_required")
    return `mo refused (${error.code}): this needs an owner connection of your own account, and your own profile here has ordinary agent access. Nothing changed. Set the handle and manage the directory listing in mo's web app, under "You & your agents". See README, "Owner connections".`;
  if (error instanceof MoApiError)
    return `mo refused (${error.code}): ${error.message} ${error.nextAction}`.trim();
  if (error instanceof Disconnected)
    return "mo refused this profile's keys, or the profile is not active here. Join it again with a new join code.";
  return "mo did not answer.";
}
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** Your own profile: the one named, or the only one in the control folder. */
function developerOf(state: State, flags: Flags) {
  const own = state
    .profiles()
    .filter((p) => !p.name.endsWith(".control") && p.state === "active");
  if (flags.developer) {
    const named = own.find((p) => p.name === flags.developer);
    if (!named)
      throw new Stop(`No active profile named ${flags.developer} is here.`);
    return named;
  }
  if (!own.length)
    throw new Stop(
      "Join your own mo account in the control folder first: join --control --profile me --server URL",
    );
  if (own.length > 1)
    throw new Stop(
      "Several of your own profiles are here. Say which with --developer NAME.",
    );
  return own[0]!;
}
/** A created product and the developer profile that controls it. */
function created(state: State, flags: Flags) {
  const name = need(flags, "name");
  const product = state.product(name);
  if (!product || product.state !== "created" || !product.agent_account_id)
    throw new Stop(
      product
        ? `${name} is not created yet. Run: product create --name "${name}"`
        : `No product named ${name} is in this control folder.`,
    );
  return { product, agent: product.agent_account_id };
}
function show(product: Product) {
  const view = product.view
    ? (JSON.parse(product.view) as {
        handle: string | null;
        number: { verified: boolean } | null;
      })
    : null;
  return {
    name: product.name,
    state: product.state,
    agentAccountId: product.agent_account_id,
    runtimeProfile: product.slug,
    runtimeJoinedHere: !!product.runtime_joined,
    handle: view?.handle ?? null,
    // Whether it has one, never the number itself.
    number: view?.number
      ? view.number.verified
        ? "verified"
        : "waiting for its code"
      : "none",
  };
}

type ApplyRequest = {
  applicationId: string;
  description: string;
  whatItDoes: string;
  supportContact: string;
};
type UnlistRequest = { listingId?: string; applicationId?: string };
/**
 * Sends a saved listing request. It is forgotten only when its outcome is
 * known: mo answered with the result, or mo refused this attempt and every
 * earlier attempt was refused too. An attempt that got no answer may have
 * reached mo, and a later refusal says nothing about it, so from then on the
 * request is kept until mo answers with the result, or the developer drops
 * it with --abandon.
 */
async function finish<T>(
  state: State,
  product: Product,
  kind: "apply" | "unlist",
  send: () => Promise<T>,
) {
  const command = kind === "apply" ? "apply" : "unlist";
  const earlier = state.listingRequestUnknown(product.name, kind);
  // Counted before it is sent: a crash from here on leaves it unknown.
  state.setListingRequestUnknown(product.name, kind, earlier + 1);
  try {
    const answer = await send();
    state.listingRequestAnswered(product.name, kind);
    return answer;
  } catch (error) {
    // mo's own refusal of this attempt: this attempt saved nothing.
    if (
      error instanceof MoApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      if (earlier === 0) {
        state.listingRequestAnswered(product.name, kind);
        throw new Stop(said(error));
      }
      state.setListingRequestUnknown(product.name, kind, earlier);
      throw new Stop(
        `${said(error)}\nThe request is still saved: an earlier attempt of it got no answer and may have reached mo, and this refusal says nothing about that one. Fix what mo names, then run the same command again to finish it. To drop it instead: product ${command} --name "${product.name}" --abandon`,
      );
    }
    throw new Stop(
      `${said(error)}\nThe request is saved. Run the same command again to send it again unchanged.`,
    );
  }
}
/** --abandon: drops a saved request the developer no longer wants finished. */
function abandon(
  state: State,
  product: Product,
  kind: "apply" | "unlist",
  io: ProductIo,
) {
  if (!state.listingRequest(product.name, kind)) {
    io.print("Nothing is saved to drop.");
    return;
  }
  state.listingRequestAnswered(product.name, kind);
  io.print(
    `Dropped the saved request. If it had reached mo, its effect stands: run product listing --name "${product.name}" to see how things are.`,
  );
}
/** What the developer needs to know, in their words. No ids they did not ask for. */
export function listingWords(name: string, view: ListingView) {
  const lines: string[] = [];
  if (view.suspended)
    lines.push(
      `mo's operator has suspended ${name}'s listing: ${view.suspendedReason ?? "no reason given"}. No application is accepted until it is lifted. The account, handle and chats are not affected.`,
    );
  if (view.listed)
    lines.push(
      view.shown
        ? `${name} is listed in the directory as @${view.handle}, since ${view.listedAt}.`
        : view.hiddenBecause === "name_changed"
          ? `${name} is listed but hidden: its name or your mo name changed since it was approved. Apply again with the same text to have the new name approved.`
          : `${name} is listed but hidden: your own mo account has no verified mobile number now. Verify one and it shows again.`,
    );
  else if (!view.suspended) lines.push(`${name} is not listed.`);
  const a = view.application;
  if (a && a.id !== view.listedApplicationId) {
    const reason = a.reason ? ` Reason: ${a.reason}` : "";
    if (a.state === "submitted")
      lines.push(
        `An application sent ${a.submittedAt} is waiting for mo's operator. Keep the product running: before approving, the operator writes to @${view.handle} and expects its reply.`,
      );
    else if (a.state === "needs_changes")
      lines.push(`The last application was sent back.${reason} Apply again.`);
    else if (a.state === "rejected")
      lines.push(`The last application was rejected.${reason}`);
    else if (a.state === "withdrawn")
      lines.push("The last application was withdrawn.");
  }
  return lines.join("\n");
}

async function create(
  state: State,
  flags: Flags,
  runtime: string,
  io: ProductIo,
) {
  const name = need(flags, "name").trim();
  let product = state.product(name);
  if (!product) {
    const developer = developerOf(state, flags);
    const slug = flags["runtime-profile"] || slugOf(name);
    if (!profileName.test(slug))
      throw new Stop(
        "Give the runtime profile a name with --runtime-profile (lower-case letters, digits, - and _).",
      );
    if (state.productBySlug(slug))
      throw new Stop(
        `Another product here already uses the profile name ${slug}. Choose one with --runtime-profile.`,
      );
    const request: CreateRequest = {
      operationId: randomUUID(),
      displayName: name,
      credential: { ...newKey(), label: "Product control" },
      renewalKey: newKey(),
      recoverySecret: newSecret(),
    };
    // Saved before it is sent. From here on only this request is ever sent.
    state.createProduct({
      name,
      slug,
      developer: developer.name,
      server: developer.server,
      developerAccount: developer.account_id!,
      request,
    });
    product = state.product(name)!;
  }
  if (product.state === "creating") {
    // Resumed only as the same developer account on the same server.
    const developer = state.profile(product.developer);
    if (
      !developer ||
      developer.state !== "active" ||
      developer.server !== product.server ||
      developer.account_id !== product.developer_account
    )
      throw new Stop(
        `The saved creation of ${name} was made as profile ${product.developer} on ${product.server}, and that profile is not the same here now. Nothing was sent and nothing was created again. Join that same account again under that profile name, then run the same command.`,
      );
    let answer;
    try {
      answer = await as(state, developer.name).withAccess((token) =>
        new MoApi(product!.server).createAgentAccount(
          token,
          JSON.parse(product!.request) as CreateRequest,
        ),
      );
    } catch (error) {
      if (error instanceof MoApiError && error.code === "operation_conflict")
        throw new Stop(
          `mo answered operation_conflict to the saved creation of ${name}, and no control profile for it is saved here. Nothing was created again, and the saved request is kept. Check your account's activity in a mo client for an agent account named ${name} before doing anything else.`,
        );
      throw new Stop(
        `${said(error)}\nThe saved creation of ${name} is kept. Run the same command again to send it again unchanged; it never makes a second product.`,
      );
    }
    state.productCreated(name, {
      agentAccountId: answer.agentAccountId,
      connectionId: answer.session.credential.connectionId,
      accessExpires: answer.session.credential.expiresAt,
    });
    product = state.product(name)!;
    io.print(
      `Created ${name}. Its control keys and recovery secret are saved in the control folder.`,
    );
  } else io.print(`${name} is already created.`);

  if ("no-join" in flags) {
    io.print(
      `Not joined here. Run: product join-code --name "${name}", then join on the machine that runs it.`,
    );
    return;
  }
  if (product.runtime_joined) {
    io.print(`Runtime profile ${product.slug} is already joined.`);
    return;
  }
  const folder = openFolder(runtime, "runtime");
  try {
    const saved = folder.profile(product.slug);
    if (saved && saved.state !== "joining") {
      if (saved.account_id !== product.agent_account_id)
        throw new Stop(
          `The runtime folder already has a profile named ${product.slug} for another account. Use product join-code and join under another profile name.`,
        );
    } else {
      const control = as(state, controlProfile(product.slug));
      await joinProfile(folder, {
        name: product.slug,
        server: () => product!.server,
        label: "Developer connector",
        // Bound to this product: an unrelated unfinished join saved under
        // the same name is refused, never sent or adopted.
        expectAccount: product.agent_account_id!,
        // Only asked for when no join is saved: a saved one is sent again.
        joinCode: async () => {
          try {
            return (
              await control.withAccess((token) =>
                new MoApi(product!.server).joinCode(token, "agent"),
              )
            ).inviteCode;
          } catch (error) {
            throw new Stop(
              `${said(error)}\n${name} exists. Run the same command again to join its runtime profile.`,
            );
          }
        },
      });
    }
    state.productRuntimeJoined(name);
    io.print(`Joined runtime profile ${product.slug}. Start it with: run`);
  } finally {
    folder.close();
  }
}

export async function productCommand(
  rest: string[],
  flags: Flags,
  folders: { runtime: string; control: string },
  io: ProductIo,
) {
  const [command, action] = rest;
  const state = openFolder(folders.control, "control");
  try {
    const api = (product: Product) => new MoApi(product.server);
    /** A call with the developer's own key, saved and shown as mo answered. */
    const manage = async (
      product: Product,
      call: (token: string) => Promise<{
        handle: string | null;
        number: { value: string; verified: boolean } | null;
      }>,
    ) => {
      try {
        const view = await as(state, product.developer).withAccess(call);
        state.productView(product.name, {
          handle: view.handle,
          number: view.number,
        });
        return view;
      } catch (error) {
        throw new Stop(said(error));
      }
    };
    switch (command) {
      case "create":
        return await create(state, flags, folders.runtime, io);
      case "join-code": {
        const { product } = created(state, flags);
        let code;
        try {
          code = await as(state, controlProfile(product.slug)).withAccess(
            (token) => api(product).joinCode(token, "agent"),
          );
        } catch (error) {
          throw new Stop(said(error));
        }
        // The code alone on standard output, so it can be piped to `join`.
        io.print(code.inviteCode);
        console.error(
          `Works once, until ${code.expiresAt}. On the runtime machine: join --profile ${product.slug} --server ${product.server}`,
        );
        return;
      }
      case "handle": {
        const { product, agent } = created(state, flags);
        const handle = action ?? "";
        if (!handle) throw new Stop("Give the handle, such as acme-travel.");
        const view = await manage(product, (token) =>
          api(product).setAgentHandle(token, agent, handle),
        );
        io.print(`Handle: @${view.handle}. It cannot be changed.`);
        return;
      }
      case "number": {
        const { product, agent } = created(state, flags);
        if (action === "add") {
          const phone = await io.line("The product's number: ");
          if (!phone) throw new Stop("No number was given.");
          const sent = await manage(product, (token) =>
            api(product).addAgentNumber(token, agent, phone),
          );
          io.print(
            `mo texted a code to that number. It works until ${(sent as { expiresAt?: string }).expiresAt}. Then: product number verify --name "${product.name}"`,
          );
        } else if (action === "verify") {
          const code = await io.line("Code: ");
          if (!code) throw new Stop("No code was given.");
          await manage(product, (token) =>
            api(product).verifyAgentNumber(token, agent, code),
          );
          io.print(
            "Verified. People who already have the number can now find the product by it.",
          );
        } else if (action === "remove") {
          await manage(product, (token) =>
            api(product).removeAgentNumber(token, agent),
          );
          io.print("The product has no number now.");
        } else throw new Stop("Use: product number add | verify | remove");
        return;
      }
      case "apply": {
        const { product, agent } = created(state, flags);
        if ("abandon" in flags) return abandon(state, product, "apply", io);
        const developer = as(state, product.developer);
        const typed =
          flags.description !== undefined ||
          flags["what-it-does"] !== undefined ||
          flags.support !== undefined;
        // Text as mo stores it, so the same text is the same however typed.
        const text = () => ({
          description: need(flags, "description").trim(),
          whatItDoes: need(flags, "what-it-does").trim(),
          supportContact: need(flags, "support").trim(),
        });
        const send = (request: ApplyRequest) =>
          finish(state, product, "apply", () =>
            developer.withAccess((token) =>
              api(product).applyAgentListing(token, agent, request),
            ),
          );
        // An application whose answer never arrived is finished first, as
        // it was saved: the same id and text, whatever has happened to it
        // since. It is never replaced by a new one.
        const saved = state.listingRequest<ApplyRequest>(product.name, "apply");
        if (saved) {
          if (typed) {
            const now = text();
            if (
              now.description !== saved.description ||
              now.whatItDoes !== saved.whatItDoes ||
              now.supportContact !== saved.supportContact
            )
              throw new Stop(
                `Nothing was sent. An earlier application for ${product.name} was sent and its answer never arrived. Finish that one first: product apply --name "${product.name}" (no text needed). Then apply with the new text.`,
              );
          }
          io.print(listingWords(product.name, await send(saved)));
          return;
        }
        const wanted = text();
        if (!("public" in flags))
          throw new Stop(
            `Nothing was sent. Once mo's operator approves this, these become public, to everyone on mo and on mo's public web page, where search engines may index them: the name ${product.name}, its handle, the description, the what-it-does text, the support contact, and your own mo account name. Never the product's number. If that is right, run the same command again with --public.`,
          );
        let before: ListingView;
        try {
          before = await developer.withAccess((token) =>
            api(product).agentListing(token, agent),
          );
        } catch (error) {
          throw new Stop(`${said(error)}\nNothing was sent.`);
        }
        const waiting = before.application;
        if (
          waiting?.state === "submitted" &&
          waiting.description === wanted.description &&
          waiting.whatItDoes === wanted.whatItDoes &&
          waiting.supportContact === wanted.supportContact
        ) {
          // Already waiting with this exact text: nothing to send.
          io.print(listingWords(product.name, before));
          return;
        }
        // A new application: its id is chosen once and saved with the exact
        // request before it is sent.
        const request = { applicationId: randomUUID(), ...wanted };
        state.saveListingRequest(product.name, "apply", request);
        io.print(listingWords(product.name, await send(request)));
        return;
      }
      case "listing": {
        const { product, agent } = created(state, flags);
        let view: ListingView;
        try {
          view = await as(state, product.developer).withAccess((token) =>
            api(product).agentListing(token, agent),
          );
        } catch (error) {
          throw new Stop(said(error));
        }
        io.print(listingWords(product.name, view));
        return;
      }
      case "unlist": {
        // Takes down the listing and withdraws a waiting application: the
        // ones the view showed when the command was first run, named by id
        // and saved before sending. A run after a lost answer sends those
        // same ids, so anything listed or sent since is untouched.
        const { product, agent } = created(state, flags);
        if ("abandon" in flags) return abandon(state, product, "unlist", io);
        const developer = as(state, product.developer);
        const send = (request: UnlistRequest) =>
          finish(state, product, "unlist", () =>
            developer.withAccess((token) =>
              api(product).withdrawAgentListing(token, agent, request),
            ),
          );
        const saved = state.listingRequest<UnlistRequest>(
          product.name,
          "unlist",
        );
        if (saved) {
          const after = await send(saved);
          io.print(
            `Finished the earlier unlist, whose answer had not arrived. Anything listed or sent since then was not touched.\n${listingWords(product.name, after)}`,
          );
          return;
        }
        let view: ListingView;
        try {
          view = await developer.withAccess((token) =>
            api(product).agentListing(token, agent),
          );
        } catch (error) {
          throw new Stop(`${said(error)}\nNothing was sent.`);
        }
        const request: UnlistRequest = {
          ...(view.listingId ? { listingId: view.listingId } : {}),
          ...(view.application?.state === "submitted"
            ? { applicationId: view.application.id }
            : {}),
        };
        if (!request.listingId && !request.applicationId) {
          io.print(
            `${product.name} is not listed and has no application waiting.`,
          );
          return;
        }
        state.saveListingRequest(product.name, "unlist", request);
        io.print(listingWords(product.name, await send(request)));
        return;
      }
      case "remove-runtime": {
        // For a lost runtime machine: every agent connection on the product
        // goes, from the control folder. The control connection stays.
        const { product } = created(state, flags);
        const control = as(state, controlProfile(product.slug));
        let removed = 0;
        try {
          const { credentials } = await control.withAccess((token) =>
            api(product).connections(token),
          );
          for (const credential of credentials)
            if (credential.role === "agent" && !credential.revokedAt) {
              await control.withAccess((token) =>
                api(product).removeConnection(token, credential.id),
              );
              removed++;
            }
        } catch (error) {
          throw new Stop(
            `${said(error)}\n${removed} removed so far. Run the same command again.`,
          );
        }
        state.productRuntimeRemoved(product.name);
        io.print(
          `Removed ${removed} runtime connection${removed === 1 ? "" : "s"}. Join a new one with product join-code.`,
        );
        return;
      }
      case "status": {
        const products = [];
        for (const product of state.products()) {
          let connections: unknown = "not read";
          if (product.state === "created")
            try {
              connections = (
                await as(state, controlProfile(product.slug)).withAccess(
                  (token) => api(product).connections(token),
                )
              ).credentials.map((c) => ({
                connectionId: c.connectionId,
                label: c.label,
                role: c.role,
                wakeRoute: c.wakeRoute,
              }));
            } catch (error) {
              connections = `not read: ${said(error)}`;
            }
          // The handle and the listing can be set in mo's web app, which
          // this folder never hears about. Read them from mo with your own
          // profile; where that profile may not, say so instead of printing
          // what was saved here as if it were current.
          const shown = show(state.product(product.name)!);
          let handle: string | null = shown.handle,
            handleRead = "read from mo now";
          if (product.state === "created" && product.agent_account_id)
            try {
              handle = (
                await as(state, product.developer).withAccess((token) =>
                  api(product).agentListing(token, product.agent_account_id!),
                )
              ).handle;
            } catch (error) {
              const why =
                error instanceof MoApiError && error.code === "owner_required"
                  ? `your own profile here has agent access, so this command cannot read it. mo's web app shows it under "You & your agents"`
                  : said(error);
              // A handle never changes, so one saved here is still right.
              if (shown.handle)
                handleRead = `saved here when it was set; not read from mo now: ${why}`;
              else {
                handle = "not known here";
                handleRead = `not read from mo: ${why}`;
              }
            }
          else handleRead = "the product is not created yet";
          products.push({ ...shown, handle, handleRead, connections });
        }
        io.print(JSON.stringify({ products }, null, 2));
        return;
      }
      default:
        throw new Stop(
          "Use: product create | join-code | handle | number add|verify|remove | apply | listing | unlist | remove-runtime | status",
        );
    }
  } finally {
    state.close();
  }
}
