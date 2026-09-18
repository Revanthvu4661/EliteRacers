// ============================================================================
// cars.js - CAR ROSTER (asset teammates: this is your file)
//
// Each entry is one selectable car. To add a car: drop the model into
// assets/models/ and append an object here. Nothing else needs to change.
//
// Fields:
//   id          unique string
//   name        display name
//   model       path to a .glb/.gltf. null => the bundled Ferrari (assets/models/ferrari.glb).
//               The loader expects nodes named body / wheel_fl / wheel_fr / wheel_rl / wheel_rr;
//               anything else falls back to the primitive car in car-model.js.
//   scale       uniform scale applied to the loaded model
//   color       hex paint colour (applied to the "body" mesh) + UI swatch
//   stats       0..1 values shown on the select screen AND fed into physics.js
//               (physics scales its base constants by these). Keep them distinct.
//   engineSound path to a loop in assets/sounds/ (stage 8). null => synth oscillator.
// ============================================================================

export const CARS = [
  {
    id: "viper",
    name: "VIPER GT",
    model: null,
    scale: 1,
    color: 0xd91e2a,
    stats: { topSpeed: 0.95, acceleration: 0.7, handling: 0.55 },
    engineSound: null,
    blurb: "All-out speed. Twitchy in the corners.",
  },
  {
    id: "kestrel",
    name: "KESTREL",
    model: null,
    scale: 1,
    color: 0x1f6fe8,
    stats: { topSpeed: 0.7, acceleration: 0.75, handling: 0.95 },
    engineSound: null,
    blurb: "Glued to the road. Wins on technical tracks.",
  },
  {
    id: "brawler",
    name: "BRAWLER",
    model: null,
    scale: 1,
    color: 0xf2b700,
    stats: { topSpeed: 0.8, acceleration: 0.95, handling: 0.65 },
    engineSound: null,
    blurb: "Rockets off the line. Heavy but forgiving.",
  },
];

export const DEFAULT_CAR_ID = CARS[0].id;

export function getCar(id) {
  return CARS.find((c) => c.id === id) || CARS[0];
}
