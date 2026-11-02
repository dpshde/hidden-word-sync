# Sync through a folder of plain files

Date: 2026-11-02

## Status

Accepted

## Context

Sync must not depend on the project's server. Many people already have a synced folder (iCloud Drive, Dropbox, Google Drive, Syncthing). Those services make conflicted copies when two devices edit the same file. The person who started the project also wants the files in that folder to be plain and readable, not encrypted blobs that need an app to open.

## Decision

Devices that share a folder sync through it with no server:

- Each device writes exactly one file, `<device>.jsonl`, a full library file with a header, including tombstones. It replaces the file whole (write a temporary file, then rename).
- Each device reads every other `.jsonl` file whose header names the same library, merges its records, and skips files whose modification time and size haven't changed.
- The files are not encrypted. People who want encryption at rest choose a folder service that encrypts, or use server sync.

In the web app, the folder is chosen through the File System Access API and its handle is kept in IndexedDB.

## Consequences

- No two devices ever write the same file, so sync services never create conflicted copies.
- Every device's file is a complete, human-readable backup. Old devices' files are harmless, because newer versions elsewhere win.
- Anyone with access to the folder can read the library. That is the stated trade-off.
- The File System Access API exists only in Chromium browsers, so the web app offers folder sync there only. Native apps use the file system directly.
- One folder can hold several libraries, since files are matched by header.
