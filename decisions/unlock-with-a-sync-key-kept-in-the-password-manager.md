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

## Update 2026-11-02, passkey on creation

Creating a library now offers a passkey in the same step. With the key saved (by 1Password's button, or by copying it), Continue first opens the passkey prompt, since WebAuthn needs a click to start, and then submits the form by itself, so the person lands in the library without another click and the password manager can still offer to save on arrival. A declined or failed passkey doesn't stop anything; the library says what happened, and "Add passkey" in the menu tries again. The passkey call names the relying party (`rp.id`) explicitly, and after 1Password's save dialog the prompt fires a second later, so the password manager has finished writing the login and can link the passkey to it (1Password's prompt prefilled no website otherwise). Passkeys made before `rp.id` was explicit used the same default and keep working.

## Update 2026-11-02, passkey after creation

Offering the passkey before submitting broke saving on iPhone. iOS (and the 1Password AutoFill provider it hands to) only offers to save a password when the form is submitted straight from the person's tap. Continue started the passkey prompt and submitted the form afterwards by script, so iOS treated the submission as the page's, not the person's, and never asked. Now Continue only submits the form, so the save prompt can appear, and the library screen that loads next shows an optional "Add a passkey" button with "Not now" beside it. It uses the same code as "Add passkey" in the menu, and it shows only right after creating a library in a browser that supports passkeys. The passkey costs one more tap, which is the price of the key being saved reliably.

## Update, 2026-11-03: the person pastes the key

Even with a real submission straight from the Continue tap, Safari and 1Password offered no save on the live site. What was left was that the page itself put the key in the password field. Now the new key is shown as text with Copy, the password field starts empty, and the person pastes the key into it before Continue; a key that doesn't match is refused. Closing 1Password's save-button dialog still counts as Continue, filling the field itself since 1Password already has the key.

## Update 2026-11-03

A lost key is still unrecoverable, so the app says so where it matters. The new-library screen says the key can't be reset or recovered and that anyone who has it can read the library, and Continue still needs the key pasted back. The start page and `/unlock` have a "Lost your sync key?" disclosure: look in the password manager, use a passkey if there is one, or read the key on a device that's still unlocked (••• → Show sync key); failing that, start a new library and Import an exported file.

## Update 2026-11-03, a shorter menu

The ••• menu held seven equal items and read as dense. It now holds Sync, Colors and Backup, then Log out after a divider. "Show sync key" and "Add passkey" moved to a "Your key" row at the top of the Sync screen, with the same behavior: the key shows on that screen until hidden, and a passkey is added the same way. Export and Import moved to a Backup screen. The lost-key help points to those places.
