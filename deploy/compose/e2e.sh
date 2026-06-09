#!/bin/sh
set -eu

apk add --no-cache curl jq >/dev/null

EDGE_URL="${EDGE_URL:-http://edge:8080}"
DEV_IDP_URL="${DEV_IDP_URL:-http://dev-idp:4000}"
EDGE_AUDIENCE="${EDGE_AUDIENCE:-api://ai-gateway-edge}"

mint_token() {
  claims="$1"
  curl -sf -X POST "${DEV_IDP_URL}/token" \
    -H 'content-type: application/json' \
    -d "{\"audience\":\"${EDGE_AUDIENCE}\",\"claims\":${claims}}" \
    | jq -r .access_token
}

echo "==> mint SP client token (seed-sp-appid)"
SP_TOKEN="$(mint_token '{"appid":"seed-sp-appid","idtyp":"app","roles":"proj1"}')"
test -n "$SP_TOKEN"

echo "==> 401 without bearer"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${EDGE_URL}/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","messages":[]}')"
test "$STATUS" = "401"

echo "==> 200 allowed chat model via edge → gateway"
RESP="$(curl -sf -X POST "${EDGE_URL}/v1/chat/completions" \
  -H "authorization: Bearer ${SP_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","messages":[]}')"
echo "$RESP" | jq -e '.stub == true and .model == "gpt-5.4" and .principal == "seed-sp-appid"' >/dev/null

echo "==> 200 allowed messages model"
curl -sf -X POST "${EDGE_URL}/v1/messages" \
  -H "authorization: Bearer ${SP_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-4-6","messages":[]}' \
  | jq -e '.stub == true and .model == "claude-opus-4-6"' >/dev/null

echo "==> 403 disallowed model"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${EDGE_URL}/v1/chat/completions" \
  -H "authorization: Bearer ${SP_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5-mini","messages":[]}')"
test "$STATUS" = "403"

echo "==> mint user client token (seed-user-oid)"
USER_TOKEN="$(mint_token '{"oid":"seed-user-oid","idtyp":"user"}')"

echo "==> 200 allowed user chat model"
curl -sf -X POST "${EDGE_URL}/v1/chat/completions" \
  -H "authorization: Bearer ${USER_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5-mini","messages":[]}' \
  | jq -e '.stub == true and .principal == "seed-user-oid"' >/dev/null

echo "==> edge /health"
curl -sf "${EDGE_URL}/health" | jq -e '.status == "ok"' >/dev/null

echo "==> gateway /ready via edge proxy (unauthenticated)"
curl -sf "${EDGE_URL}/ready" | jq -e '.status == "ready"' >/dev/null

echo "All compose E2E checks passed."
