const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");

const { requireAuth, requireRole } = require("../middleware/auth");
const { asyncHandler: h } = require("../utils/httpError");

const auth = require("../controllers/authController");
const salesmen = require("../controllers/salesmanController");
const shops = require("../controllers/shopController");
const calls = require("../controllers/callLogController");
const followups = require("../controllers/followupController");
const dashboard = require("../controllers/dashboardController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many registrations from this network. Try again later." },
});

const master = requireRole("master");
const salesman = requireRole("salesman");

const router = express.Router();

// ---- Auth ----
router.post("/auth/register-company", registerLimiter, h(auth.registerCompany));
router.get("/auth/me", requireAuth, h(auth.me));

// Everything below needs a logged-in user
router.use(requireAuth);

// ---- Salesmen (master only) ----
router.get("/salesmen", master, h(salesmen.list));
router.post("/salesmen", master, h(salesmen.create));
router.patch("/salesmen/:uid", master, h(salesmen.update));
router.post("/salesmen/:uid/reset-password", master, h(salesmen.resetPassword));

// ---- Shops ----
router.get("/shops", h(shops.list));
router.post("/shops", master, h(shops.create));
router.post("/shops/upload", master, upload.single("file"), h(shops.upload));
router.patch("/shops/:shopId", master, h(shops.update));
router.delete("/shops/:shopId", master, h(shops.remove));
router.get("/shops/:shopId/calls", h(shops.history));

// ---- Call logs ----
router.get("/call-logs", h(calls.list));
router.post("/call-logs", salesman, h(calls.create));
router.put("/call-logs/:callId", h(calls.update));

// ---- Follow-ups ----
router.get("/followups", h(followups.list));

// ---- Dashboard ----
router.get("/dashboard", h(dashboard.get));

module.exports = router;
