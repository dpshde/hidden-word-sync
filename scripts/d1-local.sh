#!/bin/sh
# Applies D1 migrations to the local state `cf dev` uses (.wrangler/state).
set -eu
id=$(sed -n 's/.*id: "\([0-9a-f-]\{36\}\)".*/\1/p' cloudflare.config.ts | head -n 1)
cf d1 migrations apply "$id" --local --dir migrations --persist-to .wrangler/state </dev/null
