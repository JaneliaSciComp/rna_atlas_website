# Deploy: S3 website (shell + data) behind CloudFront, passcode-gated

Everything — the web shell *and* the data — lives under one S3 prefix and is served through a
single CloudFront distribution (HTTPS). One origin ⇒ **no CORS**. The source code lives in a
**private** git repo (version control only; it does not serve the site).

```
  https://<dist>.cloudfront.net/                -> index.html, app.js, ... (shell, ungated)
  https://<dist>.cloudfront.net/data|structs|react/...  -> data (gated by passcode ?t=)
        |
  s3://rnanix/atlas_explorer/   (private; CloudFront reads it via OAC)
```

Why CloudFront (not the bare S3 website endpoint): the S3 website endpoint is HTTP-only and can't
check a passcode. CloudFront gives HTTPS + a viewer-request Function that enforces the passcode.

The shell paths are **ungated** so the passcode screen can load; only `/data/`, `/structs/`,
`/react/` require the passcode. The shell contains no findings — those are all in the gated data.

## 1. Build everything into dist/

```bash
mamba activate rna
cd /groups/das/home/zouinkhim/atlas_explorer
python build_feature_table.py     # data/folds.json, motifs.json (if not current)
python build_static.py            # dist/ = shell + config.js(GATED) + data/ structs/ react/
```

`dist/config.js` is generated with `DATA_BASE="" ; GATED=true` (same-origin, passcode on).

## 2. Upload to S3 (admin SSO profile — atlas-operator is read-only on rnanix)

```bash
# shell + data + react (content-type auto by extension)
aws s3 sync dist/ s3://rnanix/atlas_explorer/ --exclude "structs/*"
# CIFs are gzip bytes -> set header so browsers decompress transparently (3Dmol gets plain text)
aws s3 sync dist/structs s3://rnanix/atlas_explorer/structs \
    --content-encoding gzip --content-type text/plain
```

Keep the prefix **private** — access is only through CloudFront.

## 3. CloudFront distribution

- Origin: `rnanix` bucket, origin path `/atlas_explorer`, via an **Origin Access Control** (bucket
  stays private; append the OAC allow statement to the bucket policy — additive only).
- **Default root object:** `index.html`.
- No CORS / response-headers policy needed (single origin).

## 4. Passcode gate (CloudFront Function, viewer-request)

`EXPECTED` is the single passcode you hand to users. They type it into the site's gate; the app
sends it as `?t=<passcode>` on data requests; this function enforces it on data paths only.
Rotate by editing `EXPECTED` and re-publishing. Attach on *viewer request*.

```js
function handler(event) {
  var req = event.request;
  var uri = req.uri;
  var gated = uri.startsWith("/data/") || uri.startsWith("/structs/") || uri.startsWith("/react/");
  if (!gated) return req;                       // shell loads freely (passcode screen)
  var t = (req.querystring.t && req.querystring.t.value) || "";
  var EXPECTED = "REPLACE_WITH_PASSCODE";       // rotate here
  if (t !== EXPECTED) {
    return { statusCode: 403, statusDescription: "Forbidden",
             headers: { "content-type": { value: "text/plain" } }, body: "invalid passcode" };
  }
  return req;
}
```

Note: the passcode rides in the query string (visible in access logs) — fine for a shared secret;
rotate periodically.

## 5. Use it

Open `https://<dist>.cloudfront.net/`. The shell loads, shows the passcode screen; on a correct
passcode the data loads. Share the CloudFront URL + the passcode.

## Smoke test

```bash
curl -I  "https://<dist>.cloudfront.net/"                              # 200 (shell, ungated)
curl -I  "https://<dist>.cloudfront.net/data/folds.json?t=WRONG"       # 403
curl -s  "https://<dist>.cloudfront.net/data/folds.json?t=REAL" | head -c 60   # JSON
```

## Local development (no S3, no gate)

`web/config.js` stays `DATA_BASE="" ; GATED=false` → `python serve.py` serves shell + data, no
passcode. (The deploy `config.js` only exists inside `dist/`, so local dev is never gated.)

## Scaling to v2 (414k)

Same exporter + layout — extend `folds.json` + assets via the precompute pipeline, re-run
`build_static.py`, `aws s3 sync`. No CloudFront/passcode changes.

## AWS gotchas (from prior atlas work)

- Upload with the admin SSO `[default]` profile; `atlas-operator` can't write to `rnanix`.
- Bucket-policy edits are gated — **append** the OAC statement, don't rewrite the policy.
