// ============================================================================
// audio.js - procedural Web Audio (no asset files, no dependencies).
// Imports NOTHING from the game; main.js / ui.js call in. Every public function is
// wrapped so a bug in here can never break racing, menus or results.
//
//   initAudio()                       once at boot: gesture unlock, tab-visibility, M key,
//                                     delegated UI sounds, mute buttons (.btn-mute)
//   toggleMute() / setVolume(v)       persisted in localStorage "er_audio_v1" {muted, volume}
//   engineStart() / engineUpdate({kmh, throttle, boost, slip, countdown}) / engineStop()
//   remoteEngine(uid, distM, kmh) / removeRemoteEngine(uid)      (max 3, quiet, by distance)
//   reportFrame(dt)                   FPS guard: drops remote engines first when slow
//   countdownBeep() goBeep() lapDing() finishFanfare() resultsSting() collision(impact)
//   boostWhoosh() repairChime() respawnSweep() wrongWayBeep() lowHpBeep()
//   uiClick() uiHover() uiConfirm() uiBack() buy() denied()
//   audioStats()                      diagnostics (context state, live node count, engine params)
//
// Graph: sources -> sfxBus/engBus -> master gain (0.6 * volume, 0 when muted)
//        -> DynamicsCompressor -> destination.
// ============================================================================

const KEY = "er_audio_v1";
const MASTER_BASE = 0.6;
const MAX_VOICES = 12;          // simultaneous one-shot SFX voices
const MAX_REMOTE_ENGINES = 3;

let ctx = null;
let master = null, comp = null, sfxBus = null, engBus = null, noiseBuf = null;
let settings = { muted: false, volume: 1 };
let voices = 0;
let liveNodes = 0;              // engine + remote-engine nodes currently connected
let inited = false;
let lowFps = false;
let fpsEma = 1 / 60;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const safe = (fn) => (...args) => { try { return fn(...args); } catch (_) { /* audio must never break the game */ } };
const running = () => !!ctx && ctx.state === "running";

// ---------------------------------------------------------------------------
// Settings + context
// ---------------------------------------------------------------------------
function loadSettings() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && typeof d === "object") {
      settings.muted = !!d.muted;
      const v = Number(d.volume);
      settings.volume = Number.isFinite(v) ? clamp(v, 0, 1) : 1;
    }
  } catch (_) { /* defaults */ }
}
function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) { /* private mode */ }
}

function applyMaster() {
  if (!ctx || !master) return;
  master.gain.setTargetAtTime(settings.muted ? 0 : MASTER_BASE * settings.volume, ctx.currentTime, 0.02);
}

function buildGraph() {
  master = ctx.createGain();
  master.gain.value = settings.muted ? 0 : MASTER_BASE * settings.volume;
  comp = ctx.createDynamicsCompressor();
  sfxBus = ctx.createGain();
  engBus = ctx.createGain();
  sfxBus.connect(master);
  engBus.connect(master);
  master.connect(comp);
  comp.connect(ctx.destination);
  // 1 s of white noise, shared by every noise burst / squeal.
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

/** Create/resume the context. Only ever called from a user gesture or a later audio call. */
function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    buildGraph();
    ctx.addEventListener("statechange", () => refreshMuteButtons());
  }
  if (ctx.state === "suspended" && !document.hidden) ctx.resume().catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// One-shot voices (limited to MAX_VOICES; no-op unless the context is running)
// ---------------------------------------------------------------------------
function tone({ f0, f1 = f0, type = "sine", dur = 0.15, gain = 0.2, delay = 0, attack = 0.004 }) {
  if (!running() || settings.muted || voices >= MAX_VOICES) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(sfxBus);
  voices++;
  o.onended = () => { voices--; try { o.disconnect(); g.disconnect(); } catch (_) { /* gone */ } };
  o.start(t);
  o.stop(t + dur + 0.03);
}

function noise({ dur = 0.2, gain = 0.3, type = "lowpass", f0 = 1000, f1 = f0, q = 0.7, delay = 0 }) {
  if (!running() || settings.muted || voices >= MAX_VOICES) return;
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(sfxBus);
  voices++;
  s.onended = () => { voices--; try { s.disconnect(); f.disconnect(); g.disconnect(); } catch (_) { /* gone */ } };
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.03);
}

