// ============================================================================
// physics.js - Cannon-es world + raycast vehicle.
//
// Conventions (match cannon's RaycastVehicle): chassis-local +X = forward,
// +Y = up, +Z = the car's right side. car-model.js models face -Z, so main.js
// rotates the visual by -90deg about Y to line up.
//
// ---------------------------- TUNING KNOBS ----------------------------------
// Tweak these live. Each is scaled by the selected car's stats (cars.js) so the
// three cars feel different without extra code.
// ----------------------------------------------------------------------------
export const TUNING = {
  MAX_SPEED_KMH: 215,        // at stats.topSpeed = 1
  REVERSE_SPEED_KMH: 40,
  ENGINE_FORCE: 5200,        // at stats.acceleration = 1
  BRAKE_FORCE: 260,          // impulse clamp per step when braking
  ENGINE_BRAKE: 6,           // coasting drag
  HANDBRAKE_FORCE: 14,       // rear wheels while drifting: a light bite, not a stop.
                             // cannon-es uses "brake" as a per-step friction-impulse
                             // clamp, not a drag coefficient - even a modest value here
                             // dwarfs the wheel's own support impulse and kills all
                             // speed in under a second. The slide should come mostly
                             // from DRIFT_FRICTION_SLIP (reduced rear grip), not this.
  MAX_STEER_RAD: 0.19,       // at stats.handling = 1 (~11 deg -> ~14m turn radius with this
                             // 2.65m wheelbase). Keyboard steer is full-lock-only (no analog
                             // range), so this single fixed angle has to work for the whole
                             // track. Measured every curve on the actual generated circuit:
                             // the tightest corner anywhere on it is a 15m radius, while most
                             // of the track (including the first corner after the start line)
                             // is a gentle 60m+ sweeper. The old 0.30 rad (~9m radius) was
                             // still 6-7x tighter than those gentle curves, so even a brief,
                             // well-timed tap overshot them and clipped the inside barrier -
                             // every technique (hold, brief tap, tap-while-braking) failed the
                             // same way on the very first bend. 0.19 rad can just complete the
                             // sharpest corner on the track (at the low speed a corner that
                             // tight demands anyway) while no longer wildly out-turning the
                             // gentle ones that make up most of the lap.
  STEER_SPEED: 4.5,          // responsiveness of steering input. Lower = the wheel eases
                             // toward its target instead of snapping there in ~0.15s.
  HIGH_SPEED_STEER_CUT: 0.4,  // additional steering lock reduction at top speed (0..1), on
                             // top of MAX_STEER_RAD above. This still trims lock at speed
                             // for stability, but not so much that a held turn through an
                             // accelerating corner widens into understeer as speed builds -
                             // MAX_STEER_RAD itself already does most of the low-speed-spin
                             // taming now, so this doesn't need to do as much on top of it.
  DRIFT_STEER_CUT: 0.45,     // extra steering lock reduction while handbrake is held
  FRICTION_SLIP: 3.8,        // lateral grip; lower => more slide. Raised from 3.2 so the
                             // tyres keep up with the lateral load at 150+ km/h (cause #3).
  DRIFT_FRICTION_SLIP: 2.1,  // rear grip while handbrake held. Keyboard steering is
                             // full-lock only (no analog input), so this needs enough
                             // rear grip left that a max-steer handbrake tap steps the
                             // rear out into a controllable slide instead of an
                             // instant, unrecoverable spin.
  OFFROAD_GRIP: 0.55,        // grip multiplier on grass
  OFFROAD_DRAG: 0.35,        // extra linear damping on grass
  MASS: 420,
  SUSPENSION_STIFFNESS: 58,  // stiffer: less body lean at speed (cause #5)
  SUSPENSION_REST: 0.3,
  SUSPENSION_TRAVEL: 0.22,
  DAMPING_RELAX: 3.4,        // more rebound damping: no oscillation at speed
  DAMPING_COMPRESS: 5.6,     // more bump damping
  DOWNFORCE: 16,             // N per (m/s) of speed, pushes the car down. Raised so the
                             // car is planted harder the faster it goes (helps #4/#5).
  UPRIGHT_TORQUE: 40,        // arcade anti-roll: torque (x mass) pulling the car level.
                             // Was 95, cranked up to fight the bogus downforce torque
                             // (see preStep); with that fixed it only needs a light touch.
  UPRIGHT_DAMPING: 10,       // damping on roll/pitch angular velocity (x mass)
  MAX_YAW_RATE: 2.2,         // rad/s (~126 deg/s) cap on spin speed before the limiter bites
  YAW_RATE_DAMPING: 14,      // how hard the limiter pushes back past MAX_YAW_RATE (x mass)
  GRAVITY: -9.82,
  FIXED_STEP: 1 / 60,
  MAX_SUBSTEPS: 5,
};

