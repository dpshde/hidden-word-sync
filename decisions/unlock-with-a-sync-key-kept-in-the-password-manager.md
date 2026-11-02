# Unlock with a sync key kept in the password manager

Date: 2026-11-02

## Status

Accepted

## Context

The sync key is a 28-character secret with no reset. People lose secrets like that unless something stores them for them. The person who started the project uses 1Password and wants the sign-up to feel like any other website's: the password manager offers to save, and later fills the form. Passkeys are welcome, but they're bound to the website that created them, so they can't be the only way in.

## Decision

The sync key is treated as a password, and the library name as its username.

- Creating a library shows a real `<form>` with `autocomplete="username"` and `autocomplete="new-password"` fields, and the person submits it. (As first built, the app called `navigator.credentials.store(new PasswordCredential(…))` and navigated with `history.pushState`; see the update below.)
- Unlocking uses `autocomplete="current-password"` so password managers fill it.
- Optionally, a passkey with the WebAuthn PRF extension unlocks without typing: the PRF output derives a slot id, a slot token and a key-encryption key, and the server stores the sync key wrapped under that key.

## Consequences

- 1Password, iCloud Keychain, Google Password Manager, Bitwarden and browsers' built-in managers all work without integration code.
- The server never sees a password: the key never leaves the device except inside a password manager or wrapped by a passkey.
- Passkeys only work on the site that created them, so they're a convenience; the saved key is what works in other apps.
- Whether a given password manager actually prompts depends on its heuristics. The real save prompt and passkeys can't be exercised in automated tests and need manual checks.

## Update 2026-11-02

In the first live test, 1Password in Chrome did not offer to save. The form set the key by script (no input events) and cancelled the submission, so 1Password saw neither typing nor a sign-up. Now the app dispatches `input` and `change` events after filling the key, and lets the form really submit as a `GET` to `/` that reloads into the new library. A `formdata` handler empties the submission, so the request carries no fields; the key reaches the new page through localStorage. The `PasswordCredential` call was dropped, since the real submission is what Chrome's own manager needs too.

## Update 2026-11-02, later

With those changes 1Password still didn't offer to save. The new-library screen now also shows 1Password's own save button; see [Offer 1Password's save button](offer-1password-s-save-button.md). This record's "without integration code" still holds for every other password manager.
