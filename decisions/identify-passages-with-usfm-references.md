# Identify passages with USFM references

Date: 2026-11-02

## Status

Accepted

## Context

Highlights only travel between apps if every app agrees on what "John 3:16" is. Apps use different book names, abbreviations, numbering systems and translations. bible-rs, the first app this format was modeled on, already stores highlights by USFM book code, chapter and verse in KJV numbering, with partial-verse offsets counted in Unicode scalar values and the highlighted words kept as a quote.

## Decision

A reference is `BOOK.chapter[.verse[-endVerse]]` with a USFM book code from the 66-book Protestant canon, KJV versification, and decimal numbers without leading zeros (`JHN.3.16`, `JHN.3.16-18`, `JUD.1.3`). Apps with other versifications map to KJV before writing.

A highlight record covers exactly one verse and holds one or more colored parts. A part may cover the whole verse, or a span given by `start`/`end` offsets in Unicode scalar values plus a `quote` of the covered words. In another translation, an app finds the quote nearest `start`, and if it isn't there, highlights the whole verse. A highlight across several verses is one record per verse. Notes may cover a chapter, verse or range.

## Consequences

- References are short, unambiguous, sortable, and the same codes route.bible and most Bible software use.
- One record per verse keeps merging simple: two devices highlighting different verses never conflict.
- Offsets are only exact in the translation they were counted in. The quote fallback keeps highlights visible across translations, at the cost of sometimes widening a partial highlight to the whole verse.
- Deuterocanonical books and non-KJV versification are out of scope for now. Adding books later is backwards compatible; changing versification would not be.
- People type references loosely, so every client needs a parser.

## Update 2026-11-02

The web app now parses with grab-bcv; see [Parse references with grab-bcv](parse-references-with-grab-bcv.md).
