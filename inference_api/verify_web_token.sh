#!/usr/bin/env bash
# Read-only verification that casp-web-atlas's WEB_TOKEN rotation (rotate_web_token.sh) is live
# and self-consistent. Does NOT need the old value. Never prints the token anywhere -- it is
# held in a shell variable only long enough to (a) compare it and (b) use it in one read-only
# API call, both without echoing it.
#
# Scope: casp-web-atlas only, same hard constant as rotate_web_token.sh. Mutates nothing.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${PROFILE:-default}"
REGION="us-east-2"
FN="casp-web-atlas"
AWS="aws --profile $PROFILE --region $REGION"
DEPLOYED_MD="../DEPLOYED.local.md"
FAIL=0

echo "== 1/4: Lambda update status =="
STATUS="$($AWS lambda get-function-configuration --function-name "$FN" --query 'LastUpdateStatus' --output text)"
echo "   LastUpdateStatus: $STATUS"
[ "$STATUS" = "Successful" ] || { echo "   FAIL: expected Successful"; FAIL=1; }

echo "== 2/4: deployed token shape =="
LIVE_TOKEN="$($AWS lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables.WEB_TOKEN' --output text)"
if echo "$LIVE_TOKEN" | grep -qiE '^atlas-[a-f0-9]{12}$'; then
  echo "   shape OK (value not printed)"
else
  echo "   FAIL: WEB_TOKEN missing or wrong shape"; FAIL=1
fi

echo "== 3/4: matches $DEPLOYED_MD =="
DOC_TOKEN="$(grep -ioE 'atlas-[a-f0-9]{12}' "$DEPLOYED_MD" 2>/dev/null | head -1 || true)"
if [ -n "$DOC_TOKEN" ] && [ "$LIVE_TOKEN" = "$DOC_TOKEN" ]; then
  echo "   MATCH (values not printed)"
else
  echo "   FAIL: Lambda env and $DEPLOYED_MD disagree (or doc has no token line)"; FAIL=1
fi

echo "== 4/4: end-to-end, read-only (GET /jobs) =="
if [ -f .infer_api ]; then
  INFER_API="$(tr -d '\n' < .infer_api)"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$INFER_API/jobs?t=$LIVE_TOKEN")"
  if [ "$CODE" = "200" ]; then
    echo "   GET /jobs -> 200 (token accepted)"
  else
    echo "   FAIL: GET /jobs -> $CODE (expected 200)"; FAIL=1
  fi
else
  echo "   skipped: .infer_api not found here (run from a host that has it, or export INFER_API=...)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "All checks passed. Token value never printed above."
else
  echo "One or more checks FAILED -- see above. Token value never printed above." >&2
  exit 1
fi
