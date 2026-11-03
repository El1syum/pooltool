# Club menu assets

Source: Figma file `YPQR5qd4bL3LUjSRBzTuQH`, section `Меню`.
The original source background is converted to `club-background.webp` by the
main implementation: source upload `f8752.png`, 1264 × 848 px, converted to WebP
quality 90 without resizing (68,442 bytes). It is not a composed-frame screenshot.
SVGs are direct Figma exports, never screenshots or
reconstructed paths. Runtime references use local files only.

Main callsites: `ClubMenu.vue`, `ClubSettings.vue`. Text, Elo, player names,
match history, room codes and connection states remain live application data.

| Local asset | Source frame | Native dimensions |
| --- | --- | --- |
| online-dot.svg | Shared header | 5 × 5 |
| play.svg, settings.svg, user.svg, exit.svg | Main menu `96:14801` | 20 × 20 |
| chevron-dark.svg, chevron-gold.svg | Main and play menus | 16 × 16 |
| shuffle.svg, trophy.svg, users.svg, eye.svg | Play `96:14849` | 20 × 20 |
| circle-dot.svg, sliders.svg, plus.svg, key.svg | Friend `96:14987` | 20 × 20 |
| arrow-left.svg | Shared back action | 16 × 16 |
| copy.svg | Created room `96:15124` | 20 × 20 |
| wait-dot.svg | Created room `96:15124` | 5 × 5 |
| log-in.svg | Join `96:15173` | 20 × 20 |
| eye-muted.svg, eye-dark.svg | Watch `96:15215` | 20 × 20 |
| search-arc.svg | Search `96:14897`, `96:14940` | 64.7862 × 30.2247 |
| x.svg | Search cancel | 20 × 20 |
| pencil.svg | Profile `96:15592` | 16 × 16 |
| pencil-small.svg | Profile `96:15592` | 13 × 13 |
| profile-trophy.svg | Profile `96:15592` | 30 × 30 |
| check-dark.svg | Profile / settings save | 20 × 20 |
| monitor.svg, volume.svg, mouse.svg | Settings `96:15259` | 20 × 20 |
| chevron-down.svg | Game rules `96:15035` | 14 × 14 |
| toggle-on.svg, toggle-off.svg | Rules / graphics `96:15303` | 38 × 22 |
| exit-large.svg | Exit `96:15690` | 26 × 26 |
| exit-dark.svg | Exit confirm `96:15690` | 20 × 20 |

The arc is placed in its original 90 × 90 rotation container without stretching.
Switch assets are external SVGs, used unchanged. Sliders are native interactive
range inputs with CSS tracks; they are not a screenshot of a fixed Figma value.

All screen contexts were retrieved with screenshots and reviewed in high-fidelity
mode. Frame `96:15392` (sound) and `96:15486` (controls) supply those settings layouts.
Unsupported sample values are not represented as operational controls: season,
city/about, club music, ambience, TAA, vsync, best-of-three and selectable 3D table
rules do not currently exist in the product model. The UI exposes actual Elo,
current browser behavior, implemented quality/audio/bindings and private-room rules.
