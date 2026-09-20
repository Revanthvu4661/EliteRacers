// ============================================================================
// tree-textures.js - canvas-generated textures for the procedural trees. No asset files,
// no downloads: every pixel here is drawn with the 2D canvas API at load time.
//
//   makeBarkTexture(species, seed)   tiling vertical-grain bark (RepeatWrapping on V)
//   makeLeafTexture(species, seed)   one leaf CLUSTER on transparent pixels, for alpha-tested
//                                    cards: many small leaves, colour variation, dark interior,
//                                    highlights on the lit side
//   makeContactTexture()             soft radial gradient for the ground-contact decals
//
// All of them are created BEFORE the race (during the loading state) and disposed by the owner
// (trees.js keeps the list). Sizes are deliberately small: bark 128x512, leaves 256x256 - they
// are seen at speed, and texture memory is the thing a phone runs out of first.
//
// alphaTest note: the leaf textures are drawn with FULLY opaque leaves on fully transparent
// background, so an alphaTest cut (no blending, no depth sorting) gives clean edges. Mipmaps
// shrink alpha toward the threshold at distance, which is why trees.js uses a low cut (0.35)
// rather than the usual 0.5 - at 0.5 the far leaf cards visibly thin out.
// ============================================================================

import * as THREE from "three";
import { makeRng } from "./themes.js?v=87";

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Bark
// ---------------------------------------------------------------------------
// Per-species bark look. `base` is the mid tone, `dark`/`light` drive the grain, `marks` adds
// the horizontal lenticels that make birch read as birch.
const BARK = {
  broadleaf: { base: "#9a7d5c", dark: "#5e4832", light: "#c2a782", grain: 150, cracks: 26, marks: 0, roughEdge: 1 },
  conifer:   { base: "#8b6647", dark: "#513823", light: "#b58a63", grain: 170, cracks: 34, marks: 0, roughEdge: 1.25 },
  birch:     { base: "#e3ded2", dark: "#a9a292", light: "#f8f6ef", grain: 70,  cracks: 6,  marks: 26, roughEdge: 0.35 },
  poplar:    { base: "#a5a28c", dark: "#6f6b53", light: "#c0bda6", grain: 120, cracks: 14, marks: 6,  roughEdge: 0.6 },
};

