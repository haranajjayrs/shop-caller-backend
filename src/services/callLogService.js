const { GetCommand, PutCommand, UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { docClient } = require("../config/dynamoClient");
const TABLES = require("../config/tables");
const { queryAll, encodeCursor, decodeCursor } = require("../utils/dynamo");
const { istDateKey, istDayStartIso } = require("../utils/dates");

/**
 * CallLogs table (OUTGOING calls placed from the app only):
 *   callId (PK) | companyId | salesmanUid | salesmanName
 *   shopId | shopName | address | fromNumber | toNumber
 *   callDirection ("outgoing") | callResult ("answered" | "no_answer" | "busy" | "unreachable" | "wrong_number")
 *   callStatus (legacy compatibility: "connected" | "not_connected") | orderReceived | orderDetails
 *   durationSeconds | callTimestamp (UTC ISO) | callDate (IST yyyy-mm-dd)
 *   notes | reminderDate (IST yyyy-mm-dd, only when set)
 *   followupStatus ("pending" | "done", only when reminderDate is set)
 *   followupDoneAt | followupClosedBy ("manual" | "call") | createdAt
 *
 * GSIs:
 *   companyId-callTimestamp-index   master dashboard / call list
 *   salesmanUid-callTimestamp-index salesman dashboard / call list
 *   shopId-callTimestamp-index      call history of one shop
 *   companyId-reminderDate-index    follow-ups (sparse: only items with a reminder)
 */

const newCallId = () => `CALL-${uuidv4().replace(/-/g, "").slice(0, 12)}`;

async function getCallLog(callId) {
  const res = await docClient.send(new GetCommand({ TableName: TABLES.CALL_LOGS, Key: { callId } }));
  return res.Item || null;
}

async function createCallLog({ user, shop, durationSeconds, callResult, callTimestamp, notes, orderReceived = false, orderDetails = null, reminderDate }) {
  const when = callTimestamp ? new Date(callTimestamp) : new Date();
  const ts = Number.isNaN(when.getTime()) ? new Date() : when;
  const duration = Math.max(0, Math.floor(Number(durationSeconds) || 0));

  const item = {
    callId: newCallId(),
    companyId: user.companyId,
    salesmanUid: user.uid,
    salesmanName: user.name,
    shopId: shop.shopId,
    shopName: shop.name,
    address: shop.address || "",
    fromNumber: user.mobile || "",
    toNumber: shop.phoneNumber,
    callDirection: "outgoing",
    callResult: callResult || (duration > 0 ? "answered" : "no_answer"),
    // Kept for older clients/dashboard consumers; new clients should use callResult.
    callStatus: (callResult || (duration > 0 ? "answered" : "no_answer")) === "answered" ? "connected" : "not_connected",
    durationSeconds: duration,
    orderReceived: Boolean(orderReceived),
    orderDetails: orderReceived ? (orderDetails || {}) : null,
    callTimestamp: ts.toISOString(),
    callDate: istDateKey(ts),
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  if (reminderDate) {
    item.reminderDate = reminderDate;
    item.followupStatus = "pending";
  }

  await docClient.send(
    new PutCommand({
      TableName: TABLES.CALL_LOGS,
      Item: item,
      ConditionExpression: "attribute_not_exists(callId)",
    }),
  );

  // A new call to the shop that has a NOTE closes that shop's older pending
  // follow-ups. Without a note nothing is closed.
  await closeHandledFollowups(item).catch(() => {});

  return item;
}

const hasNote = (c) => Boolean(c.notes && String(c.notes).trim());

async function closeHandledFollowups(newCall) {
  if (!hasNote(newCall)) return;

  const pending = await queryAll({
    TableName: TABLES.CALL_LOGS,
    IndexName: TABLES.INDEX.CALLS_BY_SHOP_TIME,
    KeyConditionExpression: "shopId = :s AND callTimestamp <= :t",
    FilterExpression: "followupStatus = :p AND callId <> :me",
    ExpressionAttributeValues: {
      ":s": newCall.shopId,
      ":t": newCall.callTimestamp,
      ":p": "pending",
      ":me": newCall.callId,
    },
  });
  await Promise.all(pending.map((c) => setFollowupDone(c.callId, "call")));
}

async function setFollowupDone(callId, closedBy = "manual") {
  const res = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.CALL_LOGS,
      Key: { callId },
      UpdateExpression: "SET followupStatus = :d, followupDoneAt = :t, followupClosedBy = :by",
      ConditionExpression: "attribute_exists(callId) AND attribute_exists(reminderDate)",
      ExpressionAttributeValues: { ":d": "done", ":t": new Date().toISOString(), ":by": closedBy },
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes;
}

/**
 * Updates notes and/or the reminder. reminderDate === "" (or null) removes
 * the reminder; a date sets it and re-opens the follow-up.
 */
async function updateCallLog(callId, { notes, reminderDate, callResult, orderReceived, orderDetails }) {
  const sets = [];
  const removes = [];
  const names = {};
  const values = {};

  if (notes !== undefined) {
    sets.push("#n = :n");
    names["#n"] = "notes";
    values[":n"] = notes;
  }
  if (callResult !== undefined) {
    sets.push("callResult = :cr", "callStatus = :cs");
    values[":cr"] = callResult;
    values[":cs"] = callResult === "answered" ? "connected" : "not_connected";
  }
  if (orderReceived !== undefined) {
    sets.push("orderReceived = :or");
    values[":or"] = orderReceived;
  }
  if (orderDetails !== undefined) {
    if (orderDetails === null) removes.push("orderDetails");
    else { sets.push("orderDetails = :od"); values[":od"] = orderDetails; }
  }
  if (reminderDate !== undefined) {
    if (reminderDate) {
      sets.push("reminderDate = :r", "followupStatus = :p");
      values[":r"] = reminderDate;
      values[":p"] = "pending";
      removes.push("followupDoneAt", "followupClosedBy");
    } else {
      removes.push("reminderDate", "followupStatus", "followupDoneAt", "followupClosedBy");
    }
  }

  const expr = [
    sets.length ? `SET ${sets.join(", ")}` : "",
    removes.length ? `REMOVE ${removes.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const res = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.CALL_LOGS,
      Key: { callId },
      UpdateExpression: expr,
      ...(Object.keys(names).length && { ExpressionAttributeNames: names }),
      ...(Object.keys(values).length && { ExpressionAttributeValues: values }),
      ConditionExpression: "attribute_exists(callId)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes;
}

function rangeQuery({ companyId, salesmanUid, startIso, endIso }) {
  return salesmanUid
    ? {
        TableName: TABLES.CALL_LOGS,
        IndexName: TABLES.INDEX.CALLS_BY_SALESMAN_TIME,
        KeyConditionExpression: "salesmanUid = :k AND callTimestamp BETWEEN :a AND :b",
        // defence in depth: never leak another company's data
        FilterExpression: "companyId = :c",
        ExpressionAttributeValues: { ":k": salesmanUid, ":a": startIso, ":b": endIso, ":c": companyId },
      }
    : {
        TableName: TABLES.CALL_LOGS,
        IndexName: TABLES.INDEX.CALLS_BY_COMPANY_TIME,
        KeyConditionExpression: "companyId = :k AND callTimestamp BETWEEN :a AND :b",
        ExpressionAttributeValues: { ":k": companyId, ":a": startIso, ":b": endIso },
      };
}

/** Every call in the range (used by the dashboard aggregation). */
async function listCallsInRange(opts) {
  return queryAll(rangeQuery(opts));
}

/**
 * One page of call logs, newest first.
 * status: "connected" | "not_connected" | undefined
 */
async function listCallLogsPage({ companyId, salesmanUid, startIso, endIso, status, shopId, limit = 50, cursor }) {
  const params = rangeQuery({ companyId, salesmanUid, startIso, endIso });
  const filters = params.FilterExpression ? [params.FilterExpression] : [];
  if (status) {
    if (["answered", "no_answer", "busy", "unreachable", "wrong_number"].includes(status)) {
      filters.push("callResult = :st");
      params.ExpressionAttributeValues[":st"] = status;
    } else {
      filters.push("callStatus = :st");
      params.ExpressionAttributeValues[":st"] = status;
    }
  }
  if (shopId) {
    filters.push("shopId = :sh");
    params.ExpressionAttributeValues[":sh"] = shopId;
  }
  if (filters.length) params.FilterExpression = filters.join(" AND ");

  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let items = [];
  let lastKey = decodeCursor(cursor);
  // With a FilterExpression a single DynamoDB page can come back short, so
  // keep reading until we have a full page or reach the end.
  do {
    const res = await docClient.send(
      new QueryCommand({
        ...params,
        ScanIndexForward: false,
        Limit: pageSize - items.length,
        ExclusiveStartKey: lastKey,
      }),
    );
    items = items.concat(res.Items || []);
    lastKey = res.LastEvaluatedKey;
  } while (lastKey && items.length < pageSize);

  return { items, nextCursor: encodeCursor(lastKey) };
}

/** Call history of a single shop, newest first. */
async function listShopCalls(shopId, { limit = 50 } = {}) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLES.CALL_LOGS,
      IndexName: TABLES.INDEX.CALLS_BY_SHOP_TIME,
      KeyConditionExpression: "shopId = :s",
      ExpressionAttributeValues: { ":s": shopId },
      ScanIndexForward: false,
      Limit: Math.min(Number(limit) || 50, 200),
    }),
  );
  return res.Items || [];
}

/**
 * Follow-ups shown to the salesman (and master):
 *  - today:           pending calls whose reminderDate is today
 *  - missedYesterday: yesterday's NOT-ANSWERED calls (latest per shop)
 * An item disappears only when a newer call with a NOTE is logged for that
 * shop. There is no manual "done".
 */
async function listDueFollowups({ companyId, salesmanUid }) {
  const today = istDateKey();
  const yesterday = istDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const values = { ":c": companyId, ":t": today, ":p": "pending" };
  let filter = "followupStatus = :p";
  if (salesmanUid) {
    filter += " AND salesmanUid = :s";
    values[":s"] = salesmanUid;
  }

  const [reminders, recentCalls] = await Promise.all([
    queryAll({
      TableName: TABLES.CALL_LOGS,
      IndexName: TABLES.INDEX.CALLS_BY_COMPANY_REMINDER,
      KeyConditionExpression: "companyId = :c AND reminderDate = :t",
      FilterExpression: filter,
      ExpressionAttributeValues: values,
    }),
    // every call since the start of yesterday (to find misses + newer notes)
    listCallsInRange({
      companyId,
      salesmanUid,
      startIso: istDayStartIso(yesterday),
      endIso: new Date(Date.now() + 60 * 1000).toISOString(),
    }),
  ]);

  // latest call-with-note per shop
  const lastNoteAt = new Map();
  for (const c of recentCalls) {
    if (!hasNote(c)) continue;
    if (!lastNoteAt.has(c.shopId) || c.callTimestamp > lastNoteAt.get(c.shopId)) {
      lastNoteAt.set(c.shopId, c.callTimestamp);
    }
  }

  const todayList = reminders.sort((a, b) =>
    String(b.callTimestamp).localeCompare(String(a.callTimestamp)),
  );
  const todayShops = new Set(todayList.map((c) => c.shopId));

  const latestMiss = new Map();
  for (const c of recentCalls) {
    if (c.callDate !== yesterday || !(c.callResult ? ["no_answer", "busy", "unreachable"].includes(c.callResult) : c.callStatus === "not_connected")) continue;
    const prev = latestMiss.get(c.shopId);
    if (!prev || c.callTimestamp > prev.callTimestamp) latestMiss.set(c.shopId, c);
  }
  const missedYesterday = [...latestMiss.values()]
    .filter((c) => !todayShops.has(c.shopId))
    .filter((c) => !(lastNoteAt.get(c.shopId) > c.callTimestamp))
    .sort((a, b) => String(b.callTimestamp).localeCompare(String(a.callTimestamp)));

  return { today: todayList, missedYesterday };
}

module.exports = {
  getCallLog,
  createCallLog,
  updateCallLog,
  setFollowupDone,
  listCallsInRange,
  listCallLogsPage,
  listShopCalls,
  listDueFollowups,
};
