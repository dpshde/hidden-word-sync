-- A library's blob characters, kept up to date by every write, so a write checks the size limit
-- without adding up every item in the library.
ALTER TABLE libs ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
UPDATE libs SET size = (SELECT COALESCE(SUM(LENGTH(blob)), 0) FROM items WHERE items.lib = libs.lib);
