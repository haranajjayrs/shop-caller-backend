const {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { docClient } = require("../config/dynamoClient");
const TABLES = require("../config/tables");
const { queryAll, batchPut } = require("../utils/dynamo");

/**
 * Shops table:
 *   shopId (PK) | companyId | name | address | phoneNumber
 *   salesmanUid | salesmanName | createdAt | updatedAt
 * GSI companyId-index   (PK companyId)   -> master: all shops of the company
 * GSI salesmanUid-index (PK salesmanUid) -> salesman: only their shops
 */

const newShopId = () => `SHOP-${uuidv4().split("-")[0]}${uuidv4().split("-")[1]}`;

const byName = (a, b) => String(a.name).localeCompare(String(b.name));

async function getShop(shopId) {
  const res = await docClient.send(new GetCommand({ TableName: TABLES.SHOPS, Key: { shopId } }));
  return res.Item || null;
}

async function listCompanyShops(companyId) {
  const items = await queryAll({
    TableName: TABLES.SHOPS,
    IndexName: TABLES.INDEX.SHOPS_BY_COMPANY,
    KeyConditionExpression: "companyId = :c",
    ExpressionAttributeValues: { ":c": companyId },
  });
  return items.sort(byName);
}

async function listSalesmanShops(salesmanUid) {
  const items = await queryAll({
    TableName: TABLES.SHOPS,
    IndexName: TABLES.INDEX.SHOPS_BY_SALESMAN,
    KeyConditionExpression: "salesmanUid = :s",
    ExpressionAttributeValues: { ":s": salesmanUid },
  });
  return items.sort(byName);
}

function buildShop({ companyId, name, address, phoneNumber, salesman }) {
  const now = new Date().toISOString();
  return {
    shopId: newShopId(),
    companyId,
    name: String(name).trim(),
    address: String(address || "").trim(),
    phoneNumber,
    salesmanUid: salesman.uid,
    salesmanName: salesman.name,
    createdAt: now,
    updatedAt: now,
  };
}

async function createShop(input) {
  const item = buildShop(input);
  await docClient.send(
    new PutCommand({
      TableName: TABLES.SHOPS,
      Item: item,
      ConditionExpression: "attribute_not_exists(shopId)",
    }),
  );
  return item;
}

async function createShopsBulk(inputs) {
  const items = inputs.map(buildShop);
  await batchPut(TABLES.SHOPS, items);
  return items;
}

async function updateShop(shopId, fields) {
  const entries = Object.entries({ ...fields, updatedAt: new Date().toISOString() }).filter(
    ([, v]) => v !== undefined,
  );
  const names = {};
  const values = {};
  const sets = entries.map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  const res = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.SHOPS,
      Key: { shopId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(shopId)",
      ReturnValues: "ALL_NEW",
    }),
  );
  return res.Attributes;
}

async function deleteShop(shopId) {
  await docClient.send(new DeleteCommand({ TableName: TABLES.SHOPS, Key: { shopId } }));
}

module.exports = {
  getShop,
  listCompanyShops,
  listSalesmanShops,
  createShop,
  createShopsBulk,
  updateShop,
  deleteShop,
};
