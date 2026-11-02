# Use colors as categories instead of bookmarks

Date: 2026-11-02

## Status

Accepted. Version 0.1 had a `bookmark` record kind; version 0.2 removes it.

## Context

Version 0.1 had highlights, notes and bookmarks. In practice a bookmark is a verse you marked to come back to, which is what a highlight already is. People also use highlight colors as categories (promises, prayer, questions), and want to name them and add their own.

## Decision

Drop bookmarks. Add `color` records:

- Six built-in color ids: `yellow`, `green`, `blue`, `pink`, `purple`, `orange`. A `color` record with a built-in `ref` gives it a `name`.
- A library can add custom colors with a random id (`c-` plus random characters), a `name`, a `hex` value, and a `created` time that orders them after the built-ins.
- A highlight whose color is unknown or deleted shows as yellow. Apps recolor highlights before deleting a color.
- bible-rs bookmarks are left out on import.

## Consequences

- One mechanism (highlight + named color) covers bookmarks and categories, and the web app can filter by color.
- Color names sync like any record and merge by the same rule.
- Apps that don't support custom colors still show those highlights, as yellow, so nothing disappears.
- Anyone who relied on 0.1 bookmarks has to re-mark them as highlights. There were no released 0.1 clients, so the cost is nil.
