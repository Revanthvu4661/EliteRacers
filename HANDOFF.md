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

## Git status

`main` is **pushed** to [github.com/Revanthvu4661/EliteRacers](https://github.com/Revanthvu4661/EliteRacers)
(`origin/main` = `03c6db2` when this was written; the user pushes, sessions never do). Every verified
task/fix has a local tag: `ok-baseline`, `ok-task1` ... `ok-task10`, `ok-fix1`, `ok-fix2`, `ok-fix3`, `ok-fix4`,
`ok-round2`, `ok-orient`, `ok-fixA`, `ok-fixB` (`git tag`). Reset target if a change fails twice: the last tag.

The three **optimised** car models in `assets/models/` (`ferrari-458-spider.glb` 340 KB, `huracan.glb` 2.2 MB,
`bugatti-eb110.glb` 1.4 MB) are now **tracked** (commit `8c337cc`) - without them the deploy 404s and every car
falls back to the tinted Ferrari. The three ORIGINAL Sketchfab GLBs in the repo root
(`2013_ferrari_458_spider.glb`, `2022_lamborghini_huracan_super_trofeo_evo2_carb.glb`,
`bugatti_eb110_super_sport_1992_by_alex.ka..glb`) stay **untracked on purpose**: never `git add` them, never
delete/move them. README "Credits" still has TODOs for each model's source link and license.
Always `git add` by path, never `git add -A` / `git add .`.

`git status` may show files as modified with an empty diff after a `sed -i` pass - that is
`core.autocrlf=true` stat noise, the files are byte-identical.

## Build status

| Stage | State |
|---|---|
| 1-6. Scaffold, login, track, physics, cars, cameras | Done (earlier sessions) |
| 7. AI commentary (Gemini) | Scripted fallback lines only - Gemini NOT wired up |
| 8. Juice pass | Partial - shake, engine/SFX audio done; tire smoke not started |
| 9-11. Multiplayer lobby / in-race sync / shared results | Code-complete, **still never live-tested with 2 real players** (blocker below) |
| 12-16. 2.2x track, pickups, barrier reaction, health, minimap | Done (earlier sessions) |
| **2026-09-19 session** (all done; round-2 fixes below) | |
| T1. 0 HP respawn fix | Done, verified (sub-1% health now clamps to 0) |
| T2. Analog speedometer (`speedometer.js`, written this session - it was not in the repo) | Done, verified |
| T3. Car-select: hero car centred, bottom card strip slides, tint cross-fade | Done, verified |
| T4. HUD banner: RESPAWNING / RECONNECTING (`.info/connected`) | Done; RESPAWNING verified, RECONNECTING listener unverified (no 2-player auth) |
| T5. Wrong-way: 1.5 s grace, 10 s banner countdown, `resetCar()` | Done, verified (lap/checkpoint/trackDistance preserved) |
| T6. Finish gantry at start/finish (visual only) | Done, verified (physics body count unchanged: 426) |
| T7. Three real car models (Draco/WebP), auto-fitted, tinted-Ferrari fallback | Done, verified solo per car; 2-player check impossible |
| T8-9. XP + levels + coins (`progression.js`) | Done, verified (pure functions + a real finished race) |
| T10. Garage skin store (tints) | Done, verified (buy / blocked buy / equip / reload persist / race) |
| **Round 2** | |
| Boost/repair pickup freeze | Fixed, verified (root cause: hiding a pickup dropped its PointLight => shader recompile) |
| Car vanishing on car-select | Fixed, verified (shared template materials + mid-fade "rest" values) |
| Multiplayer cars overlapping | Pure slot logic verified; **live 2-browser test not done** |
| Procedural audio (`audio.js`) | Built; context/voices/engine params verified, **sound quality never heard** |
| Viper GT facing backward (`modelYaw`) | Fixed, verified for all 3 cars + puppets |
| **Round 3** | |
| Cars driving through barriers | Fixed, verified: 2520/2520 strike tests hold (was 43% failing) |
| Race-start lag eating the countdown | Fixed, verified solo; **multiplayer path not live-tested** |

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
| `main.js` | app flow, renderer, two scenes, race loop, input, car rig, lobby wiring, synced countdown, remote-car puppets, health/pickup/minimap per-frame wiring, race-start `warmup` phase + `schedulePrewarm`, wall safety net, wrong-way, HUD banner, hero-car swap fade + self-heal, garage/progression glue, `ER.perfSummary()` |
| `auth.js` | Firebase Google login + Skip Login fallback (never throws); `getFirebaseApp()` + `ensureFirebaseUid()` (anonymous sign-in for guests) used by multiplayer.js |
| `multiplayer.js` | Realtime Database room logic: host/join/leave/start, room codes, disconnect cleanup, synced countdown, `writeMyState()` (throttled ~12Hz in-race telemetry), `writeMyResult()`, grid `order` (`orderUids`, `slotFor`), `onConnectionChange` (`.info/connected`). Code-complete, not live-tested (see blocker). |
| `database.rules.json` | RTDB security rules — written, not yet published in the console |
| `cars.js` | car roster: 3 cars with stats + colors, real-model path (`model`), `paintMaterial` (null = tint-disabled), `modelYaw` (nose authored at +Z => Math.PI for all three), `fit.hideMaterials` |
| `car-model.js` | GLB loader + per-car tint, primitive fallback car, `instantiateReal` (recentre/scale/`modelYaw`, per-instance material clones, Ferrari wheel layout for physics), `loadCarModelQuick` (3 s wait then tinted-Ferrari fallback + late swap). `VISUAL_SCALE = 1.4` bumps rendered size without touching physics-facing wheel radius/position numbers |
| `physics.js` | cannon-es world, RaycastVehicle, all TUNING constants at top (**untouched this whole session** — verified via diff, zero lines changed inside the `TUNING` object). Additive barrier-hit reaction (`IMPACT_*` consts, `setBoost()`) — all new, separate from TUNING |
| `track.js` | spline circuit, procedural textures, barriers, checkpoints, finish gantry, `gridOffsets`. `SCALE = 2.2`. Barriers = continuous overlapping segments along the wall line; ALL colliders are shapes of ONE static compound body. `PICKUP_SPAWN_U` (boost) + `REPAIR_SPAWN_U` (repair) fixed spawn fractions |
| `pickups.js` | Boost (gold orb) + repair (green medkit cross) pickups, shared spawn/proximity/respawn-timer machinery. **Pooled**: created once (`ensurePickups`), `reset()` per race; hiding = meshes off + light intensity 0 (never change the light count). Solo-only (see file header for why) |
| `minimap.js` | **New.** Top-down track outline + local player marker, ~150x150px canvas, top-left HUD. Accepts (but nothing calls with) remote markers |
| `camera.js` | chase / cockpit / cinematic rigs, shake, FOV punch — untouched |
| `ai-commentary.js` | scripted fallback lines + `commentate()` contract for Gemini |
| `firebase-config.js` | Firebase project config (real values) — auth + `databaseURL` |
| `speedometer.js` | **New.** Self-contained canvas speed gauge (create / set / destroy) |
| `progression.js` | XP, levels, coins, skins - pure math + localStorage, no DOM |
| `audio.js` | Procedural Web Audio (no assets, imports nothing from the game): UI sounds, 5-gear engine, race SFX, remote engines (<=3), mute (M + `.btn-mute`), `er_audio_v1` |
| `assets/models/ferrari.glb` | fallback car model (three.js examples, Ferrari 458 by vicent091036) |
| `assets/models/{ferrari-458-spider,huracan,bugatti-eb110}.glb` | optimised real car models (tracked). Originals live untracked in the repo root |
| `assets/libs/draco/` | Draco decoder, shipped locally so GLB loads offline |

## CRITICAL GOTCHA — cache busting

All local ES module imports carry a version query, currently **`?v=44`**:
```js
import { createWorld } from "./physics.js?v=44";
```
`index.html` has both `<script type="module" src="main.js?v=44">` and
`<link rel="stylesheet" href="styles.css?v=44">`. **The browser caches these files
independently of the page.** Editing a module without bumping the version means
your changes silently do not load. After editing any module or the stylesheet, bump
every `?v=N` together as the LAST step, e.g. from `v=44` to `v=45`:
```bash
cd "/d/Gaming Hackathon" && \
  sed -i 's/\.js?v=44"/.js?v=45"/g' main.js auth.js multiplayer.js pickups.js && \
  sed -i 's/main.js?v=44/main.js?v=45/; s/styles.css?v=44/styles.css?v=45/' index.html
```
(Only main.js, auth.js, multiplayer.js and pickups.js contain versioned imports; the
other modules import only `three`/`cannon-es`.) `index.html` itself is also heuristically
cached by Chrome with `python -m http.server` - a hard refresh (Ctrl+Shift+R) or a fresh
query string (`/?r=1`) is needed to pick up a new version number. Verify with
`performance.getEntriesByType('resource')` for the right `?v=` suffix.

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

**2026-09-19 fix:** damage is fractional, so health could end at e.g. 0.4 - the HUD
rounded that to "0%" but `<= 0` never fired. `onCollide` now clamps anything under 1%
to 0. Respawn + 50% heal + "RESPAWNING" banner + repair pickup (+35) are all verified
live via `ER.updateRace` stepping.

**Verified with real screenshots (earlier):** HP dropping from a real barrier hit
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

**Pooled since round 3:** `ensurePickups()` in main.js creates the controller once with the track and
`reset()` re-arms it each race. Never create/dispose/hide-with-`visible=false` anything that owns a light
mid-race: three.js recompiles every lit material when the scene's visible-light count changes
(seconds of freeze).

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
- **Start grid:** the host writes `order` (uids sorted by joinedAt, then uid) in the same update as the start
  flag; every client uses `slot = order.indexOf(myUid)` (fallback: the same sort over players known at start),
  `gridOffsets(slot)` in track.js (2 columns, 9 m rows, 5 m columns, 8 slots) and one function
  (`gridPoseFor`) for the local car and every puppet. Solo spawn is unchanged.
- **Countdown online:** the shared server-synced start (`syncedEnd`) is kept; the local warmup never delays it.
- Public API: `hostRoom`, `joinRoom`, `startRoomRace`, `leaveRoom`, `onRoomChange`, `onConnectionChange`,
  `getRoom`, `serverToLocalTime`, `writeMyState`, `writeMyResult`, `getUid`, `orderUids`, `slotFor`.

## Debug handle

`window.ER` exposes `{ state, cameraRig, TUNING, keys, camera, THREE, mp, remotes,
computeLeaderboard, computeResultsBoard, updateRace, hudBanner, showcase, prog, renderer, raceScene, dumpHero, gridPoseFor, gridOffsets, audio, updateRemotesFromView, perfSummary }`.
```js
ER.state.race.veh.speedKmh()
ER.state.race.health                              // current HP (0-100)
ER.updateRace(1/60)                               // step ONE race frame by hand (see Testing notes)
ER.state.race.countdownEnd = performance.now()-1  // then step a few frames: skips the countdown
ER.hudBanner                                      // { reconnecting, respawnUntil, wrongWay }
ER.showcase                                       // THREE.Group holding the car-select hero car
ER.prog.raceXP({...}) / ER.prog.levelFromXP(n)    // progression.js pure functions
ER.state.race.speedo.value                        // eased needle value (km/h)
ER.perfSummary()                                  // race-start marks (click..GO) + slow frames
ER.audio.audioStats()                             // audio context state, live node count, engine params
ER.dumpHero()                                     // every hero-car material (car-select debugging)
ER.TUNING.ENGINE_FORCE = 7000                     // live tuning
ER.keys.add('up')                                 // simulate input
```
`pickups`/`minimap`/`speedo` controllers live on `ER.state.race.*`.

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

1. **Enable Firebase Anonymous sign-in** (one click, see blocker section) - still the single thing blocking every
   multiplayer verification: 2-player join, leaderboard, shared results, RECONNECTING banner, distinct grid
   slots, puppets with real models, the online warmup/countdown path, remote engine sounds.
2. **Confirm the three car-model licenses** and fill the README "Credits" TODOs (the optimised models are
   already tracked; the root originals stay untracked).
3. **Listen to the audio** (never heard by the author) and tune gains in `audio.js`; **tune `PAR_SPEED_MPS`** in
   `progression.js` (28 m/s) after a clean lap.
4. Live 2-player test once #1 is done (see Testing notes for the localhost/127.0.0.1 trick).
5. Wire Gemini commentary; tire smoke (Stage 8 remainder).
6. Known, deliberately not changed: real-model wheels are baked into one mesh (they do not visibly steer or
   spin); Huracan is tint-disabled (no single paint material); the rendered car (6.35 x 3.2 m) is larger than
   its physics box (3.9 x 1.8 m) by design (`VISUAL_SCALE`), so meshes can visually overlap walls; six harmless
   `ERR_CONNECTION_RESET` console lines when model texture blobs load; the first race after a cold page load
   still spends ~0.4-1 s in warmup.

## 2026-09-19 session - what was added and where

- **0 HP respawn** (`main.js` onCollide): damage is fractional, so health could land on
  e.g. 0.4 - HUD showed "0%" but the `<= 0` check never fired. Anything under 1% is now 0.
- **Speedometer** (`speedometer.js`, new, self-contained canvas gauge): created in
  `startRace`, `set(kmh)` each frame, `destroy()` in `teardownRace`; every call is
  try/catch-guarded. Old `.hud-speed` text readout is hidden in CSS (element still exists,
  `ui.setHudSpeed` still updates it).
- **Car select** (`styles.css` + `main.js`): `#screen-select` is bottom-justified, the
  `.car-list` strip is translated by `slideStrip()` so the selected card is centred;
  `fadeSwapShowcase()` cross-fades material opacity on car change. Camera look-at is
  lowered on the select screen only (`frame()`).
- **HUD banner** (`#hud-banner`, `ui.setHudBanner`, `main.js` `hudBanner` +
  `refreshBanner()` every race tick): priority RECONNECTING > RESPAWNING > WRONG WAY n.
  `multiplayer.js` got an additive `onConnectionChange(fn)` fed by a persistent
  `.info/connected` listener (only after online play has connected once).
- **Wrong-way** (`main.js` `updateWrongWay`, constants `WRONG_WAY_*`): velocity (not
  heading) against the nearest sample tangent below -15 km/h; 1.5 s grace, then a 10 s
  countdown in the banner, then `resetCar()` - which only moves the chassis, so lap /
  nextCp / trackDistance survive. Applies in solo and multiplayer.
- **Finish gantry** (`track.js` `makeFinishGantry`): replaces the checkpoint-0 gate.
  Towers + tall canvas-textured FINISH banner (front and mirrored back face) + flags.
- **Real car models** (`cars.js` `model` / `paintMaterial` / `fit`, `car-model.js`
  `instantiateReal` + `loadCarModelQuick`): none of the GLBs use the body/wheel_* node
  contract, so the model is recentred, scaled so its long axis equals the Ferrari's raw
  length (VISUAL_SCALE applied on top exactly like the Ferrari), min-y put on the ground,
  optionally flipped 180deg; wheels are baked/static and the physics wheel layout is the
  Ferrari's, so handling is unchanged. Race start waits at most `REAL_MODEL_WAIT_MS`
  (3 s) then races the tinted Ferrari and swaps the real body in when it lands
  (remote puppets do the same). Mapping: Viper GT = 458 Spider (paint
  `Vehicle_Exterior_mm_ext`, no flip), Kestrel = Huracan ST EVO2 (tint-disabled, flip),
  Brawler = Bugatti EB110 (paint `Bugatti_EB110SS_By_Alex_Ka`, flip, hides the asset's
  `floor` / `carshadow` / `red_carpet` meshes). Optimised with
  `npx @gltf-transform/cli optimize <in> <out> --compress draco --texture-compress webp --texture-size 1024`
  (one-off, not in the repo).
- **Progression** (`progression.js`, new, no DOM): `raceXP`, `xpToNext`, `levelFromXP`,
  `coinsForXP` (0.6), `loadProgress`/`saveProgress` on localStorage key
  `er_progress_v1_<uid|demo>` (Demo Mode starts with 500 coins, Google users with 0),
  `applyRaceResult`, skin catalog (`SKIN_CATALOG`: default + 300 + 800 coins per car),
  `buySkin`/`equipSkin`/`skinColor`. Awarded in exactly one place: `finishRace()` in
  `main.js`, only when `r.phase === "finished"`, wrapped in try/catch. Multiplayer place
  comes from `computeResultsBoard(room)` at finish time; if unavailable podium = 0.
  Results screen: `#results-xp` block (`ui.renderProgress`). Car-select header:
  `#coin-chip` + Garage button; **Garage screen** (`#screen-garage`, `renderGarage()` in
  main.js, `ui.renderGarage`). Skins are applied by passing `skinnedCar(carCfg)` (the car
  config with `color` replaced) into the existing tint path at both `setShowcaseCar`
  and `startRace`. Tint-disabled cars show "Stock only".

## Round 2 (2026-09-19): bug fixes + audio - what changed

- **Boost/repair freeze (root cause):** every pickup owns a `PointLight`, and hiding the pickup
  group (`mesh.visible = false`) removed it from the scene's visible-light list. three.js rebuilds
  every lit material's shader when the light count changes: 3.9 s hitch per collect AND per respawn.
  `pickups.js` now hides only the meshes and sets the light intensity to 0 (`setShown`). Rule for
  anything new: **never add/remove/hide a light mid-race**. Worst render after a collect: 15 ms
  (was 3860 ms), 18 collects in a row.
- **Car vanishing on car select (root cause):** `instantiateReal` shared materials with the cached
  GLB template, and the swap fade recorded mid-fade opacity as the "rest" value, so rapid card
  switching left materials at opacity 0 (mesh visible, shadow still drawn). Now: materials are
  cloned per instance (`car-model.js`), fades are idempotent (`fadeJob`, rest values in
  `material.userData`, timeout failsafe), `healShowcase()` repairs the hero every 1.5 s on menu
  screens, and `webglcontextlost/restored` rebuild the PMREM env map and hero.
  `ER.dumpHero()` dumps every hero material. Verified: 90 rapid switches, 3 race round trips, a forced
  context loss/restore, 195 s idle.
- **Multiplayer grid:** every client used `startPose(7)` (identical spawn). `multiplayer.js`:
  `orderUids(players)` (joinedAt, then uid) is written as `order` in the same update as the start
  flag; `slotFor(view, uid)` reads it (falls back to the same sort). `track.js`: `gridOffsets(slot)`
  (2 columns, 9 m rows, 5 m columns, 8 slots; larger than the 6 m / 3.5 m minimum because cars render
  ~7 m x 3.2 m). `main.js` `gridPoseFor` is the ONE slot function for the local car and puppets.
  Solo spawn unchanged. **Live two-browser test NOT done** (Anonymous sign-in off).
- **Audio (`audio.js`, new):** procedural Web Audio, no assets. Context is created on the first
  gesture, suspended when the tab is hidden; master 0.6 -> compressor; M key + `.btn-mute`
  buttons (car-select header, race HUD); `{muted, volume}` in `er_audio_v1`. Engine = 2 detuned saws
  + sub square -> lowpass, 5-gear RPM model (`rpmModel`), boost whine, drift squeal; UI sounds via one
  delegated pointerdown handler; race SFX; <=12 SFX voices; <=3 remote engines dropped first when FPS
  falls. `ER.audio.audioStats()` shows context state, live node count and engine params.
  **Sound quality is UNVERIFIED by ear** - only that the context runs, voices are created, engine
  frequency/gain/filter follow speed, and the node count returns to 0 after every race.
- **Speedometer live:** `speedometer.js` (canvas gauge in `#speedo`). The old `.hud-speed` text
  element still exists and is still updated, but is `display: none`.

## Round 3 (2026-09-19): wall pass-through + race-start lag

- **Cars driving through barriers (root causes):** (1) every barrier body kept an AABB computed BEFORE it was
  positioned (centred on the origin); cannon's sweep-and-prune broadphase sorts by AABB, so wall/car pairs were
  skipped depending on the chassis' x (43% of 1314 wall-strike tests passed straight through at commit ea82f0f,
  same at ok-baseline, i.e. not a regression, present since the 2.2x track). (2) real holes on the OUTSIDE of tight
  corners (fixed 8.8 m grid + 14 m colliders vs. a wall line up to 17 m between segments). Fix in `track.js`: walls
  are generated per sample pair along the wall line (continuous, 1.5 m overlap, 2.2 m thick outward, 8 m tall) and
  ALL colliders are shapes of ONE static compound body (840 separate bodies made each physics step ~6x slower
  through cannon's O(n^2) collision matrix); AABB computed explicitly. `main.js` has a per-frame safety net
  (clamps a breaching car to the wall face, removes outward velocity, damage once). Now 2520/2520 perpendicular
  strikes hold (every sample, 30/120/205+boost km/h) plus 29/57 degree and 20 fps-frame variants; physics step
  1.1-1.6 ms -> 0.2 ms. Visual clipping (rendered car 6.35 x 3.2 m vs 3.9 x 1.8 m chassis box) is by design
  (VISUAL_SCALE 1.4) and was NOT changed.
  **Gotcha for testers:** `RaycastVehicle.castRay` sets `chassisBody.collisionResponse = false` around each wheel
  ray; if a script is interrupted mid-ray (tool timeout) the chassis stays non-colliding until you reset it.
- **Race-start lag (root cause):** first-use work ran inside the running countdown - pickups (with 9 point lights)
  were re-created per race (light-count change = recompile of every lit material), the new car's materials were
  compiled against the race lights, textures were uploaded - while the countdown deadline was already stamped.
  Now: pickups pooled (`pickups.reset()`), circuit built + scene `compileAsync`'d while on car-select/lobby
  (`schedulePrewarm`), "Loading race..." overlay paints first, then `renderer.compile` + `initTexture` under it,
  then a `warmup` phase (frozen car, frames rendering) until 10 spike-free frames (`noteFrame`) or 5 s, THEN the
  countdown starts (`beginCountdown`). Online keeps the server-synced start time (`syncedEnd`). Race timer still
  starts at GO. `ER.perfSummary()` prints performance marks from the click to GO plus slow frames.
  Multiplayer path is implemented but NOT live-tested (Anonymous sign-in still off).

## Testing notes for whoever continues

**Round 3 testing lessons (read before writing a harness):**
- The browser tool kills a script at ~30-45 s ("Internal error"). If it is killed mid-wheel-raycast,
  cannon's `RaycastVehicle.castRay` leaves `chassisBody.collisionResponse = false` (it toggles it around each
  ray) and every later test "fails" because the car no longer collides. Reset `chassisBody.collisionResponse = true`
  before every test and keep each call under ~25 s.
