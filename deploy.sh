#!/usr/bin/env bash
# Renders wrangler.toml from wrangler.template.toml using the local .env,
# then forwards every argument to wrangler.
#
#   ./deploy.sh deploy
#   ./deploy.sh dev
#   ./deploy.sh d1 execute telegram-rss --remote --file=schema.sql
#   ./deploy.sh secret put API_KEY
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "error: .env not found. Create it with: D1_DATABASE_ID=<id from 'wrangler d1 create telegram-rss'>" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [[ -z "${D1_DATABASE_ID:-}" ]]; then
  echo "error: D1_DATABASE_ID is empty in .env" >&2
  exit 1
fi

# the id is pasted into a sed expression, so allow only characters a D1 id can contain
if [[ ! "$D1_DATABASE_ID" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "error: D1_DATABASE_ID in .env has unexpected characters (expected letters, digits, dashes)" >&2
  exit 1
fi

placeholder="__D1_DATABASE_ID__"
if ! grep -qF "$placeholder" wrangler.template.toml; then
  echo "error: wrangler.template.toml has no $placeholder placeholder (use: database_id = \"$placeholder\")" >&2
  exit 1
fi

# replace the placeholder; everything else in the template is copied unchanged
sed "s|$placeholder|$D1_DATABASE_ID|g" wrangler.template.toml > wrangler.toml

exec npx wrangler "$@"