// ---------------------------------------------------------------------------
// UI sounds
// ---------------------------------------------------------------------------
export const uiClick = safe(() => tone({ f0: 520, f1: 760, type: "triangle", dur: 0.055, gain: 0.12 }));
export const uiHover = safe(() => tone({ f0: 1800, type: "sine", dur: 0.03, gain: 0.05 }));
export const uiConfirm = safe(() => {
  tone({ f0: 620, type: "triangle", dur: 0.09, gain: 0.14 });
  tone({ f0: 930, type: "triangle", dur: 0.14, gain: 0.14, delay: 0.07 });
});
export const uiBack = safe(() => tone({ f0: 520, f1: 320, type: "triangle", dur: 0.11, gain: 0.13 }));
export const buy = safe(() => {
  [880, 1175, 1568].forEach((f, i) => tone({ f0: f, type: "sine", dur: 0.28, gain: 0.16, delay: i * 0.07 }));
});
export const denied = safe(() => {
  tone({ f0: 150, type: "square", dur: 0.2, gain: 0.1 });
  tone({ f0: 112, type: "square", dur: 0.2, gain: 0.1, delay: 0.02 });
});

const CONFIRM_IDS = new Set(["btn-race", "btn-multiplayer", "btn-host", "btn-join", "btn-room-start", "btn-again", "btn-google", "btn-skip", "btn-garage"]);
const BACK_IDS = new Set(["btn-signout", "btn-garage-back", "btn-lobby-back", "btn-join-back", "btn-room-leave", "btn-change-car", "btn-quit"]);

// ---------------------------------------------------------------------------
// Race SFX
// ---------------------------------------------------------------------------
export const countdownBeep = safe(() => tone({ f0: 440, type: "square", dur: 0.16, gain: 0.13 }));
export const goBeep = safe(() => {
  tone({ f0: 880, type: "square", dur: 0.45, gain: 0.14 });
  tone({ f0: 1320, type: "square", dur: 0.45, gain: 0.06 });
});
export const lapDing = safe(() => {
  tone({ f0: 1046, type: "sine", dur: 0.32, gain: 0.17 });
  tone({ f0: 1568, type: "sine", dur: 0.4, gain: 0.13, delay: 0.09 });
});
export const finishFanfare = safe(() => {
  [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, type: "triangle", dur: 0.26, gain: 0.15, delay: i * 0.12 }));
  tone({ f0: 1046, type: "triangle", dur: 0.8, gain: 0.13, delay: 0.5 });
  tone({ f0: 1318, type: "triangle", dur: 0.8, gain: 0.1, delay: 0.5 });
});
export const resultsSting = safe(() => {
  [392, 494, 587].forEach((f) => tone({ f0: f, type: "triangle", dur: 0.9, gain: 0.1 }));
  tone({ f0: 1568, f1: 1175, type: "sine", dur: 0.6, gain: 0.07, delay: 0.1 });
});

let lastCollAt = 0;
export const collision = safe((impact) => {
  const t = performance.now();
  if (t - lastCollAt < 150) return; // throttle
  lastCollAt = t;
  const k = clamp((Number(impact) || 0) / 14, 0.15, 1);
  noise({ dur: 0.22, gain: 0.5 * k, type: "lowpass", f0: 300 + 1800 * k, f1: 200 });
  tone({ f0: 110, f1: 45, type: "sine", dur: 0.22, gain: 0.32 * k });
});
export const boostWhoosh = safe(() => {
  noise({ dur: 0.75, gain: 0.22, type: "bandpass", f0: 500, f1: 3200, q: 1.4 });
  tone({ f0: 300, f1: 1300, type: "sine", dur: 0.5, gain: 0.07 });
});
export const repairChime = safe(() => {
  tone({ f0: 784, type: "sine", dur: 0.25, gain: 0.15 });
  tone({ f0: 1175, type: "sine", dur: 0.38, gain: 0.15, delay: 0.09 });
});
export const respawnSweep = safe(() => {
  tone({ f0: 180, f1: 1400, type: "sawtooth", dur: 0.55, gain: 0.08 });
  noise({ dur: 0.5, gain: 0.08, type: "highpass", f0: 800, f1: 4000 });
});
export const wrongWayBeep = safe(() => tone({ f0: 520, type: "square", dur: 0.12, gain: 0.13 }));
export const lowHpBeep = safe(() => {
  tone({ f0: 330, type: "square", dur: 0.08, gain: 0.11 });
  tone({ f0: 330, type: "square", dur: 0.08, gain: 0.11, delay: 0.13 });
});

