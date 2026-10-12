const { QueryCommand, BatchWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../config/dynamoClient");

/** Runs a Query and follows LastEvaluatedKey until done (or `max` items). */
async function queryAll(params, { max = 20000 } = {}) {
  let items = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items = items.concat(res.Items || []);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < max);
  return items.slice(0, max);
}

/** Puts many items, 25 per request, retrying UnprocessedItems with backoff. */
async function batchPut(tableName, items) {
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;
    while (requests.length) {
      const res = await docClient.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
      );
      requests = res.UnprocessedItems?.[tableName] || [];
      if (requests.length) {
        attempt += 1;
        if (attempt > 8) throw new Error("DynamoDB batch write kept throttling");
        await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      }
    }
  }
}

/** Opaque pagination cursor helpers (base64url JSON of LastEvaluatedKey). */
const encodeCursor = (key) =>
  key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;

function decodeCursor(cursor) {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

module.exports = { queryAll, batchPut, encodeCursor, decodeCursor };
