// ============================================================================
// themes.js - visual themes (sky, fog, lights, ground/road look) for the race scene.
//
//   THEMES / getTheme(id)         plain data, see the shape below
//   createEnvironment(scene, renderer)
//        -> env: creates the sky dome, the sun, the hemisphere light and ONE headlight spot
//           exactly ONCE (at load). env.apply(themeId) only changes their PROPERTIES (colours,
//           intensities, fog, exposure) - it never adds or removes a light, because three.js
//           recompiles every lit material whenever the scene's light count changes.
//           env.update(dt, carPos, carFwd) follows the sun/headlight to the car and runs lightning
//           (a brief modulation of the existing hemisphere + exposure values, no new lights).
//   makeGroundTexture / makeRoadMaterial   procedural canvas textures (no asset files)
//   makeRng(seed)                 small seeded PRNG so scenery/textures are reproducible
//
// theme = {
//   id, accent,
//   sky {top, mid, horizon}, background, fog {color, near, far},
//   sun {color, intensity, offset[x,y,z]}, hemi {sky, ground, intensity}, exposure,
//   ground {kind:'grass'|'sand'|'concrete', base, roughness, metalness},
//   road {base, grain, roughness, metalness, envMapIntensity, wet},
//   kerb [colorA, colorB], barrier {white, a, b, roughness},
//   sceneryId, particles {type, count, speed, area}, lightning?, headlight (spot intensity, 0 = off)
// }
// ============================================================================

import * as THREE from "three";

