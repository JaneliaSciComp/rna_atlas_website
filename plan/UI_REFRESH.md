# UI refresh + deep-view overhaul (2026-07)

A front-end pass over the RNA Atlas Explorer: a consistent design-token layer + optional dark
mode, and a substantially reworked per-fold **deep view** — an AlphaFold-DB-style panoramic
dashboard, a per-channel 3D small-multiples gallery, and a new orientation-matched **3D-projection**
2D structure. All client-side (`web/`); no data or builder changes. Reviewed by an independent
Codex pass (`codex-visual-refresh-review.md`) whose findings are folded in.

## 1. Design tokens + dark mode (`style.css`, `index.html`)

- Refactored the flat, hardcoded palette (~8 ad-hoc greys, 0 CSS variables) into a `:root`
  design-token layer — colors, radii, shadows, transitions — and routed the UI chrome through it.
  (Data-viz palettes — nucleotide / reactivity / pLDDT / motif chips — stay intentionally fixed.)
- Polish: consistent elevation scale, hover/active transitions with a subtle lift, `:focus-visible`
  rings, thin theme-aware scrollbars, comfier table rows + sticky-header shadow, accent-tinted
  selection, `prefers-reduced-motion` guard.
- **Opt-in dark theme** via a header ☾ toggle → `[data-theme="dark"]` token overrides, persisted in
  localStorage and applied pre-paint (inline `<head>` script, no flash). Self-contained; doesn't
  touch `app.js`. Plot surfaces (map + reactivity canvases, drawn by JS with dark ink) deliberately
  stay light so their content stays legible.

## 2. Deep view — fluid SVGs (`app.js`, `ss.js`)

Added `viewBox`/`preserveAspectRatio` to the reactivity-track, arc, forna, and projection SVGs so
they scale to their container instead of forcing a horizontal scrollbar. The three existing modes
(modal / dock-right / dock-bottom) are unchanged; the fluid behavior is used by panoramic.

## 3. Panoramic dashboard mode (`app.js`, `style.css`, `index.html`)

- A 4th deep-view mode (`mode-panoramic`), toggled by a **⛶ Panoramic** button in the deep-view
  toolbar. Full-screen, card-tiled layout that tiles every panel at once (no scrollbars); column
  count adapts to viewport width via CSS breakpoints (1 → 2 at ≥1000px → 3-col at ≥1600px).
  AlphaFold-DB-style dashboard feel.

## 4. Per-channel 3D gallery (`app.js`, `style.css`)

In panoramic, the left panel becomes **small multiples**: the same structure rendered once per
coloring channel (2A3, DMS, pLDDT, base-pairing, nucleotide, 5′→3′), each labeled, reusing the
single structure fetch.

- **Camera-linked** — rotating any panel rotates all the others in lock-step (3Dmol
  `setViewChangeCallback`/`getView`/`setView`, with a `syncing` guard against feedback).
- **Per-channel value legend** (bottom-right of each panel) matched to the exact 3D palette — e.g.
  the AlphaFold pLDDT gradient 0→100, the white→red reactivity ramp, paired/unpaired swatches,
  A/C/G/U swatches, 5′→3′ rainbow.
- **+/- sizing** (top-right) — fewer/more columns (bigger/smaller structures), 1–4, persisted; the
  viewers re-fit on change.

## 5. "3D projection" 2D structure (`ss.js`, `app.js`, `index.html`)

A new secondary-structure rendering that flattens the **real C1′ coordinates** onto a 2D plane so
the diagram mirrors the actual fold, rather than the abstract forna spring layout.

- **Orientation-matched** — projects using the 3D viewer's current camera quaternion (`activeQuat`);
  falls back to a principal-axes (PCA) plane while the 3D is still loading.
- **Live-follow** — rotating the 3D re-projects the 2D in real time; parse is cached per fold
  (`projParse`, on `currentDeep._proj`) and updates are `requestAnimationFrame`-throttled, so a drag
  only rotates + redraws, never re-parses.
