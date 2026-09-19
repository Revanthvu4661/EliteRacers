// ============================================================================
// track.js - closed-loop circuit built from a CatmullRom spline.
//
// buildTrack(scene, world) adds to the scene:
//   sky dome, grass ground, asphalt ribbon with lane markings, red/white curbs,
//   barriers (with static physics bodies), trees, start/finish line, gates,
//   a grandstand, and the sun. It returns helpers for lap logic and resets.
//
// Everything visual is data-driven from TRACK_POINTS + TRACK_CONFIG. Change the
// points and the whole circuit (curbs, barriers, gates, colliders) regenerates.
// ============================================================================

import * as THREE from "three";
import * as CANNON from "cannon-es";

// Larger-track pass: TRACK_POINTS and every size below are scaled by SCALE (2.2x,
// within the asked 2-2.5x range) from the original circuit, uniformly - same shape,
// same corner-radii logic (untouched), just bigger. width/barrierOffset/curb size
// scale by the same factor so the road doesn't look like a thread lost in a huge
// landscape at the new scale. bounds + sky radius + fog near/far (see buildTrack
// below) and the camera far-plane (main.js) are scaled by the same factor too, which
// preserves the exact same edge-of-world/fog-falloff ratios the original had -
// whatever was already comfortably hidden stays comfortably hidden at the new size.
const SCALE = 2.2;

export const TRACK_CONFIG = {
  width: Math.round(16 * SCALE),            // road width (m). Widened from 12 originally: even
                         // well-tuned fixed-angle keyboard steering can't exactly track a
                         // continuously-varying curve, so a bit more room for a slightly-off
                         // line before it counts as "off the asphalt" makes normal driving
                         // far more forgiving without touching how the car itself handles.
  laps: 3,
  checkpoints: 4,       // gates spread evenly along the loop (index 0 = start/finish) -
                         // c/checkpoints stays a fraction of the loop, so this stays evenly
                         // distributed automatically as the spline gets bigger.
  samples: 420,         // ribbon resolution (unchanged - not a "size", corner-radii logic
                         // untouched per spec; sampling density scales with the track for free)
  curbSpacing: +(2.6 * SCALE).toFixed(2),     // m between curb blocks
  barrierSpacing: +(4.0 * SCALE).toFixed(2),  // m between barrier segments
  barrierOffset: Math.round(6 * SCALE),  // m from road edge to barrier centre - more grass
                         // shoulder to run through before hitting a hard collision
  treeCount: 260,        // grown for the bigger play area, short of a full area-scale
                         // (170 * SCALE^2 would be ~820) to keep the instanced draw count sane
  bounds: Math.round(340 * SCALE),          // half-size of grass plane
};

// Control points of the centreline (x, z), scaled SCALE x from the original circuit.
// y is 0 everywhere. Closed loop.
export const TRACK_POINTS = [
  [-60, 0], [60, 0], [130, -25], [155, -90], [115, -150], [45, -120],
  [-15, -160], [-100, -140], [-150, -70], [-135, 10], [-105, 32],
].map(([x, z]) => [x * SCALE, z * SCALE]);

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

// Boost pickup spawn points (Task 1): fixed fractions around the loop (u, same
// convention as sampleAt/checkpoints), picked once here rather than randomised per
// frame. Deliberately offset from the checkpoint gates (0, 0.25, 0.5, 0.75) and the
// start/finish grandstand so they don't visually crowd either. Positions are resolved
// to world space by the caller via the built track's own sampleAt(u), not here - this
// module only owns the fixed layout data, same split as TRACK_POINTS/TRACK_CONFIG above.
export const PICKUP_SPAWN_U = [0.08, 0.18, 0.36, 0.58, 0.7, 0.88];

// Repair pickup spawn points (health revision): fewer and spaced apart from both
// the boost spawns above and the checkpoint gates, same fixed-list convention.
export const REPAIR_SPAWN_U = [0.13, 0.47, 0.81];

