# Quick start: sync with a Selah Vault server

Five steps from a sync key to a synced highlight, using the test-vector key from [SPEC.md section 10](../SPEC.md#10-test-vectors). Every value below is real: check your code against it.

The test-vector key is public, so anyone can read or erase its library. Use it only against a local server (`bun run dev`, then `http://localhost:8787`), never for real highlights. The hosted server is `https://vault.selah.tools`: point your app there once these steps work against your local one.

## 1. Parse the key

[SPEC 5.1](../SPEC.md#51-the-sync-key). The text `000G-40R4-0M30-E209-185G-R38E-1YZ0` is Crockford base32 of 16 key bytes plus a check byte. Accept any case, ignore dashes and spaces, read `O` as `0` and `I`/`L` as `1`, and reject a key whose check byte (the first byte of SHA-256 of the key) doesn't match.

```
key = 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f
```

## 2. Derive the library id, token and keys

[SPEC 5.2](../SPEC.md#52-derived-values). HKDF-SHA256, empty salt, from the 16 key bytes:

```
lib  = hex(HKDF(key, "hidden-word/v1/lib", 16))        = 2f4856b70a85a635e64ca60c047e27fb
auth = base64url(HKDF(key, "hidden-word/v1/auth", 32)) = fCuKEYwQJkKHQKEupTVwTYeowChbJzSwgT5iyBG-CJI
enc  = HKDF(key, "hidden-word/v1/enc", 32)             AES-256-GCM key
mac  = HKDF(key, "hidden-word/v1/mac", 32)             HMAC-SHA256 key
```

## 3. Make an item

[SPEC 5.3](../SPEC.md#53-items). For the record

```json
{"kind":"highlight","ref":"JHN.3.16","updated":1793000000,"highlights":[{"color":"yellow","created":1792000000}]}
```

- `id` = base64url(HMAC-SHA256(mac, "highlight JHN.3.16")), first 22 characters: `cq_pOilWI_5HRaH6ll9W2d`.
- `blob` = base64url(nonce ‖ AES-256-GCM(enc, nonce, plaintext, aad = id)), where the plaintext is the JSON padded with spaces to 256 bytes. With the fixed nonce `000102030405060708090a0b` from `test/vectors.json` you get exactly its `blob`. Real clients use 12 fresh random bytes every time.

## 4. Push

[SPEC 5.4](../SPEC.md#54-routes). The first write claims the library for this token.

```sh
S=http://localhost:8787
LIB=2f4856b70a85a635e64ca60c047e27fb
TOKEN=fCuKEYwQJkKHQKEupTVwTYeowChbJzSwgT5iyBG-CJI

curl -s -X POST $S/v1/lib/$LIB -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"items":[{"id":"cq_pOilWI_5HRaH6ll9W2d","blob":"AAECAwQFBgcICQoLq8SFwYE8sb0Q7Nvj0LOe6lpQU5r-sMxoBjyo4EP05KSuW7lN79F32bdn56D8EI6iKnaePNLsnxzid7fKUGOpfZj3sFrmQjSdPoLtPeZuBPTPkoPjGnFYloQ4bWNIzu5XtH1NRhcrxGcWHplpjj9yfs6ReI6P7PGUUNUiImUrSskqfI1GJ0vLEVI-puqVYS-90vel6nLEeWTQt-NtECi4kTBs5trpW4Jk4XEpXDi3LePDSOgRuKCRdYWoa-ex8xIGmroNWKFyMhN1M4ngPeikW99IPDk0NOH1wzEaR-KC-CyCflE-P7Dgw3a6BNwzJp3y4twt8SaCmBEDle1zni80Tdr7tecLTIweeXP8LioMAAI"}]}'
```

```json
{"seq":1,"epoch":"198398cd159821b83ab1a49e"}
```

The epoch is random; yours will differ. Remember it with the `seq`.

## 5. Pull and merge

```sh
curl -s "$S/v1/lib/$LIB?after=0" -H "authorization: Bearer $TOKEN"
```

```json
{"items":[{"seq":1,"id":"cq_pOilWI_5HRaH6ll9W2d","blob":"AAECAwQFBgcICQoL…"}],"more":false,"seq":1,"epoch":"198398cd159821b83ab1a49e"}
```

For each item: decrypt it, strip the trailing spaces, parse the JSON, check that `id` is the item id of its `kind` and `ref` (skip it if not), and keep it only if it wins against your copy by [the merge rule](../SPEC.md#3-merging). Move your cursor to the last `seq`, and ask again while `more` is true.

Errors look like this:

```sh
curl -s $S/v1/lib/$LIB -H "authorization: Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
```

```json
{"error":"wrong token for this library"}
```

with status 401. `curl -X DELETE …` with the right token erases the library (204) and releases the claim.

## The sync loop

[SPEC 5.6](../SPEC.md#56-syncing-with-a-server). Per server, keep `cursor`, `seq`, `epoch`, and which records it still needs.

```
sync():
  for each batch of up to 100 records the server still needs (never ones it sent you):
    answer = POST /v1/lib/{lib} {items}
    if lost(answer): return refill()
    epoch = answer.epoch
    if answer.seq - distinct ids sent == cursor: cursor = answer.seq   # nobody else wrote
    seq = max(seq, answer.seq)
  loop:
    page = GET /v1/lib/{lib}?after={cursor}
    if lost(page): return refill()
    for item in page.items:
      record = decrypt and check(item)
      if mine beats record: send mine again next time
      else if record beats mine: keep record
      cursor = item.seq
    seq = max(seq, page.seq)
    if not page.more: break

lost(answer) = (epoch != null and answer.epoch != epoch) or answer.seq < seq
refill()     = cursor = 0, seq = 0, epoch = answer.epoch, mark every record (deleted ones too) as needed, sync() again
```

Run it after changes, on start, when the network returns, and every 30 seconds or so while visible. Never delete a local record because a server lacks it ([SPEC 6](../SPEC.md#6-rules-that-protect-peoples-data)).

## Ranges

Highlights are stored one record per verse, encrypted, so the server can't see refs or colors and can't expand or merge ranges for you. The reference client does both ([SPEC 1.2, Ranges in apps](../SPEC.md#ranges-in-apps)):

```js
import { Library, serverTransport } from "./sync.js";

const lib = await Library.open({ keyText });
await lib.use([serverTransport({ url: "https://vault.selah.tools" })]);

// Write: one record per verse, saved together and sent in one POST (all or none). At most 100 verses,
// in one chapter. Verses already that color are left alone, so repeating it writes nothing.
await lib.highlightRange("ROM.5.3-5", "green");
// → { ref: "ROM.5.3-5", verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"], written: ["ROM.5.3", "ROM.5.4", "ROM.5.5"] }

// Read: one record per verse, as before…
lib.highlights();
// → [{ kind: "highlight", ref: "ROM.5.3", highlights: [{ color: "green", created: … }], updated: … }, …]

// …or grouped the way the vault's list shows them.
lib.highlights({ group: "ranges" });
// → [{ ref: "ROM.5.3-5", verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"], color: "green", time: 1793000000 }]
```

Apps connected with a grant should use `public/grant-client.js` ([docs/connect.md](connect.md)): a changes feed, grouped ranges and range writes. Apps with their own client (or a grant from `/connect`, which hands over the library id, a grant token, `ek` and, for writing, `mk`) can import the same rule from `public/ranges.js`: `rangeWrites(ref, color, t, find)` gives the records to encrypt and POST together, and `listRanges(records, colorIds)` the grouped view. A grant needs `highlights:write` for the POST and `read` for the GET; the server checks the method, since it can't see what a record is.

## Check your work

- `test/vectors.json`: key, derived values, item id, blob and slot values to reproduce.
- `conformance/fixtures.json`: merge cases, the `updated` an edit gets, refill decisions, and sync scenarios to replay with your client.
- `bun run conformance <base-url>`: checks a server's library routes with a fresh random key, and deletes its library at the end ([SPEC 10.1](../SPEC.md#101-conformance)).

The reference client is `public/sync.js`: plain JavaScript that runs in browsers, Bun, Node, Deno and Workers. Importing it is a fine way to start.
