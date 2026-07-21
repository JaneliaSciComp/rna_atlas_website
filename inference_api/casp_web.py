"""casp-web — thin web bridge between the RNA Atlas /inference page and the CASP
prediction pipeline (us-east-2). Exposes a clean JSON API the front-end already speaks:

  GET  /models                      -> {models:[{id,label}]}
  POST /predict  {entities:[{type,sequence|ligand,count}], model, options, token}
                 (legacy: {sequence,...} single RNA is still accepted)
                                     -> {job_id, target_id, model, status}
  GET  /status?job=<job_id>&t=<tok> -> {state, stages:{msa:{status,cif?}}}
  GET  /msa?job=<job_id>&t=<tok>    -> {files:[{name,content}]}   (alignment files)
  GET  /template?job=<job_id>&t=<tok> -> {files:[{name,content}]} (JohnTBM template CSVs)
  GET  /brief?job=<job_id>&t=<tok>  -> {gate,template_pdb_ids,brief,rationale,thinking} (Expert-mode research)
  GET  /pool?job=<job_id>&t=<tok>   -> {files:[{key,name,size}],count,bytes}  (full sample pool)
  GET  /poolfile?job=<job_id>&key=<k>&t=<tok> -> raw file content (one pool member)
  GET  /jobs?t=<tok>                -> {jobs:[{job_id,model,state,name}]}
  POST /cancel   {job_id,token}     -> {ok}

It REUSES the existing per-model handler Lambda (janelia-das-casp-daslab-<model>-prod)
with submit=false, so predictions run through the SAME Step-Functions/SageMaker engine, but
the atlas workspace's Finalize step is finalize_inference.py (not the real finalize.py) —
CASP submission mechanics are never invoked. Results (inference/<target>/<model>/manifest.json
+ rank_NN.pdb in the private artifacts bucket) are read server-side and returned inline,
behind a shared web token.

job_id is compound: "<model>:<target_id>:<executionName>" so /status & /cancel are self-contained.
Env: ARTIFACTS_BUCKET, WEB_TOKEN (gate passcode), ACCOUNT, REGION, STAGE.
"""
import base64
import datetime
import gzip
import hashlib
import json
import os
import re
import time
import uuid

import boto3
from botocore.client import Config

lam = boto3.client("lambda")
sfn = boto3.client("stepfunctions")
s3 = boto3.client("s3")
_ENV_CACHE = {}

ACCOUNT = os.environ.get("ACCOUNT", "481088927481")
REGION = os.environ.get("REGION", "us-east-2")
STAGE = os.environ.get("STAGE", "prod")
ARTIFACTS_BUCKET = os.environ.get("ARTIFACTS_BUCKET", "janelia-das-casp-artifacts-prod")
WEB_TOKEN = os.environ.get("WEB_TOKEN", "")

# Presigned URLs must use the REGIONAL virtual-hosted endpoint (bucket.s3.<region>.amazonaws.com).
# The default/global bucket.s3.amazonaws.com host 307-redirects a non-us-east-1 bucket to its region,
# and browsers do NOT carry CORS headers across that redirect -> the client fetch() fails even though
# curl (which ignores CORS) succeeds. Pinning region + virtual addressing removes the redirect.
s3_presign = boto3.client("s3", region_name=REGION,
                          config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))

MODELS = [
    {"id": "daslab-ptnx1", "label": "Protenix (ptnx1)"},
    {"id": "daslab-base", "label": "daslab base"},
    {"id": "daslab-v0", "label": "daslab v0"},
]
MODEL_IDS = {m["id"] for m in MODELS}

# ---- multi-entity (AF3-style) input: RNA / protein / DNA / ligand, each with a copy count ----
MAX_ENTITIES = 16
MAX_COUNT = 8
MIN_POLY = 5
MAX_TOTAL_RESIDUES = 5000
# per-request fleet knobs (RNAnix fleet models read SEEDS + N_SAMPLE env; defaults 3 seeds, 5 samples)
SEED_POOL = ["101", "202", "303", "404", "505"]
MAX_SEEDS = 5
MAX_SAMPLES = 5
_ALPHA = {"rna": set("ACGUN"), "dna": set("ACGTN"),
          "protein": set("ACDEFGHIKLMNPQRSTVWYX")}
