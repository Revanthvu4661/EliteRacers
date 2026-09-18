// ============================================================================
// auth.js - Firebase Google sign-in with an offline-safe Demo Mode fallback.
//
// Public API:
//   initAuth({ onSignedIn, onSignedOut })  -> resolves once we know the auth state
//   signInWithGoogle()                      -> Promise<player | null>
//   skipLogin()                             -> player (demo)
//   signOut()                               -> Promise<void>
//   getPlayer()                             -> current player or null
//   isConfigured()                          -> bool (firebase-config.js filled in?)
//   getFirebaseApp()                        -> firebase App or null (for multiplayer.js)
//   ensureFirebaseUid()                     -> Promise<uid>; guests get an anonymous
//                                              Firebase identity (online play only)
//
// A "player" is a plain object every other module can use:
//   { uid, name, photo, email, demo }
//
// Guarantees:
//   * Nothing here ever throws to the caller. Every failure path returns null /
//     surfaces a message through `onError` and leaves the Skip button usable.
//   * Firebase SDK is loaded lazily from the CDN. If the CDN itself is unreachable
//     (venue wifi), initAuth still resolves and Demo Mode works.
// ============================================================================

import { firebaseConfig } from "./firebase-config.js?v=28";

const FIREBASE_VERSION = "11.10.0";
const SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

// How long we wait for the SDK / the popup before telling the user to use Demo Mode.
const SDK_LOAD_TIMEOUT_MS = 6000;
const POPUP_HINT_AFTER_MS = 8000;

let firebaseApp = null;       // firebase App instance (shared with multiplayer.js)
let firebaseAuth = null;      // firebase Auth instance (null when unavailable)
let authModule = null;        // the firebase/auth ES module (for provider/popup fns)
let currentPlayer = null;
let listeners = { onSignedIn: () => {}, onSignedOut: () => {}, onError: () => {} };

// ---------------------------------------------------------------------------

export function isConfigured() {
  return Boolean(
    firebaseConfig &&
    firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.startsWith("PASTE_") &&
    firebaseConfig.projectId &&
    firebaseConfig.projectId !== "your-project"
  );
}