import * as CANNON from "cannon-es";

const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Barrier-hit reaction (additive - kept separate from TUNING above so that
// object's diff stays exactly zero; nothing here changes any already-tuned
// constant or the wheel-sync/postStep code path). Hooks into the EXISTING
// chassisBody "collide" listener below (already there, already used for
// camera shake/commentary) rather than adding a second collision-detection
// path, and applies its steering effect as a single guarded multiplier
// (=== 1, a no-op, whenever no recent hard hit occurred) on the existing
// per-frame steering-target line in update() below, rather than a parallel,
// separately-timed system.
// ---------------------------------------------------------------------------
const IMPACT_HARD_THRESHOLD = 6;        // m/s impact velocity - matches the existing
                                         // "crash" commentary cutoff in main.js's
                                         // onCollide, so "hard enough to comment on"
                                         // and "hard enough to physically react to" agree.
const IMPACT_SPEED_CUT = 0.45;          // fraction of speed removed on a hard hit (40-50%)
const IMPACT_RECOVER_MS = 500;          // how long steering stays sluggish afterward
const IMPACT_MIN_STEER_RESPONSE = 0.3;  // never fully dead - "recovering", not locked out

/** Create the physics world (ground + track colliders are added by track.js). */
export function createWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, TUNING.GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.defaultContactMaterial.friction = 0.12; // walls: slide, don't grab
  world.defaultContactMaterial.restitution = 0.2;
  world.defaultContactMaterial.contactEquationStiffness = 1e7;
  world.defaultContactMaterial.contactEquationRelaxation = 3;
  return world;
}

/** Advance the simulation with real elapsed seconds. */
export function stepWorld(world, dt) {
  world.step(TUNING.FIXED_STEP, dt, TUNING.MAX_SUBSTEPS);
}

/**
 * Build a raycast vehicle for a car.
 * @param world       CANNON.World
 * @param carConfig   entry from cars.js (uses .stats)
 * @param layout      { wheels: [{x, z, radius, isFront}], halfLength, halfWidth, centerX }
 *                    in chassis frame (+X forward, +Z right). y is derived.
 * @param onCollide   (impactSpeed) => void  for shake / commentary
 */
