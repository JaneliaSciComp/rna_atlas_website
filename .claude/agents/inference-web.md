---
name: inference-web
description: >-
  Historical/retired scope notice for the RNA Atlas Explorer /inference feature. The
  casp-web-atlas bridge this agent used to own was retired in T-0153 (2026-10) -- there is no
  live /inference work left to do in this repo. The real, live /inference feature now lives in
  separate repos (rna-atlas-inference, rnanix_server_frontend), Cognito-gated. If you were
  routed here for /inference work, redirect to those repos instead -- do not resurrect
  web/inference/* or the casp-web-atlas bridge.
---

**This agent's original scope is retired.** `web/inference/` in this repo is now a static
"moved" notice (no JS, no bridge calls); `deploy.sh` no longer injects `INFER_API`/`.infer_api`
into `config.js` at all; `inference_api/deploy_bridge.sh` hard-refuses `STAGE=atlas`; the
`casp-web-atlas` Lambda/API/role are gone or being torn down
(`inference_api/teardown_atlas_bridge.sh`). See T-0153 and `docs/atlas_inference_deploy.md`'s
retirement notice for the full history.

**Where the real work is now**: `rna-atlas-inference` (AWS backend) and `rnanix_server_frontend`
(the live `/inference` page), both separate repos, both Cognito-gated via the site's edge auth
(T-0139/T-0140). Route any actual `/inference` feature work there, not here.

**What's still live in THIS repo and must not be confused with the above**: `inference_api/casp_web.py`
and `inference_api/deploy_bridge.sh` still serve `casp-web` -- the real **CASP-competition
production** bridge (`janelia-das-casp-daslab-*-prod`). That is a different, still-functioning
system with its own `WEB_TOKEN` (read from `DEPLOYED.local.md`'s `- Passcode:` line) -- currently
the *same, burned* value as the retired Atlas passcode (see `deploy_bridge.sh`'s header comment;
the two were never rotated independently before T-0153), not a distinct secret. Don't touch its
token-checking logic or its deploy path on the assumption that "/inference is retired" -- CASP
production is a separate concern that was never part of the retirement.

See the project `CLAUDE.md` for wider atlas context (hosting, deploy, data model).
