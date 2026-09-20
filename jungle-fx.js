// ============================================================================
// jungle-fx.js - jungle atmosphere, all created at build time (loading), nothing per frame but
// writes into existing buffers / uniforms:
//   * 5 light shafts  (additive tapered quads, soft gradient texture, slow opacity drift),
//                     placed 45-90 m off the road in the mid belt, never over the road centre
//   * ground mist     (<= 32 sprites, alpha <= 0.2, slow drift)
//   * pollen / leaves (Points: 800 high, 400 med, 0 low/mobile)
// ?fx=off disables everything; prefers-reduced-motion freezes drift; a hidden tab pauses it.
// buildJungleFx(scene, track, rnd, P, qualityId) -> {update(dt, camera), dispose()} | null
// ============================================================================
import * as THREE from "three";

const POLLEN = { high: 800, med: 400, low: 0, mobile: 0 };
const BOX = 40; // pollen volume half-size around the camera (metres)

function fxOff() { try { return new URLSearchParams(location.search).get("fx") === "off"; } catch (_) { return false; } }
function reducedMotion() { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } }

function gradientTexture(kind) {
  const c = document.createElement("canvas"); c.width = 64; c.height = 128;
  const g = c.getContext("2d");
  if (kind === "shaft") { // fades to nothing at both ends and sideways
    const v = g.createLinearGradient(0, 0, 0, 128);
    v.addColorStop(0, "rgba(255,240,200,0)"); v.addColorStop(0.25, "rgba(255,240,200,0.9)"); v.addColorStop(1, "rgba(255,240,200,0)");
    g.fillStyle = v; g.fillRect(0, 0, 64, 128);
    g.globalCompositeOperation = "destination-in";
    const h = g.createLinearGradient(0, 0, 64, 0);
    h.addColorStop(0, "rgba(0,0,0,0)"); h.addColorStop(0.5, "rgba(0,0,0,1)"); h.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = h; g.fillRect(0, 0, 64, 128);
  } else { // soft round puff
    const r = g.createRadialGradient(32, 64, 0, 32, 64, 32);
    r.addColorStop(0, "rgba(220,235,225,1)"); r.addColorStop(1, "rgba(220,235,225,0)");
    g.fillStyle = r; g.fillRect(0, 0, 64, 128);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function buildJungleFx(scene, track, rnd, P, qualityId) {
  if (fxOff()) return null;
  const S = track.samples, N = S.length;
  const still = reducedMotion();
  const group = new THREE.Group(); group.name = "jungle-fx";
  const disposables = [];
  const at = (u) => S[Math.floor(((u % 1) + 1) % 1 * N) % N];

  // --- light shafts ----------------------------------------------------------
  const shaftTex = gradientTexture("shaft"); disposables.push(shaftTex);
  const shafts = [];
  for (let i = 0; i < 5; i++) {
    const s = at((i + rnd() * 0.6) / 5), side = rnd() < 0.5 ? 1 : -1;
    const lat = P.wall + 45 + rnd() * 40; // mid belt, always well off the road
    const x = s.p.x + s.n.x * side * lat, z = s.p.z + s.n.z * side * lat;
    if (P.centreDist(x, z) < P.wall + 30) continue;
    const mat = new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    const geo = new THREE.PlaneGeometry(9, 34); disposables.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 17, z);
    mesh.rotation.set(0, Math.atan2(s.t.x, s.t.z) + Math.PI / 2, 0.22); // lean along the sun
    mesh.frustumCulled = true; mesh.renderOrder = 5;
    group.add(mesh); shafts.push({ mat, ph: rnd() * 6.28, sp: 0.15 + rnd() * 0.2 });
  }

  // --- ground mist -------------------------------------------------------------
  const mistTex = gradientTexture("mist"); disposables.push(mistTex);
  const mist = [];
  const mistN = qualityId === "mobile" ? 12 : qualityId === "low" ? 20 : 32;
  for (let i = 0; i < mistN; i++) {
    const s = at(rnd()), side = rnd() < 0.5 ? 1 : -1;
    const lat = P.wall + 10 + rnd() * 50;
    const mat = new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.12 + rnd() * 0.08, depthWrite: false, fog: true });
    disposables.push(mat);
    const sp = new THREE.Sprite(mat);
    const x = s.p.x + s.n.x * side * lat, z = s.p.z + s.n.z * side * lat;
    sp.position.set(x, 1.5 + rnd() * 2, z); sp.scale.set(26 + rnd() * 18, 8 + rnd() * 4, 1);
    group.add(sp); mist.push({ sp, x0: x, z0: z, ph: rnd() * 6.28, dx: s.t.x, dz: s.t.z });
  }

  // --- pollen / leaf motes -----------------------------------------------------
  const pollenN = POLLEN[qualityId] != null ? POLLEN[qualityId] : POLLEN.med;
  let pts = null, pos = null;
  if (pollenN > 0) {
    pos = new Float32Array(pollenN * 3);
    for (let i = 0; i < pollenN; i++) { pos[i * 3] = (rnd() - 0.5) * BOX * 2; pos[i * 3 + 1] = rnd() * 14; pos[i * 3 + 2] = (rnd() - 0.5) * BOX * 2; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xf3e8b0, size: 0.05, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true });
    disposables.push(geo, mat);
    pts = new THREE.Points(geo, mat); pts.frustumCulled = false; group.add(pts);
  }
  scene.add(group);

  let t = 0;
  return {
    counts: { shafts: shafts.length, mist: mist.length, pollen: pollenN },
    update(dt, camera) {
      if (document.hidden || still) return; // paused in a hidden tab / reduced motion
      try {
        t += dt;
        for (let i = 0; i < shafts.length; i++) shafts[i].mat.opacity = 0.15 + 0.08 * Math.sin(t * shafts[i].sp + shafts[i].ph);
        for (let i = 0; i < mist.length; i++) {
          const m = mist[i], k = Math.sin(t * 0.05 + m.ph) * 6;
          m.sp.position.x = m.x0 + m.dx * k; m.sp.position.z = m.z0 + m.dz * k;
        }
        if (pts) {
          const cp = camera.position, a = pts.geometry.attributes.position.array, dl = dt * 0.4;
          pts.position.set(cp.x, 0, cp.z); // volume follows the camera; local coords wrap inside the box
          for (let i = 0; i < pollenN; i++) {
            const j = i * 3;
            a[j] += Math.sin(t * 0.7 + i) * dl; a[j + 1] -= dl * 0.6; a[j + 2] += Math.cos(t * 0.5 + i * 1.3) * dl;
            if (a[j + 1] < 0) a[j + 1] += 14;
            if (a[j] > BOX) a[j] -= BOX * 2; else if (a[j] < -BOX) a[j] += BOX * 2;
            if (a[j + 2] > BOX) a[j + 2] -= BOX * 2; else if (a[j + 2] < -BOX) a[j + 2] += BOX * 2;
          }
          pts.geometry.attributes.position.needsUpdate = true;
        }
      } catch (err) { console.warn("[jungle-fx] update", err); }
    },
    dispose() {
      scene.remove(group);
      for (const d of disposables) d.dispose();
    },
  };
}
