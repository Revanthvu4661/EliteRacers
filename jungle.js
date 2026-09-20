// ============================================================================
// jungle.js - GLB tree layer for the jungle look, added ON TOP of the procedural trees.
//   buildJungleModels(scene, track, rnd, P, qualityId) -> {update(dt, camera), dispose()} | null
// One InstancedMesh per (model part, LOD) per ~60 m arc chunk, matrices written once at build.
// LOD every 250 ms with 10% hysteresis: L0 < lod0, L1 < lod1, hidden beyond (the procedural
// crown blobs already cover the far belt). Geometry/materials come from nature-models.js and are
// shared for the session, so dispose() only frees the per-track instance buffers.
// Trees stay non-colliding; in curved sections nothing is placed closer than 25 m to the wall
// (both sides, the conservative reading of "inside of every corner").
// ============================================================================
import * as THREE from "three";
import { getNature } from "./nature-models.js?v=89";

const CHUNK_M = 60, UPDATE_MS = 250, HYST = 0.1;
const COUNT = { high: 260, med: 180, low: 90, mobile: 0 };
const LOD = { high: [70, 160], med: [55, 120], low: [40, 90], mobile: [0, 0] };

export function buildJungleModels(scene, track, rnd, P, qualityId) {
  const nat = getNature();
  const target = COUNT[qualityId] != null ? COUNT[qualityId] : COUNT.med;
  if (!nat || !target) return null;
  const [lod0, lod1] = LOD[qualityId] || LOD.med;
  const S = track.samples, N = S.length, L = track.length;
  const chunkCount = Math.max(1, Math.round(L / CHUNK_M));
  const NEAR = P.wall + 8, FAR = 110;

  const ex = [];
  for (const c of track.checkpoints) ex.push(c.position);
  for (const p of track.pickups) ex.push(p.position);
  const excluded = (x, z) => {
    if (Math.hypot(x - P.start.x, z - P.start.z) < 40) return true;
    for (const e of ex) if (Math.hypot(x - e.x, z - e.z) < 14) return true;
    return false;
  };

  // up to 3 variants per chunk, chosen deterministically
  const perChunk = [];
  for (let i = 0; i < chunkCount; i++) {
    const pick = [];
    while (pick.length < Math.min(3, nat.variants.length)) {
      const v = (rnd() * nat.variants.length) | 0;
      if (!pick.includes(v)) pick.push(v);
    }
    perChunk.push(pick);
  }

  // placement: strides along the arc, both sides, density modulated by low-frequency noise
  const buckets = new Map(); // "chunk|variant" -> items
  let placed = 0, arc = rnd() * 10;
  const nPhase = rnd() * 6.28;
  let guard = 0;
  while (placed < target && guard++ < 30000) {
    arc += 3 + rnd() * 6;
    if (arc >= L) arc -= L; // wrap: several passes fill toward the target, noise keeps them uneven
    const dens = 0.55 + 0.45 * Math.sin(arc * 0.011 + nPhase);
    if (rnd() > dens) continue;
    const si = Math.floor((arc / L) * N) % N;
    const s = S[si], s2 = S[(si + 6) % N];
    const curved = Math.abs(s.t.x * s2.t.z - s.t.z * s2.t.x) > 0.08;
    const side = rnd() < 0.5 ? 1 : -1;
    const lat = NEAR + Math.pow(rnd(), 1.3) * (FAR - NEAR);
    if (curved && lat < P.wall + 25) continue;
    const x = s.p.x + s.n.x * side * lat, z = s.p.z + s.n.z * side * lat;
    if (excluded(x, z)) continue;
    if (P.centreDist(x, z) < NEAR - 3) continue; // real distance, not just offset arithmetic
    const ci = Math.min(chunkCount - 1, Math.floor(arc / (L / chunkCount)));
    const vi = perChunk[ci][(rnd() * perChunk[ci].length) | 0];
    const key = ci + "|" + vi;
    let a = buckets.get(key); if (!a) buckets.set(key, a = []);
    a.push({ x, z, sc: 0.8 + rnd() * 0.6, yaw: rnd() * 6.283, tA: rnd() * 0.052, tD: rnd() * 6.283,
      r: 0.58 + rnd() * 0.16, g: 0.7 + rnd() * 0.16, b: 0.5 + rnd() * 0.14 });
    placed++;
  }

  const group = new THREE.Group(); group.name = "jungle-models";
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), yq = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3(), ax = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const chunks = [];
  for (const [key, items] of buckets) {
    const v = nat.variants[+key.split("|")[1]];
    let cx = 0, cz = 0;
    for (const it of items) { cx += it.x; cz += it.z; }
    cx /= items.length; cz /= items.length;
    let rad = 0;
    for (const it of items) rad = Math.max(rad, Math.hypot(it.x - cx, it.z - cz));
    const sphere = new THREE.Sphere(new THREE.Vector3(cx, 14, cz), rad + 30);
    const tiers = [[], []];
    [v.l0, v.l1].forEach((parts, lod) => {
      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(part.geo, part.mat, items.length);
        items.forEach((it, i) => {
          ax.set(Math.cos(it.tD), 0, Math.sin(it.tD));
          q.setFromAxisAngle(ax, it.tA); yq.setFromAxisAngle(up, it.yaw); q.multiply(yq);
          pos.set(it.x, 0, it.z); scl.set(it.sc, it.sc, it.sc);
          m.compose(pos, q, scl); mesh.setMatrixAt(i, m);
          col.setRGB(it.r, it.g, it.b); mesh.setColorAt(i, col);
        });
        mesh.count = items.length;
        mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.boundingSphere = sphere.clone(); mesh.frustumCulled = true; mesh.visible = false;
        group.add(mesh); tiers[lod].push(mesh);
      }
    });
    chunks.push({ cx, cz, tiers, lod: -1 });
  }
  scene.add(group);

  let acc = 0;
  function setLod(c, lod) {
    c.lod = lod;
    for (let t = 0; t < 2; t++) { const on = t === lod, a = c.tiers[t]; for (let i = 0; i < a.length; i++) a[i].visible = on; }
  }
  return {
    count: placed, chunks,
    update(dt, camera) {
      acc += dt * 1000; if (acc < UPDATE_MS) return; acc = 0;
      try {
        const cp = camera.position;
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i], d = Math.hypot(c.cx - cp.x, c.cz - cp.z);
          let lod = c.lod;
          if (lod === 0) { if (d > lod0 * (1 + HYST)) lod = d > lod1 * (1 + HYST) ? -1 : 1; }
          else if (lod === 1) { if (d < lod0 * (1 - HYST)) lod = 0; else if (d > lod1 * (1 + HYST)) lod = -1; }
          else lod = d < lod0 ? 0 : d < lod1 ? 1 : -1;
          if (lod !== c.lod) setLod(c, lod);
        }
      } catch (err) { console.warn("[jungle] update", err); }
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); // instance buffers only; geo/mat are shared
    },
  };
}
