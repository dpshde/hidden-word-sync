# Hidden Word, version 0.2

> Thy word have I hid in mine heart, that I might not sin against thee. (Psalm 119:11)

Hidden Word is a small format for Bible highlights and notes, and two ways to keep them in step across devices and apps: a shared folder, or a server that can't read them. Any app that implements it shows your highlights, and you can switch apps, servers, or stop syncing at all without losing anything.

The spec has layers. Each one works without the ones after it.

1. **Records**: what a highlight, note or color looks like as JSON.
2. **Files**: a library as one readable JSON Lines file.
3. **Merging**: one rule that decides which version of a record wins, everywhere.
4. **Folder sync**: devices share a folder of plain files. No server.
5. **Server sync**: a sync key, end-to-end encryption, and three HTTPS routes.
6. **Unlocking**: password managers, passkeys, and handing a library to another app.

An app can stop at layer 3 and interoperate through files. Layer 4 needs only file access. Layer 5 needs only HTTPS, JSON, SHA-256, HMAC-SHA256, HKDF-SHA256 and AES-256-GCM.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Records

A record is a JSON object. Every record has:

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | `highlight`, `note`, `color`, or an app's own kind starting with `x-` |
| `ref` | string | What the record is about: a canonical reference (1.1), or for `color`, a color id |
| `updated` | integer | When the record last changed, in Unix seconds (see section 3) |
| `deleted` | `true` | Optional. The record was deleted |

A record's identity is its `kind` and `ref`. A library holds one version of each identity; section 3 says which.

Apps MUST keep records and fields they don't understand. When an app changes a record, it copies it, changes what it needs, and writes the whole record back. Field and kind names an app invents SHOULD start with `x-`.

A deleted record is `{"kind": …, "ref": …, "updated": …, "deleted": true}`. Readers MUST treat it as absent, and MUST keep it, so the deletion reaches every device.

### 1.1 References

A reference is a USFM book code, a chapter, and optionally a verse or a range of verses in that chapter:

```
JHN.3        John 3
JHN.3.16     John 3:16
JHN.3.16-18  John 3:16–18
```

- Book codes are the 66 books of the Protestant canon: `GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV`.
- Numbers follow the KJV versification, in decimal without leading zeros. An app whose translation numbers verses differently maps them to KJV numbers before writing.
- A range's end is greater than its start. A single verse is never written as a range.
- Books with one chapter still have chapter 1: Jude 3 is `JUD.1.3`.

### 1.2 Highlights

A highlight record covers exactly one verse. It holds one or more colored parts of it:

```json
{"kind":"highlight","ref":"JHN.3.16","updated":1793000000,"highlights":[
  {"color":"yellow","created":1792000000},
  {"color":"blue","start":4,"end":18,"quote":"God so loved","created":1792500000,"edited":1792600000}
]}
```

| Field | Type | Meaning |
|---|---|---|
| `color` | string | A color id (1.4). Show an id the library doesn't define as `yellow`. |
| `start` | integer | Optional, default 0. The first character covered, counted in Unicode scalar values of the verse's text. |
| `end` | integer | Optional. The character after the last one covered. Absent means to the end of the verse. |
| `quote` | string | Optional, recommended for part of a verse. The words covered when it was made. |
| `created` | integer | Optional. When this part was first made (Unix seconds). |
| `edited` | integer | Optional. When this part was last colored (Unix seconds). |

A part with no `start` and no `end` covers the whole verse, in every translation.

Offsets only mean something in the text they were counted in. To show a partial highlight in another translation, find `quote` in the verse, choosing the occurrence nearest `start`. If the verse doesn't contain it, highlight the whole verse, so a highlight never disappears. Where parts overlap, the most recently colored (largest `edited`, else `created`) is on top. A highlight across several verses is one record per verse.

There are no bookmarks: a highlight in a color named "Bookmarks" does the same job.

### 1.3 Notes

```json
{"kind":"note","ref":"JHN.3.16-18","updated":1793000000,"created":1792000000,"body":"Plain text."}
```

`ref` may be a chapter, a verse, or a range. `body` is plain text. There is one note per reference.

### 1.4 Colors

Colors double as categories. Six are built in: `yellow`, `green`, `blue`, `pink`, `purple`, `orange`. A library may name them, and may add its own:

