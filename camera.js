// ============================================================================
// camera.js - chase / cockpit / cinematic rigs with smooth blending, FOV punch
// and screen shake.
//
//   const rig = createCameraRig(camera);
//   rig.update(dt, target)   target = { position: Vector3, quaternion: Quaternion,
//                                       speedRatio: 0..1 }
//   rig.cycle() / rig.setMode(name) / rig.shake(strength) / rig.snap(target)
// ============================================================================

import * as THREE from "three";

export const CAMERA_MODES = ["chase", "cockpit", "cinematic"];

// Offsets are in chassis-local space: +X forward, +Y up, +Z right.
export const CAMERA_TUNING = {
  chase:     { offset: new THREE.Vector3(-9.5, 4.0, 0), look: new THREE.Vector3(6, 1.0, 0), posLerp: 5.5, lookLerp: 9, fov: 68 },
  cockpit:   { offset: new THREE.Vector3(-0.15, 0.78, -0.36), look: new THREE.Vector3(30, 0.6, 0), posLerp: 30, lookLerp: 30, fov: 82 },
  cinematic: { radius: 11, height: 4.2, orbitSpeed: 0.32, posLerp: 3, lookLerp: 5, fov: 52 },
  fovPunchMax: 13,     // extra degrees at top speed
  fovLerp: 4,
  shakeDecay: 7,       // per second
  shakeScale: 0.35,    // metres at strength 1
  blendTime: 0.9,      // seconds of slower lerp after a mode switch
};

export function createCameraRig(camera) {
  let mode = "chase";
  let blend = 0;
  let orbitAngle = 0;
  let shakeStrength = 0;
  const shakeOffset = new THREE.Vector3();
  const desiredPos = new THREE.Vector3();
  const desiredLook = new THREE.Vector3();
  const currentLook = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let initialised = false;

  function computeTargets(target) {
    const t = CAMERA_TUNING[mode];
    if (mode === "cinematic") {
      desiredPos.set(Math.cos(orbitAngle) * t.radius, t.height, Math.sin(orbitAngle) * t.radius).add(target.position);
      desiredLook.copy(target.position).add(tmp.set(0, 0.8, 0));
    } else {
      desiredPos.copy(t.offset).applyQuaternion(target.quaternion).add(target.position);
      desiredLook.copy(t.look).applyQuaternion(target.quaternion).add(target.position);
    }
  }

  function update(dt, target) {
    const t = CAMERA_TUNING[mode];
    orbitAngle += dt * CAMERA_TUNING.cinematic.orbitSpeed;
    computeTargets(target);

    if (!initialised) { snap(target); return; }

    // Slower blend right after a mode switch so it feels like a camera move, not a cut.
    const slow = blend > 0 ? 0.45 : 1;
    blend = Math.max(0, blend - dt);
    const kp = 1 - Math.exp(-t.posLerp * slow * dt);
    const kl = 1 - Math.exp(-t.lookLerp * slow * dt);
    camera.position.lerp(desiredPos, kp);
    currentLook.lerp(desiredLook, kl);

    // Shake
    shakeStrength = Math.max(0, shakeStrength - shakeStrength * CAMERA_TUNING.shakeDecay * dt);
    if (shakeStrength > 0.001) {
      shakeOffset.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2)
        .multiplyScalar(shakeStrength * CAMERA_TUNING.shakeScale);
      camera.position.add(shakeOffset);
    }

    camera.lookAt(currentLook);

    // FOV punch with speed.
    const targetFov = t.fov + CAMERA_TUNING.fovPunchMax * Math.pow(target.speedRatio || 0, 2);
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-CAMERA_TUNING.fovLerp * dt));
    camera.updateProjectionMatrix();
  }

  function snap(target) {
    computeTargets(target);
    camera.position.copy(desiredPos);
    currentLook.copy(desiredLook);
    camera.lookAt(currentLook);
    camera.fov = CAMERA_TUNING[mode].fov;
    camera.updateProjectionMatrix();
    initialised = true;
  }

  function setMode(next) {
    if (!CAMERA_MODES.includes(next) || next === mode) return mode;
    mode = next;
    blend = CAMERA_TUNING.blendTime;
    return mode;
  }

  return {
    update,
    snap,
    setMode,
    cycle: () => setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(mode) + 1) % CAMERA_MODES.length]),
    getMode: () => mode,
    shake: (strength) => { shakeStrength = Math.min(1.5, shakeStrength + strength); },
    reset: () => { initialised = false; shakeStrength = 0; },
  };
}
