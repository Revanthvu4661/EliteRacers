// ============================================================================
// scenery.js - per-theme scenery + weather particles. All procedural (no asset files).
//
//   buildScenery(themeId, track, scene) -> handle
//     handle.update(dt, camera)   per frame: weather particles follow the camera (no allocation);
//                                 if the average frame time stays above 22 ms for 2 s the particle
//                                 count is halved (once)
//     handle.dispose()            removes everything from the scene and frees geometries, materials,
//                                 textures and instanced meshes
//   disposeScenery(handle)        same as handle.dispose(), null-safe
//
// Everything is created BEFORE the race (during the loading state), uses InstancedMesh /
// merged geometry / one pooled Points|LineSegments per weather type, and adds NO lights: glow is
// additive sprites, lightning lives in themes.js and only modulates existing light values.
// ============================================================================

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getTheme, makeRng, hashString } from "./themes.js?v=75";
import { buildJungleModels } from "./jungle.js?v=75";
import { buildJungleFx } from "./jungle-fx.js?v=75";
import { createTreeAssets, THEME_TREES, TREE_QUALITY, pickQuality, makeWindUniform } from "./trees.js?v=75";

const SLOW_FRAME_S = 0.022;
const SLOW_FOR_S = 2;

function disposeTree(root) {
  const freed = new Set();
  const freeMaterial = (m) => {
    if (!m || freed.has(m)) return;
    freed.add(m);
    for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture && !freed.has(v)) { freed.add(v); v.dispose(); } }
    m.dispose();
  };
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(freeMaterial);
    if (o.isInstancedMesh) o.dispose();
  });
}

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------
function makePlacement(track, rnd) {
  const S = track.samples;
  const wall = track.halfWidth + track.barrierOffset;
  const start = track.startPose(0).position;
  const g = track.groundRect;
  /** distance from (x,z) to the centreline (every 2nd sample is plenty for placement) */
  function centreDist(x, z) {
    let best = Infinity;
    for (let i = 0; i < S.length; i += 2) {
      const dx = S[i].p.x - x, dz = S[i].p.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  const nearStart = (x, z, r = 95) => Math.hypot(x - start.x, z - start.z) < r;
  /** random point inside the ground rectangle (with a margin) */
  const randomPoint = (margin = 20) => [
    g.cx + (rnd() * 2 - 1) * (g.w / 2 - margin),
    g.cz + (rnd() * 2 - 1) * (g.h / 2 - margin),
  ];
  return { centreDist, nearStart, randomPoint, wall, start, g };
}

function instanced(geo, mat, count, group, shadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  m.castShadow = shadow;
  m.receiveShadow = true;
  m.frustumCulled = false; // instances are spread over the whole map; one cull box would be huge anyway
  group.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// Scenery sets
// ---------------------------------------------------------------------------
// Original Green Valley trees (cone crown + trunk), seeded instead of Math.random. Kept reachable
// through ?trees=old (see buildScenery) until the new trees are approved; not otherwise called.
function buildTreesOld(group, track, rnd, P) {
  const target = 260;
  const positions = [];
  let tries = 0;
  while (positions.length < target && tries++ < target * 40) {
    const [x, z] = P.randomPoint(20);
    const d = P.centreDist(x, z);
    if (d < P.wall + 5 || d > 150) continue;
    if (P.nearStart(x, z, 80)) continue; // keep the start straight clear for the grandstand
    positions.push([x, z]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 2.2, 7);
  const crownGeo = new THREE.ConeGeometry(2.4, 6, 7);
  const trunks = instanced(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 1 }), positions.length, group);
  const crowns = instanced(crownGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), positions.length, group);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  positions.forEach(([x, z], k) => {
    const sc = 0.8 + rnd() * 0.8;
    m.makeScale(sc, sc, sc); m.setPosition(x, 1.1 * sc, z); trunks.setMatrixAt(k, m);
    m.makeScale(sc, sc, sc); m.setPosition(x, (2.2 + 3) * sc, z); crowns.setMatrixAt(k, m);
    col.setHSL(0.3 + rnd() * 0.08, 0.5 + rnd() * 0.2, 0.22 + rnd() * 0.12);
    crowns.setColorAt(k, col);
  });
  trunks.count = crowns.count = positions.length;
}

// ---------------------------------------------------------------------------
// New procedural trees (trees.js), T2: seeded clump placement with exclusion zones, chunked into
// ~60 m spatial cells along the track's arc length. Each chunk is ONE (species, variant) - a
// clump can straddle a chunk boundary and show two species where it does, which is both what a
// real tree line looks like and the thing that keeps the mesh count, and so the draw-call count,
// bounded by construction: exactly one InstancedMesh per (chunk, LOD), never per (chunk, clump).
//
//   MAX_TREE_MESHES   caps chunk count so 2 draw calls/mesh (bark+leaf) * meshes <= the 60 budget
//   NEAR_M / FAR_M     the lateral band trees are allowed in, off the track centreline
//   EXCLUDE_*          keep-clear radii around the start line and every checkpoint/pickup
//
// LOD: all 3 LOD tiers are built and added (hidden) for every chunk at load time; handle.update()
// throttles to a pick every CHUNK_UPDATE_MS and only toggles .visible - no allocation, no
// creation/removal during the race. 10% hysteresis stops a chunk flickering between two LODs
// when the camera sits near a threshold.
// ---------------------------------------------------------------------------
const MAX_TREE_MESHES = 29;      // *2 draw calls (bark+leaf) = 58, under the 60-call budget
const CHUNK_UPDATE_MS = 250;
const LOD_HYSTERESIS = 0.10;
const EXCLUDE_START_M = 40;      // first/last 40 m around the start line
const EXCLUDE_POINT_M = 15;      // checkpoints, pickups (the gantry/grandstand sit AT the start
                                  // line's checkpoint, already covered by EXCLUDE_START_M)

function buildTreesNew(group, track, rnd, P, theme, quality) {
  // One shared wind-time uniform for every tree material this build creates (bark and leaf,
  // every species) - updated once per frame in update() below, never reallocated.
  const windTime = makeWindUniform();
  const assets = createTreeAssets(theme.id, quality.id, hashString(track.id) + 3, windTime);
  const mix = THEME_TREES[theme.id] || [];
  if (!mix.length || !assets.variants.length) return { assets, update() {}, dispose() {}, debug: null };

  // --- exclusion zones ---------------------------------------------------------
  const excludeCircles = []; // {x, z, r}
  for (const cp of track.checkpoints) excludeCircles.push({ x: cp.position.x, z: cp.position.z, r: EXCLUDE_POINT_M });
  for (const pk of track.pickups) excludeCircles.push({ x: pk.position.x, z: pk.position.z, r: EXCLUDE_POINT_M });
  function excluded(x, z) {
    if (Math.hypot(x - P.start.x, z - P.start.z) < EXCLUDE_START_M) return true;
    for (const e of excludeCircles) { const dx = x - e.x, dz = z - e.z; if (dx * dx + dz * dz < e.r * e.r) return true; }
    return false;
  }

  // --- lateral band --------------------------------------------------------------
  // "halfWidth + kerb + 6 m" is read here as the WALL line (P.wall = halfWidth + barrierOffset)
  // plus a 6 m clearance margin, not the ~1 m painted kerb strip itself - the literal kerb sits
  // INSIDE the barrier, so anchoring to it would let trees spawn between the kerb and the wall
  // (i.e. visually inside/through the barrier). Conservative reading, noted per the brief.
  const NEAR_M = P.wall + 6;
  const FAR_M = 80;

  // --- deterministic weighted species pick, then a uniform pick within that species' variants --
  function pickVariant(u1, u2) {
    let acc = 0, sid = mix[mix.length - 1][0];
    for (const [s, w] of mix) { acc += w; if (u1 < acc) { sid = s; break; } }
    const vs = assets.variants.filter((v) => v.species === sid);
    return vs.length ? vs[(u2 * vs.length) | 0] : null;
  }

  // --- chunk the track's arc length, sized so mesh count never exceeds the draw-call budget ----
  const L = track.length, S = track.samples, N = S.length;
  const chunkSize = Math.max(60, L / MAX_TREE_MESHES);
  const chunkCount = Math.min(MAX_TREE_MESHES, Math.max(1, Math.round(L / chunkSize)));
  const chunkLen = L / chunkCount;
  const chunkVariant = [];
  for (let i = 0; i < chunkCount; i++) chunkVariant.push(pickVariant(rnd(), rnd()));

  // --- clump placement along arc length: jittered strides, each either a clump or a clearing ---
  const target = quality.count;
  const placed = []; // {x, z, chunkIdx, scale, yaw, tiltAngle, tiltDir}
  let arc = rnd() * 20, guard = 0;
  while (arc < L && placed.length < target * 1.3 && guard++ < 40000) {
    const stride = 14 + rnd() * 16;
    arc += stride;
    if (rnd() < 0.22) continue; // a clearing: this stride gets no clump at all

    const u = ((arc / L) % 1 + 1) % 1;
    const si = Math.floor(u * N) % N;
    const s = S[si];
    const ci = Math.min(chunkCount - 1, Math.floor(arc / chunkLen) % chunkCount);
    if (!chunkVariant[ci]) continue;
    const side = rnd() < 0.5 ? 1 : -1;
    const clumpLat = NEAR_M + rnd() * (FAR_M - NEAR_M) * 0.7; // biased toward the near half
    const clumpSize = 3 + ((rnd() * 6) | 0);

    for (let k = 0; k < clumpSize && placed.length < target * 1.3; k++) {
      const lat = clumpLat + (rnd() - 0.5) * 14;
      if (lat < NEAR_M || lat > FAR_M) continue;
      const along = (rnd() - 0.5) * 16;
      const x = s.p.x + s.n.x * side * lat + s.t.x * along;
      const z = s.p.z + s.n.z * side * lat + s.t.z * along;
      if (excluded(x, z)) continue;
      // s.n is only exact for a locally straight stretch; re-check the REAL distance to the
      // centreline (P.centreDist, authoritative) rather than trust the offset arithmetic alone.
      const d = P.centreDist(x, z);
      if (d < NEAR_M - 3 || d > FAR_M + 10) continue;
      const along2 = arc + along; // this tree's own arc position (clump centre's arc +- jitter)
      const kc = Math.min(chunkCount - 1, Math.floor((((along2 % L) + L) % L) / chunkLen));
      placed.push({
        x, z, chunkIdx: kc,
        scale: 0.8 + rnd() * 0.6, yaw: rnd() * Math.PI * 2,
        tiltAngle: rnd() * (3 * Math.PI / 180), tiltDir: rnd() * Math.PI * 2,
      });
    }
  }

  // --- build 3 LOD InstancedMeshes per non-empty chunk (all hidden; the LOD pass below turns
  //     the right tier on). Manual bounding sphere per mesh (not the shared geometry's - that
  //     would apply one chunk's bounds to every other chunk reusing the same variant/LOD
  //     geometry) is what makes frustumCulled=true correct for a shared-geometry InstancedMesh:
  //     three.js's Frustum.intersectsObject checks object.boundingSphere before falling back to
  //     the geometry's. ------------------------------------------------------------------------
  const byChunk = new Map();
  for (const p of placed) { let a = byChunk.get(p.chunkIdx); if (!a) byChunk.set(p.chunkIdx, a = []); a.push(p); }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const tiltAxis = new THREE.Vector3(), yUp = new THREE.Vector3(0, 1, 0), yawQ = new THREE.Quaternion();
  const col = new THREE.Color(), sphereCentre = new THREE.Vector3();
  const chunks = [];
  let totalMeshes = 0;
  for (const [ci, items] of byChunk) {
    const variant = chunkVariant[ci];
    if (!variant || !items.length) continue;
    sphereCentre.set(0, 0, 0);
    for (const it of items) sphereCentre.add(new THREE.Vector3(it.x, 0, it.z));
    sphereCentre.multiplyScalar(1 / items.length);
    let maxDist = 0;
    for (const it of items) maxDist = Math.max(maxDist, Math.hypot(it.x - sphereCentre.x, it.z - sphereCentre.z));
    const treeExtent = variant.height * 1.4 * 0.75; // instance scale tops out at 1.4x; a generous radius, not a tight fit
    const sphere = new THREE.Sphere(new THREE.Vector3(sphereCentre.x, treeExtent, sphereCentre.z), maxDist + treeExtent);

    const lodMeshes = [];
    for (let lod = 0; lod < 3; lod++) {
      const mesh = new THREE.InstancedMesh(variant.lods[lod].geometry, variant.materials, items.length);
      items.forEach((it, i) => {
        tiltAxis.set(Math.cos(it.tiltDir), 0, Math.sin(it.tiltDir));
        q.setFromAxisAngle(tiltAxis, it.tiltAngle);
        yawQ.setFromAxisAngle(yUp, it.yaw);
        q.multiply(yawQ);
        pos.set(it.x, 0, it.z);
        scl.set(it.scale, it.scale, it.scale);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        col.setHSL(0.32 + (rnd() - 0.5) * 0.05, 0.45 + rnd() * 0.15, 0.42 + (rnd() - 0.5) * 0.12);
        mesh.setColorAt(i, col);
      });
      mesh.count = items.length;
      // No shadows from trees (see file header): the sun's shadow camera only spans ~60 m around
      // the car, and the old cone trees spent most of their frame cost in that pass for shadows
      // almost never on screen.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.boundingSphere = sphere.clone();
      mesh.frustumCulled = true;
      mesh.visible = false;
      mesh.name = "tree-c" + ci + "-" + variant.species + "v" + variant.index + "-L" + lod;
      group.add(mesh);
      lodMeshes.push(mesh);
      totalMeshes++;
    }
    chunks.push({ idx: ci, center: sphereCentre.clone(), lodMeshes, activeLod: -1, count: items.length });
  }

  // --- ground contact: ONE InstancedMesh of soft radial-gradient decals, one draw call, flat on
  //     the ground at every tree's base. No real shadows (see file header) - this is what sells
  //     "planted" instead. Scaled to roughly the crown radius so it reads as a soft footprint,
  //     not a spotlight. --------------------------------------------------------------------
  if (placed.length && assets.contactMaterial) {
    const decalGeo = new THREE.CircleGeometry(1, 10);
    decalGeo.rotateX(-Math.PI / 2);
    const decals = new THREE.InstancedMesh(decalGeo, assets.contactMaterial, placed.length);
    placed.forEach((p, i) => {
      const variant = chunkVariant[p.chunkIdx];
      const r = (variant ? variant.height : 10) * p.scale * 0.32;
      m.makeScale(r, 1, r);
      m.setPosition(p.x, 0.03, p.z);
      decals.setMatrixAt(i, m);
    });
    decals.count = placed.length;
    decals.castShadow = false;
    decals.receiveShadow = false;
    decals.frustumCulled = false; // spread the same way the old flat scenery sets are
    decals.name = "tree-contact-decals";
    group.add(decals);
  }

  // --- per-frame (throttled) LOD selection: distance-only, 10% hysteresis, visibility toggle
  //     only - no allocation. ----------------------------------------------------------------
  let acc = 0;
  const camXZ = new THREE.Vector2();
  function pickLod(dist, cur) {
    const b0 = quality.lod0, b1 = quality.lod1, far = quality.far;
    if (cur === 0) { if (dist > b0 * (1 + LOD_HYSTERESIS)) cur = dist > b1 * (1 + LOD_HYSTERESIS) ? (dist > far ? -1 : 2) : 1; }
    else if (cur === 1) {
      if (dist < b0 * (1 - LOD_HYSTERESIS)) cur = 0;
      else if (dist > b1 * (1 + LOD_HYSTERESIS)) cur = dist > far ? -1 : 2;
    } else if (cur === 2) {
      if (dist > far) cur = -1;
      else if (dist < b1 * (1 - LOD_HYSTERESIS)) cur = dist < b0 * (1 - LOD_HYSTERESIS) ? 0 : 1;
    } else { // cur === -1 (hidden): re-enter at whichever tier this distance belongs to
      cur = dist > far ? -1 : dist > b1 ? 2 : dist > b0 ? 1 : 0;
    }
    return cur;
  }
  // Adaptive budget (mirrors createWeather's particle-halving below): if the average frame time
  // stays above 22 ms for 2 s, the farthest CURRENTLY VISIBLE chunk is hidden outright, at most
  // one change every 3 s so it cannot chase a noisy frame time back and forth. Never un-hides -
  // matching the brief ("hide the farthest chunks first"), a hidden chunk only returns when the
  // camera gets close enough to re-enter it through the normal LOD pass.
  let avgMs = 16, slowForMs = 0, lastCutAt = -Infinity, nowMs = 0;
  function adaptiveCut(camera) {
    let farthestChunk = null, farthestDist = -1;
    for (const c of chunks) {
      if (c.activeLod < 0) continue;
      const dist = Math.hypot(c.center.x - camXZ.x, c.center.z - camXZ.y);
      if (dist > farthestDist) { farthestDist = dist; farthestChunk = c; }
    }
    if (!farthestChunk) return;
    farthestChunk.lodMeshes[farthestChunk.activeLod].visible = false;
    farthestChunk.activeLod = -1;
    farthestChunk.cut = true; // stays hidden until the camera's own distance re-enters it naturally
    lastCutAt = nowMs;
  }
  function updateLods(camera, dtMs) {
    nowMs += dtMs;
    camXZ.set(camera.position.x, camera.position.z);
    for (const c of chunks) {
      const dist = Math.hypot(c.center.x - camXZ.x, c.center.z - camXZ.y);
      const next = pickLod(dist, c.activeLod);
      if (next === c.activeLod) continue;
      if (c.activeLod >= 0) c.lodMeshes[c.activeLod].visible = false;
      if (next >= 0) c.lodMeshes[next].visible = true;
      c.activeLod = next;
    }
    avgMs = avgMs * 0.9 + dtMs * 0.1;
    slowForMs = avgMs > 22 ? slowForMs + dtMs : 0;
    if (slowForMs >= 2000 && nowMs - lastCutAt >= 3000) { adaptiveCut(camera); slowForMs = 0; }
  }

  return {
    assets,
    update(dt, camera) {
      // Wind sways every frame (it would visibly stutter throttled to 250ms); LOD/adaptive-budget
      // only needs to react at human timescales.
      windTime.value += dt;
      acc += dt * 1000;
      if (acc < CHUNK_UPDATE_MS) return;
      const elapsedMs = acc; acc = 0;
      updateLods(camera, elapsedMs);
    },
    // Dev-only hook (harmless if never called): _dev/ scripts read this to verify placement -
    // every instance clear of the centreline by the briefed margin and of every exclusion zone.
    debug: { placed, chunks, NEAR_M, FAR_M, EXCLUDE_START_M, EXCLUDE_POINT_M, totalMeshes, chunkCount },
  };
}

function buildMesa(group, track, rnd, P) {
  const rust = [0xb5522b, 0xc9683a, 0xa8462a, 0xd0824a, 0x9c4a2e];
  const col = new THREE.Color(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  // Flat-topped mesas: a wide tapered base + a narrower cap, merged into one geometry.
  const base = new THREE.CylinderGeometry(0.86, 1, 0.62, 7, 1);
  base.translate(0, 0.31, 0);
  const cap = new THREE.CylinderGeometry(0.72, 0.84, 0.4, 7, 1);
  cap.translate(0, 0.82, 0);
  const mesaGeo = mergeGeometries([base, cap]);
  base.dispose(); cap.dispose();
  const mesaCount = 34;
  const mesas = instanced(mesaGeo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), mesaCount, group);
  let n = 0, tries = 0;
  while (n < mesaCount && tries++ < 4000) {
    const [x, z] = P.randomPoint(30);
    const d = P.centreDist(x, z);
    if (d < 170 || d > 900) continue;
    const w = 30 + rnd() * 90, h = 24 + rnd() * 80;
    q.setFromAxisAngle(yAxis, rnd() * Math.PI);
    pos.set(x, 0, z); scl.set(w, h, w * (0.7 + rnd() * 0.5));
    m.compose(pos, q, scl);
    mesas.setMatrixAt(n, m);
    col.setHex(rust[(rnd() * rust.length) | 0]).offsetHSL(0, 0, (rnd() - 0.5) * 0.06);
    mesas.setColorAt(n, col);
    n++;
  }
  mesas.count = n;

  // Rock spires
  const spireGeo = new THREE.CylinderGeometry(0.22, 0.6, 1, 6, 1);
  spireGeo.translate(0, 0.5, 0);
  const spireCount = 16;
  const spires = instanced(spireGeo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), spireCount, group);
  n = 0; tries = 0;
  while (n < spireCount && tries++ < 3000) {
    const [x, z] = P.randomPoint(30);
    const d = P.centreDist(x, z);
    if (d < 110 || d > 700) continue;
    const w = 8 + rnd() * 16, h = 40 + rnd() * 70;
    q.setFromAxisAngle(yAxis, rnd() * Math.PI);
    pos.set(x, 0, z); scl.set(w, h, w);
    m.compose(pos, q, scl);
    spires.setMatrixAt(n, m);
    spires.setColorAt(n, col.setHex(rust[(rnd() * rust.length) | 0]));
    n++;
  }
  spires.count = n;

  // Low rocks near the road
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rockCount = 230;
  const rocks = instanced(rockGeo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), rockCount, group);
  n = 0; tries = 0;
  while (n < rockCount && tries++ < 6000) {
    const [x, z] = P.randomPoint(30);
    const d = P.centreDist(x, z);
    if (d < P.wall + 6 || d > P.wall + 110) continue;
    if (P.nearStart(x, z, 70)) continue;
    const s = 0.9 + rnd() * 3.4;
    q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
    pos.set(x, s * 0.35, z); scl.set(s * (0.8 + rnd() * 0.6), s * (0.5 + rnd() * 0.5), s * (0.8 + rnd() * 0.6));
    m.compose(pos, q, scl);
    rocks.setMatrixAt(n, m);
    rocks.setColorAt(n, col.setHex(0x8f5a3a).offsetHSL((rnd() - 0.5) * 0.04, 0, (rnd() - 0.5) * 0.14));
    n++;
  }
  rocks.count = n;

  // Saguaro-style cacti (trunk + two arms, merged)
  const trunk = new THREE.CylinderGeometry(0.42, 0.5, 5.2, 7); trunk.translate(0, 2.6, 0);
  const armA = new THREE.CylinderGeometry(0.28, 0.3, 1.5, 6); armA.rotateZ(Math.PI / 2); armA.translate(0.95, 3.2, 0);
  const armAup = new THREE.CylinderGeometry(0.26, 0.28, 1.9, 6); armAup.translate(1.7, 4.05, 0);
  const armB = new THREE.CylinderGeometry(0.28, 0.3, 1.2, 6); armB.rotateZ(Math.PI / 2); armB.translate(-0.8, 2.3, 0);
  const armBup = new THREE.CylinderGeometry(0.26, 0.28, 1.5, 6); armBup.translate(-1.4, 2.95, 0);
  const cactusGeo = mergeGeometries([trunk, armA, armAup, armB, armBup]);
  [trunk, armA, armAup, armB, armBup].forEach((g) => g.dispose());
  const cactusCount = 150;
  const cacti = instanced(cactusGeo, new THREE.MeshStandardMaterial({ color: 0x4d7a3a, roughness: 0.9 }), cactusCount, group);
  n = 0; tries = 0;
  while (n < cactusCount && tries++ < 6000) {
    const [x, z] = P.randomPoint(30);
    const d = P.centreDist(x, z);
    if (d < P.wall + 8 || d > P.wall + 130) continue;
    if (P.nearStart(x, z, 70)) continue;
    const s = 0.8 + rnd() * 0.9;
    q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
    pos.set(x, 0, z); scl.set(s, s * (0.85 + rnd() * 0.4), s);
    m.compose(pos, q, scl);
    cacti.setMatrixAt(n, m);
    cacti.setColorAt(n, col.setHex(0x4d7a3a).offsetHSL((rnd() - 0.5) * 0.05, 0, (rnd() - 0.5) * 0.08));
    n++;
  }
  cacti.count = n;
}

