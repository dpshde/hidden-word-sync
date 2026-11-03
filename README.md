# Hidden Word

Bible highlights that follow you between apps and devices. Your library lives on each device first, and reaches the others through a shared folder of plain files, a server that can't read it, both, or neither.

The hosted app and server is at **https://vault.selah.tools**. `sync.selah.tools` serves the same Worker as an alias. The old `hidden-word.dpshade.workers.dev` address sends browsers to vault.selah.tools (a 308, same path and query), and keeps answering `/v1`, `/mcp`, `/api/` and `/config.json` so existing clients keep working. Passkeys belong to the address they were made on, so add one again on vault.selah.tools.

- [SPEC.md](SPEC.md): the format and protocol. Start here to add Hidden Word to an app.
- [decisions/](decisions/README.md): why it is built this way, one architecture decision record per choice.
- `public/sync.js`: the reference client. Plain JavaScript with WebCrypto and `fetch`, no dependencies, so it runs in browsers, Bun, Node 20+, Deno and Workers. It merges records, syncs through servers (`serverTransport`) and folders (`folderTransport`), and writes library files.
- `public/passage.js`: reads what people type or paste ("jn 3.16", "Psalm 23", a bible.com link) with [grab-bcv](https://github.com/dpshde/grab-bcv), bundled into `public/vendor/` by `bun run vendor`. The add field is [scripture-inline](https://github.com/cameronapak/scripture-inline)'s `<si-passage-input>` by Cameron Pak (MIT), which suggests books, chapters, verses and ranges as you type; it is bundled into `public/vendor/` the same way, so the app loads nothing from a CDN. `public/refs.js` labels and sorts canonical references (`JHN.3.16`).
- `src/mcp/`: an [MCP](https://modelcontextprotocol.io) server at `/mcp`, so AI assistants can read and change a library (see "Connect an AI assistant" below).
- `src/worker.ts`: the server, a Cloudflare Worker with D1. It also serves `/config.json` with the YouVersion app key from the `YVP_PUBLIC_APP_KEY` secret, so the key stays out of this repo.
- `public/`: a minimal web app: unlock with a passkey where the browser has them, or with the sync key; create a library (and save its key to your password manager, then optionally add a passkey), unlock it, rename it in place, add highlights (tap a row to open it in route.bible, or its book icon to read it in the BSB from YouVersion, via scripture-inline's `<si-passage>`), recolor, edit and delete them, group the list by date or by genre (a per-device choice), name colors or add your own, choose how it syncs (and erase it) on the Sync screen, export and import (including bible-rs exports), and log out. The library's name syncs like a highlight, as an encrypted `library` record (SPEC.md 1.5): rename it on one device and the others follow. `/unlock` lets other apps ask for a library, and `/save?ref=John+3:16&color=blue` saves a verse from any link.

## Connect an AI assistant (MCP)

The Worker serves a remote MCP server (Streamable HTTP) at `https://vault.selah.tools/mcp`. It opens your library with your sync key, sent on every request as `Authorization: Bearer <sync key>` (or `X-Hidden-Word-Key: <sync key>`). Tools: `list_highlights`, `find_highlights`, `add_highlight`, `set_highlight_color`, `delete_highlight`, `list_colors`, `get_library_info`, `get_passage_link`. Changes reach your other devices on their next sync.

```json
{
  "mcpServers": {
    "hidden-word": {
      "url": "https://vault.selah.tools/mcp",
      "headers": { "Authorization": "Bearer XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" }
    }
  }
}
```

The tradeoff: server sync never shows the server your key, but the MCP server has to decrypt your library to answer, so your key reaches the Worker, in memory, for each request. It isn't stored, logged or sent back, and the code is in `src/mcp/`. Your assistant's config file holds the key, so treat it like the key itself. See [the decision record](decisions/serve-an-mcp-server-that-opens-a-library-with-its-sync-key.md).

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

The custom domains (`vault.selah.tools`, `sync.selah.tools`) are Worker custom domains in the Cloudflare dashboard, not in this config. The pages (`/`, `/unlock`) run the Worker first (`assets.runWorkerFirst` in `cloudflare.config.ts`) so it can redirect the old workers.dev address; a fork on its own workers.dev name isn't redirected.

CI runs `bun test` and `bun run check` on every push to `main` and every pull request (`.github/workflows/ci.yml`). Deploys stay manual.

Logs, traces and browser error reports are on, redacted so they never hold a key, token, id, query string or verse: see [docs/observability.md](docs/observability.md) for what's recorded and where to read it.

## Adding Hidden Word to an app

Start with [docs/quickstart.md](docs/quickstart.md): a first sync in five steps, with real requests and answers. SPEC.md is version 1.1, and section 11 says what stays stable.

1. Read and write records (SPEC.md section 1) in your own storage, keyed by `kind` and `ref`, and keep what you don't understand.
2. Apply the merge rule (section 3) whenever a record comes from anywhere else. Offer export and import of `.jsonl` files (section 2). This alone makes your app interoperable.
3. For sync without a server, read and write files in a shared folder (section 4).
4. For server sync, derive keys from the sync key and push and pull (section 5). Check your output against `test/vectors.json`, replay `conformance/fixtures.json` with your client, and run `bun run conformance <base-url>` against your server (section 10.1).
5. When creating a library, offer to save its key to the password manager (section 7.1). To use a library made elsewhere, show a username/password form the password manager can fill, or open `/unlock?app=…&callback=…` on a Hidden Word site (section 7.3).
