# Bridge IFC Viewer — prototype

A proof-of-concept **IFC4.3 bridge model viewer** for a state DOT bridge office. It runs entirely in the browser, as a static site with no build step and no server code. It can be hosted on GitHub Pages or on any internal web server.

> **Status:** prototype. The alignment math has unit tests. The full viewer needs testing on real bridge models from your authoring tools (OpenBridge, Allplan, Revit, Tekla, etc.). See [Known limitations](#known-limitations).

## What it does

| Feature | Notes |
|---|---|
| Open IFC files by file picker or drag-and-drop | IFC4.3 (`IFC4X3_ADD2`) is the target. IFC4 and IFC2x3 also open. |
| **Bridge breakdown tree** | Project → Site → Bridge → Bridge parts (superstructure, piers, abutments…) → elements grouped by class. Click ⌖ to select and zoom. |
| **Alignment-aware readouts** | Reads `IfcAlignment` horizontal and vertical segments (lines, arcs, clothoids, parabolic vertical curves) and draws the centerline with station ticks. |
| **Station / offset / elevation** | Hover or click any element to get *Sta 105+25.40 · 12.00 ft RT · El 806.10 ft · −1.00 ft vs profile*. |
| **Element station range** | Selecting an element (or a whole pier) shows the station and offset range it covers. |
| **Go to station** | Type `107+00` (or `1+250` for metric) to fly to that station. |
| Properties | Attributes, property sets and quantity sets for the picked element. |
| Layers | Show/hide by IFC class. Turning rebar off is the big win on heavy models. |
| **Model checks** | Rules in `config/requirements.json` (e.g. "every girder has a mark", "deck slabs state concrete class"). Click to select failing elements. |
| Large-model handling | Parsing runs in a Web Worker. Geometry is merged by material. State-plane coordinates are shifted near the origin to avoid jitter. |

Stations follow US practice when the file's length unit is feet (`125+40.25`, 100 ft stations) and metric practice otherwise (`1+254.032`). The start station comes from the alignment's `IfcReferent` / `Pset_Stationing.Station` (0 if there isn't one).

## Privacy model — your files stay on your computer

* GitHub Pages (or your web server) delivers **only the viewer code**. When you open a model, the browser reads it from your disk into memory and processes it inside the tab. **It is never uploaded.** Close the tab and it's gone.
* **No third-party CDNs.** three.js and web-ifc are copied into `vendor/` at pinned versions by `scripts/vendor.sh`. npm verifies each package against the registry's integrity hash, and a `vendor/CHECKSUMS.txt` is written.
* **Content-Security-Policy** in `index.html` stops the page from making requests to any site other than its own (`connect-src 'self'`).
* The worker that holds the file in memory also blocks non-local `fetch` / XHR / WebSocket (`src/net-guard.js`). A meta-tag CSP doesn't reach workers, and GitHub Pages can't send CSP headers.
* **Verify it yourself:** open DevTools → Network, load a model, and confirm no request carries the file.

⚠️ On a free GitHub account the **repo and the Pages site are public**. That's fine for the viewer code. **Never commit real project models.** `.gitignore` already excludes `*.ifc` except the fictional demo.

## Quick start (local)

Requires Node 18+ (for `npm pack`) and Python 3 (for a quick local web server).

```bash
scripts/vendor.sh                 # one-time: fetch pinned three.js + web-ifc into vendor/
python3 -m http.server 8080       # any static server works
# open http://localhost:8080 and drop samples/demo-bridge.ifc on the page
```

Opening `index.html` straight from disk (`file://`) won't work. Browsers block module workers and WebAssembly there, so use a local server.

## Deploy to GitHub Pages

1. Create a new GitHub repository and push this folder to `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push again (or run the workflow manually). `.github/workflows/pages.yml` runs the tests, vendors the libraries, checks the CSP hash and publishes.
4. Your viewer is at `https://<user-or-org>.github.io/<repo>/`.

`vendor/` is not committed. The workflow builds it fresh from the pinned versions on every deploy.

## Hosting internally

The deployed site is just static files: `index.html`, `styles.css`, `src/`, `vendor/`, `config/`. Copy them to any internal web server (IIS, nginx, Apache, SharePoint-hosted static site, etc.). It needs:

* `.wasm` served as `application/wasm` (most servers already do this)
* ideally, the CSP sent as a real HTTP header so it also covers the worker:
  `default-src 'self'; script-src 'self' 'sha256-…' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`
  Copy the `sha256-…` value from the meta tag in `index.html`.

## Project layout

```
index.html               page shell + CSP + import map
styles.css
src/main.js              UI wiring: tree, layers, properties, checks, station readouts
src/viewer.js            three.js scene, merged meshes, picking, highlighting, alignment drawing
src/worker.js            web-ifc: parsing, geometry streaming, tree, alignments, properties, checks
src/alignment.js         pure alignment math (sampling, profile, projection, station formatting)
src/net-guard.js         blocks non-local network calls inside the worker
config/requirements.json example DOT model requirements for the Checks tab
samples/demo-bridge.ifc  small fictional IFC4.3 bridge on a curved alignment (feet)
scripts/vendor.sh        pins + downloads three.js and web-ifc
scripts/update-csp.mjs   recomputes the CSP hash if you edit the import map
scripts/make_demo_ifc.py regenerates the demo model
tests/                   node --test unit tests for the alignment math
```

## Customizing the checks

Edit `config/requirements.json`. Each rule names an IFC entity and either an attribute or a property-set property that must be present and non-empty. Add `"values"` to restrict allowed values:

```json
{ "id": "BR-04", "description": "Deck slabs state the concrete class",
  "entity": "IfcSlab", "pset": "DOT_Concrete", "property": "ConcreteClass", "values": ["A", "AA", "HPC"] }
```

The demo model has deliberate gaps (girders in segment 7 have no mark, two slabs say class "B", no bearings), so you'll see passes and failures.

## How the alignment readout works

1. The worker reads the *business-logic* alignment data (`IfcAlignmentHorizontalSegment`, `IfcAlignmentVerticalSegment`), not the geometric curves. It integrates the horizontal geometry itself (curvature varies linearly within a segment, exact for lines, arcs and clothoids) and samples it about every 2 m.
2. web-ifc transforms geometry (Y-up swap, unit scaling, shift to origin). The worker tries the plausible mappings and keeps the one that puts the alignment on the model. You'll get a warning if none line up.
3. A picked 3D point is mapped back into IFC coordinates. It's then projected onto the sampled centerline to get station and signed offset (LT/RT), and compared against the profile elevation.

## Known limitations

* **Not yet tested against real authoring-tool exports.** The demo file is synthetic. Expect to fix some exporter-specific issues on your first real models.
* Pinned versions (`three@0.160.0`, `web-ifc@0.0.66`) were chosen without network access. If `vendor.sh` or loading fails, try a newer web-ifc (`WEBIFC_VERSION=… scripts/vendor.sh`) and check the browser console. The web-ifc API calls used are listed at the top of `src/worker.js`.
* Station equations, cant/superelevation, and alignments that only have geometric curves (no semantic segments) aren't handled yet.
* Uncommon transition curves (Bloss, cubic, sine, cosine, Viennese bend, Helmert) are approximated by a clothoid.
* Elements positioned with `IfcLinearPlacement` depend on web-ifc's support for it.
* Hover readout raycasts the full model. On very large models, turn off "Live station readout" or hide rebar. A BVH (`three-mesh-bvh`) is the proper fix.
* Not a design or authoring tool. It's read-only.

## Roadmap ideas

* buildingSMART **IDS** support in place of the custom JSON rules
* Plan / profile / cross-section views cut along the alignment
* Quantity takeoff export (deck area, concrete volumes, girder lengths) to CSV
* Link elements to AASHTO element-level inspection items / BrM, and pin inspection findings to elements
* "Convert once, open fast" cache of processed geometry for large models
* Model comparison between submittals (added / removed / changed elements)
* Measure tool, section box, saved viewpoints, BCF issues

## Third-party

* [three.js](https://threejs.org) — MIT
* [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (That Open Company) — MPL-2.0

Choose and add a license for your own code before publishing.