function buildPort(group, track, rnd, P) {
  const col = new THREE.Color(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const g = P.g;

  // Water everywhere beyond the concrete quay (the ground plane is a rectangle around the track).
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000),
    new THREE.MeshStandardMaterial({ color: 0x0b1a33, roughness: 0.1, metalness: 0.75, envMapIntensity: 1.8 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(g.cx, -0.25, g.cz);
  water.receiveShadow = false;
  water.name = "water";
  group.add(water);

  // Container yards: stacks on a 15 m grid away from the track.
  const palette = [0x8b2c2c, 0x2c5a8b, 0x2c7a4f, 0xb8862b, 0x59606b, 0x7a3f8b, 0xa8a29a, 0x9a4b1f];
  const boxGeo = new THREE.BoxGeometry(12, 2.6, 2.5);
  const maxContainers = 460;
  const containers = instanced(boxGeo, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 }), maxContainers, group);
  let n = 0;
  const cell = 15;
  for (let x = g.cx - g.w / 2 + 30; x < g.cx + g.w / 2 - 30 && n < maxContainers; x += cell) {
    for (let z = g.cz - g.h / 2 + 30; z < g.cz + g.h / 2 - 30 && n < maxContainers; z += cell) {
      if (rnd() > 0.34) continue;
      const jx = x + (rnd() - 0.5) * 3, jz = z + (rnd() - 0.5) * 3;
      const d = P.centreDist(jx, jz);
      if (d < P.wall + 14) continue;
      if (P.nearStart(jx, jz, 100)) continue;
      const h = 1 + ((rnd() * 3) | 0); // stack height 1-3
      const rot = rnd() < 0.5 ? 0 : Math.PI / 2;
      col.setHex(palette[(rnd() * palette.length) | 0]);
      for (let k = 0; k < h && n < maxContainers; k++) {
        q.setFromAxisAngle(yAxis, rot);
        pos.set(jx, 1.3 + k * 2.6, jz); scl.set(1, 1, 1);
        m.compose(pos, q, scl);
        containers.setMatrixAt(n, m);
        containers.setColorAt(n, col);
        n++;
      }
    }
  }
  containers.count = n;

  // Quay cranes (merged box frames) near the far edge of the quay.
  const legs = [], addBox = (w, h, d, x, y, z) => { const b = new THREE.BoxGeometry(w, h, d); b.translate(x, y, z); legs.push(b); };
  for (const sx of [-9, 9]) for (const sz of [-6, 6]) addBox(1.6, 34, 1.6, sx, 17, sz);   // four legs
  addBox(22, 1.8, 16, 0, 34, 0);                                                           // portal beam
  addBox(70, 2.6, 3, 14, 36.5, 0);                                                         // boom
  addBox(6, 4, 5, -6, 39, 0);                                                              // cab
  const craneGeo = mergeGeometries(legs);
  legs.forEach((b) => b.dispose());
  const craneCount = 6;
  const cranes = instanced(craneGeo, new THREE.MeshStandardMaterial({ color: 0x38414c, roughness: 0.6, metalness: 0.5 }), craneCount, group);
  for (let i = 0; i < craneCount; i++) {
    const x = g.cx - g.w / 2 + g.w * (0.12 + 0.76 * (i + rnd() * 0.4) / craneCount);
    const z = g.cz + g.h / 2 - 34;
    q.setFromAxisAngle(yAxis, Math.PI / 2 * 0); // booms point toward the water (+z)
    pos.set(x, 0, z); scl.set(1, 1, 1);
    m.compose(pos, q, scl);
    cranes.setMatrixAt(i, m);
    cranes.setColorAt(i, col.setHex(i % 2 ? 0x38414c : 0xb5651d));
  }
  cranes.count = craneCount;

  // Warehouse silhouettes (box + pyramid roof), far from the track.
  const wb = new THREE.BoxGeometry(1, 1, 1); wb.translate(0, 0.5, 0);
  const roof = new THREE.ConeGeometry(0.75, 0.32, 4); roof.rotateY(Math.PI / 4); roof.translate(0, 1.16, 0);
  const whGeo = mergeGeometries([wb, roof]);
  wb.dispose(); roof.dispose();
  const whCount = 10;
  const wh = instanced(whGeo, new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.8, metalness: 0.2 }), whCount, group);
  n = 0;
  for (let tries = 0; n < whCount && tries < 800; tries++) {
    const [x, z] = P.randomPoint(50);
    if (P.centreDist(x, z) < P.wall + 45) continue;
    if (P.nearStart(x, z, 130)) continue;
    const w = 40 + rnd() * 50, d = 22 + rnd() * 20, h = 10 + rnd() * 8;
    q.setFromAxisAngle(yAxis, rnd() < 0.5 ? 0 : Math.PI / 2);
    pos.set(x, 0, z); scl.set(w, h, d);
    m.compose(pos, q, scl);
    wh.setMatrixAt(n, m);
    wh.setColorAt(n, col.setHex(0x232a33).offsetHSL(0, 0, (rnd() - 0.5) * 0.05));
    n++;
  }
  wh.count = n;

  // Lamp posts just outside the barriers: emissive heads + additive glow sprites (NO lights).
  const S = track.samples;
  const ds = track.length / S.length;
  const step = Math.max(2, Math.round(58 / ds));
  const lampPositions = [];
  const off = P.wall + 3.2;
  for (let i = 0; i < S.length; i += step) {
    for (const side of [1, -1]) {
      const s = S[i];
      lampPositions.push([s.p.x + s.n.x * side * off, s.p.z + s.n.z * side * off, side]);
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.22, 0.3, 11, 6); poleGeo.translate(0, 5.5, 0);
  const poles = instanced(poleGeo, new THREE.MeshStandardMaterial({ color: 0x252b33, roughness: 0.7, metalness: 0.5 }), lampPositions.length, group, false);
  const headGeo = new THREE.BoxGeometry(1.5, 0.35, 0.8); headGeo.translate(0, 11.2, 0);
  const heads = instanced(headGeo, new THREE.MeshBasicMaterial({ color: 0xffe2a4 }), lampPositions.length, group, false);
  const glowPos = new Float32Array(lampPositions.length * 3);
  lampPositions.forEach(([x, z], k) => {
    m.makeTranslation(x, 0, z);
    poles.setMatrixAt(k, m); heads.setMatrixAt(k, m);
    glowPos.set([x, 11.1, z], k * 3);
  });
  poles.count = heads.count = lampPositions.length;
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPos, 3));
  const glow = new THREE.Points(glowGeo, new THREE.PointsMaterial({
    map: glowTexture(), color: 0xffd08a, size: 15, sizeAttenuation: true, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.frustumCulled = false;
  glow.name = "lamp-glow";
  group.add(glow);
}

// ---------------------------------------------------------------------------
// Weather (one pooled system per theme, fixed area around the camera)
// ---------------------------------------------------------------------------
function createWeather(theme, group) {
  const P = theme.particles;
  if (!P) return null;
  const rnd = makeRng(hashString(theme.id) + 7);
  const N = P.count;
  const R = P.area;
  let obj, positions, update, drawScale = 1, setDraw;

  if (P.type === "rain") {
    const H = 40, LEN = 2.2, WIND = 0.28;
    const base = new Float32Array(N * 3);       // drop head position, camera-relative
    positions = new Float32Array(N * 6);        // 2 vertices per streak
    for (let i = 0; i < N; i++) { base[i * 3] = (rnd() * 2 - 1) * R; base[i * 3 + 1] = rnd() * H; base[i * 3 + 2] = (rnd() * 2 - 1) * R; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    obj = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xb4c8e0, transparent: true, opacity: 0.42, depthWrite: false }));
    setDraw = (frac) => geo.setDrawRange(0, Math.max(2, Math.floor(N * frac) * 2));
    update = (dt) => {
      const fall = P.speed * dt;
      for (let i = 0; i < N; i++) {
        let y = base[i * 3 + 1] - fall;
        if (y < 0) { y += H; base[i * 3] = (rnd() * 2 - 1) * R; base[i * 3 + 2] = (rnd() * 2 - 1) * R; }
        base[i * 3 + 1] = y;
        const x = base[i * 3], z = base[i * 3 + 2], k = i * 6;
        positions[k] = x; positions[k + 1] = y; positions[k + 2] = z;
        positions[k + 3] = x + WIND * LEN; positions[k + 4] = y + LEN; positions[k + 5] = z;
      }
      geo.attributes.position.needsUpdate = true;
    };
  } else { // dust
    const H = 16;
    const base = new Float32Array(N * 3);
    positions = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    for (let i = 0; i < N; i++) { base[i * 3] = (rnd() * 2 - 1) * R; base[i * 3 + 1] = 0.5 + rnd() * H; base[i * 3 + 2] = (rnd() * 2 - 1) * R; phase[i] = rnd() * 6.28; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    obj = new THREE.Points(geo, new THREE.PointsMaterial({
      map: glowTexture(), color: 0xe6b880, size: 9, sizeAttenuation: true, transparent: true, opacity: 0.2, depthWrite: false,
    }));
    setDraw = (frac) => geo.setDrawRange(0, Math.max(1, Math.floor(N * frac)));
    let t = 0;
    update = (dt) => {
      t += dt;
      const dx = P.speed * dt;
      for (let i = 0; i < N; i++) {
        let x = base[i * 3] + dx;
        if (x > R) x -= 2 * R;
        base[i * 3] = x;
        positions[i * 3] = x;
        positions[i * 3 + 1] = base[i * 3 + 1] + Math.sin(t * 0.5 + phase[i]) * 0.8;
        positions[i * 3 + 2] = base[i * 3 + 2] + Math.cos(t * 0.35 + phase[i]) * 1.2;
      }
      geo.attributes.position.needsUpdate = true;
    };
  }
  obj.frustumCulled = false;
  obj.name = "weather-" + P.type;
  group.add(obj);
  setDraw(1);

  let avg = 1 / 60, slowFor = 0, halved = false;
  return {
    obj,
    get halved() { return halved; },
    step(dt, camera) {
      // adaptive budget: sustained slow frames => halve the particle count (once)
      avg = avg * 0.95 + dt * 0.05;
      if (!halved) {
        slowFor = avg > SLOW_FRAME_S ? slowFor + dt : 0;
        if (slowFor >= SLOW_FOR_S) { halved = true; drawScale = 0.5; setDraw(0.5); }
      }
      // follow the camera (rain spans y 0..H above the ground, so only x/z follow)
      obj.position.set(camera.position.x, 0, camera.position.z);
      update(dt);
    },
  };
}

// ---------------------------------------------------------------------------

// ?trees=old keeps the original cone trees reachable for comparison; default (no param, or any
// other value) is the new procedural trees. Read once per build, not cached, so a track change
// picks up a URL edit without a full page reload.
function treesWanted() {
  try { return new URLSearchParams(location.search).get("trees") !== "old"; }
  catch (_) { return true; }
}

export function buildScenery(themeId, track, scene) {
  const theme = getTheme(themeId);
  const group = new THREE.Group();
  group.name = "scenery-" + theme.id;
  const rnd = makeRng(hashString(track.id) + 1);
  const P = makePlacement(track, rnd);
  let treeAssets = null, treesHandle = null, jungleHandle = null, fxHandle = null;
  if (theme.sceneryId === "trees") {
    if (treesWanted()) {
      const qualityId = pickQuality();
      const quality = Object.assign({ id: qualityId }, TREE_QUALITY[qualityId] || TREE_QUALITY.high);
      treesHandle = buildTreesNew(group, track, rnd, P, theme, quality);
      treeAssets = treesHandle.assets;
      if (theme.id === "jungle") { try { jungleHandle = buildJungleModels(scene, track, rnd, P, qualityId); } catch (err) { console.warn("[jungle] build failed", err); }
        try { fxHandle = buildJungleFx(scene, track, rnd, P, qualityId); } catch (err) { console.warn("[jungle-fx] build failed", err); } }
    } else buildTreesOld(group, track, rnd, P);
  }
  else if (theme.sceneryId === "mesa") buildMesa(group, track, rnd, P);
  else if (theme.sceneryId === "port") buildPort(group, track, rnd, P);
  const weather = createWeather(theme, group);
  scene.add(group);

  let disposed = false;
  return {
    group, weather, themeId: theme.id,
    // Dev-only: _dev/ scripts read this to verify tree placement (never referenced by game code).
    treesDebug: treesHandle && treesHandle.debug,
    get jungle() { return jungleHandle; },
    get fx() { return fxHandle; },
    update(dt, camera) {
      if (disposed) return;
      if (weather) weather.step(dt, camera);
      if (treesHandle) treesHandle.update(dt, camera);
      if (jungleHandle) jungleHandle.update(dt, camera);
      if (fxHandle) fxHandle.update(dt, camera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      if (fxHandle) { try { fxHandle.dispose(); } catch (_) {} fxHandle = null; }
      if (jungleHandle) { try { jungleHandle.dispose(); } catch (_) {} jungleHandle = null; }
      disposeTree(group);
      // Frees every LOD's geometry/material/texture, including whichever tiers (L1/L2, or the
      // hidden ones for a given chunk) disposeTree's traversal above still sees since ALL tiers
      // are added to the group (just hidden) here in T2 - so this is now mostly redundant with
      // disposeTree, but stays as a second, explicit line of defence: three.js dispose() is a
      // no-op on an already-freed resource, so calling both is safe, not harmful double-freeing.
      if (treeAssets) treeAssets.dispose();
    },
  };
}

export function disposeScenery(handle) { if (handle) handle.dispose(); }
