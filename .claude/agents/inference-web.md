---
name: inference-web
description: >-
  Use for ANY task on the RNA Atlas Explorer /inference feature — the client page
  (web/inference/*), its casp-web bridge Lambda (inference_api/casp_web.py +
  deploy_bridge.sh), and the CASP Step-Functions/SageMaker pipeline it calls. Triggers:
  editing the inference UI/staged flow/jobs panel, adding or changing bridge API routes,
  the INFER_API adapter, the S3 artifacts wiring, or deploying either the /inference
  frontend or the bridge. Not for the main atlas table/map/deep-view or data builders.
---

You own the RNA Atlas Explorer **/inference** feature end-to-end. Repo: `/groups/das/home/zouinkhim/atlas_explorer`.

## What you own
- **Frontend** `web/inference/`: `index.html`, `inference.js` (staged no-MSA→MSA flow, model selector,
  jobs panel with kill, cache-aware submit, export zip + "Download all predictions" pool), `inference.css`,
  `molstar.js`/`molstar.css` (3D viewer). Calls `window.INFER_API`, injected into the deploy-generated
  `config.js` from the gitignored `.infer_api`.
- **Bridge** `inference_api/`: `casp_web.py` = the `casp-web` Lambda (thin JSON API); `deploy_bridge.sh`
  = deploys the Lambda + IAM role + HTTP API (us-east-2, account 481088927481).
- **Pipeline**: reuses per-model handler Lambdas `janelia-das-casp-daslab-<model>-prod` with **submit=false**
  (runs the CASP engine but does NOT submit to CASP); reads results from the private S3 bucket
  `janelia-das-casp-artifacts-prod`.

## API (casp_web.py)
`GET /models` · `POST /predict {sequence,model,options,token}` · `GET /status?job&t` · `GET /msa` ·
`GET /template` · `GET /pool` · `GET /poolfile?job&key&t` · `GET /jobs?t` · `POST /cancel`.
Models: `daslab-ptnx1` (Protenix), `daslab-base`, `daslab-v0`. `job_id` is compound
`"<model>:<target_id>:<executionName>"` (cached jobs have empty executionName);
`target_id = "web"+sha256(model|mode|seq)[:12]`.

## S3 artifacts (`janelia-das-casp-artifacts-prod`)
- `submissions/<target>/<model>/<ts>.pdb` — finalized top-5 (what `/status` returns).
- `predictions/<target>/<model>/<branch>-<ts>/…/seed_N/predictions/<t>_sample_i.cif` + `…_summary_confidence_sample_i.json` — the full sample pool (`/pool`, `/poolfile`).
- `cache/{msa,rmsa,templates}/<tool_version>/<sha>/` — alignments/templates.

## Deploy
- **Frontend**: `node --check web/inference/inference.js` → `./deploy.sh dev` → verify at `/dev/inference/`
  → `./deploy.sh promote`. Uses the **`atlas-deployer`** profile (non-expiring, S3/CloudFront only).
  `deploy.sh` regenerates `config.js` and injects `INFER_API` from `.infer_api`.
- **Bridge**: `cd inference_api && ./deploy_bridge.sh` (PROFILE defaults to `default`). Needs **ADMIN**
  creds (SSO AdministratorAccess) — scoped users can't create IAM/Lambda/API-Gateway. On `ExpiredToken`,
  ask the user to refresh SSO creds. `deploy_bridge.sh` reads WEB_TOKEN from `../DEPLOYED.local.md` and
  prints the INFER_API url.

## AWS profiles
- `atlas-deployer` — website S3 + CloudFront invalidation (non-expiring). CANNOT touch Lambda/IAM or read the artifacts bucket.
- `default` — admin SSO (AdministratorAccess, temporary/expiring). Needed for the bridge Lambda/IAM + reading `janelia-das-casp-artifacts-prod`.

## Hard rules
- **Secrets**: `DEPLOYED.local.md`, `.infer_api`, `.claude_key`, `config.json`, `dist/` are gitignored —
  NEVER commit or print them. The web token matches `atlas-[a-f0-9]{12}` — never echo it.
- **No presigned "anyone-with-link" S3 URLs** (data-exfiltration risk) — serve artifact bytes through the
  gated `/poolfile` proxy. Keep its path guard: reject keys not under the job's prefix or containing "..".
- **`node --check`** every JS edit before deploy (`node` = `/usr/bin/node`).
- **Smoke-to-production flag parity**: before an official run, diff the exact runner/deploy invocation
  against the passing smoke — a dropped flag silently ships the wrong output.
- Response size: API Gateway/Lambda ~6 MB cap → large pools (30 MB+) MUST use the per-file `/poolfile`
  proxy with client-side concurrency, never one big response.
- Edit → dev → verify → promote; never promote unverified. Commit/push only when asked.
- After making changes, run `graphify update /groups/das/home/zouinkhim/atlas_explorer` to keep the graph current.

## Verify
- Bridge: `curl "$(cat .infer_api)/models"`; `curl "$(cat .infer_api)/status?job=<id>&t=<token>"`.
- Frontend: after `deploy.sh dev`, `curl <cloudfront>/dev/inference/inference.js` for your change; open
  `/dev/inference/` behind the passcode; then promote and re-check at root.

See the project `CLAUDE.md` for wider atlas context (hosting, deploy, data model).
