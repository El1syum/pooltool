# Strict Figma interface pass · 2026-11-11

Source of truth: [the approved Figma copy, Demo page](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=0-1).
The Old and Concept frames are not implementation references for this pass.

| Area | Figma frame nodes |
| --- | --- |
| Club, play and matchmaking | `96:14801`, `96:14849`, `96:14897`, `96:14940` |
| Private game, rules, lobby, join and spectator entry | `96:14987`, `96:15035`, `96:15124`, `96:15173`, `96:15215` |
| Club settings and subsections, profile and exit | `96:15259`, `96:15303`, `96:15392`, `96:15486`, `96:15592`, `96:15690` |
| Match menu, settings and surrender | `102:17902`, `102:18132`, `102:18367`, `102:18839` (audio content plus surrounding frame), `102:18914`, `102:19206` |
| Table overview, heading, contact and power, with and without assistance | `102:16962`, `102:17183`, `102:17407`, `103:3950`, `104:4567`, `102:17640`, `105:4617`, `105:4626` |

- Reused the exported WebP background, fonts and vector icons. Added the source SVG direction ring and reticle. No Figma screenshot is used as a game surface.
- Removed the undocumented bot setup, profile history panel, appearance selector, extra settings, shot drawer/toasts, rules pop-up, permanent numbered pocket badges and match result screen. The one extra play action, «Играть с ботом», opens a real solo match directly.
- Private rooms start when the second player joins. The browser uses the existing authoritative ready endpoint without a manual ready button. Finished games return to the existing main menu after any final trajectory. Stored results and Elo are unchanged. A player who cancels surrender stays in the same game.
- Live values, actual controls and the selected 3D assets replace the prototype's sample accounts, ranks, ping, values and 3D scene. Unimplemented options in the design are read-only; unavailable rating season/league data is not fabricated. Both quick and ranked search read actual queue elapsed time. Ranked aiming aid stays disabled on the renderer.
- The existing authenticated model tools remain available separately at `/?tools=models`, with no link from the game. Platform authentication and technical recovery gates are not player menu designs.

Follow-up exception: the profile's previous match history was restored at the user's request. The existing authenticated feed supplies the 100 most recent finished matches. The other player screens and the direct bot button are unchanged.

Current verification: `club-menu-browser.mjs`, `match-assist.mjs`, `power-gauges.mjs`, `qa-settings.mjs`, `strict-figma-flow.mjs`, `ranked-policy-integration.mjs`, `assist-binding-integration.mjs`, `cursor-resume-app.mjs`, `surrender-recovery.mjs` and the unit/SSR suite. Tests that deliberately targeted removed controls are historical unless updated for these frames.