# Protenix/AF3 sequences[] key per polymer type.
# MUST-VERIFY against the pinned Protenix schema before the atlas bridge goes live: the protein key
# may be "proteinChain" (ByteDance Protenix) rather than "proteinSequence"; likewise the ligand inner
# key and CCD_ prefix convention. RNA is confirmed ("rnaSequence").
_PTX_KEY = {"rna": "rnaSequence", "dna": "dnaSequence", "protein": "proteinChain"}
_CCD_RE = re.compile(r"^[A-Za-z0-9]{1,5}$")
_SMILES_RE = re.compile(r"^[A-Za-z0-9@+\-\[\]()=#$%.\\/:*]+$")
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def _clean_poly(kind, s):
    s = "".join(str(s or "").split()).upper()
    if kind == "rna":
        s = s.replace("T", "U")
    elif kind == "dna":
        s = s.replace("U", "T")
    elif kind == "protein":
        s = "".join(c if c in _ALPHA["protein"] else "X" for c in s)  # coerce unknown residues -> X
    return s


def _parse_entities(body):
    """Return (entities, error). entities = [{type, seq|value, count}] in submission order.
    Backward compatible: with no `entities`, fall back to the legacy single-RNA `sequence` field."""
    raw = body.get("entities")
    if not isinstance(raw, list) or not raw:
        seq = "".join(c for c in (body.get("sequence") or "").upper().replace("T", "U") if c in "ACGUN")
        if len(seq) < MIN_POLY:
            return None, "sequence must be >= 5 nt (A/C/G/U/N)"
        return [{"type": "rna", "seq": seq, "count": 1}], None
    if len(raw) > MAX_ENTITIES:
        return None, f"too many entities (max {MAX_ENTITIES})"
    out, has_poly = [], False
    for i, e in enumerate(raw, 1):
        t = str((e or {}).get("type") or "rna").lower()
        if t not in ("rna", "dna", "protein", "ligand"):
            return None, f"entity {i}: unknown type '{t}'"
        try:
            count = int((e or {}).get("count") or 1)
        except (TypeError, ValueError):
            count = 1
        count = max(1, min(MAX_COUNT, count))
        val = (e or {}).get("sequence")
        if val is None:
            val = (e or {}).get("ligand")
        if t == "ligand":
            v = str(val or "").strip()
            if not v or not (_CCD_RE.match(v) or _SMILES_RE.match(v)):
                return None, f"entity {i} (ligand): not a valid CCD code or SMILES"
            out.append({"type": t, "value": v, "is_ccd": bool(_CCD_RE.match(v)), "count": count})
            continue
        s = _clean_poly(t, val)
        if len(s) < MIN_POLY:
            return None, f"entity {i} ({t}) must be >= {MIN_POLY} residues"
        if set(s) - _ALPHA[t]:
            return None, f"entity {i} ({t}) has invalid characters"
        has_poly = True
        out.append({"type": t, "seq": s, "count": count})
    if not has_poly:
        return None, "need at least one polymer entity (rna/dna/protein)"
    total = sum(len(e["seq"]) * e["count"] for e in out if e["type"] != "ligand")
    if total > MAX_TOTAL_RESIDUES:
        return None, f"total {total} residues exceeds the {MAX_TOTAL_RESIDUES} limit"
    return out, None


_STATE = {"RUNNING": "running", "SUCCEEDED": "done", "FAILED": "error",
          "ABORTED": "error", "TIMED_OUT": "error"}
_CORS = {"Access-Control-Allow-Origin": "*",
         "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
         "Access-Control-Allow-Headers": "content-type"}


def _resp(code, obj):
    body = json.dumps(obj)
    headers = {"Content-Type": "application/json", **_CORS}
    # Large results (a big structure returned inline as cif) can exceed API Gateway's ~6 MB
    # response cap. gzip bodies over ~1 MB: a 6.8 MB PDB -> ~1.5 MB, well under the limit, and
    # ~40 MB structures still fit. The browser (fetch) decodes Content-Encoding: gzip transparently.
    if len(body) > 1_000_000:
        gz = gzip.compress(body.encode())
        return {"statusCode": code, "isBase64Encoded": True,
                "headers": {**headers, "Content-Encoding": "gzip"},
                "body": base64.b64encode(gz).decode()}
    return {"statusCode": code, "headers": headers, "body": body}


def _handler_fn(model):
    return f"janelia-das-casp-{model}-{STAGE}"


def _exec_arn(model, name):
    return f"arn:aws:states:{REGION}:{ACCOUNT}:execution:janelia-das-casp-{model}-pipeline-{STAGE}:{name}"


def _pipeline_arn(model):
    return f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:janelia-das-casp-{model}-pipeline-{STAGE}"


