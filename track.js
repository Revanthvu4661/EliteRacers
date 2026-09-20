// ============================================================================
// track.js - closed-loop circuits built from CatmullRom splines. A track is DATA (see TRACKS).
//
// buildTrack(id, world, scene) adds to the scene the ground, asphalt ribbon with lane markings,
// kerbs, barriers (with ONE static compound physics body), start/finish gantry, gates and a
// grandstand, and returns the helpers every consumer uses (samples, nearest, checkpoints, pickups,
// startPose, gridSlot, tangentAt, bounds, dispose). The sky, lights, fog, scenery and weather are NOT
// built here: they belong to the theme system (themes.js / scenery.js), which is created once and
// only has its properties changed per track. Ground/road/kerb/barrier LOOKS come from the theme.
// ============================================================================

import * as THREE from "three";
import * as CANNON from "cannon-es";
import { getTheme, makeGroundTexture, makeRoadMaterial, hashString } from "./themes.js?v=58";

// ---------------------------------------------------------------------------
// TRACK DATA. A track is a plain data object; buildTrack(id, ...) turns it into geometry,
// colliders and helpers. Everything is FLAT (y = 0): physics is a flat ground plane.
//   {id, name, place, weatherLabel, controlPoints (closed Catmull-Rom loop, x/z metres),
//    width, laps, checkpointCount, pickups:[{kind, t}] (t = fraction along the loop),
//    startT, themeId, difficulty, samples, groundHalf}
// Pickups are always 6 boost + 3 repair on every track: the pooled pickup controller owns one
// point light per pickup, and the scene's light count must never change (see pickups.js).
// ---------------------------------------------------------------------------

// Larger-track pass: Track 1's control points and every size below are scaled by SCALE (2.2x,
// within the asked 2-2.5x range) from the original circuit, uniformly - same shape, same
// corner-radii logic (untouched), just bigger. width/barrierOffset/curb size scale by the same
// factor so the road doesn't look like a thread lost in a huge landscape at the new scale.
const SCALE = 2.2;

// Shared (not per-track) constants. laps / checkpoints / width live in the track data now;
// they stay here only for anything that still imports the old single-track config.
export const TRACK_CONFIG = {
  width: Math.round(16 * SCALE),
  laps: 3,
  checkpoints: 4,
  samples: 420,
  curbSpacing: +(2.6 * SCALE).toFixed(2),     // m between curb blocks
  barrierSpacing: +(4.0 * SCALE).toFixed(2),  // m between barrier segments (legacy; walls now follow the samples)
  barrierOffset: Math.round(6 * SCALE),  // m from road edge to barrier centre - more grass
                         // shoulder to run through before hitting a hard collision
  bounds: Math.round(340 * SCALE),          // half-size of grass plane
};

// Track 1 "Green Valley": the original circuit, unchanged.
const GREEN_VALLEY_POINTS = [
  [-60, 0], [60, 0], [130, -25], [155, -90], [115, -150], [45, -120],
  [-15, -160], [-100, -140], [-150, -70], [-135, 10], [-105, 32],
].map(([x, z]) => [x * SCALE, z * SCALE]);

// Track 2 "Red Mesa": two long fast straights (the start straight bows gently north, the return bows
// south) joined by two R=48 m hairpins. ~2.48 km. Validated: min radius 29.7 m, legs >= 96 m apart,
// wall lines >= 64 m from any other stretch of road.
const RED_MESA_POINTS = [
  [-540, -78], [-270, -96], [0, -112], [270, -96], [540, -78],
  [564, -71.6], [581.6, -54], [588, -30], [581.6, -6], [564, 11.6],
  [540, 18], [300, 78], [0, 113], [-300, 78], [-540, 18],
  [-564, 11.6], [-581.6, -6], [-588, -30], [-581.6, -54], [-564, -71.6],
];

