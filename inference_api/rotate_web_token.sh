#!/usr/bin/env bash
# Rotate the WEB_TOKEN (shared passcode) on the ATLAS inference bridge Lambda ONLY.
#
# T-0153: the current token equals the old Atlas website passcode, which was exposed, so it
# needs a fresh value unrelated to anything that was ever public.
#
# SCOPE, non-negotiable: this script rotates casp-web-atlas and NOTHING else. casp-web (no
# suffix) is the live CASP-competition production bridge (see deploy_bridge.sh's STAGE=prod
# default) -- it must never be touched here, and its token is NOT rotated by this ticket (that
# is a separate decision). There is no override: FN is a fixed constant, not an env var, and
# the script refuses to run if given any argument at all.
#
# This is a human-run admin script (needs ADMIN/SSO creds, same as deploy_bridge.sh) -- it is
# not meant to be invoked unattended, and it asks for confirmation before mutating anything.
#
# Safety properties:
#   - refuses to run unless the caller's AWS account is exactly the expected one.
#   - reads the CURRENT Lambda environment and replaces ONLY the WEB_TOKEN key -- every other
#     env var (ARTIFACTS_BUCKET, ACCOUNT, REGION, STAGE, ...) is carried over unchanged.
#   - the new value has the same shape deploy_bridge.sh's prod reader expects
#     (atlas-[a-f0-9]{12}).
#   - NEITHER the old nor the new token value is ever passed as a CLI argument to anything
#     (jq, python3, aws) -- argv is visible to other users on a shared host via
#     /proc/<pid>/cmdline, unlike the process environment. Both tokens travel only via
#     exported env vars that the child process reads itself, or via files.
#   - the updated environment is written to AWS via a 0600 temp file (--environment file://...).
#   - the doc's shape is validated BEFORE any AWS write happens, so a malformed
#     DEPLOYED.local.md is caught before the Lambda is touched, not after.
#   - if the Lambda update is accepted but anything after that point fails (the wait for
#     LastUpdateStatus=Successful times out or fails, or the doc write itself fails), an EXIT
#     trap prints a loud, impossible-to-miss warning that the live token and the documented
#     token now disagree -- it never fails silently.
#   - DEPLOYED.local.md is rewritten atomically (temp file in the same directory, 0600 from
#     creation, then os.replace) -- never truncated in place, never briefly world/group
#     readable mid-write.
#   - writes its OWN labelled "Atlas-stage WEB_TOKEN:" line, never touching the existing
#     "Passcode:" line that deploy_bridge.sh's STAGE=prod path reads (see T-0153 investigation:
#     casp-web and casp-web-atlas currently share that one value; touching it would silently
#     push this rotation onto CASP production the next time someone runs the prod deploy).
#   - the new token value is never echoed, logged, or printed anywhere, including the
#     confirmation prompt; only its length is printed at the end.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$#" -ne 0 ]; then
  echo "ERROR: rotate_web_token.sh takes no arguments -- it only ever rotates casp-web-atlas." >&2
  exit 1
fi
[ -t 0 ] || { echo "Aborted: not running interactively (stdin is not a TTY)." >&2; exit 1; }

PROFILE="${PROFILE:-default}"
REGION="us-east-2"
FN="casp-web-atlas"
ACCOUNT_EXPECTED="481088927481"
[ "$FN" = "casp-web-atlas" ] && [ "$FN" != "casp-web" ]   # redundant on purpose; see header
AWS=(aws --profile "$PROFILE" --region "$REGION")         # array: PROFILE never word-splits
DEPLOYED_MD="../DEPLOYED.local.md"
ATLAS_LABEL="Atlas-stage WEB_TOKEN:"

