const admin = require("firebase-admin");

let initialized = false;

/**
 * Lazily initialises Firebase Admin from a base64-encoded service account
 * (same trick the old Google Sheets config used, so it pastes cleanly into
 * any hosting provider's env var UI). Firebase is used for AUTH ONLY —
 * no business data is stored in Firebase.
 */
function getFirebaseAdmin() {
  if (initialized) return admin;

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!base64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 is not set");
  }
  const credentials = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));

  admin.initializeApp({ credential: admin.credential.cert(credentials) });
  initialized = true;
  return admin;
}

module.exports = { getFirebaseAdmin };