// Track 3 "Harbor Nights": compact container-port circuit with five tight S-bend chicanes (arc R=38-40 m)
// joined by R=50 m corners. ~1.54 km. Validated: min radius 30.6 m, legs >= 124 m apart.
const HARBOR_NIGHTS_POINTS = [
  [-184, -156], [-145.5, -156], [-106.9, -156], [-68.4, -156], [-29.8, -156], [8.7, -156], [47.3, -156],
  [59.2, -154.1], [70, -148.5], [78.4, -139.8], [86.8, -131.1], [97.6, -125.5], [109.5, -123.6],
  [144.5, -123.6], [179.5, -123.6], [195, -121.1], [208.9, -114], [220, -103], [227.1, -89], [229.5, -73.6],
  [229.5, -40.3], [229.5, -7], [231.5, 5], [237, 15.7], [245.7, 24.2], [254.4, 32.6], [260, 43.3], [261.9, 55.3],
  [261.9, 105.3], [259.5, 120.7], [252.4, 134.7], [241.3, 145.7], [227.4, 152.8], [211.9, 155.3],
  [168.6, 155.3], [125.3, 155.3], [81.9, 155.3], [70, 153.4], [59.2, 147.8], [50.8, 139.1], [42.4, 130.4],
  [31.6, 124.8], [19.7, 122.9], [-20.3, 122.9], [-32.3, 124.8], [-43, 130.4], [-51.4, 139.1], [-59.9, 147.8],
  [-70.6, 153.4], [-82.6, 155.3], [-125.9, 155.3], [-169.2, 155.3], [-212.6, 155.3], [-228, 152.8],
  [-242, 145.7], [-253, 134.7], [-260.1, 120.7], [-262.6, 105.3], [-262.6, 72], [-262.6, 38.6], [-262.6, 5.3],
  [-260.9, -6.2], [-256, -16.7], [-248.3, -25.4], [-240.6, -34], [-235.7, -44.5], [-234, -56], [-234, -106],
  [-231.6, -121.5], [-224.5, -135.4], [-213.4, -146.5], [-199.5, -153.6],
];

const boost = (t) => ({ kind: "boost", t });
const repair = (t) => ({ kind: "repair", t });

export const TRACKS = [
  {
    id: "green-valley",
    name: "Green Valley",
    place: "Lowland countryside",
    weatherLabel: "Sunny",
    controlPoints: GREEN_VALLEY_POINTS,
    width: Math.round(16 * SCALE),
    laps: 3,
    checkpointCount: 4,
    // Fixed fractions around the loop, deliberately offset from the checkpoint gates (0, .25, .5,
    // .75) and the start/finish grandstand so they don't crowd either.
    pickups: [boost(0.08), boost(0.18), boost(0.36), boost(0.58), boost(0.7), boost(0.88),
              repair(0.13), repair(0.47), repair(0.81)],
    startT: 0,
    themeId: "sunny",
    difficulty: "Medium",
    samples: 420,        // ribbon resolution (~4.4 m per sample)
    groundHalf: Math.round(340 * SCALE),
  },
  {
    id: "red-mesa",
    name: "Red Mesa",
    place: "Canyon country, Arizona",
    weatherLabel: "Hot & dusty",
    controlPoints: RED_MESA_POINTS,
    width: 38,
    laps: 2,
    checkpointCount: 5,
    pickups: [boost(0.07), boost(0.27), boost(0.34), boost(0.56), boost(0.68), boost(0.77),
              repair(0.13), repair(0.52), repair(0.86)],
    startT: 0,
    themeId: "desert",
    difficulty: "Fast",
    samples: 540,
    groundHalf: 1100,
    groundMargin: 420,
  },
  {
    id: "harbor-nights",
    name: "Harbor Nights",
    place: "Container port, North Sea",
    weatherLabel: "Night rain",
    controlPoints: HARBOR_NIGHTS_POINTS,
    width: 32,
    laps: 3,
    checkpointCount: 4,
    pickups: [boost(0.08), boost(0.19), boost(0.36), boost(0.58), boost(0.69), boost(0.9),
              repair(0.14), repair(0.45), repair(0.82)],
    startT: 0,
    themeId: "nightRain",
    difficulty: "Technical",
    samples: 330,
    groundHalf: 700,
    groundMargin: 190,
  },
];

