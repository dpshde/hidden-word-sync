# Detect server data loss with an epoch

Date: 2026-11-02

## Status

Accepted

## Context

Clients pull from a server by cursor (`seq`). If the server is erased, replaced, or restored from a backup, cursors point past data the server no longer has, and records the server lost are never sent again, because clients think they already delivered them. Without detection, a server failure would quietly split devices apart.

## Decision

Each library on a server has an `epoch`: a random id chosen when the library is first written, returned with `seq` on every GET and POST (`null` when the library doesn't exist). The server keeps it in `libs.epoch` (migration `0002_epoch.sql`).

A client remembers the epoch and the highest `seq` it has seen per server. If the epoch changes, or `seq` goes down, the client resets its cursor to 0, re-sends every record including tombstones, and pulls again. During normal pulls, if the client's own version of a record beats the server's, it re-sends its version on the next push.

## Consequences

- A wiped or restored server refills itself from whichever devices sync next, without anyone noticing.
- A full re-push costs one upload of the library, which is small for personal highlights.
- A server that lies about its epoch can still withhold data, but it can't make a device lose its copy (see [Keep the library on the device first](keep-the-library-on-the-device-first.md)).
- Erasing a library on purpose starts a new epoch, so other devices refill it. Erase is local by design.
