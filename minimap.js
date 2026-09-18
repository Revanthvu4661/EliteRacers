// ============================================================================
// minimap.js - top-down track overview (Task 3).
//
//   createMinimap(canvas, track) -> controller
//     controller.update(carPosition, headingRad, remoteMarkers?) -> void
//       call once per race frame. Redraws the track outline (computed once,
//       from the track's own samples) plus the local player's marker, and any
//       remoteMarkers passed - [{ position: {x,z}, heading, color }].
//
// LOCAL PLAYER ONLY for now, matching pickups.js's reasoning (see its file
// header): remote markers would read from the same /rooms/{code}/players/
// {uid}/state sync that hasn't been verified with two real browser windows
// yet. `remoteMarkers` is already accepted and drawn here if passed - main.js
// just isn't passing any yet - so wiring that in later (once the
// multiplayer-sync prerequisite is verified) is a one-line addition at the
// call site, not a change to this file. It would reuse the SAME
// players/{uid}/state data the remote-car puppets already sync, per the task
// spec - no second data path.
//
// Built AFTER the track-resize task (previous prompt), deliberately - the fit
// math below is computed once from the actual (already-scaled) track.samples,
// so there's nothing here that assumes the old, smaller track size.
// ============================================================================

const SIZE = 150; // CSS px - the ~150x150 box asked for
const PAD = 12;    // px margin inside the box so the outline doesn't touch the edge

/**
 * @param canvas <canvas> element already sized in CSS to SIZExSIZE
 * @param track  the object buildTrack() returns (needs .samples: [{p:{x,z}}])
 */
export function createMinimap(canvas, track) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // World -> minimap transform, computed ONCE from the track's own samples
  // (top-down: world x -> minimap x, world z -> minimap y, no rotation).
  const xs = track.samples.map((s) => s.p.x);
  const zs = track.samples.map((s) => s.p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const scale = (SIZE - PAD * 2) / span;
  const offX = (SIZE - (maxX - minX) * scale) / 2;
  const offZ = (SIZE - (maxZ - minZ) * scale) / 2;

  function toMap(x, z) {
    return [offX + (x - minX) * scale, offZ + (z - minZ) * scale];
  }
  const outline = track.samples.map((s) => toMap(s.p.x, s.p.z));

  function drawBackground() {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "rgba(7,8,12,0.55)";
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(0, 0, SIZE, SIZE, 10); ctx.fill(); }
    else ctx.fillRect(0, 0, SIZE, SIZE);
  }

  function drawOutline() {
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  /**
   * headingRad uses the SAME convention as track.js's sample.yaw
   * (Math.atan2(-forward.z, forward.x)) - verified against three reference
   * angles (facing +X/+Z/-Z) so the arrow's rotation matches the outline's
   * own coordinate mapping (minimap y = world z, no flip) rather than
   * assuming canvas rotate() direction.
   */
  function drawMarker(x, z, headingRad, color, isMe) {
    const [mx, my] = toMap(x, z);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-headingRad);
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-4, 4.5);
    ctx.lineTo(-4, -4.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = isMe ? 7 : 3;
    ctx.fill();
    ctx.restore();
  }

  function update(carPosition, headingRad, remoteMarkers) {
    drawBackground();
    drawOutline();
    if (remoteMarkers) {
      for (const m of remoteMarkers) drawMarker(m.position.x, m.position.z, m.heading, m.color || "#8fb3ff", false);
    }
    drawMarker(carPosition.x, carPosition.z, headingRad, "#ff3b3b", true);
  }

  return { update };
}
