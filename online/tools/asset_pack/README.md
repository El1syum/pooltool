# Asset-pack intake tools

These tools inspect and prepare **local-only** models from the user-supplied
`8 Ball Pool Game Assets 3D Pack.zip`. No raw or derived asset is part of Git.
The ZIP has no license file; do not publish its geometry until rights are
confirmed. The independently authored preparation code is reusable.

The likely exact original is [TGamesAssets on Sketchfab](https://sketchfab.com/3d-models/8-ball-pool-game-assets-3d-pack-df112bf7923a45c99b3529426dfb78f2),
listed as a commercial royalty-free pack. Its description includes original
textures; the supplied ZIP contains only 34 OBJ files and references missing MTL
files. Buying/obtaining the original licensed package is the clean path to the
original textures and provenance.

## Run locally

From the repository root, with the project's NumPy/SciPy Python environment:

```powershell
.venv\Scripts\python.exe online/tools/asset_pack/audit_pack.py "C:/path/to/8 Ball Pool Game Assets 3D Pack.zip" online/client/tests/artifacts/model-intake/pack
.venv\Scripts\python.exe online/tools/asset_pack/prepare_candidates.py online/client/tests/artifacts/model-intake/pack/source online/client/tests/artifacts/model-intake/pack/candidates
$env:PLAYWRIGHT_MODULE = 'C:/path/to/playwright/index.mjs'
$env:BROWSER = 'chromium' # also verified with webkit
node online/tools/asset_pack/render_pack.mjs
```

ZIP extraction checks containment, rejects symlinks and oversized input, and
refuses to overwrite different existing source bytes. Output goes to the
Git-ignored intake directory. The renderer starts/stops Vite on loopback 4328;
it does not upload anything to the shared library.

`prepare_candidates.py` removes zero-area faces, moves the off-centre models to
local origin, rotates the long axis to Z, reconstructs simple PBR tint groups and
calibrates the measured cushion nose to the actual Pooltool table. It does not
recover original textures. The six `*-review.glb` files retain the original
functional openings and are **not** playable replacements.

`render_pack.mjs` makes original/colored/hybrid contact sheets and exports one
playable Table 1 hybrid using `../model_intake/playable_surface.mjs`. It retains
the original legs and lower cabinet but reconstructs the top apron/rim, cloth,
cushions, rounded jaws and pocket shafts from the measured physics reference.
The rebuilding is necessary: after scale-only conversion, the source side holes
are too small and too far inboard. Meshes are batched into five material groups,
welded and exported as a self-contained GLB. The exported asset is still local-
only until rights to the original cabinet/leg geometry are confirmed.

Verification: 231 flat-bed ray samples and 240 samples inside the six physical
pocket circles, zero blocked openings and zero bed-height deviation in both
Chromium and WebKit. This is art-geometry validation, not a substitute for the
application's real shot/playback integration tests.
