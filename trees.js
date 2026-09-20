// ============================================================================
// trees.js - procedural trees: a seeded generator that bakes whole trees into merged
// BufferGeometry at load time, plus the runtime that instances them around a track.
//
//   TREE_SPECIES          the four species (broadleaf / conifer / birch / poplar)
//   THEME_TREES           which species (and in what mix) each THEME uses
//   TREE_QUALITY          low / med / high / mobile presets: counts, cards, LOD distances
//   createTreeAssets(themeId, quality, seed, windTime) -> assets
//        Builds every (species, variant, LOD) geometry and the shared materials ONCE, during
//        the loading state. assets.dispose() frees geometries, materials and textures.
//
// Design notes that matter:
//
//  - SKELETON FIRST, LODs SECOND. Each variant's branch skeleton is grown once from its seed;
//    all three LODs are then baked from that same skeleton by dropping depth levels, decimating
//    path points and thinning foliage cards. The LODs therefore share a silhouette by
//    construction, which is what stops LOD switches from popping - regenerating per LOD with the
//    same seed does NOT work, because each LOD consumes the RNG in a different order.
//
//  - One geometry per (variant, LOD) with TWO groups (bark, then leaves) and a two-material
//    array, so a whole tree is one InstancedMesh and exactly two draw calls.
//
//  - Foliage is alpha-TESTED, never blended: no transparency sorting, no depth-order bugs.
//
//  - Every leaf card's vertex normal points outward from the crown centre, not along the card,
//    so a flat quad shades like the surface of a round crown. Vertex colour bakes an AO that
//    darkens toward the crown interior and toward the ground.
//
//  - Nothing here casts a shadow. The old cone trees spent most of their ~2.5 ms/frame in the
//    shadow pass for shadows almost never on screen (the sun's shadow camera is only +-60 m
//    around the car). Ground contact comes from cheap decals instead.
// ============================================================================

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { makeRng } from "./themes.js?v=60";
import { makeBarkTexture, makeLeafTexture, makeContactTexture } from "./tree-textures.js?v=60";

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
// height     natural height in metres BEFORE the per-instance 0.8-1.4 scale
// mode       "fork"  = trunk forks recursively (broadleaf, birch, poplar)
//            "whorl" = one straight leader with rings of drooping side branches (conifer)
// maxScale   clamp on the per-instance scale so nothing grows past ~20 m
export const TREE_SPECIES = {
  broadleaf: {
    id: "broadleaf", height: 12, maxScale: 1.4, mode: "fork",
    trunkR: 0.30, trunkFrac: 0.42, taper: 0.72, flare: 0.8,
    depth: 4, children: [3, 3, 2, 2], spread: [0.46, 0.56, 0.66, 0.74],
    lenDecay: [0.72, 0.70, 0.66, 0.6], radDecay: 0.60,
    droop: -0.18, curl: 0.16,
    leafFrom: 3, cardSize: 2.5, cardsPerCluster: 3, alongCards: 2,
    crownLift: 0.0, leafTint: [0.86, 1.06, 0.72],
  },
  conifer: {
    id: "conifer", height: 14, maxScale: 1.35, mode: "whorl",
    trunkR: 0.26, trunkFrac: 1.0, taper: 0.12, flare: 0.7,
    whorls: 14, perWhorl: [5, 7], whorlFrom: 0.13,
    branchLen: [0.40, 0.13], droop: 0.42, depth: 2,
    leafFrom: 1, cardSize: 2.2, cardsPerCluster: 2, clustersPerBranch: 5,
    crownLift: -0.04, leafTint: [0.74, 0.96, 0.78],
  },
  birch: {
    id: "birch", height: 10, maxScale: 1.4, mode: "fork",
    trunkR: 0.19, trunkFrac: 0.50, taper: 0.76, flare: 0.55,
    depth: 4, children: [2, 3, 2, 2], spread: [0.32, 0.44, 0.58, 0.68],
    lenDecay: [0.76, 0.72, 0.66, 0.6], radDecay: 0.58,
    droop: 0.06, curl: 0.2,
    leafFrom: 3, cardSize: 1.8, cardsPerCluster: 3, alongCards: 2,
    crownLift: 0.06, leafTint: [0.96, 1.10, 0.74],
  },
  poplar: {
    id: "poplar", height: 15, maxScale: 1.2, mode: "fork",
    trunkR: 0.26, trunkFrac: 0.34, taper: 0.80, flare: 0.5,
    depth: 4, children: [3, 2, 2, 2], spread: [0.17, 0.21, 0.26, 0.30],
    lenDecay: [0.82, 0.78, 0.72, 0.64], radDecay: 0.62,
    droop: -0.34, curl: 0.06,
    leafFrom: 2, cardSize: 1.7, cardsPerCluster: 3, alongCards: 3,
    crownLift: 0.04, leafTint: [0.90, 1.04, 0.76],
  },
};

