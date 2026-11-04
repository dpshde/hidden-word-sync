-- Grants: limited, expiring tokens a library's owner gives another app (/connect). The server
-- keeps only the token's SHA-256 hash. `scopes` is a space-separated list; v1 knows only "read".
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  lib TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  client TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX grants_lib ON grants (lib);