```json
{"kind":"color","ref":"yellow","updated":1793000000,"name":"Promises"}
{"kind":"color","ref":"c-7f3a9b","updated":1793000000,"name":"Prayer","hex":"#3a7bd5","created":1793000000}
```

| Field | Type | Meaning |
|---|---|---|
| `ref` | string | The color id: lowercase letters, digits and `-`, up to 32 characters, starting with a letter or digit |
| `name` | string | Optional. What the color means to this person |
| `hex` | string | `#RRGGBB`. Required for a color that isn't built in. Apps MAY ignore it for built-in colors |
| `created` | integer | Optional. Apps list a library's own colors after the built-in ones, in `created` order |

New ids SHOULD be random (`c-` and a few random characters) so two devices never pick the same one. A highlight whose color is unknown or deleted shows as yellow. An app that deletes a color SHOULD first recolor its highlights.

## 2. Files

A library file is UTF-8 JSON Lines (`.jsonl`, media type `application/x-ndjson`), one JSON object per line, readable by people and by any JSON parser. Blank lines are ignored.

The first line MAY be a header, which has no `kind`:

```json
{"hidden-word":2,"library":"2f4856b70a85a635e64ca60c047e27fb","device":"q8Zr0aXv5Tg","name":"Personal"}
```

`library` is the library id (5.2), `device` names the device that wrote the file, and `name` is the library's name for people. Every other line is a record. Readers skip lines that aren't records.

When importing a file, each record is merged into the library by the rule in section 3, as if it had arrived from another device. Within one file, a later line with the same identity replaces an earlier one. A record without `updated` is treated as written at the moment of import.

### 2.1 bible-rs exports

Apps MAY import a bible-rs export (JSON with `"app": "bible-rs"` and `"format": 1`):

- Each entry of `highlights` (`book`, `chapter`, `verse`, `color`, `start`, `end`, `quote`, `created`, `edited`) becomes a part of the highlight record for `BOOK.chapter.verse`, with RFC 3339 times converted to Unix seconds. `updated` is the latest `edited` or `created` among its parts.
- Each entry of `notes` becomes a `note` record with `body` set to its `note`.
- `bookmarks` have no equivalent and are left out.

## 3. Merging

Every device, server and file follows one rule, so a library ends up the same everywhere whatever order changes arrive in, however long a device was offline, and however it syncs.

**Which version wins.** Of two versions of a record, the one with the larger `updated` wins. If `updated` is equal, the one whose JSON text is larger as a sequence of UTF-8 bytes wins. A missing or non-integer `updated` counts as 0. The JSON text is the record exactly as its writer serialized it: the line in a file, or the plaintext of an encrypted item without its padding.

**Writing.** When an app changes a record, it sets `updated` to the current time, or to one more than the `updated` of the version it is replacing, whichever is larger. An edit therefore always beats what it was made from, even on a device whose clock is behind.

**Receiving.** A device keeps an incoming version only if it wins against the device's own. A device never deletes or replaces a record for any other reason.

Two devices that change the same record while apart keep the later change. Changes to different records never conflict. An app that wants to keep both versions' highlight parts MAY combine them into a new version, which then wins like any edit.

## 4. Folder sync

Devices that can reach the same folder (iCloud Drive, Dropbox, Google Drive, Syncthing, a network share, a USB stick) sync through it with no server and no encryption of their own: the files are as readable as an export.

- Each device keeps exactly one file in the folder, named for its device id: `<device>.jsonl`. It is a library file (section 2) with a header, and it holds every record the device has, including deleted ones.
- A device writes only its own file, replacing it whole (write a temporary file, then rename). File sync tools never see two devices editing one file, so they never make conflicted copies of it.
- A device reads every other `.jsonl` file in the folder whose header names the same library, and merges its records (section 3). Files for other libraries, files without a header, and everything else are left alone, so one folder can hold several libraries.
- A device SHOULD remember each file's modification time and size, and skip files that haven't changed.
- A device rewrites its own file whenever its library changed since it last wrote it, including by records it just merged from others.

Files left by old devices are harmless: anything newer elsewhere wins over them. Any one device's file is a complete backup.

People who want the files encrypted at rest should choose a folder service that encrypts (for example iCloud Drive with Advanced Data Protection), or use server sync.

## 5. Server sync

