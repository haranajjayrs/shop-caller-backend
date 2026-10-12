const callLogService = require("./callLogService");
const shopService = require("./shopService");
const userService = require("./userService");
const { eachDateKey } = require("../utils/dates");

function emptyStats() {
  return {
    totalCalls: 0,
    connectedCalls: 0,
    notConnectedCalls: 0,
    answeredCalls: 0,
    noAnswerCalls: 0,
    busyCalls: 0,
    unreachableCalls: 0,
    wrongNumberCalls: 0,
    ordersReceived: 0,
    totalTalkSeconds: 0,
    avgTalkSeconds: 0,
    uniqueShopsCalled: 0,
    followupsSet: 0,
  };
}

/** Pure aggregation over a list of call logs — exported for tests. */
function aggregate(calls) {
  const stats = emptyStats();
  const shops = new Set();
  for (const c of calls) {
    stats.totalCalls += 1;
    const result = c.callResult || (c.callStatus === "connected" ? "answered" : "no_answer");
    if (result === "answered") {
      stats.connectedCalls += 1;
      stats.answeredCalls += 1;
      stats.totalTalkSeconds += Number(c.durationSeconds) || 0;
    } else {
      stats.notConnectedCalls += 1;
    }
    if (result === "no_answer") stats.noAnswerCalls += 1;
    if (result === "busy") stats.busyCalls += 1;
    if (result === "unreachable") stats.unreachableCalls += 1;
    if (result === "wrong_number") stats.wrongNumberCalls += 1;
    if (c.orderReceived === true) stats.ordersReceived += 1;
    if (c.reminderDate) stats.followupsSet += 1;
    shops.add(c.shopId);
  }
  stats.uniqueShopsCalled = shops.size;
  stats.avgTalkSeconds = stats.connectedCalls
    ? Math.round(stats.totalTalkSeconds / stats.connectedCalls)
    : 0;
  return stats;
}

function dailyTrend(calls, from, to) {
  const days = new Map(eachDateKey(from, to).map((d) => [d, { date: d, calls: 0, connected: 0 }]));
  for (const c of calls) {
    const d = days.get(c.callDate);
    if (!d) continue;
    d.calls += 1;
    if ((c.callResult || (c.callStatus === "connected" ? "answered" : "no_answer")) === "answered") d.connected += 1;
  }
  return [...days.values()];
}

/**
 * Dashboard for a date range.
 *  - master: whole company (optionally narrowed to one salesman) + per-salesman table
 *  - salesman: only their own numbers
 */
async function getDashboard({ user, range, salesmanUid }) {
  const isMaster = user.role === "master";
  const scopeUid = isMaster ? salesmanUid || undefined : user.uid;

  const [calls, followups, shops, salesmen] = await Promise.all([
    callLogService.listCallsInRange({
      companyId: user.companyId,
      salesmanUid: scopeUid,
      startIso: range.startIso,
      endIso: range.endIso,
    }),
    callLogService.listDueFollowups({ companyId: user.companyId, salesmanUid: scopeUid }),
    scopeUid
      ? shopService.listSalesmanShops(scopeUid)
      : shopService.listCompanyShops(user.companyId),
    isMaster ? userService.listCompanyUsers(user.companyId, { role: "salesman" }) : [],
  ]);

  const stats = aggregate(calls);
  const summary = {
    ...stats,
    assignedShops: shops.length,
    shopsNotCalled: (() => {
      const called = new Set(calls.map((c) => c.shopId));
      return shops.filter((s) => !called.has(s.shopId)).length;
    })(),
    followupsDueToday: followups.today.length,
    missedYesterday: followups.missedYesterday.length,
  };

  const result = {
    range: { from: range.from, to: range.to },
    summary,
    daily: dailyTrend(calls, range.from, range.to),
    recentCalls: calls
      .slice()
      .sort((a, b) => String(b.callTimestamp).localeCompare(String(a.callTimestamp)))
      .slice(0, 10),
  };

  if (isMaster) {
    const shopsPerSalesman = new Map();
    for (const s of shops) shopsPerSalesman.set(s.salesmanUid, (shopsPerSalesman.get(s.salesmanUid) || 0) + 1);

    const callsPerSalesman = new Map();
    for (const c of calls) {
      if (!callsPerSalesman.has(c.salesmanUid)) callsPerSalesman.set(c.salesmanUid, []);
      callsPerSalesman.get(c.salesmanUid).push(c);
    }

    const visible = scopeUid ? salesmen.filter((s) => s.uid === scopeUid) : salesmen;
    result.salesmen = visible
      .map((s) => ({
        uid: s.uid,
        name: s.name,
        mobile: s.mobile,
        active: s.active !== false,
        assignedShops: shopsPerSalesman.get(s.uid) || 0,
        ...aggregate(callsPerSalesman.get(s.uid) || []),
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls || String(a.name).localeCompare(String(b.name)));
  }

  return result;
}

module.exports = { getDashboard, aggregate, dailyTrend };
