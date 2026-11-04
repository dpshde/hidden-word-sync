# Style the app like route.bible

Date: 2026-11-03

## Status

Accepted.

## Context

Selah Vault and route.bible are both selah.tools apps, and route.bible links into Selah Vault. They looked unrelated: Selah Vault used the system font, rounded corners and a neutral palette.

## Decision

- Take route.bible's design language from its source (`static/css/tokens.css` and friends): Lexend for text, Geist for small uppercase labels, its warm-paper light palette and true-black dark palette, square corners, inverted blocks for the primary action and section bars, and a 3px brand edge on hovered rows and messages.
- Self-host the fonts in `public/fonts/`, unmodified, with their SIL OFL 1.1 licenses beside them. The app still loads nothing from other servers.
- Keep every layout decision as it was: the compact row icons, rows that keep their size while edited, the Date | Genre groups, the four-item menu, the highlight colors and the icon.
- Light-mode muted text is a step darker than route.bible's (`#6a6156`, 5.3:1 on the page) so it keeps 4.5:1 everywhere it appears.

## Consequences

- About 115 KB of font files, cached after the first visit. `font-display: swap` shows text in the fallback stack until they arrive.
- route.bible's dark-mode grain overlay is left out, and its hairlines are a little lighter here so the list's separators show.
