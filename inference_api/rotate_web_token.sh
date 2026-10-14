#!/usr/bin/env bash
# Rotate the WEB_TOKEN (shared passcode) on the ATLAS inference bridge Lambda ONLY.
#
# T-0153: the current token equals the old Atlas website passcode, which was exposed, so it
# needs a fresh value unrelated to anything that was ever public.
#
# SCOPE, non-negotiable: this script rotates casp-web-atlas and NOTHING else. casp-web (no
# suffix) is the live CASP-competition production bridge (see deploy_bridge.sh's STAGE=prod
# default) -- it must never be touched here. There is no override: FN is a fixed constant, not
# an env var, and the script refuses to run if given any argument at all.
#
# This is a human-run admin script (needs ADMIN/SSO creds, same as deploy_bridge.sh) -- it is
# not meant to be invoked unattended, and it asks for confirmation before mutating anything.
#
# Safety properties:
#   - reads the CURRENT Lambda environment and replaces ONLY the WEB_TOKEN key -- every other
#     env var (ARTIFACTS_BUCKET, ACCOUNT, REGION, STAGE, ...) is carried over unchanged, exactly
#     as it is live right now, not reconstructed from scratch.
#   - the new value has the same shape deploy_bridge.sh's reader expects (:30,
#     `atlas-[a-f0-9]{12}`), so that script keeps working unmodified.
#   - the updated environment is written to AWS via a 0600 temp file (--environment file://...),
#     never as a --environment Variables={...} CLI argument -- the token is never on argv, so it
#     never lands in shell history or `ps`.
#   - waits for LastUpdateStatus=Successful before touching DEPLOYED.local.md, so the doc is
#     never updated for a change that didn't actually take effect.
#   - the new token value is held only in memory for this run; it is never echoed, logged, or
#     printed anywhere, including the confirmation prompt.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$#" -ne 0 ]; then
  echo "ERROR: rotate_web_token.sh takes no arguments -- it only ever rotates casp-web-atlas." >&2
  exit 1
fi

PROFILE="${PROFILE:-default}"
REGION="us-east-2"
FN="casp-web-atlas"
[ "$FN" = "casp-web-atlas" ] && [ "$FN" != "casp-web" ]   # redundant on purpose; see header
AWS="aws --profile $PROFILE --region $REGION"
DEPLOYED_MD="../DEPLOYED.local.md"

command -v jq >/dev/null || { echo "ERROR: jq is required." >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 is required." >&2; exit 1; }
command -v openssl >/dev/null || { echo "ERROR: openssl is required." >&2; exit 1; }
[ -f "$DEPLOYED_MD" ] || { echo "ERROR: $DEPLOYED_MD not found." >&2; exit 1; }

echo "This will rotate WEB_TOKEN on Lambda function: $FN  (region $REGION, profile $PROFILE)"
echo "It will NOT touch casp-web (CASP production). The new value is never printed."
read -r -p "Continue? [y/N] " CONFIRM
[ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ] || { echo "Aborted, nothing changed."; exit 1; }

echo "== 1/5: fetching current environment for $FN =="
CUR_ENV_JSON="$($AWS lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)"
[ -n "$CUR_ENV_JSON" ] && [ "$CUR_ENV_JSON" != "null" ] || { echo "ERROR: could not read current environment for $FN." >&2; exit 1; }
echo "$CUR_ENV_JSON" | jq -e 'has("WEB_TOKEN")' >/dev/null || {
  echo "ERROR: $FN's current environment has no WEB_TOKEN key -- refusing to guess; check the function by hand." >&2
  exit 1
}

echo "== 2/5: generating the new token =="
NEW_TOKEN="atlas-$(openssl rand -hex 6)"   # same shape as deploy_bridge.sh:30 expects

echo "== 3/5: writing the updated environment (WEB_TOKEN replaced, everything else unchanged) =="
TMP_ENV_FILE="$(mktemp)"
chmod 600 "$TMP_ENV_FILE"
trap 'rm -f "$TMP_ENV_FILE"' EXIT
jq -n --argjson vars "$CUR_ENV_JSON" --arg tok "$NEW_TOKEN" \
  '{Variables: ($vars + {WEB_TOKEN: $tok})}' > "$TMP_ENV_FILE"
$AWS lambda update-function-configuration --function-name "$FN" --environment "file://$TMP_ENV_FILE" >/dev/null

echo "== 4/5: waiting for LastUpdateStatus=Successful =="
STATUS=""
for _ in $(seq 1 30); do
  STATUS="$($AWS lambda get-function-configuration --function-name "$FN" --query 'LastUpdateStatus' --output text)"
  case "$STATUS" in
    Successful) break ;;
    Failed) echo "ERROR: Lambda update failed (LastUpdateStatus=Failed)." >&2; exit 1 ;;
    *) sleep 2 ;;
  esac
done
[ "$STATUS" = "Successful" ] || { echo "ERROR: timed out waiting for LastUpdateStatus=Successful (last seen: $STATUS)." >&2; exit 1; }
echo "   LastUpdateStatus: Successful"

echo "== 5/5: updating $DEPLOYED_MD =="
python3 - "$DEPLOYED_MD" "$NEW_TOKEN" <<'PY'
import re, sys
path, new = sys.argv[1], sys.argv[2]
with open(path) as f:
    text = f.read()
new_text, n = re.subn(r"atlas-[a-f0-9]{12}", new, text, count=1, flags=re.IGNORECASE)
if n != 1:
    sys.exit(f"ERROR: expected exactly one atlas-<12hex> occurrence in {path} to replace, found {n}.")
with open(path, "w") as f:
    f.write(new_text)
PY
echo "   updated (value not printed)"

echo
echo "Done. WEB_TOKEN rotated on $FN and DEPLOYED.local.md updated. Nothing above printed the"
echo "token value. Run verify_web_token.sh to confirm end-to-end without needing the old value."