def _inference_result_pdb(target_id, model):
    """Read finalize_inference.py's ranked picks (inference/<target>/<model>/manifest.json +
    rank_NN.{pdb,cif} — whichever format the model actually wrote) and return the top-ranked
    structure. inference.js content-sniffs format (fmtOf(): 'data_'/'_atom_site' -> cif, else
    pdb), so raw text of either format is fine — but MODEL/ENDMDL bracketing (which the old
    submissions/ PFRMAT-TS path used to show all 5 in one blob) is PDB-only syntax and would
    corrupt real mmCIF, so only PDB-format results get concatenated; CIF returns just the best
    pick. Returns None if no result is there yet."""
    try:
        manifest_key = f"inference/{target_id}/{model}/manifest.json"
        manifest = json.loads(s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=manifest_key)["Body"].read())
    except Exception:
        return None
    rank_keys = manifest.get("ranks", [])
    if not rank_keys:
        return None
    bodies = []
    for key in rank_keys:
        try:
            bodies.append(s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=key)["Body"].read().decode())
        except Exception:
            continue
    if not bodies:
        return None
    is_cif = bodies[0].startswith("data_") or "_atom_site" in bodies[0]
    if is_cif or len(bodies) == 1:
        return bodies[0]
    lines = []
    for idx, body in enumerate(bodies, start=1):
        lines.append(f"MODEL {idx}")
        lines.append(body.rstrip("\n"))
        lines.append("ENDMDL")
    lines.append("END")
    return "\n".join(lines)


def _submissions_result_url(target_id, model):
    """Fallback for jobs from the pre-inference/ backend generation (the CASP-prod results copied
    into this bucket): those live at submissions/<target>/<model>/<ts>.pdb — a single CASP PFRMAT-TS
    PDB (already MODEL/ENDMDL-bracketed, renders as-is). Rather than stream the file (up to ~9 MB)
    back through the Lambda + API Gateway on every click (~20 s, and near the 30 s Lambda timeout),
    hand the browser a short-lived presigned S3 URL so it downloads straight from S3 — much faster
    and cheaper (no Lambda runtime / API GW payload). Returns the newest object's URL, or None.
    Only consulted when inference/ has nothing and the execution is unresolvable, so it never
    touches the live-prediction hot path."""
    prefix = f"submissions/{target_id}/{model}/"
    try:
        resp = s3.list_objects_v2(Bucket=ARTIFACTS_BUCKET, Prefix=prefix)
    except Exception:
        return None
    pdbs = sorted(o["Key"] for o in resp.get("Contents", []) if o["Key"].endswith(".pdb"))
    if not pdbs:
        return None
    try:
        return s3_presign.generate_presigned_url(
            "get_object", Params={"Bucket": ARTIFACTS_BUCKET, "Key": pdbs[-1]}, ExpiresIn=3600)
    except Exception:
        return None


def lambda_handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "") or ""
    qs = event.get("queryStringParameters") or {}
    if method == "OPTIONS":
        return {"statusCode": 204, "headers": _CORS, "body": ""}

    body = {}
    raw = event.get("body") or ""
    if raw:
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        try:
            body = json.loads(raw)
        except Exception:
            body = {}

    if path.endswith("/models"):
        return _resp(200, {"models": MODELS})

    # shared-token gate (front-end sends ?t= on GET, token in POST body)
    if WEB_TOKEN and (qs.get("t") or body.get("token")) != WEB_TOKEN:
        return _resp(403, {"error": "invalid token"})

    if path.endswith("/predict") and method == "POST":
        return _predict(body)
    if path.endswith("/status"):
        return _status(qs)
    if path.endswith("/msa"):
        return _msa(qs)
    if path.endswith("/template") or path.endswith("/templates"):
        return _templates(qs)
    if path.endswith("/brief"):
        return _brief(qs)
    if path.endswith("/poolfile"):
        return _poolfile(qs)
    if path.endswith("/pool"):
        return _pool(qs)
    if path.endswith("/jobs"):
        return _jobs()
    if path.endswith("/cancel") and method == "POST":
        return _cancel(body)
    return _resp(404, {"error": "not found", "path": path})


def _handler_env(model):
    """The per-model handler Lambda's env holds SERVER_CONFIG_JSON + tool versions +
    state-machine ARN — the exact config it would use to start an execution."""
    if model not in _ENV_CACHE:
        c = lam.get_function_configuration(FunctionName=_handler_fn(model))
        _ENV_CACHE[model] = c["Environment"]["Variables"]
    return _ENV_CACHE[model]


