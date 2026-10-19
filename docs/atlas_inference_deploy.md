# Atlas Inference Backend — Deploy Runbook

End-to-end, reproducible steps to stand up and update the **Atlas inference backend**: the isolated
`atlas` fork of the CASP prediction pipeline + the `casp-web-atlas` bridge + wiring the website to it.
Every step is a saved command (script/Make target) — nothing here is ad-hoc.

> **The `casp-web-atlas` bridge (Steps 2-3) is retired (T-0153).** It is not just unreachable --
> the Lambda/API/role are gone or slated for teardown (`inference_api/teardown_atlas_bridge.sh`),
> `deploy_bridge.sh` now refuses `STAGE=atlas` outright, and `deploy.sh` no longer injects an
> `INFER_API`/`.infer_api` value into `config.js` at all. Steps 2-3 below are kept as historical
> record of how it used to be stood up, not as a procedure to follow. The live `/inference`
> feature is a separate system (`rna-atlas-inference` / `rnanix_server_frontend`), Cognito-gated,
> unaffected by any of this. Steps 1/4/5 describe the `atlas` OpenTofu pipeline stage in the
> separate `rna-atlas-aws-server` repo, which T-0153 does not touch -- not verified current here.

## Why a fork

The `/inference` page used to submit to the **shared CASP production** pipeline
(`janelia-das-casp-daslab-*-prod`), which RNAnix also uses for the **CASP competition**. To evolve the
website (AF3-style multi-entity / complexes) without risking the competition pipeline, the website runs
against a dedicated **`atlas`** copy. CASP-prod is never modified.

| | `-prod` stack | `-atlas` stack |
|---|---|---|
| Purpose | CASP competition (real submissions) | the rna-atlas.org `/inference` website |
| Owner | RNAnix | atlas |
| CASP submit endpoint | **real** predictioncenter.org | **mock** (non-prod stages) |
| Who changes it | RNAnix only | where website/complex divergence lands |

**Shared (read-only, NOT duplicated):** ECR images, `janelia-das-casp-databases` bucket (weights/fleet
specs), VPC endpoints, external `s3://rnanix-rmsa-db` (758 GB). These are created only under the `dev`
workspace and referenced by data source, so the `atlas` stage reuses them automatically.

## Accounts / tooling / creds

- AWS account **481088927481**, region **us-east-2**.
- **Admin SSO** (`default` profile, AdministratorAccess) is required for the pipeline (tofu) and the
  bridge (Lambda/IAM/APIGW). Refresh when expired (`aws --profile default sts get-caller-identity`).
