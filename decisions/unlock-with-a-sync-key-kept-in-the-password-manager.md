# Unlock with a sync key kept in the password manager

Date: 2026-11-02

## Status

Accepted

## Context

The sync key is a 28-character secret with no reset. People lose secrets like that unless something stores them for them. The person who started the project uses 1Password and wants the sign-up to feel like any other website's: the password manager offers to save, and later fills the form. Passkeys are welcome, but they're bound to the website that created them, so they can't be the only way in.

## Decision

The sync key is treated as a password, and the library name as its username.

- Creating a library shows a real `<form>` with `autocomplete="username"` and `autocomplete="new-password"` fields, and the person submits it. The app calls `navigator.credentials.store(new PasswordCredential(…))` where available (Chromium's save prompt), then navigates with `history.pushState`, which is how 1Password, Safari and Chrome recognize a completed sign-up. After that, the key is cleared from the form.
- Unlocking uses `autocomplete="current-password"` so password managers fill it.
- Optionally, a passkey with the WebAuthn PRF extension unlocks without typing: the PRF output derives a slot id, a slot token and a key-encryption key, and the server stores the sync key wrapped under that key.

## Consequences

- 1Password, iCloud Keychain, Google Password Manager, Bitwarden and browsers' built-in managers all work without integration code.
- The server never sees a password: the key never leaves the device except inside a password manager or wrapped by a passkey.
- Passkeys only work on the site that created them, so they're a convenience; the saved key is what works in other apps.
- Whether a given password manager actually prompts depends on its heuristics. The real save prompt and passkeys can't be exercised in automated tests and need manual checks.
