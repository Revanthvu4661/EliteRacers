// ============================================================================
// oval-model.js - visual model for the OVAL track (assets/models/oval.glb, Draco + WebP, ~7.7 MB;
// the 124 MB original is never loaded at runtime).
//   preloadOval()        -> Promise<boolean>, cached; 12 s timeout, never rejects.
//   ovalReady()          -> true once the model is loaded.
//   buildOvalGroup(pts)  -> THREE.Group with the WHOLE scene (road, grass, stands, garages, trees,
//                           balloons, ...) re-levelled to the game's FLAT physics ground, or null.
//
// Why re-level: physics is a flat plane at y = 0 but the source model banks the ring by up to ~5 m.
// A height map of the model's own road/gravel/grass (rasterised from its triangles) is subtracted
// from every vertex within ~80 m of the racing line (fading out to nothing at ~220 m, so the far
// hills keep their shape). The road top ends up at y = 0.02. `pts` is the track's control-point
// loop ([x, z] in model space = world space).
//
// The re-levelled geometry is baked ONCE into the cached scene (world matrices applied, instanced
// parts' instance matrices adjusted); each build only makes new Mesh/InstancedMesh objects that
// share that geometry, with cloned materials, so track.dispose() can free them safely (shared
// geometry is simply re-uploaded to the GPU on the next build).
// ============================================================================
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const URL_OVAL = "./assets/models/oval.glb";
const TIMEOUT_MS = 12000;
const CELL = 2;                       // m, height-map resolution
const X0 = -620, X1 = 660, Z0 = -640, Z1 = 460;
const FULL_M = 80, FADE_M = 220;      // re-level fully within FULL_M of the racing line, none beyond FADE_M
const ROAD_TOP = 0.02;
const HEIGHT_LAYERS = ["1GRASS", "0GRASS2", "1GRAVEL", "1TARMAC"]; // rasterised in this order (later wins)

let scene = null, promise = null, prepared = false;

export function ovalReady() { return !!scene; }

export function preloadOval() {
  if (promise) return promise;
  promise = new Promise((resolve) => {
    const t = setTimeout(() => { console.warn("[oval] timeout, using the procedural road"); resolve(false); }, TIMEOUT_MS);
    const draco = new DRACOLoader().setDecoderPath("./assets/libs/draco/");
    new GLTFLoader().setDRACOLoader(draco).load(URL_OVAL,
      (gltf) => { clearTimeout(t); scene = gltf.scene; draco.dispose(); resolve(true); },
      undefined,
      (err) => { clearTimeout(t); console.warn("[oval] load failed, using the procedural road:", err && err.message); resolve(false); });
  });
  promise.then((ok) => { if (!ok) promise = null; }); // allow a retry
  return promise;
}

