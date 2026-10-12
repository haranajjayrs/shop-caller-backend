const callLogService = require("../services/callLogService");
const { istDateKey } = require("../utils/dates");

/**
 * GET /api/followups  ->  { date, today: [...], missedYesterday: [...] }
 * master can pass ?salesmanUid= ; salesman always sees only their own.
 * Items close automatically when a new call WITH a note is logged for the shop.
 */
async function list(req, res) {
  const salesmanUid =
    req.user.role === "salesman" ? req.user.uid : req.query.salesmanUid || undefined;
  const due = await callLogService.listDueFollowups({ companyId: req.user.companyId, salesmanUid });
  res.json({ success: true, data: { date: istDateKey(), ...due } });
}

module.exports = { list };
