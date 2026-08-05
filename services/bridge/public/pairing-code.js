const encoder = new TextEncoder();
const pairingCodeDomain = "work-fold.pairing-code.v1";
const stableIdPattern = /^[A-Za-z0-9._:-]+$/;

/**
 * Produce the short authentication string shown independently by the browser
 * and desktop. The hosted bridge relays the browser-contributed pairing id and
 * public keys, but it does not get to choose a code that hides a substitution.
 */
export async function pairingCodeForKeys({
  pairingId,
  browserId,
  signingPublicJwk,
  encryptionPublicJwk,
}) {
  const validatedPairingId = stableId(pairingId, "pairing id");
  const validatedBrowserId = stableId(browserId, "browser id");
  const commitment = JSON.stringify([
    pairingCodeDomain,
    validatedPairingId,
    validatedBrowserId,
    await pairingKeyFields(signingPublicJwk, "sig", "ECDSA"),
    await pairingKeyFields(encryptionPublicJwk, "enc", "ECDH"),
  ]);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(commitment)));
  const prefix = digest[0] * 0x1000000 + digest[1] * 0x10000 + digest[2] * 0x100 + digest[3];
  return String(prefix % 1_000_000).padStart(6, "0");
}

/**
 * Check every relay refresh against the browser's original locally-derived
 * commitment. Poll responses are not allowed to replace this expected value.
 */
export function assertPairingRelay(pairing, { pairingId, browserId, expectedCode }) {
  if (!pairing || typeof pairing !== "object" || Array.isArray(pairing)
    || pairing.id !== pairingId || pairing.browserId !== browserId
    || pairing.code !== expectedCode) {
    throw new Error("The bridge pairing did not match this browser.");
  }
}

async function pairingKeyFields(value, expectedUse, algorithm) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.kty !== "EC" || value.crv !== "P-256" || value.d !== undefined
    || (value.use !== undefined && value.use !== expectedUse)) {
    throw new Error("Pairing public key is invalid.");
  }
  const x = p256Coordinate(value.x);
  const y = p256Coordinate(value.y);
  try {
    await globalThis.crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x, y },
      { name: algorithm, namedCurve: "P-256" },
      false,
      algorithm === "ECDSA" ? ["verify"] : [],
    );
  } catch {
    throw new Error("Pairing public key is invalid.");
  }
  return [expectedUse, "P-256", x, y];
}

function stableId(value, label) {
  if (typeof value !== "string" || !value || value.length > 160 || !stableIdPattern.test(value)) {
    throw new Error(`A valid ${label} is required.`);
  }
  return value;
}

function p256Coordinate(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("Pairing public key is invalid.");
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const binary = atob(padded);
    if (binary.length !== 32) throw new Error("invalid coordinate");
    const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (canonical !== value) throw new Error("non-canonical coordinate");
    return value;
  } catch {
    throw new Error("Pairing public key is invalid.");
  }
}
