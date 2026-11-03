# Resolve conflicts with one merge rule

Date: 2026-11-02

## Status

Accepted. Replaces the version 0.1 behavior, where the server's arrival order decided which version of a record won.

## Context

Devices change records while offline, sync in any order, and can reach each other through different transports (a folder for some, a server for others). In version 0.1 the server kept whichever version arrived last. That made results depend on network timing, gave folders no rule at all, and let a slow or restored server overwrite newer edits.

The library has to end up the same on every device whatever order changes arrive in, with no coordinator.

## Decision

Every device, file and transport applies one rule (SPEC.md section 3):

- Of two versions of a record, the one with the larger `updated` (Unix seconds) wins. On a tie, the one whose JSON text is larger as UTF-8 bytes wins. A missing `updated` counts as 0.
- When an app changes a record, it sets `updated` to the larger of the current time and one more than the version it replaces, so an edit always beats what it was made from, even with a slow clock.
- A device keeps an incoming version only if it wins. Nothing else replaces or deletes a record.

Servers store blobs they can't read, so they never apply the rule; clients do, and re-push their own version when it beats the server's.

## Consequences

- Merging is commutative, associative and idempotent, so devices converge regardless of path, delay or transport.
- Changes to different records never conflict. Concurrent changes to the same record keep the later one; the earlier one is lost unless an app chooses to combine highlight parts into a new version.
- A device with a clock far in the future can win conflicts it shouldn't. The `+1` rule limits the damage from slow clocks but not fast ones.
- The tie-break compares exact serialized text, so writers must not reformat records they did not change.

## Update 2026-11-02: stamps and note history

To match bible-rs (see [Join bible-rs Study Libraries as a bible-rs device](join-bible-rs-study-libraries-as-a-bible-rs-device.md)), versions are ordered by a millisecond stamp and then device id before the JSON text. Notes merge by their edit history: a concurrent edit keeps the losing text as a conflict copy. The rule is still one rule, applied the same on every device and transport (spec section 3).

