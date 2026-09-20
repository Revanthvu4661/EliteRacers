// touch-controls.js - on-screen steering joystick + pedals. Pure input source: it calls the injected
// setKey(name, down) with the SAME names the keyboard handler uses ("up"/"down"/"left"/"right"),
// so main.js's `keys` set / readInput() remain the single input path.
import { isTouchDevice } from "./device.js?v=89";

const LS_KEY = "er_touch_layout";
const DEADZONE = 0.22; // fraction of joystick radius before steering engages

export function getLayout() {
  try { return localStorage.getItem(LS_KEY) === "right" ? "right" : "left"; } catch (_) { return "left"; }
}

export function createTouchControls({ setKey }) {
  if (!isTouchDevice) return { setActive() {}, getLayout, setLayout() {}, enabled: false };

  const root = document.createElement("div");
  root.id = "touch-controls";
  root.hidden = true;
  root.innerHTML = `
    <div class="tc-stick" id="tc-stick"><div class="tc-knob" id="tc-knob"></div></div>
    <div class="tc-pedals">
      <button class="tc-pedal tc-brake" id="tc-brake" type="button">BRAKE</button>
      <button class="tc-pedal tc-gas" id="tc-gas" type="button">GAS</button>
    </div>
    <div class="tc-rotate"><div class="tc-rotate-icon">&#128241;</div><p>Rotate your phone to landscape to race</p></div>`;
  document.body.appendChild(root);

  const stick = root.querySelector("#tc-stick");
  const knob = root.querySelector("#tc-knob");

  function applyLayout() { root.dataset.layout = getLayout(); }
  applyLayout();

  // Joystick: horizontal offset -> left/right keys, spring back (release) -> both off.
  let stickPtr = null;
  function moveStick(e) {
    const r = stick.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = e.clientX - (r.left + radius);
    dx = Math.max(-radius, Math.min(radius, dx));
    knob.style.transform = `translateX(${dx}px)`;
    const n = dx / radius;
    setKey("left", n < -DEADZONE);
    setKey("right", n > DEADZONE);
  }
  function endStick() {
    stickPtr = null;
    knob.style.transform = "";
    setKey("left", false);
    setKey("right", false);
  }
  stick.addEventListener("pointerdown", (e) => {
    if (stickPtr !== null) return;
    stickPtr = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    e.preventDefault();
    moveStick(e);
  });
  stick.addEventListener("pointermove", (e) => { if (e.pointerId === stickPtr) moveStick(e); });
  stick.addEventListener("pointerup", (e) => { if (e.pointerId === stickPtr) endStick(); });
  stick.addEventListener("pointercancel", (e) => { if (e.pointerId === stickPtr) endStick(); });

  // Pedals: hold = key down.
  function bindPedal(el, name) {
    let ptr = null;
    const off = (e) => { if (e.pointerId !== ptr) return; ptr = null; el.classList.remove("held"); setKey(name, false); };
    el.addEventListener("pointerdown", (e) => {
      if (ptr !== null) return;
      ptr = e.pointerId; el.setPointerCapture(e.pointerId); e.preventDefault();
      el.classList.add("held"); setKey(name, true);
    });
    el.addEventListener("pointerup", off);
    el.addEventListener("pointercancel", off);
  }
  bindPedal(root.querySelector("#tc-gas"), "up");
  bindPedal(root.querySelector("#tc-brake"), "down");

  root.addEventListener("contextmenu", (e) => e.preventDefault());

  return {
    enabled: true,
    getLayout,
    setLayout(side) {
      try { localStorage.setItem(LS_KEY, side === "right" ? "right" : "left"); } catch (_) { /* private mode */ }
      applyLayout();
    },
    setActive(on) {
      root.hidden = !on;
      // Best effort: Android Chrome only honours this in fullscreen/installed mode; the rotate overlay covers the rest.
      try { if (on) screen.orientation?.lock?.("landscape").catch(() => {}); else screen.orientation?.unlock?.(); } catch (_) { /* unsupported */ }
      if (!on) { endStick(); for (const k of ["up", "down"]) setKey(k, false); root.querySelectorAll(".held").forEach((el) => el.classList.remove("held")); }
    },
  };
}
