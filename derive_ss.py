#!/usr/bin/env python
"""Clean secondary structure from the predicted 3D, for one dataset.

Unlike analyze_ss.py (which accepted any 2-H-bond edge contact and so picked up tertiary/
non-canonical pairs -> fake helices + fake pseudoknots), this only accepts CANONICAL
Watson-Crick / wobble pairs: complementary bases (A-U, G-C, G-U) with the specific WC-edge
H-bond geometry. From those clean pairs we derive:

    bp_fraction, pseudoknot (only a crossing of real >=2bp helices), ss_class
    (unpaired / hairpin / two-helix / multiloop / pseudoknot), and the dot-bracket.

Updates dist/datasets/<ds>/data/{folds.json,pairing.json}; for ribo2, data/{folds,pairing}.json
(structures read from config.json struct_bases). Run in the `rna` env.

  python derive_ss.py --name ribo2 --workers 48
"""
import argparse
import gzip
import json
import os
from multiprocessing import Pool

ROOT = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(ROOT, "config.json")))
MIN_STEM = 2
HB = 3.4          # H-bond cutoff (A)
# canonical WC/wobble edge H-bonds: PAIR_HB[(b1,b2)] = [(atom_on_b1, atom_on_b2), ...]
PAIR_HB = {
    ("A", "U"): [("N1", "N3"), ("N6", "O4")],
    ("G", "C"): [("N1", "N3"), ("N2", "O2"), ("O6", "N4")],
    ("G", "U"): [("N1", "O2"), ("O6", "N3")],
}
NEED = {"A": ["N1", "N6"], "U": ["N3", "O4", "O2"], "G": ["N1", "N2", "O6"], "C": ["N3", "N4", "O2"]}


def hb_list(bi, bj):
    if (bi, bj) in PAIR_HB:
        return PAIR_HB[(bi, bj)]
    if (bj, bi) in PAIR_HB:
        return [(c, a) for a, c in PAIR_HB[(bj, bi)]]
    return None


def struct_path_ribo2(sid):
    lib = sid.split("-")[1].replace("ribonanza2", "").upper()
    base = CFG["struct_bases"]["AE"] if lib and lib[0] in "ABCDE" else CFG["struct_bases"]["FGH"]
    return os.path.join(base, sid + ".cif")


def read_chain(path):
    import gemmi
    if path.endswith(".cif"):
        st = gemmi.read_structure(path)
    else:
        with open(path, "rb") as fh:
            raw = fh.read()
        txt = gzip.decompress(raw).decode() if raw[:2] == b"\x1f\x8b" else raw.decode()
        st = gemmi.read_pdb_string(txt)
    return st[0][0]


def base_of(resn):
    nm = resn.strip().upper()
    return {"RA": "A", "RG": "G", "RC": "C", "RU": "U", "ADE": "A", "GUA": "G", "CYT": "C", "URA": "U"}.get(nm, nm)


def crosses(p, q):
    a, b = p; c, d = q
    return (a < c < b < d) or (c < a < d < b)


def to_dbn(n, pairs):
    OPEN, CLOSE = "([{<", ")]}>"
    dbn = ["."] * n
    levels = []
    pk_pairs = []
    for (i, j) in sorted(pairs):
        lvl = 0
        while True:
            if lvl >= len(levels):
                levels.append([])
            if not any(crosses((i, j), pq) for pq in levels[lvl]):
                levels[lvl].append((i, j))
                o = OPEN[lvl] if lvl < 4 else OPEN[-1]
                c = CLOSE[lvl] if lvl < 4 else CLOSE[-1]
                dbn[i], dbn[j] = o, c
                if lvl > 0:
                    pk_pairs.append((i, j))
                break
            lvl += 1
    return "".join(dbn), pk_pairs


def stems(pairs):
    """maximal stacked runs -> list of (outer_pair, length)."""
    P = set(pairs); out = []
    for (i, j) in P:
        if (i - 1, j + 1) in P:
            continue
        a, b, L = i, j, 1
        while (a + 1, b - 1) in P:
            a, b, L = a + 1, b - 1, L + 1
        out.append(((i, j), L))
    return out


def n_helices(pairs):
    """Number of hairpin loops backed by a >=MIN_STEM stem. A bulged/internal-loop stem
    counts once (one terminal loop); branching (multiloops) yields multiple. This is the
    topology-correct helix count — raw stacked-run counting splits bulged hairpins."""
    P = set(pairs)
    cnt = 0
    for (i, j) in P:
        if any(i < k < l < j for (k, l) in P):    # encloses another pair -> not a terminal loop
            continue
        a, b, L = i, j, 1                          # walk outward to measure the closing stem
        while (a - 1, b + 1) in P:
            a, b, L = a - 1, b + 1, L + 1
        if L >= MIN_STEM:
            cnt += 1
    return cnt