/** mulberry32: tiny seeded PRNG (deterministic scenery / textures). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

const SCALE = 2.2; // same factor track.js uses for Track 1's fog / sky distances

export const THEMES = {
  // Track 1: must equal the original look exactly (values copied from the old buildTrack).
  sunny: {
    id: "sunny",
    accent: "#ffcf40",
    sky: { top: 0x1b3f8f, mid: 0x6fa8e6, horizon: 0xdfe9f3 },
    background: 0xdfe9f3,
    fog: { color: 0xdfe9f3, near: 180 * SCALE, far: 900 * SCALE },
    sun: { color: 0xfff2dc, intensity: 2.4, offset: [60, 110, 40], shadowFar: 320 },
    hemi: { sky: 0xbfd8ff, ground: 0x3f6b2a, intensity: 0.55 },
    exposure: 1.05,
    ground: { kind: "grass", base: "#4f8a3a", roughness: 1, metalness: 0 },
    road: { base: "#3a3c40", grain: 26, roughness: 0.82, metalness: 0.05, envMapIntensity: 1, wet: false },
    kerb: [0xd8262a, 0xf2f2f2],
    barrier: { white: 0xf0f0f0, a: 0xd8262a, b: 0x2a5cd8, roughness: 0.7 },
    sceneryId: "trees",
    particles: null,
    lightning: null,
    headlight: 0,
  },

  // JUNGLE_LOOK: humid pale teal sky, green-teal fog, dark loam ground, greenish hemi, warm moderate
  // sun. Applied to Green Valley (track id unchanged) unless ?theme=classic (see getTheme).
  jungle: {
    id: "jungle",
    accent: "#7fd08a",
    sky: { top: 0x6f9aa0, mid: 0xa9c9c4, horizon: 0xd6e6dc },
    background: 0xbdd3c9,
    fog: { color: 0xa9c4b6, near: 40, far: 300 },
    sun: { color: 0xffe2b8, intensity: 1.9, offset: [60, 90, 40], shadowFar: 320 },
    hemi: { sky: 0xb4d6c4, ground: 0x2a2a18, intensity: 0.6 },
    exposure: 0.96,
    ground: { kind: "moss", base: "#2b3a1e", roughness: 1, metalness: 0 },
    road: { base: "#2f3236", grain: 26, roughness: 0.78, metalness: 0.05, envMapIntensity: 1, wet: false },
    kerb: [0xd8262a, 0xf2f2f2],
    barrier: { white: 0xf0f0f0, a: 0xd8262a, b: 0x2a5cd8, roughness: 0.7 },
    sceneryId: "trees",
    particles: null,
    lightning: null,
    headlight: 0,
  },

  // Track 2: hot late afternoon, low orange-gold sun, warm dusty haze.
  desert: {
    id: "desert",
    accent: "#ff8a3d",
    sky: { top: 0x3d6fb0, mid: 0xe9b46f, horizon: 0xf3c98a },
    background: 0xeec48a,
    fog: { color: 0xe8b879, near: 140 * SCALE, far: 640 * SCALE },
    sun: { color: 0xffb066, intensity: 2.7, offset: [-210, 62, 96], shadowFar: 480 },
    hemi: { sky: 0xffd9a8, ground: 0xb5652f, intensity: 0.62 },
    exposure: 1.08,
    ground: { kind: "sand", base: "#c88b4d", roughness: 1, metalness: 0 },
    road: { base: "#4b4137", grain: 22, roughness: 0.9, metalness: 0.03, envMapIntensity: 0.8, wet: false },
    kerb: [0xd9a441, 0xf1e0b4],
    barrier: { white: 0xe9d4a4, a: 0xb5522b, b: 0xd9a441, roughness: 0.85 },
    sceneryId: "mesa",
    particles: { type: "dust", count: 520, speed: 5, area: 180 },
    lightning: null,
    headlight: 0,
  },

  // Track 3: dark blue overcast night, dense fog, rain, wet road, occasional lightning.
  nightRain: {
    id: "nightRain",
    accent: "#4fc3ff",
    sky: { top: 0x070a14, mid: 0x0d1526, horizon: 0x1a2438 },
    background: 0x141c2c,
    fog: { color: 0x141c2c, near: 40, far: 420 },
    sun: { color: 0x7f9dd8, intensity: 0.55, offset: [-50, 130, -40], shadowFar: 320 },
    hemi: { sky: 0x3c4f7a, ground: 0x10141c, intensity: 0.42 },
    exposure: 0.95,
    ground: { kind: "concrete", base: "#262a31", roughness: 0.55, metalness: 0.15 },
    road: { base: "#1b1e24", grain: 14, roughness: 0.32, metalness: 0.25, envMapIntensity: 2.2, wet: true },
    kerb: [0xe6c229, 0x1c1c1c],
    barrier: { white: 0x8a9099, a: 0xd9a800, b: 0x59606b, roughness: 0.6 },
    sceneryId: "port",
    particles: { type: "rain", count: 1700, speed: 46, area: 60 },
    lightning: { gapMin: 7, gapMax: 17, strength: 3.2, exposureBoost: 0.7 },
    headlight: 1500,
  },
};

function classicTheme() {
  try { return new URLSearchParams(location.search).get("theme") === "classic"; } catch (_) { return false; }
}
THEMES.speedway = { // OVAL: the classic bright sunny look, no scenery of its own (the model provides the ground)
  ...THEMES.sunny, id: "speedway", accent: "#4fc3ff", sceneryId: "none",
  ground: { kind: "grass", base: "#4f8a3a", roughness: 1, metalness: 0 },
};
export function getTheme(id) {
  if (id === "sunny" && !classicTheme()) return THEMES.jungle;
  return THEMES[id] || THEMES.sunny;
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** Ground tile. For 'grass' the drawing is identical to the original grassTexture(). */
export function makeGroundTexture(theme, seed = 1) {
  const rnd = makeRng(seed);
  const c = makeCanvas(256, 256);
  const g = c.getContext("2d");
  const kind = theme.ground.kind;
  g.fillStyle = theme.ground.base;
  g.fillRect(0, 0, 256, 256);
  if (kind === "grass") {
    for (let i = 0; i < 2600; i++) {
      const v = 60 + rnd() * 60;
      g.fillStyle = `rgb(${v * 0.55 | 0}, ${v + 40 | 0}, ${v * 0.45 | 0})`;
      g.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 3, 2 + rnd() * 3);
    }
  } else if (kind === "moss") { // dark loam + moss, leaf litter and mud patches, soft macro variation
    g.fillStyle = theme.ground.base; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 40; i++) { // large soft macro blobs (moss / mud), wrap-free but low contrast
      const x = rnd() * 256, y = rnd() * 256, r = 25 + rnd() * 50, mud = rnd() < 0.4;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, mud ? "rgba(70,52,34,0.35)" : "rgba(50,78,34,0.32)"); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) { g.save(); g.translate(ox, oy); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore(); }
    }
    for (let i = 0; i < 1800; i++) {
      const v = 30 + rnd() * 45, k = rnd();
      g.fillStyle = k < 0.55 ? `rgb(${v * 0.6 | 0}, ${v + 14 | 0}, ${v * 0.4 | 0})` : k < 0.85 ? `rgb(${v + 30 | 0}, ${v * 0.7 + 14 | 0}, ${v * 0.3 | 0})` : `rgb(${v * 0.9 + 10 | 0}, ${v * 0.75 | 0}, ${v * 0.5 | 0})`;
      g.fillRect(rnd() * 256, rnd() * 256, 1.5 + rnd() * 4, 1.5 + rnd() * 2.5);
    }
  } else if (kind === "sand") {
    for (let i = 0; i < 3400; i++) {
      const v = 150 + rnd() * 75;
      g.fillStyle = `rgb(${v + 22 | 0}, ${v * 0.7 + 12 | 0}, ${v * 0.4 | 0})`;
      g.fillRect(rnd() * 256, rnd() * 256, 1.5 + rnd() * 3, 1.5 + rnd() * 3);
    }
    for (let i = 0; i < 26; i++) { // faint wind ripples
      g.fillStyle = `rgba(120,70,30,${0.05 + rnd() * 0.06})`;
      g.fillRect(rnd() * 256, rnd() * 256, 30 + rnd() * 60, 1.5 + rnd() * 2);
    }
  } else { // concrete apron with expansion joints and stains
    for (let i = 0; i < 2600; i++) {
      const v = 30 + rnd() * 40;
      g.fillStyle = `rgb(${v | 0}, ${v + 2 | 0}, ${v + 7 | 0})`;
      g.fillRect(rnd() * 256, rnd() * 256, 1.5 + rnd() * 3, 1.5 + rnd() * 3);
    }
    g.fillStyle = "rgba(255,255,255,0.07)";
    g.fillRect(0, 0, 256, 2); g.fillRect(0, 128, 256, 2);
    g.fillRect(0, 0, 2, 256); g.fillRect(128, 0, 2, 256);
    for (let i = 0; i < 14; i++) { // oil/rain puddle stains
      g.fillStyle = `rgba(90,110,150,${0.05 + rnd() * 0.05})`;
      g.beginPath(); g.ellipse(rnd() * 256, rnd() * 256, 10 + rnd() * 22, 5 + rnd() * 10, rnd() * 3, 0, 7); g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Road texture (u = across the road, v = along it). Identical to the original asphalt for 'sunny'. */
function makeRoadTexture(theme, seed = 2) {
  const rnd = makeRng(seed);
  const r = theme.road;
  const c = makeCanvas(256, 256);
  const g = c.getContext("2d");
  g.fillStyle = r.base;
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * r.grain;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  if (r.wet) { // darker/lighter wet patches and tyre-polished lanes
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(140,165,205,${0.05 + rnd() * 0.07})`;
      g.beginPath(); g.ellipse(rnd() * 256, rnd() * 256, 16 + rnd() * 40, 6 + rnd() * 14, rnd() * 3, 0, 7); g.fill();
    }
    g.fillStyle = "rgba(0,0,0,0.16)";
    g.fillRect(70, 0, 22, 256); g.fillRect(164, 0, 22, 256);
  }
  // edge lines (u = 0 and 1 are the road edges)
  g.fillStyle = r.wet ? "#b9bec6" : "#e8e8e8";
  g.fillRect(6, 0, 5, 256);
  g.fillRect(245, 0, 5, 256);
  // dashed centre line
  g.fillStyle = r.wet ? "#d8cf9a" : "#f2e7b0";
  g.fillRect(125, 20, 6, 110);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function makeRoadMaterial(theme, seed = 2) {
  const r = theme.road;
  return new THREE.MeshStandardMaterial({
    map: makeRoadTexture(theme, seed), roughness: r.roughness, metalness: r.metalness,
    envMapIntensity: r.envMapIntensity, side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Environment (created ONCE at load)
// ---------------------------------------------------------------------------
function makeSky() {
  const geo = new THREE.SphereGeometry(1400 * SCALE, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x1b3f8f) },
      midColor: { value: new THREE.Color(0x6fa8e6) },
      horizonColor: { value: new THREE.Color(0xdfe9f3) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 midColor; uniform vec3 horizonColor;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        float t = clamp(h, 0.0, 1.0);
        vec3 c = mix(horizonColor, midColor, smoothstep(0.0, 0.25, t));
        c = mix(c, topColor, smoothstep(0.25, 1.0, t));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "sky";
  mesh.frustumCulled = false;
  return mesh;
}

export function createEnvironment(scene, renderer) {
  const sky = makeSky();
  scene.add(sky);
  scene.background = new THREE.Color(0xdfe9f3);
  scene.fog = new THREE.Fog(0xdfe9f3, 180 * SCALE, 900 * SCALE);

  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3f6b2a, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dc, 2.4);
  sun.position.set(60, 110, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 320;
  const S = 60;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  // The ONE headlight: always in the scene, intensity 0 except on themes that ask for it.
  const head = new THREE.SpotLight(0xfff0d4, 0, 130, 0.62, 0.7, 1.1);
  head.castShadow = false;
  scene.add(head);
  scene.add(head.target);

  let theme = getTheme("sunny");
  let sunOffset = new THREE.Vector3(...theme.sun.offset);
  const lightning = { nextAt: 0, startedAt: -1, f: 0 };

  function apply(id) {
    theme = getTheme(id);
    const u = sky.material.uniforms;
    u.topColor.value.set(theme.sky.top);
    u.midColor.value.set(theme.sky.mid);
    u.horizonColor.value.set(theme.sky.horizon);
    scene.background.set(theme.background);
    scene.fog.color.set(theme.fog.color);
    scene.fog.near = theme.fog.near;
    scene.fog.far = theme.fog.far;
    hemi.color.set(theme.hemi.sky);
    hemi.groundColor.set(theme.hemi.ground);
    hemi.intensity = theme.hemi.intensity;
    sun.color.set(theme.sun.color);
    sun.intensity = theme.sun.intensity;
    sunOffset.set(...theme.sun.offset);
    sun.position.copy(sunOffset);
    sun.shadow.camera.far = theme.sun.shadowFar || 320;
    sun.shadow.camera.updateProjectionMatrix();
    renderer.toneMappingExposure = theme.exposure;
    head.intensity = theme.headlight;
    lightning.startedAt = -1;
    lightning.f = 0;
    lightning.nextAt = theme.lightning ? performance.now() + 2500 + Math.random() * 4000 : 0;
  }

  const _fwd = new THREE.Vector3();
  /** Per frame: sun + headlight follow the car, lightning modulates hemisphere/exposure. */
  function update(nowMs, carPos, carFwd) {
    if (carPos) {
      sun.position.set(carPos.x + sunOffset.x, sunOffset.y, carPos.z + sunOffset.z);
      sun.target.position.set(carPos.x, 0, carPos.z);
      if (theme.headlight > 0 && carFwd) {
        _fwd.set(carFwd.x, 0, carFwd.z).normalize();
        head.position.set(carPos.x + _fwd.x * 2.4, 1.15, carPos.z + _fwd.z * 2.4);
        head.target.position.set(carPos.x + _fwd.x * 34, 0.2, carPos.z + _fwd.z * 34);
      }
    }
    const L = theme.lightning;
    if (!L) return;
    if (lightning.startedAt < 0 && nowMs >= lightning.nextAt) lightning.startedAt = nowMs;
    let f = 0;
    if (lightning.startedAt >= 0) {
      const t = (nowMs - lightning.startedAt) / 1000;
      // two quick pulses then a fade: 0 s, 0.13 s, 0.34 s
      for (const [t0, amp] of [[0, 1], [0.13, 0.7], [0.34, 0.45]]) {
        if (t >= t0) f = Math.max(f, amp * Math.exp(-(t - t0) * 16));
      }
      if (t > 1.1) {
        lightning.startedAt = -1;
        lightning.nextAt = nowMs + (L.gapMin + Math.random() * (L.gapMax - L.gapMin)) * 1000;
      }
    }
    lightning.f = f;
    hemi.intensity = theme.hemi.intensity + L.strength * f;
    renderer.toneMappingExposure = theme.exposure * (1 + L.exposureBoost * f);
  }

  return {
    apply, update, sky, hemi, sun, head,
    get theme() { return theme; },
    get themeId() { return theme.id; },
    get lightningLevel() { return lightning.f; },
  };
}