- Wall-strike harness recipe: teleport the car ~9 m inside the wall (`halfWidth + 13` = 30.5 m from the
  centreline), heading outward, set velocity, then step exactly like `updateRace`: `veh.setSurfaceGrip`,
  `veh.setBoost`, `veh.update(input, dt)`, `world.step(TUNING.FIXED_STEP, dt, TUNING.MAX_SUBSTEPS)`; fail if
  `track.nearest(pos).dist > 30.8`. A body count above a few dozen makes cannon's collision matrix O(n^2).
- Frame timing in the pane: screenshots stall the page (they capture a frame), other tabs running WebGL steal
  the CPU, and the pane sometimes drops to ~1 fps when "hidden" - discard runs containing ~1000 ms frames.
  `tabs_select` + a small screenshot wakes it. Measure with `ER.perfSummary()`.
- Old builds for A/B checks: `git worktree add <dir> <tag>` + `python -m http.server <port> --directory <dir>`
  (never check out another commit in the main working tree); remove with `git worktree remove --force`.

**Deterministic stepping (new, use this first):** the browser pane used for automated
testing often reports itself hidden, which freezes `requestAnimationFrame` entirely.
`ER.updateRace(1/60)` steps one race frame synchronously regardless, so a whole
scenario (teleport, set velocity, step N frames, read HUD) runs inside ONE
`javascript_tool` call with no dependence on the pane pumping frames. Skip the
countdown with `ER.state.race.countdownEnd = performance.now() - 1` then step 3 frames.
Screenshots still need the pane visible (`tabs_select` sometimes brings it back).

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