export function createVehicle(world, carConfig, layout, onCollide = () => {}) {
  const s = carConfig.stats;
  const maxSpeedKmh = TUNING.MAX_SPEED_KMH * lerp(0.72, 1, s.topSpeed);
  const engineForce = TUNING.ENGINE_FORCE * lerp(0.7, 1, s.acceleration);
  const maxSteer = TUNING.MAX_STEER_RAD * lerp(0.78, 1, s.handling);
  const baseSlip = TUNING.FRICTION_SLIP * lerp(0.85, 1.15, s.handling);

  const CONNECT_Y = 0.25;
  const radius = layout.wheels[0].radius;
  // Chassis origin height above ground at suspension rest.
  const restHeight = radius + TUNING.SUSPENSION_REST - CONNECT_Y;

  const chassisBody = new CANNON.Body({ mass: TUNING.MASS });
  chassisBody.addShape(
    new CANNON.Box(new CANNON.Vec3(layout.halfLength, 0.3, layout.halfWidth)),
    new CANNON.Vec3(layout.centerX, 0.35, 0)
  );
  chassisBody.angularDamping = 0.6;
  chassisBody.linearDamping = 0.02;

  const vehicle = new CANNON.RaycastVehicle({
    chassisBody, indexRightAxis: 2, indexUpAxis: 1, indexForwardAxis: 0,
  });

  for (const w of layout.wheels) {
    vehicle.addWheel({
      radius: w.radius,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      axleLocal: new CANNON.Vec3(0, 0, 1),
      chassisConnectionPointLocal: new CANNON.Vec3(w.x, CONNECT_Y, w.z),
      suspensionStiffness: TUNING.SUSPENSION_STIFFNESS,
      suspensionRestLength: TUNING.SUSPENSION_REST,
      maxSuspensionTravel: TUNING.SUSPENSION_TRAVEL,
      dampingRelaxation: TUNING.DAMPING_RELAX,
      dampingCompression: TUNING.DAMPING_COMPRESS,
      frictionSlip: baseSlip,
      maxSuspensionForce: 1e5,
      rollInfluence: 0.01,
      customSlidingRotationalSpeed: -30,
      useCustomSlidingRotationalSpeed: true,
    });
  }
  vehicle.addToWorld(world);

  chassisBody.addEventListener("collide", (e) => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (v > 2.5) onCollide(v);
    // Barrier-hit reaction (additive - the line above is untouched). A real
    // hit knocks off speed and leaves steering mushy for a beat; light scrapes
    // (below the threshold) don't trigger it at all.
    if (v > IMPACT_HARD_THRESHOLD) {
      chassisBody.velocity.scale(1 - IMPACT_SPEED_CUT, chassisBody.velocity);
      impactRecoverUntil = performance.now() + IMPACT_RECOVER_MS;
    }
  });

  // --- runtime state ---------------------------------------------------------
  let steer = 0;
  let surfaceGrip = 1;
  let handbrakeHeld = false;
  let impactRecoverUntil = 0; // performance.now() timestamp; see IMPACT_* above
  const fwdWorld = new CANNON.Vec3();
  const tmp = new CANNON.Vec3();
  let boostForce = 0; // N, continuous forward force while a pickup boost is active (Task 1)

  function forwardSpeed() {
    chassisBody.quaternion.vmult(new CANNON.Vec3(1, 0, 0), fwdWorld);
    return fwdWorld.dot(chassisBody.velocity);
  }

  /**
   * input: { throttle: -1..1, steer: -1..1 (+ = left), handbrake: bool }
   * Call once per rendered frame before stepWorld().
   */
  function update(input, dt) {
    handbrakeHeld = Boolean(input.handbrake);
    const kmh = chassisBody.velocity.length() * 3.6;
    const fwd = forwardSpeed();
    const speedRatio = Math.min(1, kmh / maxSpeedKmh);

    // Steering: smooth toward target, less lock at speed, and less lock while
    // handbraking. Full front-wheel lock throughout a slide mostly adds lateral
    // translation, not rotation, once the rear has already broken loose - it's
    // the reduced rear grip that spins the car, not more front steer. Cutting
    // the lock keeps the drift from carrying so far sideways on a held input.
    const steerCut = TUNING.HIGH_SPEED_STEER_CUT * speedRatio + (input.handbrake ? TUNING.DRIFT_STEER_CUT : 0);
    // Barrier-hit steering recovery (additive multiplier, === 1 - a complete no-op -
    // whenever no recent hard impact occurred; see IMPACT_* above). Mushy, not dead,
    // per IMPACT_MIN_STEER_RESPONSE, and ramps back to 1 over IMPACT_RECOVER_MS.
    const impactT = Math.max(0, Math.min(1, (impactRecoverUntil - performance.now()) / IMPACT_RECOVER_MS));
    const steerResponse = impactT > 0 ? lerp(1, IMPACT_MIN_STEER_RESPONSE, impactT) : 1;
    const target = input.steer * maxSteer * (1 - Math.min(0.85, steerCut)) * steerResponse;
    steer += (target - steer) * (1 - Math.exp(-TUNING.STEER_SPEED * dt));
    // Steering is applied to the front wheel indices only (0 = fl, 1 = fr, matching
    // layout.wheels' order in car-model.js/main.js). Rear indices 2/3 are never
    // steered, so their wheelInfos[i].steering stays 0 for the visual sync.
    vehicle.setSteeringValue(steer, 0);
    vehicle.setSteeringValue(steer, 1);

    // Throttle / brake / reverse.
    let force = 0, brake = 0;
    if (input.throttle > 0.01) {
      if (fwd < -1) brake = TUNING.BRAKE_FORCE;
      else force = engineForce * input.throttle * surfaceGrip * Math.max(0, 1 - Math.pow(speedRatio, 3));
    } else if (input.throttle < -0.01) {
      if (fwd > 1) brake = TUNING.BRAKE_FORCE;
      else force = -engineForce * 0.45 * surfaceGrip * Math.max(0, 1 - Math.pow(kmh / TUNING.REVERSE_SPEED_KMH, 3));
    } else {
      brake = TUNING.ENGINE_BRAKE;
    }

    // Front 40 / rear 60 split: forgiving arcade feel.
    vehicle.applyEngineForce(force * 0.4, 0);
    vehicle.applyEngineForce(force * 0.4, 1);
    vehicle.applyEngineForce(force * 0.6, 2);
    vehicle.applyEngineForce(force * 0.6, 3);

    const rearSlip = (input.handbrake ? TUNING.DRIFT_FRICTION_SLIP : baseSlip) * surfaceGrip;
    const frontSlip = baseSlip * surfaceGrip;
    vehicle.wheelInfos[0].frictionSlip = frontSlip;
    vehicle.wheelInfos[1].frictionSlip = frontSlip;
    vehicle.wheelInfos[2].frictionSlip = rearSlip;
    vehicle.wheelInfos[3].frictionSlip = rearSlip;

    for (let i = 0; i < 4; i++) vehicle.setBrake(brake, i);
    if (input.handbrake) {
      vehicle.setBrake(TUNING.HANDBRAKE_FORCE, 2);
      vehicle.setBrake(TUNING.HANDBRAKE_FORCE, 3);
    }

    chassisBody.linearDamping = 0.02 + (1 - surfaceGrip) * TUNING.OFFROAD_DRAG;
  }

  // Per-substep forces (cannon clears forces after every substep, so anything
  // applied once per frame would only hit the first substep).
  const upWorld = new CANNON.Vec3();
  const torque = new CANNON.Vec3();
  function preStep() {
    // Downforce keeps it planted at speed. Applied at the centre of mass: cannon's
    // applyForce(force, relativePoint) takes a point RELATIVE to the centre of
    // mass and adds relativePoint x force as torque. An earlier version passed
    // chassisBody.position (a world coordinate, 60-150 m long) here, which turned
    // this into a pitch torque of tens of thousands of N.m that grew with speed
    // and changed with where the car was on the track - the actual source of the
    // "car tips / flies / twitches as it gets faster" instability.
    tmp.set(0, -TUNING.DOWNFORCE * chassisBody.velocity.length(), 0);
    chassisBody.applyForce(tmp);

    // Arcade anti-roll: torque toward upright + damping on roll/pitch rates.
    chassisBody.quaternion.vmult(new CANNON.Vec3(0, 1, 0), upWorld);
    const m = chassisBody.mass;
    const av = chassisBody.angularVelocity;
    // Yaw-rate limiter: ONLY while the handbrake is held. Without a driver
    // countersteering, full-lock steer + handbrake is a positive-feedback loop
    // (more slip angle -> more lateral tire force -> more yaw rate -> more slip
    // angle) that spins up forever instead of settling into a slide. Past
    // MAX_YAW_RATE, push back proportionally to the overshoot so a held drift
    // settles into a bounded, controllable rotation instead of an
    // ever-accelerating spin.
    //
    // This must NOT run during normal (non-handbrake) driving: a full-grip,
    // no-slip turn at speed can easily need MORE than MAX_YAW_RATE of rotation
    // to track a tight corner (e.g. ~90 km/h at full steering lock implies well
    // over 2 rad/s just from the bicycle-model geometry, no sliding involved).
    // Capping that unconditionally fought the driver's own steering input on
    // ordinary corners, producing exactly the jerky "car snaps/won't turn
    // right" feel this was meant to prevent.
    const yawOver = handbrakeHeld && Math.abs(av.y) > TUNING.MAX_YAW_RATE
      ? av.y - Math.sign(av.y) * TUNING.MAX_YAW_RATE
      : 0;

    torque.set(
      -upWorld.z * TUNING.UPRIGHT_TORQUE * m - av.x * TUNING.UPRIGHT_DAMPING * m,
      -yawOver * TUNING.YAW_RATE_DAMPING * m,
      upWorld.x * TUNING.UPRIGHT_TORQUE * m - av.z * TUNING.UPRIGHT_DAMPING * m
    );
    chassisBody.applyTorque(torque);

    // Boost pickup (Task 1, additive) - applied here rather than in update() so it's
    // correctly re-applied every physics substep, same reason the downforce above has
    // to be: cannon clears applied forces after each substep, so anything applied once
    // per rendered frame (update() runs once per frame, before stepWorld()) would only
    // ever hit the first substep. Set via the new setBoost() below; a fully separate
    // force from the engine-force pipeline in update(), so pickups can't touch it.
    if (boostForce !== 0) {
      chassisBody.quaternion.vmult(new CANNON.Vec3(1, 0, 0), fwdWorld);
      chassisBody.applyForce(fwdWorld.scale(boostForce, tmp));
    }
  }
  world.addEventListener("preStep", preStep);

  function reset(position, yaw) {
    chassisBody.position.set(position.x, restHeight + 0.15, position.z);
    chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    steer = 0;
    for (let i = 0; i < 4; i++) { vehicle.setSteeringValue(0, i); vehicle.applyEngineForce(0, i); vehicle.setBrake(0, i); }
  }

  /** Snap the car level (keeps position, heading and speed). Used when it ends up on its side. */
  function level() {
    chassisBody.quaternion.vmult(new CANNON.Vec3(1, 0, 0), fwdWorld);
    const yaw = Math.atan2(-fwdWorld.z, fwdWorld.x);
    chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.position.y = Math.max(chassisBody.position.y, restHeight + 0.2);
  }

  /** Chassis-local wheel centre (connection point + current suspension travel). */
  function wheelLocalPosition(i, out) {
    const w = vehicle.wheelInfos[i];
    const len = Number.isFinite(w.suspensionLength) ? w.suspensionLength : TUNING.SUSPENSION_REST;
    out.set(w.chassisConnectionPointLocal.x, w.chassisConnectionPointLocal.y - len, w.chassisConnectionPointLocal.z);
    return out;
  }

  /**
   * Authoritative per-wheel visual state, straight from cannon's RaycastVehicle
   * (updated every physics substep in updateWheelTransform/updateFriction; not a
   * value we track separately, so it can't drift out of sync with the physics):
   *   steering  current steer angle (0 for wheels we never call setSteeringValue on)
   *   rotation  accumulated roll angle about the axle, slip-aware (wheelspin under
   *             throttle and lock-up under braking show correctly, not just a
   *             naive chassis-speed/radius estimate)
   */
  function wheelInfo(i) {
    const w = vehicle.wheelInfos[i];
    return { steering: w.steering, rotation: w.rotation, radius: w.radius, isInContact: w.isInContact };
  }

  return {
    chassisBody,
    vehicle,
    maxSpeedKmh,
    restHeight,
    update,
    reset,
    level,
    forwardSpeed,
    speedKmh: () => chassisBody.velocity.length() * 3.6,
    setSurfaceGrip: (g) => { surfaceGrip = g; },
    setBoost: (forceN) => { boostForce = forceN; }, // Task 1 (additive) - 0 = no-op
    wheelLocalPosition,
    wheelInfo,
    isUpsideDown: () => { chassisBody.quaternion.vmult(new CANNON.Vec3(0, 1, 0), tmp); return tmp.y < 0.2; },
    isOnSide: () => { chassisBody.quaternion.vmult(new CANNON.Vec3(0, 1, 0), tmp); return tmp.y < 0.55; },
    dispose: () => { world.removeEventListener("preStep", preStep); vehicle.removeFromWorld(world); },
  };
}
