#!/usr/bin/env bash
# Deploy the explorer to S3 + CloudFront using the non-expiring atlas-deployer IAM profile.
#
# Staging workflow:  ./deploy.sh dev   ->  test at .../dev/   ->  ./deploy.sh promote
#
#   ./deploy.sh dev        # web shell -> dev/  (reuses PROD data via DATA_BASE="..") + invalidate /dev/*
#   ./deploy.sh promote    # server-side copy dev/ shell -> root (ship the exact bytes you tested)
#   ./deploy.sh            # web shell + data jsons -> root (production)
#   ./deploy.sh full       # production, and also re-sync structs/ + react/ + datasets/ from dist/
set -euo pipefail
P=atlas-deployer
B=s3://rnanix/atlas_explorer
DIST=E2CV6KWMNI7AQP
CF=ddc01lh56i5th.cloudfront.net
cd "$(dirname "$0")"

# Refuse to upload a config.js that contains anything credential-shaped. There is no shared
# Anthropic key anywhere in this architecture (client or server-side proxy) -- each user sets
# their own key in their own browser (web/agent.js localStorage "atlas_claude_key"). A shared
# key (window.CLAUDE_KEY) leaked in 2026-07 by being injected here; see
# docs/incident_2026-07_claude_key_leak.md. Do not reintroduce a shared key of any kind.
assert_safe_config() {
  local cfg="$1"
  if grep -Eq "CLAUDE_KEY|CLAUDE_PROXY|sk-ant-[A-Za-z0-9_-]{10,}" <<<"$cfg"; then
    echo "ERROR: generated config.js contains a credential-shaped or shared-key string (CLAUDE_KEY / CLAUDE_PROXY / sk-ant-...). Refusing to upload." >&2
    exit 1
  fi
}

# Re-fetch the config.js that was just published from S3 (not just the local variable) and
# re-run the same check against the live bytes, so a bad publish is caught before invalidation
# rather than left live and cached at the edge.
verify_published_config() {
  local pfx="$1" live
  live=$(aws --profile $P s3 cp "$B/${pfx}config.js" - --only-show-errors)
  if grep -Eq "CLAUDE_KEY|CLAUDE_PROXY|sk-ant-[A-Za-z0-9_-]{10,}" <<<"$live"; then
    echo "ERROR: published ${pfx}config.js contains a credential-shaped or shared-key string -- aborting before invalidation." >&2
    exit 1
  fi
}

SHELL_FILES="index.html app.js agent.js style.css viz_style.js ss.js datasets.js"