/** Which species a theme's forest is made of, and the weight of each. */
export const THEME_TREES = {
  // Green Valley: mostly broadleaf, some conifer, a few birch (as briefed).
  sunny: [["broadleaf", 0.62], ["conifer", 0.26], ["birch", 0.12]],
  // The other two themes keep their own scenery (mesa rocks / container port) and get no trees.
  // The empty mixes are here so a future track can switch one on without touching this file.
  // Jungle: procedural broadleaf as the base, <=10% conifer (far belt feel), a few birch.
  jungle: [["broadleaf", 0.8], ["conifer", 0.08], ["birch", 0.12]],
  desert: [],
  nightRain: [],
};

// ---------------------------------------------------------------------------
// Quality presets
// ---------------------------------------------------------------------------
// count      trees placed around the track
// lod0/lod1  metres: within lod0 -> L0, within lod1 -> L1, else L2
// far        metres: chunks beyond this are hidden entirely
// cards      multiplier on foliage density (the main fill-rate lever)
// `high.far` was 330 until T3 verification: a wide/elevated pose (one of the 4 fixed baseline
// poses) measured new trees ~4.5ms over old at that distance - over the "cut until it doesn't"
// 3ms budget - while the 3 ground-level poses (closer to an actual chase-cam angle) were all
// FASTER than old already, because removing tree shadows (see file header) saves more than the
// extra geometry costs. Trimming far to 260 cuts the distant LOD2 belt a ground-level camera
// barely resolves anyway, without touching lod0/lod1 (the close-up quality that is the point of
// this whole pass). Re-measured after the cut - see HANDOFF/commit message for the numbers.
export const TREE_QUALITY = {
  high:   { count: 420, lod0: 55, lod1: 140, far: 260, cards: 1.0,  variantsPerSpecies: 4, maxTris: 250000 },
  med:    { count: 320, lod0: 42, lod1: 110, far: 220, cards: 0.8,  variantsPerSpecies: 4, maxTris: 120000 },
  low:    { count: 210, lod0: 32, lod1: 80,  far: 180, cards: 0.6,  variantsPerSpecies: 3, maxTris: 50000 },
  mobile: { count: 170, lod0: 30, lod1: 75,  far: 160, cards: 0.55, variantsPerSpecies: 3, maxTris: 50000 },
};

/** ?gfx=low|med|high|mobile overrides the auto pick. (?trees=old is handled in scenery.js.) */
export function pickQuality() {
  try {
    const q = new URLSearchParams(location.search).get("gfx");
    if (q && TREE_QUALITY[q]) return q;
  } catch (_) { /* no URL access - fall through to auto */ }
  try {
    if (matchMedia("(hover: none) and (pointer: coarse)").matches) return "mobile";
    if ((navigator.hardwareConcurrency || 4) <= 4) return "med";
  } catch (_) { /* feature detection only */ }
  return "high";
}

// ---------------------------------------------------------------------------
// Scratch geometry buffers
// ---------------------------------------------------------------------------
function newMesh() { return { pos: [], nor: [], uv: [], col: [], idx: [] }; }

