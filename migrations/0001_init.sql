-- A library: the SHA-256 of its bearer token (claimed by the first write) and its last seq.
CREATE TABLE libs (
  lib TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

-- The latest encrypted blob for each item id. Every write gets a new, higher seq.
CREATE TABLE items (
  lib TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (lib, id)
);
CREATE INDEX items_by_seq ON items (lib, seq);

-- A passkey's wrapped sync key, under an id derived from the passkey's PRF output.
CREATE TABLE slots (
  slot TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  wrapped TEXT NOT NULL
);
