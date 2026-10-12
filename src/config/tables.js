/**
 * DynamoDB table + index names in one place. See scripts/createTables.js for
 * the full key schema of every table.
 */
module.exports = {
  COMPANIES: process.env.DYNAMODB_COMPANIES_TABLE || "SC_Companies",
  USERS: process.env.DYNAMODB_USERS_TABLE || "SC_Users",
  SHOPS: process.env.DYNAMODB_SHOPS_TABLE || "SC_Shops",
  CALL_LOGS: process.env.DYNAMODB_CALLLOGS_TABLE || "SC_CallLogs",

  INDEX: {
    USERS_BY_COMPANY: "companyId-index",
    SHOPS_BY_COMPANY: "companyId-index",
    SHOPS_BY_SALESMAN: "salesmanUid-index",
    CALLS_BY_COMPANY_TIME: "companyId-callTimestamp-index",
    CALLS_BY_SALESMAN_TIME: "salesmanUid-callTimestamp-index",
    CALLS_BY_SHOP_TIME: "shopId-callTimestamp-index",
    CALLS_BY_COMPANY_REMINDER: "companyId-reminderDate-index",
  },
};
