/**
 * Creates all DynamoDB tables + GSIs (on-demand billing). Safe to re-run:
 * existing tables are skipped.
 *
 *   npm run create-tables
 */
require("dotenv").config();
const { CreateTableCommand, DescribeTableCommand, waitUntilTableExists } = require("@aws-sdk/client-dynamodb");
const { client } = require("../src/config/dynamoClient");
const TABLES = require("../src/config/tables");

const S = (name) => ({ AttributeName: name, AttributeType: "S" });
const gsi = (IndexName, hash, range) => ({
  IndexName,
  KeySchema: [
    { AttributeName: hash, KeyType: "HASH" },
    ...(range ? [{ AttributeName: range, KeyType: "RANGE" }] : []),
  ],
  Projection: { ProjectionType: "ALL" },
});

const definitions = [
  {
    TableName: TABLES.COMPANIES,
    AttributeDefinitions: [S("companyId")],
    KeySchema: [{ AttributeName: "companyId", KeyType: "HASH" }],
  },
  {
    TableName: TABLES.USERS,
    AttributeDefinitions: [S("uid"), S("companyId")],
    KeySchema: [{ AttributeName: "uid", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [gsi(TABLES.INDEX.USERS_BY_COMPANY, "companyId")],
  },
  {
    TableName: TABLES.SHOPS,
    AttributeDefinitions: [S("shopId"), S("companyId"), S("salesmanUid")],
    KeySchema: [{ AttributeName: "shopId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      gsi(TABLES.INDEX.SHOPS_BY_COMPANY, "companyId"),
      gsi(TABLES.INDEX.SHOPS_BY_SALESMAN, "salesmanUid"),
    ],
  },
  {
    TableName: TABLES.CALL_LOGS,
    AttributeDefinitions: [
      S("callId"),
      S("companyId"),
      S("salesmanUid"),
      S("shopId"),
      S("callTimestamp"),
      S("reminderDate"),
    ],
    KeySchema: [{ AttributeName: "callId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      gsi(TABLES.INDEX.CALLS_BY_COMPANY_TIME, "companyId", "callTimestamp"),
      gsi(TABLES.INDEX.CALLS_BY_SALESMAN_TIME, "salesmanUid", "callTimestamp"),
      gsi(TABLES.INDEX.CALLS_BY_SHOP_TIME, "shopId", "callTimestamp"),
      gsi(TABLES.INDEX.CALLS_BY_COMPANY_REMINDER, "companyId", "reminderDate"),
    ],
  },
];

async function exists(TableName) {
  try {
    await client.send(new DescribeTableCommand({ TableName }));
    return true;
  } catch (err) {
    if (err.name === "ResourceNotFoundException") return false;
    throw err;
  }
}

async function createAll({ log = console.log } = {}) {
  for (const def of definitions) {
    if (await exists(def.TableName)) {
      log(`✓ ${def.TableName} already exists`);
      continue;
    }
    await client.send(new CreateTableCommand({ ...def, BillingMode: "PAY_PER_REQUEST" }));
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: def.TableName });
    log(`+ created ${def.TableName}`);
  }
}

if (require.main === module) {
  createAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createAll, definitions };
