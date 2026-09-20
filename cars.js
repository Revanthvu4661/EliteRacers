// ============================================================================
// cars.js - CAR ROSTER (asset teammates: this is your file)
//
// Each entry is one selectable car. To add a car: drop the model into
// assets/models/ and append an object here. Nothing else needs to change.
//
// Fields:
//   id          unique string
//   name        display name
//   model       path to a real car .glb (Task 7), loaded on demand and auto-fitted
//               (recentred, scaled to the Ferrari's length, wheels baked/static) by
//               car-model.js. null => the bundled tinted Ferrari (assets/models/ferrari.glb).
//               Any load failure / 404 / timeout falls back to the tinted Ferrari.
//   paintMaterial  name of the model's body-paint material (re-tinted with `color`).
//               null => tint-disabled: the model keeps its own livery ("Stock only").
//   modelYaw    radians (0 or Math.PI): yaw of the real model inside its wrapper so its NOSE ends up
//               at model-frame -Z (the loader's forward; main.js then maps -Z onto the physics +X).
//               All three Sketchfab models are authored nose-at-+Z, so each needs Math.PI.
//               Wrapper-level only: physics, camera, controls and wrong-way logic never see it.
//   fit         { hideMaterials: [] } extra per-model cleanup
//   scale       uniform scale applied to the loaded model
//   color       hex paint colour (applied to the "body" mesh) + UI swatch
//   stats       0..1 values shown on the select screen AND fed into physics.js
//               (physics scales its base constants by these). Keep them distinct.
//   audioProfile { basePitchOffset (octaves), filterType, filterFrequency (Hz), filterQ, volumeMultiplier }: per-car engine tone
//   engineSound path to a loop in assets/sounds/ (stage 8). null => synth oscillator.
// ============================================================================

export const CARS = [
  {
    id: "viper",
    name: "VIPER GT",
    model: "./assets/models/ferrari-458-spider.glb",
    paintMaterial: "Vehicle_Exterior_mm_ext",
    modelYaw: Math.PI, // nose authored at +Z (cabin/windows sit toward +Z on this mid-engine car)
    fit: {},
    scale: 1,
    color: 0xd91e2a,
    stats: { topSpeed: 0.95, acceleration: 0.7, handling: 0.55 },
    audioProfile: { basePitchOffset: 0.1, filterType: "bandpass", filterFrequency: 1500, filterQ: 0.9, volumeMultiplier: 1.05 }, // engine character on top of the speed pitch (audio.js setEngineProfile)
    engineSound: null,
    blurb: "All-out speed. Twitchy in the corners.",
  },
  {
    id: "kestrel",
    name: "KESTREL",
    model: "./assets/models/huracan.glb",
    paintMaterial: null, // carbon/livery race car - no single painted-body material: tint-disabled
    modelYaw: Math.PI, // nose authored at +Z (rear plate is at -Z)
    fit: {},
    scale: 1,
    color: 0x1f6fe8,
    stats: { topSpeed: 0.7, acceleration: 0.75, handling: 0.95 },
    audioProfile: { basePitchOffset: 0, filterType: "lowpass", filterFrequency: 3000, filterQ: 0.7, volumeMultiplier: 1 }, // engine character on top of the speed pitch (audio.js setEngineProfile)
    engineSound: null,
    blurb: "Glued to the road. Wins on technical tracks.",
  },
  {
    id: "brawler",
    name: "BRAWLER",
    model: "./assets/models/bugatti-eb110.glb",
    paintMaterial: "Bugatti_EB110SS_By_Alex_Ka",
    modelYaw: Math.PI, // nose authored at +Z (exhaust is at -Z)
    fit: { hideMaterials: ["floor", "carshadow", "red_carpet"] }, // the asset ships with a floor, shadow plane and display carpet
    scale: 1,
    color: 0xf2b700,
    stats: { topSpeed: 0.8, acceleration: 0.95, handling: 0.65 },
    audioProfile: { basePitchOffset: -0.18, filterType: "lowpass", filterFrequency: 850, filterQ: 1.2, volumeMultiplier: 1.1 }, // engine character on top of the speed pitch (audio.js setEngineProfile)
    engineSound: null,
    blurb: "Rockets off the line. Heavy but forgiving.",
  },
  {
    id: "rb19",
    name: "RB19",
    model: "./assets/models/rb19.glb", // optimised copy (Draco + 1024px WebP) of the 26 MB source
    paintMaterial: null, // team livery: tint-disabled ("Stock only")
    modelYaw: Math.PI, // same half-turn as the other cars (nose was facing the chase camera without it; verified in-race)
    fit: {},
    scale: 1,
    color: 0x1b2a6b,
    stats: { topSpeed: 1.0, acceleration: 0.9, handling: 0.4 },
    audioProfile: { basePitchOffset: 0.3, filterType: "highpass", filterFrequency: 1300, filterQ: 2, volumeMultiplier: 1.1 }, // engine character on top of the speed pitch (audio.js setEngineProfile)
    engineSound: null,
    blurb: "Pure downforce. Rocket on straights, edgy in corners.",
  },
];

export const DEFAULT_CAR_ID = CARS[0].id;

export function getCar(id) {
  return CARS.find((c) => c.id === id) || CARS[0];
}
