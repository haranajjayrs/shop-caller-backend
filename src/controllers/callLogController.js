const callLogService = require("../services/callLogService");
const shopService = require("../services/shopService");
const { istDateKey, parseDateKey, resolveRange } = require("../utils/dates");
const { badRequest, notFound, forbidden } = require("../utils/httpError");

const MAX_NOTE_WORDS = 200;
const CALL_RESULTS = ["answered", "no_answer", "busy", "unreachable", "wrong_number"];
const countWords = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

function cleanNotes(notes) {
  if (notes === undefined || notes === null) return undefined;
  const text = String(notes).trim();
  if (countWords(text) > MAX_NOTE_WORDS) {
    throw badRequest(`Notes must be ${MAX_NOTE_WORDS} words or fewer`);
  }
  return text;
}

/** "" / null -> "" (clear). Otherwise must be a valid date, today or later. */
function cleanReminder(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return "";
  const key = parseDateKey(value);
  if (!key) throw badRequest("reminderDate must be yyyy-mm-dd");
  if (key < istDateKey()) throw badRequest("Reminder date cannot be in the past");
  return key;
}

/**
 * POST /api/call-logs   (salesman)
 * { shopId, callResult, notes?, orderReceived?, orderDetails?, reminderDate? }
 * Company, salesman, from/to numbers and call status are filled in by the
 * server — the client can't spoof them.
 */
async function create(req, res) {
  const { shopId, callResult, durationSeconds, callTimestamp, notes, orderReceived, orderDetails, reminderDate } = req.body || {};
  if (!shopId) throw badRequest("shopId is required");

  const shop = await shopService.getShop(String(shopId));
  if (!shop || shop.companyId !== req.user.companyId) throw notFound("Shop not found");
  if (shop.salesmanUid !== req.user.uid) throw forbidden("This shop is not assigned to you");

  if (callResult !== undefined && !CALL_RESULTS.includes(callResult)) {
    throw badRequest(`callResult must be one of: ${CALL_RESULTS.join(", ")}`);
  }
  if (orderReceived !== undefined && typeof orderReceived !== "boolean") {
    throw badRequest("orderReceived must be a boolean");
  }
  if (orderDetails !== undefined && orderDetails !== null && typeof orderDetails !== "object") {
    throw badRequest("orderDetails must be an object or null");
  }
  if (orderReceived === true && (orderDetails === undefined || orderDetails === null)) {
    throw badRequest("orderDetails is required when orderReceived is true");
  }
  const duration = Number(durationSeconds);
  if (durationSeconds !== undefined && (!Number.isFinite(duration) || duration < 0)) {
    throw badRequest("durationSeconds must be a non-negative number");
  }

  const item = await callLogService.createCallLog({
    user: req.user,
    shop,
    durationSeconds: duration || 0,
    callResult: callResult || (duration > 0 ? "answered" : "no_answer"),
    callTimestamp,
    notes: cleanNotes(notes),
    orderReceived: orderReceived === undefined ? false : orderReceived,
    orderDetails: orderDetails === undefined ? null : orderDetails,
    reminderDate: cleanReminder(reminderDate) || undefined,
  });
  res.status(201).json({ success: true, data: item });
}

/** PUT /api/call-logs/:callId  { notes?, reminderDate?, callResult?, orderReceived?, orderDetails? } */
async function update(req, res) {
  const call = await callLogService.getCallLog(req.params.callId);
  if (!call || call.companyId !== req.user.companyId) throw notFound("Call log not found");
  if (req.user.role === "salesman" && call.salesmanUid !== req.user.uid) throw forbidden();

  const notes = cleanNotes(req.body?.notes);
  const reminderDate = cleanReminder(req.body?.reminderDate);
  const { callResult, orderReceived, orderDetails } = req.body || {};
  if (callResult !== undefined && !CALL_RESULTS.includes(callResult)) throw badRequest(`callResult must be one of: ${CALL_RESULTS.join(", ")}`);
  if (orderReceived !== undefined && typeof orderReceived !== "boolean") throw badRequest("orderReceived must be a boolean");
  if (orderDetails !== undefined && orderDetails !== null && typeof orderDetails !== "object") throw badRequest("orderDetails must be an object or null");
  if (notes === undefined && reminderDate === undefined && callResult === undefined && orderReceived === undefined && orderDetails === undefined) {
    throw badRequest("Provide at least one field to update");
  }
  const updated = await callLogService.updateCallLog(call.callId, { notes, reminderDate, callResult, orderReceived, orderDetails });
  res.json({ success: true, data: updated });
}

/**
 * GET /api/call-logs?from=yyyy-mm-dd&to=yyyy-mm-dd&salesmanUid=&status=&shopId=&limit=&cursor=
 * master: whole company (or one salesman); salesman: only their own calls.
 */
async function list(req, res) {
  const range = resolveRange(req.query);
  const status = req.query.status;
  if (status && !["connected", "not_connected", ...CALL_RESULTS].includes(status)) {
    throw badRequest(`status must be connected, not_connected, or one of: ${CALL_RESULTS.join(", ")}`);
  }
  const salesmanUid =
    req.user.role === "salesman" ? req.user.uid : req.query.salesmanUid || undefined;

  const page = await callLogService.listCallLogsPage({
    companyId: req.user.companyId,
    salesmanUid,
    startIso: range.startIso,
    endIso: range.endIso,
    status,
    shopId: req.query.shopId || undefined,
    limit: req.query.limit,
    cursor: req.query.cursor,
  });
  res.json({ success: true, data: page.items, nextCursor: page.nextCursor, range });
}

module.exports = { create, update, list };