export const DEFAULT_TRACK_ID = TRACKS[0].id;
export function listTracks() { return TRACKS.slice(); }
/** Track data by id; an unknown id falls back to the default track (never throws). */
export function getTrack(id) { return TRACKS.find((t) => t.id === id) || TRACKS[0]; }

const previewCache = new Map();
/**
 * Cheap preview for menus (no meshes, no physics): { length, outline: [[x, z], ...] } sampled from the
 * same spline the built track uses. Cached per id.
 */
export function getTrackPreview(id) {
  const T = getTrack(id);
  if (previewCache.has(T.id)) return previewCache.get(T.id);
  const curve = new THREE.CatmullRomCurve3(T.controlPoints.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, "centripetal");
  const outline = [];
  const n = 160;
  for (let i = 0; i < n; i++) { const p = curve.getPointAt(i / n); outline.push([p.x, p.z]); }
  const preview = { length: curve.getLength(), outline };
  previewCache.set(T.id, preview);
  return preview;
}

// Starting grid (multiplayer): 2 columns, rows BEHIND the start line along the track
// tangent, up to 8 slots. Spacing is larger than the 6 m / 3.5 m minimum on purpose: the
// rendered cars are ~7 m long (VISUAL_SCALE 1.4) and ~3.2 m wide, so 6 m rows / 3.5 m
// columns would still visually overlap. Pure - no THREE, no track state.
export const GRID = { firstBackM: 7, rowM: 9, colM: 5, maxSlots: 8 };
export function gridOffsets(slot) {
  const s = Math.max(0, Math.min(GRID.maxSlots - 1, Math.floor(Number.isFinite(slot) ? slot : 0)));
  const row = s >> 1, col = s & 1;
  // lateral: + = left of travel (same sign convention as startPose's `lateral`).
  return { slot: s, back: GRID.firstBackM + row * GRID.rowM, lateral: (col === 0 ? -1 : 1) * GRID.colM / 2 };
}