- The website deploy (`deploy.sh`) uses the non-expiring **`atlas-deployer`** profile (S3/CloudFront only).
- Pipeline IaC: **OpenTofu** (`tofu`, never `terraform`) in the dedicated **`rna-atlas-aws-server`**
  repo at `/groups/das/home/zouinkhim/aws/rna-atlas-aws-server/` — a standalone fork of the CASP
  `jrc-rna-casp-servers` pipeline, with its OWN git history + tofu state. Stage = tofu **workspace** name.
  (RNAnix's `jrc-rna-casp-servers` is never touched by the atlas.)
- Bridge + website: this repo (`/groups/das/home/zouinkhim/atlas_explorer/`).

---

## Step 1 — Deploy the pipeline (OpenTofu → `atlas` stage)

The pipeline lives in the dedicated **`rna-atlas-aws-server`** repo (seeded from CASP; see that repo's
README). `atlas.tfvars` mirrors `prod.tfvars` (same image SHAs, default server roster → atlas == CASP
prod at fork time). Divergence is applied as pipeline **code** in that repo (Step 5), never in the CASP
repo and never by hand in the console.

```bash
cd /groups/das/home/zouinkhim/aws/rna-atlas-aws-server
export AWS_PROFILE=default AWS_DEFAULT_REGION=us-east-2   # admin SSO

tofu init -input=false                 # once per checkout (idempotent)
make plan  ENV=atlas                    # PREVIEW — must be "N to add, 0 to change, 0 to destroy"
                                        # (fresh workspace: creates only -atlas resources + reads shared data sources)
make apply ENV=atlas ARGS=-auto-approve # create the stack (omit ARGS to review interactively)
```

Creates (all `-atlas`-suffixed, zero collision with prod/dev): per-model handler Lambdas
`janelia-das-casp-daslab-<model>-atlas`, state machines `...-pipeline-atlas`, artifacts bucket
`janelia-das-casp-artifacts-atlas`, rMSA Batch CE/queue/jobdef `...-rmsa-atlas`, ECS cluster + MSA/
templates task defs, `janelia-das-casp-api-atlas`, and all per-stage IAM roles.

Verify:
```bash
make show                                              # current workspace = atlas
aws --profile default --region us-east-2 lambda get-function \
  --function-name janelia-das-casp-daslab-ptnx1-atlas --query 'Configuration.FunctionName'
aws --profile default --region us-east-2 s3 ls s3://janelia-das-casp-artifacts-atlas/ || true
```

## Step 2 — Deploy the atlas bridge (`casp-web-atlas`) — RETIRED, historical only

This step no longer applies. `deploy_bridge.sh` hard-refuses `STAGE=atlas` now (T-0153) -- running
the command below will print an error and exit, not deploy anything. Kept verbatim so the shape of
the old setup is on record:

```bash
cd /groups/das/home/zouinkhim/atlas_explorer/inference_api
python3 -m py_compile casp_web.py                       # sanity
STAGE=atlas ./deploy_bridge.sh
# now refuses, verbatim:
#   ERROR: STAGE=atlas is not supported -- the Atlas bridge (STAGE=atlas) was retired in
#   T-0153. This script only ever deploys CASP production (STAGE=prod, the default).
```

It used to create `casp-web-atlas` Lambda + `casp-web-role-atlas` + `casp-web-api-atlas` HTTP API,
scoped to the `-atlas` state machines / handlers / `janelia-das-casp-artifacts-atlas`. Those
resources are being (or have been) deleted via `inference_api/teardown_atlas_bridge.sh`.

## Step 3 — Point the website at the atlas bridge — RETIRED, historical only

This step no longer applies either. `deploy.sh` no longer reads `.infer_api` or injects
`window.INFER_API` into `config.js` at all (T-0153) -- there is nothing left for the website to
point at. `web/inference/` is now a static "moved" notice, not the old bridge-calling client.

## Step 4 — End-to-end verification — RETIRED, historical only

This tested the now-retired bridge via the old `web/inference/` client; `dev/inference/` belongs
to the separate, still-live `rnanix_server_frontend` deployment now, not this repo's testing.

At `https://rna-atlas.org/dev/inference/` (historical):
1. **Single RNA** (mode None) → structure returns.
2. **Homodimer** — one RNA entity, copies = 2 → two-chain structure; `msa` mode builds per-chain MSA.
3. **Heterodimer** — two RNA entities → two distinct chains.
4. **RNA + ligand** — CCD (e.g. `MG`) and SMILES → ligand appears; SMILES also writes `ligand.json`.
5. **RNA + protein** — folds; protein carries the "single-sequence — no MSA yet" caveat (expected).

Bridge → S3 sanity (atlas artifacts bucket):
```bash
aws --profile default --region us-east-2 s3 ls --recursive \
  s3://janelia-das-casp-artifacts-atlas/requests/ | tail
# confirm protenix_input.json (+ ligand.json for SMILES) landed under requests/.../web-<target>/
```

## Step 5 — Diverge: multichain / complex pipeline changes (atlas only)

The bridge already emits the full AF3 schema (rna/dna/`proteinChain`/ligand + counts), and the MSA
container enumerates chains from `protenix_input.json`. To lift protein/DNA from single-sequence to full
MSA accuracy (adds protein MSA DB + container + a paired-MSA branch), change the pipeline **code** in
the `rna-atlas-aws-server` repo (`containers/msa/`, `lambda/`) and redeploy the atlas stage:

```bash
cd /groups/das/home/zouinkhim/aws/rna-atlas-aws-server
export AWS_PROFILE=default AWS_DEFAULT_REGION=us-east-2
make images                         # rebuild container images (Docker) — pushes to shared ECR
make push  ENV=atlas
make apply ENV=atlas ARGS=-auto-approve
```

All changes stay in `rna-atlas-aws-server`; RNAnix's `jrc-rna-casp-servers` (the competition pipeline)
is never touched.

## Update / teardown cheatsheet

| Task | Command |
|---|---|
| Update atlas pipeline config/code | `make apply ENV=atlas ARGS=-auto-approve` (in the tofu repo) |
| Update the atlas bridge Lambda | **retired (T-0153)** -- `deploy_bridge.sh` refuses `STAGE=atlas` |
| Update website shell | `./deploy.sh dev` → verify → `./deploy.sh promote` |
| Tear down the whole atlas stack | `make destroy ENV=atlas ARGS=-auto-approve` (leaves prod/dev + shared DBs intact) |
| Which workspace am I in? | `make show` |

## Notes / gotchas

- The `atlas` stage depends on **dev-owned** shared resources (ECR, `janelia-das-casp-databases`, VPC
  endpoints created under the `dev` workspace). If `dev` is ever destroyed, atlas (and prod) lose those
  inputs. Don't destroy `dev`.
- tofu state is **local to the `rna-atlas-aws-server` repo** (`terraform.tfstate.d/`, gitignored) —
  deliberately separate from the CASP repo's shared state.
- Keep `atlas.tfvars` image tags in sync with CASP `prod.tfvars` until an intentional divergence.
- Bridge stays python3.12 / 256 MB / 30 s, boto3-only (no RDKit/biopython) — ligand validation is regex.