def _predict(body):
    entities, err = _parse_entities(body)
    if err:
        return _resp(400, {"error": err})
    model = body.get("model") or "daslab-ptnx1"
    if model not in MODEL_IDS:
        model = "daslab-ptnx1"
    mode = ((body.get("options") or {}).get("mode") or "protenix-mt")
    if mode not in ("protenix-mt", "rmsa", "both", "none"):
        mode = "protenix-mt"
    tag = "nomsa" if mode == "none" else "msa"
    # per-request fleet knobs: N seeds x N samples/seed (RNAnix fleet models). Defaults match the
    # image (3 seeds, 5 samples). Non-fleet models (protenix ptnx1) ignore these env vars.
    opt = body.get("options") or {}
    try:
        n_seeds = int(opt.get("seeds") or 3)
    except (TypeError, ValueError):
        n_seeds = 3
    try:
        n_sample = int(opt.get("samples") or 5)
    except (TypeError, ValueError):
        n_sample = 5
    n_seeds = max(1, min(MAX_SEEDS, n_seeds))
    n_sample = max(1, min(MAX_SAMPLES, n_sample))
    seeds_str = ",".join(SEED_POOL[:n_seeds])
    # target key covers the full ORDERED entity list (type|seq-or-ligand|count) + model + mode +
    # fleet knobs, so distinct complexes/settings never collide (homodimer count:2 vs monomer; 1 vs 5 seeds).
    parts = [f"{e['type']}:{e.get('seq', e.get('value', ''))}:{e['count']}" for e in entities]
    expert = bool(opt.get("expert", False))
    description = str(opt.get("description", "") or "")[:500]
    # expert/description change what gets folded (a curated template feeds the fold job), so they
    # must be part of the cache key -- otherwise an expert request could return a stale non-expert
    # cached result, or two different descriptions for the same sequence could collide.
    key = f"{model}|{mode}|s{n_seeds}|n{n_sample}|expert{int(expert)}|{description}|" + "|".join(parts)
    target_id = "web" + hashlib.sha256(key.encode()).hexdigest()[:12]

    # cache: a finalized structure already exists
    if _inference_result_pdb(target_id, model):
        return _resp(200, {"job_id": f"{model}:{target_id}::{tag}", "target_id": target_id,
                           "model": model, "status": "CACHED", "mode": mode})

    # build the pipeline input from the handler's own config; effective_msa_kind is
    # driven by the request ("none" skips both the MSA and rMSA opt-in checks).
    # submit=false -> structure is produced but NOT submitted to CASP.
    try:
        env = _handler_env(model)
        sc = json.loads(env.get("SERVER_CONFIG_JSON", "{}"))
    except Exception as e:
        return _resp(502, {"error": f"config read failed: {e}"})
    # thread the fleet knobs into the server config passed to the SageMaker env; step_functions.tf
    # injects them via "SEEDS.$" = "$.server.seeds" / "N_SAMPLE.$" = "$.server.n_sample".
    sc = {**sc, "seeds": seeds_str, "n_sample": str(n_sample)}
    total = sum(len(e["seq"]) * e["count"] for e in entities if e["type"] != "ligand")
    has_rna = any(e["type"] == "rna" for e in entities)
    thr = int(sc.get("large_residue_threshold", 2000))
    tbm = int(sc.get("tbm_fallback_nt", 1000))
    if thr < total <= tbm:
        sc = {**sc, "instance_type": sc.get("large_instance_type", "ml.g7e.2xlarge")}
    eff = mode
    if eff != "none" and total > tbm and eff in ("rmsa", "both"):
        eff = "protenix-mt"
    if eff in ("rmsa", "both") and not has_rna:
        eff = "protenix-mt"   # rMSA is RNA-specific — no RNA chain means nothing for it to align

    # Protenix/AF3 input: one sequences[] entry per entity (count expands to physical chains).
    # Ligand encoding matches the pipeline exactly: a CCD code -> {"ccdCodes": ["MG"]}; a SMILES
    # string -> {"ligand": "<smiles>"} (see handler.py extra_sequences + the rna-ligand fixture).
    sequences, smiles_ligand = [], ""
    for e in entities:
        if e["type"] == "ligand":
            if e.get("is_ccd"):
                sequences.append({"ligand": {"ccdCodes": [e["value"].upper()], "count": e["count"]}})
            else:
                sequences.append({"ligand": {"ligand": e["value"], "count": e["count"]}})
                if not smiles_ligand:
                    smiles_ligand = e["value"]
        else:
            sequences.append({_PTX_KEY[e["type"]]: {"count": e["count"], "sequence": e["seq"]}})
    protenix = json.dumps([{"name": target_id, "sequences": sequences}])
    # multi-record FASTA: one record per PHYSICAL polymer chain (A, B, C, …); ligands carry no MSA.
    recs, ci = [], 0
    for e in entities:
        for _ in range(e["count"]):
            cid = _LETTERS[ci] if ci < len(_LETTERS) else f"z{ci}"
            ci += 1
            if e["type"] != "ligand":
                recs.append(f">{target_id}_{cid}\n{e['seq']}\n")
    fasta = "".join(recs)
    # Every task (MSA / rMSA Fargate containers AND the MSAStubBuild Lambda) reads
    # protenix_input.json from request_input_prefix — the handler stores it for all
    # requests, so the bridge must too. Ligands are inline in sequences[] (verified against the
    # rna-ligand fixture + handler.py).
    req_prefix = f"requests/{env['SERVER_KEY']}/web-{target_id}"
    try:
        s3.put_object(Bucket=env.get("ARTIFACTS_BUCKET", ""),
                      Key=f"{req_prefix}/protenix_input.json",
                      Body=protenix.encode(), ContentType="application/json")
        # A SMILES ligand also needs a companion ligand.json (the MSA container reads it to build
        # the ligand template SDF). CCD-code ligands are self-contained and need none.
        if smiles_ligand:
            s3.put_object(Bucket=env.get("ARTIFACTS_BUCKET", ""),
                          Key=f"{req_prefix}/ligand.json",
                          Body=json.dumps({"ligand_id": "", "ligand_name": "",
                                           "ligand_smiles": smiles_ligand, "ligand_task": "",
                                           "fileloc": ""}).encode(),
                          ContentType="application/json")
    except Exception as e:
        return _resp(502, {"error": f"input upload failed: {e}"})
    ename = f"{env['SERVER_KEY']}-{re.sub(r'[^a-zA-Z0-9-]', '-', target_id)}-{uuid.uuid4().hex[:8]}"
    inp = {
        "fasta": fasta, "fasta_sha256": hashlib.sha256(fasta.encode()).hexdigest(),
        "request_input_prefix": req_prefix, "target_id": target_id, "reply": "", "fileloc": "",
        "server_name": env.get("SERVER_NAME", ""), "server_key": env["SERVER_KEY"],
        "server": sc, "stage": env.get("STAGE", "prod"), "submit": False, "ack": False,
        "msa_tool_version": env.get("MSA_TOOL_VERSION", ""),
        "templates_tool_version": env.get("TEMPLATES_TOOL_VERSION", ""),
        "rmsa_tool_version": env.get("RMSA_TOOL_VERSION", ""),
        "artifacts_bucket": env.get("ARTIFACTS_BUCKET", ""),
        "total_residues": total, "effective_msa_kind": eff,
        "relax": bool(opt.get("relax", True)),  # OpenMM relax post-process; checked by default
        "expert": expert,  # Claude research + curated template; unchecked by default
        "description": description,
    }
    try:
        sfn.start_execution(stateMachineArn=env["STATE_MACHINE_ARN"], name=ename,
                            input=json.dumps(inp))
    except Exception as e:
        return _resp(502, {"error": f"start failed: {e}"})
    return _resp(200, {"job_id": f"{model}:{target_id}:{ename}:{tag}", "target_id": target_id,
                       "model": model, "status": "submitted", "mode": mode})


