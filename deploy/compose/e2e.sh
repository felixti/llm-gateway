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
  -d '{"model":"gpt-4.1","messages":[]}')"
test "$STATUS" = "401"

assert_chat_ok() {
  echo "$1" | jq -e '
    (.stub == true and .model != null)
    or (.object == "chat.completion" and (.choices | length) > 0)
  ' >/dev/null
}

echo "==> 200 allowed chat model via edge → gateway"
RESP="$(curl -sf -X POST "${EDGE_URL}/v1/chat/completions" \
  -H "authorization: Bearer ${SP_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}')"
assert_chat_ok "$RESP"

echo "==> 200 allowed messages model (Kimi-K2.5)"
RESP="$(curl -sf -X POST "${EDGE_URL}/v1/messages" \
  -H "authorization: Bearer ${SP_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"Kimi-K2.5","messages":[{"role":"user","content":"hi"}]}')"
assert_chat_ok "$RESP"

echo "==> 403 disallowed model"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${EDGE_URL}/v1/chat/completions" \
  -H "authorization: Bearer ${SP_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"unknown-model","messages":[]}')"
test "$STATUS" = "403"

echo "==> mint user client token (seed-user-oid)"
USER_TOKEN="$(mint_token '{"oid":"seed-user-oid","idtyp":"user"}')"

echo "==> 200 allowed user chat model"
RESP="$(curl -sf -X POST "${EDGE_URL}/v1/chat/completions" \
  -H "authorization: Bearer ${USER_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"hi"}]}')"
assert_chat_ok "$RESP"

echo "==> edge /health"
curl -sf "${EDGE_URL}/health" | jq -e '.status == "ok"' >/dev/null

echo "==> gateway /ready via edge proxy (unauthenticated)"
curl -sf "${EDGE_URL}/ready" | jq -e '.status == "ready"' >/dev/null

echo "All compose E2E checks passed."
