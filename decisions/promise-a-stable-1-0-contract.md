# Promise a stable 1.0 contract

Date: 2026-11-03

## Status

Accepted.

## Context

Other apps can only build on Selah Vault if the format, the derivations and the server routes stop moving. Version 0.2 made no promise, and there was no way to check an implementation beyond `test/vectors.json`.

## Decision

- SPEC.md is version 1.0, with no wire changes from 0.2. Section 11 lists what every 1.x keeps, what counts as breaking (only in 2.0, under `/v2/` and new HKDF infos), what may be added, and how deprecation works.
- Where the spec and the reference implementation disagreed, the spec now says what the code does: `updated` counts only as a safe integer, a repeated id in one POST keeps the later one, `after` must be a non-negative integer, preflights allow `Authorization` and `Content-Type`.
- `conformance/` holds a server checker (`bun run conformance <base-url>`) and client fixtures. `bun test` runs both against the reference Worker and client, so CI keeps them honest. The checker never runs against production from CI.
- The MCP endpoint and the Worker's other extras stay outside the contract.

## Consequences

- A change to anything in section 11's list now needs a new major version, so it needs a strong reason.
- A third-party server can show it conforms by running one command, and a client by replaying one file.
- The checker makes and deletes one library with a random key on the server it's pointed at.
