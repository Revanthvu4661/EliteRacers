// ============================================================================
// multiplayer.js - online rooms on Firebase Realtime Database (no custom server).
//
// Public API (every async call throws an Error whose .message is user-facing):
//   hostRoom(profile)            -> Promise<code>   create a room, join it as host
//   joinRoom(code, profile)      -> Promise<code>   join a waiting room
//   startRoomRace()              -> Promise<void>   host only: status "racing" + start time
//   leaveRoom()                  -> Promise<void>   leave (host leaving a waiting room closes it)
//   onRoomChange(fn)             -> fn(view | null, reason?) on every room update
//   getRoom()                    -> current view or null
//   serverToLocalTime(ms)        -> converts a server timestamp to local Date.now() time
//   writeMyState(snapshot)       -> throttled (~12Hz), fire-and-forget in-race telemetry write
//   writeMyResult(result)        -> one-shot write when the local player finishes
//
// profile = { name, carId }
//
// Data layout (/rooms/{code}):
//   { hostId, status: "waiting"|"racing"|"finished", createdAt, raceStartAt,
//     players: { <uid>: { name, carId, position, quaternion, speed, lap, finished, joinedAt,
//                          state?: { position, quaternion, speedKmh, currentLap,
//                                    currentCheckpoint, trackDistance, updatedAt } } },
//     results?: { <uid>: { finishTimeMs, bestLapMs, totalLaps, finishedAt } } }
//
// `players/{uid}` (identity: name/carId/joinedAt) is written once on join and rarely
// after. `players/{uid}/state` (position/lap/etc) is written ~12x/sec while racing -
// kept as its own nested object so the two write patterns don't fight each other, and
// so the single room-level onValue listener below is enough to drive both the lobby
// list and, later, remote-car rendering + the leaderboard - no second listener needed.
//
// Degrades gracefully: the SDK loads lazily, connecting has a timeout, and any
// failure surfaces as a message so the UI can offer solo play instead.
// ============================================================================

import { getFirebaseApp, ensureFirebaseUid } from "./auth.js?v=87";

const SDK_URL = "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const START_DELAY_MS = 3000;

// Uppercase + digits minus the ambiguous 0/O and 1/I (and L, which reads as 1 aloud).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

const CONNECT_TIMEOUT_MS = 8000;

let fb = null;             // firebase-database ES module
let db = null;
let uid = null;
let serverOffset = 0;      // server time = Date.now() + serverOffset
let room = null;           // { code, roomRef, playerRef, unsubscribe, view }
let roomListener = () => {};
let connectionListener = () => {}; // fn(connected: bool) - fed by .info/connected (HUD "RECONNECTING" banner)

/** Subscribe to Firebase's own socket state. Fires only once online play has been used. */
export function onConnectionChange(fn) {
  connectionListener = fn;
}

// ---------------------------------------------------------------------------

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function serverNow() {
  return Date.now() + serverOffset;
}

export function serverToLocalTime(serverMs) {
  return serverMs - serverOffset;
}

export function getUid() {
  return uid;
}

export function getRoom() {
  return room ? room.view : null;
}

export function onRoomChange(fn) {
  roomListener = fn || (() => {});
}

function friendly(err, fallback) {
  const msg = err?.message || "";
  if (/permission.denied/i.test(msg) || err?.code === "PERMISSION_DENIED") {
    return "The game server refused the request (check Realtime Database rules).";
  }
  return msg || fallback;
}