export function makeBarkTexture(species, seed) {
  const S = BARK[species] || BARK.broadleaf;
  const rnd = makeRng(seed >>> 0);
  const W = 128, H = 512;
  const c = makeCanvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = S.base;
  g.fillRect(0, 0, W, H);

  // Vertical grain: long wavy strokes down the trunk. Each stroke wanders a little in x so the
  // bark does not read as a barcode.
  for (let i = 0; i < S.grain; i++) {
    const x0 = rnd() * W;
    const dark = rnd() < 0.55;
    g.strokeStyle = dark ? S.dark : S.light;
    g.globalAlpha = 0.06 + rnd() * 0.22;
    g.lineWidth = 0.6 + rnd() * (2.2 * S.roughEdge);
    g.beginPath();
    let x = x0;
    g.moveTo(x, -8);
    for (let y = 0; y <= H + 8; y += 26) {
      x += (rnd() - 0.5) * 3.4 * S.roughEdge;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;

  // Cracks: short, darker, near-vertical gouges with a soft edge.
  for (let i = 0; i < S.cracks; i++) {
    const x = rnd() * W, y = rnd() * H, len = 20 + rnd() * 90;
    g.strokeStyle = S.dark;
    g.globalAlpha = 0.25 + rnd() * 0.4;
    g.lineWidth = 1 + rnd() * 2.4;
    g.beginPath();
    g.moveTo(x, y);
    let cx = x;
    for (let k = 0; k < len; k += 14) { cx += (rnd() - 0.5) * 5; g.lineTo(cx, y + k); }
    g.stroke();
  }
  g.globalAlpha = 1;

  // Birch/poplar lenticels: dark horizontal dashes, the single most recognisable birch cue.
  for (let i = 0; i < S.marks; i++) {
    const y = rnd() * H, w = 10 + rnd() * 46, h = 2 + rnd() * 5;
    g.fillStyle = "#2c2a24";
    g.globalAlpha = 0.5 + rnd() * 0.45;
    g.beginPath();
    g.ellipse(rnd() * W, y, w / 2, h / 2, 0, 0, 7);
    g.fill();
    // a soft light edge under the mark, like peeling bark
    g.globalAlpha = 0.25;
    g.fillStyle = S.light;
    g.fillRect(rnd() * W - w / 2, y + h, w, 1.5);
  }
  g.globalAlpha = 1;

  // Vertical shading: the texture wraps around the trunk, so a dark band on one side reads as
  // a terminator and gives the cylinder volume the low-poly silhouette cannot.
  const grd = g.createLinearGradient(0, 0, W, 0);
  grd.addColorStop(0, "rgba(0,0,0,0.20)");
  grd.addColorStop(0.42, "rgba(0,0,0,0)");
  grd.addColorStop(0.72, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(0,0,0,0.17)");
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------
// Leaf clusters
// ---------------------------------------------------------------------------
// One tile = one clump of foliage seen against nothing. Drawn back-to-front: dark leaves first
// (they become the interior), mid leaves, then a few bright ones catching the sun, so the card
// has depth of its own before any lighting is applied.
const LEAF = {
  broadleaf: { n: 190, hue: [82, 124], sat: [34, 62], lit: [26, 58], len: [12, 30], wide: 0.62, kind: "blade" },
  conifer:   { n: 250, hue: [92, 138], sat: [28, 52], lit: [28, 56], len: [15, 34], wide: 0.16, kind: "needle" },
  birch:     { n: 200, hue: [68, 100], sat: [40, 66], lit: [36, 68], len: [9, 20],  wide: 0.78, kind: "blade" },
  poplar:    { n: 210, hue: [66, 100], sat: [36, 62], lit: [32, 62], len: [10, 22], wide: 0.7,  kind: "blade" },
};

/** One pointed-oval leaf at (x,y), rotated, filled with `fill`. */
function leafBlade(g, x, y, len, wide, ang, fill) {
  const w = len * wide;
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, -len / 2);
  g.quadraticCurveTo(w / 2, 0, 0, len / 2);
  g.quadraticCurveTo(-w / 2, 0, 0, -len / 2);
  g.fill();
  g.restore();
}

/** A needle spray: a short stem with many needles along it, for conifers. */
function needleSpray(g, x, y, len, ang, fill) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.strokeStyle = fill;
  g.lineWidth = 1.15;
  g.beginPath();
  g.moveTo(0, -len / 2); g.lineTo(0, len / 2);
  for (let t = -len / 2; t < len / 2; t += 2.4) {
    const s = (1 - Math.abs(t) / (len / 2)) * len * 0.3 + 2;
    g.moveTo(0, t); g.lineTo(-s, t + s * 0.8);
    g.moveTo(0, t); g.lineTo(s, t + s * 0.8);
  }
  g.stroke();
  g.restore();
}

export function makeLeafTexture(species, seed) {
  const L = LEAF[species] || LEAF.broadleaf;
  const rnd = makeRng(seed >>> 0);
  const N = 256;
  const c = makeCanvas(N, N);
  const g = c.getContext("2d");
  g.clearRect(0, 0, N, N);

  const cx = N / 2, cy = N / 2;
  // Three passes, dark -> light. `depth` biases both the lightness and how far from the tile
  // centre a leaf is allowed to sit, which is what produces a dark core with a lit rim.
  const passes = [
    { count: Math.round(L.n * 0.42), depth: 0.0, spread: 0.30, scale: 1.05 },
    { count: Math.round(L.n * 0.38), depth: 0.5, spread: 0.40, scale: 1.0 },
    { count: Math.round(L.n * 0.20), depth: 1.0, spread: 0.46, scale: 0.9 },
  ];
  for (const p of passes) {
    for (let i = 0; i < p.count; i++) {
      // Gaussian-ish clump: two uniforms averaged pulls samples toward the middle.
      const a = rnd() * Math.PI * 2;
      const r = ((rnd() + rnd()) / 2) * N * p.spread;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.88;
      // Interior (small r) stays dark; the rim and the top get the light.
      const rim = Math.min(1, r / (N * p.spread));
      const up = 1 - y / N;
      const lit = L.lit[0] + (L.lit[1] - L.lit[0]) * (0.25 * p.depth + 0.45 * rim + 0.45 * up) * (0.7 + rnd() * 0.6);
      const hue = L.hue[0] + rnd() * (L.hue[1] - L.hue[0]);
      const sat = L.sat[0] + rnd() * (L.sat[1] - L.sat[0]);
      const fill = "hsl(" + hue.toFixed(0) + "," + sat.toFixed(0) + "%," + Math.max(6, Math.min(72, lit)).toFixed(0) + "%)";
      const len = (L.len[0] + rnd() * (L.len[1] - L.len[0])) * p.scale;
      if (L.kind === "needle") needleSpray(g, x, y, len, rnd() * Math.PI * 2, fill);
      else leafBlade(g, x, y, len, L.wide * (0.75 + rnd() * 0.5), rnd() * Math.PI * 2, fill);
    }
  }

  // A handful of bright specular leaves on the sunlit (upper-left) side.
  for (let i = 0; i < Math.round(L.n * 0.08); i++) {
    const x = cx + (rnd() - 0.75) * N * 0.5;
    const y = cy + (rnd() - 0.8) * N * 0.5;
    const hue = L.hue[0] + rnd() * (L.hue[1] - L.hue[0]);
    const fill = "hsl(" + hue.toFixed(0) + "," + (L.sat[1] * 0.8).toFixed(0) + "%," + (L.lit[1] + 12).toFixed(0) + "%)";
    if (L.kind === "needle") needleSpray(g, x, y, L.len[1] * 0.8, rnd() * 6.28, fill);
    else leafBlade(g, x, y, L.len[1] * 0.8, L.wide, rnd() * 6.28, fill);
  }

  // Feather the tile edge so a card never ends on a straight alpha cut.
  const img = g.getImageData(0, 0, N, N);
  const d = img.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      if (!d[i + 3]) continue;
      const dx = (x - cx) / cx, dy = (y - cy) / cy;
      const rr = Math.sqrt(dx * dx + dy * dy);
      if (rr > 0.86) d[i + 3] = 0;               // hard-clip the corners
      else if (rr > 0.7) d[i + 3] = d[i + 3] * (1 - (rr - 0.7) / 0.16);
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------
// Ground contact
// ---------------------------------------------------------------------------
/** Soft dark blob: one of these under each tree is what sells "planted" without a shadow map. */
export function makeContactTexture() {
  const N = 64;
  const c = makeCanvas(N, N);
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0, "rgba(0,0,0,0.62)");
  grd.addColorStop(0.45, "rgba(0,0,0,0.34)");
  grd.addColorStop(0.78, "rgba(0,0,0,0.10)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
