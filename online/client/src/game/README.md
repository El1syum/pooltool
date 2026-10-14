# Browser scene

`createGameScene(container, callbacks)` creates a Three.js scene. The container must have a nonzero CSS height. The caller owns screen layout and controls; this module owns the interactive canvas and disposes it with `destroy()`.

```ts
import { createGameScene } from './game/createGameScene'

const game = createGameScene(container, {
  onAimChange: aim => updateAimControls(aim),
  onShoot: aim => sendShot(aim),
  onPlaceCueBall: position => sendCuePlacement(position),
  onSelectPocket: pocket => selectCalledPocket(pocket),
  onSelectBall: ball => selectCalledBall(ball),
  onError: message => showMessage(message),
})
game.setState(snapshot)
game.setInteraction({ canShoot: true, canPlaceCueBall: false, spectator: false })
game.setAim({ phi: 90, V0: 2, theta: 0, a: 0, b: 0 })
game.playShot(result.trajectory, serverStartAtMs - serverClockOffsetMs)
```

## Coordinate and protocol contract

Positions are pooltool metres: x runs across the table, y along it, and z upwards from the cloth. The cloth is rendered at `table.renderHeight ?? table.height ?? 0.8` metres above the floor. `phi` is degrees counterclockwise from pooltool +x, `V0` is m/s, `theta` is cue elevation in degrees, and `a`/`b` are normalized cue-tip offsets. Spin is constrained to an 0.8-radius disk. The server validates all parameters and owns ball positions, rules and turn permissions.

`ShotTrajectory.frames` must be chronological seconds from the beginning of the shot. Frames contain all balls, physical state, pocketed state and optional x/y/z/w quaternion. Playback samples the shared absolute start time on every rendered frame rather than accumulating local deltas. A late or reconnected client catches up to the same point in the authoritative animation. Quaternion interpolation handles the equivalent q and -q orientations. Event sounds are emitted at the trajectory's authoritative event time; old sounds are skipped on a late join.

Do not call `setState(finalSnapshot)` immediately after `playShot()`: it intentionally cancels playback. Apply the final authoritative snapshot after `onPlaybackComplete`, or use `setState()` directly when reconnecting after the animation has already finished. The scene temporarily keeps the last trajectory frame for smooth completion; the caller must still apply the server snapshot to update turn/rule state.

`setInteraction` is required for input permissions. Spectators can orbit the camera but cannot aim, strike, select calls or place the cue ball. During playback shooting is suppressed. Placement is previewed with a green/red ghost using table, pocket, ball overlap and optional `placementRegion` bounds. Placement is submitted to the server and does not locally mutate the authoritative snapshot.

## Controls

- Left click/drag or one finger: aim; while ball-in-hand is active, preview/place the cue ball.
- Right drag: orbit camera; mouse wheel: zoom. Two fingers: orbit and pinch zoom.
- Q/E (or the HUD arrows) turn the table view; `rotateCamera(radians)` and `zoomCamera(factor)` drive the camera from UI buttons.
- V or `setCameraMode('cue')` puts the camera behind the cue and follows the aim; there, horizontal drag aims. `resetCamera()` returns to the free camera.
- Click an object ball or numbered pocket: select it for a called shot (caller owns rule validation).
- Defaults: arrows aim/change power; W/S elevation; A/D horizontal spin; R/F vertical spin; Space shoots; C resets camera; T selects top view.
- Keys are active only when the canvas has focus and ignore editable controls. `setSettings({ bindings })` remaps them using `KeyboardEvent.code`. The camera binding accepts `Mouse0`, `Mouse1` or `Mouse2`, or a keyboard modifier such as `KeyX`: hold that key and drag with the left mouse button to orbit without changing the aim. Releasing the key or leaving the window restores normal mouse bindings.

Aim guide (when `showAimGuide` is on): the cue path to the first ball or cushion, a ghost ball at contact, the object-ball line (green and its pocket highlighted when it heads into a pocket), the cue ball's line after contact (tangent line bent by follow/draw) or its first cushion rebound, a ring under the ball to be hit and a red dot on the cue ball where the tip strikes (`a`/`b`). `setCalledBall(id)` rings the called ball. These are straight-line previews for orientation; the server simulation decides the real outcome.

`setAim(aim, false)` changes remote/opponent aiming data without emitting the local change callback. `shoot()` applies the same local permission check as the keyboard action. UI controls should submit through that method.

Graphics quality controls device-pixel ratio and shadows. Volume controls procedural cue/ball/cushion/pocket sounds; Web Audio is unlocked after the first user gesture for Safari/Chrome autoplay policies. `onPerformance` reports average FPS and renderer workload every five seconds.

## Assets

`public/models/balls/*.png` are copied directly from the fork's `pooltool/models/balls/pooltool_pocket/` textures (Apache-2.0 project), not screenshots. The original license is included beside the textures. Sixteen PNGs total about 0.55 MB. The table and cue geometry are generated from physical dimensions; no game-state visuals are baked into images. Generated numbered fallback textures keep the game usable when an optional texture fails to load.

Run the protocol/placement checks with Node 24: `node --test --experimental-strip-types src/game/playback.test.mjs`.
