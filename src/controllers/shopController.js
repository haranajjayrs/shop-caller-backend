const shopService = require("../services/shopService");
const userService = require("../services/userService");
const callLogService = require("../services/callLogService");
const { parseShopsFile, planImport } = require("../services/shopImportService");
const { normalizeShopPhone } = require("../utils/phone");
const { badRequest, conflict, notFound, forbidden } = require("../utils/httpError");

async function loadSalesman(companyId, uid) {
  const s = uid ? await userService.getUser(uid) : null;
  if (!s || s.companyId !== companyId || s.role !== "salesman") {
    throw badRequest("Select a valid salesman");
  }
  if (s.active === false) throw badRequest("This salesman is deactivated");
  return s;
}

async function loadCompanyShop(req) {
  const shop = await shopService.getShop(req.params.shopId);
  if (!shop || shop.companyId !== req.user.companyId) throw notFound("Shop not found");
  return shop;
}

/**
 * GET /api/shops
 *  master   -> every shop in the company (optional ?salesmanUid=)
 *  salesman -> only the shops assigned to them
 */
async function list(req, res) {
  let shops;
  if (req.user.role === "salesman") {
    shops = await shopService.listSalesmanShops(req.user.uid);
    shops = shops.filter((s) => s.companyId === req.user.companyId);
  } else if (req.query.salesmanUid) {
    shops = (await shopService.listSalesmanShops(String(req.query.salesmanUid))).filter(
      (s) => s.companyId === req.user.companyId,
    );
  } else {
    shops = await shopService.listCompanyShops(req.user.companyId);
  }
  res.json({ success: true, data: shops });
}

/** POST /api/shops  { name, address, phoneNumber, salesmanUid }  (master) */
async function create(req, res) {
  const { name, address, phoneNumber, salesmanUid } = req.body || {};
  if (!name || !String(name).trim()) throw badRequest("Shop name is required");
  const phone = normalizeShopPhone(phoneNumber);
  if (!phone) throw badRequest("Enter a valid phone number");
  const salesman = await loadSalesman(req.user.companyId, salesmanUid);

  const existing = await shopService.listCompanyShops(req.user.companyId);
  if (existing.some((s) => s.phoneNumber === phone)) {
    throw conflict(`A shop with phone ${phone} already exists`);
  }

  const shop = await shopService.createShop({
    companyId: req.user.companyId,
    name,
    address,
    phoneNumber: phone,
    salesman,
  });
  res.status(201).json({ success: true, data: shop });
}

/**
 * POST /api/shops/upload  multipart/form-data, field "file" (.xlsx / .csv)  (master)
 * Columns: Shop Name | Address | Phone Number | Salesman Mobile
 */
async function upload(req, res) {
  if (!req.file) throw badRequest('Attach the Excel file in the "file" field');

  const { rows } = await parseShopsFile(req.file.buffer, req.file.originalname);
  if (!rows.length) throw badRequest("The Excel file has no shop rows");

  const [salesmen, existingShops] = await Promise.all([
    userService.listCompanyUsers(req.user.companyId, { role: "salesman" }),
    shopService.listCompanyShops(req.user.companyId),
  ]);

  const { toCreate, skipped } = planImport(rows, { salesmen, existingShops });
  const created = await shopService.createShopsBulk(
    toCreate.map((s) => ({ ...s, companyId: req.user.companyId })),
  );

  const perSalesman = {};
  for (const s of created) perSalesman[s.salesmanName] = (perSalesman[s.salesmanName] || 0) + 1;

  res.status(201).json({
    success: true,
    data: {
      totalRows: rows.length,
      created: created.length,
      skippedCount: skipped.length,
      skipped,
      perSalesman,
    },
  });
}

/** PATCH /api/shops/:shopId  { name?, address?, phoneNumber?, salesmanUid? }  (master) */
async function update(req, res) {
  const shop = await loadCompanyShop(req);
  const { name, address, phoneNumber, salesmanUid } = req.body || {};
  const fields = {};

  if (name !== undefined) {
    if (!String(name).trim()) throw badRequest("Shop name cannot be empty");
    fields.name = String(name).trim();
  }
  if (address !== undefined) fields.address = String(address).trim();
  if (phoneNumber !== undefined) {
    const phone = normalizeShopPhone(phoneNumber);
    if (!phone) throw badRequest("Enter a valid phone number");
    if (phone !== shop.phoneNumber) {
      const existing = await shopService.listCompanyShops(req.user.companyId);
      if (existing.some((s) => s.phoneNumber === phone)) {
        throw conflict(`A shop with phone ${phone} already exists`);
      }
    }
    fields.phoneNumber = phone;
  }
  if (salesmanUid !== undefined && salesmanUid !== shop.salesmanUid) {
    const salesman = await loadSalesman(req.user.companyId, salesmanUid);
    fields.salesmanUid = salesman.uid;
    fields.salesmanName = salesman.name;
  }
  if (!Object.keys(fields).length) return res.json({ success: true, data: shop });

  const updated = await shopService.updateShop(shop.shopId, fields);
  res.json({ success: true, data: updated });
}

/** DELETE /api/shops/:shopId  (master) — call history is kept. */
async function remove(req, res) {
  const shop = await loadCompanyShop(req);
  await shopService.deleteShop(shop.shopId);
  res.json({ success: true });
}

/** GET /api/shops/:shopId/calls — call history of one shop */
async function history(req, res) {
  const shop = await loadCompanyShop(req);
  if (req.user.role === "salesman" && shop.salesmanUid !== req.user.uid) throw forbidden();
  const calls = await callLogService.listShopCalls(shop.shopId, { limit: req.query.limit });
  res.json({ success: true, data: { shop, calls } });
}

module.exports = { list, create, upload, update, remove, history };