command -v jq >/dev/null || { echo "ERROR: jq is required." >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 is required." >&2; exit 1; }
command -v openssl >/dev/null || { echo "ERROR: openssl is required." >&2; exit 1; }
[ -f "$DEPLOYED_MD" ] || { echo "ERROR: $DEPLOYED_MD not found." >&2; exit 1; }

echo "== checking caller identity =="
CALLER_ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
[ "$CALLER_ACCOUNT" = "$ACCOUNT_EXPECTED" ] || {
  echo "ERROR: caller identity is account $CALLER_ACCOUNT, expected $ACCOUNT_EXPECTED. Refusing." >&2
  exit 1
}

echo "== checking $DEPLOYED_MD's current shape (before touching anything live) =="
EXISTING_COUNT="$(grep -icF "$ATLAS_LABEL" "$DEPLOYED_MD" || true)"
if [ "$EXISTING_COUNT" -gt 1 ]; then
  echo "ERROR: $DEPLOYED_MD has $EXISTING_COUNT '$ATLAS_LABEL' lines -- ambiguous, fix by hand first." >&2
  exit 1
fi
if [ "$EXISTING_COUNT" -eq 0 ]; then
  grep -qE '^- Passcode:' "$DEPLOYED_MD" || {
    echo "ERROR: no '- Passcode:' anchor line found to insert the new label after." >&2
    exit 1
  }
fi

LAMBDA_UPDATE_CALLED=0
DOC_UPDATED=0
TMP_ENV_FILE=""
on_exit() {
  local code=$?
  if [ "$LAMBDA_UPDATE_CALLED" = 1 ] && [ "$DOC_UPDATED" != 1 ]; then
    {
      echo
      echo "########################################################################"
      echo "## $FN WAS updated with a new WEB_TOKEN, but $DEPLOYED_MD was NOT.    ##"
      echo "## The live token and the documented token now disagree. Fix the doc  ##"
      echo "## by hand (or rerun this script) before anyone relies on it again.   ##"
      echo "########################################################################"
    } >&2
  fi
  [ -n "$TMP_ENV_FILE" ] && rm -f "$TMP_ENV_FILE"
  exit "$code"
}
trap on_exit EXIT

echo "This will rotate WEB_TOKEN on Lambda function: $FN  (account $CALLER_ACCOUNT, region $REGION)"
echo "It will NOT touch casp-web (CASP production). The new value is never printed."
read -r -p "Continue? [y/N] " CONFIRM
[ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ] || { echo "Aborted, nothing changed."; exit 1; }

echo "== 1/5: fetching current environment for $FN =="
CUR_ENV_JSON="$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json)"
[ -n "$CUR_ENV_JSON" ] && [ "$CUR_ENV_JSON" != "null" ] || { echo "ERROR: could not read current environment for $FN." >&2; exit 1; }
printf '%s' "$CUR_ENV_JSON" | jq -e 'has("WEB_TOKEN")' >/dev/null || {
  echo "ERROR: $FN's current environment has no WEB_TOKEN key -- refusing to guess; check the function by hand." >&2
  exit 1
}

echo "== 2/5: generating the new token =="
export NEW_TOKEN="atlas-$(openssl rand -hex 6)"   # same shape deploy_bridge.sh's prod reader expects

echo "== 3/5: writing the updated environment (WEB_TOKEN replaced, everything else unchanged) =="
TMP_ENV_FILE="$(mktemp)"
chmod 600 "$TMP_ENV_FILE"
# $CUR_ENV_JSON (contains the OLD token) goes in via stdin, never argv; NEW_TOKEN goes in via
# jq's `env.NEW_TOKEN`, reading the exported env var -- neither ever appears in this process's
# command line.
printf '%s' "$CUR_ENV_JSON" | jq '{Variables: (. + {WEB_TOKEN: env.NEW_TOKEN})}' > "$TMP_ENV_FILE"
"${AWS[@]}" lambda update-function-configuration --function-name "$FN" --environment "file://$TMP_ENV_FILE" >/dev/null
LAMBDA_UPDATE_CALLED=1

echo "== 4/5: waiting for LastUpdateStatus=Successful =="
STATUS=""
for _ in $(seq 1 30); do
  STATUS="$("${AWS[@]}" lambda get-function-configuration --function-name "$FN" --query 'LastUpdateStatus' --output text)"
  case "$STATUS" in
    Successful) break ;;
    Failed) echo "ERROR: Lambda update failed (LastUpdateStatus=Failed)." >&2; exit 1 ;;
    *) sleep 2 ;;
  esac
done
[ "$STATUS" = "Successful" ] || { echo "ERROR: timed out waiting for LastUpdateStatus=Successful (last seen: $STATUS)." >&2; exit 1; }
echo "   LastUpdateStatus: Successful"

echo "== 5/5: updating $DEPLOYED_MD (atomic, 0600, never touching the Passcode: line) =="
python3 - "$DEPLOYED_MD" <<'PY'
import os, re, sys, tempfile

path = sys.argv[1]
new = os.environ["NEW_TOKEN"]          # never on argv
label_re = re.compile(r"Atlas-stage WEB_TOKEN:\s*atlas-[a-f0-9]{12}", re.IGNORECASE)
new_line = f"Atlas-stage WEB_TOKEN: {new}"

with open(path) as f:
    text = f.read()

matches = label_re.findall(text)
if len(matches) > 1:
    sys.exit(f"ERROR: {len(matches)} '{new_line.split(':')[0]}:' lines found -- ambiguous.")
elif len(matches) == 1:
    new_text = label_re.sub(new_line, text, count=1)
else:
    anchor = re.search(r"^- Passcode:.*$", text, re.MULTILINE)
    if not anchor:
        sys.exit("ERROR: no '- Passcode:' anchor line found to insert after.")
    i = anchor.end()
    new_text = text[:i] + f"\n- {new_line}" + text[i:]

dirpath = os.path.dirname(os.path.abspath(path)) or "."
fd, tmp_path = tempfile.mkstemp(dir=dirpath)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(new_text)
    os.replace(tmp_path, path)
except Exception:
    os.unlink(tmp_path)
    raise
PY
DOC_UPDATED=1

echo
echo "rotated, new token length ${#NEW_TOKEN}, stored in DEPLOYED.local.md"