/** Load the SDK, sign in (anonymously for guests) and confirm the database is reachable. */
async function connect() {
  const app = getFirebaseApp();
  if (!app) throw new Error("Online play is unavailable right now. Race solo instead.");

  uid = await ensureFirebaseUid();

  if (!fb) {
    fb = await withTimeout(import(SDK_URL), CONNECT_TIMEOUT_MS, "Couldn't load the multiplayer service. Check your connection.");
    db = fb.getDatabase(app);
    fb.onValue(fb.ref(db, ".info/serverTimeOffset"), (s) => { serverOffset = s.val() || 0; });
    // Persistent (never unsubscribed) so main.js can show/clear a reconnect banner mid-race.
    fb.onValue(fb.ref(db, ".info/connected"), (s) => { try { connectionListener(s.val() === true); } catch (_) { /* UI only */ } });
  }

  // .info/connected fires false first, then true once the socket is up.
  await withTimeout(new Promise((resolve) => {
    const stop = fb.onValue(fb.ref(db, ".info/connected"), (s) => {
      if (s.val() === true) { stop(); resolve(); }
    });
  }), CONNECT_TIMEOUT_MS, "Can't reach the game server. Check your Wi-Fi, or race solo.");
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function playerNode(profile) {
  return {
    name: String(profile.name || "Racer").slice(0, 24),
    carId: profile.carId,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    speed: 0,
    lap: 0,
    finished: false,
    joinedAt: serverNow(),
  };
}

/** Deterministic grid order: uids sorted by joinedAt, then uid. Pure. */
export function orderUids(players) {
  return [...players]
    .sort((a, b) => ((a.joinedAt || 0) - (b.joinedAt || 0)) || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
    .map((p) => p.uid);
}

/**
 * Grid slot for `uid` in a room view: the host-written `order` (identical on every client)
 * when it is present and lists this uid, otherwise derived from the players known now with
 * the same sort. Returns -1 only if the uid isn't in the room at all. Pure.
 */
export function slotFor(view, uid) {
  if (!view) return -1;
  const order = Array.isArray(view.order) && view.order.includes(uid) ? view.order : orderUids(view.players || []);
  return order.indexOf(uid);
}

function buildView(code, data) {
  const players = Object.entries(data.players || {})
    .map(([id, p]) => ({ uid: id, name: p.name, carId: p.carId, joinedAt: p.joinedAt || 0,
                         isHost: id === data.hostId, isMe: id === uid, state: p.state || null }))
    .sort((a, b) => a.joinedAt - b.joinedAt);
  return {
    code,
    status: data.status,
    hostId: data.hostId,
    isHost: data.hostId === uid,
    hostPresent: players.some((p) => p.isHost),
    raceStartAt: data.raceStartAt || null,
    trackId: typeof data.trackId === "string" ? data.trackId : null,
    order: Array.isArray(data.order) ? data.order : (data.order && typeof data.order === "object" ? Object.values(data.order) : null),
    players,
    results: data.results || null,
    raw: data,
  };
}

/** Subscribe to the room and register disconnect cleanup. */
async function attach(code, isHost) {
  const roomRef = fb.ref(db, `rooms/${code}`);
  const playerRef = fb.ref(db, `rooms/${code}/players/${uid}`);

  // Dropped connection -> our player node disappears for everyone else.
  // A host dropping out of a *waiting* room closes the room entirely.
  await fb.onDisconnect(playerRef).remove();
  if (isHost) await fb.onDisconnect(roomRef).remove();

  room = { code, roomRef, playerRef, isHost, view: null, unsubscribe: null };
  const myRoom = room;
  myRoom.unsubscribe = fb.onValue(roomRef, (snap) => {
    if (room !== myRoom) return;
    const data = snap.val();
    if (!data) { detach(); roomListener(null, "The host closed the room."); return; }
    if (!data.players || !data.players[uid]) { detach(); roomListener(null, "You were disconnected from the room."); return; }
    myRoom.view = buildView(code, data);
    roomListener(myRoom.view);
  }, (err) => {
    if (room !== myRoom) return;
    detach();
    roomListener(null, friendly(err, "Lost connection to the room."));
  });
}

function detach() {
  if (!room) return;
  if (room.unsubscribe) room.unsubscribe();
  room = null;
}

// ---------------------------------------------------------------------------

export async function hostRoom(profile) {
  await leaveRoom();
  try {
    await connect();
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      const newRoom = {
        hostId: uid,
        status: "waiting",
        createdAt: serverNow(),
        // The host picks the track; every client loads this one. (database.rules.json does not
        // constrain extra fields under rooms/$code, so no rules change is needed.)
        trackId: String(profile.trackId || "green-valley").slice(0, 40),
        players: { [uid]: playerNode(profile) },
      };
      // Create only if the code is free. (A null guess that's wrong is retried
      // by the SDK with the real server value, which we then decline.)
      const res = await fb.runTransaction(fb.ref(db, `rooms/${code}`), (cur) => (cur === null ? newRoom : undefined));
      if (res.committed) {
        await attach(code, true);
        return code;
      }
    }
    throw new Error("Couldn't find a free room code. Try again.");
  } catch (err) {
    console.warn("[mp] hostRoom:", err);
    throw new Error(friendly(err, "Couldn't create a room."));
  }
}

export function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function joinRoom(rawCode, profile) {
  const code = normalizeCode(rawCode);
  if (!CODE_RE.test(code)) throw new Error(`Room codes are ${CODE_LENGTH} letters/numbers.`);
  await leaveRoom();

  let reason = null;
  try {
    await connect();
    const res = await fb.runTransaction(fb.ref(db, `rooms/${code}`), (cur) => {
      reason = null;
      if (cur === null) { reason = "Room not found."; return cur; }
      const players = cur.players || {};
      if (players[uid]) {                              // rejoining after a refresh
        if (cur.status !== "waiting") { reason = "Race already started."; return; }
        players[uid] = { ...players[uid], name: profile.name, carId: profile.carId };
        cur.players = players;
        return cur;
      }
      if (cur.status !== "waiting") { reason = "Race already started."; return; }
      if (Object.keys(players).length >= MAX_PLAYERS) { reason = "Room is full."; return; }
      players[uid] = playerNode(profile);
      cur.players = players;
      return cur;
    });
    if (reason) throw new Error(reason);
    if (!res.committed || !res.snapshot.exists()) throw new Error("Room not found.");
    await attach(code, false);
    return code;
  } catch (err) {
    console.warn("[mp] joinRoom:", err);
    throw new Error(friendly(err, "Couldn't join that room."));
  }
}

export async function startRoomRace() {
  const v = getRoom();
  if (!v || !v.isHost) throw new Error("Only the host can start the race.");
  if (v.players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} racers to start.`);
  try {
    // From here the room must outlive the host's connection, so drop the
    // "close room on disconnect" hook (cancel() clears children too, so
    // re-register this player's own cleanup right after).
    await fb.onDisconnect(room.roomRef).cancel();
    await fb.onDisconnect(room.playerRef).remove();
    // `order` is written in the SAME update as the start flag, so every client that sees
    // "racing" also sees the grid order (used by main.js for spawn slots).
    await fb.update(room.roomRef, { status: "racing", raceStartAt: serverNow() + START_DELAY_MS, order: orderUids(v.players) });
  } catch (err) {
    console.warn("[mp] startRoomRace:", err);
    throw new Error(friendly(err, "Couldn't start the race."));
  }
}

export async function leaveRoom() {
  if (!room) return;
  const { roomRef, playerRef, isHost, view } = room;
  detach();
  lastStateAt = 0;
  lastStateKey = null;
  try {
    await fb.onDisconnect(roomRef).cancel();
    if (isHost && (!view || view.status === "waiting")) await fb.remove(roomRef);
    else await fb.remove(playerRef);
  } catch (err) {
    console.warn("[mp] leaveRoom:", err); // best effort; onDisconnect is the backstop
  }
}

// ---------------------------------------------------------------------------
// In-race telemetry (Task 1). Not part of the lobby/join flow above - purely
// additive writes into players/{uid}/state, picked up by the same room
// listener `attach()` already subscribes with.
// ---------------------------------------------------------------------------

const STATE_INTERVAL_MS = 80; // ~12.5 Hz - within the asked 10-15Hz / 65-100ms range
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const r3 = (n) => Math.round((n || 0) * 1000) / 1000;

let lastStateAt = 0;
let lastStateKey = null; // cheap dirty-check: skip the write if nothing changed

/**
 * Throttled, fire-and-forget write of the local player's live race telemetry.
 * No-op when not in a room. Safe to call every render frame - it self-throttles
 * and skips the network write entirely when the rounded snapshot is unchanged
 * since the last sent tick (e.g. car sitting still during the countdown).
 *
 * snapshot = { position:{x,y,z}, quaternion:{x,y,z,w}, speedKmh, currentLap,
 *              currentCheckpoint, trackDistance }
 */
export function writeMyState(snapshot) {
  if (!room || !fb) return;
  const now = performance.now();
  if (now - lastStateAt < STATE_INTERVAL_MS) return;

  const rounded = {
    position: { x: r2(snapshot.position.x), y: r2(snapshot.position.y), z: r2(snapshot.position.z) },
    quaternion: {
      x: r3(snapshot.quaternion.x), y: r3(snapshot.quaternion.y),
      z: r3(snapshot.quaternion.z), w: r3(snapshot.quaternion.w),
    },
    speedKmh: Math.round(snapshot.speedKmh || 0),
    currentLap: snapshot.currentLap || 0,
    currentCheckpoint: snapshot.currentCheckpoint || 0,
    trackDistance: r2(snapshot.trackDistance || 0),
  };
  const key = JSON.stringify(rounded);
  if (key === lastStateKey) return; // nothing meaningfully changed - skip the write
  lastStateAt = now;
  lastStateKey = key;

  const myRoom = room;
  fb.set(fb.ref(db, `rooms/${myRoom.code}/players/${uid}/state`), { ...rounded, updatedAt: serverNow() })
    .catch((err) => console.warn("[mp] state write failed:", err));
}

/** One-shot write when the local player finishes all laps. Fire-and-forget. */
export function writeMyResult(result) {
  if (!room || !fb) return;
  const myRoom = room;
  fb.set(fb.ref(db, `rooms/${myRoom.code}/results/${uid}`), {
    finishTimeMs: Math.round(result.finishTimeMs),
    bestLapMs: Math.round(result.bestLapMs),
    totalLaps: result.totalLaps,
    finishedAt: serverNow(),
  }).catch((err) => console.warn("[mp] result write failed:", err));
}
