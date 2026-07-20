# Atlas Inference Backend — Deploy Runbook

End-to-end, reproducible steps to stand up and update the **Atlas inference backend**: the isolated
`atlas` fork of the CASP prediction pipeline + the `casp-web-atlas` bridge + wiring the website to it.
Every step is a saved command (script/Make target) — nothing here is ad-hoc.

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
- Pipeline IaC: **OpenTofu** (`tofu`, never `terraform`) at
  `/groups/das/home/zouinkhim/aws/RNAnix/jrc-rna-casp-servers/`. Stage = tofu **workspace** name.
- Bridge + website: this repo (`/groups/das/home/zouinkhim/atlas_explorer/`).

---

## Step 1 — Fork the pipeline (OpenTofu → `atlas` stage)

Config lives in `jrc-rna-casp-servers/atlas.tfvars` (mirrors `prod.tfvars`: same image SHAs, default
server roster → atlas == prod at fork time). Divergence is applied later as pipeline **code** under the
atlas workspace (Step 5), never by hand in the console.

```bash
cd /groups/das/home/zouinkhim/aws/RNAnix/jrc-rna-casp-servers
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

## Step 2 — Deploy the atlas bridge (`casp-web-atlas`)

The bridge Lambda is fully `STAGE`-parameterized; `deploy_bridge.sh` derives all names + IAM ARNs from
`STAGE`. Non-prod stages get a `-<stage>` suffix so the atlas bridge never touches the prod bridge.

```bash
cd /groups/das/home/zouinkhim/atlas_explorer/inference_api
python3 -m py_compile casp_web.py                       # sanity
STAGE=atlas ./deploy_bridge.sh                          # admin SSO; prints "INFER_API = https://<id>.execute-api..."
```

Creates `casp-web-atlas` Lambda + `casp-web-role-atlas` + `casp-web-api-atlas` HTTP API, scoped to the
`-atlas` state machines / handlers / `janelia-das-casp-artifacts-atlas`.

Smoke test:
```bash
ATLAS_API="https://<id>.execute-api.us-east-2.amazonaws.com"   # from the deploy output
curl -s "$ATLAS_API/models"
# single-RNA:
curl -s -X POST "$ATLAS_API/predict" -H 'content-type: application/json' \
  -d '{"sequence":"GGGAACGACUCGAGUAGAGUCG","model":"daslab-ptnx1","options":{"mode":"none"},"token":"<passcode>"}'
```

## Step 3 — Point the website at the atlas bridge

`INFER_API` is injected into the generated `config.js` from the gitignored `.infer_api`. Move the website
DEV-first, verify, then promote.

```bash
cd /groups/das/home/zouinkhim/atlas_explorer
# write the atlas bridge URL (do NOT paste secrets in chat; the passcode is separate)
printf '%s' "$ATLAS_API" > .infer_api      # or: ! printf ... > .infer_api  (run it yourself)

node --check web/inference/inference.js
./deploy.sh dev                            # -> /dev only  (atlas-deployer profile)
# verify at https://rna-atlas.org/dev/inference/  (see Step 4)
./deploy.sh promote                        # ship the tested bytes to prod  (only when ready)
```

Rollback = point `.infer_api` back at the CASP-prod bridge URL and re-deploy.

## Step 4 — End-to-end verification (behind the passcode)

At `https://rna-atlas.org/dev/inference/`:
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
`jrc-rna-casp-servers/` (`containers/msa/`, `lambda/`) and redeploy **only** the atlas stage:

```bash
cd /groups/das/home/zouinkhim/aws/RNAnix/jrc-rna-casp-servers
export AWS_PROFILE=default AWS_DEFAULT_REGION=us-east-2
make images                         # rebuild container images (Docker)
make push  ENV=atlas                # push to shared ECR (tags pinned in atlas.tfvars)
make apply ENV=atlas ARGS=-auto-approve
```

Never run these with `ENV=prod` for website-only features — that would change the competition pipeline.

## Update / teardown cheatsheet

| Task | Command |
|---|---|
| Update atlas pipeline config/code | `make apply ENV=atlas ARGS=-auto-approve` (in the tofu repo) |
| Update the atlas bridge Lambda | `STAGE=atlas ./deploy_bridge.sh` (in `inference_api/`) |
| Update website shell | `./deploy.sh dev` → verify → `./deploy.sh promote` |
| Tear down the whole atlas stack | `make destroy ENV=atlas ARGS=-auto-approve` (leaves prod/dev + shared DBs intact) |
| Which workspace am I in? | `make show` |

## Notes / gotchas

- The `atlas` stage depends on **dev-owned** shared resources (ECR, `janelia-das-casp-databases`, VPC
  endpoints created under the `dev` workspace). If `dev` is ever destroyed, atlas (and prod) lose those
  inputs. Don't destroy `dev`.
- tofu state is local, via the symlink `terraform.tfstate.d -> /groups/das/rnastruct/infra/casp_servers_tf/…`.
- Keep `atlas.tfvars` image tags in sync with `prod.tfvars` until an intentional divergence.
- Bridge stays python3.12 / 256 MB / 30 s, boto3-only (no RDKit/biopython) — ligand validation is regex.
