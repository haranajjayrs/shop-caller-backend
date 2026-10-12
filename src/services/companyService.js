const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { docClient } = require("../config/dynamoClient");
const TABLES = require("../config/tables");

/**
 * Companies table:
 *   companyId (PK) | name | ownerUid | ownerName | email | mobile | createdAt
 */

function newCompanyId() {
  return `CMP-${uuidv4().split("-")[0]}`;
}

async function createCompany({ name, ownerUid, ownerName, email, mobile }) {
  const item = {
    companyId: newCompanyId(),
    name,
    ownerUid,
    ownerName,
    email,
    mobile,
    createdAt: new Date().toISOString(),
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLES.COMPANIES,
      Item: item,
      ConditionExpression: "attribute_not_exists(companyId)",
    }),
  );
  return item;
}

async function getCompany(companyId) {
  const res = await docClient.send(
    new GetCommand({ TableName: TABLES.COMPANIES, Key: { companyId } }),
  );
  return res.Item || null;
}

module.exports = { createCompany, getCompany };
