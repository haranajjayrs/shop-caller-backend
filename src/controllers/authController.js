const authProvider = require("../services/authProvider");
const companyService = require("../services/companyService");
const userService = require("../services/userService");
const { normalizeMobile } = require("../utils/phone");
const { badRequest, conflict } = require("../utils/httpError");
const logger = require("../utils/logger");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/auth/register-company   (public)
 * { companyName, ownerName, email, mobile, password }
 *
 * Creates the Firebase login for the company's master user, then the
 * Company + User records in DynamoDB. The app signs in with the same email
 * and password right after.
 */
async function registerCompany(req, res) {
  const { companyName, ownerName, email, mobile, password } = req.body || {};

  if (!companyName || !String(companyName).trim())
    throw badRequest("Company name is required");
  if (!ownerName || !String(ownerName).trim())
    throw badRequest("Your name is required");
  const cleanEmail = String(email || "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) throw badRequest("Enter a valid email");
  const cleanMobile = normalizeMobile(mobile);
  if (!cleanMobile) throw badRequest("Enter a valid 10-digit mobile number");
  if (!password || String(password).length < 6)
    throw badRequest("Password must be at least 6 characters");

  let uid;
  try {
    ({ uid } = await authProvider.createUser({
      email: cleanEmail,
      password: String(password),
      displayName: String(ownerName).trim(),
    }));
  } catch (err) {
    if (err.code === "auth/email-already-exists")
      throw conflict("This email is already registered. Please log in.");
    if (err.code === "auth/invalid-password")
      throw badRequest("Password must be at least 6 characters");
    throw err;
  }

  try {
    const company = await companyService.createCompany({
      name: String(companyName).trim(),
      ownerUid: uid,
      ownerName: String(ownerName).trim(),
      email: cleanEmail,
      mobile: cleanMobile,
    });
    const user = await userService.putUser({
      uid,
      companyId: company.companyId,
      role: "master",
      name: String(ownerName).trim(),
      mobile: cleanMobile,
      email: cleanEmail,
      active: true,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ success: true, data: { user, company } });
  } catch (err) {
    // Roll back the Firebase account so the email can be used again.
    await authProvider.deleteUser(uid).catch((e) =>
      logger.error("Rollback of Firebase user failed", {
        uid,
        error: e.message,
      }),
    );
    throw err;
  }
}

/** GET /api/auth/me — profile + company of the logged-in user. */
async function me(req, res) {
  const company = await companyService.getCompany(req.user.companyId);
  res.json({ success: true, data: { user: req.user, company } });
}

/** POST /api/auth/change-password */
async function changePassword(req, res) {
  const password = String(req.body?.password || "");

  if (password.length < 8) {
    throw badRequest("Password must be at least 8 characters");
  }

  if (req.user.role !== "salesman") {
    throw badRequest("This action is only for salesmen");
  }

  await authProvider.updateUser(req.user.uid, {
    password,
  });

  await userService.updateUser(req.user.uid, {
    mustChangePassword: false,
  });

  const { clearProfileCache } = require("../middleware/auth");
  clearProfileCache(req.user.uid);

  res.json({
    success: true,
    message: "Password changed successfully",
  });
}

module.exports = { registerCompany, me, changePassword };
