#!/usr/bin/env bash
# Run gateway + direct-provider smoke tests and write JSON evidence under http/evidence/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_ENV="$ROOT/deploy/compose/.env"
EVIDENCE_DIR="$ROOT/http/evidence"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
INPUT="${SMOKE_INPUT:-Reply with exactly: OK}"

mkdir -p "$EVIDENCE_DIR"

if [[ ! -f "$COMPOSE_ENV" ]]; then
  echo "Missing $COMPOSE_ENV — run: make env" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$COMPOSE_ENV"

EDGE="${EDGE_HOST:-http://localhost:8080}"
DEV_IDP="${DEV_IDP_HOST:-http://localhost:4000}"

TOKEN="$(curl -sf -X POST "$DEV_IDP/token" \
  -H 'content-type: application/json' \
  -d '{"audience":"api://ai-gateway-edge","claims":{"appid":"seed-sp-appid","idtyp":"app","roles":"proj1"}}' \
  | jq -r .access_token)"

OPENAI="${AZURE_OPENAI_ENDPOINT%/}"
FOUNDRY="${AZURE_AI_FOUNDRY_ENDPOINT%/}"
FOUNDRY_KEY="${AZURE_AI_FOUNDRY_KEY:-$AZURE_OPENAI_KEY}"

run_gateway() {
  local model="$1"
  local body http text
  body="$(jq -nc --arg m "$model" --arg c "$INPUT" '{model:$m,messages:[{role:"user",content:$c}],stream:false}')"
  http="$(curl -sS -m 120 -w '%{http_code}' -o /tmp/smoke-body.json -X POST "$EDGE/v1/chat/completions" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body")"
  text="$(jq -r '.choices[0].message.content // .error.message // .error // "?"' /tmp/smoke-body.json 2>/dev/null || cat /tmp/smoke-body.json)"
  jq -nc \
    --arg model "$model" \
    --arg route "gateway" \
    --arg input "$INPUT" \
    --arg http "$http" \
    --arg result "$text" \
    --arg status "$( [[ "$http" == "200" && "$text" == "OK" ]] && echo PASS || echo FAIL )" \
    --argjson raw "$(cat /tmp/smoke-body.json)" \
    '{model:$model,route:$route,input:$input,http:($http|tonumber),result:$result,status:$status,response:$raw}'
}

run_direct() {
  local model="$1" provider="$2" url="$3" key="$4" body="$5"
  local http text
  http="$(curl -sS -m 120 -w '%{http_code}' -o /tmp/smoke-body.json -X POST "$url" \
    -H "api-key: $key" -H 'content-type: application/json' -d "$body")"
  text="$(jq -r '
    if .choices then .choices[0].message.content
    elif .output then [.output[]? | .. | objects | select(.text)? | .text] | join("")
    else .error.message // .error // "?"
    end' /tmp/smoke-body.json 2>/dev/null || cat /tmp/smoke-body.json)"
  jq -nc \
    --arg model "$model" \
    --arg route "direct" \
    --arg provider "$provider" \
    --arg input "$INPUT" \
    --arg http "$http" \
    --arg result "$text" \
    --arg status "$( [[ "$http" == "200" && "$text" == "OK" ]] && echo PASS || echo FAIL )" \
    --argjson raw "$(cat /tmp/smoke-body.json)" \
    '{model:$model,route:$route,provider:$provider,input:$input,http:($http|tonumber),result:$result,status:$status,response:$raw}'
}

GATEWAY_MODELS=(gpt-4.1 gpt-5-mini gpt-5.1-codex-mini DeepSeek-V4-Flash Kimi-K2.5)
gateway_rows=()
for m in "${GATEWAY_MODELS[@]}"; do
  gateway_rows+=("$(run_gateway "$m")")
done

direct_rows=(
  "$(run_direct gpt-4.1 azure-openai \
    "$OPENAI/openai/deployments/gpt-4.1/chat/completions?api-version=${AZURE_OPENAI_CHAT_API_VERSION}" \
    "$AZURE_OPENAI_KEY" \
    "$(jq -nc --arg c "$INPUT" '{messages:[{role:"user",content:$c}],stream:false}')")"
  "$(run_direct gpt-5-mini azure-openai \
    "$OPENAI/openai/responses?api-version=${AZURE_OPENAI_RESPONSES_API_VERSION}" \
    "$AZURE_OPENAI_KEY" \
    "$(jq -nc --arg c "$INPUT" '{model:"gpt-5-mini",input:$c,stream:false}')")"
  "$(run_direct gpt-5.1-codex-mini azure-openai \
    "$OPENAI/openai/responses?api-version=${AZURE_OPENAI_RESPONSES_API_VERSION}" \
    "$AZURE_OPENAI_KEY" \
    "$(jq -nc --arg c "$INPUT" '{model:"gpt-5.1-codex-mini",input:$c,stream:false}')")"
  "$(run_direct DeepSeek-V4-Flash azure-foundry \
    "$FOUNDRY/models/chat/completions?api-version=${AZURE_FOUNDRY_CHAT_API_VERSION}" \
    "$FOUNDRY_KEY" \
    "$(jq -nc --arg c "$INPUT" '{model:"DeepSeek-V4-Flash",messages:[{role:"user",content:$c}],stream:false}')")"
  "$(run_direct Kimi-K2.5 azure-foundry \
    "$FOUNDRY/models/chat/completions?api-version=${AZURE_FOUNDRY_CHAT_API_VERSION}" \
    "$FOUNDRY_KEY" \
    "$(jq -nc --arg c "$INPUT" '{model:"Kimi-K2.5",messages:[{role:"user",content:$c}],stream:false}')")"
)

gateway_json="$(printf '%s\n' "${gateway_rows[@]}" | jq -s '.')"
direct_json="$(printf '%s\n' "${direct_rows[@]}" | jq -s '.')"

out_gateway="$EVIDENCE_DIR/${STAMP}-gateway-smoke.json"
out_direct="$EVIDENCE_DIR/${STAMP}-direct-smoke.json"
latest_gateway="$EVIDENCE_DIR/latest-gateway-smoke.json"
latest_direct="$EVIDENCE_DIR/latest-direct-smoke.json"

jq -nc \
  --arg ts "$STAMP" \
  --arg input "$INPUT" \
  --arg edge "$EDGE" \
  --argjson rows "$gateway_json" \
  '{captured_at:$ts,input:$input,edge:$edge,results:$rows}' > "$out_gateway"
cp "$out_gateway" "$latest_gateway"

jq -nc \
  --arg ts "$STAMP" \
  --arg input "$INPUT" \
  --argjson rows "$direct_json" \
  '{captured_at:$ts,input:$input,results:$rows}' > "$out_direct"
cp "$out_direct" "$latest_direct"

echo "Wrote:"
echo "  $out_gateway"
echo "  $out_direct"
echo ""
echo "Gateway summary:"
jq -r '.results[] | "| \(.model) | \(.input) | \(.result) | \(.status) |"' "$latest_gateway"
echo ""
echo "Direct summary:"
jq -r '.results[] | "| \(.model) | \(.provider) | \(.input) | \(.result) | \(.status) |"' "$latest_direct"
