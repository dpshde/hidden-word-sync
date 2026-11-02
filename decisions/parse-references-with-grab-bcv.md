# Parse references with grab-bcv

Date: 2026-11-02

## Status

Accepted. The web app's own parser (`parseRef` in `public/refs.js`) is retired.

## Context

People type references loosely ("jn 3.16", "1 Cor 13:4-7", "Phlm 6") and paste links from Bible apps. The web app had its own small parser. grab-bcv, by the same author, already handles natural text, OSIS refs, verse lists, cross-chapter ranges, typo correction, verse-count limits, and links from bible.com, BibleGateway, Logos and route.bible. Save links (`/save?ref=…`) make that breadth matter, because apps will send whatever they have.

The web app has no build step ([Build the web app without a framework](build-the-web-app-without-a-framework.md)), and grab-bcv's package root bundles about 280 KB of paragraph data the app doesn't need.

## Decision

The web app parses everything people enter with grab-bcv, through `public/passage.js`:

- `bun run vendor` bundles only grab-bcv's `parse` and `books` sub-paths into `public/vendor/grab-bcv.js` (about 28 KB, minified ESM). The bundle is committed; grab-bcv is a pinned dev dependency.
- `readPassage(text)` tries grab-bcv's single-passage parser first (in 0.1.7 it reads "jn 3.16" and "I John 4:8" correctly where the any-passage parser doesn't), then the any-passage parser for links, free text and verse lists. It reads "Jude 3" as Jude 1:3, since books of one chapter are cited by verse alone. It expands the result to whole verses, at most 500.
- `public/refs.js` keeps only canonical-ref helpers (labels, sorting) that the sync code also uses.

## Consequences

- Typing, pasting a link, and save links all accept the same, much wider set of inputs, with specific errors ("John has 21 chapters.").
- Updating grab-bcv means bumping the version and running `bun run vendor`.
- When grab-bcv's any-passage parser is fixed for the inputs above, `readPassage` can call it alone.
- The format is unchanged: grab-bcv's canonical refs are the same USFM codes as [Identify passages with USFM references](identify-passages-with-usfm-references.md).
