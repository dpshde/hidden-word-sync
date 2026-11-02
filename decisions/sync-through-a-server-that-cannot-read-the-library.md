# Sync through a server that can't read the library

Date: 2026-11-02

## Status

Accepted

## Context

Some people want sync without managing a folder, across devices that share none. A server makes that easy, but a server is also where privacy goes wrong: accounts, email addresses, password resets, logs of what people read. The project should be free to run, so the server has to be small and cheap, and anyone should be able to run a compatible one.

## Decision

The server is a dumb store of encrypted blobs with no accounts:

- A 16-byte random sync key, shown as 28 Crockford base32 characters with a check byte, derives everything through HKDF-SHA256: the library id, a bearer token, an AES-256-GCM key and an HMAC key.
- Each record is one item. Its id is a truncated HMAC of `kind ref`, so the server can't tell which verse it is. Its blob is the record's JSON padded to 256-byte steps and encrypted with the item id as associated data.
- Three routes over HTTPS and JSON: `GET /v1/lib/{lib}?after=seq`, `POST /v1/lib/{lib}`, `DELETE /v1/lib/{lib}`. The first write claims a library by storing the token's SHA-256. Every write gets a higher `seq`.
- The server stores only what it must. Observability is off.

## Consequences

- The server learns item counts, timing, IP addresses and blob sizes in 256-byte steps. It does not learn verses, colors, notes, names or keys.
- Implementing a client needs only HTTPS, JSON, SHA-256, HMAC, HKDF and AES-GCM, all in WebCrypto and every mainstream platform. `test/vectors.json` pins the cryptography.
- Holding the sync key is the only access control. Losing the key (and every passkey) means losing the server copy; device and folder copies remain readable. There is no reset.
- The server can withhold or roll back data. Clients handle that through the merge rule and the epoch (see [Detect server data loss with an epoch](detect-server-data-loss-with-an-epoch.md)).
- Anyone can run a compatible server, so the project's own deployment is a convenience, not a dependency.
