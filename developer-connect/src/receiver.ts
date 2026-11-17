// The address mo calls: POST /mo/events/<route token>.
//
// A call is a hint with no message in it. This handler makes no network
// call: it checks the signature, saves that the call happened, and answers.
// The work is fetched afterwards by the profile's worker.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { verifyCall } from "./signature.js";
import type { State } from "./state.js";
import type { Log } from "./worker.js";

const BODY_LIMIT = 64 * 1024;

function rawBody(request: IncomingMessage) {
  return new Promise<Buffer | null>((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        done(null);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => done(Buffer.concat(chunks)));
    request.on("error", () => done(null));
  });
}

export function createReceiver(
  state: State,
  wake: (profile: string) => void,
  log: Log,
): Server {
  return createServer(async (request, response) => {
    const answer = (status: number, body: unknown = {}) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const route = /^\/mo\/events\/([A-Za-z0-9_-]{20,100})$/.exec(
        request.url ?? "",
      );
      if (request.method !== "POST" || !route) return answer(404);
      // The random token in the path picks the profile. Nothing else does:
      // x-mcp-subscription-id is not covered by the signature and is never
      // read here.
      const subscription = state.subscriptionByRoute(route[1]!);
      if (!subscription) return answer(404);
      const raw = await rawBody(request);
      if (!raw) return answer(413);
      // The signature is checked over the raw bytes, with this profile's own
      // secret (and its candidate while the secret is being changed). A call
      // signed for another profile fails here.
      const checked = verifyCall(
        raw,
        request.headers,
        [subscription.secret, subscription.candidate_secret].filter(
          (secret): secret is string => !!secret,
        ),
      );
      if (!checked.ok) {
        log("call_refused", {
          profile: subscription.profile,
          reason: checked.reason,
        });
        return answer(401);
      }
      let body: {
        type?: unknown;
        challenge?: unknown;
        name?: unknown;
        cursor?: unknown;
        data?: { feedSeq?: unknown };
      };
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return answer(400);
      }
      if (body.type === "verification")
        return answer(200, { challenge: String(body.challenge ?? "") });
      // Saved before the 200: one transaction records the event, ignoring a
      // repeat of the same id, and counts a new one. If the save fails mo
      // gets a 500 and tries again.
      const fresh = state.acceptEvent(
        subscription.profile,
        {
          id: checked.id,
          name: String(body.name ?? ""),
          ...(typeof body.cursor === "string" &&
          Number.isInteger(body.data?.feedSeq)
            ? { cursor: body.cursor, feedSeq: body.data!.feedSeq as number }
            : {}),
        },
        Date.now(),
      );
      if (fresh) wake(subscription.profile);
      // Logged after the save and before the 200. No content: a call has none.
      log("call_saved", { profile: subscription.profile, repeat: !fresh });
      answer(200);
    } catch {
      log("call_failed");
      if (!response.headersSent) answer(500);
    }
  });
}
