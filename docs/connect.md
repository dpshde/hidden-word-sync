# Connect an app: grants

How an app such as route.bible reads and saves a person's highlights without ever holding their sync key. It's the one supported way for apps to work with a Selah Vault library. The server can't read libraries (SPEC 9), so the app does the reading, merging and grouping in its own client, `public/grant-client.js`. That client does the protocol for you, and this page says what it does underneath.

## 1. Ask for access

Send the person to the vault's consent page:

```
https://vault.selah.tools/connect?return=<your callback URL>&state=<random>&scope=read+highlights:write
```

- `return` must be an allowed app origin (`CLIENTS` in `public/grants.js`) or `http://localhost:<any port>`.
- `scope` is `read`, or `read highlights:write`. A `read` grant gets GET only; `highlights:write` gets POST of items only. No grant can delete the library, touch passkeys or make other grants.
- On Allow, the browser comes back to `return` with a fragment (fragments never reach a server):

```
#vault=https://vault.selah.tools&lib=<library id>&rt=g1.<token>&ek=<64 hex>&exp=<unix seconds>&name=<library name>&scope=read+highlights:write&state=<yours>&mk=<64 hex>
```

`ek` is the decryption key. `mk` (the item-id key) comes only with `highlights:write`. A grant lasts 90 days, and the person can revoke it from the vault. On Cancel the fragment is `#error=access_denied`. Check that `state` is yours, then keep the fields as you would a password.

## 2. Read: the changes feed

```js
import { GrantClient, parseGrantFragment } from "./grant-client.js"; // vendor it with refs.js, ranges.js and sync.js

const grant = parseGrantFragment(location.hash);
const vault = await GrantClient.open(grant);

let { upserts, deletions, next, reset } = await vault.changes(savedCursor); // omit the cursor the first time
```

```json
{
  "upserts": [{ "ref": "ROM.5.3", "color": "green", "record": { "kind": "highlight", "ref": "ROM.5.3", "highlights": [{ "color": "green", "created": 1793000000 }], "updated": 1793000000 } }],
  "deletions": ["JHN.3.16"],
  "colors": [{ "id": "yellow", "name": "", "hex": null, "builtIn": true }],
  "next": "9c1f0e2a4b6d8f0a1c3e5a7b.57",
  "reset": false
}
```

- Apply `upserts` and `deletions` by `ref` (one verse each), then save `next` and pass it to the next call. You don't need a merge rule or tombstones of your own: the client keeps only versions that win by the merge rule (SPEC 3), and turns deleted records into `deletions`.
- `reset: true` comes on the first call, after an unknown cursor, and after the server lost data (its `epoch` changed, or its `seq` went backwards). Replace everything you hold from this vault with `upserts`.
- The cursor is opaque. Underneath it is the server's `epoch` and `seq`, and each call reads `GET /v1/lib/{lib}?after={seq}` with the grant token until `more` is false.
- Poll it when your page is visible or regains focus. Repeated calls with nothing new are one small GET.
- Needs `read`. Without it the server answers 403.

The highlights read so far, from memory:

```js
vault.highlights();                    // one record per verse, canonical order
vault.highlights({ group: "ranges" }); // [{ ref: "ROM.5.3-5", verses: ["ROM.5.3", "ROM.5.4", "ROM.5.5"], color: "green", time }]
```

Ranges group back-to-back verses of one chapter that show the same color (SPEC 1.2, Ranges in apps). Each range lists its verses, so you can recolor or delete one verse.

## 3. Write: ranges in one request

```js
await vault.highlightRange("ROM.5.3-5", "green"); // → { ref: "ROM.5.3-5", verses: [...3], written: [...] }
await vault.remove(["ROM.5.4"]);                  // → ["ROM.5.4"] (the verses that were highlighted)
```

- A range is one chapter, forwards, at most 100 verses. It goes in one `POST /v1/lib/{lib}` and one database transaction, so the server keeps all of it or none.
- Writing the same range in the same color again writes nothing. A verse in another color takes the new color and keeps when it was first highlighted.
- Needs `highlights:write` and `mk`: the client refuses before the network, and the server answers 403.
- Call `changes()` before writing, so the client stamps each write past the version it replaces.

## 4. Disconnect

`await vault.disconnect()` revokes the grant (`DELETE /v1/grant/{lib}` with the grant token).

## Underneath

The server's routes are unchanged (SPEC 5.4). It stores encrypted items under HMAC'd ids and can't tell a verse, a color or a deletion apart. That's why the feed, ranges and the merge rule live in the client and not on the server. See [the decision](../decisions/write-and-group-ranges-in-the-client-not-the-server.md).
