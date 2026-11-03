# Hidden Word

Bible highlights that follow you between apps and devices. Your library lives on each device first, and reaches the others through a shared folder of plain files, a server that can't read it, both, or neither.

- [SPEC.md](SPEC.md): the format and protocol. Start here to add Hidden Word to an app.
- [decisions/](decisions/README.md): why it is built this way, one architecture decision record per choice.
- `public/sync.js`: the reference client. Plain JavaScript with WebCrypto and `fetch`, no dependencies, so it runs in browsers, Bun, Node 20+, Deno and Workers. It merges records, syncs through servers (`serverTransport`) and any sync adapter (`Library.use`), and writes library files.
- `public/passage.js`: reads what people type or paste ("jn 3.16", "Psalm 23", a bible.com link) with [grab-bcv](https://github.com/dpshde/grab-bcv), bundled into `public/vendor/` by `bun run vendor`. `public/refs.js` labels and sorts canonical references (`JHN.3.16`).
- `public/adapters/`: sync adapters for folders, as plugins listed in `public/adapters/index.js`. `hidden-word/` is Hidden Word's own folder format (spec section 4). `bible-rs/` syncs with a [bible-rs](https://github.com/michaelshimeles/bible-rs) Study Library and imports bible-rs exports; see its [README](public/adapters/bible-rs/README.md). The core doesn't know about any adapter, and works with `bible-rs/` deleted (`test/separation.test.ts` checks).
- `src/worker.ts`: the server, a Cloudflare Worker with D1.
- `public/`: a minimal web app: create a library (and save its key to your password manager, with 1Password's save button when the extension is there, then optionally add a passkey), unlock it, add, recolor and delete highlights, name colors or add your own, choose how it syncs, export and import (including other apps' files, through their adapters). `/unlock` lets other apps ask for a library, and `/save?ref=John+3:16&color=blue` saves a verse from any link.

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

`HWCOMPAT=<path to hwcompat> bun test` also runs the bible-rs adapter against bible-rs itself (see `test/adapters/bible-rs/hwcompat.rs`).

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
