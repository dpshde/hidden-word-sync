# Connect apps with an unlock redirect

Date: 2026-11-02

## Status

Accepted

## Context

A person with a library should be able to connect a new Bible app as easily as "Sign in with…", without copying a key by hand. OAuth itself needs a server that issues tokens, client registration, and scopes, none of which fit a system with no accounts where the key is the only credential.

## Decision

A Selah Vault site offers `/unlock?app=<name>&callback=<url>`. It asks the person to unlock a library (or reuse the one unlocked in that browser), then asks "Give <app> access to <library>?". Allow sends the browser to `<callback>#k=<key>&name=<name>`; Cancel sends `#error=denied`.

Callbacks must be `https:`, a custom scheme, or `http:` on loopback. `javascript:`, `data:`, `blob:`, `file:` and similar are refused, and the consent screen shows the callback's host.

## Consequences

- The flow feels like OAuth consent and needs no server-side state; fragments never reach servers.
- The app receives the whole key, so access is all-or-nothing and can't be revoked except by moving to a new library. Scoped or revocable access would need a new decision.
- Any site that hosts the static pages can serve this flow, so apps aren't tied to one deployment.
