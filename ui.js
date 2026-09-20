// ============================================================================
// ui.js - DOM glue: screen switching, toasts, HUD updates.
// Nothing in here knows about Three.js or physics. UI teammates own this + styles.css.
// ============================================================================

const $ = (sel) => document.querySelector(sel);

export const SCREENS = ["login", "select", "tracks", "lobby", "garage", "race", "results"];
let activeScreen = "login";

/** Cross-fade to a screen. Returns the screen name. */
export function showScreen(name) {
  if (!SCREENS.includes(name)) throw new Error(`Unknown screen: ${name}`);
  for (const s of SCREENS) {
    $(`#screen-${s}`).classList.toggle("active", s === name);
  }
  activeScreen = name;
  document.body.dataset.screen = name;
  return name;
}

export function getActiveScreen() {
  return activeScreen;
}

/** Login screen status line. kind: "" | "ok" | "warn" | "err" */
export function setLoginStatus(msg, kind = "") {
  const el = $("#login-status");
  el.textContent = msg || "";
  el.className = `status ${kind}`.trim();
}

export function setLoginBusy(busy) {
  $("#btn-google").disabled = busy;
}

/** Player chip on the car-select and lobby top bars. */
export function setPlayerChip(player) {
  for (const chip of document.querySelectorAll("#player-chip, #lobby-chip")) {
    chip.innerHTML = "";
    if (!player) continue;
    if (player.photo) {
      const img = document.createElement("img");
      img.src = player.photo;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      chip.appendChild(img);
    }
    const name = document.createElement("span");
    name.textContent = player.name;
    chip.appendChild(name);
    if (player.demo) {
      const tag = document.createElement("span");
      tag.className = "demo-tag";
      tag.textContent = "GUEST";
      chip.appendChild(tag);
    }
  }
}

// ---------------- Multiplayer lobby ----------------

/** Show one lobby panel: "menu" | "join" | "room". */
export function showLobbyPanel(name) {
  $("#lobby-menu").hidden = name !== "menu";
  $("#lobby-join").hidden = name !== "join";
  $("#lobby-room").hidden = name !== "room";
}

export function setStatus(id, msg, kind = "") {
  const el = document.getElementById(id);
  el.textContent = msg || "";
  el.className = `status ${kind}`.trim();
}

/**
 * Room panel. view: multiplayer.js room view; cars: getCar(id) lookup.
 * Pure rendering - main.js decides what the buttons do.
 */
export function renderRoom(view, getCar, maxPlayers, minPlayers) {
  $("#room-code").textContent = view.code;
  $("#room-count").textContent = `${view.players.length}/${maxPlayers}`;

  const list = $("#room-players");
  list.innerHTML = "";
  for (const p of view.players) {
    const car = getCar(p.carId);
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "car-dot";
    dot.style.background = "#" + car.color.toString(16).padStart(6, "0");
    const name = document.createElement("span");
    name.className = "p-name";
    name.textContent = p.name;
    const carName = document.createElement("span");
    carName.className = "p-car";
    carName.textContent = car.name;
    li.append(dot, name, carName);
    if (p.isHost) li.append(tagEl("HOST"));
    if (p.isMe) li.append(tagEl("YOU", "you"));
    list.appendChild(li);
  }
  for (let i = view.players.length; i < maxPlayers; i++) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Waiting for racer...";
    list.appendChild(li);
  }

  const start = $("#btn-room-start");
  start.hidden = !view.isHost;
  start.disabled = view.players.length < minPlayers || view.status !== "waiting";
}

function tagEl(text, extra = "") {
  const t = document.createElement("span");
  t.className = `tag ${extra}`.trim();
  t.textContent = text;
  return t;
}

