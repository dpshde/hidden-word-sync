# Observability

What the Worker records, where to read it, and what it never records. The reasons are in
[the decision record](../decisions/observe-the-worker-with-redacted-logs-and-traces.md).

## What's on

| Signal | Where it's set | What it holds |
|---|---|---|
| Workers Logs, the Worker's own lines | `cloudflare.config.ts` (`observability.logs`), written by `src/observe.ts` | One `request` line per Worker request: `method`, `route` (a template like `/v1/lib/:lib`), `status`, `ms`, and for a failure `error_class` and a scrubbed `error`. `/mcp` adds `mcp` (`ok` or `bad_key`), `mcp_methods`, `tools`, `tool_result` (`refused` or `failed`) and `mcp_error_class`. |
| Browser error reports | `public/report.js` → `POST /api/client-error` | One `client_error` line per report: `kind`, `name`, scrubbed `message`, `source` (a path on this site), `line`, `col`, `stack` (`path:line:col` frames only), `page` (`/`, `/unlock.html`, `/save` or `other`). |
| Workers Traces | `observability.traces` | Cloudflare's automatic spans: the fetch handler, D1 queries (SQL text, no bound values) and the assets binding, with timings. |
| Workers Issues | `observability.issues` | Groups 5xx responses and `console.error` lines (server failures and browser reports) into issues. Free during the beta. |
| Workers Metrics | always on | Requests, errors, CPU and wall time, from Cloudflare's analytics. |

Static files (the app, icons, `unlock.html`) are served by Workers Assets without running the
Worker, so they don't appear in logs or traces; they do count in Metrics.

## What's never recorded

- Sync keys, bearer tokens, library and slot ids, headers, request or response bodies. Routes are
  logged as templates, and `observability.logs.invocationLogs` is `false`, so Cloudflare's own
  per-request log (which records the request itself) isn't written at all.
- Query strings and fragments. `redactQueryString` strips queries from every URL in logs and
  traces, so `/save?ref=JHN.3.16` is stored as `/save`. Sync keys in app links are in the
  fragment (`/#k=…`), which never reaches the server.
- Verse text, references, emails, quoted strings and long tokens in error messages. `scrub()`
  (`public/report.js`, run again by the Worker on every report) replaces them with `…`,
  `[ref]`, `[email]` or `[redacted]`. Tests in `test/observe.test.ts` check this with real keys.

Traces do keep what Cloudflare attaches to every handler span: the URL path (which, for `/v1`,
holds the library id), the country and city, and the user agent. The id is random-looking and
isn't the key, but it does link a library's requests together for the seven days traces are kept.
Set `traces.enabled` to `false` to drop that.

## Where to look

- **Logs:** Cloudflare dashboard → Workers & Pages → `hidden-word` → Observability → Events.
  Useful filters:
  - `event = request` and `status >= 500`: server failures. Group by `route` and `error_class`.
  - `event = client_error`: browser errors. Group by `message` or `source`.
  - `event = request` and `route = /mcp`: assistant use. Group by `tools`, or filter `mcp = bad_key`.
  - Visualize `ms` (P50/P99) by `route` in the Query Builder.
- **Traces:** the same Observability tab → Traces. Open a slow `/mcp` or `/v1/lib/:lib` trace to see
  its D1 spans.
- **Issues:** Observability → Issues.
- **Metrics:** Workers & Pages → `hidden-word` → Metrics.
- **Live:** `bunx wrangler tail hidden-word --format pretty` from a machine logged in to the
  account. Tail is live and not stored. Prefer `--format pretty`: `--format json` also prints
  Cloudflare's event metadata for each request.

## Cost

Logs: about two lines per Worker request at most (one `request`, plus a `client_error` when a
browser reports one). Workers Free includes 200,000 log events a day; Workers Paid includes 20
million a month. From December 1, 2026, logs and traces share Cloudflare Observability pricing:
0.5 GB a day on Free, or 50 GB a month then $0.25/GB on Paid. A line here is about 150 bytes,
so traffic would need to grow by thousands of times before either costs anything. Browser reports
are capped at five per page load and 30 a minute per Worker instance, so a flood can't run up the
bill. If it ever matters, lower `headSamplingRate` for traces first.
