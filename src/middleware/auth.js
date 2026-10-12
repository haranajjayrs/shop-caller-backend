const { getFirebaseAdmin } = require("../config/firebaseAdmin");
const userService = require("../services/userService");
const { HttpError } = require("../utils/httpError");

// Small in-memory cache so every request doesn't hit DynamoDB for the
// user's profile. Entries expire after 60s, so deactivating a salesman takes
// effect within a minute even on an already-issued token.
const CACHE_TTL_MS = 60 * 1000;
const profileCache = new Map();

let verifyToken = async (idToken) =>
  getFirebaseAdmin().auth().verifyIdToken(idToken, true);

/** Test hook — lets tests swap Firebase token verification for a fake. */
function setTokenVerifier(fn) {
  verifyToken = fn;
}

function clearProfileCache(uid) {
  if (uid) profileCache.delete(uid);
  else profileCache.clear();
}

async function loadProfile(uid) {
  const hit = profileCache.get(uid);
  if (hit && hit.expires > Date.now()) return hit.profile;
  const profile = await userService.getUser(uid);
  if (profile) profileCache.set(uid, { profile, expires: Date.now() + CACHE_TTL_MS });
  return profile;
}

/**
 * Verifies the Firebase ID token from `Authorization: Bearer <token>` and
 * attaches the user's profile from DynamoDB as req.user:
 *   { uid, companyId, role: "master" | "salesman", name, mobile, email }
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) throw new HttpError(401, "Missing auth token");

    let decoded;
    try {
      decoded = await verifyToken(match[1]);
    } catch {
      throw new HttpError(401, "Session expired. Please log in again.");
    }

    const profile = await loadProfile(decoded.uid);
    if (!profile) throw new HttpError(403, "Account is not registered with any company");
    if (profile.active === false) {
      throw new HttpError(403, "Your account has been deactivated. Contact your admin.");
    }

    req.user = profile;
    next();
  } catch (err) {
    next(err);
  }
}

/** Usage: router.post("/", requireRole("master"), handler) */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new HttpError(403, "You do not have access to this action"));
  }
  next();
};

module.exports = { requireAuth, requireRole, setTokenVerifier, clearProfileCache };
