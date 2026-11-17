// Moving a file's parts between this machine and mo's private storage.
//
// mo never relays file bytes. It answers an upload or download request with a
// short-lived grant (`transfer`), and each part goes straight to storage under
// that grant. No mo key is sent to storage. Storage checks every part request
// against the account's current membership when it starts, so a removal stops
// the parts that have not started.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Transfer } from "./mo-api.js";

export type PartOutcome =
  | { state: "stored"; md5: string }
  | { state: "exists" }
  /** The grant ran out: ask mo for the upload or download again. */
  | { state: "expired" }
  /** Storage says this account may not: stop, do not retry. */
  | { state: "denied" }
  | { state: "failed"; status: number };

function partUrl(transfer: Transfer, index: number, read: boolean) {
  const base = new URL(transfer.url);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(local && base.protocol === "http:"))
    throw new Error("The storage address must be https.");
  const key = `${transfer.objectPrefix}/${index}`
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${base.toString().replace(/\/$/, "")}/object/${read ? "authenticated/" : ""}${encodeURIComponent(transfer.bucket)}/${key}`;
}
const headers = (transfer: Transfer, extra: Record<string, string>) => ({
  Authorization: `Bearer ${transfer.token}`,
  ...(transfer.apiKey ? { apikey: transfer.apiKey } : {}),
  ...extra,
});
export const partRange = (size: number, partSize: number, index: number) => {
  const start = index * partSize;
  return { start, end: Math.min(size, start + partSize) - 1 };
};

/**
 * Storage wraps most refusals in HTTP 400 with the real status in a JSON
 * body ({statusCode, error, message}); otherwise the HTTP status stands.
 */
async function refusal(response: Response): Promise<PartOutcome> {
  let body: { statusCode?: unknown; error?: unknown; message?: unknown } = {};
  try {
    const text = (await response.text()).slice(0, 16_384);
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    // Not JSON: the HTTP status stands.
  }
  const wrapped = Number(body.statusCode);
  const status =
    response.status === 400 && Number.isInteger(wrapped) && wrapped >= 400
      ? wrapped
      : response.status;
  const words = `${String(body.error ?? "")} ${String(body.message ?? "")}`;
  if (status === 409 || /KeyAlreadyExists|Duplicate/i.test(words))
    return { state: "exists" };
  if (status === 401 || /expired|"exp" claim/i.test(words))
    return { state: "expired" };
  if (status === 403 || status === 404) return { state: "denied" };
  return { state: "failed", status };
}

/** Send one part of a local file. Its MD5 is worked out on the way. */
export async function uploadPart(
  transfer: Transfer,
  index: number,
  file: { path: string; size: number; partSize: number },
  fetcher: typeof fetch = fetch,
): Promise<PartOutcome> {
  const { start, end } = partRange(file.size, file.partSize, index);
  const length = Math.max(0, end - start + 1);
  const hash = createHash("md5");
  const source = length
    ? createReadStream(file.path, { start, end })
    : Readable.from([]);
  let response: Response;
  try {
    response = await fetcher(partUrl(transfer, index, false), {
      method: "POST",
      headers: headers(transfer, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(length),
        // mo refuses a part that storage would let a cache keep.
        "Cache-Control": "no-store",
        "x-upsert": "false",
      }),
      body: Readable.toWeb(
        source.map((chunk: Buffer) => {
          hash.update(chunk);
          return chunk;
        }),
      ) as ReadableStream,
      duplex: "half",
      redirect: "error",
      signal: AbortSignal.timeout(600_000),
    } as RequestInit);
  } catch {
    return { state: "failed", status: 0 };
  }
  if (response.status !== 200) return refusal(response);
  void response.body?.cancel().catch(() => {});
  return { state: "stored", md5: hash.digest("hex") };
}

/**
 * Fetch one part into an open file at its own offset, and check it against
 * the size and MD5 mo listed for it.
 */
export async function downloadPart(
  transfer: Transfer,
  part: { index: number; size: number; md5: string },
  file: { size: number; partSize: number },
  destination: FileHandle,
  fetcher: typeof fetch = fetch,
): Promise<PartOutcome> {
  if (part.size === 0) return { state: "stored", md5: part.md5 };
  let response: Response;
  try {
    response = await fetcher(partUrl(transfer, part.index, true), {
      method: "GET",
      headers: headers(transfer, { "Cache-Control": "no-cache" }),
      redirect: "error",
      signal: AbortSignal.timeout(600_000),
    });
  } catch {
    return { state: "failed", status: 0 };
  }
  if (response.status !== 200 || !response.body) return refusal(response);
  const hash = createHash("md5");
  let position = partRange(file.size, file.partSize, part.index).start;
  let written = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const bytes = chunk as Buffer;
      if (bytes.length > part.size - written) throw new Error("too_large");
      hash.update(bytes);
      await destination.write(bytes, 0, bytes.length, position);
      position += bytes.length;
      written += bytes.length;
    }
  } catch {
    return { state: "failed", status: 0 };
  }
  const md5 = hash.digest("hex");
  return written === part.size && md5 === part.md5
    ? { state: "stored", md5 }
    : { state: "failed", status: 0 };
}

/** SHA-256 of a whole file, streamed: mo asks for it when an upload starts. */
export async function fileSha256(path: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