A library can also sync through a server that only stores encrypted blobs under random-looking ids. It has no accounts, no email addresses and no passwords. Holding the sync key is the only access control.

### 5.1 The sync key

A sync key is 16 random bytes from a cryptographically secure generator. People see it as text:

1. Append one check byte: the first byte of SHA-256 of the 16 key bytes.
2. Encode the 17 bytes (136 bits) in Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), most significant bit first, padding the last group with zero bits: 28 characters.
3. Write them in groups of 4 joined by `-`: `000G-40R4-0M30-E209-185G-R38E-1YZ0`.

When parsing, accept any case, ignore spaces and dashes, read `O` as `0` and `I` or `L` as `1`, and reject a key that isn't 28 characters, has nonzero padding bits, or fails the check byte. A rejected key is a typo; say so.

### 5.2 Derived values

HKDF-SHA256 with an empty salt, from the 16 key bytes:

| Name | HKDF info | Length | Used as |
|---|---|---|---|
| `lib` | `hidden-word/v1/lib` | 16 bytes | Library id: lowercase hex, 32 characters |
| `auth` | `hidden-word/v1/auth` | 32 bytes | Bearer token: base64url without padding, 43 characters |
| `enc` | `hidden-word/v1/enc` | 32 bytes | AES-256-GCM key |
| `mac` | `hidden-word/v1/mac` | 32 bytes | HMAC-SHA256 key |

### 5.3 Items

Each record is stored as one item, `{id, blob}`.

- **id**: base64url (no padding) of HMAC-SHA256(`mac`, UTF-8 of `kind + " " + ref`), cut to 22 characters. Versions of one record share an id, and the server can't tell which verse it is.
- **blob**: base64url (no padding) of `nonce ‖ ciphertext`. The plaintext is the record's JSON text in UTF-8, padded with spaces (0x20) to a multiple of 256 bytes (at least 256). `nonce` is 12 fresh random bytes. `ciphertext` is AES-256-GCM(`enc`, nonce, plaintext) with the ASCII id as additional authenticated data, including the 16-byte tag.

A reader removes the trailing spaces, parses the JSON, and MUST check that `id` is the item id of the record's `kind` and `ref`, skipping it if not. A record's JSON text SHOULD stay under 16 KiB.

### 5.4 Routes

All bodies are JSON. Every route needs `Authorization: Bearer <token>`. Servers MUST send `Access-Control-Allow-Origin: *` and answer `OPTIONS` preflights. Responses SHOULD be `Cache-Control: no-store`.

**`GET /v1/lib/{lib}?after={seq}`** returns items written after `seq` (default 0), oldest first, at most 500 a page:

```json
{"items":[{"seq":41,"id":"cq_pOilWI_5HRaH6ll9W2d","blob":"AAEC…"}],"more":false,"seq":57,"epoch":"9c1f0e…"}
```

When `more` is true, ask again with `after` set to the last item's `seq`. `seq` is the library's latest sequence number. `epoch` is a random id the server chose when the library was first written, or `null` when the server has no such library.

**`POST /v1/lib/{lib}`** with `{"items":[{"id":…,"blob":…}]}`, 1 to 100 items, returns `{"seq": n, "epoch": "…"}`.

The first write claims a library: the server stores the SHA-256 of the token and refuses other tokens afterward (401). Each item replaces the server's item with the same id, whatever it held, and gets a new `seq` higher than every earlier one. The server can't read blobs, so it never applies the merge rule; clients do. Readers never see a `seq` before every lower one is visible.

**`DELETE /v1/lib/{lib}`** deletes the library and its items, and releases the claim. Returns 204. The next write starts a new epoch.

Errors are `{"error": "message"}` with status 400, 401, 404, 405, 413 or 500.

### 5.5 Limits

A server SHOULD accept at least: 100 items per POST; blobs of 379 to 21,900 characters; 8,000,000 blob characters per library (about 20,000 items); 2.4 MB request bodies; 2,000-character key slots. Pages hold 500 items.

### 5.6 Syncing with a server

A client keeps, per server: the cursor (the last `seq` it read), the latest `seq` and the `epoch` it has seen, and which of its records the server doesn't have yet.

