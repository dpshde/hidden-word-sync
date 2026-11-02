// Writes test/vectors.json: fixed inputs and the outputs any implementation must reproduce.
// Raw key material comes from node:crypto, everything else from the reference client.
import { hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { deriveKeys, encryptRecord, formatKey, itemId, prfSalt, hex, b64url } from "../public/sync.js";

const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const prf = new Uint8Array(32).fill(0x11);
const nonce = Uint8Array.from({ length: 12 }, (_, i) => i);
const record = { kind: "highlight", ref: "JHN.3.16", updated: 1793000000, highlights: [{ color: "yellow", created: 1792000000 }] };
const raw = (ikm: Uint8Array, info: string, n: number) => new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), info, n));

const keys = await deriveKeys(key);
const vectors = {
  key: hex(key),
  keyText: await formatKey(key),
  lib: keys.lib,
  auth: keys.auth,
  enc: hex(raw(key, "hidden-word/v1/enc", 32)),
  mac: hex(raw(key, "hidden-word/v1/mac", 32)),
  item: { kind: "highlight", ref: "JHN.3.16", id: await itemId(keys, "highlight", "JHN.3.16") },
  blob: { nonce: hex(nonce), record, ...(await encryptRecord(keys, record, nonce)) },
  prfSalt: hex(await prfSalt()),
  slot: {
    prf: hex(prf),
    slot: hex(raw(prf, "hidden-word/v1/slot", 16)),
    auth: b64url(raw(prf, "hidden-word/v1/slot-auth", 32)),
    kek: hex(raw(prf, "hidden-word/v1/kek", 32)),
  },
};
writeFileSync(new URL("../test/vectors.json", import.meta.url), JSON.stringify(vectors, null, 2) + "\n");
console.log(JSON.stringify(vectors, null, 2));
