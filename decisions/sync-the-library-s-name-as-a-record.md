# Sync the library's name as a record

Date: 2026-11-03

## Status

Accepted.

## Context

A library's name lived only on each device: in localStorage, and in a passkey's slot when the passkey was added. Nothing synced it, so a second device, or the same person on another address, showed whatever was typed to unlock. Renaming on one device changed nothing anywhere else.

## Decision

- The name is a record, `{"kind":"library","ref":"name","updated":…,"name":…}` (SPEC.md 1.5). It takes the same path as every other record: an HMAC id, an AES-GCM blob, the one merge rule. The server stays a blind store, and learns no more than before.
- Renaming writes it like any edit, so the latest rename wins on every device.
- The name typed to unlock is only a label until the record arrives. A library that has no record adopts this device's name once every transport has synced, written with `updated` 0, so it can never beat a name chosen anywhere.
- Export headers carry the synced name, and exports and imports carry the record.
- Passkey slots keep the name they were made with. Refreshing a slot needs the passkey's PRF output, which means a passkey prompt, so the app doesn't do it on a rename. The synced name wins once the library has synced.
- It's a new record kind, a compatible change in 1.x (section 11), so SPEC.md is version 1.1.

## Consequences

- Two devices that adopt different names before either has synced settle on one by the tie rule. Renaming once fixes that everywhere.
- A 1.0 app keeps the record without showing it. An app that lists every record it holds, rather than the kinds it knows, would show it.
- The MCP server's `get_library_info` now reports the name.