1. **Push** every record changed on this device, or received through another transport, since the last push, in POSTs of up to 100. Records that came from this server are not sent back to it.
2. **Pull** pages from the cursor until `more` is false. Merge each item (section 3). If this device's version wins against the server's, send this device's version again on the next push. That repairs a server that went back to an old version, or received one late.
3. **Refill a server that lost data.** If an answer has a different `epoch` from the one remembered, or a `seq` lower than the latest seen, the server was erased, replaced or restored from a backup. Reset the cursor to 0, send every record (including deleted ones), and pull again.

Sync after changes, on start, when the network returns, and every 30 seconds or so while visible.

## 6. Rules that protect people's data

Whatever an app's choice of sync, these keep a library safe from any server or folder going wrong:

- The copy on the device is the library. Every read and write goes to it first, and the app never waits on the network to show or save a change.
- An app MUST NOT delete local records because a server or folder doesn't have them, answers with nothing, or fails. Only a newer deleted version (section 3) removes a record.
- Changes made offline are kept across restarts until every transport the device uses has them.
- Network requests time out, and a failed sync is tried again later (on the next change, when the network returns, or on a timer).
- Export to a file (section 2) is always available, with or without sync.
- An app that uses several transports (a server and a folder, or two servers) syncs each in turn and passes what one brings in on to the others, so devices that share no transport still meet through one that has both.

Erasing a library removes it from the transports and the device doing the erasing. Any other device that still holds it will put it back the next time it syncs, by design: no transport can take a library away from a device.

## 7. Unlocking

### 7.1 Password managers

The sync key is a password, and the library name is its username. When an app creates a library it MUST offer to save the key in the person's password manager before going on:

- On the web, show a real `<form>` with the name and key, and have the person submit it:

