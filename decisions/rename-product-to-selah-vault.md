# Rename the product to Selah Vault

Date: 2026-11-03

## Status

Accepted.

## Context

The app has lived at vault.selah.tools since the domain move, beside route.bible and the other selah.tools apps, but it still called itself Hidden Word. People see one name in the address bar and another on the page. The old name is also built into the protocol. It's in the key derivations, the library file header, the MCP server's id, the browser's storage, and the Worker and repo names. Existing devices, libraries, folder files, passkeys and connected apps depend on those exact strings.

## Decision

- The product is **Selah Vault**, and **Vault** where space is tight: the start page's wordmark, the manifest's `short_name`, and the home-screen title (`apple-mobile-web-app-title`).
- Everything people read says Selah Vault: page titles, the manifest `name`, meta and Open Graph tags, on-page copy, the README, SPEC.md's prose, the MCP server's `title` and instructions, the passkey's `rp.name` (new passkeys only), and the Backup export's file name (`selah-vault-<date>.jsonl`).
- Identifiers keep the old name, because changing any of them would break a device, file, passkey or client that already exists:
  - the HKDF info strings `hidden-word/v1/…` and the PRF input `hidden-word/v1/prf`
  - the library file header field `"hidden-word": 2`
  - the `X-Hidden-Word-Key` header and the `realm="hidden-word"` challenge
  - the MCP server's `serverInfo.name` (`hidden-word`)
  - the `hidden-word:*` localStorage keys
  - the IndexedDB database and the folder picker's id (`hidden-word`)
  - the Worker (`hidden-word`), its D1 database and its old workers.dev address
  - the WebAuthn `rp.id`, which stays the hostname
- The repo moved to `dpshde/selah-vault` after this was written (GitHub redirects `dpshde/hidden-word-sync`), and the older decision records now say Selah Vault too, so one name reads through the history. This record keeps the old name where it explains the change.

## Consequences

- Nothing a user or app already has needs to change. Existing passkeys keep the name they were made with until they're added again.
- The spec and README say once that the product was formerly Hidden Word, so the identifiers don't look like a mistake.
- A future major version of the protocol could rename the identifiers. That would be a breaking change under [Promise a stable 1.0 contract](promise-a-stable-1-0-contract.md).
