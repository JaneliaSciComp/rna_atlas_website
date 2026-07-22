#!/usr/bin/env python
"""Minimal static server for the RNA Atlas Explorer.

Serves the web/ app + data/ JSON, and two lazy per-fold endpoints:
  GET /struct/<seq_id>  -> the predicted structure (CIF/PDB text) by exact path
  GET /react/<seq_id>   -> {seq, dms[], a23[], sn[]} design-aligned reactivity

Reactivity is read on demand only for the fold the user opens (no bulk scans).
Run in an env with h5py + pyarrow + numpy (e.g. the `rna` env). Filtering/ranking
all happens client-side; this process only serves bytes.

    python serve.py --port 8765
"""
import argparse
import gzip
import json
import os
import threading
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, HTTPServer

# h5py / gemmi native reads segfault under concurrent access (HDF5 global state is not
# thread-safe). This is a single-user dev/review server, so we serve single-threaded
# (plain HTTPServer, one request at a time) — the safe, simple fix. The lock below is a
# belt-and-suspenders guard in case the server class is ever switched back to threaded.
_NATIVE_LOCK = threading.RLock()

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB, DATA = os.path.join(ROOT, "web"), os.path.join(ROOT, "data")

# All machine-specific absolute paths live in config.json (gitignored) so nothing
# absolute is committed or served to the browser.
CFG = json.load(open(os.path.join(ROOT, "config.json")))
MINED = CFG["mined_dir"]
STRUCT_BASES = CFG["struct_bases"]
PARQUET = CFG["metadata_parquet"]
HDF5 = CFG["hdf5"]
REACT_OVERRIDE = CFG.get("react_override") or os.path.join(MINED, "summary/react_override_fgh40.parquet")
# uniform-spread (cmuts126 --uniform-spread) chemmap for all A-H (see build_static.py for the contract)
UNIFORM_DIR = CFG["uniform_spread_dir"]
FGH_DEFAULT_DIR = CFG["fgh_default_h5_dir"]
FGH_LIBOFF = {"F": 0, "G": 8_000_000, "H": 16_000_000}

SEQ = {}
with open(os.path.join(MINED, "selection.tsv")) as fh:
    next(fh)
    for line in fh:
        p = line.rstrip("\n").split("\t")
        if len(p) >= 2:
            SEQ[p[0]] = p[1]


def struct_path(seq_id):
    lib = seq_id.split("-")[1].replace("ribonanza2", "").upper()
    base = STRUCT_BASES["AE"] if lib in "ABCDE" else STRUCT_BASES["FGH"]
    return os.path.join(base, seq_id + ".cif")


def _nan_list(a):
    return [None if (v != v) else round(float(v), 4) for v in a]


@lru_cache(maxsize=4096)
def cif_sequence(seq_id):
    """Derive the RNA sequence from the predicted structure (F-H lack it in selection.tsv)."""
    p = struct_path(seq_id)
    if not os.path.exists(p):
        return ""
    try:
        import gemmi
        st = gemmi.read_structure(p)
        chain = st[0][0]
        return "".join((r.name if r.name in "AUGC" else "N") for r in chain)
    except Exception:
        return ""


