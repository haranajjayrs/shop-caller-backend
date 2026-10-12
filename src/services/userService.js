const { GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../config/dynamoClient");
const TABLES = require("../config/tables");
const { queryAll } = require("../utils/dynamo");

/**
 * Users table — one item per Firebase user (masters AND salesmen):
 *   uid (PK) | companyId | role | name | mobile | email | active | createdAt
 * GSI companyId-index (PK companyId)
 */

async function getUser(uid) {
  const res = await docClient.send(new GetCommand({ TableName: TABLES.USERS, Key: { uid } }));
  return res.Item || null;
}

async function putUser(user) {
  await docClient.send(
    new PutCommand({
      TableName: TABLES.USERS,
      Item: user,
      ConditionExpression: "attribute_not_exists(uid)",
    }),
  );
  return user;
}

async function listCompanyUsers(companyId, { role } = {}) {
  const items = await queryAll({
    TableName: TABLES.USERS,
    IndexName: TABLES.INDEX.USERS_BY_COMPANY,
    KeyConditionExpression: "companyId = :c",
    ExpressionAttributeValues: { ":c": companyId },
  });
  const filtered = role ? items.filter((u) => u.role === role) : items;
  return filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function updateUser(uid, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return getUser(uid);
  const names = {};
  const values = {};
  const sets = entries.map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  const res = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.USERS,
      Key: { uid },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(uid)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes;
}

module.exports = { getUser, putUser, listCompanyUsers, updateUser };
