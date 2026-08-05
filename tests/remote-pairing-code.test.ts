import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { deriveRemotePairingCode } from "../desktop/src/remote-access.js";
import { assertPairingRelay, pairingCodeForKeys } from "../services/bridge/public/pairing-code.js";

const signingPublicJwk = {
  kty: "EC", crv: "P-256", use: "sig",
  x: "xEkeDeRgxDVFaj_PB7QX1eF5DT94ETgJA4N5bPNhIno",
  y: "GveHxVX5FBYWxKmO_riBPgetQ8bxxXEpYM1m353Bb3c",
};
const encryptionPublicJwk = {
  kty: "EC", crv: "P-256", use: "enc",
  x: "GmmMwHR9tTlnVdnPz3InF4Lx-Mj3otTYx8PXttps3oc",
  y: "UPGztQbOksSf3T7QrxgYFibxB2ZOCCjIqdvbPy3ks4E",
};
const alternateEncryptionPublicJwk = {
  kty: "EC", crv: "P-256", use: "enc",
  x: "Gww7OYN9xo4od3Hm04wcifhvwf8R5m1ryJAClc_IrtE",
  y: "JbGvE8li4d1A37YEsDpyBLsh-C7zYkgKNGFeou1WxOE",
};

const pairingInput = {
  pairingId: "pairing-123",
  browserId: "browser-456",
  signingPublicJwk,
  encryptionPublicJwk,
};

test("browser and desktop pairing commitments share one deterministic vector", async () => {
  const browserCode = await pairingCodeForKeys(pairingInput);
  const desktopCode = deriveRemotePairingCode(pairingInput);

  assert.equal(browserCode, "010833");
  assert.equal(desktopCode, browserCode);
  assert.match(browserCode, /^\d{6}$/);
});

test("pairing commitment changes with the browser key, browser id, and browser nonce", async () => {
  const original = await pairingCodeForKeys(pairingInput);
  const alternatives = await Promise.all([
    pairingCodeForKeys({ ...pairingInput, encryptionPublicJwk: alternateEncryptionPublicJwk }),
    pairingCodeForKeys({ ...pairingInput, pairingId: "pairing-124" }),
    pairingCodeForKeys({ ...pairingInput, browserId: "browser-457" }),
  ]);

  assert.deepEqual(alternatives, ["850799", "081672", "506123"]);
  for (const alternative of alternatives) assert.notEqual(alternative, original);
});

test("pairing commitment rejects malformed or mislabeled P-256 keys", async () => {
  const zeroCoordinate = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  await assert.rejects(() => pairingCodeForKeys({
    ...pairingInput,
    signingPublicJwk: { ...signingPublicJwk, use: "enc" },
  }), /invalid/i);
  await assert.rejects(() => pairingCodeForKeys({
    ...pairingInput,
    encryptionPublicJwk: { ...encryptionPublicJwk, x: `${encryptionPublicJwk.x}=` },
  }), /invalid/i);
  assert.throws(() => deriveRemotePairingCode({
    ...pairingInput,
    encryptionPublicJwk: { ...encryptionPublicJwk, x: `${encryptionPublicJwk.x}=` },
  }), /invalid/i);
  await assert.rejects(() => pairingCodeForKeys({
    ...pairingInput,
    signingPublicJwk: { ...signingPublicJwk, x: zeroCoordinate, y: zeroCoordinate },
  }), /invalid/i);
  assert.throws(() => deriveRemotePairingCode({
    ...pairingInput,
    signingPublicJwk: { ...signingPublicJwk, x: zeroCoordinate, y: zeroCoordinate },
  }), /invalid/i);
});

test("browser relay validation rejects pairing id, browser id, and code substitution", () => {
  const pairing = { id: pairingInput.pairingId, browserId: pairingInput.browserId, code: "010833" };
  const expected = { pairingId: pairingInput.pairingId, browserId: pairingInput.browserId, expectedCode: "010833" };
  assert.doesNotThrow(() => assertPairingRelay(pairing, expected));

  assert.throws(() => assertPairingRelay({ ...pairing, id: "bridge-chosen" }, expected), /did not match/i);
  assert.throws(() => assertPairingRelay({ ...pairing, browserId: "substituted-browser" }, expected), /did not match/i);
  assert.throws(() => assertPairingRelay({ ...pairing, code: "999999" }, expected), /did not match/i);
});

test("browser pairing flow keeps its local commitment authoritative through polling and approval", async () => {
  const app = await readFile(new URL("../services/bridge/public/app.js", import.meta.url), "utf8");
  assert.match(app, /const pairingId = crypto\.randomUUID\(\)/);
  assert.match(app, /body:\s*\{\s*pairingId,/);
  assert.match(app, /pairingExpectedCode: null/);
  assert.match(app, /pollPairing\(pairingId, expectedCode\)/);
  assert.match(app, /assertPairingRelay\(result\.pairing, \{ pairingId, browserId: state\.identity\.browserId, expectedCode \}\)/);
  assert.match(app, /certificate\.pairingCode !== expectedCode/);
  assert.match(app, /const certificateCode = await pairingCodeForKeys/);
  assert.match(app, /certificateCode !== expectedCode/);
  assert.doesNotMatch(app, /pairing-code[^\n]*state\.pairing\?\.code/);
});
