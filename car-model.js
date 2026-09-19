// ============================================================================
// car-model.js - car visuals.
//
//   loadCarModel(carConfig) -> Promise<CarModel>
//     Option A: GLTF (assets/models/ferrari.glb, cached, re-tinted per car).
//     Option B: buildCarModel(colorHex) - low-poly primitives fallback if the
//               GLB fails to load for any reason.
//
//   CarModel = {
//     body:   THREE.Group   (everything except the wheels; origin at ground level,
//                            car faces -Z, +X is the car's right side)
//     wheels: [{ node, position: Vector3 (model frame), radius, isFront, side }]
//             fl, fr, rl, rr in that order. Each wheel rolls about its local X.
//     source: "gltf" | "primitive"
//   }
//
//   assembleStatic(model) -> Group with the wheels attached (menus / previews)
//
// Art teammates: to use a different GLB, set `model` in cars.js. The loader looks
// for nodes named body / wheel_fl / wheel_fr / wheel_rl / wheel_rr (three.js's
// Ferrari has exactly these). Anything else falls back to the primitive car.
// ============================================================================

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const DEFAULT_MODEL_URL = "./assets/models/ferrari.glb";
const DRACO_PATH = "./assets/libs/draco/"; // decoder shipped locally: no CDN needed at demo time
const LOAD_TIMEOUT_MS = 8000;

// Purely cosmetic size bump - the car looked small relative to the track/other cars.
// Applied to the returned `body` group and to each wheel's own mesh scale, AFTER
// `radius`/`position`/`quaternion` are captured below - those three numbers are what
// main.js's buildCarRig() turns into the chassis collision box and wheel-raycast
// layout (physics.js), so they're read at their original, unscaled values and never
// touched here. That deliberately means the locally-driven car's own wheel STANCE
// (not size) stays exactly where physics already has it tuned - only assembleStatic()
// (menu car, results preview, remote multiplayer puppets - none of them physics-driven)
// also widens the wheel POSITION to match, since nothing there is fighting a tuned
// collision box. See car-model.js's assembleStatic() for that half of the fix.
const VISUAL_SCALE = 1.4;

const gltfCache = new Map(); // url -> Promise<gltf.scene>

function loadGltfOnce(url) {
  if (!gltfCache.has(url)) {
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("GLB load timed out")), LOAD_TIMEOUT_MS);
      const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
      const loader = new GLTFLoader().setDRACOLoader(draco);
      loader.load(
        url,
        (gltf) => { clearTimeout(timer); resolve(gltf.scene); },
        undefined,
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
    p.catch(() => gltfCache.delete(url)); // allow a retry next time
    gltfCache.set(url, p);
  }
  return gltfCache.get(url);
}

/** Kick off the GLB download early (call at boot). Never rejects. */
export function preloadCarAssets() {
  return loadGltfOnce(DEFAULT_MODEL_URL).then(() => true, () => false);
}

// ---------------------------------------------------------------------------

export async function loadCarModel(carConfig) {
  // Real car model (Task 7): on-demand, cached by loadGltfOnce; any failure (404,
  // timeout, bad file) drops through to the tinted Ferrari below.
  if (carConfig.model) {
    try {
      const [template, ferrari] = await Promise.all([
        loadGltfOnce(carConfig.model),
        loadGltfOnce(DEFAULT_MODEL_URL).catch(() => null),
      ]);
      const model = instantiateReal(template, carConfig, ferrari);
      if (model) return model;
    } catch (err) {
      console.warn("[car-model] real model unavailable, using tinted Ferrari:", err?.message || err);
    }
  }
  try {
    const template = await loadGltfOnce(DEFAULT_MODEL_URL);
    const model = instantiateGltf(template, carConfig);
    if (model) return model;
    console.warn("[car-model] GLB missing expected nodes, using primitive car");
  } catch (err) {
    console.warn("[car-model] GLB unavailable, using primitive car:", err?.message || err);
  }
  return buildCarModel(carConfig.color);
}

/** The tinted-Ferrari fallback only (never the real model). Never rejects. */
export function loadFallbackModel(carConfig) {
  return loadCarModel({ ...carConfig, model: null });
}

/**
 * Race-start friendly load: resolves with the real model if it arrives within
 * maxWaitMs, otherwise with the tinted Ferrari immediately, and calls onLate(model)
 * once the real one does show up (caller swaps the visual). Never rejects.
 */
