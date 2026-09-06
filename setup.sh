#!/usr/bin/env bash
# One-command setup: cp .env, build, and start desktop-relay.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env with defaults (edit to change the port, resolution or fps)."
fi

docker compose up -d --build

# shellcheck disable=SC1091
source .env 2>/dev/null || true

echo
echo "desktop-relay is starting (first boot pulls Chrome, can take a minute)."
echo "Once healthy, open: http://localhost:${HOST_PORT:-8094}"
echo
echo "IMPORTANT: this app has NO built-in login. Put it behind an authenticating"
echo "reverse proxy or a VPN before exposing it beyond your own machine/LAN."
