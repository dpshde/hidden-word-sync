# Join bible-rs Study Libraries as a bible-rs device

Date: 2026-11-02

## Status

Accepted. Supersedes [Leave bible-rs out of the first clients](leave-bible-rs-out-of-the-first-clients.md).

## Context

bible-rs [#80](https://github.com/michaelshimeles/bible-rs/pull/80) and [#81](https://github.com/michaelshimeles/bible-rs/pull/81) (open, stacked) give bible-rs sync of its own. #80 stamps every record with a hybrid-logical-clock time in ms and a device id. It keeps tombstones, merges notes by their edit history (the losing side of a concurrent edit becomes a conflict copy), and raises the export to format 2. #81 syncs devices through a "Study Library" folder: `library.json`, per-device change files `changes/<device>/<n>.json` and snapshots `snapshots/<device>.json`, each written only by its own device. There are no accounts and no servers.

Dylan wants Hidden Word to be a clean participant in that mode, not a one-way importer. The deferral's list of what bible-rs lacked (tombstones, a merge rule) is now mostly done on bible-rs's side. What was left was on ours: Hidden Word's merge rule compared `updated` in seconds and then the JSON text, and dropped what it couldn't show.

## Decision

Hidden Word joins a Study Library as one more bible-rs device, with its own device id, through the same folder access as Hidden Word's folder sync (File System Access, desktop Chromium). It follows bible-rs's `folder.rs`: single writer per file, files read in order, waiting at gaps and placeholders, snapshot fallback, compaction after 64 files, rewriting removed files, and refusing newer formats. Picking a folder that holds a Study Library uses this transport; any other folder keeps the Hidden Word format.

To pick the same winners as bible-rs, the merge rule changes for every Hidden Word library, not only shared ones:

- Every version carries `updated_ms` and `device`. The order is by time in ms, then device id, with the JSON text as a last resort for equal stamps. `updated` stays, in seconds, as that time rounded down, so files remain readable and old versions remain comparable.
- Notes carry `base_updated`, `base_device`, `seen` and `conflicts`, and merge by bible-rs's `merge_note` (spec 3.1).
- bible-rs plans keep the largest restart time, and plan restarts and deletions untick passages, as bible-rs does.

What Hidden Word can't show (bookmarks, plans, ticked passages, fields added later) is kept as `x-bible-rs-*` records and fields, synced among Hidden Word devices like any record, and written back unchanged.

## Consequences

- Highlights, notes, conflict copies and deletes move both ways between bible-rs and Hidden Word with no export step. This is proven against bible-rs's own code: `test/bible-rs/hwcompat.rs` drives a real bible-rs store, and `HWCOMPAT=… bun test` runs the round trip. A committed fixture folder written by it keeps the read side tested without Rust.
- A Hidden Word server sees the new fields only inside its encrypted items. Nothing changes for servers.
- Hidden Word devices now raise conflict copies too, when one note is edited on two devices that hadn't seen each other's edit. The web app doesn't show copies yet; they are kept and travel.
- Not everything maps. Chapter and range notes stay in Hidden Word. Colors outside bible-rs's six reach bible-rs as yellow. A part's `quote` on a whole verse is dropped by bible-rs. bible-rs keeps one part per `start` in a verse.
- The folder format follows an open PR. If #81 changes before it merges, `public/biblers.js` and the fixture must follow.
- Only desktop Chromium can sync a folder. Safari and phones keep exchanging through the Hidden Word server, or by export and import.