/** Temporary toast. kind: "" | "ok" | "warn" | "err" */
export function toast(msg, kind = "", ms = 3200) {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = `toast ${kind}`.trim();
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 250ms";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/** Full-screen loading overlay. Pass null to hide. */
export function setLoading(msg) {
  const el = $("#loading-overlay");
  el.classList.toggle("show", Boolean(msg));
  $("#loading-text").textContent = msg || "";
}

// ---------------- Race HUD ----------------

export function setHudLap(lap, total) {
  $("#hud-lap").textContent = lap;
  $("#hud-laps").textContent = total;
}

export function setHudTime(ms) {
  $("#hud-time").textContent = formatTime(ms);
}

export function setHudBest(ms) {
  $("#hud-best").textContent = ms == null ? "" : `BEST ${formatTime(ms)}`;
}

export function setHudSpeed(kmh) {
  $("#hud-speed").textContent = Math.round(kmh);
}

/** Health/damage meter. pct: 0-100 (caller clamps; this clamps again defensively
 *  so a bad input can never render a negative width or break the layout). */
let _lastHp = 100;
export function setHudHealth(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const hud = document.querySelector(".health-hud");
  if (hud) {
    const lvl = clamped > 60 ? "high" : clamped >= 30 ? "mid" : "low";
    if (hud.dataset.level !== lvl) hud.dataset.level = lvl;
    if (clamped < _lastHp - 0.01) { // damage taken: restart the flash + shake animation
      hud.classList.remove("hit"); void hud.offsetWidth; hud.classList.add("hit");
    }
  }
  _lastHp = clamped;
  $("#hud-health-pct").textContent = `${Math.round(clamped)}%`;
  const fill = $("#hud-health-fill");
  fill.style.width = `${clamped}%`;
  fill.style.filter = "none"; // colour + pulse now come from .health-hud[data-level] in styles.css
}

/** Reusable HUD banner (RESPAWNING / RECONNECTING / ...). Empty string hides it. */
export function setHudBanner(text) {
  const el = $("#hud-banner");
  const t = text || "";
  if (el.textContent !== t) el.textContent = t;
  if (el.hidden !== !t) el.hidden = !t;
}

export function setHudTrack(name) { $("#hud-track").textContent = name || ""; }
export function setResultsTrack(text) { $("#results-track").textContent = text || ""; }
export function setRoomTrack(name) { $("#room-track").textContent = name ? `TRACK: ${name}` : ""; }

export function setHudCamera(mode) {
  $("#hud-cam").textContent = mode.toUpperCase();
}

let commentaryTimer = null;
export function showCommentary(text, ms = 4000) {
  const el = $("#hud-commentary");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(commentaryTimer);
  commentaryTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/**
 * In-race live standings (multiplayer only). entries: sorted array of
 * { uid, name, isMe, lap, dist } from main.js's computeLeaderboard(), or null
 * to hide it (solo races, or once the race screen is left).
 */
export function renderLeaderboard(entries) {
  const el = $("#hud-leaderboard");
  el.innerHTML = "";
  if (!entries || entries.length === 0) { el.hidden = true; return; }
  el.hidden = false;
  entries.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "lb-row" + (p.isMe ? " me" : "");
    const rank = document.createElement("span");
    rank.className = "lb-rank";
    rank.textContent = i + 1;
    const name = document.createElement("span");
    name.className = "lb-name";
    name.textContent = p.name; // player-supplied - textContent only, never innerHTML
    row.append(rank, name);
    el.appendChild(row);
  });
}

export function setHudCenter(text) {
  const el = $("#hud-center");
  if (el.textContent !== (text || "")) {
    el.textContent = text || "";
    el.classList.remove("pop");
    void el.offsetWidth; // restart animation
    if (text) el.classList.add("pop");
  }
}

// ---------------- Results ----------------

export function renderResults(player, lapTimes) {
  $("#results-name").textContent = player ? player.name : "";
  const list = $("#results-laps");
  list.innerHTML = "";
  if (!lapTimes || lapTimes.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No laps completed";
    list.appendChild(li);
    return;
  }
  const best = Math.min(...lapTimes);
  lapTimes.forEach((t, i) => {
    const li = document.createElement("li");
    if (t === best) li.classList.add("best");
    li.innerHTML = `<span>Lap ${i + 1}</span><span>${formatTime(t)}</span>`;
    list.appendChild(li);
  });
  const total = document.createElement("li");
  total.className = "total";
  total.innerHTML = `<span>Total</span><span>${formatTime(lapTimes.reduce((a, b) => a + b, 0))}</span>`;
  list.appendChild(total);
}

