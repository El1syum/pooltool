# UI and model library verification — 2026-11-03

## Delivered

- Active design: `YPQR5qd4bL3LUjSRBzTuQH`, menu `94:73`, game `105:4604`.
  Original Figma menu image converted to WebP without resizing; original UI SVGs
  and source manifests are in `public/ui/club-menu` and `public/ui/figma-assist`.
- Working menu, friends/rooms, search, profile and real settings. Example ranks,
  account fields or unsupported audio/graphics controls are not fabricated.
- Hold-Alt contact/power/elevation instruments, dynamic SVG scales, mobile Help
  alternative, Shift+wheel elevation, blur/visibility reset. Existing locked
  direction/contact workflow and authoritative shot remain intact.
- Ranked aim line forced off for participants and spectators without changing
  the saved casual preference; disabled UI, reload and reconnect tested.
- Shared self-contained GLB library, separate administrator login/password,
  transformations, material overrides, node visibility, calibration, explicit
  atomic table/environment publication, reversible disable and safe fallback.
  Refresh happens on opening the library and on a new match, not mid-shot.

## Checks

- TypeScript and production Vite build pass. The existing large Three.js bundle
  warning remains informational; it is not a failed build.
- `pytest online/tests online/server/tests -q`: 97 passed, 513 subtests passed.
- Pure client / SSR / adapter / validation tests: 48 passed.
- Chromium and WebKit: full multi-client browser smoke, locked shot workflow,
  match HUD with real physics, shared final state and 16 ball textures, responsive
  390px / resize roundtrip, original SVG live fill, Alt instruments, model workshop
  and actual shared-library API, ranked queue/settings/reconnect policy.
- A table-rebuild regression checks multiple authoritative table heights: one
  procedural bed, raycast hits the cue ball, and the ball is actually visible.
- Network resilience: failed background snapshot/profile fetches are caught;
  already-received authoritative match data and departed rooms ignore stale
  failures. Fault-injection integration explicitly returns snapshot HTTP 502
  while keeping commands, WebSocket synchronization and physics real.

The November 3 HTTP preview was updated after an online SQLite backup (38
completed matches preserved). Readiness, the current default HTML/no-store,
original WebP, administrator login/session restoration/logout and remote WebKit
gameplay were verified. The public Chromium test observed intermittent 502 on
HTTP resources; isolated Chromium/WebKit gameplay and injected-failure checks
passed. No production load or network availability guarantee is inferred.

## Limits and operation

The real interactive 3D scene remains procedural: final art models and audio are
not yet supplied. Test GLBs are verification fixtures, not production artwork.
WebKit automation does not certify native Safari / Apple devices. VK publication,
production load guarantees and TLS setup are outside this delivery.

At the user's explicit choice the testing preview permits admin login over HTTP.
Credentials/cookies are not encrypted in transit; the generated password is
unique and test-only. Plaintext handoff and hash-only configuration stay outside
Git. Server authentication uses scrypt, bounded login attempts, HttpOnly cookies,
same-origin checks and CSRF. Back up persistent model files plus SQLite using the
online backup API. Deployment preserves existing player/room/history data.
