"""casp-web — thin web bridge between the RNA Atlas /inference page and the CASP
prediction pipeline (us-east-2). Exposes a clean JSON API the front-end already speaks:

  GET  /models                      -> {models:[{id,label}]}
  POST /predict  {sequence,model,options,token}
                                     -> {job_id, target_id, model, status}
  GET  /status?job=<job_id>&t=<tok> -> {state, stages:{msa:{status,cif?}}}
  GET  /jobs?t=<tok>                -> {jobs:[{job_id,model,state,name}]}
  POST /cancel   {job_id,token}     -> {ok}

It REUSES the existing per-model handler Lambda (janelia-das-casp-daslab-<model>-prod)
with submit=false, so predictions run through the SAME Step-Functions/SageMaker engine
but are NOT submitted to CASP. Results (submissions/<target>/<model>/<ts>.pdb in the private
artifacts bucket) are read server-side and returned inline, behind a shared web token.

job_id is compound: "<model>:<target_id>:<executionName>" so /status & /cancel are self-contained.
Env: ARTIFACTS_BUCKET, WEB_TOKEN (gate passcode), ACCOUNT, REGION, STAGE.
"""
import base64
import hashlib
import json
import os
import re
import uuid

import boto3

lam = boto3.client("lambda")
sfn = boto3.client("stepfunctions")
s3 = boto3.client("s3")
_ENV_CACHE = {}

ACCOUNT = os.environ.get("ACCOUNT", "481088927481")
REGION = os.environ.get("REGION", "us-east-2")
STAGE = os.environ.get("STAGE", "prod")
ARTIFACTS_BUCKET = os.environ.get("ARTIFACTS_BUCKET", "janelia-das-casp-artifacts-prod")
WEB_TOKEN = os.environ.get("WEB_TOKEN", "")

MODELS = [
    {"id": "daslab-ptnx1", "label": "Protenix (ptnx1)"},
    {"id": "daslab-base", "label": "daslab base"},
    {"id": "daslab-v0", "label": "daslab v0"},
]
MODEL_IDS = {m["id"] for m in MODELS}
_STATE = {"RUNNING": "running", "SUCCEEDED": "done", "FAILED": "error",
          "ABORTED": "error", "TIMED_OUT": "error"}
_CORS = {"Access-Control-Allow-Origin": "*",
         "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
         "Access-Control-Allow-Headers": "content-type"}


def _resp(code, obj):
    return {"statusCode": code, "headers": {"Content-Type": "application/json", **_CORS},
            "body": json.dumps(obj)}


def _handler_fn(model):
    return f"janelia-das-casp-{model}-{STAGE}"


def _exec_arn(model, name):
    return f"arn:aws:states:{REGION}:{ACCOUNT}:execution:janelia-das-casp-{model}-pipeline-{STAGE}:{name}"


def _pipeline_arn(model):
    return f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:janelia-das-casp-{model}-pipeline-{STAGE}"


def _latest_pdb(target_id, model):
    try:
        r = s3.list_objects_v2(Bucket=ARTIFACTS_BUCKET, Prefix=f"submissions/{target_id}/{model}/")
    except Exception:
        return None
    keys = sorted(o["Key"] for o in r.get("Contents", []) if o["Key"].endswith(".pdb"))
    return keys[-1] if keys else None


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
    seq = (body.get("sequence") or "").upper().replace("T", "U")
    seq = "".join(c for c in seq if c in "ACGUN")
    if len(seq) < 5:
        return _resp(400, {"error": "sequence must be >= 5 nt (A/C/G/U/N)"})
    model = body.get("model") or "daslab-ptnx1"
    if model not in MODEL_IDS:
        model = "daslab-ptnx1"
    mode = ((body.get("options") or {}).get("mode") or "protenix-mt")
    if mode not in ("protenix-mt", "rmsa", "both", "none"):
        mode = "protenix-mt"
    tag = "nomsa" if mode == "none" else "msa"
    # target key separates alignment modes for the same sequence+model
    target_id = "web" + hashlib.sha256((model + "|" + mode + "|" + seq).encode()).hexdigest()[:12]

    # cache: a finalized structure already exists
    if _latest_pdb(target_id, model):
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
    total = len(seq)
    thr = int(sc.get("large_residue_threshold", 2000))
    tbm = int(sc.get("tbm_fallback_nt", 1000))
    if thr < total <= tbm:
        sc = {**sc, "instance_type": sc.get("large_instance_type", "ml.g7e.2xlarge")}
    eff = mode
    if eff != "none" and total > tbm and eff in ("rmsa", "both"):
        eff = "protenix-mt"
    fasta = f">{target_id}\n{seq}\n"
    # Every task (MSA / rMSA Fargate containers AND the MSAStubBuild Lambda) reads
    # protenix_input.json from request_input_prefix — the handler stores it for all
    # requests, so the bridge must too (RNA-only: no ligand.json needed).
    req_prefix = f"requests/{env['SERVER_KEY']}/web-{target_id}"
    protenix = json.dumps([{"name": target_id,
                            "sequences": [{"rnaSequence": {"count": 1, "sequence": seq}}]}])
    try:
        s3.put_object(Bucket=env.get("ARTIFACTS_BUCKET", ""),
                      Key=f"{req_prefix}/protenix_input.json",
                      Body=protenix.encode(), ContentType="application/json")
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
    state, err = "running", None
    if ename:
        try:
            st = sfn.describe_execution(executionArn=_exec_arn(model, ename))["status"]
            state = _STATE.get(st, "running")
            if state == "error":
                err = st
        except Exception:
            state = "running"
    key = _latest_pdb(target_id, model) if target_id else None
    if key:
        try:
            cif = s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=key)["Body"].read().decode()
            return _resp(200, {"state": "done", "stages": {stage: {"status": "done", "cif": cif}}})
        except Exception as e:
            return _resp(200, {"state": "error", "error": f"result read failed: {e}"})
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


def _jobs():
    jobs = []
    for m in MODELS:
        try:
            r = sfn.list_executions(stateMachineArn=_pipeline_arn(m["id"]), maxResults=8)
        except Exception:
            continue
        for e in r.get("executions", []):
            if not e["name"].startswith(f"{m['id']}-web"):
                continue
            tgt = e["name"][len(m["id"]) + 1:].rsplit("-", 1)[0]
            jobs.append({"job_id": f"{m['id']}:{tgt}:{e['name']}", "model": m["id"],
                         "name": tgt, "state": _STATE.get(e["status"], e["status"].lower())})
    return _resp(200, {"jobs": jobs[:20]})


def _cancel(body):
    parts = (body.get("job_id") or "").split(":", 2)
    if len(parts) < 3 or not parts[2]:
        return _resp(400, {"error": "bad job_id"})
    try:
        sfn.stop_execution(executionArn=_exec_arn(parts[0], parts[2]), cause="cancelled from web atlas")
    except Exception as e:
        return _resp(502, {"error": str(e)})
    return _resp(200, {"ok": True})