def _status(qs):
    job = qs.get("job") or ""
    parts = job.split(":")
    model = parts[0] if parts else "daslab-ptnx1"
    target_id = parts[1] if len(parts) > 1 else ""
    ename = parts[2] if len(parts) > 2 else ""
    stage = parts[3] if len(parts) > 3 and parts[3] in ("msa", "nomsa") else "msa"
    # state stays None until we have POSITIVE evidence of a live execution status. Do NOT
    # default to "running": an execution that can't be resolved (deleted/expired history, a
    # recreated pipeline, a job_id from a prior backend generation/STAGE, ...) is not evidence
    # it's still running. This used to default to "running" here, which silently flipped
    # already-"done" jobs back to a false "running" the moment the client re-checked them.
    state, err = None, None
    if ename:
        try:
            st = sfn.describe_execution(executionArn=_exec_arn(model, ename))["status"]
            state = _STATE.get(st, "running")
            if state == "error":
                err = st
        except Exception as e:
            err = str(e)   # unresolvable execution -- leave state unset, fall through below
    cif = _inference_result_pdb(target_id, model) if target_id else None
    # legacy fallback: jobs from the pre-inference/ backend generation (CASP-prod results copied
    # here) have no inference/ manifest and an unresolvable execution (state is None). Read their
    # submissions/<target>/<model>/<ts>.pdb so those "done" jobs keep opening. Gated on state is
    # None so a live prediction (state="running"/"done") never hits the extra S3 list.
    legacy_url = None
    if cif is None and state is None and target_id:
        legacy_url = _submissions_result_url(target_id, model)   # presigned S3 URL, fetched client-side
    # Only trust a readable manifest as "done" when the execution isn't actively RUNNING.
    # finalize_inference now writes its manifest before RelaxPicks (Phase 2) runs after it, so a
    # readable manifest no longer means the whole pipeline finished -- state="running" from a
    # live, resolvable execution overrides it. (state is None -- unresolvable/expired history,
    # e.g. an old job from a prior backend generation -- still trusts the S3 result, unchanged.)
    if cif and state != "running":
        return _resp(200, {"state": "done", "stages": {stage: {"status": "done", "cif": cif}}})
    # legacy job: return the presigned URL, not the bytes -- the browser downloads straight from S3.
    if legacy_url:
        return _resp(200, {"state": "done", "stages": {stage: {"status": "done", "url": legacy_url}}})
    if state is None:
        # no live execution to report AND no finalized result in S3 -- genuinely unknown
        # (e.g. a foreign/prior-generation job_id), distinct from "running" so the client
        # never mistakes "we can't resolve this" for real progress.
        state = "unknown"
    return _resp(200, {"state": state, "error": err, "stages": {}})


