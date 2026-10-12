const dashboardService = require("../services/dashboardService");
const { resolveRange } = require("../utils/dates");

/** GET /api/dashboard?from=yyyy-mm-dd&to=yyyy-mm-dd&salesmanUid= */
async function get(req, res) {
  const range = resolveRange(req.query);
  const data = await dashboardService.getDashboard({
    user: req.user,
    range,
    salesmanUid: req.query.salesmanUid,
  });
  res.json({ success: true, data });
}

module.exports = { get };