// ---------------------------------------------------------------------------
// Local engine: 2 detuned sawtooth + sub square -> lowpass, RPM with 5 gears.
// Parameters only ever move via setTargetAtTime; no per-frame allocation.
// ---------------------------------------------------------------------------
const GEAR_TOP = [0, 40, 78, 115, 158, 215]; // km/h: gear g spans [GEAR_TOP[g-1], GEAR_TOP[g]]
const IDLE_RPM = 900;
const REDLINE_RPM = 7200;

/** Pure: gear, normalised rev position and rpm for a road speed. rpm falls on each upshift. */
export function rpmModel(kmh) {
  const v = Math.max(0, Number(kmh) || 0);
  let g = 1;
  while (g < 5 && v >= GEAR_TOP[g]) g++;
  const frac = clamp((v - GEAR_TOP[g - 1]) / (GEAR_TOP[g] - GEAR_TOP[g - 1]), 0, 1);
  const rf = g === 1 ? 0.05 + 0.95 * frac : 0.38 + 0.62 * frac;
  return { gear: g, rf, rpm: IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * rf };
}
const fundamental = (rpm) => (rpm / 60) * 4; // ~V8: 4 firing pulses per revolution

let eng = null;
let wantEngine = false; // a race is on; start (or restart) the engine as soon as the context runs

export const engineStart = safe(() => {
  wantEngine = true;
  if (eng || !running()) return;
  lowFps = false;
  fpsEma = 1 / 60;
  const nodes = [];
  const sources = [];
  const mk = (n) => { nodes.push(n); return n; };
  const o1 = mk(ctx.createOscillator()); o1.type = "sawtooth";
  const o2 = mk(ctx.createOscillator()); o2.type = "sawtooth"; o2.detune.value = 14;
  const sub = mk(ctx.createOscillator()); sub.type = "square";
  const whine = mk(ctx.createOscillator()); whine.type = "sine";
  const sq = mk(ctx.createBufferSource()); sq.buffer = noiseBuf; sq.loop = true;
  const g1 = mk(ctx.createGain()); g1.gain.value = 0.5;
  const g2 = mk(ctx.createGain()); g2.gain.value = 0.4;
  const gs = mk(ctx.createGain()); gs.gain.value = 0.3;
  const lp = mk(ctx.createBiquadFilter()); lp.type = "lowpass"; lp.Q.value = 2.5; lp.frequency.value = 600;
  const gEng = mk(ctx.createGain()); gEng.gain.value = 0;
  const gWhine = mk(ctx.createGain()); gWhine.gain.value = 0;
  const bp = mk(ctx.createBiquadFilter()); bp.type = "bandpass"; bp.Q.value = 9; bp.frequency.value = 2400;
  const gSq = mk(ctx.createGain()); gSq.gain.value = 0;
  o1.connect(g1); o2.connect(g2); sub.connect(gs);
  g1.connect(lp); g2.connect(lp); gs.connect(lp);
  lp.connect(gEng); gEng.connect(engBus);
  whine.connect(gWhine); gWhine.connect(engBus);
  sq.connect(bp); bp.connect(gSq); gSq.connect(engBus);
  [o1, o2, sub, whine, sq].forEach((s) => { s.start(); sources.push(s); });
  liveNodes += nodes.length;
  eng = { nodes, sources, o1, o2, sub, whine, lp, gEng, gWhine, bp, gSq, rpm: IDLE_RPM, lastAt: 0, gear: 1, freq: 0 };
  // Ease in from silence.
  gEng.gain.setTargetAtTime(0.06, ctx.currentTime, 0.15);
});

