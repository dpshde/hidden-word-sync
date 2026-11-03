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

## Update 2026-11-02: bible-rs sync phase 0 and 1

bible-rs [#80](https://github.com/michaelshimeles/bible-rs/pull/80) and [#81](https://github.com/michaelshimeles/bible-rs/pull/81) (open, stacked) add sync of its own. #80 stamps every record (`updated_ms` from a hybrid logical clock, plus `device`), keeps tombstones, keeps a note's losing versions as conflict copies, and raises the export to format 2. #81 syncs devices through a "Study Library" folder of per-device change files and snapshots; the web app keeps using export and import.

Hidden Word still doesn't integrate. The import reads format 2: the stamp sets `updated`, so re-importing a later export whose verse lost a part replaces the earlier import instead of tying with it, and conflict copies are kept in `x-bible-rs-conflicts`. Tombstones are ignored, as bible-rs's own import ignores them. Reading or writing the Study Library folder would be the integration this record defers, and needs its own record.

bible-rs now has tombstones and a merge rule, two of the gaps listed above. Its rule differs from section 3: it compares millisecond stamps and then device ids, where Hidden Word compares second-resolution `updated` and then the record's JSON text.

