// ============================================================================
// progression.js - XP, levels, coins and skins. Pure math + localStorage only:
// NOTHING in here touches the DOM (main.js/ui.js render the results).
//
//   parTimeMs(laps, trackLengthM)          -> ms  (laps * length / PAR_SPEED_MPS)
//   raceXP({ finishMs, healthLeft, place, players, parTimeMs }) -> { base, clean, podium, total }
//   xpToNext(lvl), levelFromXP(totalXP)    -> { lvl, into, need }
//   coinsForXP(totalXP)                    -> floor(totalXP * COIN_RATE)
//   loadProgress(uid) / saveProgress(uid, data)   localStorage "er_progress_v1_<uid|demo>"
//   applyRaceResult(uid, xp)               -> { xp, coins, progress, level, leveledUp }
//   skinsFor(carId), skinColor(carConfig, progress), buySkin(), equipSkin()
//
// Storage record: { xp, coins, owned: { carId: [skinId] }, equipped: { carId: skinId }, races }
// Only TOTAL xp is stored; the level is always derived. Every read/write is
// try/catch-guarded and corrupt/missing data falls back to defaults.
// ============================================================================

// The one tuning knob for "par": average speed (m/s) that earns a 1.0x speed
// multiplier. 28 m/s ~ 100 km/h. Tune after a clean lap.
export const PAR_SPEED_MPS = 28;
export const COIN_RATE = 0.6;          // coins = floor(total XP * COIN_RATE)
export const DEMO_START_COINS = 500;   // Demo Mode's first-run balance

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (Number.isFinite(v) ? v : d);

export function parTimeMs(laps, trackLengthM) {
  return ((laps * trackLengthM) / PAR_SPEED_MPS) * 1000;
}

export function raceXP({ finishMs, healthLeft = 100, place = 1, players = 1, parTimeMs: par }) {
  const speedMult = clamp(par / Math.max(1, finishMs), 0.5, 1.5);
  const base = Math.round(100 * speedMult);
  const clean = Math.round((50 * clamp(num(healthLeft, 0), 0, 100)) / 100);
  const podium = players > 1 ? ([50, 30, 15][place - 1] ?? 5) : 0;
  return { base, clean, podium, total: base + clean + podium, speedMult };
}

export function xpToNext(lvl) {
  return 100 + 50 * (lvl - 1);
}

export function levelFromXP(totalXP) {
  let lvl = 1;
  let into = Math.max(0, Math.floor(num(totalXP, 0)));
  while (into >= xpToNext(lvl)) { into -= xpToNext(lvl); lvl++; }
  return { lvl, into, need: xpToNext(lvl) };
}

export function coinsForXP(totalXP) {
  return Math.floor(Math.max(0, num(totalXP, 0)) * COIN_RATE);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const KEY_PREFIX = "er_progress_v1_";

export function storageKey(uid) {
  return KEY_PREFIX + (uid || "demo");
}

export function defaultProgress(uid) {
  const demo = !uid || uid === "demo";
  return { xp: 0, coins: demo ? DEMO_START_COINS : 0, owned: {}, equipped: {}, races: 0 };
}

export function loadProgress(uid) {
  const base = defaultProgress(uid);
  try {
    const raw = localStorage.getItem(storageKey(uid));
    if (!raw) return base;
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return base;
    return {
      xp: Math.max(0, num(d.xp, 0)),
      coins: Math.max(0, num(d.coins, base.coins)),
      owned: d.owned && typeof d.owned === "object" ? d.owned : {},
      equipped: d.equipped && typeof d.equipped === "object" ? d.equipped : {},
      races: Math.max(0, num(d.races, 0)),
    };
  } catch (_) {
    return base;
  }
}

export function saveProgress(uid, data) {
  try {
    localStorage.setItem(storageKey(uid), JSON.stringify(data));
    return true;
  } catch (_) {
    return false;
  }
}

/** Add one race's XP (+ coins) to the stored record. Returns everything the results screen shows. */
export function applyRaceResult(uid, xp) {
  const before = loadProgress(uid);
  const levelBefore = levelFromXP(before.xp);
  const coins = coinsForXP(xp.total);
  const progress = { ...before, xp: before.xp + xp.total, coins: before.coins + coins, races: before.races + 1 };
  saveProgress(uid, progress);
  const level = levelFromXP(progress.xp);
  return { xp, coins, progress, level, leveledUp: level.lvl > levelBefore.lvl };
}

// ---------------------------------------------------------------------------
// Skins: tints of the existing cars (no models). "default" = the car's own colour.
// ---------------------------------------------------------------------------
export const SKIN_CATALOG = {
  viper:   [{ id: "default", name: "Rosso", price: 0, color: null },
            { id: "midnight", name: "Midnight", price: 300, color: 0x1b1f3a },
            { id: "pearl", name: "Pearl White", price: 800, color: 0xe8ecf2 }],
  kestrel: [{ id: "default", name: "Stock", price: 0, color: null },
            { id: "arancio", name: "Arancio", price: 300, color: 0xff7a00 },
            { id: "verde", name: "Verde", price: 800, color: 0x2fbf71 }],
  brawler: [{ id: "default", name: "Giallo", price: 0, color: null },
            { id: "gulf", name: "Gulf Blue", price: 300, color: 0x3aa0ff },
            { id: "emerald", name: "Emerald", price: 800, color: 0x16a34a }],
};

export function skinsFor(carId) {
  return SKIN_CATALOG[carId] || [{ id: "default", name: "Stock", price: 0, color: null }];
}

export function isOwned(progress, carId, skinId) {
  return skinId === "default" || ((progress.owned || {})[carId] || []).includes(skinId);
}

export function equippedSkinId(progress, carId) {
  const id = (progress.equipped || {})[carId] || "default";
  return isOwned(progress, carId, id) ? id : "default";
}

/** Paint colour for a car given the equipped skin (falls back to the car's own colour). */
export function skinColor(carConfig, progress) {
  try {
    if (!carConfig.paintMaterial && carConfig.model) return carConfig.color; // tint-disabled car
    const id = equippedSkinId(progress, carConfig.id);
    const skin = skinsFor(carConfig.id).find((s) => s.id === id);
    return skin && skin.color != null ? skin.color : carConfig.color;
  } catch (_) {
    return carConfig.color;
  }
}

export function buySkin(uid, carId, skinId) {
  const progress = loadProgress(uid);
  const skin = skinsFor(carId).find((s) => s.id === skinId);
  if (!skin) return { ok: false, reason: "Unknown skin", progress };
  if (isOwned(progress, carId, skinId)) return { ok: false, reason: "Already owned", progress };
  if (progress.coins < skin.price) return { ok: false, reason: `Need ${skin.price - progress.coins} more coins`, progress };
  const owned = { ...progress.owned, [carId]: [...(progress.owned[carId] || []), skinId] };
  const next = { ...progress, coins: progress.coins - skin.price, owned };
  saveProgress(uid, next);
  return { ok: true, progress: next };
}

export function equipSkin(uid, carId, skinId) {
  const progress = loadProgress(uid);
  if (!isOwned(progress, carId, skinId)) return { ok: false, reason: "Not owned", progress };
  const next = { ...progress, equipped: { ...progress.equipped, [carId]: skinId } };
  saveProgress(uid, next);
  return { ok: true, progress: next };
}
