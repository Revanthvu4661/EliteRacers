// ============================================================================
// ai-commentary.js - Gemini race commentary with scripted fallback.   [STAGE 7 - stub]
//
// Contract (stays the same when Gemini is wired in):
//   commentate(event, snapshot) -> Promise<string>   always resolves within
//                                                     FALLBACK_AFTER_MS.
// Events: "race_start" | "lap_complete" | "overtake" | "overtaken" | "crash" |
//         "drift" | "near_miss" | "final_lap" | "race_finish"
// ============================================================================

export const COMMENTARY_CONFIG = {
  GEMINI_API_KEY: "",          // paste from https://aistudio.google.com/apikey (stage 7)
  MODEL: "gemini-2.0-flash",
  FALLBACK_AFTER_MS: 1500,     // never let the HUD wait longer than this
  MIN_GAP_MS: 5000,            // rate-limit lines so they don't pile up
};

// Scripted lines used when Gemini is off, slow, or errors. Feel free to add more.
export const FALLBACK_LINES = {
  race_start:   ["Lights out and away we go!", "And they're off! Clean start off the line."],
  lap_complete: ["That's a lap in the bag. Keep it tidy!", "Lap done. The rhythm's building now."],
  overtake:     ["What a move! Straight up the inside!", "Overtake complete. Ice cold."],
  overtaken:    ["Ooh, they've been mugged for that position!", "Lost a place there. Time to fight back."],
  crash:        ["Big hit on the barrier! That'll leave a mark.", "Contact! Sparks flying everywhere."],
  drift:        ["Sideways through the corner. Beautiful.", "Full opposite lock! Tyre smoke for days."],
  near_miss:    ["Millimetres in it! Heart-in-mouth stuff.", "So close to the wall there!"],
  final_lap:    ["Final lap! Everything on the line now.", "Last lap. No mistakes from here."],
  race_finish:  ["Chequered flag! What a race!", "Across the line. That's how you do it."],
};

let lastLineAt = 0;

export async function commentate(event, snapshot = {}) {
  const now = performance.now();
  if (now - lastLineAt < COMMENTARY_CONFIG.MIN_GAP_MS && event !== "race_finish") return null;
  lastLineAt = now;
  // TODO(stage 7): race Gemini fetch vs. FALLBACK_AFTER_MS timer; return whichever wins.
  return pickFallback(event);
}

export function pickFallback(event) {
  const pool = FALLBACK_LINES[event] || ["Racing on!"];
  return pool[Math.floor(Math.random() * pool.length)];
}
