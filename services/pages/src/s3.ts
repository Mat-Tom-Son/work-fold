/**
 * A minimal S3 `PutObject` for backups (docs/pages.md, "Page service"):
 * AWS Signature Version 4 with `node:crypto`, no SDK. Railway storage
 * buckets are S3-compatible. The payload is signed (its SHA-256 is sent in
 * `x-amz-content-sha256`), and the file is streamed with a fixed length.
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface S3Settings {
  /** `https://host[:port]`; virtual-hosted requests put the bucket in front of the host. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (`endpoint/bucket/key`) instead of virtual-hosted (`bucket.endpoint/key`). */
  pathStyle: boolean;
}

export interface SigV4Input {
  method: string;
  /** The URI path, not yet encoded (S3 encodes it once). */
  path: string;
  query?: Record<string, string>;
  /** Every header to sign, including `host` and `x-amz-date`. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Result {
  authorization: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
}

/** Signs one request. `headers["x-amz-date"]` (`YYYYMMDDTHHMMSSZ`) sets the date and scope. */
export function signAwsV4(input: SigV4Input): SigV4Result {
  const headers = Object.entries(input.headers).map(([name, value]) => [name.trim().toLowerCase(), value.trim().replace(/\s+/gu, " ")] as const);
  headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const amzDate = headers.find(([name]) => name === "x-amz-date")?.[1];
  if (!amzDate || !/^\d{8}T\d{6}Z$/u.test(amzDate)) throw new Error("Signing needs an x-amz-date header.");
  const day = amzDate.slice(0, 8);
  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join("");
  const canonicalQuery = Object.entries(input.query ?? {})
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalPath = input.path.split("/").map(encodeRfc3986).join("/") || "/";
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  let key: Buffer = hmac(`AWS4${input.secretAccessKey}`, day);
  key = hmac(key, input.region);
  key = hmac(key, input.service);
  key = hmac(key, "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
  };
}

/** `YYYYMMDDTHHMMSSZ` for a date. */
export function amzDateOf(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

/** Where an object lives and the `host` to sign. */
export function s3ObjectUrl(settings: S3Settings, key: string): URL {
  const endpoint = new URL(settings.endpoint);
  const encodedKey = key.split("/").map(encodeRfc3986).join("/");
  if (settings.pathStyle) return new URL(`${endpoint.origin}/${encodeRfc3986(settings.bucket)}/${encodedKey}`);
  return new URL(`${endpoint.protocol}//${settings.bucket}.${endpoint.host}/${encodedKey}`);
}

/** Uploads a file to `key`. Throws with the status (never the response text) when the bucket refuses. */
export async function putObjectFile(settings: S3Settings, key: string, filePath: string, options: { now?: Date; contentType?: string; timeoutMs?: number } = {}): Promise<void> {
  const { size } = await stat(filePath);
  const payloadHash = await sha256File(filePath);
  const url = s3ObjectUrl(settings, key);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDateOf(options.now ?? new Date()),
  };
  const signed = signAwsV4({
    method: "PUT",
    path: decodeURIComponent(url.pathname),
    headers,
    payloadHash,
    region: settings.region,
    service: "s3",
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
  });
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = send(url, {
      method: "PUT",
      headers: {
        ...headers,
        authorization: signed.authorization,
        "content-length": String(size),
        "content-type": options.contentType ?? "application/octet-stream",
      },
      timeout: options.timeoutMs ?? 120_000,
    }, (res) => {
      res.resume();
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`The bucket refused the upload (${status}).`));
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("The upload timed out.")));
    req.on("error", reject);
    const file = createReadStream(filePath);
    file.on("error", (error) => req.destroy(error));
    file.pipe(req);
  });
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** RFC 3986 encoding: everything but `A–Z a–z 0–9 - . _ ~`. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
