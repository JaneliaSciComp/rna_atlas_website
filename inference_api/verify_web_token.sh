#!/usr/bin/env bash
# Read-only verification that casp-web-atlas's WEB_TOKEN rotation (rotate_web_token.sh) is live
# and self-consistent. Does NOT need the old value. Never prints the token anywhere -- it is
# held in an exported env var only long enough to (a) compare it and (b) send it in one
# read-only POST body, never on argv/in a URL/query-string (so it never lands in `ps`,
# /proc/<pid>/cmdline, or CloudFront/API Gateway access logs).
#
# Scope: casp-web-atlas only, same hard constant as rotate_web_token.sh. Mutates nothing.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${PROFILE:-default}"
REGION="us-east-2"
FN="casp-web-atlas"
AWS=(aws --profile "$PROFILE" --region "$REGION")
DEPLOYED_MD="../DEPLOYED.local.md"
ATLAS_LABEL="Atlas-stage WEB_TOKEN:"
# The exact env key set deploy_bridge.sh manages (main.tf equivalent for this hand-rolled
# bridge) -- a mismatch here means something other than a clean WEB_TOKEN-only rotation
# touched this function.
EXPECTED_KEYS='["ACCOUNT","ARTIFACTS_BUCKET","REGION","STAGE","WEB_TOKEN"]'
INFER_API="https://4noypwoqq4.execute-api.us-east-2.amazonaws.com"   # casp-web-atlas, hard-coded
# (not read from .infer_api: that file lives at the repo root, can point at a different stack
# entirely -- e.g. a prior run left .infer_api.prod-backup -- so it is not a reliable source
# of truth for which API this verify run is actually checking.)
FAIL=0

echo "== 1/6: Lambda update status =="
STATUS="$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'LastUpdateStatus' --output text)"
echo "   LastUpdateStatus: $STATUS"
[ "$STATUS" = "Successful" ] || { echo "   FAIL: expected Successful"; FAIL=1; }

echo "== 2/6: env key set unchanged =="
LIVE_KEYS_JSON="$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json | jq -c 'keys')"
if [ "$LIVE_KEYS_JSON" = "$EXPECTED_KEYS" ]; then
  echo "   OK: {$(echo "$EXPECTED_KEYS" | jq -r 'join(", ")')}"
else
  echo "   FAIL: expected keys $EXPECTED_KEYS, got $LIVE_KEYS_JSON"; FAIL=1
fi

echo "== 3/6: deployed token shape =="
export LIVE_TOKEN="$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables.WEB_TOKEN' --output text)"
if echo "$LIVE_TOKEN" | grep -qiE '^atlas-[a-f0-9]{12}$'; then
  echo "   shape OK (value not printed)"
else
  echo "   FAIL: WEB_TOKEN missing or wrong shape"; FAIL=1
fi

echo "== 4/6: matches $DEPLOYED_MD's Atlas-stage line =="
DOC_TOKEN="$(grep -ioE "${ATLAS_LABEL}[[:space:]]*atlas-[a-f0-9]{12}" "$DEPLOYED_MD" 2>/dev/null | grep -oiE 'atlas-[a-f0-9]{12}' | head -1 || true)"
if [ -n "$DOC_TOKEN" ] && [ "$LIVE_TOKEN" = "$DOC_TOKEN" ]; then
  echo "   MATCH (values not printed)"
else
  echo "   FAIL: Lambda env and $DEPLOYED_MD's '$ATLAS_LABEL' line disagree (or doc has no such line)"; FAIL=1
fi

echo "== 5/6: end-to-end, read-only (POST /jobs, token in body) =="
CODE="$(printf '{"token":"%s"}' "$LIVE_TOKEN" | curl -s -o /dev/null -w '%{http_code}' \
  -X POST -H 'content-type: application/json' --data-binary @- "$INFER_API/jobs")"
if [ "$CODE" = "200" ]; then
  echo "   POST /jobs (correct token) -> 200"
else
  echo "   FAIL: POST /jobs (correct token) -> $CODE (expected 200)"; FAIL=1
fi

echo "== 6/6: no-token request is still refused =="
CODE_NOTOKEN="$(printf '{}' | curl -s -o /dev/null -w '%{http_code}' \
  -X POST -H 'content-type: application/json' --data-binary @- "$INFER_API/jobs")"
if [ "$CODE_NOTOKEN" = "403" ]; then
  echo "   POST /jobs (no token) -> 403, as expected"
else
  echo "   FAIL: POST /jobs (no token) -> $CODE_NOTOKEN (expected 403 -- is WEB_TOKEN accidentally empty?)"; FAIL=1
fi
unset LIVE_TOKEN

echo
if [ "$FAIL" -eq 0 ]; then
  echo "All checks passed. Token value never printed above."
else
  echo "One or more checks FAILED -- see above. Token value never printed above." >&2
  exit 1
fi