@lru_cache(maxsize=4096)
def reactivity(seq_id):
    import numpy as np
    import pyarrow.parquet as pq
    import h5py
    seq = SEQ.get(seq_id, "") or cif_sequence(seq_id)
    lib = seq_id.split("-")[1].replace("ribonanza2", "").upper()
    fi = int(seq_id.split("-")[0]) - 1
    out = {"seq": seq, "dms": None, "a23": None, "sn": [None, None]}
    # A-E: uniform-spread per-library h5 (reactivity), sliced to the design region by sub_start
    if lib in ("A", "B", "C", "D", "E") and seq:
        dlen = len(seq)
        ss = pq.read_table(PARQUET.format(L=lib), columns=["fasta_index", "sub_start"],
                           filters=[("fasta_index", "==", fi)]).to_pydict()["sub_start"]
        if ss:
            ss = ss[0]
            with h5py.File(f"{UNIFORM_DIR}Ribonanza2{lib}_2A3.h5", "r") as f2, \
                 h5py.File(f"{UNIFORM_DIR}Ribonanza2{lib}_DMS.h5", "r") as fd:
                a23 = np.asarray(f2["reactivity"][fi][ss - 1: ss - 1 + dlen], np.float32)
                dms = np.asarray(fd["reactivity"][fi][ss - 1: ss - 1 + dlen], np.float32)
                out["sn"] = [round(float(fd["SNR"][fi]), 2), round(float(f2["SNR"][fi]), 2)]
            out["a23"] = _nan_list(a23)
            out["dms"] = _nan_list([dms[i] if seq[i] in "AC" else np.nan for i in range(dlen)])
        return out
    # F-H: recover the design offset from the default-spread parquet vs the default FGH h5,
    # then read that same row+offset from the uniform-spread FGH h5.
    if lib in ("F", "G", "H") and os.path.exists(REACT_OVERRIDE):
        t = pq.read_table(REACT_OVERRIDE, filters=[("sequence_id", "==", seq_id)]).to_pydict()
        if t["sequence_id"]:
            pa2 = np.asarray(t["reactivity_2A3"][0], np.float32)
            L = len(pa2)
            row = FGH_LIBOFF[lib] + fi
            if np.isfinite(pa2).sum() >= 5:
                with h5py.File(f"{FGH_DEFAULT_DIR}combined_2A3_samples_normalized.h5", "r") as fdef:
                    hrow = np.asarray(fdef["reactivity"][row], np.float32)
                best = None
                for sh in range(0, 177 - L + 1):
                    seg = hrow[sh:sh + L]
                    m = ~(np.isnan(seg) | np.isnan(pa2))
                    if m.sum() < 5:
                        continue
                    md = float(np.max(np.abs(seg[m] - pa2[m])))
                    if best is None or md < best[0]:
                        best = (md, sh)
                if best is not None and best[0] < 0.02 and len(seq) == L:
                    sh = best[1]
                    with h5py.File(f"{UNIFORM_DIR}Ribonanza2FGH_2A3.h5", "r") as u2, \
                         h5py.File(f"{UNIFORM_DIR}Ribonanza2FGH_DMS.h5", "r") as ud:
                        dms_seg = np.asarray(ud["reactivity"][row][sh:sh + L], np.float32)
                        out["a23"] = _nan_list(np.asarray(u2["reactivity"][row][sh:sh + L], np.float32))
                        out["dms"] = _nan_list([dms_seg[i] if seq[i] in "AC" else np.nan for i in range(len(seq))])
                        out["sn"] = [round(float(ud["SNR"][row]), 2), round(float(u2["SNR"][row]), 2)]
    return out


def read_struct(seq_id):
    p = struct_path(seq_id)
    if not os.path.exists(p):
        return None
    if p.endswith(".gz"):
        with gzip.open(p, "rt") as f:
            return f.read()
    with open(p) as f:
        return f.read()


CT = {".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json"}


class H(BaseHTTPRequestHandler):
    def _send(self, body, ctype="text/plain", code=200):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/":
                return self._serve_file(os.path.join(WEB, "index.html"))
            if path.startswith("/structs/") and path.endswith(".cif"):
                with _NATIVE_LOCK:
                    data = read_struct(path[len("/structs/"):-len(".cif")])
                return self._send(data, "text/plain") if data else self._send("not found", code=404)
            if path.startswith("/react/") and path.endswith(".json"):
                with _NATIVE_LOCK:
                    payload = json.dumps(reactivity(path[len("/react/"):-len(".json")]))
                return self._send(payload, "application/json")
            if path.startswith("/data/datasets/"):   # extra atlases live under /data/ (already gated)
                rel = path[len("/data/datasets/"):]
                base = os.path.join(ROOT, "dist", "datasets")
                fp = os.path.normpath(os.path.join(base, rel))
                if not fp.startswith(base) or not os.path.isfile(fp):
                    return self._send("not found", code=404)
                if fp.endswith(".pdb"):   # stored gzip-compressed; gunzip for the browser
                    with gzip.open(fp, "rt") as f:
                        return self._send(f.read(), "text/plain")
                with open(fp, "rb") as f:
                    return self._send(f.read(), CT.get(os.path.splitext(fp)[1], "application/octet-stream"))
            if path.startswith("/data/"):
                return self._serve_file(os.path.join(DATA, path[len("/data/"):]))
            return self._serve_file(os.path.join(WEB, path.lstrip("/")))
        except Exception as e:
            self._send(f"error: {e}", code=500)

    def _serve_file(self, fp):
        fp = os.path.normpath(fp)
        if not (fp.startswith(WEB) or fp.startswith(DATA)) or not os.path.isfile(fp):
            return self._send("not found", code=404)
        with open(fp, "rb") as f:
            self._send(f.read(), CT.get(os.path.splitext(fp)[1], "application/octet-stream"))

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    print(f"RNA Atlas Explorer: http://{args.host}:{args.port}/  ({len(SEQ)} folds)")
    HTTPServer((args.host, args.port), H).serve_forever()


if __name__ == "__main__":
    main()
