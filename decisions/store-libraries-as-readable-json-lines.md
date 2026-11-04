# Store libraries as readable JSON Lines

Date: 2026-11-02

## Status

Accepted

## Context

The format has to be portable to any language and readable without special software. A person should be able to open their library in a text editor, grep it, or keep it in git, without installing Selah Vault or any third-party app. Apps also need to round-trip data they don't understand, so one app's extensions survive another app's edits.

## Decision

A library file is UTF-8 JSON Lines (`.jsonl`): one JSON object per line. An optional first line is a header (`{"hidden-word":2,"library":…,"device":…,"name":…}`); every other line is a record with `kind`, `ref`, `updated`, and an optional `deleted: true`. A record's identity is `kind` plus `ref`.

Apps must keep records and fields they don't understand, and write back whole records when they change one. Names an app invents start with `x-`. Deletions are tombstones (`deleted: true`) that readers treat as absent but keep. Importing a file merges each record by the normal merge rule.

The same files are the backup format and, encrypted one record per item, the server's plaintext.

## Consequences

- Any JSON parser in any language can read a library. A line-oriented file diffs and merges well in text tools.
- One representation everywhere means one code path for export, import and server sync.
- Unknown-field preservation lets apps extend the format without coordination, but every app must remember to copy rather than rebuild records.
- Tombstones grow without bound. That is acceptable at the scale of personal highlights; compaction would need a new decision, because dropping tombstones early lets deleted records come back.
