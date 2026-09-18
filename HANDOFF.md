# Elite Racers — Handoff Summary (updated)

Paste this into a new chat to continue work. Supersedes any earlier copy of this file.

## Project

3D browser racing game for **ACM LudusForge 2.0** (VFSTR, 36-hour hackathon, theme: Racing).
Location: `D:\Gaming Hackathon`. Not a git repo.

**Stack:** Three.js 0.170 + cannon-es 0.20 (both via CDN import map in `index.html`),
Firebase Auth 11.10 + Firebase Realtime Database 11.10 (both lazy-loaded), vanilla ES
modules, **no build step**.

**Run it:**
```bash
python -m http.server 8080
```
Then open http://localhost:8080 — hard refresh (Ctrl+Shift+R) after code edits.

## Build status

| Stage | State |
|---|---|
| 1. Scaffold | Done |
| 2. Google login + Skip Login (Demo Mode) fallback | **Done — real Firebase project wired up** |
| 3. Track (spline circuit, curbs, barriers, gates, sky, trees, grandstand) | Done |
| 4. Car physics (cannon-es RaycastVehicle) | Done |
| 5. Three cars (Ferrari GLB re-tinted + primitive fallback) | Done |
| 6. Camera POVs (chase / cockpit / cinematic, `C` cycles) | Done |
| 7. AI commentary (Gemini) | Scripted fallback lines only — Gemini NOT wired up |
| 8. Juice pass (screen shake, tire smoke, engine audio, FOV punch) | Not started (shake + FOV punch exist in camera.js) |
| 9. Results screen polish | Basic version works (lap times, best lap, total, Play Again / Change Car) |
| 10. Multiplayer lobby (host/join, room codes, RTDB) | **UI + backend built, NOT yet live-tested with 2 real players** |
| 11. Multiplayer in-race sync (remote car puppets, position lerp) | **Not started** |
| 12. Larger track (2-3x scale) | **Not started** |

## What changed since the original handoff

1. **Google Sign-In is fully live.** Real Firebase project `race-14f6a` is configured
   in `firebase-config.js`. Verified end-to-end: button opens the real Google account
   picker (falls back to redirect if the popup is blocked), success lands on car-select
   with the real Google name + avatar, Skip Login still shows "Guest Racer". The old
   "Firebase not configured" warning and the Enter/Esc hint text are gone.
2. **Firebase Realtime Database is connected and verified.** Live at
   `https://race-14f6a-default-rtdb.firebaseio.com` (region **us-central1** — note this
   is NOT the region originally guessed). Confirmed with a real write+read round trip
   through the browser, then cleaned up.
3. **Multiplayer lobby screen built** (host + join flow, room codes, live player list,
   synced countdown) — see `multiplayer.js` below. **Not yet live-tested with two real
   players** because two prerequisites in the Firebase Console are still open (see
   "Not configured" below).
4. **New files:** `multiplayer.js` (RTDB room logic), `database.rules.json` (security
   rules — written but not yet confirmed published, see below).