export function loadCarModelQuick(carConfig, maxWaitMs, onLate) {
  if (!carConfig.model) return loadCarModel(carConfig);
  const real = loadCarModel(carConfig);
  let settled = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      loadFallbackModel(carConfig).then(resolve);
      real.then((m) => { if (m && m.source === "gltf-real") onLate?.(m); }).catch(() => {});
    }, maxWaitMs);
    real.then((m) => { if (settled) return; settled = true; clearTimeout(timer); resolve(m); },
              () => { if (settled) return; settled = true; clearTimeout(timer); loadFallbackModel(carConfig).then(resolve); });
  });
}

// ---------------------------------------------------------------------------
// Real car models (Task 7). None of the shipped GLBs use the body/wheel_* node
// contract, so: recentre on the bounding box, scale so the long axis matches the
// Ferrari's raw length (VISUAL_SCALE is then applied on top, exactly like the
// Ferrari path), sit min-y on the ground, per-car modelYaw. Wheels are baked
// into the mesh (static); the physics-facing wheel layout is copied from the
// Ferrari so the chassis box / raycast layout - and therefore handling - are
// identical to the tinted-Ferrari car. Nothing in physics.js changes.
// ---------------------------------------------------------------------------
const FALLBACK_FERRARI_LENGTH = 4.5; // m, only if the Ferrari GLB itself failed to load

function ferrariWheelData(ferrariTemplate) {
  const names = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];
  const nodes = names.map((n) => ferrariTemplate.getObjectByName(n));
  if (nodes.some((n) => !n)) return null;
  return nodes.map((node, i) => {
    const box = new THREE.Box3().setFromObject(node);
    return {
      node: new THREE.Group(), // empty: the real model's own wheels are part of its body
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      radius: (box.max.y - box.min.y) / 2 || 0.36,
      isFront: i < 2,
      side: i % 2 === 0 ? -1 : 1,
    };
  });
}

function instantiateReal(template, carConfig, ferrariTemplate) {
  const fit = carConfig.fit || {};
  const hide = new Set(fit.hideMaterials || []);
  const root = template.clone(true);
  const paint = new THREE.MeshPhysicalMaterial({
    color: carConfig.color, metalness: 0.55, roughness: 0.32, clearcoat: 1.0, clearcoatRoughness: 0.05,
  });
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mname = (o.material && o.material.name) || "";
    if (hide.has(mname)) { o.visible = false; return; }
    o.castShadow = true;
    o.receiveShadow = false;
    if (carConfig.paintMaterial && mname === carConfig.paintMaterial) o.material = paint;
    else if (Array.isArray(o.material)) o.material = o.material.map((m) => m.clone());
    else if (o.material) o.material = o.material.clone();
    // ^ Object3D.clone() shares materials with the cached template. Anything that mutates a
    //   material (the hero car's swap fade) would then leak into every other instance of the
    //   same model - the race car included - so each instance gets its own copies. Textures
    //   and geometry stay shared (cloning a material copies the texture reference only).
    box.expandByObject(o, true);
  });
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const length = Math.max(size.x, size.z) || 1;

  let targetLength = FALLBACK_FERRARI_LENGTH;
  if (ferrariTemplate) {
    const fb = new THREE.Box3().setFromObject(ferrariTemplate);
    targetLength = (fb.max.z - fb.min.z) || FALLBACK_FERRARI_LENGTH;
  }
  const scale = (targetLength / length) * (carConfig.scale || 1);

  root.position.set(-centre.x, -box.min.y, -centre.z); // recentre, wheels on the ground
  const orient = new THREE.Group();
  orient.add(root);
  if (size.x > size.z) orient.rotation.y = Math.PI / 2; // long axis onto Z (model frame faces -Z)
  // Per-car yaw (cars.js modelYaw) - applied on the model's own wrapper, AFTER the model is
  // centred (root.position above) and BEFORE the scale group / chassis group it is added to.
  orient.rotation.y += Number(carConfig.modelYaw) || 0;
  const fitted = new THREE.Group();
  fitted.scale.setScalar(scale);
  fitted.add(orient);

  let wheels = ferrariTemplate ? ferrariWheelData(ferrariTemplate) : null;
  if (!wheels) wheels = buildCarModel(carConfig.color).wheels.map((w) => ({ ...w, node: new THREE.Group() }));

  const body = new THREE.Group();
  body.name = "car-body";
  body.scale.setScalar(VISUAL_SCALE);
  body.add(fitted);
  return { body, wheels, source: "gltf-real", tintDisabled: !carConfig.paintMaterial };
}

