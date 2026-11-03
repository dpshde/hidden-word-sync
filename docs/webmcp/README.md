# WebMCP tools (in-page)

The web app registers three [WebMCP](https://github.com/webmachinelearning/webmcp) tools on
`document.modelContext`, so a browser agent can work with the library that is open in that tab.
Code: `public/webmcp.js`, registered from the end of `public/app.js`. Browsers without WebMCP
skip it entirely.

These are different from the remote MCP server at `/mcp`. That one opens a library with the sync
key sent on every request. These tools only act on a library the user has already unlocked on the
page. They never read, return or ask for the key, and they don't touch sync settings or transports.
Changes go through the same code as the buttons, so they sync like any other edit.

Designed with Google's `build-webmcp-tools` skill in Autonomous Mode (Stages 1–6, self-critique).

| Tool | What it does | Annotations |
| --- | --- | --- |
| `find_highlights` | Highlights in Bible order, optionally within a book or passage or one color, 12 per page, each with its color and a clipped quote. Also lists the library's color names. | `readOnlyHint`, `untrustedContentHint` (quotes and color names are user-written) |
| `add_highlight` | Highlights or recolors every verse of a reference as typed. Yellow by default. Shows the usual "Saved … Undo" line. | none |
| `delete_highlights` | Removes the highlights in a reference here and, on their next sync, on other devices. Shows "Deleted … Undo". | `consequentialHint` |

`schema.json` is the tool contract (a test keeps it identical to the code). `evals.json` is the
`webmcp-evals` suite: `npx webmcp-evals local -t docs/webmcp/schema.json -e docs/webmcp/evals.json`
(needs a model provider key in `.env`; not run yet).

## Stage 1: goals

1. **Save a verse I'm looking at** (the main thing people do). Outcome: the verses are highlighted in the color asked for. Context: an unlocked library. Boundary: never unlock, create or switch libraries, and never handle the key.
2. **Find what I highlighted** in a book, passage or color. Outcome: a short, paged list. Context: an unlocked library. Boundary: read-only.
3. **Remove a highlight.** Outcome: those verses are no longer highlighted on any device. Boundary: deletion reaches every device, so it's marked consequential (the agent confirms first), and Undo stays on screen.
4. *(Not built)* Sync settings, passkeys, the key, export and import, and color editing. They're security-sensitive or rare, and they stay in the UI.

## Stages 2–4 (per goal, self-critiqued)

- **Starting states:** locked (start screen) or unlocked on the main list. Any tool on a locked page returns `LIBRARY_LOCKED`, telling the agent to have the user unlock on the page and never to ask for the key in chat. That's eval 6.
- **Save:** "highlight Romans 8:28 in green" → `add_highlight` → `{status:"saved", reference:"Romans 8:28", color:"Green", verses:1}` → the row appears with the Saved/Undo line. Variations: no color → yellow; an unknown color → `COLOR_NOT_FOUND`, and the agent checks `find_highlights` colors (eval 7); not a reference → `NOT_A_REFERENCE` with the parser's sentence; over 500 verses → the parser's limit message.
- **Find:** "what have I highlighted in Romans?" → `find_highlights({within:"Romans"})`. "rom", "Ps 23" and "John 3" all work. Nothing matched → `total_count: 0` plus a suggestion to widen the search. "The second one" resolves against `highlights[1].reference`.
- **Remove:** "remove my highlight in Psalm 23" → find, then `delete_highlights` on the run's reference (eval 5). Nothing highlighted there → `NOTHING_HIGHLIGHTED`.
- **Self-critique:** replies stay short and use the user's color names. The agent asks when the reference is missing. The only consequential tool is delete. Adding is undoable and routine, so it isn't flagged. Quotes and color names are user-written, so the read tool is marked untrusted.

## Verification

- `test/webmcp.test.ts` (bun): every tool against a real `Library`. It covers the locked state, colors by name, Undo, book and passage filters, paging, the 1,500-character output budget, schema parity with `schema.json`, and that no output contains the sync key.
- Headless Chrome for Testing 156 with `--enable-features=WebMCP`, serving `public/` with `/v1` stubbed offline: `getTools()` lists all three tools. On the locked page they return `LIBRARY_LOCKED`. On a throwaway local library, `add_highlight` drew the row and the Saved/Undo line, `find_highlights({within:"Romans"})` found it, and `delete_highlights` split Romans 5:3–5 into 5:3 and 5:5. No output contained the key.
- Not yet done: the DevTools Application > WebMCP pane by hand, Lighthouse "Agentic browsing", and `webmcp-evals` model runs.
