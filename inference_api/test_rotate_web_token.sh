#!/usr/bin/env bash
# Reproducible test harness for rotate_web_token.sh, against a fake `aws` -- never touches real
# AWS or the real DEPLOYED.local.md. Run: ./test_rotate_web_token.sh
#
# Covers: a clean first rotation (inserts the Atlas-stage line), a second rotation (replaces an
# existing Atlas-stage line, Passcode: line still untouched), and a stuck-update failure (Lambda
# update "succeeds" but LastUpdateStatus never reaches Successful -- the doc must stay completely
# untouched and the loud exit-trap warning must fire).
#
# Deliberately NOT `set -e`: this script accumulates pass/fail across many independent checks via
# the check() helper and a FAIL counter, which is the usual shape for that and doesn't mix well
# with errexit (a single unexpected non-zero from any check would abort the whole run early).
set -uo pipefail
cd "$(dirname "$0")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAIL=0

mkfakeaws() { # $1 = bin dir, $2 = status to report ("Successful" or "InProgress")
  mkdir -p "$1"
  cat > "$1/aws" <<FAKEAWS
#!/usr/bin/env bash
ARGS=("\$@"); IFS=' '; CMD="\${ARGS[*]}"; unset IFS
if [[ "\$CMD" == *"sts get-caller-identity"* ]]; then echo "481088927481"; exit 0; fi
if [[ "\$CMD" == *"LastUpdateStatus"* ]]; then echo "$2"; exit 0; fi
if [[ "\$CMD" == *"Environment.Variables, RevisionId"* ]]; then
  echo '{"Variables":{"WEB_TOKEN":"atlas-000000000000","ARTIFACTS_BUCKET":"janelia-das-casp-artifacts-atlas","ACCOUNT":"481088927481","REGION":"us-east-2","STAGE":"atlas"},"RevisionId":"fake-rev-1"}'
  exit 0
fi
if [[ "\$CMD" == *"update-function-configuration"* ]]; then
  for a in "\${ARGS[@]}"; do [[ "\$a" == file://* ]] && cp "\${a#file://}" "$1/last_payload.json"; done
  for i in "\${!ARGS[@]}"; do [ "\${ARGS[\$i]}" = "--revision-id" ] && echo "\${ARGS[\$((i+1))]}" > "$1/last_revision_id.txt"; done
  echo '{}'; exit 0
fi
echo "FAKE_AWS unhandled: \$CMD" >&2; exit 1
FAKEAWS
  chmod +x "$1/aws"
}

# $1 = target doc path, $2 = extra line to seed (empty string = none)
# Fixture value is an obvious dummy (all zeros) -- never a real credential, even a test one.
mkfixture() {
  cat > "$1" <<DOC
# Live deployment (do not commit)
- Passcode:   atlas-000000000000
DOC
  if [ -n "$2" ]; then
    printf '%s\n' "$2" >> "$1"
  fi
  return 0
}

mkscript() { # $1 = doc path -> writes a TTY-check-disabled copy to $WORK/rotate.sh
  sed -e "s#DEPLOYED_MD=\"\.\./DEPLOYED\.local\.md\"#DEPLOYED_MD=\"$1\"#" \
      -e 's/\[ -t 0 \] || { echo "Aborted.*/: # TTY check disabled for this test harness/' \
      rotate_web_token.sh > "$WORK/rotate.sh"
  chmod +x "$WORK/rotate.sh"
}

check() { # $1 = actual, $2 = expected, $3 = label
  if [ "$1" = "$2" ]; then
    echo "   ok: $3"
  else
    echo "   FAIL: $3 (expected '$2', got '$1')"
    FAIL=1
  fi
}
ok() { echo "   ok: $1"; }
bad() { echo "   FAIL: $1"; FAIL=1; }

echo "== scenario 1: first rotation (inserts the Atlas-stage line) =="
BIN1="$WORK/bin1"; DOC1="$WORK/doc1.md"
mkfakeaws "$BIN1" "Successful"
mkfixture "$DOC1" ""
mkscript "$DOC1"
OUT="$(PATH="$BIN1:$PATH" bash -c "echo y | '$WORK/rotate.sh'" 2>&1)"
CODE=$?
check "$CODE" "0" "exits 0"
if printf '%s' "$OUT" | grep -qE '^rotated, new token length 18, stored in DEPLOYED\.local\.md$'; then ok "final message exact"; else bad "final message wrong: $OUT"; fi
if printf '%s' "$OUT" | grep -qoE 'atlas-[0-9a-f]{12}'; then bad "secret leaked in stdout/stderr"; else ok "no secret in output"; fi
check "$(stat -c %a "$DOC1")" "600" "doc chmod 600"
if grep -qF "atlas-000000000000" "$DOC1"; then ok "Passcode: line untouched"; else bad "Passcode: line changed"; fi
check "$(grep -icE 'Atlas-stage WEB_TOKEN:[[:space:]]*atlas-[a-f0-9]{12}' "$DOC1")" "1" "exactly one Atlas-stage line"
if [ -f "$BIN1/last_revision_id.txt" ] && [ "$(cat "$BIN1/last_revision_id.txt")" = "fake-rev-1" ]; then ok "--revision-id passed through"; else bad "--revision-id missing/wrong"; fi
if [ -f "$BIN1/last_payload.json" ]; then
  PRESERVED="$(jq -r '.Variables.ARTIFACTS_BUCKET=="janelia-das-casp-artifacts-atlas" and .Variables.ACCOUNT=="481088927481" and .Variables.REGION=="us-east-2" and .Variables.STAGE=="atlas"' "$BIN1/last_payload.json")"
  CHANGED="$(jq -r '.Variables.WEB_TOKEN != "atlas-000000000000"' "$BIN1/last_payload.json")"
  if [ "$PRESERVED" = "true" ]; then ok "other env keys (ARTIFACTS_BUCKET/ACCOUNT/REGION/STAGE) preserved unchanged"; else bad "an unrelated env key was altered"; fi
  if [ "$CHANGED" = "true" ]; then ok "WEB_TOKEN actually changed from the fake 'current' value"; else bad "WEB_TOKEN was not changed"; fi
else
  bad "no payload captured to check key preservation"
fi

echo "== scenario 2: second rotation (replaces the existing Atlas-stage line) =="
BIN2="$WORK/bin2"; DOC2="$WORK/doc2.md"
mkfakeaws "$BIN2" "Successful"
mkfixture "$DOC2" "- Atlas-stage WEB_TOKEN: atlas-aaaaaaaaaaaa"
mkscript "$DOC2"
OUT2="$(PATH="$BIN2:$PATH" bash -c "echo y | '$WORK/rotate.sh'" 2>&1)"
CODE2=$?
check "$CODE2" "0" "exits 0"
check "$(grep -icE 'Atlas-stage WEB_TOKEN:' "$DOC2")" "1" "still exactly one Atlas-stage line (replaced, not duplicated)"
if grep -qF "atlas-aaaaaaaaaaaa" "$DOC2"; then bad "old Atlas-stage value was not replaced"; else ok "old Atlas-stage value replaced"; fi
if grep -qF "atlas-000000000000" "$DOC2"; then ok "Passcode: line still untouched"; else bad "Passcode: line changed"; fi

echo "== scenario 3: stuck update (LastUpdateStatus never Successful) =="
BIN3="$WORK/bin3"; DOC3="$WORK/doc3.md"
mkfakeaws "$BIN3" "InProgress"
mkfixture "$DOC3" ""
mkscript "$DOC3"
sed -i 's/for _ in \$(seq 1 30)/for _ in $(seq 1 2)/; s/sleep 2/sleep 0/' "$WORK/rotate.sh"
ORIG_DOC3="$(cat "$DOC3")"
OUT3="$(PATH="$BIN3:$PATH" bash -c "echo y | '$WORK/rotate.sh'" 2>&1)"
CODE3=$?
check "$CODE3" "1" "exits 1"
if printf '%s' "$OUT3" | grep -q "WAS updated with a new WEB_TOKEN, but"; then ok "loud warning printed"; else bad "loud warning missing"; fi
if [ "$(cat "$DOC3")" = "$ORIG_DOC3" ]; then ok "doc completely untouched"; else bad "doc was modified despite the failed update"; fi
check "$(stat -c %a "$DOC3")" "644" "doc permissions untouched"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL SCENARIOS PASSED"
else
  echo "SOME SCENARIOS FAILED -- see above" >&2
  exit 1
fi
