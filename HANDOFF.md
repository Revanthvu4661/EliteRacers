# Elite Racers — Handoff Summary (updated)

Paste this into a new chat to continue work. Supersedes any earlier copy of this file.

## Project

3D browser racing game for **ACM LudusForge 2.0** (VFSTR, 36-hour hackathon, theme: Racing).
Location: `D:\Gaming Hackathon`. **Is now a git repo**, pushed to
[github.com/Revanthvu4661/EliteRacers](https://github.com/Revanthvu4661/EliteRacers) (`main`).

**Stack:** Three.js 0.170 + cannon-es 0.20 (both via CDN import map in `index.html`),
Firebase Auth 11.10 + Firebase Realtime Database 11.10 (both lazy-loaded), vanilla ES
modules, **no build step**.

**Run it:**
```bash
python -m http.server 8080
```
Then open http://localhost:8080 — hard refresh (Ctrl+Shift+R) after code edits.

## ⚠️ UNCOMMITTED WORK — read this first

The working tree has real, tested changes that were **never committed or pushed**
(the user hasn't asked to yet as of this handoff). `git status`/`git diff --stat`:
`auth.js`, `index.html`, `main.js` (+102 lines), `multiplayer.js`, `physics.js`
(+47 lines), `styles.css`, `track.js`, `ui.js` all modified; `pickups.js` and
`minimap.js` are new, untracked files. This is everything described below from
"Barrier-reaction bug fix" onward. **Ask the user before committing** — check first
whether they want it committed/pushed now.

There are also three **untracked, unexplained asset items** in the project root:
`2013-ferrari-458-spider/`, `2013_ferrari_458_spider.glb`, and
`26-mustang-13.04.2021-compressed/` (contains Blender `.blend`/`.blend1` files).
These were **not** added by any Claude session — they appeared in the working
directory outside of tracked work, likely the user manually dropping in candidate
car models for a future roster expansion. They are **not wired into `cars.js`** and
`car-model.js` doesn't know about them. Don't assume they're safe to delete; ask
the user what they're for before touching them.

## Build status

| Stage | State |
|---|---|
| 1. Scaffold | Done |
| 2. Google login + Skip Login (Demo Mode) fallback | Done — real Firebase project wired up |
| 3. Track (spline circuit, curbs, barriers, gates, sky, trees, grandstand) | Done, **scaled 2.2x** (see below) |
| 4. Car physics (cannon-es RaycastVehicle) | Done, untouched all session (see TUNING note) |
| 5. Three cars (Ferrari GLB re-tinted + primitive fallback) | Done. Visual size bumped ~1.4x (car-model.js) |
| 6. Camera POVs (chase / cockpit / cinematic, `C` cycles) | Done |
| 7. AI commentary (Gemini) | Scripted fallback lines only — Gemini NOT wired up |
| 8. Juice pass (screen shake, tire smoke, engine audio, FOV punch) | Partial — shake wired (barrier hits), tire smoke/engine audio not started |
| 9. Results screen polish | Solo: done. Multiplayer: shared results table built, **not live-tested** |
| 10. Multiplayer lobby (host/join, room codes, RTDB) | Built, **still not live-tested with 2 real players** — see blocker below |
| 11. Multiplayer in-race sync (remote car puppets, position lerp, leaderboard) | **Code-complete, NOT live-tested** — same blocker |
| 12. Larger track (2.2x scale) | **Done and verified** |
| 13. Boost + repair pickups | **Done** (solo-only; multiplayer sync deliberately not built yet) |
| 14. Barrier hit reaction (shake, speed cut, steering wobble) | **Done and verified** — see investigation notes below |
| 15. Health/damage meter + 0%-HP respawn | **Built; respawn+repair-pickup interaction not fully live-verified** (browser pane went hidden mid-test) |
| 16. Minimap | **Done** (local player only; remote markers not wired) |

## THE recurring blocker: Firebase Anonymous sign-in is still OFF

Checked **five separate times** across sessions, always the same result — calling
the identity API directly returns `ADMIN_ONLY_OPERATION`:
```bash
curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaSyDhyHkPB5ut7aYhi57SaUTKPLKCHbB0qyM" -H "Content-Type: application/json" -d '{"returnSecureToken":true}'
```
This is the **single thing blocking all multiplayer verification**. Without it, a
Guest can't get an online identity, so two real players can never both join a room.
**Fix:** Firebase Console → race-14f6a → Authentication → Sign-in method →
Anonymous → Enable. One click. Nobody has done this yet across ~4 sessions that
have asked for it. If you're picking this up: check this FIRST before attempting
any multiplayer testing, or you'll waste time rediscovering the same blocker.

Also still open in the Firebase Console (lower priority, flagged repeatedly):
**RTDB security rules are not published** — the database is still running Firebase's
default open "test mode" (verified by writing to it with no one signed in — it
succeeded). `database.rules.json` in the repo is ready to paste into
Realtime Database → Rules → Publish whenever this gets addressed.

## File map

| File | Owns |
|---|---|
| `index.html` | screen markup (incl. lobby screen, minimap canvas, health bar), import map, cache-bust version |
| `styles.css` | all styling, screen transitions, HUD, lobby panels, minimap, health bar |
| `ui.js` | screen switching, toasts, HUD setters (incl. `setHudHealth`), results rendering, leaderboard rendering |
| `main.js` | app flow, renderer, two scenes, race loop, input, car rig, lobby wiring, synced countdown, remote-car puppets, health/pickup/minimap per-frame wiring |
| `auth.js` | Firebase Google login + Skip Login fallback (never throws); `getFirebaseApp()` + `ensureFirebaseUid()` (anonymous sign-in for guests) used by multiplayer.js |
| `multiplayer.js` | Realtime Database room logic: host/join/leave/start, room codes, disconnect cleanup, synced countdown, `writeMyState()` (throttled ~12Hz in-race telemetry), `writeMyResult()`. Code-complete, not live-tested (see blocker). |
| `database.rules.json` | RTDB security rules — written, not yet published in the console |
| `cars.js` | car roster: 3 cars with stats + colors (the loose GLB/blend assets in the repo root are NOT wired in here) |
| `car-model.js` | GLB loader + per-car tint, primitive fallback car. `VISUAL_SCALE = 1.4` bumps rendered size without touching physics-facing wheel radius/position numbers |
| `physics.js` | cannon-es world, RaycastVehicle, all TUNING constants at top (**untouched this whole session** — verified via diff, zero lines changed inside the `TUNING` object). Additive barrier-hit reaction (`IMPACT_*` consts, `setBoost()`) — all new, separate from TUNING |
| `track.js` | spline circuit, procedural textures, barriers, checkpoints. `SCALE = 2.2`. `PICKUP_SPAWN_U` (boost) + `REPAIR_SPAWN_U` (repair) fixed spawn fractions |
| `pickups.js` | **New.** Boost (gold orb) + repair (green medkit cross) pickups, shared spawn/proximity/respawn-timer machinery. Solo-only (see file header for why) |
| `minimap.js` | **New.** Top-down track outline + local player marker, ~150x150px canvas, top-left HUD. Accepts (but nothing calls with) remote markers |
| `camera.js` | chase / cockpit / cinematic rigs, shake, FOV punch — untouched |
| `ai-commentary.js` | scripted fallback lines + `commentate()` contract for Gemini |
| `firebase-config.js` | Firebase project config (real values) — auth + `databaseURL` |
| `assets/models/ferrari.glb` | car model (three.js examples, Ferrari 458 by vicent091036) |
| `assets/libs/draco/` | Draco decoder, shipped locally so GLB loads offline |

## CRITICAL GOTCHA — cache busting

All local ES module imports carry a version query, currently **`?v=16`**:
```js
import { createWorld } from "./physics.js?v=16";
```
`index.html` has both `<script type="module" src="main.js?v=16">` and
`<link rel="stylesheet" href="styles.css?v=16">`. **The browser caches these files
independently of the page.** Editing a module without bumping the version means
your changes silently do not load. After editing any module or the stylesheet, bump
every `?v=N` together as the LAST step, e.g. from `v=16` to `v=17`:
```bash
cd "/d/Gaming Hackathon" && \
  sed -i 's/\.js?v=16"/.js?v=17"/g' main.js auth.js multiplayer.js pickups.js minimap.js && \
  sed -i 's/main.js?v=16/main.js?v=17/; s/styles.css?v=16/styles.css?v=17/' index.html
```
Verify with a hard refresh (Ctrl+Shift+R) or by checking
`performance.getEntriesByType('resource')` for the right `?v=` suffix in the console.

## Barrier-hit reaction — bug investigation (do not re-chase this)

A task reported "hitting barriers triggers no shake, no speed cut" after the track
resize and asked to check three specific hypotheses (barrier physics bodies not
rescaled / threshold miscalibrated for the new scale / stale listener references).
**Extensive empirical testing found none of the three true**, on a fresh page load:
- Barrier physics body positions **are** correctly scaled (measured lateral offset
  ≈31.2m vs. theoretical ≈30.5m from the scaled `hw+barrierOffset`).
- Real hits **do** clear both thresholds by a wide margin (logged real impact
  velocities of 16.6, 14.1, 9.9, 7.6 m/s against a 6 m/s "hard hit" cutoff).
- The collision listener **is** correctly attached and fires — confirmed with
  `try/catch` around the `cameraRig.shake()` call itself, "returned normally"
  every time, across 4 separate hits at different points around the track.

**One anomalous single failure** did occur earlier in a very long, heavily
console-instrumented single-tab session (many teleports/monkeypatches, no reload)
that could not be explained or reproduced again on a clean reload. Flagging this
honestly rather than hiding it — no confirmed root cause, no evidence it reflects
real gameplay. If a future report says this is broken again: reproduce on a
**fresh page load** first before assuming the mechanism itself is at fault; the
temporary `console.log` technique used to investigate this (logging
`e.contact.getImpactVelocityAlongNormal()` on every collide event) is fast to
re-add to `physics.js`'s collide listener and physics.js/main.js's `onCollide` if
needed again — just remember to remove it afterward (both were cleaned up this
session, confirmed via `grep -c DEBUG` returning 0 in both files).

## Health / damage / respawn system (main.js)

```
HEALTH_MAX 100              HEALTH_DAMAGE_HARD_THRESHOLD 6   (m/s - same cutoff as
                              the existing "crash" commentary line and physics.js's
                              own IMPACT_HARD_THRESHOLD, so all hard-hit effects agree)
HEALTH_DAMAGE_SCALE 1.8     (% health per m/s of impact above the threshold)
HEALTH_MIN_DAMAGE_PER_HIT 3 HEALTH_MAX_DAMAGE_PER_HIT 30
HEALTH_REGEN_PER_SEC 0      (off by default - the one constant to change for slow
                              passive regen, nothing else to touch)
HEALTH_RESPAWN_PCT 50       (health after a 0%-HP respawn - not full, so repair
                              pickups still matter)
```
Damage is applied in `onCollide()` (main.js), reusing the exact same `impact`
value that already drives camera shake and crash commentary — no second
detection path. At 0% HP, a flag (`r.pendingRespawn`) is set (not acted on
immediately — mutating the chassis body mid-collision-resolution is avoided,
same reasoning as the existing upside-down/stranded recovery) and consumed on
the next `updateRace()` tick: calls the **existing** `resetCar()` function,
restores health to `HEALTH_RESPAWN_PCT`, shows a toast.

**Verified with real screenshots:** HP dropping from a real barrier hit
(100%→84%, with a matching speed-cut and crash-commentary toast, all from one
collision), and the UI clamp (fed -45 directly into `ui.setHudHealth()`, got a
clean "0%", never broken/negative). **NOT verified live:** actually driving to
0% and watching the respawn+50%-heal fire, and collecting a repair pickup to
confirm it heals. The browser pane reported itself hidden mid-test
(`tabs_context` confirmed `"Browser pane is currently hidden"`) which stops both
screenshots and physics stepping — a desktop-app display-state issue, not a code
issue. The respawn logic reuses `resetCar()` unmodified and the damage math was
untouched by this addition, so confidence is reasonably high, but this is
flagged as genuinely unverified, not assumed-fine.

There is **no NOS-meter UI** in the codebase, despite a later task's spec
assuming one exists to mirror — only the boost pickup mechanic itself
(`pickups.js`) with a toast on collection. The health bar was built as its own
element (right side, red/orange gradient, "HP" label) rather than inventing an
unrequested NOS-meter feature. If the user wants a matching NOS bar on the left,
that's a distinct, not-yet-asked-for feature.

## Pickups (pickups.js)

Two kinds, sharing spawn/proximity/respawn-timer machinery:
- **Boost** (existing): gold icosahedron + ring, `PICKUP_SPAWN_U` in track.js (6
  points). Applies a continuous 2600N forward force for 1.8s via `physics.js`'s
  `setBoost()` — a brand-new, fully separate function hooked into the **existing**
  `preStep` listener (same one downforce uses, for the same reason: cannon clears
  applied forces every substep). Does **not** touch `update()`'s engine-force
  lines at all.
- **Repair** (new): green medkit cross, `REPAIR_SPAWN_U` in track.js (3 points).
  Restores 35% HP, clamped at 100.

`TRIGGER_RADIUS 3.2m`, `RESPAWN_MS 8000` (derived purely from a timestamp on
each client independently — no second "available again" write, matching the
pattern multiplayer sync will eventually need too). **Solo-only**: no
`/rooms/{code}/pickups/{id}` Firebase sync — deliberately not built, since the
multiplayer position-sync foundation it would ride on isn't verified yet (see
blocker above). The seam for adding that sync later is small (see the file's own
header comment).

## Multiplayer architecture (multiplayer.js) — code-complete, unverified

- Room codes: 5 chars, uppercase A-Z + 2-9, excludes `0 O 1 I L`. `/rooms/{code}` in RTDB.
- Host creates via `runTransaction` (atomic — no code collisions, no over-filling a room).
- **Synced start:** host writes `raceStartAt = server_now + 3000ms`; every client
  converts via `serverToLocalTime()` and counts down to the same instant.
- **In-race sync:** `writeMyState()` throttles position/quaternion/speed/lap/
  checkpoint/trackDistance to ~12Hz, with a dirty-check that skips redundant
  writes. Remote players render as visual-only puppets (no physics) in main.js,
  lerped/slerped toward each new sample over ~120ms. Symmetric by construction
  (filters out only `isMe`), so host and guest should each see everyone else —
  this specific claim is the most important one to verify first once the
  blocker clears, per the acceptance criteria of the task that built it.
- **Live leaderboard:** ranks by `(currentLap desc, trackDistance desc)`, fed
  from the same room listener, no extra reads.
- **Results:** `writeMyResult()` on finishing; shared results table on the
  results screen, sorted by `finishTimeMs`, fills in as stragglers finish. Room
  subscription is deliberately kept alive through the results screen for an
  online race (see `goTo()`'s `wantsRoom` logic in main.js).
- **Disconnect handling:** `onDisconnect()` removes a dropped player automatically;
  host disconnecting from a *waiting* room deletes it; once racing, that hook is
  cancelled so a mid-race host drop doesn't kill the room for everyone else.
- Public API: `hostRoom`, `joinRoom`, `startRoomRace`, `leaveRoom`, `onRoomChange`,
  `getRoom`, `serverToLocalTime`, `writeMyState`, `writeMyResult`, `getUid`.

## Debug handle

`window.ER` exposes `{ state, cameraRig, TUNING, keys, camera, THREE, mp, remotes,
computeLeaderboard, computeResultsBoard }`.
```js
ER.state.race.veh.speedKmh()
ER.state.race.health                              // current HP (0-100)
ER.state.race.track.nearest(ER.state.race.veh.chassisBody.position).dist
ER.TUNING.ENGINE_FORCE = 7000                       // live tuning
ER.keys.add('up')                                   // simulate input
ER.state.race.veh.chassisBody.world.bodies.length   // physics body count (426 on
                                                     // the current track - useful
                                                     // for checking barrier bodies)
```
`pickups`/`minimap` controllers live on `ER.state.race.pickups` /
`ER.state.race.minimap` — not on the top-level `ER` object.

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
barriers, falls off the world, **or hits 0% HP** is put back on the track
automatically (the last one also restores health to `HEALTH_RESPAWN_PCT`).

## Current physics tuning (physics.js) — unchanged all session, verified via diff

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
New, purely additive constants live in a separate block (not inside `TUNING`) so
the `TUNING` object itself stays a zero-diff, easy thing to verify hasn't
regressed: `IMPACT_HARD_THRESHOLD 6`, `IMPACT_SPEED_CUT 0.45`,
`IMPACT_RECOVER_MS 500`, `IMPACT_MIN_STEER_RESPONSE 0.3` (barrier-hit reaction —
cuts speed ~45%, makes steering mushy but not dead for 500ms).

**Track is now 2.2x scale** (`SCALE` const in track.js): `width ≈35`,
`barrierOffset ≈13`, `laps 3`, `checkpoints 4`, `samples 420` (unchanged - not a
"size"), track length **≈1866m** (was ~848m). Sky dome radius scaled to match
(3080), camera far-plane raised to 4000 to clear it. Tightest corner is still a
**15 m radius** (corner-radii logic deliberately untouched by the scale-up) — the
hairpin-at-top-speed physical impossibility noted below is unchanged by the resize.

## Physics bugs already found and fixed (do not re-introduce)

1. **Downforce applied at a world coordinate** — `applyForce(tmp, chassisBody.position)`
   creates a huge pitch torque since cannon's 2nd arg is relative to center of mass.
   Fixed: `applyForce(tmp)` with no point.
2. **Yaw-rate limiter ran during normal driving** — now gated behind `handbrakeHeld` only.
3. **Handbrake force was 120** (a friction-impulse clamp, not drag) — killed speed
   instantly. Now 14.
4. **Steering was 0.52 rad** (~5 m turn radius, violent pivot-spins) — now 0.19 rad.
5. **Wheel visual sync** now reads cannon's own per-wheel `steering`/`rotation` from
   `wheelInfo(i)` in a `postStep` listener, registered in `startRace()`, removed in
   `teardownRace()`.

Fixed timestep, speed-sensitive steering, rollInfluence 0.01, friction slip 2-6 were
already correct — not the problem. All five still hold; nothing this session
touched any of these mechanisms (verified via diff for the TUNING object
specifically, and by inspection for the rest).

## Known remaining issue (design tradeoff, not a bug)

Steering is **digital only** (full lock or nothing; same for throttle). The 15m
hairpin near top speed needs ~20g — correctly impossible, not instability. Not
implemented differently either way.

## Suggested next steps (in order)

1. **Enable Firebase Anonymous sign-in** (one click, see blocker section) — this
   unblocks literally every remaining multiplayer verification task.
2. **Live 2-player test** once #1 is done: two browser profiles/incognito windows
   (or `localhost` vs `127.0.0.1` origins, which get separate Firebase Auth
   sessions in the *same* browser — a proven trick from this session) both on
   `http://localhost:8080`. Verify remote car rendering, leaderboard sync, and
   shared results specifically — that's the part with zero real-player evidence.
3. **Finish verifying the health respawn + repair pickup interaction live** —
   the one thing this session couldn't complete due to the browser pane going
   hidden. Should be quick: drive to 0% HP, confirm respawn + 50% heal; drive
   over a green cross, confirm HP increases.
4. **Decide on committing the uncommitted work** (see warning at top) — ask the
   user first.
5. Wire Gemini commentary (key drop-in + race against `FALLBACK_AFTER_MS`).
6. Tire smoke / engine audio (Stage 8 remainder).
7. Figure out what the loose GLB/blend car assets in the repo root are for
   (ask the user) before deciding whether to wire them into `cars.js` or remove them.
8. Stop adding features in the last 3-4 hours; bug fix, polish, rehearse.

## Testing notes for whoever continues

The browser pane used for automated testing throttles `requestAnimationFrame`
when hidden, so the game clock only advances while a screenshot or wait action is
pumping frames. **New this session:** the pane can also report itself fully
*hidden* (`tabs_context` returns `"The Browser pane is currently hidden"`), at
which point even `wait`+`screenshot` cycles stop pumping frames entirely and
screenshots time out after 5s regardless of retries — this appears to be a
desktop-app display-state issue (the pane not actually being shown on the user's
screen), not something fixable from inside the session. If this happens, say so
plainly rather than continuing to guess based on stale reads.

Keep a whole test sequence inside **one** batch of actions where possible.
Prefer per-step tracing (temporary `console.log` in the actual collision
listener, read back via `read_console_messages`) over trying to time
JS-round-trip-based before/after snapshots precisely — the latter is fragile
(proven repeatedly: teleporting a car 20m from a wall lets `ENGINE_BRAKE` bleed
off most of its speed before impact even with zero throttle held, producing
misleadingly small "impact velocities" that have nothing to do with a real bug;
teleporting 1-2m away avoids this).

For multiplayer specifically: real end-to-end testing needs two separate signed-in
identities. `localhost` vs `127.0.0.1` (different origins → different Firebase
Auth sessions, even in the same browser) is a legitimate way to get this without
needing Claude-in-Chrome as a second browser — but it still needs Anonymous
auth enabled for Guest-only tests, or two different Google accounts. Calling
`multiplayer.js` functions directly to fake a second player is NOT equivalent
to real two-client verification and specs have explicitly called this out.
