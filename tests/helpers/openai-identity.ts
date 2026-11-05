import { createHash, generateKeyPairSync, sign } from "node:crypto";

/** Synthetic OIDC responses shaped like the privately captured direct grant. */
export function openAiIdentityFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "synthetic-signing-key", use: "sig", alg: "RS256" }] };
  const idToken = (claims: Record<string, unknown> = {}, access = "synthetic-access") => {
    const payload = {
      iss: "https://auth.openai.com", sub: "synthetic-person", aud: ["issued-client"],
      email: "person@example.test", email_verified: true,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
      at_hash: createHash("sha256").update(access).digest().subarray(0, 16).toString("base64url"), ...claims,
    };
    const input = [{ alg: "RS256", kid: "synthetic-signing-key" }, payload]
      .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };
  return { jwks, idToken };
}
