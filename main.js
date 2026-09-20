// ============================================================================
// main.js - Elite Racers entry: renderer, screen flow, race loop.
//
// Flow:  login  ->  select  ->  race  ->  results  ->  (select | race)
//                      \->  lobby (host/join room)  ->  race
//
// Two scenes share one canvas:
//   showcaseScene  dark studio with the selected car on a turntable (menus)
//   raceScene      the circuit (track.js) + the player's car rig
// ============================================================================

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as auth from "./auth.js?v=65";
import * as ui from "./ui.js?v=65";
import { CARS, DEFAULT_CAR_ID, getCar } from "./cars.js?v=65";
import { createWorld, stepWorld, createVehicle, TUNING } from "./physics.js?v=65";
import { buildTrack, getTrack, listTracks, getTrackPreview, DEFAULT_TRACK_ID, gridOffsets } from "./track.js?v=65";
import { createCameraRig } from "./camera.js?v=65";
import { loadCarModel, loadCarModelQuick, assembleStatic, preloadCarAssets } from "./car-model.js?v=65";
import { commentate } from "./ai-commentary.js?v=65";
import * as mp from "./multiplayer.js?v=65";
import { createPickups } from "./pickups.js?v=65";
import { createMinimap } from "./minimap.js?v=65";
import { createEnvironment, getTheme } from "./themes.js?v=65";
import { preloadNature } from "./nature-models.js?v=65";
import { buildScenery } from "./scenery.js?v=65";
import { createSpeedometer } from "./speedometer.js?v=65";
import * as prog from "./progression.js?v=65";
import * as audio from "./audio.js?v=65";

// ---------------------------------------------------------------------------
// Renderer + camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById("game-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// Far-plane must clear the sky dome radius (track.js, scaled with the track) with
// margin, or the dome itself gets clipped at the horizon.
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 4000);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Cheap image-based lighting so car paint and glass have something to reflect.
const pmrem = new THREE.PMREMGenerator(renderer);
let envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ---------------------------------------------------------------------------
// Showcase scene (login / select / results backdrop)
// ---------------------------------------------------------------------------
const showcaseScene = new THREE.Scene();
showcaseScene.background = new THREE.Color(0x07080c);
showcaseScene.fog = new THREE.Fog(0x07080c, 18, 60);
showcaseScene.environment = envMap;
showcaseScene.add(new THREE.HemisphereLight(0x8fb3ff, 0x1a1208, 0.5));
{
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(8, 14, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 60;
  key.shadow.camera.left = key.shadow.camera.bottom = -12;
  key.shadow.camera.right = key.shadow.camera.top = 12;
  showcaseScene.add(key);
  const rim = new THREE.SpotLight(0xff3b3b, 60, 40, Math.PI / 5, 0.6, 1.2);
  rim.position.set(-8, 6, -8);
  showcaseScene.add(rim);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshStandardMaterial({ color: 0x14161e, roughness: 0.55, metalness: 0.3 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  showcaseScene.add(floor);
  const grid = new THREE.GridHelper(80, 40, 0x2a2f45, 0x1a1d2b);
  grid.position.y = 0.01;
  showcaseScene.add(grid);
}
const showcase = new THREE.Group();
showcaseScene.add(showcase);

let showcaseCar = null;
let showcaseToken = 0;
const SHOWCASE_FADE_MS = 280;

// Hero-car swap fade. Idempotent by construction: each material's REST opacity/transparent
// is recorded once (before anything ever touches it) in material.userData, every swap first
// FINISHES any fade still running (new car back to rest values, old car removed), and a
// timeout guarantees completion even if requestAnimationFrame is throttled. Rapid card
// switching used to capture mid-fade values as "rest" and leave the car at opacity 0
// (invisible, while its shadow still rendered).
let fadeJob = null;
const heroMaterials = (obj) => {
  const set = new Set();
  obj.traverse((o) => { if (o.isMesh && o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((x) => set.add(x)); });
  return [...set];
};
const rememberRest = (m) => { if (m.userData.restOpacity === undefined) { m.userData.restOpacity = m.opacity; m.userData.restTransparent = m.transparent; } };
const restoreRest = (m) => { if (m.userData.restOpacity !== undefined) { m.opacity = m.userData.restOpacity; m.transparent = m.userData.restTransparent; } };

function finishFade() {
  const j = fadeJob;
  if (!j) return;
  fadeJob = null;
  j.nm.forEach(restoreRest);
  j.newCar.visible = true;
  if (j.oldCar && j.oldCar !== j.newCar) showcase.remove(j.oldCar);
}

function fadeSwapShowcase(oldCar, newCar) {
  finishFade();
  const nm = heroMaterials(newCar);
  const om = oldCar ? heroMaterials(oldCar) : [];
  nm.forEach(rememberRest);
  om.forEach(rememberRest);
  nm.forEach((m) => { m.transparent = true; m.opacity = 0; });
  const job = { oldCar, newCar, nm, om, t0: performance.now() };
  fadeJob = job;
  setTimeout(() => { if (fadeJob === job) finishFade(); }, SHOWCASE_FADE_MS + 600);
  (function tick() {
    if (fadeJob !== job) return;
    const k = Math.min(1, (performance.now() - job.t0) / SHOWCASE_FADE_MS);
    nm.forEach((m) => { m.opacity = m.userData.restOpacity * k; });
    om.forEach((m) => { m.transparent = true; m.opacity = m.userData.restOpacity * (1 - k); });
    if (k < 1) { requestAnimationFrame(tick); return; }
    finishFade();
  })();
}

let showcaseLoading = 0;
let lastHealAt = 0;
/** Self-heal, run ~every 1.5 s while a menu screen is up: whatever went wrong (stuck fade,
 *  lost car, stale async load), the hero ends up present, visible and at rest opacity. */
function healShowcase(now) {
  if (now - lastHealAt < 1500) return;
  lastHealAt = now;
  if (fadeJob) return;
  if (!showcaseCar || !showcaseCar.parent) {
    if (!showcaseLoading) setShowcaseCar(skinnedCar(getCar(state.carId)));
    return;
  }
  showcaseCar.visible = true;
  for (const m of heroMaterials(showcaseCar)) restoreRest(m);
}

/** Debug: every mesh material under the hero car. */
function dumpHero() {
  const rows = [];
  showcase.traverse((o) => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => rows.push({ vis: o.visible, op: +m.opacity.toFixed(2), tr: m.transparent, name: (m.name || "").slice(0, 20) }));
  });
  return {
    children: showcase.children.length, meshes: rows.length, hidden: rows.filter((r) => !r.vis).length,
    opacityNearZero: rows.filter((r) => r.op < 0.05).length, ctxLost: renderer.getContext().isContextLost(),
    sample: rows.filter((r) => r.op < 0.99).slice(0, 4),
  };
}

const carLoadingEl = document.getElementById("car-loading");
async function setShowcaseCar(carConfig) {
  const token = ++showcaseToken;
  const hint = setTimeout(() => { if (token === showcaseToken) carLoadingEl.hidden = false; }, 150);
  showcaseLoading++;
  let model;
  try { model = await loadCarModel(carConfig); } finally { showcaseLoading--; clearTimeout(hint); }
  if (token !== showcaseToken) return; // a newer selection won
  carLoadingEl.hidden = true;
  const previous = showcaseCar;
  showcaseCar = assembleStatic(model);
  showcase.add(showcaseCar);
  try { fadeSwapShowcase(previous, showcaseCar); } catch (_) { if (previous) showcase.remove(previous); }
  // GLB failed (slow network)? Try once more a few seconds later.
  if (model.source === "primitive" && !carConfig._retried) {
    carConfig._retried = true;
    setTimeout(() => { if (token === showcaseToken) setShowcaseCar(carConfig); }, 5000);
  }
}

// ---------------------------------------------------------------------------
// Race scene
// ---------------------------------------------------------------------------
const raceScene = new THREE.Scene();
raceScene.environment = envMap;
const world = createWorld();
// Sky, sun, hemisphere light, fog and the single headlight are created ONCE here and only have their
// properties changed per track (env.apply) - lights are never added or removed after this point.
preloadNature(); // async, never blocks; jungle GLB trees appear once loaded, else procedural only
const env = createEnvironment(raceScene, renderer);
env.apply("sunny");
let track = null;
let scenery = null;
/** The built track for `id` (rebuilt if a different track was loaded), with its theme + scenery. */
function ensureTrack(id = state.trackId) {
  if (track && track.id !== id) disposeTrack();
  if (!track) {
    track = buildTrack(id, world, raceScene);
    env.apply(track.themeId);
    scenery = buildScenery(track.themeId, track, raceScene);
  }
  return track;
}
/** Free the current track, its scenery and weather (scene objects, GPU resources, physics bodies). */
function disposeTrack() {
  if (scenery) { try { scenery.dispose(); } catch (err) { console.warn("[scenery] dispose failed", err); } scenery = null; }
  if (track) { try { track.dispose(); } catch (err) { console.warn("[track] dispose failed", err); } track = null; }
  env.apply("sunny"); // menus render with the default exposure
}
const cameraRig = createCameraRig(camera);

// Pickups are created ONCE with the track and pooled across races (reset() per race). They own point
// lights, and three.js recompiles every lit material whenever the scene's light count changes, so
// creating/disposing them per race put a multi-hundred-ms shader compile inside every countdown.
let pickupsCtl = null;
function ensurePickups(t) {
  if (!pickupsCtl) pickupsCtl = createPickups(raceScene);
  pickupsCtl.configure(t);
  return pickupsCtl;
}

// Race-start prewarm (Bug B): while the player is on car-select / the lobby, build the circuit and
// compile the race scene's shaders (non-blocking where the GPU supports parallel compile) so the
// click on Race doesn't pay for it.
let prewarmScheduled = false;
function schedulePrewarm() {
  if (prewarmScheduled) return;
  prewarmScheduled = true;
  setTimeout(async () => {
    try {
      if (state.screen === "race") return;
      const t = ensureTrack();
      ensurePickups(t);
      if (renderer.compileAsync) await renderer.compileAsync(raceScene, camera);
      else renderer.compile(raceScene, camera);
    } catch (err) { console.warn("[prewarm]", err); }
  }, 700);
}

/** Visual rig: model frame (faces -Z) -> chassis frame (+X forward). */
function buildCarRig(model) {
  const root = new THREE.Group();
  const bodyPivot = new THREE.Group();
  bodyPivot.rotation.y = -Math.PI / 2;
  bodyPivot.add(model.body);
  root.add(bodyPivot);

  const wheels = model.wheels.map((w) => {
    const pivot = new THREE.Group();   // chassis-local position + steering
    const align = new THREE.Group();   // model-frame orientation
    align.rotation.y = -Math.PI / 2;
    w.node.position.set(0, 0, 0);
    w.node.quaternion.copy(w.quaternion);
    align.add(w.node);
    pivot.add(align);
    root.add(pivot);
    return { ...w, pivot };
  });

  // Physics layout in chassis frame: model (x, y, z) -> chassis (-z, y, x).
  const pw = model.wheels.map((w) => ({ x: -w.position.z, z: w.position.x, radius: w.radius, isFront: w.isFront }));
  const xs = pw.map((w) => w.x);
  const layout = {
    wheels: pw,
    halfLength: (Math.max(...xs) - Math.min(...xs)) / 2 + 0.6,
    centerX: (Math.max(...xs) + Math.min(...xs)) / 2,
    halfWidth: Math.max(...pw.map((w) => Math.abs(w.z))) + 0.08,
  };
  return { root, bodyPivot, wheels, layout, model };
}

// ---------------------------------------------------------------------------
// Remote cars (multiplayer) - visual-only puppets driven by RTDB state, no
// physics. Position/quaternion are interpolated toward the latest network
// sample over REMOTE_LERP_MS to hide the ~80ms gap between writeMyState() ticks.
// ---------------------------------------------------------------------------
const remotes = new Map(); // uid -> puppet
const REAL_MODEL_WAIT_MS = 3000; // how long a race start waits for a real car model before using the fallback
const knownNames = new Map(); // uid -> name, survives a player's own node being removed
const REMOTE_LERP_MS = 120;

// Minimap dots for remote players. Colour comes from the grid slot (mp.slotFor,
// the same host-written order every client sees), so a given player is the same
// colour on every screen and four players are four distinct colours. Red is the
// local player's and is never in this list.
const REMOTE_DOT_COLORS = ["#4da3ff", "#3ddc84", "#ffb300", "#c77dff"];
const REMOTE_DOT_STALE_MS = 3000; // hide a dot whose player hasn't sent state for this long
const _remoteDotPool = []; // marker objects, allocated at most once per player and reused
const _remoteDots = [];    // the list handed to minimap.update() - holds pool objects, never new ones

function makeNameSprite(text) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.font = "700 30px Inter, system-ui, sans-serif";
  const textW = g.measureText(text).width;
  const boxW = Math.min(236, textW + 28);
  g.fillStyle = "rgba(7,8,12,0.72)";
  g.fillRect(128 - boxW / 2, 14, boxW, 36);
  g.fillStyle = "#f2f4f8";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 33, boxW - 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.set(0, 2.1, 0);
  return sprite;
}

/** Same model-frame -> chassis-frame convention as buildCarRig, but static
 *  (no wheel articulation - remote cars are visual puppets, not simulated). */
function buildRemoteRig(model, name) {
  const root = new THREE.Group();
  const bodyPivot = new THREE.Group();
  bodyPivot.rotation.y = -Math.PI / 2;
  bodyPivot.add(assembleStatic(model));
  root.add(bodyPivot);
  root.add(makeNameSprite(name));
  return root;
}

function disposePuppet(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    if (o.isSprite) { o.material.map?.dispose(); o.material.dispose(); }
  });
}