function toGeometry(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(m.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(m.nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(m.uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(m.col, 3));
  g.setIndex(m.idx);
  return g;
}

// ---------------------------------------------------------------------------
// Tapered tube along a path (trunk and branches)
// ---------------------------------------------------------------------------
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _nrm = new THREE.Vector3();
const _bin = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();

/**
 * Add a tube through `path` with per-point `radii`, `sides` around.
 * `flare` (optional, per point) swells the ring with five soft lobes - used only on the bottom
 * rings of a trunk, so it reads as a root base rather than a pipe pushed into the grass.
 * Frames are parallel-transported so long branches do not twist.
 */
function addTube(M, path, radii, sides, uvLen, flare, shade) {
  const n = path.length;
  if (n < 2) return;
  const base = M.pos.length / 3;
  _t1.copy(path[1]).sub(path[0]).normalize();
  _nrm.set(0, 1, 0);
  if (Math.abs(_nrm.dot(_t1)) > 0.92) _nrm.set(1, 0, 0);
  _nrm.crossVectors(_t1, _nrm).normalize();
  _bin.crossVectors(_t1, _nrm).normalize();

  let vLen = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      _t2.copy(path[Math.min(i + 1, n - 1)]).sub(path[i - 1]);
      if (_t2.lengthSq() < 1e-12) _t2.copy(_t1); else _t2.normalize();
      _q.setFromUnitVectors(_t1, _t2);
      _nrm.applyQuaternion(_q).normalize();
      _t1.copy(_t2);
      _bin.crossVectors(_t1, _nrm).normalize();
      vLen += path[i].distanceTo(path[i - 1]);
    }
    const r = radii[i];
    const f = flare ? flare[i] : 0;
    const shd = shade ? shade[i] : 1;
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Five soft lobes, and only where flare > 0.
      const lobe = f > 0 ? 1 + f * (0.30 + 0.70 * Math.pow(Math.max(0, Math.cos(a * 5)), 1.4)) : 1;
      _v.set(_nrm.x * ca + _bin.x * sa, _nrm.y * ca + _bin.y * sa, _nrm.z * ca + _bin.z * sa);
      M.pos.push(path[i].x + _v.x * r * lobe, path[i].y + _v.y * r * lobe, path[i].z + _v.z * r * lobe);
      M.nor.push(_v.x, _v.y, _v.z);
      M.uv.push(s / sides, vLen / uvLen);
      M.col.push(shd, shd, shd);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = base + i * ring + s, b = a + ring;
      // Winding matters: (a, b, a+1) has its geometric normal pointing INWARD, which meant the
      // front faces were the inside of the tube and every trunk rendered as an unlit black shell.
      M.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
}

// ---------------------------------------------------------------------------
// Foliage cards
// ---------------------------------------------------------------------------
const _u = new THREE.Vector3(), _w = new THREE.Vector3(), _out = new THREE.Vector3();
const _ax = new THREE.Vector3(), _ay = new THREE.Vector3();

/**
 * One alpha-tested quad spanning `ax` x `ay`. `outward` becomes EVERY vertex's normal (the fake
 * crown volume), and `aoIn`/`aoOut` bake the interior-to-rim darkening into vertex colour.
 */
function addCard(M, centre, ax, ay, half, outward, aoIn, aoOut, tint) {
  const base = M.pos.length / 3;
  for (let k = 0; k < 4; k++) {
    const sx = k === 1 || k === 2 ? 1 : -1;
    const sy = k >= 2 ? 1 : -1;
    M.pos.push(
      centre.x + ax.x * sx * half + ay.x * sy * half,
      centre.y + ax.y * sx * half + ay.y * sy * half,
      centre.z + ax.z * sx * half + ay.z * sy * half
    );
    M.nor.push(outward.x, outward.y, outward.z);
    M.uv.push(sx > 0 ? 1 : 0, sy > 0 ? 1 : 0);
    const ao = sy > 0 ? aoOut : aoIn;
    M.col.push(tint[0] * ao, tint[1] * ao, tint[2] * ao);
  }
  M.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * A clump of crossed cards at `p`. All normals point away from `crownC`, which is what turns a
 * pile of flat quads into something that shades like a ball of leaves.
 */
function addCluster(M, p, crownC, crownR, half, count, rnd, tint) {
  _out.copy(p).sub(crownC);
  const dist = _out.length();
  if (dist < 1e-4) _out.set(0, 1, 0); else _out.multiplyScalar(1 / dist);
  // Outward, but tilted toward the sky. A purely radial normal makes the half of the crown
  // facing away from the sun render black (the conifers were the worst offenders); a canopy
  // really does present most of its leaf area upward, so this is the honest normal anyway.
  _out.y += 0.62;
  _out.normalize();
  // AO: interior darker than rim, underside darker than top. The floors here are deliberately
  // high - an earlier pass used 0.29 and the crowns read as black holes in the game's lighting.
  const rim = crownR > 0 ? Math.min(1, dist / crownR) : 1;
  const vert = Math.min(1, Math.max(0, (p.y - (crownC.y - crownR)) / (crownR * 2)));
  const lit = (0.64 + 0.36 * rim) * (0.84 + 0.16 * vert);
  const aoIn = lit * 0.82, aoOut = lit;
  _u.set(0, 1, 0);
  if (Math.abs(_u.dot(_out)) > 0.9) _u.set(1, 0, 0);
  _u.crossVectors(_out, _u).normalize();
  _w.crossVectors(_out, _u).normalize();
  for (let c = 0; c < count; c++) {
    // Crossed: each card is spun about the outward axis, so the clump is solid from any side.
    const a = (c / count) * Math.PI + rnd() * 0.4;
    const ca = Math.cos(a), sa = Math.sin(a);
    _ax.set(_u.x * ca + _w.x * sa, _u.y * ca + _w.y * sa, _u.z * ca + _w.z * sa);
    if (c === 0) _ay.crossVectors(_out, _ax).normalize();
    else _ay.copy(_out);
    addCard(M, p, _ax, _ay, half * (0.8 + rnd() * 0.45), _out, aoIn, aoOut, tint);
  }
}

// ---------------------------------------------------------------------------
// Skeleton growth (LOD-independent)
// ---------------------------------------------------------------------------
/** Build a slightly curved path of `steps` segments from `origin` along `dir`. */
function branchPath(origin, dir, len, steps, curl, droop, rnd) {
  const pts = [origin.clone()];
  const d = dir.clone().normalize();
  const step = len / steps;
  for (let i = 0; i < steps; i++) {
    d.y += droop / steps;
    d.x += (rnd() - 0.5) * curl * 2 / steps;
    d.z += (rnd() - 0.5) * curl * 2 / steps;
    d.normalize();
    pts.push(pts[pts.length - 1].clone().addScaledVector(d, step));
  }
  return pts;
}

// The skeleton is always grown at MAX detail; LODs decimate it afterwards.
const SKEL_STEPS = 4, SKEL_TRUNK_STEPS = 6;

function growForkSkel(S, out, origin, dir, len, rad, depth, rnd) {
  const steps = depth === 0 ? SKEL_TRUNK_STEPS : SKEL_STEPS;
  const path = branchPath(origin, dir, len, steps, S.curl, S.droop * (depth === 0 ? 0.12 : 1), rnd);
  if (depth === 0) {
    // Two extra rings just above the ground give the root flare vertical extent, instead of
    // splaying out of a single ring like a skirt (which is exactly what the first pass did).
    const d0 = dir.clone().normalize();
    path.splice(1, 0,
      origin.clone().addScaledVector(d0, len * 0.022),
      origin.clone().addScaledVector(d0, len * 0.075));
  }
  const r1 = rad * S.radDecay;
  out.branches.push({ path: path, r0: rad, r1: r1, depth: depth });

  const tip = path[path.length - 1];
  if (depth >= S.leafFrom) {
    // Foliage strung ALONG the branch, densest toward the tip - leaves only at tips leave a
    // hollow crown with a hole through the middle.
    const along = Math.max(1, Math.round((S.alongCards || 2) * (depth >= S.depth ? 1.5 : 1)));
    for (let i = 0; i < along; i++) {
      const f = 0.32 + 0.68 * ((i + 0.5) / along);
      out.leaves.push({
        p: path[0].clone().lerp(tip, f).add(new THREE.Vector3(
          (rnd() - 0.5) * S.cardSize * 0.5, (rnd() - 0.5) * S.cardSize * 0.35, (rnd() - 0.5) * S.cardSize * 0.5)),
        size: 0.72 + 0.5 * f, depth: depth,
      });
    }
  }
  if (depth >= S.depth) return;

  const kids = S.children[Math.min(depth, S.children.length - 1)];
  const spread = S.spread[Math.min(depth, S.spread.length - 1)];
  const a0 = rnd() * Math.PI * 2;
  for (let k = 0; k < kids; k++) {
    const a = a0 + (k / kids) * Math.PI * 2 + (rnd() - 0.5) * 0.7;
    const tilt = spread * (0.7 + rnd() * 0.6);
    const nd = dir.clone().normalize();
    _u.set(0, 1, 0);
    if (Math.abs(_u.dot(nd)) > 0.9) _u.set(1, 0, 0);
    _u.crossVectors(nd, _u).normalize();
    _w.crossVectors(nd, _u).normalize();
    nd.multiplyScalar(Math.cos(tilt))
      .addScaledVector(_u, Math.sin(tilt) * Math.cos(a))
      .addScaledVector(_w, Math.sin(tilt) * Math.sin(a))
      .normalize();
    const nl = len * S.lenDecay[Math.min(depth, S.lenDecay.length - 1)] * (0.82 + rnd() * 0.36);
    growForkSkel(S, out, tip, nd, nl, r1, depth + 1, rnd);
  }
}

function growWhorlSkel(S, out, origin, height, rad, rnd) {
  const path = branchPath(origin, UP.clone(), height, SKEL_TRUNK_STEPS, 0.02, 0, rnd);
  const d0 = UP.clone();
  path.splice(1, 0,
    origin.clone().addScaledVector(d0, height * 0.012),
    origin.clone().addScaledVector(d0, height * 0.04));
  out.branches.push({ path: path, r0: rad, r1: rad * S.taper, depth: 0 });

  for (let i = 0; i < S.whorls; i++) {
    const t = S.whorlFrom + (1 - S.whorlFrom) * (i / (S.whorls - 1));
    const y = origin.y + height * t;
    const spanT = 1 - t;                                   // long low branches, short at the top
    const len = height * (S.branchLen[1] + (S.branchLen[0] - S.branchLen[1]) * spanT);
    const per = Math.max(3, Math.round(S.perWhorl[0] + rnd() * (S.perWhorl[1] - S.perWhorl[0])));
    const a0 = rnd() * Math.PI * 2;
    for (let k = 0; k < per; k++) {
      const a = a0 + (k / per) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
      const dir = new THREE.Vector3(Math.cos(a), 0.05 + rnd() * 0.12, Math.sin(a)).normalize();
      const bp = branchPath(new THREE.Vector3(origin.x, y, origin.z), dir, len, 3, 0.05, -S.droop, rnd);
      const br = rad * (0.15 + 0.13 * spanT);
      // wi (whorl index) lets bakeLOD thin by dropping every other WHORL at LOD1+. A whorl tree
      // has no branch-depth hierarchy to trim (every side branch is depth 1), so without this its
      // L1 stayed near L0's triangle count - confirmed by the triangle table (1838 vs a ~1k target).
      out.branches.push({ path: bp, r0: br, r1: br * 0.25, depth: 1, wi: i });
      const n = S.clustersPerBranch;
      for (let c = 0; c < n; c++) {
        const f = 0.22 + 0.82 * ((c + rnd() * 0.5) / n);
        out.leaves.push({
          p: bp[0].clone().lerp(bp[bp.length - 1], f),
          size: (0.62 + 0.55 * (1 - f)) * (0.55 + 0.6 * spanT), depth: 1, wi: i,
        });
      }
    }
  }
}

/** Per-variant structural jitter: variants must differ in SHAPE, not just in noise. */
function variantSpec(S, rnd) {
  const s = Object.assign({}, S);
  s.height = S.height * (0.86 + rnd() * 0.3);
  if (S.trunkFrac < 1) s.trunkFrac = S.trunkFrac * (0.84 + rnd() * 0.34);
  s.droop = S.droop * (0.6 + rnd() * 0.9);
  s.curl = S.curl * (0.7 + rnd() * 0.8);
  s.radDecay = S.radDecay * (0.94 + rnd() * 0.12);
  s.trunkR = S.trunkR * (0.88 + rnd() * 0.26);
  if (S.spread) s.spread = S.spread.map((v) => v * (0.88 + rnd() * 0.28));
  if (S.children) {
    s.children = S.children.slice();
    // Only ever ADD a fork, never remove one. Dropping children[0] to 2 on a species whose base
    // is already 3 combined with the spread jitter above split the crown into visibly separate
    // detached lobes (seen on broadleaf variant 3 - confirmed by rendering it in isolation).
    // Depth 1 is jittered instead of depth 0: it thickens an existing lobe rather than removing
    // one of the handful of main forks that DEFINE the crown's overall shape. The two are
    // mutually exclusive - stacking both pushed one variant to 5360 L0 triangles, well past the
    // ~4k target (confirmed by the triangle table) - so at most one level gets denser per variant.
    if (rnd() < 0.4) s.children[0] = Math.min(4, S.children[0] + 1);
    else if (s.children.length > 1 && rnd() < 0.5) s.children[1] = Math.max(2, Math.min(4, s.children[1] + (rnd() < 0.5 ? -1 : 1)));
  }
  if (S.whorls) s.whorls = Math.max(8, Math.round(S.whorls * (0.85 + rnd() * 0.32)));
  if (S.perWhorl) s.perWhorl = [S.perWhorl[0], S.perWhorl[1] + (rnd() < 0.4 ? 1 : 0)];
  return s;
}

function growSkeleton(speciesId, vi) {
  const rnd = makeRng((speciesId.charCodeAt(0) * 7919 + speciesId.length * 131 + vi * 104729 + 17) >>> 0);
  const S = variantSpec(TREE_SPECIES[speciesId], rnd);
  const out = { branches: [], leaves: [] };
  if (S.mode === "whorl") growWhorlSkel(S, out, new THREE.Vector3(), S.height, S.trunkR, rnd);
  else growForkSkel(S, out, new THREE.Vector3(), UP.clone(), S.height * S.trunkFrac, S.trunkR, 0, rnd);
  // Crown centre / radius drive the outward normals and the AO.
  const c = new THREE.Vector3();
  for (const l of out.leaves) c.add(l.p);
  if (out.leaves.length) c.multiplyScalar(1 / out.leaves.length);
  c.y += S.height * S.crownLift;
  let r = 0.001;
  for (const l of out.leaves) r = Math.max(r, l.p.distanceTo(c));
  out.spec = S; out.crownC = c; out.crownR = r;
  let top = 0;
  for (const b of out.branches) for (const p of b.path) top = Math.max(top, p.y);
  for (const l of out.leaves) top = Math.max(top, l.p.y);

  // Normalise to the species' natural height. Variant jitter should change SHAPE, not size:
  // size comes from the per-instance 0.8-1.4 scale, and letting the two compound produced 24 m
  // broadleaves against a 4.5 m car.
  const norm = TREE_SPECIES[speciesId].height / Math.max(0.001, top);
  for (const b of out.branches) {
    for (const p of b.path) p.multiplyScalar(norm);
    b.r0 *= norm; b.r1 *= norm;
  }
  for (const l of out.leaves) l.p.multiplyScalar(norm);
  c.multiplyScalar(norm);
  out.crownR = r * norm;
  out.height = top * norm;
  out.cardScale = norm;
  return out;
}

// ---------------------------------------------------------------------------
// Baking a skeleton at a given LOD
// ---------------------------------------------------------------------------
// depth      branches deeper than this are dropped
// stride     keep every Nth path point (1 = all) - fewer rings along each branch
// leafStride keep every Nth foliage cluster; survivors are enlarged by sqrt(stride) so the
//            crown keeps its volume and the LOD switch stays invisible
// sides      ring resolution by branch depth
// cards      cards per cluster
const LOD_DETAIL = [
  { depth: 99, stride: 1, leafStride: 1, cards: 0, sides: (d) => (d === 0 ? 7 : 4) },
  { depth: 2,  stride: 2, leafStride: 3, cards: -1, sides: (d) => (d === 0 ? 5 : 4) },
];

function decimate(path, stride) {
  if (stride <= 1) return path;
  const out = [];
  for (let i = 0; i < path.length; i += stride) out.push(path[i]);
  if (out[out.length - 1] !== path[path.length - 1]) out.push(path[path.length - 1]);
  return out.length >= 2 ? out : path;
}

function bakeLOD(skel, lod, quality) {
  const S = skel.spec;
  const bark = newMesh(), leaf = newMesh();
  const rnd = makeRng((skel.spec.id.charCodeAt(0) * 31 + 977) >>> 0);
  const tint = S.leafTint || [1, 1, 1];

  if (lod === 2) {
    // L2: short trunk stub + three crossed crown cards. ~16 triangles, readable past ~140 m.
    const h = skel.height;
    const r = S.trunkR * skel.cardScale;
    addTube(bark, [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, h * 0.4, 0)],
      [r * 1.15, r * 0.6], 5, 3.2, [S.flare * 0.8, 0], null);
    const cy = skel.crownC.y, cr = skel.crownR * 1.06;
    const centre = new THREE.Vector3(0, cy, 0);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI;
      _ax.set(Math.cos(a), 0, Math.sin(a));
      _ay.set(0, 1, 0);
      // Normal tilted up and out: at this range it only has to read as a lit blob.
      _out.set(Math.cos(a) * 0.6, 0.72, Math.sin(a) * 0.6).normalize();
      addCard(leaf, centre, _ax, _ay, cr, _out, 0.80, 0.98, tint);
    }
  } else {
    const D = LOD_DETAIL[lod];
    // Whorl trees (conifer) have no branch-depth hierarchy to trim - every side branch is depth
    // 1 - so at LOD1 every other WHORL is dropped instead (wi = whorl index, undefined/skipped
    // for fork species). Confirmed necessary: without it conifer's L1 measured 1838 tris against
    // a ~1k target because depth-based trimming alone did nothing for this species.
    const dropWhorl = lod === 1 ? (wi) => wi != null && wi % 2 === 1 : () => false;
    const whorlRadiusBoost = lod === 1 ? 1.35 : 1;   // partially compensate the halved branch count
    for (const b of skel.branches) {
      if (b.depth > D.depth || dropWhorl(b.wi)) continue;
      const pts = decimate(b.path, D.stride);
      // Radius by arclength fraction, so decimating rings does not change the taper.
      let total = 0;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) { total += pts[i].distanceTo(pts[i - 1]); cum.push(total); }
      const rb = b.wi != null ? whorlRadiusBoost : 1;
      const radii = cum.map((c) => (b.r0 + (b.r1 - b.r0) * (total > 0 ? c / total : 0)) * rb);
      const flare = b.depth === 0
        ? pts.map((_, i) => (i === 0 ? S.flare : i === 1 ? S.flare * 0.42 : i === 2 ? S.flare * 0.12 : 0))
        : null;
      const shade = b.depth === 0 ? pts.map((_, i) => 1 - 0.10 * (i / (pts.length - 1))) : null;
      addTube(bark, pts, radii, D.sides(b.depth), 3.2, flare, shade);
    }
    // Thin the foliage, then enlarge the survivors to keep the same covered area.
    const q = quality.cards;
    const stride = Math.max(1, Math.round(D.leafStride / Math.max(0.35, q)));
    const grow = Math.sqrt(stride) * (lod === 1 ? 1.15 : 1); // a touch extra: whorls also thinned
    const cards = Math.max(1, S.cardsPerCluster + (D.cards || 0));
    for (let i = 0; i < skel.leaves.length; i += stride) {
      const L = skel.leaves[i];
      // A dropped branch level must not drop its leaves: they are re-pinned to the parent tip.
      if (L.depth > D.depth + 1 || dropWhorl(L.wi)) continue;
      addCluster(leaf, L.p, skel.crownC, skel.crownR, S.cardSize * 0.5 * L.size * grow * skel.cardScale, cards, rnd, tint);
    }
  }

  const gBark = toGeometry(bark), gLeaf = toGeometry(leaf);
  const merged = mergeGeometries([gBark, gLeaf], true);   // group 0 = bark, group 1 = leaves
  gBark.dispose(); gLeaf.dispose();
  merged.computeBoundingSphere();
  return {
    geometry: merged, tris: merged.index.count / 3,
    barkTris: bark.idx.length / 3, leafTris: leaf.idx.length / 3,
    height: skel.height,
  };
}

