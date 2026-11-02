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

Call sites: `MatchHud.vue` and `FigmaBallBadge.vue`. Player names, ball numbers, counts, timers, room codes, strength and angle are live data, not the example values in Figma.

The Figma `image 1` layers are references for future 3D artwork. They are deliberately not shipped as the game background: the actual interactive Three.js canvas remains in their place until the new models are supplied.

Inter and Lora are self-hosted from the official Google Fonts repository. Their license files are included beside the font files in `public/fonts`.