/** Create (if needed) a loading placeholder for uid; the model loads async and
 *  the puppet becomes visible once both the model is ready AND a first state
 *  update has arrived (so it never flashes at the world origin). */
function ensureRemotePuppet(uid, name, carId, initial) {
  let r = remotes.get(uid);
  if (r) return r;
  r = {
    root: null, carId,
    from: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
    to: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
    tStart: performance.now(), hasState: false,
  };
  // Start on that racer's grid slot (same slot function as the local car) so the puppet is
  // already in the right place before its first network sample arrives.
  if (initial) {
    r.to.p.set(initial.position.x, 0.6, initial.position.z);
    r.to.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), initial.yaw);
    r.from.p.copy(r.to.p); r.from.q.copy(r.to.q);
    r.hasState = true;
  }
  remotes.set(uid, r);
  const attach = (model) => {
    if (remotes.get(uid) !== r) return; // removed (or replaced) while the model was loading
    const prev = r.root;
    r.root = buildRemoteRig(model, name);
    r.root.visible = r.hasState;
    if (r.hasState) { r.root.position.copy(r.to.p); r.root.quaternion.copy(r.to.q); }
    if (prev) { r.root.position.copy(prev.position); r.root.quaternion.copy(prev.quaternion); raceScene.remove(prev); disposePuppet(prev); }
    raceScene.add(r.root);
  };
  // Tinted-Ferrari fallback shows first if the real model is slow; swapped when it lands.
  loadCarModelQuick(getCar(carId), REAL_MODEL_WAIT_MS, (late) => { try { attach(late); } catch (_) { /* visual only */ } }).then(attach);
  return r;
}

/** Feed a fresh network sample: capture the current interpolated pose as the
 *  new lerp start so a burst of updates never makes the puppet jump backwards. */
function applyRemoteState(r, netState) {
  if (r.root) {
    const alpha = Math.min(1, (performance.now() - r.tStart) / REMOTE_LERP_MS);
    r.from.p.lerpVectors(r.from.p, r.to.p, alpha);
    r.from.q.slerp(r.to.q, alpha);
  }
  r.to.p.set(netState.position.x, netState.position.y, netState.position.z);
  r.to.q.set(netState.quaternion.x, netState.quaternion.y, netState.quaternion.z, netState.quaternion.w);
  r.speedKmh = Number(netState.speedKmh) || 0;
  r.tStart = performance.now();
  r.hasState = true;
  if (r.root) r.root.visible = true;
}

function removeRemotePuppet(uid) {
  const r = remotes.get(uid);
  if (!r) return;
  remotes.delete(uid);
  try { audio.removeRemoteEngine(uid); } catch (_) { /* audio only */ }
  if (r.root) { raceScene.remove(r.root); disposePuppet(r.root); }
}

/** Grid spawn pose for `uid` in a room view - the ONE slot function used for the local
 *  car and for every remote puppet. Pure given (track, view, uid). */
function gridPoseFor(t, view, uid) {
  let slot = mp.slotFor(view, uid);
  if (slot < 0) slot = view.players.length; // not listed (shouldn't happen): last row
  return t.gridSlot(slot);
}

/** Called from every room update while state.screen === "race": builds/updates/
 *  removes puppets for every OTHER player currently in the room. Symmetric by
 *  construction - runs identically on the host's and every guest's client, each
 *  filtering out only their own uid, so each side puppets everyone else. */
function updateRemotesFromView(view) {
  const seen = new Set();
  for (const p of view.players) {
    if (p.isMe) continue;
    seen.add(p.uid);
    let initial = null;
    try { if (track && view.status === "racing") initial = gridPoseFor(track, view, p.uid); } catch (_) { /* fall back to network state only */ }
    const r = ensureRemotePuppet(p.uid, p.name, p.carId, initial);
    // Read-only: slotFor is pure, and the slot only picks this player's minimap dot colour.
    try { r.slot = mp.slotFor(view, p.uid); } catch (_) { /* dot colour falls back below */ }
    if (p.state) applyRemoteState(r, p.state);
  }
  for (const uid of [...remotes.keys()]) if (!seen.has(uid)) removeRemotePuppet(uid);
}

