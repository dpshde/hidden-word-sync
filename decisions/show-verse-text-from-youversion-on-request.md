# Show verse text from YouVersion on request

Date: 2026-11-03

## Status

Accepted.

## Context

Hidden Word stores references, not Bible text, and opens passages in route.bible. Reading a highlight without leaving the list needs text from somewhere. [scripture-inline](https://github.com/cameronapak/scripture-inline) (Cameron Pak, MIT), already vendored for the add field, has `<si-passage>`, which shows a passage from the YouVersion Platform with its required attribution. It needs a YouVersion public app key. The key is public by design, but the repository is public too, and it shouldn't carry it.

## Decision

- Each row has a book icon between its text and its Open icon. Tapping it shows the row's passage under the row in the Berean Standard Bible (version 3034), without a reference line, following the system theme. One passage is open at a time. Nothing is fetched until someone taps, so YouVersion hears only about passages a person opens, never the whole library.
- The rest of the row still opens route.bible; the book icon is its own button above the row's link.
- The key is the Worker secret `YVP_PUBLIC_APP_KEY`, served at `GET /config.json` as `{"yvpPublicAppKey": …}`. The app reads it at startup; without one, the book icon doesn't show.
- The page scanner, `scriptureInline()`, isn't used.
- The CSP allows `https://api.youversion.com` (passages, and its fonts stylesheet) and `https://cdn.youversion.com` (bible.css) for styles and requests, plus the component's shadow `<style>` by hash. Web fonts stay blocked: the text uses the system serif, so YouVersion's and Google's font files aren't needed.

## Consequences

- Opening a passage's text sends its reference and the app key to YouVersion. Highlights, notes and colors never leave the device that way.
- Rotating the key is `wrangler secret put YVP_PUBLIC_APP_KEY`; no deploy or commit.
- Blocked font requests log CSP warnings in the console when text opens. They are harmless.
