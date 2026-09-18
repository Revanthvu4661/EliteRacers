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
import * as auth from "./auth.js?v=9";
import * as ui from "./ui.js?v=9";
import { CARS, DEFAULT_CAR_ID, getCar } from "./cars.js?v=9";
import { createWorld, stepWorld, createVehicle, TUNING } from "./physics.js?v=9";
import { buildTrack, TRACK_CONFIG } from "./track.js?v=9";
import { createCameraRig } from "./camera.js?v=9";
import { loadCarModel, assembleStatic, preloadCarAssets } from "./car-model.js?v=9";
import { commentate } from "./ai-commentary.js?v=9";
import * as mp from "./multiplayer.js?v=9";

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

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 3000);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Cheap image-based lighting so car paint and glass have something to reflect.
const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

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
async function setShowcaseCar(carConfig) {
  const token = ++showcaseToken;
  const model = await loadCarModel(carConfig);
  if (token !== showcaseToken) return; // a newer selection won
  if (showcaseCar) showcase.remove(showcaseCar);
  showcaseCar = assembleStatic(model);
  showcase.add(showcaseCar);
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
let track = null;
function ensureTrack() {
  if (!track) track = buildTrack(raceScene, world);
  return track;
}
const cameraRig = createCameraRig(camera);

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
// App state + input
// ---------------------------------------------------------------------------
const state = {
  screen: "login",
  player: null,
  carId: DEFAULT_CAR_ID,
  race: null,
  mpStartAt: null,   // local Date.now() time the next online race's countdown ends
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
}
function statRow(label, v) {
  return `<div class="stat"><span>${label}</span><div class="stat-bar"><i style="width:${Math.round(v * 100)}%"></i></div></div>`;
}
function selectCar(id) {
  state.carId = id;
  for (const el of carList.children) el.classList.toggle("selected", el.dataset.id === id);
  setShowcaseCar(getCar(id));
}

document.getElementById("btn-race").addEventListener("click", () => goTo("race"));
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
  return { name: state.player.name, carId: state.carId };
}

document.getElementById("btn-multiplayer").addEventListener("click", () => {
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
    } else if (reason) {
      ui.toast(reason, "warn");
    }
    return;
  }
  if (state.screen !== "lobby") return;

  ui.renderRoom(view, getCar, mp.MAX_PLAYERS, mp.MIN_PLAYERS);
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

async function startRace() {
  teardownRace();
  ui.setLoading("Building circuit...");
  ui.setHudLap(1, TRACK_CONFIG.laps);
  ui.setHudTime(0);
  ui.setHudSpeed(0);
  ui.setHudBest(null);
  ui.setHudCenter("");
  ui.setHudCamera(cameraRig.getMode());

  const t = ensureTrack();
  const carCfg = getCar(state.carId);
  ui.setLoading("Loading car...");
  const model = await loadCarModel(carCfg);
  if (state.screen !== "race") return; // user left while loading

  const rig = buildCarRig(model);
  const veh = createVehicle(world, carCfg, rig.layout, onCollide);
  rig.bodyPivot.position.y = -veh.restHeight;
  raceScene.add(rig.root);
  world.addEventListener("postStep", syncWheelVisuals);

  const pose = t.startPose(7);
  veh.reset(pose.position, pose.yaw);

  state.race = {
    ready: true,
    phase: "countdown",
    countdownEnd: countdownEndTime(),
    startedAt: 0,
    lapStartedAt: 0,
    lapTimes: [],
    lap: 1,
    nextCp: 1,
    cpSide: t.checkpoints.map(() => 0),
    veh, rig, track: t, carCfg,
    upsideDownFor: 0,
    lastDriftLineAt: 0,
  };
  syncChassisVisual();
  syncWheelVisuals();
  cameraRig.reset();
  cameraRig.setMode("chase");
  cameraRig.snap(cameraTarget());
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
  if (!r) return;
  world.removeEventListener("postStep", syncWheelVisuals);
  if (r.veh) r.veh.dispose();
  if (r.rig) raceScene.remove(r.rig.root);
  state.race = null;
}

function finishRace() {
  const r = state.race;
  if (!r) return;
  const laps = r.lapTimes.slice();
  teardownRace();
  ui.renderResults(state.player, laps);
  goTo("results");
}

function onCollide(impact) {
  const r = state.race;
  if (!r || !r.ready) return;
  cameraRig.shake(Math.min(1, impact / 12));
  if (impact > 6) commentate("crash").then((line) => line && ui.showCommentary(line));
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

  // Countdown
  if (r.phase === "countdown") {
    const remaining = (r.countdownEnd - now) / 1000;
    ui.setHudCenter(remaining <= 0 ? "GO!" : String(Math.ceil(remaining)));
    if (remaining <= 0) {
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

  // Auto-recover if flipped, fallen, or stranded outside the barriers.
  const stranded = near.dist > t.halfWidth + TRACK_CONFIG.barrierOffset + 1.5;
  r.upsideDownFor = (r.veh.isUpsideDown() || stranded) ? r.upsideDownFor + dt : 0;
  r.onSideFor = r.veh.isOnSide() ? (r.onSideFor || 0) + dt : 0;
  if (r.upsideDownFor > 1.5 || body.position.y < -5) resetCar();
  else if (r.onSideFor > 0.6) { r.veh.level(); r.onSideFor = 0; }

  syncChassisVisual();
  // Wheel visuals are synced by syncWheelVisuals, a postStep listener on
  // `world` registered in startRace() - it already ran, inline with the
  // physics step above, for every substep stepWorld() just performed.

  // Sun + shadows follow the car.
  t.sun.position.set(body.position.x + 60, 110, body.position.z + 40);
  t.sun.target.position.set(body.position.x, 0, body.position.z);

  // Camera
  cameraRig.update(dt, cameraTarget());

  // HUD
  const kmh = r.veh.speedKmh();
  ui.setHudSpeed(kmh);
  if (r.phase === "racing") ui.setHudTime(now - r.lapStartedAt);

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
    if (r.lap > TRACK_CONFIG.laps) {
      r.phase = "finished";
      ui.setHudCenter("FINISH");
      commentate("race_finish").then((line) => line && ui.showCommentary(line));
      setTimeout(() => { if (state.race === r) finishRace(); }, 2200);
      return;
    }
    ui.setHudLap(r.lap, TRACK_CONFIG.laps);
    const evt = r.lap === TRACK_CONFIG.laps ? "final_lap" : "lap_complete";
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
  // Anywhere but the lobby or an online race means we've left the room.
  if (screen !== "race") state.mpStartAt = null;
  if (mp.getRoom() && screen !== "lobby" && !(screen === "race" && state.mpStartAt != null)) mp.leaveRoom();
  state.screen = ui.showScreen(screen);
  keys.clear();
  if (screen === "select") renderCarCards();
  if (screen === "race") startRace();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (state.screen === "race" && state.race?.ready) {
    updateRace(dt);
    renderer.render(raceScene, camera);
  } else {
    showcase.rotation.y += dt * 0.45;
    const t = clock.elapsedTime;
    camera.fov = 45;
    camera.updateProjectionMatrix();
    camera.position.set(Math.sin(t * 0.12) * 2.5, 2.6 + Math.sin(t * 0.3) * 0.3, 8.5);
    camera.lookAt(0, 0.7, 0);
    renderer.render(showcaseScene, camera);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Dev handle for the console / automated checks (harmless in the demo).
window.ER = { state, cameraRig, TUNING, keys, camera, THREE };

preloadCarAssets();
setShowcaseCar(getCar(state.carId));
ui.showScreen("login");
frame();
bootAuth();
