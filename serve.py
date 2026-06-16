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
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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
    seq = SEQ.get(seq_id, "") or cif_sequence(seq_id)
    lib = seq_id.split("-")[1].replace("ribonanza2", "")
    fi = int(seq_id.split("-")[0]) - 1
    out = {"seq": seq, "dms": None, "a23": None, "sn": [None, None]}
    # F-H: design-aligned override parquet (only the len>40 coverage subset exists)
    if os.path.exists(REACT_OVERRIDE):
        t = pq.read_table(REACT_OVERRIDE, filters=[("sequence_id", "==", seq_id)]).to_pydict()
        if t["sequence_id"]:
            a23 = np.asarray(t["reactivity_2A3"][0], np.float32)
            dms = np.asarray(t["reactivity_DMS"][0], np.float32)
            dlen = len(seq) or len(a23)
            out["dms"], out["a23"] = _nan_list(dms[:dlen]), _nan_list(a23[:dlen])
            return out
    # A-E: HDF5 r_norm sliced by sub_start
    if lib in HDF5 and seq:
        import h5py
        dlen = len(seq)
        ss = pq.read_table(PARQUET.format(L=lib.upper()), columns=["fasta_index", "sub_start"],
                           filters=[("fasta_index", "==", fi)]).to_pydict()["sub_start"]
        if ss:
            ss = ss[0]
            with h5py.File(HDF5[lib], "r") as fh:
                rn = fh["r_norm"][fi]
                sn = fh["signal_to_noise"][fi]
            seg = rn[ss - 1: ss - 1 + dlen]
            dms = np.array([seg[i, 0] if seq[i] in "AC" else np.nan for i in range(dlen)])
            out["dms"], out["a23"] = _nan_list(dms), _nan_list(seg[:, 1])
            out["sn"] = [round(float(sn[0]), 2), round(float(sn[1]), 2)]
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
            if path.startswith("/struct/"):
                data = read_struct(path[len("/struct/"):])
                return self._send(data, "text/plain") if data else self._send("not found", code=404)
            if path.startswith("/react/"):
                return self._send(json.dumps(reactivity(path[len("/react/"):])), "application/json")
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
    ThreadingHTTPServer((args.host, args.port), H).serve_forever()


if __name__ == "__main__":
    main()