def _msa(qs):
    """Return the MSA/rMSA alignment files for a job so the web export can bundle them.
    The pipeline caches them at cache/{msa|rmsa}/{tool_version}/{fasta_sha256}/ — all
    derivable from the execution input."""
    job = qs.get("job") or ""
    parts = job.split(":")
    model = parts[0] if parts else "daslab-ptnx1"
    ename = parts[2] if len(parts) > 2 else ""
    tag = parts[3] if len(parts) > 3 else "msa"
    if tag == "nomsa" or not ename:
        return _resp(200, {"files": []})            # single-sequence: no alignment
    try:
        inp = json.loads(sfn.describe_execution(executionArn=_exec_arn(model, ename))["input"])
    except Exception as e:
        return _resp(200, {"files": [], "error": str(e)})
    sha = inp.get("fasta_sha256", "")
    eff = inp.get("effective_msa_kind", "")
    if not sha:
        return _resp(200, {"files": []})
    prefixes = []
    if eff in ("protenix-mt", "both"):
        prefixes.append(("msa", inp.get("msa_tool_version", "")))
    if eff in ("rmsa", "both"):
        prefixes.append(("rmsa", inp.get("rmsa_tool_version", "")))
    files, total, CAP = [], 0, 4_500_000          # keep the JSON response under the API limit
    for kind, tv in prefixes:
        try:
            r = s3.list_objects_v2(Bucket=ARTIFACTS_BUCKET, Prefix=f"cache/{kind}/{tv}/{sha}/")
        except Exception:
            continue
        for o in r.get("Contents", []):
            key = o["Key"]
            leaf = key.rsplit("/", 1)[-1]
            if not leaf.lower().endswith((".a3m", ".fasta", ".sto", ".aln", ".afa")):
                continue                                # skip sentinels / input mirrors / csv
            fn = kind + "/" + leaf
            if o["Size"] > CAP or total + o["Size"] > CAP:
                files.append({"name": fn, "truncated": True})
                continue
            try:
                files.append({"name": fn, "content": s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=key)["Body"].read().decode("utf-8", "replace")})
                total += o["Size"]
            except Exception:
                continue
    return _resp(200, {"files": files})


def _templates(qs):
    """Return the JohnTBM per-chain template files for a job so the web export can
    bundle them. The pipeline's Templates step caches them at
    cache/templates/{templates_tool_version}/{fasta_sha256}/ (same scheme as the MSA
    step; see cache_check.py kind="templates"). These are the structural templates the
    model was conditioned on (per-chain .templates.csv + any JTBM structures)."""
    job = qs.get("job") or ""
    parts = job.split(":")
    model = parts[0] if parts else "daslab-ptnx1"
    ename = parts[2] if len(parts) > 2 else ""
    if not ename:
        return _resp(200, {"files": []})           # cached/single-seq jobs: no execution to read
    try:
        inp = json.loads(sfn.describe_execution(executionArn=_exec_arn(model, ename))["input"])
    except Exception as e:
        return _resp(200, {"files": [], "error": str(e)})
    sha = inp.get("fasta_sha256", "")
    tv = inp.get("templates_tool_version", "")
    if not sha or not tv:
        return _resp(200, {"files": []})
    files, total, CAP = [], 0, 4_500_000           # keep the JSON response under the API limit
    try:
        r = s3.list_objects_v2(Bucket=ARTIFACTS_BUCKET, Prefix=f"cache/templates/{tv}/{sha}/")
    except Exception as e:
        return _resp(200, {"files": [], "error": str(e)})
    for o in r.get("Contents", []):
        key = o["Key"]
        leaf = key.rsplit("/", 1)[-1]
        if not leaf.lower().endswith((".csv", ".pdb", ".cif")):
            continue                                # skip the 'done'/'pending' sentinels
        fn = "templates/" + leaf
        if o["Size"] > CAP or total + o["Size"] > CAP:
            files.append({"name": fn, "truncated": True})
            continue
        try:
            files.append({"name": fn, "content": s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=key)["Body"].read().decode("utf-8", "replace")})
            total += o["Size"]
        except Exception:
            continue
    return _resp(200, {"files": files})


