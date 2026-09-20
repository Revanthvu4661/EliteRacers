// ============================================================================
// oval-model.js - visual model for the OVAL track (assets/models/oval.glb, Draco + WebP, ~7.7 MB;
// the 124 MB original is never loaded at runtime).
//   preloadOval()   -> Promise<boolean>, cached; 12 s timeout, never rejects. Call when OVAL is
//                      picked, and await it before building the track (see main.js startRace).
//   ovalReady()     -> true once the model is loaded.
//   buildOvalGroup()-> THREE.Group with the FLATTENED ground layers (tarmac, grass, gravel, lines)
//                      or null. The physics ground is a flat plane, but the source model has up to
//                      ~5 m of banking/hills, so the ground layers are squashed to (almost) flat;
//                      everything standing up (walls, stands, trees, garages, props) is dropped,
//                      because at their authored heights they would float or sink. The road,
//                      kerbs, barriers and gates are the procedural ones from track.js, aligned to
//                      the tarmac by control points measured from the model (model space = world).
// Geometry and materials are cloned per build, so track.dispose() can free them safely.
// ============================================================================
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const URL_OVAL = "./assets/models/oval.glb";
const TIMEOUT_MS = 12000;
// mesh-name prefix -> y offset (metres) after squashing; higher layers draw over lower ones
const LAYERS = [["1GRASS", -0.06], ["0GRASS2", -0.05], ["1GRAVEL", -0.02], ["1TARMAC", 0.03], ["line_seg", 0.05]];
const SQUASH = 0.02;

let scene = null, promise = null;

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

export function buildOvalGroup() {
  if (!scene) return null;
  const group = new THREE.Group();
  group.name = "oval-model";
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const layer = LAYERS.find(([p]) => o.name.startsWith(p));
    if (!layer) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    const pos = geo.attributes.position, nrm = geo.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, pos.getY(i) * SQUASH + layer[1]);
      if (nrm) nrm.setXYZ(i, 0, 1, 0);
    }
    pos.needsUpdate = true;
    if (nrm) nrm.needsUpdate = true;
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const mat = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = "oval-" + o.name;
    group.add(mesh);
  });
  return group.children.length ? group : null;
}
