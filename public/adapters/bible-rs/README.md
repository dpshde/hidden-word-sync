# bible-rs adapter

Keeps a Hidden Word library in step with a [bible-rs](https://github.com/michaelshimeles/bible-rs) **Study Library** folder, both ways, and imports bible-rs JSON exports. It follows bible-rs's code at PR [#81](https://github.com/michaelshimeles/bible-rs/pull/81) (`d393e4d`, stacked on [#80](https://github.com/michaelshimeles/bible-rs/pull/80)): `crates/core/src/folder.rs`, `sync.rs` and `StudyStore::merge` in `study.rs`. Both PRs are still open, so this adapter follows a format that may change.

Hidden Word's core doesn't know this adapter exists. To remove it, delete this folder and `test/adapters/bible-rs/`; `public/adapters/index.js` skips a missing module.

## Files

| File | What it does |
|---|---|
| `index.js` | The plugin: `detect` (the folder holds a Study Library `library.json`), `adapter`, `importFile` (bible-rs exports) |
| `folder.js` | The Study Library protocol: files, numbering, reading in order, snapshots, compaction |
| `merge.js` | The study of one bible-rs device, merged by bible-rs's rules |
| `map.js` | Between bible-rs's highlights and notes and Hidden Word records, and bible-rs exports to records |

## How it works

The adapter is one more bible-rs device, with its own random 16-hex-digit device id. It keeps that device's study (every record bible-rs syncs, exactly as bible-rs writes them, with stamps, note history and conflict copies, tombstones, bookmarks, plans, ticked passages and any fields it doesn't know) in its own state: `Library.remote("bible-rs folder")`, saved on this device with the library and never synced elsewhere.

Each sync:

1. **Hidden Word's edits become this device's edits.** Every highlight and one-verse note changed in the library since the last sync is compared with the study. If it says something different, the study gets a new version: stamped by the device's hybrid logical clock (from the record's `updated`, never behind a stamp it has seen), and for a note, edited from the study's version, keeping its history and conflict copies, as bible-rs's `set_note` does.
2. **Reads the other devices' files**, as `folder.rs` does. Each device's change files are read in order from where it stopped. It stops at a gap, a half-written file or an iCloud placeholder, and reads that device's snapshot when the next file it needs is gone. Files and libraries with a newer `format` are refused. What it reads is merged into the study by bible-rs's sync rules:
   - **Highlights, bookmarks, plans and ticked passages:** the later stamp wins (time in ms, then device id), deletes included.
   - **Notes:** `merge_note`. A version that has seen the other wins. Two edits made apart keep the loser's text as a conflict copy, and copies travel with the note.
   - **Plans:** a restart counts even when the plan's stamp loses, and unticks earlier passages. A deleted plan unticks all of them.
3. **Gives Hidden Word what changed** in highlights and one-verse notes, as edits (`Library.putMany`), when the library doesn't already say the same. Hidden Word keeps plain records: no stamps, no bible-rs fields or kinds.
4. **Writes what changed in the study** since its last write, as one change file under `changes/<its device>/`. It skips records stamped by another device with files in the folder, but a note with conflict copies always goes. After more than 64 change files it writes `snapshots/<its device>.json` and removes its change files up to it. If its own files were removed, it writes a whole snapshot. Numbering follows the highest of its files, its snapshot and what it last wrote.

| bible-rs | Hidden Word |
|---|---|
| highlight of a verse (`parts`) | `highlight` record; parts keep `color`, `start`, `end`, `quote`, `created`, `edited` |
| note on a verse | `note` record with `body` and `created` |
| bookmarks, plans, ticked passages, note history and conflict copies, stamps, unknown fields | the adapter's state only, written back unchanged |

Going the other way, colors outside bible-rs's six go out as `yellow`, and parts get the `created` and `edited` that bible-rs requires. Chapter and range notes, colors and other kinds stay in Hidden Word.

## Exports

`importFile` takes a bible-rs JSON export (`"app": "bible-rs"`, format 1 or 2) and returns records for the library to merge by its own rule:

- Each highlight entry becomes a part of the verse's `highlight` record, with RFC 3339 times in Unix seconds. `updated` is the latest `edited`/`created`, or the verse's format 2 stamp (`updated_ms`, rounded down) when that is later. That way a later export whose verse lost a part still wins.
- Each note becomes a `note` (`body` from `note`), with `updated` the later of `updated` and `updated_ms`. Format 2 conflict copies are kept in the record's extension field `x-bible-rs-conflicts` (`{body, updated, device}`).
- Bookmarks, history, plans and tombstones are left out. An export brought in by hand never deletes, as in bible-rs's own import.

## Limits

- Hidden Word doesn't show conflict copies or bookmarks; they're kept and written back.
- bible-rs drops a `quote` on a whole-verse part, and keeps one part per `start`.
- A note Hidden Word gets from bible-rs and passes to its other devices through its server is a plain note there. Each Hidden Word device in the folder is its own bible-rs device, so two of them can each write the same text once under their own stamps. bible-rs settles on one.
- Only desktop Chromium can open a folder.

## Testing

`test/adapters/bible-rs/` holds the tests, a Study Library written by bible-rs (`library/`, with `library.dump.json`), and `hwcompat.rs`, a small command-line bible-rs device. To run the round trip against bible-rs itself, copy `hwcompat.rs` into `crates/core/examples/` of a bible-rs checkout at #81, build it (`cargo build -p bible-core --example hwcompat`), and run `HWCOMPAT=target/debug/examples/hwcompat bun test`.
