// ============================================================================
// pickups.js - track pickups: boost (Task 1) and repair (revision - see below).
//
//   createPickups(scene, track) -> controller
//     controller.update(dt, carPosition) -> { collected: [{kind}], boosted: bool }
//       call once per race frame. `collected` lists every pickup taken THIS
//       frame (almost always 0 or 1 entries, but robust if two are ever close
//       enough to overlap) - main.js applies each kind's effect itself (boost
//       force / health repair); this module only owns pickup lifecycle
//       (spawn, proximity, hide, timestamp-derived respawn), not gameplay
//       effects. `boosted` is true for the whole ~1.5-2s window after a boost
//       pickup specifically (repair is an instant one-shot, no window).
//     controller.dispose() -> removes meshes from the scene
//
// SOLO ONLY for now - deliberately. Availability lives purely in local state
// (`pickup.available`/`pickup.respawnAt`) below. The previous multiplayer-sync
// prompt's remote-car position sync has NOT yet been verified with two real
// browser windows (Firebase Anonymous sign-in is still disabled in the
// console, blocking a second real identity to test with - see chat), and this
// prompt's own instructions say not to build more synced state on top of an
// unverified base. So there is no /rooms/{code}/pickups/{id} read/write here.
//
// The seam for adding that later is small and contained: swap the two
// `pickup.available`/`respawnAt` local reads/writes in update() below for a
// write-on-collect + read-from-the-existing-room-listener, following exactly
// the same "write once, respawn is derived from the timestamp on every
// client, never a second write" pattern this task's spec already describes -
// nothing else in this file would need to change.
// ============================================================================

import * as THREE from "three";

const HOVER_HEIGHT = 1.3;       // m above the road
const TRIGGER_RADIUS = 3.2;     // m, proximity trigger (generous - arcade feel)
const RESPAWN_MS = 8000;
const BOOST_MS = 1800;
const BOOST_FORCE_N = 2600;     // ~half of TUNING.ENGINE_FORCE, continuous for BOOST_MS
const REPAIR_AMOUNT = 35;       // % health restored per repair pickup (main.js clamps at 100)
const BOB_AMPLITUDE = 0.28;
const BOB_SPEED = 2.4;
const SPIN_SPEED = 1.8;

function buildBoostMesh() {
  // Visual only: additive glowing lightning bolt inside a spinning ring (same gold/orange as before).
  const g = new THREE.Group();
  const sh = new THREE.Shape();
  [[0.16, 1], [-0.38, 0.05], [-0.04, 0.05], [-0.2, -1], [0.42, -0.12], [0.06, -0.12], [0.34, 0.5]].forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y)));
  const boltGeo = new THREE.ExtrudeGeometry(sh, { depth: 0.18, bevelEnabled: false });
  boltGeo.center();
  const glow = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  const bolt = new THREE.Mesh(boltGeo, glow(0xffc23a, 0.95));
  bolt.scale.setScalar(0.9);
  const halo = new THREE.Mesh(boltGeo, glow(0xff8c00, 0.35)); // slightly larger dim copy = soft glow
  halo.scale.setScalar(1.2);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.07, 8, 32), glow(0xffa000, 0.85));
  ring.rotation.x = Math.PI / 2.4;
  g.add(bolt, halo, ring);
  g.add(new THREE.PointLight(0xffb800, 6, 8));
  return g;
}

/** Green medkit-style cross, visually distinct from the gold boost orb at a glance. */
function buildRepairMesh() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.55, 0),
    new THREE.MeshStandardMaterial({
      color: 0x3ddc84, emissive: 0x1f9e5a, emissiveIntensity: 1.8,
      roughness: 0.3, metalness: 0.05,
    })
  );
  base.castShadow = true;
  const crossMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdfffee, emissiveIntensity: 1.2, roughness: 0.3 });
  const barV = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.62, 0.24), crossMat);
  const barH = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.24, 0.24), crossMat);
  g.add(base, barV, barH);
  g.add(new THREE.PointLight(0x3ddc84, 6, 8));
  return g;
}

/**
 * @param scene  THREE.Scene to add pickup meshes to (the race scene)
 * @param track  optional: a built track (needs .pickups); the pool is pointed at it immediately.
 *               Later calls to controller.configure(track) re-point the SAME pooled meshes/lights.
 */