const Y_UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Procedural textures (no external files => nothing to fail on venue wifi)
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function checkerTexture(cols = 12, rows = 3) {
  const c = makeCanvas(cols * 16, rows * 16);
  const g = c.getContext("2d");
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    g.fillStyle = (x + y) % 2 ? "#111111" : "#f4f4f4";
    g.fillRect(x * 16, y * 16, 16, 16);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// ---------------------------------------------------------------------------
/**
 * Build a track from its data. Adds the group (and, until the theme system takes over, the sky,
 * lights and fog) to `scene`, adds the physics ground + wall colliders to `world`, and returns the
 * helper object every consumer uses. dispose() undoes ALL of it.
 */
export function buildTrack(id, world, scene) {
  const T = getTrack(id);
  const cfg = { ...TRACK_CONFIG, width: T.width, laps: T.laps, checkpoints: T.checkpointCount,
                samples: T.samples, bounds: T.groundHalf };
  const hw = cfg.width / 2;
  const theme = getTheme(T.themeId);
  const seed = hashString(T.id);
  const group = new THREE.Group();
  group.name = "track";
  const physicsBodies = [];

  // --- Centreline curve -----------------------------------------------------
  const curve = new THREE.CatmullRomCurve3(
    T.controlPoints.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    "centripetal"
  );
  const length = curve.getLength();

  // Samples along the curve with tangents + left normals.
  const N = cfg.samples;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u).normalize();
    const n = new THREE.Vector3().crossVectors(Y_UP, t).normalize(); // left of travel
    samples.push({ u, p, t, n, yaw: Math.atan2(-t.z, t.x) });
  }

  // --- Ground ---------------------------------------------------------------
  // Track bounding box -> ground rectangle. Track 1 keeps its original square (groundHalf); the other
  // tracks use the bbox plus a per-track margin.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of samples) { minX = Math.min(minX, s.p.x); maxX = Math.max(maxX, s.p.x); minZ = Math.min(minZ, s.p.z); maxZ = Math.max(maxZ, s.p.z); }
  const groundRect = T.groundMargin != null
    ? { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: (maxX - minX) + 2 * T.groundMargin, h: (maxZ - minZ) + 2 * T.groundMargin }
    : { cx: 0, cz: 0, w: cfg.bounds * 2, h: cfg.bounds * 2 };
  const GROUND_TILE_M = 1496 / 90; // texture tile size (Track 1: 90 repeats over 1496 m)
  const groundTex = makeGroundTexture(theme, seed);
  groundTex.repeat.set(Math.round(groundRect.w / GROUND_TILE_M * 1000) / 1000, Math.round(groundRect.h / GROUND_TILE_M * 1000) / 1000);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundRect.w, groundRect.h),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: theme.ground.roughness, metalness: theme.ground.metalness })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(groundRect.cx, 0, groundRect.cz);
  ground.receiveShadow = true;
  group.add(ground);

  // physics ground plane
  const groundBody = new CANNON.Body({ mass: 0 });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);
  physicsBodies.push(groundBody);

  // --- Road ribbon ----------------------------------------------------------
  {
    const rows = N + 1;
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const nrm = new Float32Array(rows * 2 * 3);
    const idx = [];
    let dist = 0;
    for (let i = 0; i <= N; i++) {
      const s = samples[i % N];
      if (i > 0) dist += s.p.distanceTo(samples[(i - 1) % N].p);
      const L = s.p.clone().addScaledVector(s.n, hw);
      const R = s.p.clone().addScaledVector(s.n, -hw);
      const v = dist / 12; // one texture tile per 12 m
      pos.set([L.x, 0.02, L.z], i * 6);
      pos.set([R.x, 0.02, R.z], i * 6 + 3);
      uv.set([0, v, 1, v], i * 4);
      nrm.set([0, 1, 0, 0, 1, 0], i * 6);
      if (i < N) {
        const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    const road = new THREE.Mesh(geo, makeRoadMaterial(theme, seed + 1));
    road.receiveShadow = true;
    road.name = "road";
    group.add(road);
  }

  // --- Curbs (instanced, alternating red/white) -----------------------------
  {
    const geo = new THREE.BoxGeometry(cfg.curbSpacing * 0.98, 0.14, 0.9 * SCALE);
    const count = Math.floor(length / cfg.curbSpacing);
    const red = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: theme.kerb[0], roughness: 0.6 }), count);
    const white = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: theme.kerb[1], roughness: 0.6 }), count);
    const m = new THREE.Matrix4();
    let ri = 0, wi = 0;
    for (let k = 0; k < count; k++) {
      const s = sampleAt(k * cfg.curbSpacing / length);
      for (const side of [1, -1]) {
        const p = s.p.clone().addScaledVector(s.n, side * (hw + 0.45));
        m.makeRotationY(s.yaw);
        m.setPosition(p.x, 0.07, p.z);
        const isRed = ((k + (side > 0 ? 0 : 1)) % 2) === 0;
        if (isRed) red.setMatrixAt(ri++, m); else white.setMatrixAt(wi++, m);
      }
    }
    red.count = ri; white.count = wi;
    red.castShadow = white.castShadow = true;
    red.receiveShadow = white.receiveShadow = true;
    group.add(red, white);
  }

  // --- Barriers (instanced + static physics boxes) ---------------------------
  // One wall segment per centreline sample pair on each side, laid along the WALL LINE itself
  // (the centreline offset by hw + barrierOffset), not on a fixed 8.8 m centreline grid. The old
  // fixed spacing + fixed 14 m collider left holes on the OUTSIDE of tight corners, where the wall
  // line is much longer than the centreline (e.g. R=32 m: wall segments 17 m apart, colliders 14 m).
  // Each collider overlaps its neighbours by BARRIER_OVERLAP at both ends, is BARRIER_COLL_T thick
  // extending OUTWARD (its inner face lies on the visible wall's inner face) and is tall enough
  // that a car can't hop it.
  {
    const BARRIER_OVERLAP = 1.5;   // m beyond each segment end
    const BARRIER_COLL_T = 2.2;    // m thick, extending away from the track
    const BARRIER_COLL_H = 8;      // m tall (invisible)
    const VIS_T = 0.45;
    const OFF = hw + cfg.barrierOffset;
    const geo = new THREE.BoxGeometry(1, 1.0, VIS_T); // unit length, scaled per instance
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: theme.barrier.roughness }), N * 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
    const cWhite = new THREE.Color(theme.barrier.white), cRed = new THREE.Color(theme.barrier.a), cBlue = new THREE.Color(theme.barrier.b);
    let count = 0;
    // ALL wall segments are shapes of ONE static compound body. cannon keeps an O(n^2) collision
    // matrix (and a per-step broadphase sweep) over every body in the world: 840 separate wall
    // bodies made each physics step ~6x slower than the old 424. As one body the world has 3 bodies
    // and the narrowphase only walks the segment shapes near the chassis.
    const wallBody = new CANNON.Body({ mass: 0 });
    const yAxisC = new CANNON.Vec3(0, 1, 0);
    for (const side of [1, -1]) {
      for (let i = 0; i < N; i++) {
        const a = samples[i], c = samples[(i + 1) % N];
        const ax = a.p.x + a.n.x * side * OFF, az = a.p.z + a.n.z * side * OFF;
        const cx = c.p.x + c.n.x * side * OFF, cz = c.p.z + c.n.z * side * OFF;
        const dx = cx - ax, dz = cz - az;
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        const yaw = Math.atan2(-dz, dx);
        const mx = (ax + cx) / 2, mz = (az + cz) / 2;
        // outward = away from the track, perpendicular to this segment (flipped if a tight inner
        // corner reverses the segment's direction)
        let ox = dz / len * side, oz = -dx / len * side;
        if (ox * a.n.x * side + oz * a.n.z * side < 0) { ox = -ox; oz = -oz; }

        // visible wall
        q.setFromAxisAngle(yAxis, yaw);
        pos.set(mx, 0.5, mz);
        scl.set(len + 0.3, 1, 1);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(count, m);
        mesh.setColorAt(count, Math.floor(i / 2) % 3 === 0 ? (side > 0 ? cRed : cBlue) : cWhite);
        count++;

        // collider
        const shape = new CANNON.Box(new CANNON.Vec3(len / 2 + BARRIER_OVERLAP, BARRIER_COLL_H / 2, BARRIER_COLL_T / 2));
        const off = BARRIER_COLL_T / 2 - VIS_T / 2;
        wallBody.addShape(
          shape,
          new CANNON.Vec3(mx + ox * off, BARRIER_COLL_H / 2, mz + oz * off),
          new CANNON.Quaternion().setFromAxisAngle(yAxisC, yaw)
        );
      }
    }
    // cannon computes a body's AABB when a shape is added and only refreshes it for bodies that
    // MOVE. The old per-wall bodies were positioned after that, so every wall kept an AABB
    // centred on the origin and the sweep-and-prune broadphase (sorted by AABB) skipped
    // wall/car pairs depending on list order - cars drove through walls "in some places".
    // Compute it explicitly now that the shapes are in place.
    wallBody.updateAABB();
    world.addBody(wallBody);
    physicsBodies.push(wallBody);
    mesh.count = count;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }

  // --- Start / finish line + gates -------------------------------------------
  const checkpoints = [];
  for (let c = 0; c < cfg.checkpoints; c++) {
    const s = sampleAt(T.startT + c / cfg.checkpoints);
    checkpoints.push({ position: s.p.clone(), tangent: s.t.clone(), normal: s.n.clone(), halfWidth: hw + 1.5 });
    // Start/finish gets the big checkered gantry (Task 6) instead of a plain gate.
    group.add(c === 0 ? makeFinishGantry(s, hw) : makeGate(s, hw, false));
  }
  {
    const s = sampleAt(T.startT);
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(3, 0.06, hw * 2),
      new THREE.MeshStandardMaterial({ map: checkerTexture(3, 12), roughness: 0.7 })
    );
    line.rotation.y = s.yaw;
    line.position.set(s.p.x, 0.03, s.p.z);
    line.receiveShadow = true;
    group.add(line);
    group.add(makeGrandstand(s, hw));
  }

  scene.add(group);

  // --- helpers -----------------------------------------------------------------
  function sampleAt(u) {
    u = ((u % 1) + 1) % 1;
    return samples[Math.floor(u * N) % N];
  }

  /** Nearest sample to a world position: { index, dist, sample }. */
  function nearest(pos) {
    let best = Infinity, bi = 0;
    for (let i = 0; i < N; i++) {
      const dx = samples[i].p.x - pos.x, dz = samples[i].p.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    return { index: bi, dist: Math.sqrt(best), sample: samples[bi] };
  }

  /** Pose a few metres behind the start line, facing along the track. */
  function startPose(backOffset = 7, lateral = 0) {
    const s = sampleAt(T.startT);
    const p = s.p.clone().addScaledVector(s.t, -backOffset).addScaledVector(s.n, lateral);
    return { position: p, yaw: s.yaw, tangent: s.t.clone() };
  }

  // --- new-interface helpers ---------------------------------------------------
  /** Tangent at distance `s` metres along the loop (wraps). */
  function tangentAt(s) { return sampleAt(s / length).t; }

  /** Grid slot i behind the start line (2 columns, see gridOffsets): { slot, position, yaw, tangent }. */
  function gridSlot(i) {
    const g = gridOffsets(i);
    const pose = startPose(g.back, g.lateral);
    return { slot: g.slot, position: pose.position, yaw: pose.yaw, tangent: pose.tangent, back: g.back, lateral: g.lateral };
  }

  // Pickups resolved to world space (t = fraction along the loop, same lookup as everything else).
  const pickups = T.pickups.map((pk, i) => {
    const s = sampleAt(pk.t);
    return { id: `${pk.kind}-${i}`, kind: pk.kind, t: pk.t, position: s.p.clone() };
  });

  const bounds = { minX, maxX, minZ, maxZ, groundHalf: cfg.bounds };

  let disposed = false;
  /** Free everything this build created: scene objects, GPU resources, physics bodies. Idempotent. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const b of physicsBodies) { try { world.removeBody(b); } catch (_) { /* already gone */ } }
    scene.remove(group);
    const freed = new Set();
    const freeMaterial = (m) => {
      if (!m || freed.has(m)) return;
      freed.add(m);
      for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture && !freed.has(v)) { freed.add(v); v.dispose(); } }
      m.dispose();
    };
    const freeObject = (o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(freeMaterial);
      if (o.isInstancedMesh) o.dispose();
      if (o.shadow && o.shadow.map) o.shadow.map.dispose();
    };
    group.traverse(freeObject);
  }

  return {
    id: T.id, name: T.name, place: T.place, weatherLabel: T.weatherLabel, themeId: T.themeId,
    difficulty: T.difficulty, laps: T.laps, width: cfg.width, barrierOffset: cfg.barrierOffset,
    group, curve, length, samples, checkpoints, pickups, halfWidth: hw, bounds, groundRect,
    nearest, startPose, sampleAt, tangentAt, gridSlot, dispose,
  };
}

