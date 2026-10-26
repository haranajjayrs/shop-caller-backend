const authProvider = require("../services/authProvider");
const userService = require("../services/userService");
const shopService = require("../services/shopService");
const { clearProfileCache } = require("../middleware/auth");
const {
  normalizeMobile,
  defaultSalesmanPassword,
  salesmanEmail,
} = require("../utils/phone");
const { badRequest, conflict, notFound } = require("../utils/httpError");
const logger = require("../utils/logger");

const publicView = (u, shopCount) => ({
  uid: u.uid,
  name: u.name,
  mobile: u.mobile,
  active: u.active !== false,
  createdAt: u.createdAt,
  ...(shopCount !== undefined && { assignedShops: shopCount }),
});

/** Excel upload maps shops by salesman NAME, so names must be unique per company. */
async function assertNameFree(companyId, name, exceptUid) {
  const all = await userService.listCompanyUsers(companyId, {
    role: "salesman",
  });
  const taken = all.some(
    (u) =>
      u.uid !== exceptUid &&
      String(u.name).trim().toLowerCase() === name.toLowerCase(),
  );
  if (taken)
    throw conflict(
      `A salesman named "${name}" already exists. Use a different name (e.g. add initial).`,
    );
}

async function loadOwnSalesman(req) {
  const s = await userService.getUser(req.params.uid);
  if (!s || s.companyId !== req.user.companyId || s.role !== "salesman") {
    throw notFound("Salesman not found");
  }
  return s;
}

/** GET /api/salesmen */
async function list(req, res) {
  const [salesmen, shops] = await Promise.all([
    userService.listCompanyUsers(req.user.companyId, { role: "salesman" }),
    shopService.listCompanyShops(req.user.companyId),
  ]);
  const counts = new Map();
  for (const s of shops)
    counts.set(s.salesmanUid, (counts.get(s.salesmanUid) || 0) + 1);
  res.json({
    success: true,
    data: salesmen.map((s) => publicView(s, counts.get(s.uid) || 0)),
  });
}

/**
 * POST /api/salesmen { name, mobile }
 * Password is generated randomly.
 */
async function create(req, res) {
  const name = String(req.body?.name || "").trim();
  const mobile = normalizeMobile(req.body?.mobile);
  if (!name) throw badRequest("Salesman name is required");
  if (!mobile) throw badRequest("Enter a valid 10-digit mobile number");
  await assertNameFree(req.user.companyId, name);

  const password = defaultSalesmanPassword();
  let uid;
  try {
    ({ uid } = await authProvider.createUser({
      email: salesmanEmail(mobile),
      password,
      displayName: name,
    }));
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      throw conflict("A salesman with this mobile number already exists");
    }
    throw err;
  }

  try {
    const user = await userService.putUser({
      uid,
      companyId: req.user.companyId,
      role: "salesman",
      name,
      mobile,
      email: salesmanEmail(mobile),
      active: true,
      createdBy: req.user.uid,
      createdAt: new Date().toISOString(),
      mustChangePassword: true,
    });
    res.status(201).json({
      success: true,
      data: {
        salesman: publicView(user, 0),
        credentials: { loginId: mobile, password },
      },
    });
  } catch (err) {
    await authProvider.deleteUser(uid).catch((e) =>
      logger.error("Rollback of Firebase user failed", {
        uid,
        error: e.message,
      }),
    );
    throw err;
  }
}

/** PATCH /api/salesmen/:uid  { name?, active? } */
async function update(req, res) {
  const salesman = await loadOwnSalesman(req);
  const fields = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) throw badRequest("Name cannot be empty");
    await assertNameFree(req.user.companyId, name, salesman.uid);
    fields.name = name;
  }
  if (req.body?.active !== undefined) fields.active = Boolean(req.body.active);
  if (!Object.keys(fields).length) throw badRequest("Nothing to update");

  await authProvider.updateUser(salesman.uid, {
    ...(fields.name && { displayName: fields.name }),
    ...(fields.active !== undefined && { disabled: !fields.active }),
  });
  if (fields.active === false)
    await authProvider.revokeTokens(salesman.uid).catch(() => {});

  const updated = await userService.updateUser(salesman.uid, fields);
  clearProfileCache(salesman.uid);

  // Keep the denormalised salesman name on their shops in sync.
  if (fields.name && fields.name !== salesman.name) {
    const shops = await shopService.listSalesmanShops(salesman.uid);
    for (const shop of shops) {
      await shopService.updateShop(shop.shopId, { salesmanName: fields.name });
    }
  }

  res.json({ success: true, data: publicView(updated) });
}

/** POST /api/salesmen/:uid/reset-password — generates a random password */
async function resetPassword(req, res) {
  const salesman = await loadOwnSalesman(req);
  const password = defaultSalesmanPassword();
  await authProvider.updateUser(salesman.uid, { password });
  await authProvider.revokeTokens(salesman.uid).catch(() => {});
  await userService.updateUser(salesman.uid, {
    mustChangePassword: true,
  });
  clearProfileCache(salesman.uid);
  res.json({ success: true, data: { loginId: salesman.mobile, password } });
}

module.exports = { list, create, update, resetPassword };
