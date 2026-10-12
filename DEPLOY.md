# Deploy: S3 website (shell + data) behind CloudFront

Everything — the web shell *and* the data — lives under one S3 prefix and is served through a
single CloudFront distribution (HTTPS). One origin ⇒ **no CORS**. The source code lives in a
**private** git repo (version control only; it does not serve the site).

```
  https://<dist>.cloudfront.net/                -> index.html, app.js, ... (shell)
  https://<dist>.cloudfront.net/data|structs|react/...  -> data
        |
  s3://rnanix/atlas_explorer/   (private; CloudFront reads it via OAC)
```

Access control: as of T-0140 (2026-10), this site no longer has a client-side passcode. Access is
enforced at the CloudFront edge by a Lambda@Edge viewer-request function checking Cognito group
membership (`app:atlas`) — maintained in a separate repo, not this one. The old `atlas-explorer-gate`
CloudFront Function (passcode-only, `/data/ /structs/ /react/`) has been retired.

## 1. Build everything into dist/

```bash
mamba activate rna
cd /groups/das/home/zouinkhim/atlas_explorer
python build_feature_table.py     # data/folds.json, motifs.json (if not current)
python build_static.py            # dist/ = shell + config.js + data/ structs/ react/
```

`dist/config.js` is generated with `DATA_BASE=""` (same-origin).

## Updating the live site (non-expiring deployer)

A scoped IAM user **`atlas-explorer-deployer`** (profile `[atlas-deployer]` in `~/.aws/credentials`,
**long-lived keys — no SSO expiry**) can push updates. It can only write `rnanix/atlas_explorer/*` and
invalidate distribution `E2CV6KWMNI7AQP`. Just run:

```bash
./deploy.sh            # data jsons + web shell + CloudFront invalidation
./deploy.sh full       # also re-sync structs/ + react/ from dist/ (after build_static.py)
```

`deploy.sh` deliberately does **not** upload `web/config.js` (S3 keeps the deploy-generated copy).
Rotate the key any time: `aws iam create-access-key --user-name atlas-explorer-deployer` (and delete the old).

## 2. Upload to S3 (initial build — admin SSO; atlas-operator is read-only on rnanix)

```bash
# shell + data + react (content-type auto by extension)
aws s3 sync dist/ s3://rnanix/atlas_explorer/ --exclude "structs/*"
# CIFs are gzip bytes -> set header so browsers decompress transparently (3Dmol gets plain text)
aws s3 sync dist/structs s3://rnanix/atlas_explorer/structs \
    --content-encoding gzip --content-type text/plain
```

Keep the prefix **private** — access is only through CloudFront.

## 3. CloudFront distribution

- Origin: `rnanix` bucket, origin path `/atlas_explorer`, via an **Origin Access Control** (bucket
  stays private; append the OAC allow statement to the bucket policy — additive only).
- **Default root object:** `index.html`.
- No CORS / response-headers policy needed (single origin).

## 4. Access control (CloudFront edge, Cognito)

Retired (T-0140): this repo no longer has a passcode gate, client-side or CloudFront-Function.
Access to the whole site, including `/data/ /structs/ /react/`, is enforced by a Lambda@Edge
viewer-request function checking Cognito group `app:atlas`, maintained outside this repo. Signing
in / access requests go through that system, not through anything here.

## 5. Use it

Open `https://rna-atlas.org/`. A signed-in `app:atlas` member sees the app directly; anyone else
is redirected to sign in.

## Smoke test

```bash
curl -I  "https://<dist>.cloudfront.net/"                              # 401 if not signed in
curl -I  "https://<dist>.cloudfront.net/data/folds.json"               # 401 if not signed in
```

## Local development (no S3, no edge auth)

`python serve.py` serves the shell + data directly from `/groups` with no access check at all —
local dev was never gated by either the old passcode or the new edge auth.

## Scaling to v2 (414k)

Same exporter + layout — extend `folds.json` + assets via the precompute pipeline, re-run
`build_static.py`, `aws s3 sync`. No CloudFront/access-control changes.

## AWS gotchas (from prior atlas work)

- Upload with the admin SSO `[default]` profile; `atlas-operator` can't write to `rnanix`.
- Bucket-policy edits are gated — **append** the OAC statement, don't rewrite the policy.
