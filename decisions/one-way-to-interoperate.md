# One way to interoperate

Date: 2026-11-04

## Status

Accepted. Supersedes [Sync through a folder of plain files](sync-through-a-folder-of-plain-files.md), [Leave bible-rs out of the first clients](leave-bible-rs-out-of-the-first-clients.md) and [Connect apps with an unlock redirect](connect-apps-with-an-unlock-redirect.md).

## Context

The contract offered several ways for apps to meet a library: folder sync, a bible-rs import, `/unlock` handing over the whole sync key, and `/connect` grants. Folder sync was the heavy one. Every client had to write its own file, keep deleted records forever, preserve unknown fields and relay between transports, which made any new client (bible-rs first) costly to add. Only the reference web app ever implemented it.

## Decision

External apps work with a library one way: a `/connect` grant and the highlights API (SPEC 4). The grant's scopes are `read` and `highlights:write`; the API is changes since a cursor, list and find, a grouped read, add (a verse or a range), recolor and delete, done in the reference grant client because the server can't read records.

- Folder sync is removed: the spec section, `folderTransport`, `public/folder.js` and the Sync screen's folder option. The vault's own devices sync through its server only.
- The bible-rs import is removed. bible-rs, like any app, would connect with a grant.
- `.jsonl` export and import stay, as a person's own backup and restore. They aren't an interop path.
- `/unlock` (the key handoff) is deprecated and kept working for the rest of 1.x.
- `/save` links, the `/mcp` server and in-page WebMCP tools act inside the person's own library, with their own key or unlocked session. They're conveniences for that person, not a way for apps to interoperate.

## Consequences

- One short section of the spec tells an app everything it needs. New clients need HTTPS and the grant client, not the merge rule and file bookkeeping.
- No sync without a server: devices that only shared a folder now need server sync, or a backup file moved by hand.
- Browsers that used folder sync drop the stored folder handles (an IndexedDB database holding nothing else) on the next load. Their records, in local storage and on the server, are untouched, and anything a folder brought in still reaches the server on the next sync.
- Strictly, 1.1 promised folder sync's file layout for all of 1.x. It's withdrawn in 1.2 rather than kept to 2.0, because nothing outside this repo used it and nothing on the wire changes.
