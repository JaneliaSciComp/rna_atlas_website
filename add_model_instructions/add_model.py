#!/usr/bin/env python3
"""add_model.py — deploy a contributed RNAnix model as a selectable community model.

A contributed model is DATA, not infrastructure: a checkpoint + its config + a manifest row,
served by the shared "community fleet" on the atlas stack (no tofu apply, no per-model Lambda).

  export AWS_PROFILE=default AWS_DEFAULT_REGION=us-east-2      # admin SSO (S3 write)
  python3 add_model.py <model-id>.zip        # validate a contributor zip, upload, register
  python3 add_model.py <dir>/                # same, from an already-unzipped directory
  python3 add_model.py --list                # list registered community models
  python3 add_model.py --remove <model-id>   # unregister + delete the model's artifacts

Zip/dir contract (see README.md):
  model.json                # {id, display_name, description, model_name, use_msa,
                            #  use_template, rnaonly, config_overrides?}
  <model_name>.pt           # the RNAnix checkpoint (weights)
  config/                   # the RNAnix config that defines the architecture (yaml/json)

Everything lands under s3://<ARTIFACTS_BUCKET>/community/<id>/ and a row is written to
community/models_manifest.json. The dashboard reads the manifest, so a new model appears with no
redeploy. Serving wiring (community fleet + per-request mount + fleet_predict config threading) is a
one-time pipeline step tracked in README.md §4.
"""
import argparse
import datetime
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

import boto3

ARTIFACTS_BUCKET = os.environ.get("ATLAS_ARTIFACTS_BUCKET", "janelia-das-casp-artifacts-atlas")
COMMUNITY_PREFIX = "community"
MANIFEST_KEY = f"{COMMUNITY_PREFIX}/models_manifest.json"
CKPT_MOUNT = "/opt/ml/processing/input/community"  # where the pipeline mounts community/<id>/
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
REQUIRED_META = ["id", "display_name", "model_name", "use_msa", "use_template", "rnaonly"]

s3 = boto3.client("s3")


def _die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def _load_manifest():
    try:
        obj = s3.get_object(Bucket=ARTIFACTS_BUCKET, Key=MANIFEST_KEY)
        return json.loads(obj["Body"].read())
    except s3.exceptions.NoSuchKey:
        return {"models": []}
    except Exception as e:
        if "NoSuchKey" in str(e) or "Not Found" in str(e):
            return {"models": []}
        raise


def _save_manifest(manifest):
    s3.put_object(Bucket=ARTIFACTS_BUCKET, Key=MANIFEST_KEY,
                  Body=json.dumps(manifest, indent=2).encode(),
                  ContentType="application/json")


def _validate(src: Path):
    """Return (meta, ckpt_path, config_dir) after validating the contract."""
    mj = src / "model.json"
    if not mj.is_file():
        _die(f"{src}/model.json not found")
    try:
        meta = json.loads(mj.read_text())
    except Exception as e:
        _die(f"model.json is not valid JSON: {e}")
    for k in REQUIRED_META:
        if k not in meta:
            _die(f"model.json missing required field: {k}")
    if not ID_RE.match(str(meta["id"])):
        _die(f"id '{meta['id']}' must match [a-z0-9-] (2-63 chars)")
    ckpt = src / f"{meta['model_name']}.pt"
    if not ckpt.is_file():
        _die(f"checkpoint {ckpt.name} not found (must equal model_name + '.pt')")
    cfg = src / "config"
    if not cfg.is_dir() or not any(cfg.iterdir()):
        _die("config/ directory is required and must be non-empty (it defines the architecture)")
    for k in ("use_msa", "use_template", "rnaonly"):
        if not isinstance(meta.get(k), bool):
            _die(f"model.json field '{k}' must be true/false")
    return meta, ckpt, cfg


def _fleet_spec(meta):
    """Single-checkpoint fleet spec (JSON is valid YAML — no PyYAML dependency).
    config_overrides + load_strict are consumed by the community fleet_predict path (README §4)."""
    return {
        "name": f"community-{meta['id']}",
        "description": meta.get("description", ""),
        "checkpoints": [{
            "id": meta["id"],
            "ckpt_dir": CKPT_MOUNT,
            "model_name": meta["model_name"],
            "use_msa": bool(meta["use_msa"]),
            "use_template": bool(meta["use_template"]),
            "rnaonly": bool(meta["rnaonly"]),
            "description": meta.get("description", ""),
            "config_overrides": meta.get("config_overrides", {}),
            "load_strict": True,  # contributed models fail loud on config/weights mismatch
        }],
    }


