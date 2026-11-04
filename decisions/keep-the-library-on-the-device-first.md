# Keep the library on the device first

Date: 2026-11-02

## Status

Accepted

## Context

Selah Vault exists so that Bible highlights follow a person between apps and devices. The person who started it does not want any app, including their own, to depend on a server they run. If the server goes down, is erased, or disappears, no client may lose data or stop working. People also read offline (on planes, in church, with no signal) and expect what they mark there to stay marked.

Most sync products treat the server as the source of truth and the device as a cache. That makes the server's failures the user's failures.

## Decision

The copy on the device is the library. Every read and write goes to local storage first, and the app never waits on the network to show or save a change. Sync through a server is optional, and a library that never syncs is complete.

SPEC.md section 6 makes this normative:

- An app must not delete local records because a server lacks them, returns nothing, or fails. Only a newer deleted version removes a record.
- Changes made offline are kept across restarts until the server has them.
- Requests time out (the reference client uses 20 seconds), and failed syncs are retried on the next change, when the network returns, or on a timer.
- Export to a file is always available.

## Consequences

- A server outage, erase or rollback costs nobody their data. The worst case is that devices stop meeting until the server works again.
- Switching servers or turning sync off are local settings changes, not migrations.
- Erasing a library only removes it from the erasing device and its transports. Any other device that still holds it will put it back on its next sync. This is deliberate, and the UI has to say so.
- Every client must implement merging (see [Resolve conflicts with one merge rule](resolve-conflicts-with-one-merge-rule.md)), because there is no authority to defer to.
- Local storage limits (localStorage in the web app) bound library size. Fine for highlights and notes; revisit if records grow large.

## Update 2026-11-03: sync is not shown

Since every change is already saved on the device, the web app no longer shows "Syncing…". The status reads "Synced" (or "On this device only") and only changes when it matters: "Offline · n waiting" when changes can't be sent, or "Sync failed" after two failed runs in a row, so a single blip stays quiet. A change goes up right away, and when the server's answer shows no other device wrote in between, the app skips the pull, so a change costs one request.

## Update 2026-11-03 (later): no sync status at all

The main view says nothing about sync in any state: the header's status ("Synced", "Offline · n waiting", "Sync failed") is gone. The library on the device is the library, so there is nothing to report in normal use. How a library syncs lives only on the Sync screen, reached from the ••• menu. Erasing a library moved there too, under "Danger zone", and "Lock" is now "Log out".