// --- one-time preparation ----------------------------------------------------------------------
function prepare(pts) {
  scene.updateMatrixWorld(true);
  const GW = Math.ceil((X1 - X0) / CELL), GH = Math.ceil((Z1 - Z0) / CELL);
  const height = new Float32Array(GW * GH).fill(NaN);
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

  // 1. rasterise the ground layers' triangles into the height map (barycentric y)
  const layers = new Map();
  scene.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) for (const n of HEIGHT_LAYERS) if (o.name.startsWith(n)) layers.set(n, o); });
  for (const n of HEIGHT_LAYERS) {
    const o = layers.get(n);
    if (!o) continue;
    const p = o.geometry.attributes.position, idx = o.geometry.index;
    const tri = idx ? idx.count / 3 : p.count / 3;
    for (let t = 0; t < tri; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      v0.fromBufferAttribute(p, a).applyMatrix4(o.matrixWorld);
      v1.fromBufferAttribute(p, b).applyMatrix4(o.matrixWorld);
      v2.fromBufferAttribute(p, c).applyMatrix4(o.matrixWorld);
      const minX = Math.max(0, Math.floor((Math.min(v0.x, v1.x, v2.x) - X0) / CELL)), maxX = Math.min(GW - 1, Math.ceil((Math.max(v0.x, v1.x, v2.x) - X0) / CELL));
      const minZ = Math.max(0, Math.floor((Math.min(v0.z, v1.z, v2.z) - Z0) / CELL)), maxZ = Math.min(GH - 1, Math.ceil((Math.max(v0.z, v1.z, v2.z) - Z0) / CELL));
      const d = (v1.z - v2.z) * (v0.x - v2.x) + (v2.x - v1.x) * (v0.z - v2.z);
      if (Math.abs(d) < 1e-9) continue;
      for (let gz = minZ; gz <= maxZ; gz++) {
        const pz = Z0 + (gz + 0.5) * CELL;
        for (let gx = minX; gx <= maxX; gx++) {
          const px = X0 + (gx + 0.5) * CELL;
          const l0 = ((v1.z - v2.z) * (px - v2.x) + (v2.x - v1.x) * (pz - v2.z)) / d;
          const l1 = ((v2.z - v0.z) * (px - v2.x) + (v0.x - v2.x) * (pz - v2.z)) / d;
          const l2 = 1 - l0 - l1;
          if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
          height[gz * GW + gx] = l0 * v0.y + l1 * v1.y + l2 * v2.y;
        }
      }
    }
  }
  // 2. fill holes (cells no triangle reached) from the nearest filled neighbour, a few passes
  for (let pass = 0; pass < 6; pass++) {
    const copy = height.slice();
    for (let gz = 0; gz < GH; gz++) for (let gx = 0; gx < GW; gx++) {
      const i = gz * GW + gx;
      if (!Number.isNaN(copy[i])) continue;
      let s = 0, n = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx, z = gz + dz;
        if (x < 0 || z < 0 || x >= GW || z >= GH) continue;
        const h = copy[z * GW + x];
        if (!Number.isNaN(h)) { s += h; n++; }
      }
      if (n) height[i] = s / n;
    }
  }
  // 3. per-cell shift = weight(distance to the racing line) * (height - ROAD_TOP)
  const shift = new Float32Array(GW * GH);
  for (let gz = 0; gz < GH; gz++) {
    const pz = Z0 + (gz + 0.5) * CELL;
    for (let gx = 0; gx < GW; gx++) {
      const h = height[gz * GW + gx];
      if (Number.isNaN(h)) continue;
      const px = X0 + (gx + 0.5) * CELL;
      let best = 1e9;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        let t = ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const e = Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
        if (e < best) best = e;
      }
      const w = best <= FULL_M ? 1 : best >= FADE_M ? 0 : 1 - (best - FULL_M) / (FADE_M - FULL_M);
      shift[gz * GW + gx] = w * (h - ROAD_TOP);
    }
  }
  const dyAt = (x, z) => {
    const gx = Math.floor((x - X0) / CELL), gz = Math.floor((z - Z0) / CELL);
    if (gx < 0 || gz < 0 || gx >= GW || gz >= GH) return 0;
    return shift[gz * GW + gx];
  };

  // 4. bake world matrices and apply the shift: plain meshes per vertex, instanced parts per instance
  const m = new THREE.Matrix4(), inst = new THREE.Matrix4(), w = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, inst);
        inst.premultiply(o.matrixWorld); // instance matrix in WORLD space
        w.setFromMatrixPosition(inst);
        inst.elements[13] -= dyAt(w.x, w.z);
        o.setMatrixAt(i, inst);
      }
      o.instanceMatrix.needsUpdate = true;
      o.userData.baked = "instanced";
    } else {
      o.geometry.applyMatrix4(o.matrixWorld);
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - dyAt(p.getX(i), p.getZ(i)));
      p.needsUpdate = true;
      o.geometry.computeBoundingSphere(); o.geometry.computeBoundingBox();
      o.userData.baked = "plain";
    }
    o.matrixWorld.identity(); o.matrix.identity(); o.matrixAutoUpdate = false;
  });
  void m;
  prepared = true;
}

export function buildOvalGroup(pts) {
  if (!scene) return null;
  if (!prepared) prepare(pts);
  const group = new THREE.Group();
  group.name = "oval-model";
  scene.traverse((o) => {
    if (!o.isMesh || !o.userData.baked) return;
    const mat = Array.isArray(o.material) ? o.material.map((x) => x.clone()) : o.material.clone();
    (Array.isArray(mat) ? mat : [mat]).forEach((x) => { if (x.map && x.transparent) { x.alphaTest = 0.5; x.transparent = false; x.side = THREE.DoubleSide; } });
    let mesh;
    if (o.isInstancedMesh) {
      mesh = new THREE.InstancedMesh(o.geometry, mat, o.count);
      mesh.instanceMatrix.copy(o.instanceMatrix);
      if (o.instanceColor) { mesh.instanceColor = o.instanceColor.clone(); }
      mesh.count = o.count;
      mesh.frustumCulled = false; // instance bounds are not tracked
    } else {
      mesh = new THREE.Mesh(o.geometry, mat);
    }
    mesh.name = "oval-" + o.name;
    mesh.receiveShadow = /TARMAC|GRASS|GRAVEL/.test(o.name);
    mesh.castShadow = false;
    group.add(mesh);
  });
  return group.children.length ? group : null;
}
