# One way to interoperate

Date: 2026-11-04

## Status

Accepted

## Context

Apps should be able to read and save a person's highlights without the person handing over their sync key, and without every app reimplementing sync, the merge rule and record bookkeeping. One small, clear contract is easier to adopt and to keep stable than several.

## Decision

External apps work with a library one way: a `/connect` grant and the highlights API (SPEC 4). The grant's scopes are `read` and `highlights:write`; the API is changes since a cursor, list and find, a grouped read, add (a verse or a range), recolor and delete, done in the reference grant client because the server can't read records.

- The vault's own devices sync through its server (SPEC 5).
- `.jsonl` export and import are a person's own backup and restore, not an interop path.
- `/unlock` (handing an app the whole key) is deprecated and kept working for the rest of 1.x.
- `/save` links, the `/mcp` server and in-page WebMCP tools act inside the person's own library, with their own key or unlocked session. They're conveniences for that person, not a way for apps to interoperate.

## Consequences

- One short section of the spec tells an app everything it needs. A connected app needs HTTPS and the grant client, not the merge rule or file handling.
- Access is scoped, expires after 90 days and can be revoked, unlike a handed-over key.
- A library needs its server to reach a person's other devices; without it, a backup file moves by hand.
