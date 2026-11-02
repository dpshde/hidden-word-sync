-- An epoch: a random id fixed when a library is first written. When a client sees it change, the
-- server has lost the library (erased, reset or restored), and the client sends everything again.
ALTER TABLE libs ADD COLUMN epoch TEXT NOT NULL DEFAULT '';
UPDATE libs SET epoch = lower(hex(randomblob(12))) WHERE epoch = '';