def _put_file(path: Path, key: str):
    s3.upload_file(str(path), ARTIFACTS_BUCKET, key)
    print(f"  s3://{ARTIFACTS_BUCKET}/{key}  ({path.stat().st_size:,} B)")


def deploy(arg: str):
    tmp = None
    if arg.startswith("s3://"):  # external submission: download the zip first
        bucket, _, key = arg[5:].partition("/")
        if not key.endswith(".zip"):
            _die("s3 source must point at a .zip object")
        dl = tempfile.mkdtemp(prefix="add_model_dl_")
        arg = str(Path(dl) / Path(key).name)
        print(f"downloading s3://{bucket}/{key} ...")
        s3.download_file(bucket, key, arg)
    src = Path(arg)
    if src.is_file() and src.suffix == ".zip":
        tmp = tempfile.mkdtemp(prefix="add_model_")
        with zipfile.ZipFile(src) as z:
            z.extractall(tmp)
        # allow a single top-level dir inside the zip
        entries = [p for p in Path(tmp).iterdir() if not p.name.startswith("__")]
        src = entries[0] if len(entries) == 1 and entries[0].is_dir() else Path(tmp)
    elif not src.is_dir():
        _die(f"{arg} is not a .zip or a directory")

    meta, ckpt, cfg = _validate(src)
    mid = meta["id"]
    base = f"{COMMUNITY_PREFIX}/{mid}"
    print(f"deploying model '{mid}' ({meta['display_name']}) -> s3://{ARTIFACTS_BUCKET}/{base}/")

    _put_file(ckpt, f"{base}/{ckpt.name}")
    for f in sorted(cfg.rglob("*")):
        if f.is_file():
            _put_file(f, f"{base}/config/{f.relative_to(cfg).as_posix()}")
    s3.put_object(Bucket=ARTIFACTS_BUCKET, Key=f"{base}/fleet_spec.yaml",
                  Body=json.dumps(_fleet_spec(meta), indent=2).encode(),
                  ContentType="application/yaml")
    print(f"  s3://{ARTIFACTS_BUCKET}/{base}/fleet_spec.yaml  (generated)")

    manifest = _load_manifest()
    row = {
        "id": mid,
        "display_name": meta["display_name"],
        "description": meta.get("description", ""),
        "model_name": meta["model_name"],
        "prefix": base,
        "fleet_spec": f"{base}/fleet_spec.yaml",
        "use_msa": bool(meta["use_msa"]),
        "use_template": bool(meta["use_template"]),
        "rnaonly": bool(meta["rnaonly"]),
        "community": True,
        "added": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    manifest["models"] = [m for m in manifest.get("models", []) if m.get("id") != mid] + [row]
    _save_manifest(manifest)
    print(f"registered in {MANIFEST_KEY}  ({len(manifest['models'])} community model(s) total)")
    print("done — appears in the dashboard once the community-fleet serving path is live (README §4).")


def list_models():
    manifest = _load_manifest()
    models = manifest.get("models", [])
    if not models:
        print("(no community models registered)")
        return
    for m in models:
        print(f"  {m['id']:<28} {m.get('display_name','')}  [{m.get('added','')}]")


def remove(mid: str):
    base = f"{COMMUNITY_PREFIX}/{mid}"
    objs = s3.list_objects_v2(Bucket=ARTIFACTS_BUCKET, Prefix=f"{base}/").get("Contents", [])
    if objs:
        s3.delete_objects(Bucket=ARTIFACTS_BUCKET,
                          Delete={"Objects": [{"Key": o["Key"]} for o in objs]})
        print(f"deleted {len(objs)} object(s) under {base}/")
    manifest = _load_manifest()
    before = len(manifest.get("models", []))
    manifest["models"] = [m for m in manifest.get("models", []) if m.get("id") != mid]
    _save_manifest(manifest)
    print(f"unregistered '{mid}' ({before} -> {len(manifest['models'])} community model(s))")


def main():
    ap = argparse.ArgumentParser(description="Deploy a contributed RNAnix model as a community model.")
    ap.add_argument("source", nargs="?", help="path to <model-id>.zip or an unzipped directory")
    ap.add_argument("--list", action="store_true", help="list registered community models")
    ap.add_argument("--remove", metavar="ID", help="unregister + delete a community model")
    args = ap.parse_args()
    if args.list:
        list_models()
    elif args.remove:
        remove(args.remove)
    elif args.source:
        deploy(args.source)
    else:
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