export const engineUpdate = safe(({ kmh = 0, throttle = 0, boost = false, slip = 0, countdown = false } = {}) => {
  if (!eng && wantEngine && running()) engineStart(); // context finished resuming after the race began
  if (!eng || !running()) return;
  const now = ctx.currentTime;
  if (now - eng.lastAt < 0.03) return; // ~33 Hz is plenty for a parameter follower
  eng.lastAt = now;
  const m = rpmModel(countdown ? 0 : kmh);
  eng.rpm += (m.rpm - eng.rpm) * 0.4;   // rev needle lag (also softens the upshift drop)
  eng.gear = m.gear;
  const thr = countdown ? 0 : clamp(Math.abs(throttle), 0, 1);
  const f = fundamental(eng.rpm);
  eng.freq = f;
  const tc = 0.045;
  eng.o1.frequency.setTargetAtTime(f, now, tc);
  eng.o2.frequency.setTargetAtTime(f, now, tc);
  eng.sub.frequency.setTargetAtTime(f * 0.5, now, tc);
  eng.lp.frequency.setTargetAtTime(450 + m.rf * 2300 + thr * 900, now, tc);
  eng.gEng.gain.setTargetAtTime(0.05 + thr * 0.1 + m.rf * 0.05, now, 0.08);
  eng.whine.frequency.setTargetAtTime(800 + (Number(kmh) || 0) * 7, now, tc);
  eng.gWhine.gain.setTargetAtTime(boost ? 0.045 : 0, now, 0.08);
  const s = clamp(slip, 0, 1);
  eng.bp.frequency.setTargetAtTime(2200 + s * 1400, now, 0.06);
  eng.gSq.gain.setTargetAtTime(s > 0.12 ? s * 0.07 : 0, now, 0.06);
});

export const engineStop = safe(() => {
  wantEngine = false;
  clearRemoteEngines();
  if (!eng) return;
  const e = eng;
  eng = null;
  try { e.gEng.gain.setTargetAtTime(0, ctx.currentTime, 0.07); e.gWhine.gain.setTargetAtTime(0, ctx.currentTime, 0.05); e.gSq.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } catch (_) { /* ctx gone */ }
  setTimeout(() => {
    e.sources.forEach((s) => { try { s.stop(); } catch (_) { /* already stopped */ } });
    e.nodes.forEach((n) => { try { n.disconnect(); } catch (_) { /* gone */ } });
    liveNodes -= e.nodes.length;
  }, 450);
});

// ---------------------------------------------------------------------------
// Remote engines (multiplayer): <= 3 quiet voices, gain by distance. First to appear wins
// a slot. Dropped first if FPS falls (reportFrame).
// ---------------------------------------------------------------------------
const remotes = new Map();

export const remoteEngine = safe((uid, distM, kmh) => {
  if (!running() || settings.muted || lowFps) return;
  let r = remotes.get(uid);
  if (!r) {
    if (remotes.size >= MAX_REMOTE_ENGINES) return;
    const nodes = [];
    const mk = (n) => { nodes.push(n); return n; };
    const o = mk(ctx.createOscillator()); o.type = "sawtooth";
    const f = mk(ctx.createBiquadFilter()); f.type = "lowpass"; f.frequency.value = 700; f.Q.value = 1.5;
    const g = mk(ctx.createGain()); g.gain.value = 0;
    o.connect(f); f.connect(g); g.connect(engBus);
    o.start();
    liveNodes += nodes.length;
    r = { o, f, g, nodes };
    remotes.set(uid, r);
  }
  const now = ctx.currentTime;
  const m = rpmModel(kmh);
  r.o.frequency.setTargetAtTime(fundamental(m.rpm), now, 0.08);
  r.f.frequency.setTargetAtTime(400 + m.rf * 1500, now, 0.08);
  const near = clamp(1 - (Number(distM) || 0) / 140, 0, 1);
  r.g.gain.setTargetAtTime(near * near * 0.05, now, 0.12);
});

export const removeRemoteEngine = safe((uid) => {
  const r = remotes.get(uid);
  if (!r) return;
  remotes.delete(uid);
  try { r.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } catch (_) { /* ctx gone */ }
  setTimeout(() => {
    try { r.o.stop(); } catch (_) { /* stopped */ }
    r.nodes.forEach((n) => { try { n.disconnect(); } catch (_) { /* gone */ } });
    liveNodes -= r.nodes.length;
  }, 300);
});