```html
<input name="username" autocomplete="username" value="Personal">
<input name="password" type="password" autocomplete="new-password">     <!-- creating -->
<input name="password" type="password" autocomplete="current-password"> <!-- unlocking -->
```

  Password managers offer to save a sign-up when they see the fields filled in and the form submitted with a page load after it. So:
  - After putting a generated key in the field, dispatch `input` and `change` events on both fields, as typing would. Extensions such as 1Password track fields by these events, and may not notice a value that appears without them.
  - Let the submission navigate (for example a `GET` to the app's own page) instead of cancelling it. The key MUST NOT leave the device: remove every entry in the form's `formdata` event, so the request carries nothing. Keep what the new page needs to open the library in local storage.
- Native apps use the platform equivalents (Associated Domains with `textContentType` `.username` / `.newPassword` / `.password` on Apple platforms, `autofillHints` on Android).
- Web apps SHOULD also show [1Password's save button](https://www.1password.dev/web/add-1password-button-website) (`@1password/save-button`) with a save request holding the name (`autocomplete: "username"`) and the key (`autocomplete: "new-password"`). It hands the key to the 1Password extension directly, without relying on form detection. Hide it while it stays disabled, which means the extension isn't installed.

The library name is only a label: it is not part of the key, and two people may both call theirs "Personal".

### 7.2 Passkeys

A passkey with the WebAuthn PRF extension can unlock a library without typing the key. This works with 1Password, iCloud Keychain and Google Password Manager passkeys, and with security keys that support `hmac-secret`.

- The PRF input (`eval.first`) is SHA-256 of the ASCII string `hidden-word/v1/prf`.
- From the 32-byte PRF output, HKDF-SHA256 with an empty salt derives `slot` (info `hidden-word/v1/slot`, 16 bytes, lowercase hex), `slot-auth` (info `hidden-word/v1/slot-auth`, 32 bytes, base64url bearer token) and `kek` (info `hidden-word/v1/kek`, 32 bytes, AES-256-GCM key).
- The slot holds `wrapped`: base64url of `nonce ‖ AES-256-GCM(kek, nonce, plaintext)` with the slot id as additional data, where the plaintext is the UTF-8 JSON `{"key": "<sync key text>", "name": "<library name>"}`.

Routes, with the `slot-auth` token: `PUT /v1/slot/{slot}` with `{"wrapped": "…"}` (the first write claims the slot; 204), `GET /v1/slot/{slot}` (`{"wrapped": "…"}`, or 404), `DELETE /v1/slot/{slot}` (204).

The server never verifies the passkey's signature: the PRF output is the secret. Passkeys are bound to the website that created them, so they are a convenience on that site. The sync key in a password manager is what works everywhere.

When creating a library, an app SHOULD offer a passkey right after the key is saved, in the same step: the click that leaves the save step creates the passkey (WebAuthn needs that click), then the app goes on into the library whether a passkey was made, declined or failed. It never blocks on the passkey.

### 7.3 Connecting an app

A Hidden Word site can hand a library's key to another app, in the style of an OAuth consent screen. The app opens `https://<site>/unlock?app=<display name>&callback=<url>`. The site asks the person to unlock a library, then asks "Give <app> access to <library>?". On Allow it sends the browser to `<callback>#k=<key>&name=<name>`, or `<callback>#error=denied` on Cancel. Fragments never reach servers.

`callback` MUST be `https:`, a custom scheme, or `http:` on `localhost`, `127.0.0.1` or `[::1]`. Sites MUST refuse `javascript:`, `data:`, `blob:`, `file:` and similar, and SHOULD show the callback's host. The app receives the whole key and can read, change and delete everything in the library.

A site MAY accept `/#k=<key>&name=<name>` to prefill its own unlock form.

### 7.4 Saving from a link

A Hidden Word site MAY save a highlight from a plain link, so any app, bookmarklet or share sheet can send a verse with one `GET`:

```
https://<site>/save?ref=John+3:16&color=blue
```

- `ref` is whatever the person or app has: a reference in any common form (`John 3:16`, `jn 3.16`, `JHN.3.16-18`, `Psalm 23`) or a link from a Bible app or site (bible.com, BibleGateway, route.bible). It covers every verse it names.
- `color` is optional: a color id, or a name the library gave a color (`Prayer`). Anything else means `yellow`.
- The site saves into the library already unlocked in that browser, at once and on the device first (section 6), and says what it saved with a way to undo it. If no library is unlocked, it asks the person to unlock or create one, and saves afterward.
- The link carries no key and reaches no library by itself. A site MUST NOT save for a library the browser hasn't unlocked, and SHOULD forbid framing (`frame-ancestors 'none'`) so the save is always visible.

The reference web app parses `ref` with [grab-bcv](https://github.com/dpshde/grab-bcv).
## 8. Linking

A reference is enough to link to a passage; records don't store links. To open a passage in the reader's preferred Bible app, apps MAY use route.bible, which uses the same book codes: `https://route.bible/` followed by the lowercased `ref`, for example `https://route.bible/jhn.3.16`.

## 9. What a server learns

A server learns how many items each library has, when they change, from which IP addresses, and each blob's size in 256-byte steps. It does not learn verses, colors, notes, names or keys. It can delete or withhold items, or serve old versions; section 5.6 repairs the latter, and section 6 makes sure the former never costs a device its copy.

Losing the sync key and every passkey means losing access to the server copy. The files on a device or in a sync folder are still readable without it.

## 10. Test vectors

`test/vectors.json` holds a key (bytes `00 01 … 0f`), its text form `000G-40R4-0M30-E209-185G-R38E-1YZ0`, every derived value, the item id of `highlight JHN.3.16`, a blob made with a fixed nonce, the PRF input, and slot values for a PRF output of 32 bytes of `0x11`. `bun run vectors` regenerates the file from the reference client.

| | |
|---|---|
| `lib` | `2f4856b70a85a635e64ca60c047e27fb` |
| `enc` | `5e87f9ed998e6aad7edc1bfd67eff85e050949044d082a12577653a0b30e0d4d` |
| `mac` | `1444a07f1522ce58fedbf8f88bc61087b527da58c1238b7d7c3ef747bf293162` |
| id of `highlight JHN.3.16` | `cq_pOilWI_5HRaH6ll9W2d` |
| PRF input | `fcfb4063bf395fdc94420956f179db678140eff05a60a0c776c8c81f3684fef5` |
| `slot` for PRF `11…11` | `2148b32b2ad12085df0d940c85855e97` |

## Changes from 0.1

- One merge rule (section 3) decides every conflict, on every device. Servers no longer decide by arrival order.
- Servers report `seq` and `epoch`, and clients refill a server that lost data.
- Folder sync with plain, readable files (section 4).
- Colors can be named and added (section 1.4). Bookmarks are gone.
- Files have an optional header line.
- Rules that protect people's data (section 6), and route.bible links (section 8).
- Password-manager saving uses a real form submission that sends nothing (section 7.1). Saving from a link (section 7.4).