function clearRemotes() {
  for (const uid of [...remotes.keys()]) removeRemotePuppet(uid);
}

/** Advance every remote puppet's interpolation. Called once per rendered race frame. */
function tickRemotes() {
  const now = performance.now();
  for (const [uid, r] of remotes) {
    if (!r.root || !r.hasState) continue;
    const alpha = Math.min(1, (now - r.tStart) / REMOTE_LERP_MS);
    r.root.position.lerpVectors(r.from.p, r.to.p, alpha);
    r.root.quaternion.slerpQuaternions(r.from.q, r.to.q, alpha);
    try {
      const me = state.race && state.race.veh.chassisBody.position;
      if (me) audio.remoteEngine(uid, Math.hypot(r.root.position.x - me.x, r.root.position.z - me.z), r.speedKmh || 0);
    } catch (_) { /* audio only */ }
  }
}

/** One minimap dot per ACTIVE remote player, filled into a reused array (never a
 *  fresh one) and returned - null when there is nothing to draw, so solo takes
 *  exactly the same path through minimap.update() as it always has.
 *
 *  Positions come from r.root.position - the interpolated puppet transform
 *  tickRemotes() just wrote, i.e. the very transform the 3D car is drawn at - so
 *  a dot glides with the car instead of stepping at the ~80ms network rate.
 *
 *  Skipped: a player whose puppet hasn't spawned yet (no root / no state), one
 *  whose last sample is older than REMOTE_DOT_STALE_MS, and any NaN position.
 *  A player who leaves loses their puppet in removeRemotePuppet(), so their dot
 *  simply stops being collected. */
function collectRemoteDots(now) {
  let n = 0;
  for (const [, r] of remotes) {
    if (!r.root || !r.hasState || !r.root.visible) continue;
    if (now - r.tStart > REMOTE_DOT_STALE_MS) continue;
    const p = r.root.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const slot = typeof r.slot === "number" && r.slot >= 0 ? r.slot : n;
    let d = _remoteDotPool[n];
    if (!d) d = _remoteDotPool[n] = { position: { x: 0, z: 0 }, color: "" };
    d.position.x = p.x;
    d.position.z = p.z;
    d.color = REMOTE_DOT_COLORS[slot % REMOTE_DOT_COLORS.length];
    _remoteDots[n] = d;
    n++;
  }
  // The pool keeps its objects; only this list's length changes, so a dot
  // appearing or going stale never allocates a new marker object.
  _remoteDots.length = n;
  return n ? _remoteDots : null;
}

/** (currentLap desc, trackDistance desc) - lap alone ties everyone mid-lap. */
function computeLeaderboard(view) {
  return view.players
    .map((p) => ({ uid: p.uid, name: p.name, isMe: p.isMe, lap: p.state?.currentLap || 0, dist: p.state?.trackDistance || 0 }))
    .sort((a, b) => (b.lap - a.lap) || (b.dist - a.dist));
}

function computeResultsBoard(view) {
  if (!view || !view.results) return [];
  const myUid = mp.getUid();
  return Object.entries(view.results)
    .map(([uid, r]) => ({ uid, isMe: uid === myUid, name: knownNames.get(uid) || "Racer", ...r }))
    .sort((a, b) => a.finishTimeMs - b.finishTimeMs);
}

// ---------------------------------------------------------------------------
// App state + input
// ---------------------------------------------------------------------------
const state = {
  screen: "login",
  player: null,
  carId: DEFAULT_CAR_ID,
  trackId: DEFAULT_TRACK_ID,
  race: null,
  mpStartAt: null,   // local Date.now() time the next online race's countdown ends
  lastRaceOnline: false, // was the just-finished race online? (drives the results screen)
};

const keys = new Set();
const KEY_ALIASES = {
  KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down",
  KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
  Space: "handbrake", ShiftLeft: "handbrake", ShiftRight: "handbrake",
};
document.addEventListener("keydown", (e) => {
  const k = KEY_ALIASES[e.code];
  if (k) keys.add(k);
  if (state.screen !== "race") return;
  if (k || e.code === "KeyC" || e.code === "KeyR") e.preventDefault();
  if (e.repeat) return;
  if (e.code === "KeyC") ui.setHudCamera(cameraRig.cycle());
  if (e.code === "KeyR") resetCar();
});
document.addEventListener("keyup", (e) => {
  const k = KEY_ALIASES[e.code];
  if (k) keys.delete(k);
});
window.addEventListener("blur", () => keys.clear());

function readInput() {
  return {
    throttle: (keys.has("up") ? 1 : 0) - (keys.has("down") ? 1 : 0),
    steer: (keys.has("left") ? 1 : 0) - (keys.has("right") ? 1 : 0),
    handbrake: keys.has("handbrake"),
  };
}

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------
const btnGoogle = document.getElementById("btn-google");
const btnSkip = document.getElementById("btn-skip");

function enterLobby(player) {
  state.player = player;
  ui.setPlayerChip(player);
  ui.setLoginStatus(`Welcome, ${player.name}!`, "ok");
  goTo("select");
}

let authUnavailableReason = "";

async function bootAuth() {
  ui.setLoginStatus("Connecting...");
  const result = await auth.initAuth({
    onSignedIn: (player) => { if (state.screen === "login") enterLobby(player); },
    onSignedOut: () => { if (state.screen !== "login") goTo("login"); },
    onError: (msg) => { ui.setLoginStatus(msg, "warn"); ui.setLoginBusy(false); },
  });

  if (result.available) {
    if (!auth.getPlayer()) ui.setLoginStatus("");
  } else {
    authUnavailableReason = result.reason || "Google sign-in unavailable. Use Demo Mode.";
    ui.setLoginStatus(authUnavailableReason, "warn");
    btnGoogle.disabled = true;
    btnGoogle.title = authUnavailableReason;
  }
}

btnGoogle.addEventListener("click", async () => {
  ui.setLoginBusy(true);
  ui.setLoginStatus("Opening Google sign-in...");
  const player = await auth.signInWithGoogle();
  ui.setLoginBusy(false);
  if (player) enterLobby(player);
});
btnSkip.addEventListener("click", () => auth.skipLogin());
document.addEventListener("keydown", (e) => {
  if (state.screen !== "login") return;
  if (e.key === "Enter" && !btnGoogle.disabled) btnGoogle.click();
  if (e.key === "Escape") btnSkip.click();
});

// ---------------------------------------------------------------------------
// CAR SELECT
// ---------------------------------------------------------------------------
const carList = document.getElementById("car-list");

function renderCarCards() {
  carList.innerHTML = "";
  for (const car of CARS) {
    const el = document.createElement("div");
    el.className = "car-card" + (car.id === state.carId ? " selected" : "");
    el.dataset.id = car.id;
    const hex = "#" + car.color.toString(16).padStart(6, "0");
    el.innerHTML = `
      <div class="car-swatch" style="background: linear-gradient(135deg, ${hex}, #000 140%)"></div>
      <h3 class="car-name">${car.name}</h3>
      <p class="car-blurb">${car.blurb}</p>
      ${statRow("Top speed", car.stats.topSpeed)}
      ${statRow("Accel", car.stats.acceleration)}
      ${statRow("Handling", car.stats.handling)}
    `;
    el.addEventListener("click", () => selectCar(car.id));
    carList.appendChild(el);
  }
  slideStrip();
}
function statRow(label, v) {
  return `<div class="stat"><span>${label}</span><div class="stat-bar"><i style="width:${Math.round(v * 100)}%"></i></div></div>`;
}
function selectCar(id) {
  state.carId = id;
  for (const el of carList.children) el.classList.toggle("selected", el.dataset.id === id);
  slideStrip();
  setShowcaseCar(skinnedCar(getCar(id)));
}

// ---------------------------------------------------------------------------
// Progression (Tasks 8-10): XP/coins/skins live in progression.js (pure); this
// is the only glue. Every entry point is try/catch-guarded so it can never break
// racing, results or car select.
// ---------------------------------------------------------------------------
function progressUid() {
  const p = state.player;
  return p && !p.demo && p.uid ? p.uid : "demo";
}
/** The selected car with its equipped skin tint applied (same tint path as cars.js's color). */
function skinnedCar(carCfg) {
  try { return { ...carCfg, color: prog.skinColor(carCfg, prog.loadProgress(progressUid())) }; }
  catch (_) { return carCfg; }
}
function refreshCoins() {
  try {
    const p = prog.loadProgress(progressUid());
    ui.setCoinBalance(p.coins);
    const lv = prog.levelFromXP(p.xp);
    document.getElementById("level-num").textContent = lv.lvl;
    document.getElementById("level-xp").textContent = `${lv.into} / ${lv.need} XP`;
    document.getElementById("level-fill").style.width = `${Math.round((lv.into / lv.need) * 100)}%`;
  } catch (_) { /* UI only */ }
}

