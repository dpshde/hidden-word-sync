# selah-jev

Stateless Cloudflare Worker that proxies Selah Vault's highlight-relevance requests to TypeSafe `jev-latest`. Deployed on its own; the vault Worker (`hidden-word`) does not call it.

## Request

`POST /` with JSON `{ lib, passage: { ref, text }, highlights: [{ id, ref, text }, …] }` from the vault origin only. Other shapes are refused.

## Secrets and bindings

- `TYPESAFE_API_KEY` — `wrangler secret put TYPESAFE_API_KEY` (never commit)
- `CAPS` — KV namespace for the $0.25/day spend counter and per-library rate limit

See `wrangler.toml` for reference. Deploy happens elsewhere.
