// Joining an account with a join code: the one path `join`, `join --control`
// and `product create` all use. The request is saved before it is sent.
import { randomBytes } from "node:crypto";
import { MoApi, MoApiError, newKey } from "./mo-api.js";
import type { State } from "./state.js";

/** A command ends here with these words for the person. */
export class Stop extends Error {}

export const profileName = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const whsec = () => `whsec_${randomBytes(32).toString("base64")}`;

/**
 * Joins `name`, or resends a join saved earlier under that name. `joinCode`
 * is only asked for when nothing is saved. Returns the role mo gave.
 */
export async function joinProfile(
  state: State,
  input: {
    name: string;
    server: () => string;
    label: string;
    joinCode: () => Promise<string>;
    /**
     * The one account this join is for (a product's runtime join). A saved
     * join under this name is sent again only if it was saved for that same
     * account on the same server, and the answer must be that account with
     * the agent role before the profile becomes active.
     */
    expectAccount?: string;
  },
) {
  const { name } = input;
  if (!profileName.test(name))
    throw new Stop("A profile name is lower-case letters, digits, - and _.");
  let profile = state.profile(name);
  if (profile && profile.state !== "joining")
    throw new Stop(`Profile ${name} already exists (${profile.state}).`);
  if (
    profile &&
    input.expectAccount !== undefined &&
    (profile.account_id !== input.expectAccount ||
      profile.server !== new MoApi(input.server()).server)
  )
    throw new Stop(
      `This folder has an unfinished join saved under the profile name ${name}, and it was not made for this product. Nothing was sent and it was not changed. Finish or remove that join first, or use product join-code and join under another profile name.`,
    );
  if (!profile) {
    const api = new MoApi(input.server());
    const joinCode = await input.joinCode();
    if (!joinCode) throw new Stop("No join code was given.");
    // Saved before the code is sent: new keys this connector made, the code,
    // and the secret for signed calls. After a lost answer the same command
    // is run again and sends exactly the same request.
    state.createProfile({
      name,
      server: api.server,
      label: input.label,
      keys: {
        credential: { ...newKey(), label: input.label },
        renewalKey: newKey(),
      },
      joinCode,
      ...(input.expectAccount === undefined
        ? {}
        : { expectAccount: input.expectAccount }),
      routeToken: randomBytes(24).toString("base64url"),
      signingSecret: whsec(),
    });
    profile = state.profile(name)!;
  }
  try {
    const session = await new MoApi(profile.server).redeemJoinCode(
      profile.join_code!,
      {
        credential: {
          id: profile.access_id,
          secret: profile.access_secret,
          label: profile.label,
        },
        renewalKey: {
          id: profile.renewal_id,
          secret: profile.renewal_secret,
        },
      },
    );
    // A join saved for one account becomes active only as that account,
    // with the agent role.
    if (
      profile.account_id &&
      (session.account.id !== profile.account_id ||
        session.credential.role !== "agent")
    ) {
      state.removeProfile(name);
      throw new Stop(
        `mo answered the join for ${name} with a different account or role than the product it was made for. The profile was not saved and nothing runs as it. Remove that connection in a mo client, then run the same command again.`,
      );
    }
    state.joined(name, {
      accountId: session.account.id,
      connectionId: session.credential.connectionId,
      accessExpires: session.credential.expiresAt,
    });
    return { role: session.credential.role, accountId: session.account.id };
  } catch (error) {
    if (error instanceof Stop) throw error;
    if (error instanceof MoApiError) {
      // A refusal is final for this code: nothing is kept.
      state.removeProfile(name);
      throw new Stop(
        `mo refused the join code (${error.code}). ${error.nextAction}`,
      );
    }
    throw new Stop(
      "mo did not answer. Run the same command again; the saved request is sent unchanged.",
    );
  }
}