const garageStatus = (msg, kind) => ui.setStatus("garage-status", msg, kind);
function renderGarage() {
  try {
    const car = getCar(state.carId);
    const p = prog.loadProgress(progressUid());
    ui.setCoinBalance(p.coins);
    const tintable = !(car.model && !car.paintMaterial);
    if (!tintable) { ui.renderGarage(car.name, null); return; }
    const equipped = prog.equippedSkinId(p, car.id);
    const rows = prog.skinsFor(car.id).map((s) => ({
      id: s.id, name: s.name, price: s.price,
      colorHex: "#" + (s.color == null ? car.color : s.color).toString(16).padStart(6, "0"),
      owned: prog.isOwned(p, car.id, s.id), equipped: s.id === equipped,
    }));
    ui.renderGarage(car.name, rows,
      (id) => { const r = prog.buySkin(progressUid(), car.id, id); try { r.ok ? audio.buy() : audio.denied(); } catch (_) { /* audio only */ } garageStatus(r.ok ? "Purchased!" : r.reason, r.ok ? "ok" : "err"); if (r.ok) ui.toast("Skin purchased", "ok", 1400); renderGarage(); },
      (id) => { const r = prog.equipSkin(progressUid(), car.id, id); garageStatus(r.ok ? "Equipped" : r.reason, r.ok ? "ok" : "err"); renderGarage(); setShowcaseCar(skinnedCar(car)); });
  } catch (err) {
    console.warn("[garage]", err);
  }
}
document.getElementById("btn-garage").addEventListener("click", () => { garageStatus(""); goTo("garage"); });
document.getElementById("btn-garage-back").addEventListener("click", () => goTo("select"));

/** Translate the card strip so the selected card sits at the screen's centre. */
function slideStrip() {
  const sel = carList.querySelector(".car-card.selected");
  if (!sel) return;
  const centre = sel.offsetLeft + sel.offsetWidth / 2;
  carList.style.transform = `translateX(${Math.round(carList.clientWidth / 2 - centre)}px)`;
}
window.addEventListener("resize", slideStrip);

// ---------------------------------------------------------------------------
// TRACK SELECT (car-select -> track-select -> race)
// ---------------------------------------------------------------------------
const trackList = document.getElementById("track-list");

/** Mini outline of a track, drawn from its spline (no meshes built). */
function drawTrackOutline(canvas, outline, accent) {
  const W = 248, H = 108, dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of outline) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const pad = 14;
  const k = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxZ - minZ || 1));
  const ox = (W - (maxX - minX) * k) / 2 - minX * k, oz = (H - (maxZ - minZ) * k) / 2 - minZ * k;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  outline.forEach(([x, z], i) => { const X = ox + x * k, Y = oz + z * k; if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); });
  ctx.closePath();
  ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = 8; ctx.stroke();
  ctx.strokeStyle = accent; ctx.lineWidth = 3.2; ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(ox + outline[0][0] * k, oz + outline[0][1] * k, 4.2, 0, Math.PI * 2); ctx.fill();
}

function renderTrackCards() {
  trackList.innerHTML = "";
  for (const T of listTracks()) {
    const theme = getTheme(T.themeId);
    const pv = getTrackPreview(T.id);
    const best = prog.loadBest(T.id);
    const el = document.createElement("div");
    el.className = "track-card" + (T.id === state.trackId ? " selected" : "");
    el.dataset.id = T.id;
    el.style.setProperty("--card-accent", theme.accent);
    el.setAttribute("role", "option");
    el.innerHTML = `
      <canvas class="track-outline"></canvas>
      <h3 class="track-name"></h3>
      <p class="track-place"></p>
      <div class="track-chips"><span class="track-chip weather"></span><span class="track-chip diff"></span></div>
      <div class="track-stats"><span class="ts-len"></span><span class="ts-laps"></span></div>
      <div class="track-best"></div>`;
    el.querySelector(".track-name").textContent = T.name;
    el.querySelector(".track-place").textContent = T.place;
    el.querySelector(".weather").textContent = T.weatherLabel;
    el.querySelector(".diff").textContent = T.difficulty;
    el.querySelector(".ts-len").textContent = `${(pv.length / 1000).toFixed(2)} km`;
    el.querySelector(".ts-laps").textContent = `${T.laps} laps`;
    el.querySelector(".track-best").textContent = best.lap != null ? `Best lap ${ui.formatTime(best.lap)}` : "No lap set yet";
    el.addEventListener("click", () => selectTrack(T.id));
    el.addEventListener("dblclick", () => goTo("race"));
    trackList.appendChild(el);
    drawTrackOutline(el.querySelector("canvas"), pv.outline, theme.accent);
  }
  const chip = document.getElementById("track-car-chip");
  if (chip) chip.textContent = getCar(state.carId).name;
}

function selectTrack(id) {
  state.trackId = getTrack(id).id;
  for (const el of trackList.children) el.classList.toggle("selected", el.dataset.id === state.trackId);
}
function moveTrackSelection(dir) {
  const ids = listTracks().map((t) => t.id);
  const i = Math.max(0, ids.indexOf(state.trackId));
  selectTrack(ids[(i + dir + ids.length) % ids.length]);
}

document.getElementById("btn-race").addEventListener("click", () => goTo("tracks"));
document.getElementById("btn-tracks-go").addEventListener("click", () => goTo("race"));
document.getElementById("btn-tracks-back").addEventListener("click", () => goTo("select"));
document.addEventListener("keydown", (e) => {
  if (state.screen !== "tracks") return;
  const k = e.code || e.key; // e.code is empty for some synthetic/IME keys; e.key is always set
  if (k === "ArrowLeft") { e.preventDefault(); moveTrackSelection(-1); }
  else if (k === "ArrowRight") { e.preventDefault(); moveTrackSelection(1); }
  else if (k === "Enter" || k === "NumpadEnter") { e.preventDefault(); goTo("race"); }
  else if (k === "Escape") { e.preventDefault(); goTo("select"); }
});
document.getElementById("btn-signout").addEventListener("click", async () => {
  await auth.signOut();
  ui.setLoginStatus(authUnavailableReason, authUnavailableReason ? "warn" : "");
  goTo("login");
});

// ---------------------------------------------------------------------------
// MULTIPLAYER LOBBY
// ---------------------------------------------------------------------------
const joinForm = document.getElementById("lobby-join");
const joinInput = document.getElementById("join-code");
const lobbyButtons = ["btn-host", "btn-join-open", "btn-join"].map((id) => document.getElementById(id));

function setLobbyBusy(busy) {
  for (const b of lobbyButtons) b.disabled = busy;
}
function mpProfile() {
  return { name: state.player.name, carId: state.carId, trackId: state.trackId };
}

// Host-only track picker in the lobby menu (joiners see the host's track, read-only, in the room panel).
const lobbyPicker = document.getElementById("lobby-track-picker");
function renderLobbyTrackPicker() {
  lobbyPicker.innerHTML = "";
  for (const T of listTracks()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "track-pick" + (T.id === state.trackId ? " selected" : "");
    b.style.setProperty("--card-accent", getTheme(T.themeId).accent);
    b.textContent = T.name;
    b.addEventListener("click", () => { state.trackId = T.id; renderLobbyTrackPicker(); });
    lobbyPicker.appendChild(b);
  }
}

document.getElementById("btn-multiplayer").addEventListener("click", () => {
  renderLobbyTrackPicker();
  ui.showLobbyPanel("menu");
  ui.setStatus("lobby-status", "");
  goTo("lobby");
});
document.getElementById("btn-lobby-back").addEventListener("click", () => goTo("select"));

document.getElementById("btn-host").addEventListener("click", async () => {
  setLobbyBusy(true);
  ui.setStatus("lobby-status", "Creating room...");
  try {
    await mp.hostRoom(mpProfile());
    ui.setStatus("lobby-status", "");
    ui.showLobbyPanel("room");
  } catch (err) {
    ui.setStatus("lobby-status", err.message, "err");
  } finally {
    setLobbyBusy(false);
  }
});

document.getElementById("btn-join-open").addEventListener("click", () => {
  ui.setStatus("join-status", "");
  joinInput.value = "";
  ui.showLobbyPanel("join");
  joinInput.focus();
});
document.getElementById("btn-join-back").addEventListener("click", () => ui.showLobbyPanel("menu"));
joinInput.addEventListener("input", () => {
  joinInput.value = mp.normalizeCode(joinInput.value).slice(0, 5);
});
joinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setLobbyBusy(true);
  ui.setStatus("join-status", "Joining...");
  try {
    await mp.joinRoom(joinInput.value, mpProfile());
    ui.setStatus("join-status", "");
    ui.showLobbyPanel("room");
  } catch (err) {
    ui.setStatus("join-status", err.message, "err");
  } finally {
    setLobbyBusy(false);
  }
});

