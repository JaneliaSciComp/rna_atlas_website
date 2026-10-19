#!/usr/bin/env bash
# Tear down the retired Atlas bridge (T-0153): HTTP API, Lambda, and the IAM role + inline
# policy deploy_bridge.sh used to create for it. NEVER touches casp-web (CASP production) --
# every target name here is hardcoded with the -atlas suffix, and the script refuses to run if
# any of them is missing it. There is no override.
#
# This is a human-run script, meant to be run only after confirming nobody still needs the
# Atlas bridge (see T-0153's CloudWatch investigation). It is not invoked by anything else in
# this repo, and nothing in this repo runs it automatically.
#
# Usage:
#   ./teardown_atlas_bridge.sh          # dry run (default): lists exactly what would be deleted
#   ./teardown_atlas_bridge.sh --apply  # actually deletes
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${PROFILE:-default}"
REGION="us-east-2"
ACCOUNT_EXPECTED="481088927481"
FN="casp-web-atlas"
ROLE="casp-web-role-atlas"
API_NAME="casp-web-api-atlas"
LOG_GROUP="/aws/lambda/$FN"
AWS=(aws --profile "$PROFILE" --region "$REGION")

if [[ "$FN" != *-atlas ]] || [[ "$ROLE" != *-atlas ]] || [[ "$API_NAME" != *-atlas ]]; then
  echo "ERROR: a target name is missing the -atlas suffix -- refusing to run." >&2
  exit 1
fi

MODE="dry-run"
case "${1:-}" in
  "") ;;
  --apply) MODE="apply" ;;
  *) echo "ERROR: unknown argument '$1' (use --apply, or nothing for a dry run)." >&2; exit 1 ;;
esac

CALLER_ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
[ "$CALLER_ACCOUNT" = "$ACCOUNT_EXPECTED" ] || {
  echo "ERROR: caller identity is account $CALLER_ACCOUNT, expected $ACCOUNT_EXPECTED. Refusing." >&2
  exit 1
}

echo "Mode: $MODE  (account $CALLER_ACCOUNT, region $REGION)"
echo

API_ID="$("${AWS[@]}" apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId" --output text 2>/dev/null || true)"
[ "$API_ID" = "None" ] && API_ID=""

echo "== Targets =="
echo "  HTTP API:      $API_NAME ${API_ID:+(id: $API_ID)}"
echo "  Lambda:        $FN"
echo "  IAM role:      $ROLE  (+ its inline policy, casp-web-policy)"
echo "  NOT deleted:   CloudWatch log group $LOG_GROUP -- left in place under its own retention"
echo "                 policy (has the Sept 2026 usage history T-0153's investigation used;"
echo "                 delete separately later if/when that's no longer wanted)."
echo

if [ "$MODE" = "dry-run" ]; then
  echo "Dry run only -- nothing deleted. Re-run with --apply to actually delete."
  exit 0
fi

echo "== Deleting =="
if [ -n "$API_ID" ]; then
  echo "API $API_NAME ($API_ID) ..."
  "${AWS[@]}" apigatewayv2 delete-api --api-id "$API_ID"
else
  echo "API $API_NAME: not found, skipping."
fi

if "${AWS[@]}" lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  echo "Lambda $FN ..."
  "${AWS[@]}" lambda delete-function --function-name "$FN"
else
  echo "Lambda $FN: not found, skipping."
fi

if "${AWS[@]}" iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "Role $ROLE: deleting inline policy casp-web-policy ..."
  "${AWS[@]}" iam delete-role-policy --role-name "$ROLE" --policy-name casp-web-policy 2>/dev/null || true
  echo "Role $ROLE: deleting role ..."
  "${AWS[@]}" iam delete-role --role-name "$ROLE"
else
  echo "Role $ROLE: not found, skipping."
fi

echo
echo "Done."
