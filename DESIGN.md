# Design

## Source of truth

- Status: Active. Last refreshed: 2026-11-06.
- Primary surfaces: web game, club menu/settings, personal appearance, admin workshop.
- Evidence reviewed: `project_context.md`, `online/docs/FIGMA_MATCH_INTERFACE.md`,
  `online/docs/MODEL_ASSET_PIPELINE.md`, `ClubMenu.vue`, `ClubSettings.vue`,
  `ModelWorkshop.vue`, `club-menu.css`, `match-design.css`, `VisualAssetManager.ts`.
- Button consistency evidence: user profile screenshot (2026-11-06), all
  ClubMenu/ClubSettings action variants, workshop toolbars and match dialogs.
- Active visual reference: Figma `YPQR5qd4bL3LUjSRBzTuQH`, sections `94:73` and
  `105:4604`. The new appearance screen extends existing components; no separate
  appearance frame was supplied. This is an explicit implementation assumption.

## Brand

- Quiet billiards club: dark green, warm gold, restrained typography.
- Trust: actual player/game data, clear scope of personal vs global changes.
- Avoid invented ranks, decorative controls that do nothing, or screenshot tables.

## Product goals

- Play a complete authoritative online game and choose cosmetic table/room art.
- Prepare approved GLB files without changing physics or other players' preferences.
- Non-goals: asset marketplace, retopology editor, monetization, new game rules.
- Success: useful preview, persisted selection, accurate pockets/cloth, safe fallback.

## Personas and jobs

- Player: select an available look and return to the game without admin access.
- Artist/admin: calibrate/import materials and publish an approved shared catalogue.
- Context: desktop browser first; narrow/touch screens remain usable.

## Information architecture

- Settings → Appearance: personal cosmetic choice from enabled catalogue entries.
- Settings → Models/workshop: library preparation and separate administrator login.
- Personal modes per role: server default, procedural original, particular asset.
- Table and environment are independent; global publication stays an admin action.

## Design principles

- Reuse club styling and navigation. Make scope explicit before applying changes.
- Preview locally; Apply commits the personal draft, Cancel discards it.
- Physics geometry is authoritative. Art is fitted to it, never the other way around.
- Missing/disabled art falls back; an unavailable catalogue must not erase saved IDs.

## Visual language

- Colors: existing `#141c1b` / `#1b231f`, cream `#f1ede1`, gold `#c7aa72`.
- Typography: self-hosted Pooltool Inter and Pooltool Lora, existing sizes.
- Layout: restrained bordered panels, 6–12px radius, existing spacing rhythm.
- Motion: no new decorative loops; preview camera movement is user-controlled.
- Icons: reuse exported Figma assets; actual 3D render for preview, no fake thumbnails.

## Components

- Reuse ClubSettings entries/buttons and createGameScene / VisualAssetManager.
- New personal appearance component; pure ID-only selection policy module.
- Draft/selected, loading, disabled, error and fallback states must be explicit.
- Keep personal storage separate from ModelWorkshop drafts and administrator session.
- Full club actions share a 62px minimum height (56px at ≤480px), typography
  and padding. Back/cancel variants change color/alignment, not button size.
  Paired actions use equal-width/equal-height tracks; stacked groups also keep
  consistent tracks. Let multiline text grow without clipping.
- Match result/menu action groups use full-width, equal-height tracks with a
  48px minimum. Workshop toolbars share compact line-height/minimum height.
  Header close icons, text links, switches, value fields, ball/pocket selectors
  and camera icon widths are intentional variants, not full-action buttons.

## Accessibility

- Target: accessible keyboard/screen-reader controls; no blanket compliance claim.
- Native controls, labels, visible focus, modal focus trap and Escape/Cancel.
- Text selection state must accompany color. No hover-only critical actions.
- Keep text contrast and no required animation/flashing.

## Responsive behavior

- Check 390×844 and desktop 1440×900 / 1920×1080, no horizontal overflow.
- Stack preview and options on narrow screens; controls may scroll vertically.
- Stack paired club actions at ≤480px; keep their equal sizing and readable
  labels. Dialogs must scroll inside the viewport, not clip their last action.
- Touch uses buttons/selects, not keyboard-only camera gestures.

## Interaction states

- Loading: show progress, keep last confirmed catalogue/selection available.
- Empty: default/procedural choices still work, explain how admin adds assets.
- Error: retain draft, explain fallback, allow retry; never hide the game behind it.
- Success: apply personal selection and return; do not publish a global profile.
- Disabled/offline: do not permit a missing asset to be selected or erase stored IDs
  from an unconfirmed/failed catalogue response.

## Content voice

- Russian, concise and factual: «Оформление», «Стол», «Окружение», «Применить».
- Say «только у вас на этом устройстве» for personal local preferences.
- Admin actions explicitly say «общая библиотека/сцена»; no ambiguous Save button.

## Implementation constraints

- Vue 3 / TypeScript / Three.js, existing CSS and components; no new design system.
- GLB self-contained, ≤50MiB, ≤1M rendered vertices; prefer substantially smaller
  web assets. No external resource URIs or unsupported required decoders.
- Server table reference determines calibration; live-match snapshot wins over any
  fallback dimensions. Actual current pooltool default is 0.9906×1.9812m, cloth
  height 0.708m; earlier workshop documentation's 1.27×2.54m was inaccurate.
- Verify original inputs untouched, asset geometry/materials, browser rendering,
  selection persistence, read-only rights and a real shot with custom art.

## Open questions

- [ ] Confirm permission/license before publishing the supplied Sketchfab rip.
- [x] AI source requires a hybrid: retain decorative shell; rebuild precise game
  surface/pockets/legs. Verified in both browser engines, source remains untouched.
- [ ] Final production art direction and cross-device cosmetic preference sync are deferred.
