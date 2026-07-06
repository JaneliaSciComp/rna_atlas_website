# Scaling the RNA Atlas Explorer to the full Ribonanza-2 A–H set (~23M)

How to expand the explorer from the **curated ~7.7k folds** (Chaitanya's distillation) to the
**full ~23M** Ribonanza-2 A–H design space — **while keeping the curated set exactly as it is
today**, and optimizing for **fastest latency + a stable, robust site**.

> Status: **planning / design doc.** Nothing here is built yet. See "Decisions to lock" at the end.

---

## 1. Why the current model can't hold 23M

The explorer today is a **static, 100% client-side** app: it loads **every fold into a JS array**
and filters/ranks/maps **in-memory** in the browser.

| | Curated (today) | Full A–H |
|---|---|---|
| Records | **7,757** | **~23,000,000** |
| `folds.json` size | **6.3 MB** (~845 B/record, 39 fields) | **≈ 19 GB** as JSON (≈ **2–4 GB** as compressed Parquet) |
| Load model | whole array in browser memory | impossible to load client-side |

The in-memory model tops out around **~10⁵ records** (the 15 MB `pseudolabels` set is already near the
comfortable limit). 23M is ~1000× past that. **The full set can never be a client-side JSON.**

---

## 2. Core principle

**Two tiers. Don't query 23M unless you have to.**

- **Curated (7.7k)** — stays **100% client-side**, exactly as today. Default view, instant, all
  features, and a working fallback if the big tier is ever down.
- **Full Ribonanza-2 (23M)** — **query-on-demand**, *never fully loaded*. Served from a warm
  columnar engine for arbitrary filter/rank, with as much as possible **pre-baked onto the CDN**.

Layer it so ~95% of interactions are served from the CDN at ~0 ms; only genuine full-set
exploration touches the backend.

---

## 3. Recommended stack (fastest + stable)

| Layer | Choice | Why |
|---|---|---|
| **Front-end** | Static on **S3 + CloudFront** (unchanged) | Edge-cached globally, gated, no server to fall over |
| **Default / curated 7.7k** | **100% client-side** (as today) | Instant; zero backend dependency; graceful fallback |
| **23M metadata query** | **ClickHouse** (managed / right-sized) — *or* **OpenSearch** if full-text over RNAcentral names/descriptions is first-class | Columnar OLAP scans 23M rows in **ms**: sub-second range-filter + rank + facet counts + map GROUP-BY |
| **API** | Thin **always-on Fargate service** (≥2 tasks, multi-AZ, autoscaled) behind CloudFront | **No Lambda cold-starts** (the #1 latency killer); stateless read-only → scales trivially |
| **Map (embedding)** | Precomputed **UMAP → density tiles** as static JSON/PNG on the CDN; drill-down via ClickHouse | Tiles are cached static files → instant + indestructible; only zoom-in hits the DB |
| **Caching** | CloudFront in front of cacheable query GETs + engine query cache + prebaked facet histograms | Repeat/common queries never reach the DB |
| **Per-fold assets** | structs / react / motifs / pairing **lazy-by-key on S3** (as today) | Scales to any N; only fetched when a fold is opened |

> Serverless alternative (cheaper, weaker): **DuckDB-WASM over partitioned Parquet on S3** (client runs
> SQL via HTTP range reads) or **Athena over Parquet**. Near-zero infra cost and keeps the site fully
> static, but ~seconds/query and less robust under load. Choose this only if the always-on cost of the
> recommended stack isn't justified.

---

## 4. What makes it fast

1. **Serve the common case from the CDN.** Default view, curated set, map tiles, facet counts →
   static/cached → **0 ms backend**.
2. **Warm engine + warm API.** Always-on Fargate + ClickHouse → no cold starts, no per-query
   provisioning. This is the difference between ~200 ms and ~5 s.
3. **Transfer only what's shown.** Filter/rank returns **top-N + a total count**, paginated; assets
   stay lazy-by-key. Never move 23M over the wire.
4. **Cache by query.** Deterministic filter combos → CloudFront cache key → popular queries are
   edge-served.
5. **Debounce + cancel** in the UI so only the latest query is in flight.

**Latency budget**
- Curated / default / map tiles: **instant** (client + CDN)
- Full-23M filter + rank + count: **~150–400 ms** (warm API + ClickHouse + cache); sub-second worst case
- Map drill-down: **< 500 ms**

---

## 5. What makes it strong / stable

- **Managed, multi-AZ** engine (ClickHouse Cloud / AWS OpenSearch Service / Aurora) with backups +
  autoscaling — no single box to babysit.
- **Read-only workload** → scales horizontally, caches trivially, no write contention.
- **Graceful degradation** — the static curated 7.7k works fully even if the 23M backend is down; the
  site never goes fully dark.
- **CDN absorbs spikes** for everything static/cached; the DB only sees genuine full-set queries.

---

## 6. The map at 23M (the genuinely hard part)

Can't render 23M points client-side, and **t-SNE won't compute at that scale**.

- Precompute a **UMAP** (or reuse the model's latent 2D) over 23M **offline**.
- Render as a **density heatmap / tiles** (DuckDB/ClickHouse `GROUP BY` grid-cell, or pre-baked
  map-style tiles), with **drill-down**: zoom a region → query/sample the points there.
- Curated 7.7k keep rendering as individual clickable points **on top** of the density layer.

---

## 7. UI changes

- A **scope switch**: *Curated (7.7k — fast, all features)* vs *Full Ribonanza-2 (23M — query mode)*.
- In full mode the table/map become **query-driven** (debounced): show **"N of 23M"**, paginate, and
  disable/adapt features that assume the whole array is in memory.
- Deep view / structure / reactivity unchanged — lazy-by-key works at any scale.

---

## 8. Build pipeline (offline, manifest-driven — no heavy `find` over /groups or /nrs)

From the existing sources (see gitignored `config.json`):
- per-library `Ribonanza2{L}.parquet` metadata + `annotation_manifest.parquet`

1. Assemble the **23M record table** (the 39 fields + cluster IDs) → write **partitioned Parquet**.
2. Compute **UMAP** (or export the model latent 2D) → 2D coords per fold.
3. Bake **map density tiles** + **facet histograms** as static artifacts.
4. Load Parquet into **ClickHouse/OpenSearch**; upload tiles + Parquet to S3.
5. Run once, and on each refresh. Big batch job (LSF / AWS Batch).

Per-fold structures/reactivity are uploaded lazy-by-key **only where they exist** (see scoping below).

---

## 9. Scoping — "support 23M" can mean three very different things (cost drivers)

1. **Metadata/records** (the 39 filterable fields) for 23M — *feasible, few GB.*
2. **The embedding map** for 23M — *hardest (UMAP + density tiles).*
3. **Structures + reactivity** for 23M — *depends: do predictions exist for all 23M, or only the
   curated subset? 23M CIFs could be many TB.*

Most likely target: **#1 (+ #2) now**, with structures/reactivity lazy **only where they exist**.

---

## 10. Rough effort

| Scope | Effort |
|---|---|
| Metadata filter/rank over 23M (engine + query API, swap in-memory filter → SQL in "full" mode; no map) | ~1–2 weeks |
| + density map (UMAP + prebaked tiles + drill-down) | +~1 week |
| + structures / reactivity for 23M | gated on whether they exist + storage budget |

---

## 11. Decisions to lock before building

1. **Scope**: metadata only, **+ map**, or **+ structures/reactivity**? (biggest cost driver)
2. Do structure predictions **exist** for all 23M, or only the curated subset?
3. **Engine**: **ClickHouse** (best for numeric-range + aggregation + map density — the dominant
   pattern) vs **OpenSearch** (best if full-text search over RNAcentral names is first-class).
   Default: ClickHouse.
4. **Cost ceiling** for always-on infra (drives instance size, managed-cloud vs self-hosted node).
5. Confirm the **map is prebaked tiles** (fastest/stablest) vs live-rendered.
6. Latency tolerance: **interactive (< 2 s)** vs "**run a query**" (seconds) acceptable.

Once these are set, this becomes a concrete build plan: ClickHouse schema + ordering/partition keys,
API endpoints (`/query`, `/facets`, `/map-tile`), tile format, CloudFront cache rules, and the
front-end scope-switch + query layer.