document.getElementById("room-code").addEventListener("click", async () => {
  const code = mp.getRoom()?.code;
  if (!code) return;
  try { await navigator.clipboard.writeText(code); ui.toast(`Copied ${code}`, "ok", 1600); } catch (_) { /* no clipboard */ }
});
document.getElementById("btn-room-start").addEventListener("click", async (e) => {
  e.currentTarget.disabled = true;
  try {
    await mp.startRoomRace();
  } catch (err) {
    ui.setStatus("room-status", err.message, "err");
    e.currentTarget.disabled = false;
  }
});
document.getElementById("btn-room-leave").addEventListener("click", async () => {
  await mp.leaveRoom();
  ui.setStatus("lobby-status", "");
  ui.showLobbyPanel("menu");
});

mp.onRoomChange((view, reason) => {
  if (!view) {
    if (state.screen === "lobby") {
      ui.showLobbyPanel("menu");
      ui.setStatus("lobby-status", reason, "warn");
    } else if (state.screen === "race") {
      // Room gone mid-race (host closed it, or we got disconnected) - the local
      // race keeps running on its own physics either way, just drop the puppets
      // and leaderboard rather than leaving stale cars/ranks on screen.
      clearRemotes();
      ui.renderLeaderboard(null);
      if (reason) ui.toast(reason, "warn");
    } else if (reason) {
      ui.toast(reason, "warn");
    }
    return;
  }

  for (const p of view.players) knownNames.set(p.uid, p.name);

  if (state.screen === "lobby") {
    ui.renderRoom(view, getCar, mp.MAX_PLAYERS, mp.MIN_PLAYERS);
    ui.setRoomTrack(getTrack(view.trackId).name);
    if (view.status === "racing" && view.raceStartAt) {
      // Everyone counts down to the same server timestamp, not to when the
      // "go" message happened to arrive.
      state.mpStartAt = mp.serverToLocalTime(view.raceStartAt);
      goTo("race");
      return;
    }
    const short = view.players.length < mp.MIN_PLAYERS;
    ui.setStatus("room-status",
      view.isHost
        ? (short ? "Read the code out - need at least 2 racers." : "Ready when you are.")
        : "Waiting for the host to start...");
    return;
  }

  if (state.screen === "race" && state.race?.online) {
    updateRemotesFromView(view);
    ui.renderLeaderboard(computeLeaderboard(view));
    return;
  }

  if (state.screen === "results" && state.lastRaceOnline) {
    ui.renderMultiplayerBoard(computeResultsBoard(view));
  }
});

// ---------------------------------------------------------------------------
// RACE
// ---------------------------------------------------------------------------
document.getElementById("btn-quit").addEventListener("click", () => finishRace());
document.getElementById("btn-again").addEventListener("click", () => goTo("race"));
document.getElementById("btn-change-car").addEventListener("click", () => goTo("select"));

const COUNTDOWN_S = 3.4;
const _v = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();

// Race-start timing (Bug B): performance marks from the click to GO, plus a log of any frame over
// 50 ms while the race is starting. ER.perfSummary() prints them relative to the click.
// "Stable" = the last STABLE_FRAMES frames contain no spike: every frame is under 25 ms, or (on a slower
// display, where steady frames are simply longer) within 1.5x of those frames' own median. A hitch
// (shader compile, texture upload) is many times the median, so it always breaks stability; a merely
// slow-but-steady machine still passes instead of always waiting out the 5 s cap.
const STABLE_FRAMES = 10;
function noteFrame(rr, ms) {
  const ring = rr.frameRing || (rr.frameRing = []);
  ring.push(ms);
  if (ring.length > STABLE_FRAMES) ring.shift();
  if (ring.length < STABLE_FRAMES) return false;
  const sorted = ring.slice().sort((a, b) => a - b);
  return sorted[STABLE_FRAMES - 1] <= Math.max(25, sorted[STABLE_FRAMES >> 1] * 1.5);
}
const pmark = (n) => { try { performance.mark("er:" + n); } catch (_) { /* timing only */ } };
function perfSummary() {
  const c = performance.getEntriesByName("er:click").pop();
  if (!c) return null;
  const out = {};
  for (const e of performance.getEntriesByType("mark")) if (e.name.startsWith("er:") && e.startTime >= c.startTime) out[e.name.slice(3)] = Math.round(e.startTime - c.startTime);
  const r = state.race;
  return { marksMsFromClick: out, slowFramesOver50ms: r && r.slowFrames ? r.slowFrames.slice() : [], worstFrameMs: r ? r.worstFrame || 0 : 0 };
}

// Longest the race start waits for the scene to settle before starting the countdown anyway.
const WARMUP_MAX_MS = 5000;

async function startRace() {
  teardownRace();
  ui.setLoading("Loading race...");
  // Solo: the track chosen on the track-select screen. Online: the HOST's track (room.trackId), so every
  // client loads the same circuit; an unknown id falls back to the default track with a visible message.
  const room = mp.getRoom();
  if (room && room.trackId && getTrack(room.trackId).id !== room.trackId) ui.toast("Unknown track in room - loading Green Valley", "warn", 3500);
  const raceTrackId = room ? getTrack(room.trackId).id : state.trackId;
  ui.setHudLap(1, getTrack(raceTrackId).laps);
  ui.setHudTrack(getTrack(raceTrackId).name);
  ui.setHudTime(0);
  ui.setHudSpeed(0);
  ui.setHudBest(null);
  ui.setHudCenter("");
  ui.setHudCamera(cameraRig.getMode());
  // Let the "Loading race" overlay actually paint before any heavy synchronous work below.
  await new Promise((res) => { requestAnimationFrame(() => setTimeout(res, 0)); setTimeout(res, 120); });
  if (state.screen !== "race") return;

  const t = ensureTrack(raceTrackId);
  const pickups = ensurePickups(t);
  pickups.reset();
  pmark("track-ready");
  const carCfg = skinnedCar(getCar(state.carId));
  // Never let a slow model download hold the start: fallback after REAL_MODEL_WAIT_MS,
  // and swap the real body in (wheels are baked into it, so hide the Ferrari's) later.
  const model = await loadCarModelQuick(carCfg, REAL_MODEL_WAIT_MS, (late) => {
    try {
      const rr = state.race;
      if (!rr || rr.carCfg !== carCfg || !rr.rig) return;
      rr.rig.bodyPivot.clear();
      rr.rig.bodyPivot.add(late.body);
      rr.rig.wheels.forEach((w) => { w.node.visible = false; });
    } catch (_) { /* visual only */ }
  });
  if (state.screen !== "race") return; // user left while loading
  pmark("car-loaded");

  const rig = buildCarRig(model);
  const veh = createVehicle(world, carCfg, rig.layout, onCollide);
  rig.bodyPivot.position.y = -veh.restHeight;
  raceScene.add(rig.root);
  world.addEventListener("postStep", syncWheelVisuals);

  // Do the first-use GPU work NOW, under the loading overlay, instead of inside the countdown:
  // compile this car's materials against the race scene's lights and upload every texture.
  try {
    renderer.compile(raceScene, camera);
    const seen = new Set();
    raceScene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        for (const tex of [m.map, m.emissiveMap, m.normalMap]) if (tex && !seen.has(tex)) { seen.add(tex); renderer.initTexture(tex); }
      }
    });
  } catch (err) { console.warn("[warmup] compile/initTexture failed", err); }
  pmark("gpu-warm");

  const online = !!mp.getRoom();
  let pose = t.startPose(7); // solo: unchanged
  let slot = 0;
  if (online) {
    try {
      const g = gridPoseFor(t, mp.getRoom(), mp.getUid());
      pose = g; slot = g.slot;
    } catch (err) { console.warn("[grid] slot lookup failed, using default spawn", err); }
    console.log(`[grid] uid=${mp.getUid()} slot=${slot} pos=(${pose.position.x.toFixed(1)}, ${pose.position.z.toFixed(1)}) order=${JSON.stringify(mp.getRoom()?.order || null)}`);
  }
  veh.reset(pose.position, pose.yaw);

  // Pickups are pooled (ensurePickups above, reset() per race). Solo-only for now - see
  // pickups.js's file header for why multiplayer sync isn't wired yet.
  const minimap = createMinimap(document.getElementById("minimap"), t);
  // Analog speed gauge (speedometer.js) - visual only, guarded so it can never break a race.
  let speedo = null;
  try { speedo = createSpeedometer(document.getElementById("speedo"), { max: 240 }); } catch (e) { console.warn("[speedo]", e); }

  state.race = {
    ready: true,
    online,
    phase: "warmup",            // -> "countdown" once frames are stable (or after WARMUP_MAX_MS) -> "racing"
    countdownEnd: null,         // set by beginCountdown()
    syncedEnd: online ? countdownEndTime() : null, // online: the shared server-synced start, unchanged
    startedAt: 0,
    lapStartedAt: 0,
    lapTimes: [],
    lap: 1,
    nextCp: 1,
    cpSide: t.checkpoints.map(() => 0),
    veh, rig, track: t, carCfg, pickups, minimap, speedo,
    upsideDownFor: 0,
    lastDriftLineAt: 0,
    health: HEALTH_MAX,
    pendingRespawn: false,
    wrongWayFor: 0,
    lastCountN: 0, lastWW: null, lowHpAt: 0,
    readyAt: performance.now(),
  };
  try { audio.engineStart(); } catch (_) { /* audio only */ }
  ui.setHudHealth(HEALTH_MAX);
  if (online) { ui.renderLeaderboard(computeLeaderboard(mp.getRoom())); }
  syncChassisVisual();
  syncWheelVisuals();
  cameraRig.reset();
  cameraRig.setMode("chase");
  cameraRig.snap(cameraTarget());
  pmark("scene-ready");
}

