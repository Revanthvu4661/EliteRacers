// ============================================================================
// speedometer.js - self-contained analog speed gauge (canvas, no dependencies).
//
//   const s = createSpeedometer(containerEl, { max: 240 });
//   s.set(kmh)     // call every frame; the needle eases toward the value
//   s.destroy()    // removes the canvas
//
// Purely visual: reads nothing from the game, so a failure in here can't affect
// racing (main.js wraps every call in try/catch anyway).
// ============================================================================

const SIZE = 170;                 // CSS px
const START = Math.PI * 0.75;     // needle angle at 0 (radians, canvas frame)
const SWEEP = Math.PI * 1.5;      // total sweep to max
const NEEDLE_LERP = 0.18;         // per-call easing (frame-rate tied, fine for a gauge)

export function createSpeedometer(container, opts = {}) {
  const max = opts.max || 240;
  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = SIZE + "px";
  canvas.style.height = SIZE + "px";
  canvas.className = "speedo-canvas";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const cx = SIZE / 2, cy = SIZE / 2, R = SIZE / 2 - 8;
  let shown = 0;       // eased needle value
  let target = 0;
  let alive = true;

  function angleFor(v) {
    return START + SWEEP * Math.max(0, Math.min(1, v / max));
  }

  function draw() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    // dial background
    ctx.beginPath();
    ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(7,8,12,0.62)";
    ctx.fill();
    // track arc
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, R - 10, START, START + SWEEP);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.stroke();
    // filled arc up to speed (colour shifts yellow -> red past 75%)
    const frac = Math.max(0, Math.min(1, shown / max));
    if (frac > 0.005) {
      ctx.beginPath();
      ctx.arc(cx, cy, R - 10, START, START + SWEEP * frac);
      ctx.strokeStyle = frac > 0.75 ? "#ff3b3b" : "#ffb800";
      ctx.stroke();
    }
    // ticks
    ctx.lineWidth = 2;
    for (let i = 0; i <= 12; i++) {
      const a = START + (SWEEP * i) / 12;
      const major = i % 3 === 0;
      const r1 = R - 20, r2 = major ? R - 30 : R - 25;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.strokeStyle = major ? "#f2f4f8" : "rgba(242,244,248,0.45)";
      ctx.stroke();
      if (major) {
        ctx.fillStyle = "#cfd5e3";
        ctx.font = "600 10px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const rl = R - 42;
        ctx.fillText(String(Math.round((max * i) / 12)), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl);
      }
    }
    // needle
    const a = angleFor(shown);
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * 12, cy - Math.sin(a) * 12);
    ctx.lineTo(cx + Math.cos(a) * (R - 16), cy + Math.sin(a) * (R - 16));
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ff3b3b";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#f2f4f8";
    ctx.fill();
    // digital readout
    ctx.fillStyle = "#f2f4f8";
    ctx.font = "900 26px Orbitron, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(Math.round(target)), cx, cy + R * 0.5);
    ctx.fillStyle = "#cfd5e3";
    ctx.font = "500 10px Inter, system-ui, sans-serif";
    ctx.fillText("km/h", cx, cy + R * 0.5 + 19);
  }

  function set(kmh) {
    if (!alive) return;
    target = Number.isFinite(kmh) ? Math.max(0, kmh) : 0;
    shown += (target - shown) * NEEDLE_LERP;
    draw();
  }

  function destroy() {
    alive = false;
    canvas.remove();
  }

  draw();
  return { set, destroy, canvas, get value() { return shown; } };
}