function instantiateGltf(template, carConfig) {
  const root = template.clone(true);
  root.scale.setScalar(carConfig.scale || 1);

  const bodyMesh = root.getObjectByName("body");
  const wheelNodes = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"].map((n) => root.getObjectByName(n));
  if (!bodyMesh || wheelNodes.some((w) => !w)) return null;

  // Materials: fresh paint per instance so tints don't leak between cars.
  const paint = new THREE.MeshPhysicalMaterial({
    color: carConfig.color, metalness: 0.55, roughness: 0.32, clearcoat: 1.0, clearcoatRoughness: 0.05,
  });
  const details = new THREE.MeshStandardMaterial({ color: 0xdadada, metalness: 1.0, roughness: 0.35 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fbbd8, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.55 });

  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    if (o.name === "body") o.material = paint;
    else if (/^rim_|^trim$|^centre$|^nuts$/.test(o.name)) o.material = details;
    else if (o.name === "glass") o.material = glass;
    else if (o.material) o.material = o.material.clone();
  });

  // Wheel radius from geometry (tyre mesh bounds).
  const wheels = wheelNodes.map((node, i) => {
    const box = new THREE.Box3().setFromObject(node);
    const radius = (box.max.y - box.min.y) / 2 || 0.36;
    return {
      node,
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      radius,
      isFront: i < 2,
      side: i % 2 === 0 ? -1 : 1,
    };
  });

  // Wheels become independent so physics can drive them; body keeps the rest.
  wheels.forEach((w) => w.node.removeFromParent());
  // Visual-only size bump (see VISUAL_SCALE above) - radius/position were already
  // captured from the unscaled geometry, so this doesn't touch anything physics reads.
  wheels.forEach((w) => w.node.scale.setScalar(VISUAL_SCALE));

  const body = new THREE.Group();
  body.name = "car-body";
  body.scale.setScalar(VISUAL_SCALE);
  body.add(root);
  return { body, wheels, source: "gltf" };
}

