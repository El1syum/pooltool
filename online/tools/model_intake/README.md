# Offline model intake and AI tabletop repair

These tools prepare **cosmetic GLB derivatives**; they do not change Pooltool's
collision geometry, server calculations, ball positions or rules. Run commands
from the repository root. Originals are read-only inputs, never output targets.

## Reproducible setup

Use Node 24+ and install the exact versions/lockfile in this separate tool package:

```powershell
npm ci --prefix online/tools/model_intake
```

No dependencies are added to the game's application package. By default scripts
load these local tool dependencies. `MODEL_TOOLS_ROOT` may instead point to an
isolated directory containing the same `package.json` and `node_modules`.
The Python audit also needs NumPy, Pillow and the project's Pooltool runtime.

## Workflow

```powershell
# Report binary geometry/textures without editing the original.
.venv/Scripts/python.exe online/tools/model_intake/audit_glb.py SOURCE.glb online/client/tests/artifacts/model-intake/ai/audit

# Refresh the small checked-in geometry reference from the actual engine.
.venv/Scripts/python.exe online/tools/model_intake/export_table_reference.py

# Keep UVs while reducing geometry and embedding browser-native 2K WebP textures.
node online/tools/model_intake/optimize_ai.mjs --input SOURCE.glb --output online/client/tests/artifacts/model-intake/ai/ai-optimized.glb

# This repair is specifically calibrated for the supplied AI tabletop, not arbitrary GLBs.
node online/tools/model_intake/prepare_ai_hybrid.mjs --input online/client/tests/artifacts/model-intake/ai/ai-optimized.glb --output online/client/tests/artifacts/model-intake/ai/pooltool-ai-hybrid.glb

# Independent geometric rays, plus helper regression checks.
node online/tools/model_intake/verify_prepared_model.mjs --input online/client/tests/artifacts/model-intake/ai/pooltool-ai-hybrid.glb
node --test online/tools/model_intake/playable_surface.test.mjs

# Uses the installed client Vite and Playwright Chromium for visual inspection.
node online/tools/model_intake/render_ai.mjs --input online/client/tests/artifacts/model-intake/ai/pooltool-ai-hybrid.glb
```

An existing derivative output requires explicit `--force`. An output resolving
to the input, including symlinks/hardlinks, is always rejected. Rendering writes
only ignored test artifacts and starts/stops its own localhost Vite instance.
Run `npx --prefix online/tools/model_intake playwright install chromium` if the
matching browser revision is absent. The renderer emits raw-orientation views
and an optional fixed AI-source orientation; a prepared file uses the **raw**
views because its correct transforms have already been baked.

## What the supplied AI asset required

The original is 84,875,620 bytes with 837,901 exported vertices, 1,500,000
triangles, one fused material and three embedded 4096² PNG textures. Its
geometrically welded mesh is one watertight component (no boundary/nonmanifold
edges, Euler characteristic 2). The six apparent pockets are closed recesses.
It is a tabletop without legs, with a wrong scene orientation, uneven cloth and
distorted cushion/pocket forms; it cannot simply replace the playable table.

The optimized intermediate preserves UVs and texture appearance, at 4,339,620
bytes and 75,000 triangles. The final **hybrid** keeps identifiable AI decorative
frame/lower-body geometry and its original base-color texture, with matte
material treatment. These parts are newly authored/rebuilt:

- one planar cloth region, triangulated once with Earcut;
- 18 linear cushion segments and 12 rounded jaw arcs from the actual engine;
- six through-cuts, open wells and nearly flush graphite pocket trims;
- four matching supports and leveling feet.

The final candidate is 3,235,040 bytes, 81,003 triangles, 67,503 vertices,
seven material/mesh groups, with two embedded 2048² textures. It is calibrated
to the current `.9906 × 1.9812 m` playing field, `.708 m` cloth height. The GLB
itself has cloth at local Y=0; the game adds its authoritative table height.
No Draco, Meshopt or KTX2 runtime decoder is required.

Proof: 561 playing-field rays hit the single cloth at Y=0, all six pocket center
rays are open through the cabinet, and 24 entrance rays stay at 0–1.5 mm above
cloth. Browser/server gameplay remains a separate required integration check.
The cloth's `pooltoolCastShadow:false` extras let it receive ball shadows without
self-shadow artifacts when the renderer supports that cosmetic hint.

Minor organic imperfections remain in the AI decorative shell. This is a
hybrid technical/playable preparation, not a claim that automatic decimation
alone produces production-ready precision game assets. For generated props,
backgrounds or cabinets, AI geometry is useful; exact flat playing surfaces,
cushions and pocket geometry should be rebuilt from explicit dimensions.

## Shared helper

`playable_surface.mjs` exports `buildPlayingSurface(THREE, reference?, options?)`,
`clipGeometry(THREE, geometry, options)`, `renderPoint`, `pocketHoles` and
`TABLE_REFERENCE`. Coordinates are X across, Y up, Z along the table. Normals and
UVs are interpolated when cutting the decorative source. Optional `bedHalfX` /
`bedHalfZ` must contain all corner pocket circles; side pockets can open through
the outer contour as U-notches. Material-separated groups may be merged to limit
draw calls while retaining meaningful material names.

All original/model/texture/report binaries stay in ignored artifacts or a private
handoff folder, not automatically in Git or the shared server library. Publishing
and rights/provenance review are separate actions owned by the main workflow.