const Y_UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Procedural textures (no external files => nothing to fail on venue wifi)
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function asphaltTexture() {
  const c = makeCanvas(256, 256);
  const g = c.getContext("2d");
  g.fillStyle = "#3a3c40";
  g.fillRect(0, 0, 256, 256);
  // grain
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // edge lines (u = 0 and 1 are the road edges)
  g.fillStyle = "#e8e8e8";
  g.fillRect(6, 0, 5, 256);
  g.fillRect(245, 0, 5, 256);
  // dashed centre line
  g.fillStyle = "#f2e7b0";
  g.fillRect(125, 20, 6, 110);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function grassTexture() {
  const c = makeCanvas(256, 256);
  const g = c.getContext("2d");
  g.fillStyle = "#4f8a3a";
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = 60 + Math.random() * 60;
    g.fillStyle = `rgb(${v * 0.55 | 0}, ${v + 40 | 0}, ${v * 0.45 | 0})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(90, 90);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
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
// Sky dome: vertex-gradient shader on an inverted sphere.
// ---------------------------------------------------------------------------
function makeSky() {
  const geo = new THREE.SphereGeometry(1400 * SCALE, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x1b3f8f) },
      midColor: { value: new THREE.Color(0x6fa8e6) },
      horizonColor: { value: new THREE.Color(0xdfe9f3) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 midColor; uniform vec3 horizonColor;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        float t = clamp(h, 0.0, 1.0);
        vec3 c = mix(horizonColor, midColor, smoothstep(0.0, 0.25, t));
        c = mix(c, topColor, smoothstep(0.25, 1.0, t));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "sky";
  return mesh;
}

// ---------------------------------------------------------------------------

export function buildTrack(scene, world) {
  const cfg = TRACK_CONFIG;
  const hw = cfg.width / 2;
  const group = new THREE.Group();
  group.name = "track";

  // --- Centreline curve -----------------------------------------------------
  const curve = new THREE.CatmullRomCurve3(
    TRACK_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
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

  // --- Sky + fog + lights ---------------------------------------------------
  scene.add(makeSky());
  scene.background = new THREE.Color(0xdfe9f3);
  scene.fog = new THREE.Fog(0xdfe9f3, 180 * SCALE, 900 * SCALE);

  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x3f6b2a, 0.55));
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
  sun.position.set(60, 110, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 320;
  const S = 60;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  // --- Ground ---------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(cfg.bounds * 2, cfg.bounds * 2),
    new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // physics ground plane
  const groundBody = new CANNON.Body({ mass: 0 });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

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
    const road = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.82, metalness: 0.05, side: THREE.DoubleSide })
    );
    road.receiveShadow = true;
    road.name = "road";
    group.add(road);
  }

  // --- Curbs (instanced, alternating red/white) -----------------------------
  {
    const geo = new THREE.BoxGeometry(cfg.curbSpacing * 0.98, 0.14, 0.9 * SCALE);
    const count = Math.floor(length / cfg.curbSpacing);
    const red = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xd8262a, roughness: 0.6 }), count);
    const white = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }), count);
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
  {
    const segLen = cfg.barrierSpacing * 1.12;
    const collLen = cfg.barrierSpacing * 1.6; // colliders overlap so tight outer curves never open a gap
    const geo = new THREE.BoxGeometry(segLen, 1.0, 0.45);
    const count = Math.floor(length / cfg.barrierSpacing) * 2;
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), count);
    const m = new THREE.Matrix4();
    const cWhite = new THREE.Color(0xf0f0f0), cRed = new THREE.Color(0xd8262a), cBlue = new THREE.Color(0x2a5cd8);
    // Collider is much thicker + taller than the visual wall (offset outward) so a
    // car at 200 km/h can't tunnel through or hop it. Inner face matches the visual.
    const COLL_T = 1.8, COLL_H = 8;
    const shape = new CANNON.Box(new CANNON.Vec3(collLen / 2, COLL_H / 2, COLL_T / 2));
    let i = 0;
    const per = count / 2;
    for (let k = 0; k < per; k++) {
      const s = sampleAt(k * cfg.barrierSpacing / length);
      for (const side of [1, -1]) {
        const p = s.p.clone().addScaledVector(s.n, side * (hw + cfg.barrierOffset));
        m.makeRotationY(s.yaw);
        m.setPosition(p.x, 0.5, p.z);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, k % 3 === 0 ? (side > 0 ? cRed : cBlue) : cWhite);
        i++;
        const body = new CANNON.Body({ mass: 0, shape });
        const pc = p.clone().addScaledVector(s.n, side * (COLL_T / 2 - 0.225));
        body.position.set(pc.x, COLL_H / 2, pc.z);
        body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), s.yaw);
        world.addBody(body);
      }
    }
    mesh.count = i;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }

  // --- Trees (instanced cone + trunk) ----------------------------------------
  {
    const positions = [];
    let tries = 0;
    while (positions.length < cfg.treeCount && tries++ < cfg.treeCount * 40) {
      const x = (Math.random() * 2 - 1) * (cfg.bounds - 20);
      const z = (Math.random() * 2 - 1) * (cfg.bounds - 20);
      const d = distanceToCentreline(x, z);
      if (d < hw + cfg.barrierOffset + 5 || d > 150) continue;
      // keep the start straight clear for the grandstand
      if (x > -70 && x < 70 && z > -30 && z < 30) continue;
      positions.push([x, z]);
    }
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 2.2, 7);
    const crownGeo = new THREE.ConeGeometry(2.4, 6, 7);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }), positions.length);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), positions.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    positions.forEach(([x, z], k) => {
      const sc = 0.8 + Math.random() * 0.8;
      m.makeScale(sc, sc, sc);
      m.setPosition(x, 1.1 * sc, z);
      trunks.setMatrixAt(k, m);
      m.makeScale(sc, sc, sc);
      m.setPosition(x, (2.2 + 3) * sc, z);
      crowns.setMatrixAt(k, m);
      col.setHSL(0.3 + Math.random() * 0.08, 0.5 + Math.random() * 0.2, 0.22 + Math.random() * 0.12);
      crowns.setColorAt(k, col);
    });
    trunks.castShadow = crowns.castShadow = true;
    crowns.receiveShadow = true;
    group.add(trunks, crowns);
  }

  // --- Start / finish line + gates -------------------------------------------
  const checkpoints = [];
  for (let c = 0; c < cfg.checkpoints; c++) {
    const s = sampleAt(c / cfg.checkpoints);
    checkpoints.push({ position: s.p.clone(), tangent: s.t.clone(), normal: s.n.clone(), halfWidth: hw + 1.5 });
    // Start/finish gets the big checkered gantry (Task 6) instead of a plain gate.
    group.add(c === 0 ? makeFinishGantry(s, hw) : makeGate(s, hw, false));
  }
  {
    const s = samples[0];
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

  function distanceToCentreline(x, z) {
    let best = Infinity;
    for (let i = 0; i < N; i += 2) {
      const dx = samples[i].p.x - x, dz = samples[i].p.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
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
    const s = samples[0];
    const p = s.p.clone().addScaledVector(s.t, -backOffset).addScaledVector(s.n, lateral);
    return { position: p, yaw: s.yaw, tangent: s.t.clone() };
  }

  return { group, curve, length, samples, checkpoints, sun, halfWidth: hw, nearest, startPose, sampleAt };
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
