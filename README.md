# Elite Racers

Elite Racers: 3D browser racing game for ACM LudusForge 2.0. Three.js + Cannon-es + Firebase Auth + Gemini. Vanilla ES modules, no build step.

## Run it

Any static server works. ES modules and Firebase popups need `http://`, not `file://`.

```bash
npx serve -l 8080 .
```

or

```bash
python -m http.server 8080
```

Then open http://localhost:8080.

## Controls

| Key | Action |
|---|---|
| W / Up | throttle |
| S / Down | brake / reverse |
| A / D or Left / Right | steer |
| Space / Shift | handbrake (drift) |
| C | cycle camera: chase, cockpit, cinematic |
| R | reset car onto the track |

A car that flips, lands outside the barriers, or falls off the world is put back on the track automatically. `window.ER` exposes state and tuning in the browser console for live tweaking (`ER.TUNING.ENGINE_FORCE = 7000`).

## Firebase (Google login)

1. Create a project at https://console.firebase.google.com and register a Web app.
2. Paste the config object into `firebase-config.js`.
3. Authentication > Sign-in method > enable **Google**.
4. Authentication > Settings > Authorized domains: add the deploy domain (localhost is already there).

Until step 2 is done the login screen disables the Google button and shows why. **Skip Login (Demo Mode)** always works, with or without network.

## File map

| File | Owns | Who edits |
|---|---|---|
| `index.html` | screens markup, import map | UI |
| `styles.css` | all styling, transitions | UI |
| `ui.js` | screen switching, toasts, HUD setters | UI |
| `cars.js` | car roster + stats + asset paths | Art |
| `car-model.js` | GLB loader + tint, primitive fallback car | Lead / Art |
| `assets/` | models, sounds, textures | Art / Sound |
| `main.js` | app flow, renderer, main loop | Lead |
| `auth.js` | Firebase Google login + demo fallback | Lead |
| `physics.js` | Cannon-es world, vehicle, tuning constants at top | Lead |
| `track.js` | spline circuit, checkpoints | Lead |
| `camera.js` | chase / cockpit / cinematic rigs | Lead |
| `ai-commentary.js` | Gemini calls + scripted fallback lines | Lead |

## Build status

- [x] 1. Scaffold
- [x] 2. Google login + Demo Mode fallback
- [x] 3. Track (spline circuit, curbs, barriers, gates, sky, trees)
- [x] 4. Car physics (Cannon-es raycast vehicle)
- [x] 5. Three cars (Ferrari GLB re-tinted; primitive fallback)
- [x] 6. Camera POVs (C to cycle)
- [ ] 7. AI commentary
- [ ] 8. Juice pass
- [ ] 9. Results screen polish

## Credits

Car model: Ferrari 458 Italia by vicent091036, from the three.js examples (assets/models/ferrari.glb).