/** End of warmup: the countdown clock starts NOW (solo), or is the shared synced start (online). */
function beginCountdown(r, now) {
  r.phase = "countdown";
  r.countdownEnd = r.online ? r.syncedEnd : now + COUNTDOWN_S * 1000;
  pmark("countdown-start");
  ui.setLoading(null);
}

/** performance.now() time the countdown ends: synced for online races, fixed for solo. */
function countdownEndTime() {
  const now = performance.now();
  if (state.mpStartAt == null) return now + COUNTDOWN_S * 1000;
  const end = now + Math.max(0, state.mpStartAt - Date.now());
  state.mpStartAt = null;
  return end;
}

function teardownRace() {
  const r = state.race;
  clearRemotes();
  ui.renderLeaderboard(null);
  if (!r) return;
  world.removeEventListener("postStep", syncWheelVisuals);
  if (r.veh) r.veh.dispose();
  if (r.rig) raceScene.remove(r.rig.root);
  try { if (r.speedo) r.speedo.destroy(); } catch (_) { /* visual only */ }
  hudBanner.reconnecting = false; hudBanner.respawnUntil = 0; hudBanner.wrongWay = null;
  refreshBanner();
  try { audio.engineStop(); } catch (_) { /* audio only */ }
  state.race = null;
  // Leaving the race (quit / finish / back / restart): free the track, its scenery and weather.
  disposeTrack();
}

function finishRace() {
  const r = state.race;
  if (!r) return;
  const laps = r.lapTimes.slice();
  const online = r.online;
  const roomBeforeTeardown = online ? mp.getRoom() : null;
  const finished = r.phase === "finished";
  const healthLeft = r.health;
  teardownRace();
  state.lastRaceOnline = online;
  ui.renderResults(state.player, laps);
  try {
    ui.setResultsTrack(`${r.track.name} - ${r.track.weatherLabel}`);
    if (laps.length) {
      const b = prog.saveBest(r.track.id, Math.min(...laps), finished ? laps.reduce((a, c) => a + c, 0) : NaN);
      if (b.newLap) ui.toast(`New best lap on ${r.track.name}: ${ui.formatTime(b.lap)}`, "ok", 3600);
    }
  } catch (err) { console.warn("[best]", err); }
  // Progression: the ONE place XP/coins are awarded. Only for a completed race.
  let progressData = null;
  if (finished) {
    try {
      let place = 1, players = 1;
      if (online && roomBeforeTeardown) {
        const board = computeResultsBoard(roomBeforeTeardown);
        const idx = board.findIndex((e) => e.isMe);
        players = roomBeforeTeardown.players.length || 1;
        place = idx >= 0 ? idx + 1 : 0; // 0 => podium falls to 0 below
      }
      const xp = prog.raceXP({
        finishMs: laps.reduce((a, b) => a + b, 0),
        healthLeft,
        place: place || 99, players: place ? players : 1,
        parTimeMs: prog.parTimeMs(r.track.laps, r.track.length),
      });
      progressData = { ...prog.applyRaceResult(progressUid(), xp), players: place ? players : 1 };
      if (progressData.leveledUp) ui.toast(`Level up! You reached level ${progressData.level.lvl}`, "ok", 3200);
    } catch (err) {
      console.warn("[progression]", err);
      progressData = null;
    }
  }
  try { ui.renderProgress(progressData); } catch (_) { /* results must still show */ }
  try { if (finished) audio.resultsSting(); } catch (_) { /* audio only */ }
  // Populate immediately from the cached room (don't wait for the next network
  // event) - onRoomChange keeps it live-updating as stragglers finish after this.
  ui.renderMultiplayerBoard(online ? computeResultsBoard(roomBeforeTeardown) : null);
  goTo("results");
}

// Health/damage meter (visual only - no game-ending effect). Reuses onCollide's
// own impact value below - the SAME velocity-delta this function already gets
// for shake/commentary - rather than a second detection path. "Hard" here is
// deliberately the same 6 m/s cutoff already used for the crash commentary line
// two lines down, and matches physics.js's own IMPACT_HARD_THRESHOLD (the speed-
// cut/steering-recovery trigger), so all four hard-hit effects agree on what
// counts as "hard".
const HEALTH_MAX = 100;
const HEALTH_DAMAGE_HARD_THRESHOLD = 6;   // m/s - see comment above
const HEALTH_DAMAGE_SCALE = 1.8;          // % health per m/s of impact above the threshold
const HEALTH_MIN_DAMAGE_PER_HIT = 3;      // even a just-over-threshold hit costs a little
const HEALTH_MAX_DAMAGE_PER_HIT = 30;     // cap so one single hit can't gut the bar
const HEALTH_REGEN_PER_SEC = 0;           // 0 = no regen (default). A single isolated
                                           // constant - change this alone for slow
                                           // passive regen, nothing else to touch.
const HEALTH_RESPAWN_PCT = 50;            // health after a 0%-HP respawn - enough to not
                                           // get immediately re-totaled, but repair
                                           // pickups still matter to get back to full.

function onCollide(impact) {
  const r = state.race;
  if (!r || !r.ready) return;
  cameraRig.shake(Math.min(1, impact / 12));
  try { audio.collision(impact); } catch (_) { /* audio only */ }
  if (impact > HEALTH_DAMAGE_HARD_THRESHOLD) {
    const damage = Math.min(HEALTH_MAX_DAMAGE_PER_HIT,
      Math.max(HEALTH_MIN_DAMAGE_PER_HIT, (impact - HEALTH_DAMAGE_HARD_THRESHOLD) * HEALTH_DAMAGE_SCALE));
    r.health = Math.max(0, r.health - damage);
    // Damage is fractional, so health could land on e.g. 0.4: the HUD rounds that to
    // "0%" but the `<= 0` respawn check below never fired. Anything under 1% is 0.
    if (r.health < 1) r.health = 0;
    ui.setHudHealth(r.health);
    // Actual respawn happens back in updateRace(), between physics steps - not
    // here, mid-collision-resolution (same reasoning as the existing upsideDown/
    // stranded recovery, which is also deferred to the main loop rather than
    // triggered from inside a physics callback).
    if (r.health <= 0 && !r.pendingRespawn) r.pendingRespawn = true;
  }
  if (impact > 6) commentate("crash").then((line) => line && ui.showCommentary(line));
}

// HUD banner state (Task 4) - one banner, resolved by priority every race tick.
const BANNER_RESPAWN_MS = 1200;
const hudBanner = { reconnecting: false, respawnUntil: 0, wrongWay: null };
function refreshBanner() {
  try {
    let text = "";
    if (hudBanner.reconnecting) text = "RECONNECTING";
    else if (performance.now() < hudBanner.respawnUntil) text = "RESPAWNING";
    else if (hudBanner.wrongWay != null) text = `WRONG WAY  ${hudBanner.wrongWay}`;
    ui.setHudBanner(text);
  } catch (_) { /* HUD only - never let it touch the race */ }
}
mp.onConnectionChange((connected) => {
  hudBanner.reconnecting = !connected && state.screen === "race" && !!state.race?.online;
  refreshBanner();
});

// Wrong-way detection (Task 5). Velocity (not heading) against the track tangent,
// sustained past a grace period before the countdown even shows - a spin or drift
// briefly reverses velocity for well under a second, so it never reaches the banner.
// resetCar() keeps lap / nextCp / trackDistance untouched (it only moves the chassis
// to the nearest centreline sample), so race position survives the reset.
const WRONG_WAY_MIN_KMH = 15;
const WRONG_WAY_GRACE_S = 1.5;
const WRONG_WAY_COUNTDOWN_S = 10;
function updateWrongWay(r, near, body, dt) {
  if (r.phase !== "racing") { r.wrongWayFor = 0; hudBanner.wrongWay = null; return; }
  const tan = near.sample.t;
  const alongKmh = (body.velocity.x * tan.x + body.velocity.z * tan.z) * 3.6;
  r.wrongWayFor = alongKmh < -WRONG_WAY_MIN_KMH ? (r.wrongWayFor || 0) + dt : 0;
  const over = r.wrongWayFor - WRONG_WAY_GRACE_S;
  if (over < 0) { hudBanner.wrongWay = null; return; }
  if (over >= WRONG_WAY_COUNTDOWN_S) {
    r.wrongWayFor = 0;
    hudBanner.wrongWay = null;
    resetCar();
    ui.toast("Wrong way - reset to the track.", "warn", 1600);
    return;
  }
  hudBanner.wrongWay = Math.ceil(WRONG_WAY_COUNTDOWN_S - over);
}