5. Cache-busting version is now **`?v=9`** (see gotcha below — `styles.css` is now
   versioned too, it wasn't before).

## File map

| File | Owns |
|---|---|
| `index.html` | screen markup (incl. lobby screen), import map, cache-bust version on main.js/styles.css |
| `styles.css` | all styling, screen transitions, HUD, lobby panels |
| `ui.js` | screen switching, toasts, HUD setters, results rendering, lobby rendering |
| `main.js` | app flow, renderer, two scenes, race loop, input, car rig, lobby wiring, synced countdown |
| `auth.js` | Firebase Google login + Skip Login fallback (never throws); also exposes `getFirebaseApp()` and `ensureFirebaseUid()` (anonymous sign-in for guests) used by multiplayer.js |
| `multiplayer.js` | **New.** Realtime Database room logic: host/join/leave/start, room codes, disconnect cleanup, server-clock-synced countdown. No in-race position sync yet. |
| `database.rules.json` | **New.** RTDB security rules (signed-in-only, room-scoped). Written but not yet confirmed live in the Firebase Console — see below. |
| `cars.js` | car roster: 3 cars with stats + colors |
| `car-model.js` | GLB loader + per-car tint, primitive fallback car |
| `physics.js` | cannon-es world, RaycastVehicle, all TUNING constants at top |
| `track.js` | spline circuit, procedural textures, barriers, checkpoints |
| `camera.js` | chase / cockpit / cinematic rigs, shake, FOV punch |
| `ai-commentary.js` | scripted fallback lines + `commentate()` contract for Gemini |
| `firebase-config.js` | Firebase project config (real values) — auth + `databaseURL` |
| `assets/models/ferrari.glb` | car model (three.js examples, Ferrari 458 by vicent091036) |
| `assets/libs/draco/` | Draco decoder, shipped locally so GLB loads offline |

## CRITICAL GOTCHA — cache busting

All local ES module imports carry a version query, currently `?v=9`:
```js
import { createWorld } from "./physics.js?v=9";
```
`index.html` has both `<script type="module" src="main.js?v=9">` **and now**
`<link rel="stylesheet" href="styles.css?v=9">` — the CSS is versioned too as of this
session (it wasn't in the original handoff; a stale-CSS bug cost a round of confusing
"lobby has no background" test results).

**The browser caches these files independently of the page.** Editing a module without
bumping the version means your changes silently do not load. After editing any module
or the stylesheet, bump every `?v=N` together, e.g. from `v=9` to `v=10`:
```bash
cd "/d/Gaming Hackathon" && \
  sed -i 's/\.js?v=9"/.js?v=10"/g' main.js auth.js multiplayer.js && \
  sed -i 's/main.js?v=9/main.js?v=10/; s/styles.css?v=9/styles.css?v=10/' index.html
```
Verify with a hard refresh (Ctrl+Shift+R) — a stale tab can also just be showing an old
cached `index.html` itself (this happened once this session: a screenshot showed hint
text that had been deleted two sessions earlier).

## Not configured / not yet done in the Firebase Console

These block multiplayer specifically (solo play + Google login are unaffected):

1. **Anonymous sign-in is OFF.** Authentication → Sign-in method → Anonymous → Enable.
   Guests currently see "Guests can't race online yet… Sign in with Google instead."
   when they try Host/Join. Google-signed-in players are unaffected.
2. **RTDB security rules are NOT published yet.** The database is confirmed reachable
   but is still running Firebase's default open "test mode" rules — verified this
   session by writing to it with no one signed in, and it succeeded. That means
   **anyone with the API key can currently read/write/delete any room.** Paste
   `database.rules.json` into Firebase Console → Realtime Database → Rules → Publish
   before demoing multiplayer.

Also still open from before:
- **Gemini**: `COMMENTARY_CONFIG.GEMINI_API_KEY` is `""` in `ai-commentary.js`.
  `commentate(event, snapshot)` returns a random scripted line from `FALLBACK_LINES`
  (9 event types, 5 s rate limit). Contract is correct — wiring Gemini means racing a
  fetch against `FALLBACK_AFTER_MS` (1500 ms). Key from https://aistudio.google.com/apikey.

## Multiplayer architecture (multiplayer.js)

- Room codes: 5 chars, uppercase A-Z + 2-9, excludes `0 O 1 I L` (ambiguous when read
  aloud). `/rooms/{code}` in RTDB.
- Host creates via a `runTransaction` (atomic — no two hosts can grab the same code,
  no two joiners can grab the last slot).
- **Synced start:** host writes `raceStartAt = server_now + 3000ms` using RTDB's
  `.info/serverTimeOffset`; every client converts that to its own local clock via
  `serverToLocalTime()` and counts down to the same instant — not a broadcast "go".
- **Disconnect handling:** `onDisconnect()` removes a dropped player's node
  automatically; a host disconnecting from a *waiting* (not yet started) room deletes
  the whole room. Once racing starts, the host-closes-room hook is cancelled so a host
  dropping mid-race doesn't kill the room for everyone else.
- **Guests need a Firebase identity to use RTDB at all** — `auth.js`'s
  `ensureFirebaseUid()` signs them in anonymously (separate from a "login"; never
  auto-skips the login screen). This is why Anonymous sign-in must be enabled (see above).
- Public API: `hostRoom(profile)`, `joinRoom(code, profile)`, `startRoomRace()`,
  `leaveRoom()`, `onRoomChange(fn)`, `getRoom()`, `serverToLocalTime(ms)`.
- **What's NOT built yet (the harder half):** no position/quaternion/speed/lap sync
  during the race, no remote car puppets, no lerp, no name billboards, no shared
  results screen ranking all players, no host "close room" button after a race, no
  60s-timeout-on-stragglers logic. A started multiplayer race today is functionally a
  solo race with a synced countdown — see the original multiplayer master prompt for
  the full spec of what's left (Part 2, steps 4-6).

## Debug handle

`window.ER` exposes `{ state, cameraRig, TUNING, keys, camera, THREE }`.
Useful in the console:
```js
ER.state.race.veh.speedKmh()
ER.state.race.track.nearest(ER.state.race.veh.chassisBody.position).dist
ER.TUNING.ENGINE_FORCE = 7000        // live tuning
ER.keys.add('up')                     // simulate input
```
Multiplayer module isn't on `window.ER` — import it fresh if you need to poke it from
the console: `const mp = await import('./multiplayer.js?v=9')`.

## Controls

| Key | Action |
|---|---|
| W / Up | throttle |
| S / Down | brake / reverse |
| A / D or arrows | steer (full-lock only, no analog) |
| Space / Shift | handbrake (drift) |
| C | cycle camera |
| R | reset car onto track |

Auto-recovery: a car that flips, lands on its side, gets stranded outside the
barriers, or falls off the world is put back on the track automatically.

## Current physics tuning (physics.js) — unchanged this session

```
MAX_SPEED_KMH 215   ENGINE_FORCE 5200   MASS 420   BRAKE_FORCE 260
MAX_STEER_RAD 0.19  STEER_SPEED 4.5     HIGH_SPEED_STEER_CUT 0.4
FRICTION_SLIP 3.8   DRIFT_FRICTION_SLIP 2.1   DRIFT_STEER_CUT 0.45
HANDBRAKE_FORCE 14  OFFROAD_GRIP 0.55   OFFROAD_DRAG 0.35
SUSPENSION_STIFFNESS 58   SUSPENSION_REST 0.3   SUSPENSION_TRAVEL 0.22
DAMPING_RELAX 3.4   DAMPING_COMPRESS 5.6   DOWNFORCE 16
UPRIGHT_TORQUE 40   UPRIGHT_DAMPING 10
MAX_YAW_RATE 2.2    YAW_RATE_DAMPING 14   (yaw limiter runs ONLY while handbrake held)
FIXED_STEP 1/60     MAX_SUBSTEPS 5        rollInfluence 0.01 (per wheel)
```

Track: `width 16`, `barrierOffset 6`, `laps 3`, `checkpoints 4`, `samples 420`.
Tightest corner is a **15 m radius**; most of the lap is a gentle **60 m+** sweeper.
Wheelbase **2.65 m** → full lock (0.19 rad) gives roughly a **14 m** turn radius.
**This is the track the larger-track task (Part 1 of the multiplayer master prompt,
2-3x scale) has not been started on yet.**

## Physics bugs already found and fixed (do not re-introduce)

1. **Downforce applied at a world coordinate** — `applyForce(tmp, chassisBody.position)`
   creates a huge pitch torque since cannon's 2nd arg is relative to center of mass.
   Fixed: `applyForce(tmp)` with no point. Chassis tilt at 180 km/h: 32.6° → 0.7°.
2. **Yaw-rate limiter ran during normal driving** — now gated behind `handbrakeHeld` only.
3. **Handbrake force was 120** (a friction-impulse clamp, not drag) — killed speed
   instantly. Now 14.
4. **Steering was 0.52 rad** (~5 m turn radius, violent pivot-spins) — now 0.19 rad.
5. **Wheel visual sync** now reads cannon's own per-wheel `steering`/`rotation` from
   `wheelInfo(i)` in a `postStep` listener, registered in `startRace()`, removed in
   `teardownRace()`.

Fixed timestep, speed-sensitive steering, rollInfluence 0.01, friction slip 2-6 were
already correct — not the problem.

## Known remaining issue (design tradeoff, not a bug)

Steering is **digital only** (full lock or nothing; same for throttle). Careful
driving (pulse throttle, hold steering for the whole curve) stays clean; flooring
through a whole bend or releasing steering early runs wide into a barrier. The 15 m
hairpin near top speed needs ~20g — correctly impossible, not instability. Options if
it needs to be easier: widen the track / gentle the curves, add steering assist, or
accept it. Not implemented either way.

## Suggested next steps (in order)

1. **Live 2-player multiplayer test** — needs Anonymous sign-in enabled + RTDB rules
   published (both above) before it can even be attempted. Test with two browser
   profiles/incognito windows both on `http://localhost:8080`.
2. **Multiplayer in-race sync** — the harder half of the multiplayer master prompt:
   throttled (~10-15Hz) position/quaternion writes, remote car puppets with lerp,
   name billboards, shared results screen, host room-close button, straggler timeout.
3. **Larger track (2-3x)** — scale `TRACK_POINTS`, width, curbs, checkpoint spacing,
   fog/draw distance in `track.js`; re-check camera far-plane and pop-in.
4. **Stage 8 juice pass** — tire smoke, engine audio (Web Audio, pitch scaled to
   speed); screen shake already wired via `cameraRig.shake()`.
5. **Stage 7 Gemini** — drop in the key, race the fetch against the 1.5s timeout.
6. Stop adding features in the last 3-4 hours; bug fix, polish, rehearse.

## Testing notes for whoever continues

The browser pane used for automated testing throttles `requestAnimationFrame` when
hidden, so the game clock only advances while a screenshot or wait action is pumping
frames. Keep a whole test sequence inside **one** batch of actions. Prefer per-step
tracing (`world.addEventListener('postStep', ...)`) over before/after snapshots.

For multiplayer specifically: real end-to-end testing needs two separate signed-in
identities (two browser profiles, or one Google + one guest once Anonymous auth is
on) — a single automated browser session can drive the UI and even call
`multiplayer.js` functions directly to fake a second player for smoke-testing the
data layer, but that is not the same as verifying it with two real game clients.
