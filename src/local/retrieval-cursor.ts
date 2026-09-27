import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Cursors hold positions, never authority. Scope and source identities are
// checked by each reader. Restart invalidates them explicitly rather than
// silently restarting a partial search.
import { deflateRawSync, inflateRawSync } from "node:zlib";

const key = randomBytes(32);
export function encodeRetrievalCursor(value: unknown): string {
  const data = deflateRawSync(Buffer.from(JSON.stringify(value))).toString("base64url");
  return `${data}.${createHmac("sha256", key).update(data).digest("base64url")}`;
}
export function decodeRetrievalCursor<T>(cursor: string): T {
  try {
    if (typeof cursor !== "string" || cursor.length > 128 * 1024) throw new Error();
    const [data, signature, extra] = cursor.split(".");
    if (!data || !signature || extra) throw new Error();
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", key).update(data).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    return JSON.parse(inflateRawSync(Buffer.from(data, "base64url"), { maxOutputLength: 1024 * 1024 }).toString("utf8")) as T;
  } catch { throw retrievalError("This continuation cursor is invalid or expired. Start the retrieval again.", 409); }
}
export function retrievalError(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { status: statusCode, statusCode });
}
