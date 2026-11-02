# Save highlights from a GET link

Date: 2026-11-02

## Status

Accepted

## Context

Most Bible apps can open a URL but will never implement Hidden Word. A plain link lets any app, bookmarklet, shortcut or share sheet send a verse with no integration work. The save must feel instant, and must not need the network.

## Decision

`GET /save?ref=<anything>&color=<id or name>` is served by the web app (the worker hands it the app's page). The app reads `ref` with grab-bcv, saves the verses into the library unlocked in that browser, on the device first, and shows "Saved John 3:16 in Blue" with Undo. Syncing follows in the background. If no library is unlocked, the request waits in `sessionStorage` while the person unlocks or creates one, then saves. SPEC.md section 7.4 describes it.

## Consequences

- One URL format works from anything that can open a link.
- Saving uses the cached library, so it's instant and works offline once the page is cached by the browser.
- A link can't choose a library or carry a key: it only acts on a library the person has already unlocked in that browser, and the page can't be framed, so every save is visible and undoable.
- Because it's a GET, a link opened by mistake saves a highlight. Undo covers that.