// ---------------------------------------------------------------------------
// Option B: low-poly car from primitives. Same frame as the GLB: origin on the
// ground, faces -Z, wheels roll about local X.
// ---------------------------------------------------------------------------
export function buildCarModel(colorHex = 0xff3b3b) {
  const body = new THREE.Group();
  body.name = "car-body";

  const paint = new THREE.MeshPhysicalMaterial({ color: colorHex, metalness: 0.5, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcfd4dc, metalness: 1, roughness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x8fb3d9, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.45 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 1.6 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 1.4 });

  // Side silhouette in the (z, y) plane: nose at -Z, tail at +Z. Extruded along X.
  const W = 1.7;
  const shape = new THREE.Shape();
  shape.moveTo(-2.3, 0.28);   // nose bottom
  shape.lineTo(-2.35, 0.5);   // nose lip
  shape.lineTo(-1.6, 0.62);   // bonnet start
  shape.lineTo(-0.7, 0.72);   // bonnet end / windshield base
  shape.lineTo(-0.1, 1.18);   // windshield top
  shape.lineTo(0.9, 1.2);     // roof
  shape.lineTo(1.7, 0.85);    // rear window
  shape.lineTo(2.25, 0.8);    // boot
  shape.lineTo(2.3, 0.32);    // tail bottom
  shape.lineTo(1.9, 0.2);
  shape.lineTo(-1.9, 0.2);
  shape.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2 });
  // Extrude goes along +Z; rotate so the profile runs along the car's length (Z) and the
  // extrusion becomes width (X), centred.
  bodyGeo.rotateY(-Math.PI / 2);
  bodyGeo.translate(W / 2, 0, 0);
  const shell = new THREE.Mesh(bodyGeo, paint);
  shell.castShadow = true;
  body.add(shell);

  // Cabin glass (slightly inset so it reads through the paint).
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(W - 0.3, 0.5, 1.9), glass);
  cabin.position.set(0, 0.98, 0.35);
  cabin.rotation.x = -0.05;
  body.add(cabin);

  // Spoiler
  const wing = new THREE.Mesh(new THREE.BoxGeometry(W + 0.1, 0.06, 0.45), dark);
  wing.position.set(0, 1.12, 2.05);
  wing.castShadow = true;
  body.add(wing);
  for (const x of [-0.7, 0.7]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.25), dark);
    strut.position.set(x, 0.96, 2.05);
    body.add(strut);
  }

  // Front splitter + rear diffuser
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(W + 0.15, 0.06, 0.5), dark);
  splitter.position.set(0, 0.25, -2.25);
  body.add(splitter);

  // Lights
  for (const x of [-0.65, 0.65]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.1), headMat);
    head.position.set(x, 0.55, -2.34);
    body.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.08), tailMat);
    tail.position.set(x, 0.62, 2.32);
    body.add(tail);
  }
  // Grille + mirrors
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.08), dark);
  grille.position.set(0, 0.42, -2.36);
  body.add(grille);
  for (const x of [-1.05, 1.05]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.22), paint);
    mirror.position.set(x * 0.95, 0.88, -0.45);
    body.add(mirror);
  }

  // Wheels: tyre (dark) + rim (chrome) + hub. Cylinder axis rotated onto X (the axle).
  const R = 0.36;
  const tyreGeo = new THREE.CylinderGeometry(R, R, 0.3, 24);
  tyreGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.32, 12);
  rimGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(R * 0.2, R * 0.2, 0.34, 8);
  hubGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.33, R * 1.1, 0.06);

  const layout = [
    { name: "fl", x: -0.92, z: -1.35, isFront: true, side: -1 },
    { name: "fr", x: 0.92, z: -1.35, isFront: true, side: 1 },
    { name: "rl", x: -0.92, z: 1.35, isFront: false, side: -1 },
    { name: "rr", x: 0.92, z: 1.35, isFront: false, side: 1 },
  ];
  const wheels = layout.map((l) => {
    const node = new THREE.Group();
    node.name = "wheel_" + l.name;
    const tyre = new THREE.Mesh(tyreGeo, dark);
    const rim = new THREE.Mesh(rimGeo, chrome);
    const hub = new THREE.Mesh(hubGeo, dark);
    tyre.castShadow = true;
    node.add(tyre, rim, hub);
    for (let k = 0; k < 3; k++) {
      const spoke = new THREE.Mesh(spokeGeo, chrome);
      spoke.rotation.x = (k / 3) * Math.PI;
      node.add(spoke);
    }
    return {
      node,
      position: new THREE.Vector3(l.x, R, l.z),
      quaternion: new THREE.Quaternion(),
      radius: R,
      isFront: l.isFront,
      side: l.side,
    };
  });

  // Visual-only size bump, same treatment as the GLTF path above: wheels[i].position/
  // .radius are left exactly as defined (R, the layout[] coordinates) so physics.js's
  // chassis box and wheel-raycast placement don't move; only the rendered meshes grow.
  body.scale.setScalar(VISUAL_SCALE);
  wheels.forEach((w) => w.node.scale.setScalar(VISUAL_SCALE));

  return { body, wheels, source: "primitive" };
}

// ---------------------------------------------------------------------------

/**
 * Wheels attached at rest: for the showcase / car-select preview, and for
 * multiplayer's remote-player puppets (main.js) - anything that isn't the
 * locally-driven car, which instead gets its wheel positions from physics every
 * frame (see main.js's buildCarRig/syncWheelVisuals) and is deliberately left
 * alone by VISUAL_SCALE (see the comment on it above).
 *
 * w.position is the wheel's ORIGINAL (pre-VISUAL_SCALE) offset - main.js's physics
 * layout reads that same field directly and must keep seeing the unscaled value, so
 * it's scaled only in this copy, not on the shared model.wheels object. Without this,
 * the now-bigger wheel mesh (VISUAL_SCALE'd above) would sit at its old, closer-to-
 * centre offset and visibly float inboard of the bigger body's fenders.
 */
export function assembleStatic(model) {
  const g = new THREE.Group();
  g.add(model.body);
  for (const w of model.wheels) {
    w.node.position.copy(w.position).multiplyScalar(VISUAL_SCALE);
    w.node.quaternion.copy(w.quaternion);
    g.add(w.node);
  }
  return g;
}