# deploy the web shell to a prefix with a generated (target-specific) config.js.
#   $1 = dest prefix ("" for root, "dev/" for dev)   $2 = DATA_BASE value
deploy_shell() {
  local pfx="$1" db="$2"
  for f in $SHELL_FILES; do
    [ -f "web/$f" ] && aws --profile $P s3 cp "web/$f" "$B/${pfx}$f" --only-show-errors && echo "  ${pfx}$f"
  done
  # config.js is generated per-target (web/config.js is the local-dev one and is never uploaded).
  # There is NO Anthropic key here, shared or otherwise — each user sets their own key in their
  # own browser (web/agent.js). A shared client-side key (window.CLAUDE_KEY) leaked in 2026-07;
  # see docs/incident_2026-07_claude_key_leak.md. Do not add one back, client or server-side.
  CFG=$(printf 'window.DATA_BASE = "%s";\nwindow.GATED = true;\n' "$db")
  [ -f .infer_api ] && CFG="$CFG"$'\n'"window.INFER_API = \"$(tr -d '\n' < .infer_api)\";"
  assert_safe_config "$CFG"
  printf '%s\n' "$CFG" \
    | aws --profile $P s3 cp - "$B/${pfx}config.js" --content-type application/javascript --only-show-errors \
    && echo "  ${pfx}config.js  (DATA_BASE=\"$db\"$([ -f .infer_api ] && echo ' +INFER_API'))"
  verify_published_config "$pfx"
  for lf in web/lib/*.js; do bn=$(basename "$lf"); aws --profile $P s3 cp "$lf" "$B/${pfx}lib/$bn" --only-show-errors && echo "  ${pfx}lib/$bn"; done
  # /inference subpage -- ROOT inference/ is no longer this repo's: it's the live RNAnix
  # inference app (Cognito-backed), deployed by rna-atlas-inference/scripts/deploy_frontend.sh
  # (see ticket T-0071). Only ever touch it under dev/, where the old v1 copy is intentionally
  # left in place until T-0041 decides its fate -- never under the root/prod prefix.
  if [ -n "$pfx" ]; then
    for f in web/inference/*; do [ -f "$f" ] && aws --profile $P s3 cp "$f" "$B/${pfx}inference/$(basename "$f")" --only-show-errors && echo "  ${pfx}inference/$(basename "$f")"; done
  fi
  # static image assets (favicon set + header/gate logos)
  for f in claude.png icon.png logo_exp.png favicon.ico favicon-16x16.png favicon-32x32.png \
           apple-touch-icon.png android-chrome-192x192.png android-chrome-512x512.png site.webmanifest; do
    [ -f "web/$f" ] && aws --profile $P s3 cp "web/$f" "$B/${pfx}$f" --only-show-errors && echo "  ${pfx}$f"
  done
}

invalidate() {
  aws --profile $P cloudfront create-invalidation --distribution-id $DIST --paths "$1" \
      --query 'Invalidation.Status' --output text
}

# Upload a JSON file gzip-compressed (content-encoding: gzip). CloudFront's automatic compression
# is capped at 10 MB, and folds.json for the large I–Q datasets is ~40 MB, so pre-gzip here (JSON
# compresses ~7-10x). The client fetch() (getJSON, cache:"no-cache") decompresses transparently.
put_json_gz() {
  gzip -c "$1" | aws --profile $P s3 cp - "$2" --content-encoding gzip --content-type application/json --only-show-errors
}

push_data() {
  echo "data ..."
  for f in folds motifs pairing; do
    [ -f "data/$f.json" ] && aws --profile $P s3 cp "data/$f.json" "$B/data/$f.json" \
        --content-type application/json --only-show-errors && echo "  data/$f.json"
  done
}

push_heavy() {
  # `|| true`: aws s3 sync returns non-zero if it skips a vanished/missing source file;
  # with set -e that would abort the whole deploy mid-way (and skip later datasets). A few
  # missing structs are non-fatal, so don't let them kill the run.
  echo "structs/ + react/ + datasets/ from dist/ ..."
  aws --profile $P s3 sync dist/react   "$B/react"   --only-show-errors || true
  aws --profile $P s3 sync dist/structs "$B/structs" --content-encoding gzip --content-type text/plain --only-show-errors || true
  for ds in dist/datasets/*/; do
    [ -d "$ds" ] || continue; name=$(basename "$ds")
    echo "dataset $name ... (under /data/ so the existing passcode gate covers it)"
    for j in "$ds/data"/*.json; do [ -f "$j" ] && put_json_gz "$j" "$B/data/datasets/$name/data/$(basename "$j")" && echo "  data/$(basename "$j") (gz)"; done
    aws --profile $P s3 sync "$ds/structs" "$B/data/datasets/$name/structs" --content-encoding gzip --content-type text/plain --only-show-errors || true
    [ -d "$ds/react" ] && aws --profile $P s3 sync "$ds/react" "$B/data/datasets/$name/react" --content-type application/json --only-show-errors || true
  done
}

case "${1:-prod}" in
  dev)
    echo "deploy -> dev/ (web shell only; data served from root via DATA_BASE=\"..\")"
    deploy_shell "dev/" ".."
    echo "invalidating /dev/* ..."; invalidate "/dev/*"
    echo "done — https://$CF/dev/   (and https://rna-atlas.org/dev/ once DNS is live)"
    ;;
  promote)
    echo "promote dev/ shell -> root (server-side copy of the tested bytes)"
    # inference/* deliberately excluded (T-0071): root inference/ is the live RNAnix inference
    # app owned by rna-atlas-inference/scripts/deploy_frontend.sh, not this repo's dev/ copy.
    for f in $SHELL_FILES lib/3Dmol-min.js lib/three.min.js lib/OrbitControls.js claude.png \
             icon.png logo_exp.png favicon.ico favicon-16x16.png favicon-32x32.png \
             apple-touch-icon.png android-chrome-192x192.png android-chrome-512x512.png site.webmanifest; do
      aws --profile $P s3 cp "$B/dev/$f" "$B/$f" --only-show-errors && echo "  $f"
    done
    CFG=$(printf 'window.DATA_BASE = "";\nwindow.GATED = true;\n')
    [ -f .infer_api ] && CFG="$CFG"$'\n'"window.INFER_API = \"$(tr -d '\n' < .infer_api)\";"
    assert_safe_config "$CFG"
    printf '%s\n' "$CFG" \
      | aws --profile $P s3 cp - "$B/config.js" --content-type application/javascript --only-show-errors \
      && echo "  config.js  (prod$([ -f .infer_api ] && echo ' +INFER_API'))"
    verify_published_config ""
    echo "invalidating /* ..."; invalidate "/*"
    echo "done — promoted to https://rna-atlas.org/"
    ;;
  full)
    echo "deploy -> root (production) + heavy assets"
    push_data; deploy_shell "" ""; push_heavy
    echo "invalidating /* ..."; invalidate "/*"
    echo "done — https://rna-atlas.org/"
    ;;
  prod)
    echo "deploy -> root (production)"
    push_data; deploy_shell "" ""
    echo "invalidating /* ..."; invalidate "/*"
    echo "done — https://rna-atlas.org/"
    ;;
  *)
    echo "usage: ./deploy.sh [dev|promote|prod|full]" >&2; exit 1 ;;
esac
