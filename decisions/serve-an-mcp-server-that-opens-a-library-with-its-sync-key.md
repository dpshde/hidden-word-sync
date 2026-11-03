# Serve an MCP server that opens a library with its sync key

Date: 2026-11-03

## Status

Accepted.

## Context

People want AI assistants (Claude, Cursor, ChatGPT and other MCP clients) to read and change their highlights: "what have I highlighted in Romans?", "highlight Romans 8:28 in blue". An assistant can't run the web app, and the server can't read a library. Something has to hold the sync key to decrypt it.

The options were a local MCP server on the person's machine (the key never leaves it, but it needs installing), or a remote one on the Worker that takes the key per request (nothing to install, works from any client that speaks Streamable HTTP).

## Decision

- The Worker serves a remote MCP server at `/mcp`: Streamable HTTP, stateless, JSON-RPC over POST (initialize, ping, tools/list, tools/call). GET answers 405; there is no session and no server-to-client stream.
- The client sends the sync key in `Authorization: Bearer <sync key>` (or `X-Hidden-Word-Key`) on every request. It is parsed with the reference client's `parseKey`, and the derived keys live in memory for that request only. It is never stored, logged, or repeated in an answer: every failure answers with a fixed message, and tool errors never repeat what the caller sent.
- The MCP code (`src/mcp/`) opens the library with the reference client's `Library` and `serverTransport` (public/sync.js), syncing through the same `/v1/lib` routes every device uses, called in-process. Item ids, encryption, padding, `updated` and the merge rule are therefore exactly the ones in SPEC.md, and other devices pick up its writes on their next sync. References are read with the app's `readPassage`, and runs are grouped with the app's `groupRuns`.
- Tools: `list_highlights`, `find_highlights`, `add_highlight`, `set_highlight_color`, `delete_highlight`, `list_colors`, `get_library_info`, `get_passage_link`. No verse text is fetched.
- The rest of the server doesn't import it; the router mounts `/mcp` and hands it the route handler.

## Consequences

- For the length of each MCP request, the server *can* read that library: the key is in the Worker's memory. That is weaker than the rest of server sync, where the server never sees a key. People who connect an assistant this way trust this Worker's code (which is public) and Cloudflare's runtime with their key, the same as they trust the web app page. Observability stays off, so Cloudflare keeps no request logs for the Worker.
- An MCP client keeps the key in its own configuration. Anyone who reads that file can read and change the library, as with any copy of the key.
- A library's name lives only on devices, so `get_library_info` doesn't have one.
- Each request reads the whole library from D1 (one page per 500 items), which is fine at the sizes the limits allow.
