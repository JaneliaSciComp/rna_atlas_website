# Contribute a model to the RNA Atlas inference server

This is how an RNAnix user turns a trained checkpoint into a **selectable model** on the
rna-atlas.org `/inference` dashboard. You (the contributor) send a **zip**; an admin runs one
script to deploy it. **No new infrastructure is created per model** — a contributed model is just
data (checkpoint + config + a manifest row) served by the shared "community fleet" on the atlas
stack. CASP-prod is never touched.

> Scope: models must be generated with **RNAnix** (Protenix-family). The dashboard reproduces the
> architecture from the **config you ship** and loads your weights into it. A checkpoint without its
> config cannot be served correctly (see "Why the config is mandatory").

---

## 1. What to send (the zip contract)

Produce `<model-id>.zip` with exactly this layout:

```
<model-id>.zip
├── model.json            # metadata (see below)  — REQUIRED
├── <model_name>.pt       # your RNAnix checkpoint (weights)  — REQUIRED
└── config/               # the RNAnix config your checkpoint was TRAINED/served with — REQUIRED
    └── … (yaml/json)     # whatever RNAnix writes alongside the checkpoint
```

- `<model_name>.pt` — the checkpoint file. Its basename (without `.pt`) must equal `model_name` in
  `model.json` (the runner loads `{ckpt_dir}/{model_name}.pt`).
- `config/` — the config that defines the **architecture** (dims, blocks, cycles, template/MSA
  settings, …). Copy it straight from your RNAnix run's output dir. If your variant differs from the
  RNAnix defaults in any way, this is what makes it load correctly.

### `model.json`

```json
{
  "id": "my-rna-model-v1",
  "display_name": "My RNA model v1",
  "description": "one line shown under the model in the dashboard",
  "model_name": "px1_myvariant_step49999",
  "use_msa": true,
  "use_template": true,
  "rnaonly": true,
  "config_overrides": {
    "model.pairformer.n_blocks": 48,
    "sample_diffusion.N_step": 200
  }
}
```

| field | required | meaning |
|---|---|---|
| `id` | yes | unique slug `[a-z0-9-]`; used in S3 paths + the dropdown value |
| `display_name` | yes | label shown in the dashboard model dropdown |
| `description` | no | one-line description |
| `model_name` | yes | checkpoint basename → `<model_name>.pt` |
| `use_msa` | yes | did you train/serve with MSA conditioning? |
| `use_template` | yes | did you train/serve with 3D templates (JTBM)? |
| `rnaonly` | yes | RNA-only model? (almost always `true`) |
| `config_overrides` | **only if arch differs from RNAnix defaults** | the exact Protenix config keys (dotted) that define your architecture, i.e. every non-default flag you passed at training/inference. If your model is default-architecture, omit this. |

## 2. How to generate it from RNAnix

1. Train / obtain your checkpoint as usual in RNAnix → you have `…/checkpoints/<step>_ema_….pt`
   and the run's **config**.
2. Copy the checkpoint to `<model_name>.pt` (pick a clear `model_name`).
3. Copy the run's config into `config/`.
4. List, in `config_overrides`, every architecture/inference flag you changed from the RNAnix
   defaults (the same `--key value` overrides you used with `runner/predict_rna.py`). If you didn't
   change any, omit `config_overrides`.
5. Fill `model.json`.
6. **Submit** — see "How to submit" below.

## How to submit

You're an RNAnix user on the Janelia cluster (`das` group), so **there's no upload** — drop your
model folder on shared storage and ping the admin:

```bash
# folder = model.json + <model_name>.pt + config/  (or a <model-id>.zip if you prefer)
cp -r <model-id>  /nrs/das/rnastruct/model_submissions/
```

Then message the atlas admin your `<model-id>`. The inbox is group-writable and lives on `/nrs`, so
multi-GB checkpoints are fine, and no zipping is required (the admin's tool accepts the folder
directly). Inbox instructions live at `/nrs/das/rnastruct/model_submissions/README.txt`.

**Not on the cluster?** (external RNAnix user) send a `<model-id>.zip` to an S3 location the admin
gives you; the admin deploys straight from it: `python3 add_model.py s3://<bucket>/<path>/<model-id>.zip`.

## Why the config is mandatory

The inference runner (`runner/predict_rna.py`) builds the network from a **config** (`configs_base`
+ your overrides) and then loads your `.pt` into it. The architecture is defined by the config, **not**
the checkpoint. If the wrong architecture is built, the weights won't fit — and because the fleet
historically loads with `load_strict=False`, a mismatch is **silently dropped** and you get a
quietly-broken model with no error. For contributed models the deploy uses **`load_strict=True`**, so
a config/weights mismatch **fails loudly** at deploy-test time instead of returning garbage. Shipping
the exact config (and `config_overrides`) is what guarantees your model runs as you trained it.

---

## 3. Admin: deploy a contributed zip

```bash
export AWS_PROFILE=default AWS_DEFAULT_REGION=us-east-2     # admin SSO (Lambda/S3)
cd /groups/das/home/zouinkhim/aws/rna-atlas-aws-server/add_model_instructions
python3 add_model.py <model-id>.zip                        # validate + upload + register
python3 add_model.py --list                                # show registered community models
python3 add_model.py --remove <model-id>                   # unregister + delete its artifacts
```

`add_model.py` (see the script header for details):
1. validates the zip against the contract above,
2. uploads `<model_name>.pt`, `config/`, and a generated `fleet_spec.yaml` to
   `s3://janelia-das-casp-artifacts-atlas/community/<id>/`,
3. appends/updates the row in `s3://janelia-das-casp-artifacts-atlas/community/models_manifest.json`.

The dashboard's model dropdown reads the manifest, so the new model appears with **no redeploy**. A
contributed model runs on the shared **community fleet** state machine, with its checkpoint + config
mounted per request (same per-request mechanism as the seeds/samples knobs).

## 4. Serving wiring (one-time, tracked separately)

For a contributed model to actually *run*, the atlas pipeline needs the community-fleet serving path
(built once, not per model):
- a `community` fleet server (reuses the RNAnix fleet image),
- per-request mount of `s3://…/community/<id>/` → `/opt/ml/processing/input/community` +
  `FLEET_SPEC` pointing at the mounted `fleet_spec.yaml`,
- `fleet_predict.py` threading each model's `config_overrides` + `load_strict=True` to
  `predict_rna.py` (the **one** image change — confirm with RNAnix which config keys their variants
  actually change), and
- the bridge `/models` merging the manifest into the model list + `/predict` routing a community
  model id to the community fleet.

Until that path is deployed, `add_model.py` still validates + stages models correctly; they light up
in the dashboard once the serving wiring is live.