- **Draggable + synced** — dragging the 2D itself rotates the 3D viewer (and, in panoramic, the
  whole linked gallery) via the same view-change plumbing (`initProjDrag`).
- **Default** SS view; switch to forna / arc inline (see §6).
- Edge coloring for legibility, off the A/C/G/U palette: backbone grey, **base pairs violet**
  (`#7b61ff`), **pseudoknots dashed magenta** (`#e83e8c`). Same scheme applied to forna and arc.
  (Base pairs come from `pairing.json` = `derive_ss.py`'s canonical WC/wobble call on the 3D; the
  pseudoknot flag is the crossing-bracket level parsed client-side by `ssPairs`.)

## 6. Inline controls (`app.js`, `index.html`)

- **SS-view pills** rendered right at the diagram (`setSSView`) — forna / 2D layout / arc — instead
  of a toolbar dropdown, so you switch where you're looking (and it's reachable inside the overlay).
- **Metadata text size** — A− / A+ on the props panel (`setMetaScale`), 10–18px, persisted.

## 7. Bug fixes

- **Nucleotide 3D coloring** — `hexCF()` was called but never defined (3Dmol threw → blank), so the
  "nucleotide" coloring never worked, in the single viewer too. Defined it.
- **Codex-review findings** (all fixed, verified served):
  - **PCA/Jacobi sign** — the eigendecomposition rotation-angle denominator was reversed, so the
    no-quaternion projection wasn't a true principal-axis plane. Corrected.
  - **Cross-fold load race** — a slow structure fetch could clobber a newer fold's structure/cache.
    `load3D` now bails after the `await` if the current fold changed.
  - **WebGL context leaks** — cycling single↔panoramic created viewers without releasing GL
    contexts (3Dmol `clear()` doesn't). Added `loseGL()` (`WEBGL_lose_context`), called on every
    `load3D` and on `closeDeep`; `disposePano` detaches callbacks.
  - **rAF-after-close** — the projection frame now re-validates fold/mode inside the callback and is
    cancelled on close (no `TypeError`, no stale overwrite).
  - **Mol* + panoramic** — panoramic now dispatches the 3Dmol gallery before the Mol* branch.
  - **Missing-C1′ remap** — projection keeps each residue's original index so a missing atom can't
    shift sequence/pairing labels.
  - **Dark contrast** — raised `--text-faint`; track labels/captions are now theme-aware
    (`currentColor` / `var(--text-muted)`) instead of hardcoded light-grey.
  - **Arc width** — arc diagrams no longer inherit the square-diagram 340px cap.

## 8. `serve.py` (separate concern — local dev server only)

Switched the local dev server from `ThreadingHTTPServer` to single-threaded `HTTPServer`: h5py /
HDF5 isn't thread-safe and was segfaulting (exit 139) under concurrent per-fold requests. Not part
of the deployed site (production is static S3 + CloudFront), but committed as its own change so
local review/dev is stable. Shipped as a separate commit.

## Files changed

| File | Change |
|---|---|
| `web/style.css` | design tokens, dark theme, polish, panoramic + gallery + pills + legends styling |
| `web/app.js` | panoramic mode, gallery + linked rotation + legends + sizing, 3D-projection wiring (align/live-follow/drag), inline SS pills, metadata sizing, hexCF fix, Codex fixes |
| `web/ss.js` | `projParse`/`proj2D` (+ Jacobi eigendecomp), viewBox, edge recoloring |
| `web/index.html` | theme toggle + pre-paint script, ⛶ Panoramic button, SS-view default = projection |
| `serve.py` | single-threaded (h5py thread-safety) — separate commit |

## Notes / not done

- I can't run a browser in this environment, so behavior was verified by `node --check`, the Codex
  code review, and live testing on the local `serve.py` dev server (ribo2 A–H + symlinked add-on
  data). The linked-camera peer `render()` (a minor Codex perf nit) was kept intentionally to avoid
  risking the working linked-rotation on a build detail I couldn't test.
- Deploying is the usual static path (`deploy.sh dev` → verify at `/dev/` → `promote`); this PR is
  the web shell only — no data changes.