export function createPickups(scene, track) {
  // Fixed pool: 6 boost + 3 repair slots, created once. Every track supplies exactly that many
  // (track.pickups); configure(track) only MOVES the pooled meshes/lights, never adds or removes any,
  // so the scene's light count is constant across tracks.
  const BOOST_SLOTS = 6, REPAIR_SLOTS = 3;
  const pickups = [];
  for (let i = 0; i < BOOST_SLOTS + REPAIR_SLOTS; i++) {
    const kind = i < BOOST_SLOTS ? "boost" : "repair";
    const mesh = kind === "boost" ? buildBoostMesh() : buildRepairMesh();
    scene.add(mesh);
    // The PointLight must stay VISIBLE for the pickup's whole life: three.js rebuilds
    // every lit material's shader whenever the number of visible lights changes, which
    // froze the game for seconds on each collect and each respawn. So "hidden" means
    // meshes off + light intensity 0 - the light count never changes.
    const light = mesh.children.find((c) => c.isLight);
    const parts = mesh.children.filter((c) => !c.isLight);
    const lightIntensity = light ? light.intensity : 0;
    pickups.push({ id: `${kind}-${i}`, kind, u: 0, position: new THREE.Vector3(), mesh, light, parts, lightIntensity, available: true, respawnAt: 0, phase: i * 1.7 });
  }

  // Collect burst: ONE pooled Points (4 bursts x 12 particles), additive, fade by darkening the vertex
  // colour (additive black = invisible). Built once here, no per-frame allocation.
  const BURSTS = 4, PER = 12, LIFE = 0.45;
  const bPos = new Float32Array(BURSTS * PER * 3), bCol = new Float32Array(BURSTS * PER * 3), bVel = new Float32Array(BURSTS * PER * 3);
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute("position", new THREE.BufferAttribute(bPos, 3));
  bGeo.setAttribute("color", new THREE.BufferAttribute(bCol, 3));
  const bMat = new THREE.PointsMaterial({ size: 0.4, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const bPts = new THREE.Points(bGeo, bMat);
  bPts.frustumCulled = false; bPts.visible = false;
  scene.add(bPts);
  const bAge = new Float32Array(BURSTS).fill(-1), bTint = [[1, 0.75, 0.2], [0.25, 1, 0.55]], bKind = new Uint8Array(BURSTS);
  let bNext = 0;
  function spawnBurst(p) {
    const k = bNext; bNext = (bNext + 1) % BURSTS;
    bAge[k] = 0; bKind[k] = p.kind === "boost" ? 0 : 1; bPts.visible = true;
    for (let i = 0; i < PER; i++) {
      const j = (k * PER + i) * 3, a = Math.random() * 6.283, e = (Math.random() - 0.3) * 1.2, sp = 4 + Math.random() * 4;
      bPos[j] = p.position.x; bPos[j + 1] = p.position.y; bPos[j + 2] = p.position.z;
      bVel[j] = Math.cos(a) * sp; bVel[j + 1] = e * sp; bVel[j + 2] = Math.sin(a) * sp;
    }
  }
  function stepBursts(dt) {
    let any = false;
    for (let k = 0; k < BURSTS; k++) {
      if (bAge[k] < 0) continue;
      bAge[k] += dt;
      const f = Math.max(0, 1 - bAge[k] / LIFE), t = bTint[bKind[k]];
      for (let i = 0; i < PER; i++) {
        const j = (k * PER + i) * 3;
        bPos[j] += bVel[j] * dt; bPos[j + 1] += bVel[j + 1] * dt; bPos[j + 2] += bVel[j + 2] * dt;
        bCol[j] = t[0] * f; bCol[j + 1] = t[1] * f; bCol[j + 2] = t[2] * f;
      }
      if (bAge[k] >= LIFE) bAge[k] = -1; else any = true;
    }
    bGeo.attributes.position.needsUpdate = true; bGeo.attributes.color.needsUpdate = true;
    if (!any) bPts.visible = false;
  }

  function setShown(p, shown) {
    for (const c of p.parts) c.visible = shown;
    if (p.light) p.light.intensity = shown ? p.lightIntensity : 0;
  }

  /** Point the pool at a track's pickup layout (track.pickups: [{kind, t, position}]) and re-arm it. */
  function configure(tr) {
    const boosts = tr.pickups.filter((p) => p.kind === "boost");
    const repairs = tr.pickups.filter((p) => p.kind === "repair");
    pickups.forEach((p, i) => {
      const src = p.kind === "boost" ? boosts[i] : repairs[i - BOOST_SLOTS];
      p.available = !!src;
      p.respawnAt = 0;
      if (src) {
        p.u = src.t;
        p.position.copy(src.position).add(new THREE.Vector3(0, HOVER_HEIGHT, 0));
        p.mesh.position.copy(p.position);
      }
      setShown(p, !!src);
    });
    boostUntil = 0;
  }

  let boostUntil = 0;
  const _rel = new THREE.Vector3();

  /** Call once per race frame, after the chassis position for this frame is known. */
  function update(dt, carPosition) {
    const now = performance.now();
    const collected = [];

    for (const p of pickups) {
      // Respawn: derived purely from the timestamp, checked independently by
      // whichever client is looking - no second "available: true" write/event
      // needed, even once this grows a Firebase-backed version (see file header).
      if (!p.available && now > p.respawnAt) {
        p.available = true;
        setShown(p, true);
      }

      if (p.available) {
        _rel.subVectors(carPosition, p.position);
        _rel.y = 0; // ignore ride height / suspension bob for the proximity check
        if (_rel.lengthSq() < TRIGGER_RADIUS * TRIGGER_RADIUS) {
          p.available = false;
          p.respawnAt = now + RESPAWN_MS;
          setShown(p, false);
          spawnBurst(p);
          if (p.kind === "boost") boostUntil = now + BOOST_MS;
          collected.push({ kind: p.kind });
        }
      }

      // Idle bob + spin (purely cosmetic, runs regardless of availability so a
      // just-hidden pickup doesn't leave a frozen mesh mid-animation on respawn).
      p.mesh.rotation.y += dt * SPIN_SPEED;
      p.mesh.position.y = p.position.y + Math.sin(now / 1000 * BOB_SPEED + p.phase) * BOB_AMPLITUDE;
    }

    if (bPts.visible) stepBursts(dt);
    return { collected, boosted: now < boostUntil };
  }

  /** Make every pickup available again (pooled across races - see main.js ensurePickups). */
  function reset() {
    for (const p of pickups) { p.available = true; p.respawnAt = 0; setShown(p, true); }
    boostUntil = 0;
  }

  function dispose() {
    scene.remove(bPts); bGeo.dispose(); bMat.dispose();
    for (const p of pickups) {
      scene.remove(p.mesh);
      p.mesh.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } // (bolt+halo share one geometry: double dispose is harmless)
      });
    }
  }

  if (track) configure(track);
  return { update, reset, configure, dispose, BOOST_FORCE_N, REPAIR_AMOUNT };
}