// ---------------------------------------------------------------------------
// Wind (vertex shader, via onBeforeCompile)
// ---------------------------------------------------------------------------
export function makeWindUniform() { return { value: 0 }; }

/**
 * Sway in the vertex shader: amplitude grows with height above the tree's own base, phase comes
 * from the instance's world position so no two trees move together, and every material shares ONE
 * time uniform updated once per frame. No new attributes, no per-frame CPU work.
 *
 * `noFacingFlip` (leaf materials only): three.js flips the shading normal on back-facing
 * triangles (`normal *= faceDirection` in the standard <normal_fragment_begin> chunk) so a
 * double-sided surface still looks lit from whichever side you view it. Our leaf cards use a
 * deliberately FAKE normal (crown-outward, not the card's own geometric normal - see addCluster),
 * so for any card whose winding does not itself point outward, that automatic flip fights the
 * fake normal: from one side the card lights correctly, from the other it flips to face AWAY
 * from the sun and renders black. Stripping the flip makes every card shade from its baked
 * normal unconditionally, which is what "fake volume" requires. Confirmed by inspecting the
 * actual compiled chunk list in the browser (onBeforeCompile runs before #include expansion, so
 * this matches on the literal include token, not on guessed chunk contents).
 */
export function applyWind(material, windTime, amount, noFacingFlip) {
  material.userData.windAmount = { value: amount };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.uniforms.uWindAmount = material.userData.windAmount;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>",
        "#include <common>\nuniform float uWindTime;\nuniform float uWindAmount;")
      .replace("#include <begin_vertex>", [
        "#include <begin_vertex>",
        "#ifdef USE_INSTANCING",
        "  vec3 wInst = instanceMatrix[3].xyz;",
        "#else",
        "  vec3 wInst = vec3(0.0);",
        "#endif",
        "float wH = max(transformed.y, 0.0);",
        "float wAmp = uWindAmount * 0.030 * wH * smoothstep(0.0, 3.0, wH);",
        "float wPh = dot(wInst.xz, vec2(0.21, 0.17));",
        "float wS = sin(uWindTime * 1.25 + wPh) + 0.5 * sin(uWindTime * 2.6 + wPh * 1.7);",
        "transformed.x += wAmp * wS;",
        "transformed.z += wAmp * 0.6 * cos(uWindTime * 1.05 + wPh * 0.8);",
      ].join("\n"));
    if (noFacingFlip) {
      // Only declare `normal` (unflipped). `geometryNormal` is declared FROM `normal` a little
      // later by <lights_fragment_begin> itself - redeclaring it here is a duplicate-symbol
      // compile error (confirmed by reading the actual WebGL compiler error, not guessed: three
      // r170's LambertMaterial fragment shader fails with "'geometryNormal' : redefinition" if
      // this chunk also declares it, and every leaf card silently stops rendering because the
      // WHOLE program fails to link).
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_begin>",
        "vec3 normal = normalize( vNormal );"
      );
    }
  };
  material.customProgramCacheKey = () => "treewind" + amount + (noFacingFlip ? "-nf" : "");
  return material;
}