def _brief(qs):
    """Return the Phase 3 (Expert mode) research brief/rationale/thinking + gate verdict for a
    job, for the web UI's "Why these picks" panel. finalize_inference.py writes
    gate/template_pdb_ids into inference/<target>/<model>/manifest.json; the research Lambda
    itself writes brief.md/rationale.md/thinking.md under research/<target>/<model>/ (a separate
    prefix -- that Lambda's IAM role is scoped read/write to research/* only, it never touches
    inference/*). thinking.md is Claude's own summarized extended-thinking trace from the
    research call -- the actual reasoning, not just the final brief/rationale conclusions.
    Non-expert jobs simply have nothing at either location, so this always returns 200 with
    empty strings/SUSPECT."""
    job = qs.get("job") or ""
    parts = job.split(":")
    model = parts[0] if parts else "daslab-ptnx1"
    target_id = parts[1] if len(parts) > 1 else ""
    if not target_id:
        return _resp(200, {"gate": "SUSPECT", "template_pdb_ids": [], "brief": "", "rationale": "", "thinking": ""})

    gate, template_pdb_ids = "SUSPECT", []
    try:
        manifest = json.loads(s3.get_object(
            Bucket=ARTIFACTS_BUCKET, Key=f"inference/{target_id}/{model}/manifest.json")["Body"].read())
        gate = manifest.get("gate", "SUSPECT")
        template_pdb_ids = manifest.get("template_pdb_ids", [])
    except Exception:
        pass

    def _read(name):
        try:
            return s3.get_object(
                Bucket=ARTIFACTS_BUCKET, Key=f"research/{target_id}/{model}/{name}"
            )["Body"].read().decode("utf-8", "replace")
        except Exception:
            return ""

    return _resp(200, {
        "gate": gate,
        "template_pdb_ids": template_pdb_ids,
        "brief": _read("brief.md"),
        "rationale": _read("rationale.md"),
        "thinking": _read("thinking.md"),
    })


def _pool_prefix(job):
    """predictions/<target_id>/<model>/ — the SageMaker predict step writes the full
    sample pool here (one <branch>-<ts>/<target>/seed_<N>/predictions/ tree per MSA
    branch, each with <target>_sample_<i>.cif + summary_confidence_sample_<i>.json).
    Derivable from the job_id alone, so it also works for CACHED jobs (empty exec)."""
    parts = job.split(":")
    model = parts[0] if parts else ""
    target_id = parts[1] if len(parts) > 1 else ""
    if not model or model not in MODEL_IDS or not target_id:
        return None, None
    return f"predictions/{target_id}/{model}/", model


def _pool(qs):
    """List the entire prediction pool for a job (metadata only — keys + sizes, always
    small) so the web export can fetch each file via /poolfile and zip it client-side.
    This avoids the API's response-size limit that a single inline bundle would hit."""
    prefix, _ = _pool_prefix(qs.get("job") or "")
    if not prefix:
        return _resp(200, {"files": []})
    files = []
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=ARTIFACTS_BUCKET, Prefix=prefix):
            for o in page.get("Contents", []):
                key = o["Key"]
                if key.lower().endswith((".cif", ".pdb", ".json")):
                    files.append({"key": key, "name": key[len(prefix):], "size": o["Size"]})
    except Exception as e:
        return _resp(200, {"files": [], "error": str(e)})
    return _resp(200, {"files": files, "count": len(files),
                       "bytes": sum(f["size"] for f in files)})


