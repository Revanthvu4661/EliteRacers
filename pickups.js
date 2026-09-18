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
import { PICKUP_SPAWN_U, REPAIR_SPAWN_U } from "./track.js?v=17";

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
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.55, 0),
    new THREE.MeshStandardMaterial({
      color: 0xffe066, emissive: 0xffb800, emissiveIntensity: 2.2,
      roughness: 0.25, metalness: 0.1,
    })
  );
  core.castShadow = true;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.07, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xffb800, emissive: 0xff8c00, emissiveIntensity: 1.6, roughness: 0.4 })
  );
  ring.rotation.x = Math.PI / 2.4;
  g.add(core, ring);
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
 * @param track  the object buildTrack() returns (needs .sampleAt(u))
 */
export function createPickups(scene, track) {
  const specs = [
    ...PICKUP_SPAWN_U.map((u, i) => ({ id: `boost-${i}`, u, kind: "boost" })),
    ...REPAIR_SPAWN_U.map((u, i) => ({ id: `repair-${i}`, u, kind: "repair" })),
  ];
  const pickups = specs.map((spec, i) => {
    const s = track.sampleAt(spec.u);
    const position = s.p.clone().add(new THREE.Vector3(0, HOVER_HEIGHT, 0));
    const mesh = spec.kind === "boost" ? buildBoostMesh() : buildRepairMesh();
    mesh.position.copy(position);
    scene.add(mesh);
    return { ...spec, position, mesh, available: true, respawnAt: 0, phase: i * 1.7 };
  });

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
        p.mesh.visible = true;
      }

      if (p.available) {
        _rel.subVectors(carPosition, p.position);
        _rel.y = 0; // ignore ride height / suspension bob for the proximity check
        if (_rel.lengthSq() < TRIGGER_RADIUS * TRIGGER_RADIUS) {
          p.available = false;
          p.respawnAt = now + RESPAWN_MS;
          p.mesh.visible = false;
          if (p.kind === "boost") boostUntil = now + BOOST_MS;
          collected.push({ kind: p.kind });
        }
      }

      // Idle bob + spin (purely cosmetic, runs regardless of availability so a
      // just-hidden pickup doesn't leave a frozen mesh mid-animation on respawn).
      p.mesh.rotation.y += dt * SPIN_SPEED;
      p.mesh.position.y = p.position.y + Math.sin(now / 1000 * BOB_SPEED + p.phase) * BOB_AMPLITUDE;
    }

    return { collected, boosted: now < boostUntil };
  }

  function dispose() {
    for (const p of pickups) {
      scene.remove(p.mesh);
      p.mesh.traverse((o) => {
        if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
      });
    }
  }

  return { update, dispose, BOOST_FORCE_N, REPAIR_AMOUNT };
}
