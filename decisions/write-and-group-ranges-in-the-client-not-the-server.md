# Write and group ranges in the client, not the server

Date: 2026-11-04

## Status

Accepted

## Context

A highlight across several verses is one record per verse (SPEC 1.2), and every app sending a range sent N records and merged them back into ranges for its list. The ask was a range-friendly API: a range on write, expanded into verses all or none, and an opt-in grouped read, without giving up per-verse storage.

The obvious place was the server's routes (`POST` a range, `GET ?group=ranges`). But the server stores only encrypted blobs under HMAC'd ids (SPEC 5.3, 9): it can't see a record's kind, ref or color, so it can't expand or merge anything. Grants carry `ek`/`mk` so the app, not the server, can decrypt and write.

## Decision

Ranges live in the shared client code, where the plaintext is:

- `public/ranges.js` defines both directions once: `expandRange`/`rangeWrites` (a canonical same-chapter range, at most 100 verses, into the records to save; verses already that color are skipped, so it's idempotent) and `listRanges` (the grouping the list shows). `test/ranges-vectors.json` covers both, for route.bible too.
- `public/sync.js` adds `Library.highlightRange(ref, color)` and `Library.highlights({ group: "ranges" })`. The default read is unchanged.
- One edit's records reach the server in one POST when they fit (`batches`, putMany groups), and a POST is one D1 batch, so a range is all or none on the server as well as on the device.
- The remote MCP server (`/mcp`), which opens a library with its sync key, uses the same code: `add_highlight` takes ranges, `list_highlights`/`find_highlights` group by default and take `group: "verses"`.

The `/v1` routes are unchanged. No migration.

## Consequences

- The server stays unable to read libraries, and storage stays one record per verse: no overlapping or half-deleted ranges.
- Clients that import `ranges.js` (or `sync.js`) get ranges without merge code of their own; others follow SPEC 1.2 and the vectors.
- Grant scopes need nothing new: a range write is a POST (`highlights:write`), a grouped read is a GET (`read`) plus local grouping.
- A range over 100 verses (all of Psalm 119) is two writes, so it isn't atomic as a whole.

## Update 2026-11-04: a changes feed for grant clients

Grants are the way apps work with a vault. `public/grant-client.js` gives them `changes(since)`: upserts and deletions since an opaque cursor (the server's `epoch` and `seq`), plus the next cursor, with the merge rule and tombstones handled in the client. For the same reason as above, it isn't a server route: the server can't tell an upsert from a deletion. It reads with `GET ?after=` (scope `read`) and writes one POST per range (`highlights:write`). Documented in [docs/connect.md](../docs/connect.md).