def _poolfile(qs):
    """Proxy a single pool file's content. The key MUST live under this job's own
    predictions/<target>/<model>/ prefix (prevents reading arbitrary bucket objects)."""
    prefix, _ = _pool_prefix(qs.get("job") or "")
    key = qs.get("key") or ""
    if not prefix or not key.startswith(prefix) or ".." in key:
        return _resp(403, {"error": "invalid key"})
    try:
        body = s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=key)["Body"].read()
    except Exception as e:
        return _resp(404, {"error": str(e)})
    return {"statusCode": 200,
            "headers": {"Content-Type": "text/plain; charset=utf-8", **_CORS},
            "body": body.decode("utf-8", "replace")}


def _list_all(prefix, max_pages=8):
    """Paginated list_objects_v2 (capped) -> list of {Key, LastModified}."""
    out, token, pages = [], None, 0
    while pages < max_pages:
        kw = {"Bucket": ARTIFACTS_BUCKET, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        try:
            resp = s3.list_objects_v2(**kw)
        except Exception:
            break
        out.extend(resp.get("Contents", []))
        token = resp.get("NextContinuationToken")
        pages += 1
        if not token:
            break
    return out


def _ts_from_name(name):
    """submissions/<...>/<YYYYMMDDTHHMMSSZ>.pdb -> epoch seconds (the real fold time; the object's
    LastModified is just when it was copied into the bucket, so it's useless for ordering)."""
    try:
        return datetime.datetime.strptime(name.split(".")[0], "%Y%m%dT%H%M%SZ").replace(
            tzinfo=datetime.timezone.utc).timestamp()
    except Exception:
        return None


_STORED_CACHE = {"ts": 0.0, "map": None}


def _stored_web_jobs():
    """{web-target_id: (model, ts)} for every completed job with a result in storage
    (inference/<t>/<m>/manifest.json or submissions/<t>/<m>/<ts>.pdb). Lets ANY browser see a
    finished job it didn't submit, not just the one held in that browser's localStorage. Only
    website (web*) jobs -- CASP targets are excluded. Cached ~60 s since it lists the bucket."""
    now = time.time()
    c = _STORED_CACHE
    if c["map"] is not None and now - c["ts"] < 60:
        return c["map"]
    stored = {}

    def note(tgt, model, ts):
        if not tgt.startswith("web") or model not in MODEL_IDS or ts is None:
            return
        if tgt not in stored or ts > stored[tgt][1]:
            stored[tgt] = (model, ts)

    for o in _list_all("inference/"):
        p = o["Key"].split("/")
        if len(p) >= 3 and p[-1] == "manifest.json":
            note(p[1], p[2], o["LastModified"].timestamp())
    for o in _list_all("submissions/"):
        p = o["Key"].split("/")
        if len(p) >= 4 and p[-1].endswith(".pdb"):
            note(p[1], p[2], _ts_from_name(p[-1]) or o["LastModified"].timestamp())
    c["map"], c["ts"] = stored, now
    return stored


def _jobs():
    # Merge two sources so completed jobs are reachable from any browser (deduped by target_id):
    #   1) recent atlas executions -> live state (running / error / done), authoritative
    #   2) completed web* results in storage -> "done" (covers other browsers / prior generations)
    by_tgt = {}
    for m in MODELS:
        try:
            r = sfn.list_executions(stateMachineArn=_pipeline_arn(m["id"]), maxResults=10)
        except Exception:
            continue
        for e in r.get("executions", []):
            if not e["name"].startswith(f"{m['id']}-web"):
                continue
            tgt = e["name"][len(m["id"]) + 1:].rsplit("-", 1)[0]
            ts = e["startDate"].timestamp()
            cur = by_tgt.get(tgt)
            if not cur or ts > cur["_ts"]:
                by_tgt[tgt] = {"job_id": f"{m['id']}:{tgt}:{e['name']}", "model": m["id"],
                               "name": tgt, "state": _STATE.get(e["status"], e["status"].lower()), "_ts": ts}
    for tgt, (model, ts) in _stored_web_jobs().items():
        if tgt in by_tgt:
            continue   # a live/recent execution is more authoritative than the stored result
        by_tgt[tgt] = {"job_id": f"{model}:{tgt}", "model": model, "name": tgt, "state": "done", "_ts": ts}
    jobs = sorted(by_tgt.values(), key=lambda j: j["_ts"], reverse=True)
    for j in jobs:
        j.pop("_ts", None)
    return _resp(200, {"jobs": jobs[:50]})


def _cancel(body):
    parts = (body.get("job_id") or "").split(":", 2)
    if len(parts) < 3 or not parts[2]:
        return _resp(400, {"error": "bad job_id"})
    try:
        sfn.stop_execution(executionArn=_exec_arn(parts[0], parts[2]), cause="cancelled from web atlas")
    except Exception as e:
        return _resp(502, {"error": str(e)})
    return _resp(200, {"ok": True})
