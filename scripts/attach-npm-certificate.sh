#!/bin/sh
# Attaches an existing NPM certificate (matched by exact domain_names entry,
# e.g. a wildcard like "*.example.com") to an existing NPM proxy host.
# Run this on the NPM host/container itself, or anywhere reaching its
# admin API (port 81 by default).
#
# Requires `node` for JSON handling -- present in the official NPM image
# since NPM's own backend runs on it.
#
# Usage:
#   ./attach-npm-certificate.sh <host_domain> <cert_domain_match> <admin_email> <admin_password> [npm_url]
#
# Example (note the quotes around the wildcard so the shell doesn't glob it):
#   ./attach-npm-certificate.sh brow.example.com "*.example.com" admin@example.com correcthorse

set -e

HOST_DOMAIN="$1"
CERT_MATCH="$2"
EMAIL="$3"
PASSWORD="$4"
NPM_URL="${5:-http://localhost:81}"

if [ -z "$PASSWORD" ]; then
  echo "Usage: $0 <host_domain> <cert_domain_match> <admin_email> <admin_password> [npm_url]" >&2
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

echo "Looking up certificate matching '$CERT_MATCH' ..."
CERTS=$(curl -sf "$NPM_URL/api/nginx/certificates" -H "Authorization: Bearer $TOKEN")
CERT_ID=$(echo "$CERTS" | node -e '
  let data = "";
  process.stdin.on("data", d => data += d);
  process.stdin.on("end", () => {
    const certs = JSON.parse(data);
    const match = certs.find(c => (c.domain_names || []).includes(process.argv[1]));
    if (!match) process.exit(1);
    console.log(match.id);
  });
' "$CERT_MATCH" || true)

if [ -z "$CERT_ID" ]; then
  echo "No certificate found with domain_names entry '$CERT_MATCH'. Available certificates:" >&2
  echo "$CERTS" | node -e '
    let data = "";
    process.stdin.on("data", d => data += d);
    process.stdin.on("end", () => {
      JSON.parse(data).forEach(c => console.log(c.id, JSON.stringify(c.domain_names)));
    });
  ' >&2
  exit 1
fi
echo "Found certificate id=$CERT_ID"

echo "Looking up proxy host '$HOST_DOMAIN' ..."
HOSTS=$(curl -sf "$NPM_URL/api/nginx/proxy-hosts" -H "Authorization: Bearer $TOKEN")
HOST_JSON=$(echo "$HOSTS" | node -e '
  let data = "";
  process.stdin.on("data", d => data += d);
  process.stdin.on("end", () => {
    const hosts = JSON.parse(data);
    const match = hosts.find(h => (h.domain_names || []).includes(process.argv[1]));
    if (!match) process.exit(1);
    console.log(JSON.stringify(match));
  });
' "$HOST_DOMAIN" || true)

if [ -z "$HOST_JSON" ]; then
  echo "No proxy host found for domain '$HOST_DOMAIN'." >&2
  exit 1
fi

HOST_ID=$(echo "$HOST_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).id));')
echo "Found proxy host id=$HOST_ID"

UPDATED_BODY=$(echo "$HOST_JSON" | node -e '
  let data = "";
  process.stdin.on("data", d => data += d);
  process.stdin.on("end", () => {
    const host = JSON.parse(data);
    host.certificate_id = parseInt(process.argv[1], 10);
    host.ssl_forced = true;
    host.http2_support = true;
    console.log(JSON.stringify(host));
  });
' "$CERT_ID")

echo "Attaching certificate $CERT_ID to host $HOST_ID ..."
curl -sf -X PUT "$NPM_URL/api/nginx/proxy-hosts/$HOST_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$UPDATED_BODY"

echo
echo "Done."
