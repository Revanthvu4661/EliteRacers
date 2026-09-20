// ============================================================================
// nature-models.js - loads the optimised nature GLBs (assets/nature/opt/) once per session.
//   preloadNature()  -> Promise, kicked off at boot; never rejects, never blocks the race gate.
//   getNature()      -> {variants:[{role,name,l0:[{geo,mat}],l1:[...]}]} or null until loaded.
// Every file has an 8 s timeout; a 404/error/timeout drops that model and logs it, so the game
// falls back to the procedural trees for that slot. The geometries/materials are SHARED and live
// for the whole session (never disposed per race; see jungle.js).
// ============================================================================
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const BASE = "./assets/nature/opt/";
const TIMEOUT_MS = 8000;
const MODELS = [
  ["bigTree", "bigTree_01"], ["broadleaf", "broadleaf_01"], ["broadleaf", "broadleaf_02"],
  ["broadleaf", "broadleaf_03"], ["birch", "birch_01"], ["birch", "birch_02"],
];

let promise = null, result = null;

function loadOne(loader, url) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { console.warn("[nature] timeout, using procedural for", url); resolve(null); }, TIMEOUT_MS);
    loader.load(url, (gltf) => {
      clearTimeout(t);
      gltf.scene.updateMatrixWorld(true);
      const parts = [];
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const mat = o.material;
        if (mat.map || mat.alphaMap) { mat.alphaTest = 0.5; mat.transparent = false; mat.side = THREE.DoubleSide; }
        mat.envMapIntensity = 0.5;
        parts.push({ geo, mat });
      });
      resolve(parts.length ? parts : null);
    }, undefined, (err) => { clearTimeout(t); console.warn("[nature] failed, using procedural for", url, err && err.message); resolve(null); });
  });
}

export function preloadNature() {
  if (promise) return promise;
  promise = (async () => {
    try {
      const draco = new DRACOLoader().setDecoderPath("./assets/libs/draco/");
      const loader = new GLTFLoader().setDRACOLoader(draco);
      const all = await Promise.all(MODELS.map(async ([role, name]) => {
        const [l0, l1] = await Promise.all([loadOne(loader, BASE + name + ".glb"), loadOne(loader, BASE + name + ".L1.glb")]);
        return l0 ? { role, name, l0, l1: l1 || l0 } : null;
      }));
      draco.dispose();
      const variants = all.filter(Boolean);
      result = variants.length ? { variants } : null;
      console.info("[nature] loaded", variants.length + "/" + MODELS.length, "models");
    } catch (err) { console.warn("[nature] load failed, procedural only", err); }
    return result;
  })();
  return promise;
}
export function getNature() { return result; }
