# Add "compute MSA / rMSA only" (alignment without structure prediction)

Let a user paste a sequence and get **just the MSA or rMSA alignment** — skipping the GPU structure
prediction. Verdict: **medium effort — most of the machinery already exists.**

> Status: **planning / design doc.** Nothing built yet.

---

## Why it's not hard: the alignment steps are self-contained jobs

The MSA and rMSA steps in the CASP prediction pipeline are **standalone jobs** that read the request
input and write to a cache — **neither needs the GPU predict step**.

| Step | How it's launched | Reads → writes |
|---|---|---|
| **MSA** (protenix-mt) | **ECS Fargate `RunTask`** — cluster `arn:aws:ecs:us-east-2:481088927481:cluster/janelia-das-casp-prod`, task-def `janelia-das-casp-msa-prod:4`, env overrides `REQUEST_INPUT_S3_PREFIX / OUTPUT_S3_PREFIX / ARTIFACTS_BUCKET / TOOL_VERSION` | `requests/<key>/protenix_input.json` → `cache/msa/<tool>/<sha>/` |
| **rMSA** | **AWS Batch `SubmitJob`** — its own JobDefinition + JobQueue (+ ContainerOverrides) | same input contract → `cache/rmsa/<tool>/<sha>/` |

Cache convention (from `cache_check.py`): `cache/{kind}/{tool_version}/{fasta_sha256}/` with a `done`
sentinel written on completion.

---

## What already exists (reused as-is)

The `casp-web` bridge (from the `/inference` work) already:
- **Builds + uploads `protenix_input.json`** to `requests/<server_key>/web-<target_id>/` (the input the
  MSA/rMSA containers read).
- **Computes `fasta_sha256`** = the cache key.
- **Serves the alignment output** via the **`/msa`** endpoint (lists + returns the `.MSA.fasta` / `.a3m`
  files from `cache/…`, noise filtered).

So the alignment is **already downloadable today** after *any* MSA/rMSA prediction. "MSA-only" just lets
you **run the alignment without paying for the GPU predict**.

**The only missing piece:** launch *just* the MSA/rMSA job (not the full predict pipeline) and track when
it finishes.

---

## Two implementation options

### Option A — Bridge launches the job directly
Add an `/align` endpoint to the bridge that:
1. builds + uploads `protenix_input.json` (reuse existing code),
2. **`ecs:RunTask`** the `casp-msa` Fargate task (or **`batch:SubmitJob`** for rMSA) with the env
   overrides (`REQUEST_INPUT_S3_PREFIX`, `OUTPUT_S3_PREFIX=cache/{kind}/{tv}/{sha}`, `ARTIFACTS_BUCKET`,
   `TOOL_VERSION`),
3. polls the cache `done` sentinel (engine-agnostic) — or `ecs:DescribeTasks` / `batch:DescribeJobs`,
4. serves the result via the existing `/msa`.

- **New bridge IAM:** `ecs:RunTask` + `iam:PassRole` (task exec + task roles) + `ecs:DescribeTasks`;
  `batch:SubmitJob` + `batch:DescribeJobs`.
- **Also needs:** the Fargate **network config** (subnets / security groups) reconstructed from the task
  definition or the existing SFN state parameters.
- **Effort: ~1–3 days.** Fiddly parts: `PassRole` + networking; loses the SFN's built-in
  retry/throttle/cache-check (re-add a sentinel check).

### Option B — Trimmed "align-only" Step Functions  ⭐ recommended for production
A tiny state machine reusing the **exact** `RunMSA` / `RunRMSA` states from the prediction pipeline:
`CacheCheck → Run(MSA and/or rMSA) → done`. The bridge starts it like `/predict` and polls it via
`/status`; `/msa` serves the output.

- **Effort: ~2–4 days.** More robust — **inherits the exact network config, task defs, retry/throttle,
  and cache-check for free**. Downside: it's **new pipeline infra** (pipeline-owner sign-off, like the
  additive `none`-route was).

> Note: an "early-exit after MSA" flag inside the *existing* predict SFN is **not** clean — the predict
> step lives *inside* the MSA branches (dual MSA/rMSA-conditioned prediction), so there's no single
> cut-point between "MSA done" and "predict". Standalone launch (A or B) is the right approach.

---

## UI
Small addition, mostly reusable from `/inference`:
- an **"align only"** mode (or a dedicated page/button): pick **MSA / rMSA / both**, submit,
- reuse the jobs list + status polling + the `/msa`-backed download (the alignment `.fasta`/`.a3m`).

---

## Caveats / what to set expectations on
- **Not instant.** rMSA/nhmmer search takes **~20–40 min** (CPU Fargate/Batch). The win is **cost +
  not tying up a GPU**, not latency.
- MSA (protenix-mt) is typically faster than rMSA.
- Everything stays behind the passcode gate; results served through the bridge (no public S3 exposure).

---

## Recommendation
- **Option B** (trimmed align-only SFN) for a production-solid feature that reuses the orchestration
  already trusted in the predict pipeline.
- **Option A** (bridge `RunTask`/`SubmitJob`) for a quicker reuse without standing up new SFN infra.

Either way the `/msa` serving + `protenix_input.json` upload + cache-key logic are **already built** —
the work is launching the standalone job + a thin "align only" UI.
