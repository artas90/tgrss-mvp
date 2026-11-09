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

command -v envsubst >/dev/null || { echo "error: envsubst missing (install gettext)" >&2; exit 1; }

# only this one variable is substituted; any other $ in the template is left alone
envsubst '${D1_DATABASE_ID}' < wrangler.template.toml > wrangler.toml

exec npx wrangler "$@"