function clearRemoteEngines() {
  for (const uid of [...remotes.keys()]) removeRemoteEngine(uid);
}

/** Feed every rendered race frame's dt: if the frame rate sinks, remote engines go first. */
export const reportFrame = safe((dt) => {
  fpsEma = fpsEma * 0.95 + dt * 0.05;
  if (!lowFps && fpsEma > 0.036) { lowFps = true; clearRemoteEngines(); }
});

// ---------------------------------------------------------------------------
// Mute / volume / buttons
// ---------------------------------------------------------------------------
function refreshMuteButtons() {
  for (const b of document.querySelectorAll(".btn-mute")) {
    b.textContent = settings.muted ? "\u{1F507}" : "\u{1F50A}";
    b.setAttribute("aria-pressed", settings.muted ? "true" : "false");
    b.title = settings.muted ? "Sound off (M)" : "Sound on (M)";
  }
}

export const toggleMute = safe(() => {
  settings.muted = !settings.muted;
  saveSettings();
  applyMaster();
  refreshMuteButtons();
  if (!settings.muted) uiConfirm();
  return settings.muted;
});
export const isMuted = () => settings.muted;
export const setVolume = safe((v) => { settings.volume = clamp(Number(v) || 0, 0, 1); saveSettings(); applyMaster(); });

export function audioStats() {
  return {
    state: ctx ? ctx.state : "none",
    muted: settings.muted,
    volume: settings.volume,
    masterGain: master ? +master.gain.value.toFixed(3) : null,
    voices,
    liveNodes,
    remoteEngines: remotes.size,
    lowFps,
    engine: eng ? {
      gear: eng.gear, rpm: Math.round(eng.rpm), freqHz: +eng.o1.frequency.value.toFixed(1),
      gain: +eng.gEng.gain.value.toFixed(3), filterHz: Math.round(eng.lp.frequency.value),
      whineGain: +eng.gWhine.gain.value.toFixed(3), squealGain: +eng.gSq.gain.value.toFixed(3),
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Init: first-gesture unlock, tab visibility, M key, delegated UI sounds
// ---------------------------------------------------------------------------
export const initAudio = safe(() => {
  if (inited) return;
  inited = true;
  loadSettings();
  refreshMuteButtons();

  let lastHover = null;
  let lastHoverAt = 0;

  // Capture phase so it runs before any handler that might stopPropagation.
  document.addEventListener("pointerdown", (e) => {
    try {
      ensureCtx(); // unlock on the first gesture
      const el = e.target && e.target.closest ? e.target.closest("button, .car-card, .room-code") : null;
      if (!el || el.disabled || el.dataset.sfx === "none" || el.classList.contains("btn-mute")) return;
      if (el.classList.contains("car-card") || CONFIRM_IDS.has(el.id)) uiConfirm();
      else if (BACK_IDS.has(el.id)) uiBack();
      else uiClick();
    } catch (_) { /* never break input */ }
  }, true);

  document.addEventListener("pointerover", (e) => {
    try {
      const card = e.target && e.target.closest ? e.target.closest(".car-card") : null;
      const t = performance.now();
      if (card && card !== lastHover && !card.classList.contains("selected") && t - lastHoverAt > 90) { lastHoverAt = t; uiHover(); }
      lastHover = card;
    } catch (_) { /* ignore */ }
  }, true);

  document.addEventListener("keydown", (e) => {
    try {
      ensureCtx();
      if ((e.code === "KeyM" || e.key === "m" || e.key === "M") && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) toggleMute();
    } catch (_) { /* ignore */ }
  }, true);

  document.addEventListener("click", (e) => {
    try { if (e.target && e.target.closest && e.target.closest(".btn-mute")) toggleMute(); } catch (_) { /* ignore */ }
  });

  document.addEventListener("visibilitychange", () => {
    try {
      if (!ctx) return;
      if (document.hidden) ctx.suspend().catch(() => {});
      else ctx.resume().catch(() => {});
    } catch (_) { /* ignore */ }
  });
});