function resetCar() {
  const r = state.race;
  if (!r || !r.ready) return;
  const near = r.track.nearest(r.veh.chassisBody.position);
  const s = near.sample;
  r.veh.reset(s.p, s.yaw);
  r.upsideDownFor = 0;
  cameraRig.snap(cameraTarget());
}

function cameraTarget() {
  const r = state.race;
  const b = r.veh.chassisBody;
  return {
    position: _v.set(b.position.x, b.position.y, b.position.z),
    quaternion: r.rig.root.quaternion,
    speedRatio: r.veh.speedKmh() / r.veh.maxSpeedKmh,
  };
}

/** Chassis mesh <- physics body. Once per rendered frame is enough (it doesn't
 *  need to reflect intra-frame substeps, only the resolved end-of-frame pose). */
function syncChassisVisual() {
  const r = state.race;
  const b = r.veh.chassisBody;
  r.rig.root.position.set(b.position.x, b.position.y, b.position.z);
  r.rig.root.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
}

/**
 * Wheel meshes <- physics wheels. Registered as a `postStep` listener on the
 * physics world (see startRace/teardownRace) so it runs immediately after
 * every resolved physics step, using cannon's own per-wheel state as the
 * single source of truth (RaycastVehicle.updateVehicle -> updateWheelTransform
 * -> updateFriction already refreshes wheelInfos[i].steering/.rotation every
 * step before this fires - no separate/derived steer or roll tracking here).
 *   steering  live steer angle (0 for the rear wheels: only 0/1 are ever
 *             passed to vehicle.setSteeringValue)
 *   rotation  slip-aware accumulated roll angle about the axle (shows
 *             wheelspin under throttle and lock-up under braking correctly,
 *             not a naive chassis-speed/radius estimate)
 * Position and rotation are applied through the model's own pivot/align rig
 * (car-model.js's wheel nodes carry a baked, asset-specific orientation from
 * the source GLB) rather than overwriting the mesh's world quaternion
 * directly - the latter would assume the mesh's rest pose already matches
 * cannon's default wheel frame, which this imported asset's axes don't.
 */
function syncWheelVisuals() {
  const r = state.race;
  if (!r || !r.ready) return;
  r.rig.wheels.forEach((w, i) => {
    const info = r.veh.wheelInfo(i);
    r.veh.wheelLocalPosition(i, w.pivot.position);
    w.pivot.rotation.y = info.steering;
    w.node.rotation.x = info.rotation;
  });
}

function updateRace(dt) {
  const r = state.race;
  const t = r.track;
  const now = performance.now();

  // Warmup: car frozen, overlay up, first frames rendering. Start the countdown once 10 consecutive
  // frames are spike-free (r.stableMarked, set in frame()), after WARMUP_MAX_MS at the latest, or -
  // online - once the shared start time has arrived.
  if (r.phase === "warmup") {
    if (r.stableMarked || now - r.readyAt > WARMUP_MAX_MS || (r.online && r.syncedEnd != null && now >= r.syncedEnd)) beginCountdown(r, now);
  }

  // Countdown
  if (r.phase === "countdown") {
    const remaining = (r.countdownEnd - now) / 1000;
    ui.setHudCenter(remaining <= 0 ? "GO!" : String(Math.ceil(remaining)));
    try {
      const n = Math.ceil(remaining);
      if (remaining > 0 && n <= 3 && n !== r.lastCountN) { r.lastCountN = n; audio.countdownBeep(); }
      if (remaining <= 0) audio.goBeep();
    } catch (_) { /* audio only */ }
    if (remaining <= 0) {
      pmark("go");
      r.phase = "racing";
      r.startedAt = now;
      r.lapStartedAt = now;
      setTimeout(() => ui.setHudCenter(""), 900);
      commentate("race_start").then((line) => line && ui.showCommentary(line));
    }
  }

  // Input + physics
  const input = r.phase === "racing" ? readInput() : { throttle: 0, steer: 0, handbrake: true };
  const body = r.veh.chassisBody;
  const near = t.nearest(body.position);
  r.veh.setSurfaceGrip(near.dist > t.halfWidth + 0.9 ? TUNING.OFFROAD_GRIP : 1);
  r.veh.update(input, dt);
  stepWorld(world, dt);

  // Safety net (Bug A): the walls are static colliders and now hold in every strike test, but if
  // one ever fails to stop the car (centre beyond the wall's inner face) put it back at the
  // boundary, kill the outward velocity and apply wall damage ONCE per breach. Scalars only.
  try {
    const wallFace = t.halfWidth + t.barrierOffset;
    const post = t.nearest(body.position);
    if (post.dist > wallFace) {
      const ps = post.sample, d = post.dist || 1;
      const ux = (body.position.x - ps.p.x) / d, uz = (body.position.z - ps.p.z) / d;
      body.position.x = ps.p.x + ux * (wallFace - 1.0);
      body.position.z = ps.p.z + uz * (wallFace - 1.0);
      const vOut = body.velocity.x * ux + body.velocity.z * uz;
      if (vOut > 0) { body.velocity.x -= vOut * ux; body.velocity.z -= vOut * uz; }
      if (!r.wallBreach) { r.wallBreach = true; onCollide(Math.max(vOut, 3)); }
    } else if (post.dist < wallFace - 3) {
      r.wallBreach = false;
    }
  } catch (_) { /* never let the safety net break racing */ }

  // Auto-recover if flipped, fallen, or stranded outside the barriers.
  const stranded = near.dist > t.halfWidth + t.barrierOffset + 1.5;
  r.upsideDownFor = (r.veh.isUpsideDown() || stranded) ? r.upsideDownFor + dt : 0;
  r.onSideFor = r.veh.isOnSide() ? (r.onSideFor || 0) + dt : 0;
  if (r.upsideDownFor > 1.5 || body.position.y < -5) resetCar();
  else if (r.onSideFor > 0.6) { r.veh.level(); r.onSideFor = 0; }

  syncChassisVisual();
  // Wheel visuals are synced by syncWheelVisuals, a postStep listener on
  // `world` registered in startRace() - it already ran, inline with the
  // physics step above, for every substep stepWorld() just performed.

  // Sun + shadows follow the car.
  try {
    _fwd.set(1, 0, 0).applyQuaternion(r.rig.root.quaternion);
    env.update(now, body.position, _fwd);          // sun + headlight follow the car, lightning
    if (scenery) scenery.update(dt, camera);        // weather particles
  } catch (_) { /* visual only */ }

  // Camera
  cameraRig.update(dt, cameraTarget());

  // HUD
  const kmh = r.veh.speedKmh();
  ui.setHudSpeed(kmh);
  try { if (r.speedo) r.speedo.set(kmh); } catch (_) { /* visual only */ }
  if (r.phase === "racing") ui.setHudTime(now - r.lapStartedAt);

  // Multiplayer: push our own telemetry (throttled/dirty-checked inside
  // writeMyState itself), advance remote puppets toward their latest samples.
  if (r.online) {
    mp.writeMyState({
      position: body.position,
      quaternion: body.quaternion,
      speedKmh: kmh,
      currentLap: r.lap,
      currentCheckpoint: r.nextCp,
      trackDistance: near.sample.u * t.length,
    });
  }
  tickRemotes();

  // Pickups (boost + repair, solo-only for now - see pickups.js). Fed the resolved
  // end-of-frame chassis position, same as everything else below this point.
  const pk = r.pickups.update(dt, body.position);
  r.veh.setBoost(pk.boosted ? r.pickups.BOOST_FORCE_N : 0);
  for (const c of pk.collected) {
    if (c.kind === "boost") {
      try { audio.boostWhoosh(); } catch (_) { /* audio only */ }
      ui.toast("BOOST!", "ok", 1000);
    } else if (c.kind === "repair") {
      r.health = Math.min(HEALTH_MAX, r.health + r.pickups.REPAIR_AMOUNT);
      ui.setHudHealth(r.health);
      try { audio.repairChime(); } catch (_) { /* audio only */ }
      ui.toast("REPAIRED!", "ok", 1000);
    }
  }

  // Health regen (off by default - HEALTH_REGEN_PER_SEC above is the one constant
  // to change). A no-op at 0, so this line is inert until that constant is touched.
  if (HEALTH_REGEN_PER_SEC > 0 && r.health < HEALTH_MAX) {
    r.health = Math.min(HEALTH_MAX, r.health + HEALTH_REGEN_PER_SEC * dt);
    ui.setHudHealth(r.health);
  }

  // Respawn at 0% HP (deferred from onCollide, which can't safely reposition the
  // chassis mid-collision-resolution - flips the flag only, same pattern as the
  // existing upsideDown/stranded recovery just above, kept as its own separate
  // check rather than folded into that chain so it can't interact with already-
  // debugged logic there).
  if (r.pendingRespawn) {
    r.pendingRespawn = false;
    resetCar();
    hudBanner.respawnUntil = performance.now() + BANNER_RESPAWN_MS;
    try { audio.respawnSweep(); } catch (_) { /* audio only */ }
    r.health = HEALTH_RESPAWN_PCT;
    ui.setHudHealth(r.health);
    ui.toast("Car totaled - back on track, partially repaired.", "warn", 2200);
  }

  try { updateWrongWay(r, near, body, dt); } catch (_) { /* never let it break racing */ }
  refreshBanner();

  // Audio (engine follows speed/throttle; slip = sideways velocity share; beeps for warnings).
  try {
    _side.set(0, 0, 1).applyQuaternion(r.rig.root.quaternion);
    const vLat = Math.abs(body.velocity.x * _side.x + body.velocity.z * _side.z);
    const slip = kmh > 30 ? Math.max(0, Math.min(1, (vLat - 2) / 8)) : 0;
    audio.engineUpdate({
      kmh, throttle: input.throttle > 0 ? input.throttle : 0, boost: pk.boosted,
      slip, countdown: r.phase === "countdown",
    });
    audio.reportFrame(dt);
    if (hudBanner.wrongWay !== r.lastWW) { if (hudBanner.wrongWay != null) audio.wrongWayBeep(); r.lastWW = hudBanner.wrongWay; }
    if (r.phase === "racing" && r.health < 25 && now - r.lowHpAt > 1200) { r.lowHpAt = now; audio.lowHpBeep(); }
  } catch (_) { /* audio only */ }

  // Minimap (Task 3): local marker plus one dot per active remote player.
  // Heading uses the same atan2(-fwd.z, fwd.x) convention track.js's own samples
  // use. collectRemoteDots returns null in solo, so solo draws exactly as before;
  // a failure there must never cost us the local marker.
  _fwd.set(1, 0, 0).applyQuaternion(r.rig.root.quaternion);
  let remoteDots = null;
  try { remoteDots = collectRemoteDots(now); } catch (_) { /* dots are decoration only */ }
  r.minimap.update(body.position, Math.atan2(-_fwd.z, _fwd.x), remoteDots);

  // Drift commentary
  if (r.phase === "racing" && input.handbrake && kmh > 45 && now - r.lastDriftLineAt > 9000) {
    r.lastDriftLineAt = now;
    commentate("drift").then((line) => line && ui.showCommentary(line));
  }

  // Checkpoints / laps
  if (r.phase === "racing") {
    const cps = t.checkpoints;
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      _rel.set(body.position.x - cp.position.x, 0, body.position.z - cp.position.z);
      const along = _rel.dot(cp.tangent);
      const lateral = Math.abs(_rel.dot(cp.normal));
      const side = along >= 0 ? 1 : -1;
      const crossed = r.cpSide[i] < 0 && side > 0 && lateral < cp.halfWidth && Math.abs(along) < 8;
      r.cpSide[i] = side;
      if (crossed && i === r.nextCp) onCheckpoint(i);
    }
  }
}

