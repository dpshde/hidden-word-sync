# Observe the Worker with redacted logs and traces

Date: 2026-11-03

## Status

Accepted. Updates the observability note in [Serve an MCP server that opens a library with its sync key](serve-an-mcp-server-that-opens-a-library-with-its-sync-key.md).

## Context

Observability was off, so that Cloudflare kept nothing about the people using the server. That also
meant a failure, a slow route or a broken page in someone's browser went unseen. The server is
blind by design, and the MCP server holds a sync key in memory for each request, so whatever is
turned on must not record keys, tokens, ids, references or verse text.

Cloudflare offers Workers Logs (custom lines plus an automatic invocation log per request),
Workers Traces (automatic spans, OpenTelemetry), Workers Issues, Workers Metrics (always on),
Analytics Engine, Tail Workers and Logpush, and real-time `wrangler tail`.

## Decision

- Turn on Workers Logs with the invocation log off. The Worker writes one structured line per
  request itself (`src/observe.ts`): method, route template, status, time, and for failures the
  error class and a scrubbed message. The invocation log records the request (URL, headers,
  metadata), which is the part we can't control.
- Turn on Workers Traces at full sampling, and `redactQueryString`, which strips query strings in
  logs and traces. Turn on Workers Issues.
- Add a same-origin browser error report (`public/report.js` → `POST /api/client-error`): the
  error's class, a scrubbed message, and code locations on this site. The Worker rebuilds and
  scrubs every field, caps the body at 4 KB and reports at 30 a minute per instance; the page
  sends at most five.
- Not Analytics Engine: Workers Logs already counts by route, status and error class, and reading
  Analytics Engine needs an API token and a SQL client. Not Logpush, Tail Workers or an
  OpenTelemetry export: they send data to a third party or to another Worker, and nothing needs
  them yet. Not a third-party error tracker: the CSP allows only this site's scripts.

## Consequences

- Cloudflare now keeps a week of request lines and traces for the Worker (three days on Workers
  Free). None of it holds a key, token, body or query string; tests check this with real keys.
- Traces keep the URL path (with the library id), country, city and user agent that Cloudflare
  attaches to every span. That links one library's requests for seven days. Turning traces off
  removes it.
- Durations come from `Date.now()`, which in Workers advances only across I/O, so `ms` measures
  time spent waiting on D1 and assets, not CPU.
- docs/observability.md lists where to look and what it costs.