// ---------------------------------------------------------------------------

function makeGate(s, hw, isStart) {
  const g = new THREE.Group();
  const span = hw + 1.6;
  const h = isStart ? 8 : 6.5;
  const pillarMat = new THREE.MeshStandardMaterial({ color: isStart ? 0xf2f2f2 : 0x2b2f3a, roughness: 0.5, metalness: 0.3 });
  const beamMat = isStart
    ? new THREE.MeshStandardMaterial({ map: checkerTexture(24, 2), roughness: 0.6 })
    : new THREE.MeshStandardMaterial({ color: 0xff3b3b, roughness: 0.5, emissive: 0x330000 });
  for (const side of [1, -1]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, h, 10), pillarMat);
    pillar.position.set(side * span, h / 2, 0);
    pillar.castShadow = true;
    g.add(pillar);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.7, isStart ? 1.6 : 0.7, 0.7), beamMat);
  beam.position.y = h;
  beam.castShadow = true;
  g.add(beam);
  g.position.set(s.p.x, 0, s.p.z);
  g.rotation.y = s.yaw + Math.PI / 2; // gate spans across the track
  return g;
}

// ---------------------------------------------------------------------------
// Finish gantry (Task 6): visual only - no physics bodies. Two heavy towers, a tall
// banner (checkered strips + red FINISH band, one canvas texture) and a checkered
// flag on each tower. Deliberately unlike the slim pole-and-beam checkpoint gates.
// ---------------------------------------------------------------------------
function finishBannerTexture() {
  const W = 1024, H = 256, strip = 48;
  const c = makeCanvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = "#c8102e";
  g.fillRect(0, 0, W, H);
  const cell = strip / 2;
  for (let x = 0; x < W / cell; x++) for (let y = 0; y < 2; y++) {
    g.fillStyle = (x + y) % 2 ? "#111111" : "#f4f4f4";
    g.fillRect(x * cell, y * cell, cell, cell);
    g.fillRect(x * cell, H - strip + y * cell, cell, cell);
  }
  g.fillStyle = "#ffffff";
  g.font = "900 130px Orbitron, Impact, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("FINISH", W / 2, H / 2 + 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeFinishGantry(s, hw) {
  const g = new THREE.Group();
  const span = hw + 2.8;
  const towerH = 13;
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x1c1f28, roughness: 0.55, metalness: 0.5 });
  const bannerTex = finishBannerTexture();
  const bannerMat = new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.7 });
  // Back face would read mirrored - same canvas, flipped horizontally.
  const backTex = bannerTex.clone(); backTex.wrapS = THREE.RepeatWrapping; backTex.repeat.x = -1; backTex.offset.x = 1; backTex.needsUpdate = true;
  const bannerBackMat = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.7 });
  const flagMat = new THREE.MeshStandardMaterial({ map: checkerTexture(8, 5), roughness: 0.8, side: THREE.DoubleSide });
  for (const side of [1, -1]) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(1.6, towerH, 1.6), towerMat);
    tower.position.set(side * span, towerH / 2, 0);
    tower.castShadow = true;
    g.add(tower);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2), flagMat);
    flag.position.set(side * span, towerH + 1.1, 0.9);
    flag.rotation.y = Math.PI / 2;
    g.add(flag);
  }
  // Banner faces along the track (both ways): a thin box with the texture on both broad faces.
  const banner = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 1.6, 3.6, 0.5), [towerMat, towerMat, towerMat, towerMat, bannerBackMat, bannerMat]);
  banner.position.y = towerH - 2.2;
  banner.castShadow = true;
  g.add(banner);
  g.position.set(s.p.x, 0, s.p.z);
  g.rotation.y = s.yaw + Math.PI / 2; // spans across the track, same convention as makeGate
  return g;
}

function makeGrandstand(s, hw) {
  const g = new THREE.Group();
  const seat = new THREE.MeshStandardMaterial({ color: 0x3b4152, roughness: 0.8 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xff3b3b, roughness: 0.8 });
  for (let i = 0; i < 4; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(70, 1.2, 3), i % 2 ? stripe : seat);
    step.position.set(10, 0.6 + i * 1.2, -(hw + 9 + i * 3));
    step.castShadow = step.receiveShadow = true;
    g.add(step);
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(72, 0.3, 14), new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 }));
  roof.position.set(10, 8, -(hw + 14));
  roof.castShadow = true;
  g.add(roof);
  for (const x of [-24, 10, 44]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 8, 8), seat);
    post.position.set(x, 4, -(hw + 20));
    g.add(post);
  }
  g.position.set(s.p.x, 0, s.p.z);
  g.rotation.y = s.yaw;
  return g;
}
