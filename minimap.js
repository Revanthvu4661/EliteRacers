// ============================================================================
// minimap.js - top-down track overview (Task 3).
//
//   createMinimap(canvas, track) -> controller
//     controller.update(carPosition, headingRad, remoteMarkers?) -> void
//       call once per race frame. Redraws the track outline (computed once,
//       from the track's own samples) plus the local player's marker, and any
//       remoteMarkers passed - [{ position: {x,z}, color }].
//
// Remote players are now wired up (main.js collectRemoteDots): one dot per
// active remote car, read from the SAME interpolated puppet transforms that
// place the 3D cars - not from raw Firebase snapshots - so the dots move at
// frame rate instead of stepping at the network rate. Solo passes nothing and
// draws exactly as it always did: background, outline, local marker.
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

  /** A remote player: a slightly smaller filled circle with a dark outline, so it
   *  reads as "someone else" next to the local arrow. Fixed pixel radius - the
   *  minimap transform is computed once and never zooms, so the dot is the same
   *  size on every track. No heading: a circle has none to show. */
  const DOT_R = 3.6;
  function drawRemoteDot(x, z, color) {
    const [mx, my] = toMap(x, z);
    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(7,8,12,0.9)";
    ctx.stroke();
    ctx.restore();
  }

  function update(carPosition, headingRad, remoteMarkers) {
    drawBackground();
    drawOutline();
    // Remote dots first, local marker last, so the local player is never hidden
    // underneath someone else's dot. A bad remote sample can't break the frame.
    if (remoteMarkers) {
      try {
        for (const m of remoteMarkers) {
          const p = m && m.position;
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
          drawRemoteDot(p.x, p.z, m.color || "#8fb3ff");
        }
      } catch (_) { /* minimap decoration only - never break the race */ }
    }
    drawMarker(carPosition.x, carPosition.z, headingRad, "#ff3b3b", true);
  }

  return { update };
}