export function getPlayer() {
  return currentPlayer;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function playerFromUser(user) {
  return {
    uid: user.uid,
    name: user.displayName || user.email?.split("@")[0] || "Racer",
    photo: user.photoURL || null,
    email: user.email || null,
    demo: false,
  };
}

// ---------------------------------------------------------------------------

/**
 * Initialise Firebase (if configured + reachable) and start listening for auth
 * state. Resolves with { available: bool, reason?: string }.
 */
export async function initAuth(handlers = {}) {
  listeners = { ...listeners, ...handlers };

  if (!isConfigured()) {
    return { available: false, reason: "Firebase not configured (see firebase-config.js). Demo Mode only." };
  }

  try {
    const [appMod, authMod] = await withTimeout(
      Promise.all([
        import(`${SDK_BASE}/firebase-app.js`),
        import(`${SDK_BASE}/firebase-auth.js`),
      ]),
      SDK_LOAD_TIMEOUT_MS,
      "Firebase SDK load"
    );

    const app = appMod.initializeApp(firebaseConfig);
    firebaseApp = app;
    authModule = authMod;
    firebaseAuth = authMod.getAuth(app);

    // Keep the session across reloads (default, but be explicit).
    try { await authMod.setPersistence(firebaseAuth, authMod.browserLocalPersistence); } catch (_) { /* non-fatal */ }

    // Resolve once Firebase tells us the initial state (signed in from a previous
    // visit, or signed out). Also handles the redirect-flow result if a popup was
    // blocked and we fell back to redirect.
    await new Promise((resolve) => {
      let first = true;
      authMod.onAuthStateChanged(firebaseAuth, (user) => {
        // Anonymous users are guests who went online (ensureFirebaseUid); they are
        // not a login, so they must never auto-skip the login screen on reload.
        if (user && !user.isAnonymous) {
          currentPlayer = playerFromUser(user);
          listeners.onSignedIn(currentPlayer);
        } else {
          const wasSignedIn = currentPlayer && !currentPlayer.demo;
          if (wasSignedIn) currentPlayer = null;
          if (wasSignedIn || first) listeners.onSignedOut();
        }
        if (first) { first = false; resolve(); }
      });
      // Belt and braces: never hang on this promise.
      setTimeout(resolve, SDK_LOAD_TIMEOUT_MS);
    });

    return { available: true };
  } catch (err) {
    console.warn("[auth] Firebase unavailable:", err);
    firebaseApp = null;
    firebaseAuth = null;
    authModule = null;
    return { available: false, reason: friendlyError(err) };
  }
}

/**
 * Google popup sign-in. Resolves with the player, or null on any failure
 * (the failure reason is passed to onError).
 */
export async function signInWithGoogle() {
  if (!firebaseAuth || !authModule) {
    listeners.onError("Google sign-in unavailable - continue as guest.");
    return null;
  }

  const provider = new authModule.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const hintTimer = setTimeout(() => {
    listeners.onError("Still waiting on Google... if the popup is stuck, hit Skip Login.");
  }, POPUP_HINT_AFTER_MS);

  try {
    const result = await authModule.signInWithPopup(firebaseAuth, provider);
    clearTimeout(hintTimer);
    currentPlayer = playerFromUser(result.user);
    // onAuthStateChanged also fires, but return directly so the caller can proceed.
    return currentPlayer;
  } catch (err) {
    clearTimeout(hintTimer);
    console.warn("[auth] sign-in failed:", err);

    // Popup blocked -> try the redirect flow once (comes back through onAuthStateChanged).
    if (err?.code === "auth/popup-blocked") {
      try {
        listeners.onError("Popup blocked - redirecting to Google...");
        await authModule.signInWithRedirect(firebaseAuth, provider);
        return null;
      } catch (e2) {
        listeners.onError(friendlyError(e2));
        return null;
      }
    }

    listeners.onError(friendlyError(err));
    return null;
  }
}

export function getFirebaseApp() {
  return firebaseApp;
}

/**
 * The Firebase uid to use for online play. Google players already have one;
 * guests are signed in anonymously (needs Anonymous enabled in Firebase Auth).
 * Throws an Error with a user-facing message on failure.
 */
export async function ensureFirebaseUid() {
  if (!firebaseAuth || !authModule) throw new Error("Online play is unavailable right now.");
  if (firebaseAuth.currentUser) return firebaseAuth.currentUser.uid;
  try {
    const cred = await withTimeout(authModule.signInAnonymously(firebaseAuth), SDK_LOAD_TIMEOUT_MS, "Guest sign-in");
    return cred.user.uid;
  } catch (err) {
    console.warn("[auth] anonymous sign-in failed:", err);
    const code = err?.code || "";
    if (code === "auth/operation-not-allowed" || code === "auth/admin-restricted-operation") {
      throw new Error("Guests can't race online yet (Anonymous sign-in is off in Firebase). Sign in with Google instead.");
    }
    throw new Error(friendlyError(err));
  }
}

/** Demo Mode: no network, no Firebase. */
export function skipLogin(name) {
  currentPlayer = { uid: `demo-${Date.now()}`, name: name || "Guest Racer", photo: null, email: null, demo: true };
  listeners.onSignedIn(currentPlayer);
  return currentPlayer;
}

export async function signOut() {
  const wasDemo = currentPlayer?.demo;
  currentPlayer = null;
  if (!wasDemo && firebaseAuth && authModule) {
    try { await authModule.signOut(firebaseAuth); return; } catch (e) { console.warn("[auth] signOut:", e); }
  }
  listeners.onSignedOut();
}

// ---------------------------------------------------------------------------

function friendlyError(err) {
  const code = err?.code || "";
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in cancelled. Try again or continue as guest.";
    case "auth/network-request-failed":
      return "No network - continue as guest.";
    case "auth/unauthorized-domain":
      return `This domain (${location.hostname}) isn't in Firebase > Auth > Authorized domains.`;
    case "auth/operation-not-allowed":
      return "Google provider not enabled in Firebase console.";
    case "auth/invalid-api-key":
    case "auth/api-key-not-valid.-please-pass-a-valid-api-key.":
      return "Invalid Firebase API key (check firebase-config.js).";
    default:
      if (/timed out/i.test(err?.message || "")) return "Google is unreachable - continue as guest.";
      return "Google sign-in failed - try again or continue as guest.";
  }
}