// ---------------------------------------------------------------------------
// Assets: every geometry + the shared materials, built once, before the race
// ---------------------------------------------------------------------------
export function createTreeAssets(themeId, qualityId, seed, windTime) {
  const quality = TREE_QUALITY[qualityId] || TREE_QUALITY.high;
  const mix = THEME_TREES[themeId] || [];
  const textures = [], materials = [], variants = [];

  for (const entry of mix) {
    const sid = entry[0], weight = entry[1];
    const barkTex = makeBarkTexture(sid, seed + sid.charCodeAt(0) * 31);
    const leafTex = makeLeafTexture(sid, seed + sid.charCodeAt(1) * 57);
    textures.push(barkTex, leafTex);

    // Lambert, not Standard: the scene's sun / hemisphere / fog / environment all apply exactly
    // the same, but the shading maths is much cheaper - and bark and leaves gain nothing from a
    // metal-rough workflow. vertexColors carries the baked AO, instanceColor the per-tree tint.
    const barkMat = new THREE.MeshLambertMaterial({ map: barkTex, vertexColors: true });
    const leafMat = new THREE.MeshLambertMaterial({
      map: leafTex, vertexColors: true, alphaTest: 0.35, side: THREE.DoubleSide,
    });
    barkMat.name = "bark-" + sid;
    leafMat.name = "leaf-" + sid;
    // Leaves need the no-facing-flip fix (see applyWind) even if, hypothetically, no windTime is
    // supplied - so it is applied with amount 0 (no sway, but no shader patch skipped either).
    const wt = windTime || makeWindUniform();
    applyWind(barkMat, wt, windTime ? 0.3 : 0);
    applyWind(leafMat, wt, windTime ? 1.0 : 0, true);
    materials.push(barkMat, leafMat);

    for (let vi = 0; vi < quality.variantsPerSpecies; vi++) {
      const skel = growSkeleton(sid, vi);
      const lods = [bakeLOD(skel, 0, quality), bakeLOD(skel, 1, quality), bakeLOD(skel, 2, quality)];
      variants.push({
        species: sid, index: vi, lods: lods, materials: [barkMat, leafMat],
        weight: weight, height: skel.height,
      });
    }
  }

  // One shared texture + material for the ground-contact decals (T3): a soft radial gradient,
  // alpha-blended (it is meant to fade smoothly, unlike the alpha-TESTED foliage cards) and
  // depthWrite:false so it never fights the grass/road it sits just above for depth. Built here
  // so it shares this call's dispose lifecycle; scenery.js owns the actual decal InstancedMesh
  // since only it knows where the trees ended up.
  const contactTex = makeContactTexture();
  textures.push(contactTex);
  const contactMaterial = new THREE.MeshBasicMaterial({
    map: contactTex, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.6,
  });
  materials.push(contactMaterial);

  return {
    quality: quality, qualityId: qualityId, variants: variants,
    materials: materials, textures: textures, contactMaterial: contactMaterial,
    dispose() {
      for (const v of variants) for (const l of v.lods) l.geometry.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      variants.length = 0; materials.length = 0; textures.length = 0;
    },
  };
}
