# Sync with bible-rs through an adapter

Date: 2026-11-02

## Status

Accepted. Supersedes [Leave bible-rs out of the first clients](leave-bible-rs-out-of-the-first-clients.md).

## Context

bible-rs [#80](https://github.com/michaelshimeles/bible-rs/pull/80) and [#81](https://github.com/michaelshimeles/bible-rs/pull/81) (open, stacked) give bible-rs sync of its own. A "Study Library" folder holds per-device change files and snapshots, records are stamped by a hybrid logical clock in ms and a device id, notes merge by their edit history with conflict copies, and tombstones travel. Dylan wants Hidden Word to take part in that sync cleanly, both ways. He also wants it kept apart from Hidden Word's core: a sync adapter, or plugin, not part of the format.

A first attempt changed the core to match bible-rs: millisecond stamps and device ids in every record, bible-rs's note merge in the merge rule, and `x-bible-rs-*` record kinds for bookmarks and plans. That made one app's model the format's.

## Decision

Other apps' formats are adapters. The core defines what an adapter is and nothing about any particular one:

- A **sync adapter** is `{ name, sync(lib), erase?(lib) }`. It works through the library's public side (`device`, `seq`, `changedSince`, `find`/`all`, `offer`, `putMany`, `toFile`, `remote`, `emit`), and keeps its own state in `remote(name)`, saved on the device and never synced.
- A **folder format** is a module under `public/adapters/<id>/` whose default export is `{ id, label, detect(tree), adapter(tree), importFile?(text) }`, listed in `public/adapters/index.js`. The app syncs a chosen folder with the first format that detects it, and imports a file with the first that reads it. A listed module that's missing is skipped. Folders are seen as a small tree interface (`list`, `read`, `write`, `remove`) so formats with subfolders fit.
- Hidden Word's own folder format moved out of the core into `public/adapters/hidden-word/`, as the fallback format.

The bible-rs adapter (`public/adapters/bible-rs/`, documented in its README) joins a Study Library as one more bible-rs device. It keeps that device's whole study in its own state, merged by bible-rs's rules ported from its code. Hidden Word's edits to highlights and one-verse notes become that device's edits, and it hands Hidden Word changes to highlights and notes back as ordinary edits. Hidden Word's merge rule, records and spec are unchanged. Bookmarks, plans, ticked passages, note history and conflict copies, stamps and unknown fields never enter the library. Importing bible-rs exports moved into the adapter too, out of the spec.

## Consequences

- The core knows no app but its own. `test/separation.test.ts` checks that no core file names bible-rs or imports an adapter but the plugin list. It also deletes the adapter from a copy of the repository, then builds, typechecks and runs the tests there.
- The adapter is proven against bible-rs's own code: `HWCOMPAT=… bun test` runs bible-rs devices and Hidden Word through edits on both sides, deletes, a conflict copy, compaction and a new device. They end with identical studies.
- Changes to the core were few and generic: the adapter contract, a folder tree interface (`folderTree`, `memoryTree`), and three read-only accessors on the library (`device`, `seq`, `changedSince`).
- Hidden Word doesn't show what it has no record for (bible-rs bookmarks, conflict copies). If it should one day, that's a core feature to design on its own, not something an adapter brings in.
- Each Hidden Word device in a Study Library is its own bible-rs device. A change that reaches two of them through the Hidden Word server can be written to the folder twice, with the same text; bible-rs settles on one.
- Exports still put conflict copies in a record's `x-bible-rs-conflicts` field. That uses the format's extension fields (section 1), which the core keeps without reading.
