# Host the server on Cloudflare Workers and D1

Date: 2026-11-02

## Status

Accepted

## Context

The reference server should be free or nearly free at personal scale, need no machines to maintain, and be deployable by one person in a few commands. It stores small blobs keyed by library and item id, and needs ordered sequence numbers per library. The person who started the project deploys with Cloudflare's `cf` CLI.

## Decision

The server is one Cloudflare Worker (`src/worker.ts`) with a D1 (SQLite) database, plus the static web app served from Workers Assets. Tables: `libs` (token hash, `seq`, `epoch`), `items` (latest blob per id with its `seq`), `slots` (wrapped keys for passkeys). Configuration lives in `cloudflare.config.ts`; development and deploys use `cf dev`, `cf d1 migrations apply` and `cf deploy`. Observability is disabled.

## Consequences

- The free tier covers personal and small-group use, with no servers to patch.
- SQLite transactions make `seq` assignment simple and gap-free per library.
- The worker is about one file and uses only standard `fetch`-style handlers, so porting the three routes to another host is straightforward. Clients don't care where the server runs.
- `cf` is a beta CLI (pinned to `1.0.0-beta.12`). The local migration helper (`scripts/d1-local.sh`) has been seen to hang after applying migrations, so it may need attention as `cf` matures.
- Before first deploy, someone has to create the D1 database and put its id and the account id in `cloudflare.config.ts`.
