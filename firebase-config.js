// ============================================================================
// Firebase project config (project: race-14f6a).
//
// These values are NOT secrets (they ship to every browser). Access is controlled by
// the Authorized domains list + Firebase security rules, not by hiding this file.
// Before deploying, add the deploy domain in Firebase Console -> Authentication ->
// Settings -> Authorized domains ("localhost" is there by default).
//
// The SDK itself is loaded lazily by auth.js, so if the CDN is unreachable the game
// still boots and Demo Mode works.
// ============================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDhyHkPB5ut7aYhi57SaUTKPLKCHbB0qyM",
  authDomain: "race-14f6a.firebaseapp.com",
  projectId: "race-14f6a",
  storageBucket: "race-14f6a.firebasestorage.app",
  messagingSenderId: "598058188188",
  appId: "1:598058188188:web:582ac724533e7f10a11c59",
  measurementId: "G-N49EB75DM3",
  // Realtime Database (multiplayer). Confirmed live at this URL (us-central1) -
  // copy the exact URL from Firebase Console -> Realtime Database -> Data tab
  // again if the database is ever recreated in a different region.
  databaseURL: "https://race-14f6a-default-rtdb.firebaseio.com",
};
