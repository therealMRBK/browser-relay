#!/bin/sh
# Adds a proxy host to a running Nginx Proxy Manager instance via its REST API.
# Run this on the NPM host/container itself (reaches NPM on localhost:81),
# or anywhere that can reach that NPM instance's admin port.
#
# Usage:
#   ./add-npm-proxy-host.sh <domain> <forward_host> <forward_port> <admin_email> <admin_password> [npm_url]
#
# Example:
#   ./add-npm-proxy-host.sh brow.example.com 192.168.1.50 8094 admin@example.com correcthorse
#
# npm_url defaults to http://localhost:81 (NPM's admin API port).

set -e

DOMAIN="$1"
FORWARD_HOST="$2"
FORWARD_PORT="$3"
EMAIL="$4"
PASSWORD="$5"
NPM_URL="${6:-http://localhost:81}"

if [ -z "$PASSWORD" ]; then
  echo "Usage: $0 <domain> <forward_host> <forward_port> <admin_email> <admin_password> [npm_url]" >&2
  exit 1
fi

echo "Logging in to $NPM_URL ..."
LOGIN_RESPONSE=$(curl -sf -X POST "$NPM_URL/api/tokens" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$EMAIL\",\"secret\":\"$PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | sed 's/"token":"//;s/"$//')

if [ -z "$TOKEN" ]; then
  echo "Login failed: $LOGIN_RESPONSE" >&2
  exit 1
fi

echo "Creating proxy host: $DOMAIN -> $FORWARD_HOST:$FORWARD_PORT ..."
curl -sf -X POST "$NPM_URL/api/nginx/proxy-hosts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"domain_names\": [\"$DOMAIN\"],
    \"forward_scheme\": \"http\",
    \"forward_host\": \"$FORWARD_HOST\",
    \"forward_port\": $FORWARD_PORT,
    \"access_list_id\": 0,
    \"certificate_id\": 0,
    \"ssl_forced\": false,
    \"block_exploits\": true,
    \"caching_enabled\": false,
    \"allow_websocket_upgrade\": false,
    \"enabled\": true
  }"

echo
echo "Done. Check the NPM UI to confirm, and set up a certificate separately if you want HTTPS."