def process(args):
    sid, path = args
    try:
        chain = read_chain(path)
        res = list(chain)
        n = len(res)
        coords, bases = [], []
        for r in res:
            b = base_of(r.name)
            bases.append(b)
            c = {}
            if b in NEED:
                for a in r:
                    an = a.name.strip()
                    if an in NEED[b] or an in ("C1'", "C1*"):
                        c["C1'" if an in ("C1'", "C1*") else an] = (a.pos.x, a.pos.y, a.pos.z)
            coords.append(c)

        def d2(p, q):
            return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
        cand = []
        for i in range(n):
            ci = coords[i]
            if "C1'" not in ci or bases[i] not in NEED:
                continue
            for j in range(i + 4, n):
                cj = coords[j]
                if "C1'" not in cj or bases[j] not in NEED:
                    continue
                dd = d2(ci["C1'"], cj["C1'"])
                if dd < 64 or dd > 156:        # C1'-C1' ~8-12.5 A for a WC pair
                    continue
                hl = hb_list(bases[i], bases[j])
                if not hl:
                    continue
                nb = 0
                for ai, aj in hl:
                    if ai in ci and aj in cj and d2(ci[ai], cj[aj]) <= HB * HB:
                        nb += 1
                if nb >= 2:
                    cand.append((-nb, dd, i, j))
        cand.sort()
        used = [False] * n
        pairs = []
        for _, _, i, j in cand:
            if not used[i] and not used[j]:
                used[i] = used[j] = True
                pairs.append((i, j))
        dbn, pk_pairs = to_dbn(n, pairs)
        # pseudoknot only if a real >=2bp helix sits at a crossing level
        pkset = set(pk_pairs)
        pk = 1 if any(L >= MIN_STEM and p in pkset for p, L in stems(pairs)) else 0
        helices = n_helices(pairs)
        bpf = round(2 * len(pairs) / n, 4) if n else 0.0
        if pk:
            cls = "pseudoknot"
        elif helices == 0:
            cls = "unpaired"
        elif helices == 1:
            cls = "hairpin"
        elif helices == 2:
            cls = "two-helix"
        else:
            cls = "multiloop (3+ helices)"
        # 5'/3' termini pairing (for the scaffolding filters) + UUCG tetraloop, from canonical pairs.
        #   termini_bp   = the very ends pair (nt 1 <-> nt N)  [strict]
        #   termini_trim = the first-paired base pairs with the last-paired base, so the
        #                  single-stranded ends (overhang5 / overhang3 nt) can be trimmed to leave
        #                  the termini directly paired. termini_bp is the overhang5==overhang3==0 case.
        pd = {}
        for (i, j) in pairs:
            pd[i] = j
            pd[j] = i
        if pd:
            lo, hi = min(pd), max(pd)
            term_bp = 1 if pd.get(0) == n - 1 else 0
            term_trim = 1 if pd.get(lo) == hi else 0
            oh5 = lo if term_trim else None
            oh3 = (n - 1 - hi) if term_trim else None
        else:
            term_bp = term_trim = 0
            oh5 = oh3 = None
        uucg = 0
        for (i, j) in pairs:
            if j - i - 1 == 4 and not any(k in pd for k in range(i + 1, j)) \
                    and "".join(bases[i + 1:j]) == "UUCG":
                uucg = 1
                break
        return (sid, bpf, pk, cls, dbn, term_bp, term_trim, oh5, oh3, uucg)
    except Exception as e:
        return (sid, None, None, None, f"ERR:{type(e).__name__}", None, None, None, None, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--workers", type=int, default=48)
    args = ap.parse_args()
    if args.name == "ribo2":
        fp, pp = f"{ROOT}/data/folds.json", f"{ROOT}/data/pairing.json"
        folds = json.load(open(fp))
        work = [(f["id"], struct_path_ribo2(f["id"])) for f in folds]
    else:
        dd = f"{ROOT}/dist/datasets/{args.name}"
        fp, pp = f"{dd}/data/folds.json", f"{dd}/data/pairing.json"
        folds = json.load(open(fp))
        work = [(f["id"], f"{dd}/structs/{f['key']}.pdb") for f in folds]
    work = [(s, p) for s, p in work if os.path.exists(p)]
    print(f"{args.name}: {len(work)}/{len(folds)} structures")
    out = {}
    with Pool(args.workers) as pool:
        for r in pool.imap_unordered(process, work, chunksize=16):
            out[r[0]] = r[1:]
    pair = {}
    from collections import Counter
    dist = Counter()
    nerr = nterm = ntrim = nuucg = 0
    for f in folds:
        r = out.get(f["id"])
        if not r or r[0] is None:
            nerr += 1
            continue
        bpf, pk, cls, dbn, term_bp, term_trim, oh5, oh3, uucg = r
        f["bp_fraction"] = bpf; f["pseudoknot"] = pk; f["ss_class"] = cls
        f["termini_bp"] = term_bp; f["termini_trim"] = term_trim
        f["overhang5"] = oh5; f["overhang3"] = oh3; f["uucg_tetraloop"] = uucg
        pair[f["id"]] = dbn
        dist[cls] += 1
        nterm += term_bp; ntrim += term_trim; nuucg += uucg
    json.dump(folds, open(fp, "w"), separators=(",", ":"))
    json.dump(pair, open(pp, "w"), separators=(",", ":"))
    print(f"{args.name}: errors={nerr}  ss_class={dict(dist.most_common())}")
    print(f"{args.name}: termini_bp={nterm}  termini_trim={ntrim}  uucg_tetraloop={nuucg}")


if __name__ == "__main__":
    main()