function onCheckpoint(i) {
  const r = state.race;
  const now = performance.now();
  if (i === 0) {
    const lapTime = now - r.lapStartedAt;
    r.lapTimes.push(lapTime);
    r.lapStartedAt = now;
    ui.setHudBest(Math.min(...r.lapTimes));
    r.lap += 1;
    if (r.lap > r.track.laps) {
      r.phase = "finished";
      try { audio.finishFanfare(); audio.engineStop(); } catch (_) { /* audio only */ }
      ui.setHudCenter("FINISH");
      commentate("race_finish").then((line) => line && ui.showCommentary(line));
      if (r.online) {
        mp.writeMyResult({
          finishTimeMs: r.lapTimes.reduce((a, b) => a + b, 0),
          bestLapMs: Math.min(...r.lapTimes),
          totalLaps: r.lapTimes.length,
        });
      }
      setTimeout(() => { if (state.race === r) finishRace(); }, 2200);
      return;
    }
    ui.setHudLap(r.lap, r.track.laps);
    try { audio.lapDing(); } catch (_) { /* audio only */ }
    const evt = r.lap === r.track.laps ? "final_lap" : "lap_complete";
    commentate(evt).then((line) => line && ui.showCommentary(line));
  }
  r.nextCp = (i + 1) % r.track.checkpoints.length;
}

// ---------------------------------------------------------------------------
// Screen router
// ---------------------------------------------------------------------------
function goTo(screen) {
  if (screen !== "login" && !state.player) screen = "login";
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (state.screen === "race" && screen !== "race") teardownRace();
  // Keep the room while: in the lobby, about to start a synced online race,
  // mid-race in one, or watching a just-finished online race's results (so the
  // shared leaderboard/results keep live-updating). Leave it anywhere else.
  const wantsRoom = screen === "lobby"
    || (screen === "race" && (state.mpStartAt != null || (state.race && state.race.online)))
    || (screen === "results" && state.lastRaceOnline);
  if (screen !== "race") state.mpStartAt = null;
  if (mp.getRoom() && !wantsRoom) mp.leaveRoom();
  state.screen = ui.showScreen(screen);
  keys.clear();
  if (screen === "select" || screen === "lobby") schedulePrewarm();
  if (screen === "tracks") renderTrackCards();
  if (screen === "select") { renderCarCards(); refreshCoins(); setShowcaseCar(skinnedCar(getCar(state.carId))); }
  if (screen === "garage") renderGarage();
  if (screen === "race") { pmark("click"); startRace(); }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function frame() {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);

  if (state.screen === "race" && state.race?.ready) {
    try { // start-up timing only
      const rr = state.race;
      if (!rr.firstFrameMarked) { rr.firstFrameMarked = true; pmark("first-frame"); }
      if (rawDt > 0.05 && (rr.phase === "countdown" || rr.phase === "warmup" || performance.now() - rr.readyAt < 5000)) (rr.slowFrames || (rr.slowFrames = [])).push({ ms: Math.round(rawDt * 1000), phase: rr.phase, sinceReadyMs: Math.round(performance.now() - rr.readyAt) });
      rr.worstFrame = Math.max(rr.worstFrame || 0, Math.round(rawDt * 1000));
      if (noteFrame(rr, rawDt * 1000) && !rr.stableMarked) { rr.stableMarked = true; pmark("stable10"); }
    } catch (_) { /* timing only */ }
    updateRace(dt);
    renderer.render(raceScene, camera);
  } else {
    showcase.rotation.y += dt * 0.45;
    try { healShowcase(performance.now()); } catch (_) { /* menu only */ }
    const t = clock.elapsedTime;
    camera.fov = 45;
    camera.updateProjectionMatrix();
    camera.position.set(Math.sin(t * 0.12) * 2.5, 2.6 + Math.sin(t * 0.3) * 0.3, 8.5);
    // On car-select the card strip owns the bottom of the screen, so aim lower to
    // lift the hero car up into the clear middle.
    camera.lookAt(0, state.screen === "select" || state.screen === "tracks" ? -0.35 : 0.7, 0);
    renderer.render(showcaseScene, camera);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Dev handle for the console / automated checks (harmless in the demo).
window.ER = { state, cameraRig, TUNING, keys, camera, THREE, mp, remotes, computeLeaderboard, computeResultsBoard, updateRace, hudBanner, showcase, prog, renderer, raceScene, dumpHero, gridPoseFor, gridOffsets, audio, updateRemotesFromView, perfSummary, ensureTrack, disposeTrack, env, getScenery: () => scenery };

// WebGL context loss (GPU reset, driver hiccup, tab throttling): keep the page alive and
// rebuild what lives in GPU memory that three.js can't restore on its own - the PMREM
// environment map (reflections) - then rebuild the hero car.
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); console.warn("[gl] context lost"); });
canvas.addEventListener("webglcontextrestored", () => {
  console.warn("[gl] context restored - rebuilding");
  try {
    envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    showcaseScene.environment = envMap;
    raceScene.environment = envMap;
  } catch (err) { console.warn("[gl] env rebuild failed", err); }
  try {
    finishFade();
    if (showcaseCar) { showcase.remove(showcaseCar); showcaseCar = null; }
    setShowcaseCar(skinnedCar(getCar(state.carId)));
  } catch (err) { console.warn("[gl] hero rebuild failed", err); }
});

audio.initAudio();
preloadCarAssets();
setShowcaseCar(getCar(state.carId));
ui.showScreen("login");
frame();
bootAuth();
