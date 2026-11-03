# Hidden Word

Bible highlights that follow you between apps and devices. Your library lives on each device first, and reaches the others through a shared folder of plain files, a server that can't read it, both, or neither.

- [SPEC.md](SPEC.md): the format and protocol. Start here to add Hidden Word to an app.
- [decisions/](decisions/README.md): why it is built this way, one architecture decision record per choice.
- `public/sync.js`: the reference client. Plain JavaScript with WebCrypto and `fetch`, no dependencies, so it runs in browsers, Bun, Node 20+, Deno and Workers. It merges records, syncs through servers (`serverTransport`) and folders (`folderTransport`), and writes library files.
- `public/passage.js`: reads what people type or paste ("jn 3.16", "Psalm 23", a bible.com link) with [grab-bcv](https://github.com/dpshde/grab-bcv), bundled into `public/vendor/` by `bun run vendor`. The add field is [scripture-inline](https://github.com/cameronapak/scripture-inline)'s `<si-passage-input>` by Cameron Pak (MIT), which suggests books, chapters, verses and ranges as you type; it is bundled into `public/vendor/` the same way, so the app loads nothing from a CDN. `public/refs.js` labels and sorts canonical references (`JHN.3.16`).
- `src/worker.ts`: the server, a Cloudflare Worker with D1. It also serves `/config.json` with the YouVersion app key from the `YVP_PUBLIC_APP_KEY` secret, so the key stays out of this repo.
- `public/`: a minimal web app: create a library (and save its key to your password manager, then optionally add a passkey), unlock it, rename it in place, add highlights (tap a row to open it in route.bible, or its book icon to read it in the BSB from YouVersion, via scripture-inline's `<si-passage>`), recolor and delete them, name colors or add your own, choose how it syncs (and erase it) on the Sync screen, export and import (including bible-rs exports), and log out. The library's name is this device's label for it: it is kept in localStorage and not synced. `/unlock` lets other apps ask for a library, and `/save?ref=John+3:16&color=blue` saves a verse from any link.

## Develop

Tools come from `mise` (Bun). The Cloudflare CLI is `cf`.

```sh
mise install
bun install
bun run migrate:local   # create the local D1 tables
bun run dev             # cf dev, http://localhost:8787 (add -- --port 8799 if 8787 is taken)
bun test                # client, server, and every mix of sync between devices
bun run check           # typecheck with tsrs (bun run check:tsc uses tsc)
```

`bun run vectors` rewrites `test/vectors.json` from the reference client. Only do that when the spec's cryptography changes.

## Deploy

```sh
cf d1 create hidden-word                 # put the id in cloudflare.config.ts, and add accountId
cf d1 migrations apply <database-id> --dir migrations
bun run deploy
```

Observability is off on purpose: the server should keep as little as it can about the people using it.

## Adding Hidden Word to an app

1. Read and write records (SPEC.md section 1) in your own storage, keyed by `kind` and `ref`, and keep what you don't understand.
2. Apply the merge rule (section 3) whenever a record comes from anywhere else. Offer export and import of `.jsonl` files (section 2). This alone makes your app interoperable.
3. For sync without a server, read and write files in a shared folder (section 4).
4. For server sync, derive keys from the sync key and push and pull (section 5). Check your output against `test/vectors.json`.
5. When creating a library, offer to save its key to the password manager (section 7.1). To use a library made elsewhere, show a username/password form the password manager can fill, or open `/unlock?app=…&callback=…` on a Hidden Word site (section 7.3).