/**
 * Multiplayer results table on the results screen. entries: sorted ascending
 * by finishTimeMs, from main.js's computeResultsBoard() - [{ uid, name, isMe,
 * finishTimeMs, bestLapMs, totalLaps }]. Pass null/empty to hide the section
 * (solo races). Fills in incrementally as stragglers finish - callers just
 * re-call this with a longer/updated list, no separate "waiting" state needed.
 */
export function renderMultiplayerBoard(entries) {
  const section = $("#results-mp");
  const list = $("#results-mp-list");
  list.innerHTML = "";
  if (!entries) { section.hidden = true; return; }
  section.hidden = false;
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Waiting for racers to finish...";
    list.appendChild(li);
    return;
  }
  entries.forEach((p, i) => {
    const li = document.createElement("li");
    if (p.isMe) li.classList.add("me");
    const rank = document.createElement("span");
    rank.className = "mp-rank";
    rank.textContent = i + 1;
    const name = document.createElement("span");
    name.className = "mp-name";
    name.textContent = p.name;
    const time = document.createElement("span");
    time.className = "mp-time";
    time.textContent = formatTime(p.finishTimeMs);
    li.append(rank, name, time);
    list.appendChild(li);
  });
}

// ---------------- Progression (Task 8/9/10) ----------------

/** Results-screen XP block. data: { xp:{base,clean,podium,total}, coins, level:{lvl,into,need},
 *  progress:{coins}, players } from main.js, or null to hide (quit / no laps). */
export function renderProgress(data) {
  const box = $("#results-xp");
  if (!data) { box.hidden = true; return; }
  box.hidden = false;
  $("#xp-base").textContent = data.xp.base;
  $("#xp-clean").textContent = data.xp.clean;
  $("#xp-podium").textContent = data.xp.podium;
  $("#xp-podium-row").hidden = !(data.players > 1);
  $("#xp-total").textContent = data.xp.total;
  $("#xp-level").textContent = data.level.lvl;
  $("#xp-into").textContent = data.level.into;
  $("#xp-need").textContent = data.level.need;
  $("#xp-bar-fill").style.width = `${Math.round((100 * data.level.into) / data.level.need)}%`;
  $("#xp-coins").textContent = data.coins;
  $("#xp-balance").textContent = data.progress.coins;
}

export function setCoinBalance(coins) {
  for (const el of document.querySelectorAll("#coin-balance, #garage-coins")) el.textContent = coins;
}

/**
 * Garage skin list. rows: [{ id, name, price, colorHex, owned, equipped }]; null rows => "Stock only".
 * onBuy(id) / onEquip(id) are wired by main.js; this only renders.
 */
export function renderGarage(carName, rows, onBuy, onEquip) {
  $("#garage-car").textContent = carName;
  const list = $("#skin-list");
  list.innerHTML = "";
  if (!rows) {
    const li = document.createElement("li");
    li.className = "stock-only";
    li.textContent = "Stock only - this car keeps its own livery.";
    list.appendChild(li);
    return;
  }
  for (const r of rows) {
    const li = document.createElement("li");
    if (r.equipped) li.classList.add("equipped");
    const sw = document.createElement("span");
    sw.className = "skin-swatch";
    sw.style.background = `linear-gradient(135deg, ${r.colorHex}, #000 160%)`;
    const name = document.createElement("span");
    name.className = "skin-name";
    name.textContent = r.name;
    const price = document.createElement("span");
    price.className = "skin-price";
    price.textContent = r.owned ? (r.price ? "Owned" : "Free") : `${r.price} coins`;
    const btn = document.createElement("button");
    btn.className = "btn " + (r.equipped ? "btn-ghost" : "btn-primary");
    btn.textContent = r.equipped ? "Equipped" : (r.owned ? "Equip" : "Buy");
    btn.disabled = r.equipped;
    btn.dataset.sfx = "none"; // audio.js: buy/equip play their own chime/buzz, skip the generic click
    btn.addEventListener("click", () => (r.owned ? onEquip(r.id) : onBuy(r.id)));
    li.append(sw, name, price, btn);
    list.appendChild(li);
  }
}

export function formatTime(ms) {
  if (!Number.isFinite(ms)) return "--:--.---";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = Math.floor(ms % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}
