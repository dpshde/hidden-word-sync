# Leave bible-rs out of the first clients

Date: 2026-11-02

## Status

Accepted

## Context

bible-rs is an existing Bible app by the same author, and the Hidden Word highlight model was copied from it. It would be the obvious first native client. It also differs from the format in places: notes and bookmarks are single-verse only, unknown fields are dropped, deletes are hard deletes, phone builds lack TLS, and its exports use RFC 3339 times.

## Decision

bible-rs is not changed for the first release. Hidden Word ships with the format, the reference client, the server and the web app. bible-rs users bring their data in by importing a bible-rs export (highlights and notes; bookmarks have no equivalent).

## Consequences

- The format can settle without being bent around one app's current storage.
- Highlights made in bible-rs reach Hidden Word only through manual export and import until bible-rs gains a client.
- When bible-rs does integrate, it needs: unknown-field preservation, tombstones instead of hard deletes, range notes, TLS on phone builds, and the merge rule. That work deserves its own record.
