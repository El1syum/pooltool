# Match HUD assets

Source: [Pooltool Figma design](https://www.figma.com/design/qLURhvhuM4AZ0xibHYelU8/?node-id=73-73), section `Дизайн\База`. Exported on 2026-11-02 using Figma design context. SVG files are original exports, not traced screenshots or recreated icon paths.

| Local file | Figma layer | Intrinsic SVG size |
| --- | --- | --- |
| `ball-shading.svg` | 73:86, reused for dynamic ball badges | 26 × 26 |
| `ball-highlight.svg` | 73:89, reused for dynamic ball badges | 5.2 × 2.86 |
| `turn-light.svg` | 73:111 / 73:356 | 6 × 6 |
| `help.svg` | 73:250 | 14 × 14 |
| `arrow-left.svg` | 73:155 | 16 × 16 |
| `volume.svg` | 73:159 | 20 × 20 |
| `settings.svg` | 73:162 | 20 × 20 |
| `reticle-center.svg` | 73:329 | 62 × 65 |
| `reticle-ring.svg` | 73:335 | 316 × 316 |
| `power-wedge.svg` | 73:366 | 250.5 × 138.187 |
| `elevation-wedge.svg` | 73:367 | 250.5 × 138.187 |
| `wedge-outline.svg` | 73:364 / 73:369 (original Vector 3) | 250.5 × 138.187 |

Call sites: `MatchHud.vue`, `ShotPowerGauge.vue` and `FigmaBallBadge.vue`. Player names, ball numbers, counts, timers, room codes and shot parameters are live data, not the example values in Figma.

These earlier wedge exports are retained as reference assets only. Runtime
`ShotPowerGauge.vue` uses the exact Vector 3 geometry of the current Figma export
`ui/figma-assist/power-gauge.svg` (149.714×82.5888); see that folder's
ASSETS.md for provenance and hashes. For Safari compatibility the component
embeds that unchanged geometry with local gradient/clip IDs rather than relying
on cross-document SVG `use` or paint-server resolution. Both gauges show `V0 / 8` in
percent and m/s, per the user's clarification, and remain visible without the
assistance key. Native orientation is on the right; the left rotates 180°.

`ball-shading.svg` was refreshed from the latest file `YPQR5qd4bL3LUjSRBzTuQH`,
general frame `102:16962` (original export `d0b20.svg`, 26×26).
SHA256: `c7fedebe7cfe8a33976efad8f319665cc5e0ba84f8bb806b75dde6900f8f283d`.

The Figma `image 1` layers are references for future 3D artwork. They are deliberately not shipped as the game background: the actual interactive Three.js canvas remains in their place until the new models are supplied.

Inter and Lora are self-hosted from the official Google Fonts repository. Their license files are included beside the font files in `public/fonts`.

Current-match overlays (`103:4490`, frames `102:17902` / `102:19206`):

| Asset | Original export | Native slot |
| --- | --- | --- |
| `match-resume.svg` | `d5bf6.svg` | 20 × 20 |
| `match-surrender.svg` | `4d6c3.svg` | 20 × 20 |
| `match-surrender-symbol.svg` | `76858.svg` | 24 × 24 |
| `match-running.svg` | `05936.svg` | 5 × 5 |
| `../club-menu/settings.svg` | byte-identical `a6fef.svg` | 20 × 20 |

`MatchMenu.vue` and `MatchOverlayFooter.vue` use these unchanged SVGs. The
existing HUD, clock, players and Three.js canvas remain the live match; the
Figma static scene export is not a runtime asset.
