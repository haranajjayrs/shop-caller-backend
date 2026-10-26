/**
 * End-to-end API tests using dynalite and fake Firebase.
 * Run: npm test
 */
process.env.NODE_ENV = "test";
process.env.AWS_REGION = "ap-south-1";
process.env.AWS_ACCESS_KEY_ID = "test";
process.env.AWS_SECRET_ACCESS_KEY = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const dynalite = require("dynalite");
const ExcelJS = require("exceljs");

let server;
let base;
let dyn;

const fbUsers = new Map();
let uidSeq = 0;

const fakeProvider = {
  async createUser({ email, password }) {
    if (fbUsers.has(email)) {
      const error = new Error("exists");
      error.code = "auth/email-already-exists";
      throw error;
    }

    const uid = `uid${++uidSeq}`;
    fbUsers.set(email, { uid, password, disabled: false });
    return { uid };
  },

  async updateUser(uid, fields) {
    for (const user of fbUsers.values()) {
      if (user.uid === uid) Object.assign(user, fields);
    }
  },

  async deleteUser(uid) {
    for (const [email, user] of fbUsers) {
      if (user.uid === uid) fbUsers.delete(email);
    }
  },

  async revokeTokens() {},
};

const login = (email, password) => {
  const user = fbUsers.get(email);
  return user && user.password === password && !user.disabled ? user.uid : null;
};

async function api(method, path, { token, body, form } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: form || (body ? JSON.stringify(body) : undefined),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test.before(async () => {
  dyn = dynalite({
    createTableMs: 0,
    deleteTableMs: 0,
    updateTableMs: 0,
  });

  await new Promise((resolve) => dyn.listen(0, resolve));

  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${dyn.address().port}`;

  await require("../scripts/createTables").createAll({
    log: () => {},
  });

  require("../src/services/authProvider").setProvider(fakeProvider);

  require("../src/middleware/auth").setTokenVerifier(async (token) => ({
    uid: token,
  }));

  const app = require("../src/app");
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  dyn?.close();
});

const ctx = {};

// --------------------------------------------------
// Company registration and company isolation
// --------------------------------------------------

test("company registration creates a master", async () => {
  const response = await api("POST", "/auth/register-company", {
    body: {
      companyName: "Acme Foods",
      ownerName: "Gokila",
      email: "Owner@Acme.com",
      mobile: "+91 98400 11111",
      password: "secret123",
    },
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));

  ctx.master = login("owner@acme.com", "secret123");
  assert.ok(ctx.master);

  const me = await api("GET", "/auth/me", {
    token: ctx.master,
  });

  assert.equal(me.body.data.user.role, "master");
  assert.equal(me.body.data.company.name, "Acme Foods");

  const duplicate = await api("POST", "/auth/register-company", {
    body: {
      companyName: "X",
      ownerName: "Y",
      email: "owner@acme.com",
      mobile: "9840011111",
      password: "secret123",
    },
  });

  assert.equal(duplicate.status, 409);

  await api("POST", "/auth/register-company", {
    body: {
      companyName: "Other Co",
      ownerName: "Z",
      email: "z@other.com",
      mobile: "9840022222",
      password: "secret123",
    },
  });

  ctx.otherMaster = login("z@other.com", "secret123");
});

// --------------------------------------------------
// Random passwords and mandatory first-login change
// --------------------------------------------------

test("salesmen receive random temporary passwords and must change them", async () => {
  const response = await api("POST", "/salesmen", {
    token: ctx.master,
    body: {
      name: "Ajith",
      mobile: "9123456789",
    },
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));

  const temporaryPassword = response.body.data.credentials.password;

  assert.match(temporaryPassword, /^[A-Za-z0-9_-]{16}$/);

  ctx.ajith = login("9123456789@salesman.shopcaller.app", temporaryPassword);

  assert.ok(ctx.ajith);

  const profile = await api("GET", "/auth/me", {
    token: ctx.ajith,
  });

  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.equal(profile.body.data.user.mustChangePassword, true);

  const blocked = await api("GET", "/shops", {
    token: ctx.ajith,
  });

  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");

  const changed = await api("POST", "/auth/change-password", {
    token: ctx.ajith,
    body: {
      password: "AjithSecurePass123",
    },
  });

  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  assert.equal(
    login("9123456789@salesman.shopcaller.app", "AjithSecurePass123"),
    ctx.ajith,
  );

  const updatedProfile = await api("GET", "/auth/me", {
    token: ctx.ajith,
  });

  assert.equal(updatedProfile.status, 200);
  assert.equal(updatedProfile.body.data.user.mustChangePassword, false);

  const raviResponse = await api("POST", "/salesmen", {
    token: ctx.master,
    body: {
      name: "Ravi",
      mobile: "09000012345",
    },
  });

  assert.equal(raviResponse.status, 201, JSON.stringify(raviResponse.body));

  const raviPassword = raviResponse.body.data.credentials.password;

  assert.match(raviPassword, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(raviPassword, temporaryPassword);

  ctx.ravi = login("9000012345@salesman.shopcaller.app", raviPassword);

  assert.ok(ctx.ravi);

  const raviChanged = await api("POST", "/auth/change-password", {
    token: ctx.ravi,
    body: {
      password: "RaviSecurePass123",
    },
  });

  assert.equal(raviChanged.status, 200);

  assert.equal(
    login("9000012345@salesman.shopcaller.app", "RaviSecurePass123"),
    ctx.ravi,
  );

  const duplicateMobile = await api("POST", "/salesmen", {
    token: ctx.master,
    body: {
      name: "Duplicate",
      mobile: "9123456789",
    },
  });

  assert.equal(duplicateMobile.status, 409);

  const duplicateName = await api("POST", "/salesmen", {
    token: ctx.master,
    body: {
      name: "ajith",
      mobile: "9888877777",
    },
  });

  assert.equal(duplicateName.status, 409);

  const invalidMobile = await api("POST", "/salesmen", {
    token: ctx.master,
    body: {
      name: "Bad",
      mobile: "12345",
    },
  });

  assert.equal(invalidMobile.status, 400);

  const forbiddenCreate = await api("POST", "/salesmen", {
    token: ctx.ajith,
    body: {
      name: "X",
      mobile: "9999999999",
    },
  });

  assert.equal(forbiddenCreate.status, 403);
});

// --------------------------------------------------
// Excel upload and shop/company isolation
// --------------------------------------------------

test("Excel upload assigns shops to the correct salesmen", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Shops");

  worksheet.addRow(["Shop Name", "Address", "Phone Number", "Salesman Name"]);

  worksheet.addRow(["Murugan Stores", "Madurai", 9876500001, "Ajith"]);

  worksheet.addRow(["Lakshmi Traders", "Trichy", "+91 98765 00002", " ajith "]);

  worksheet.addRow(["Ravi Shop", "Chennai", "9876500003", "Ravi"]);

  worksheet.addRow(["Dup Phone", "Chennai", "9876500003", "Ravi"]);

  worksheet.addRow(["Unknown Salesman", "Salem", "9876500004", "Kumar"]);

  worksheet.addRow(["Bad Phone", "Salem", "12", "Ajith"]);

  worksheet.addRow([]);

  const buffer = await workbook.xlsx.writeBuffer();
  const form = new FormData();

  form.append("file", new Blob([buffer]), "shops.xlsx");

  const response = await api("POST", "/shops/upload", {
    token: ctx.master,
    form,
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.created, 3);
  assert.equal(response.body.data.skippedCount, 3);

  assert.deepEqual(response.body.data.perSalesman, { Ajith: 2, Ravi: 1 });

  const ajithShops = await api("GET", "/shops", {
    token: ctx.ajith,
  });

  assert.deepEqual(ajithShops.body.data.map((shop) => shop.name).sort(), [
    "Lakshmi Traders",
    "Murugan Stores",
  ]);

  const raviShops = await api("GET", "/shops", {
    token: ctx.ravi,
  });

  assert.equal(raviShops.body.data.length, 1);

  ctx.raviShop = raviShops.body.data[0];

  ctx.ajithShop = ajithShops.body.data.find(
    (shop) => shop.name === "Murugan Stores",
  );

  assert.equal(ctx.ajithShop.phoneNumber, "9876500001");

  const allShops = await api("GET", "/shops", {
    token: ctx.master,
  });

  assert.equal(allShops.body.data.length, 3);

  const otherCompanyShops = await api("GET", "/shops", {
    token: ctx.otherMaster,
  });

  assert.equal(otherCompanyShops.body.data.length, 0);
});

// --------------------------------------------------
// Calls and follow-ups
// --------------------------------------------------

test("salesmen log calls only for their own shops", async () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(new Date());

  const yesterdayTimestamp = new Date(
    Date.now() - 24 * 60 * 60 * 1000,
  ).toISOString();

  const lakshmi = (
    await api("GET", "/shops", { token: ctx.ajith })
  ).body.data.find((shop) => shop.name === "Lakshmi Traders");

  const forbidden = await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: ctx.raviShop.shopId,
      durationSeconds: 10,
    },
  });

  assert.equal(forbidden.status, 403);

  const firstCall = await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: ctx.ajithShop.shopId,
      durationSeconds: 95,
      notes: "Wants 10 boxes",
      reminderDate: today,
    },
  });

  assert.equal(firstCall.status, 201, JSON.stringify(firstCall.body));
  assert.equal(firstCall.body.data.callStatus, "connected");
  assert.equal(firstCall.body.data.fromNumber, "9123456789");
  assert.equal(firstCall.body.data.callDirection, "outgoing");

  const missedCall = await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: lakshmi.shopId,
      durationSeconds: 0,
      callTimestamp: yesterdayTimestamp,
    },
  });

  assert.equal(missedCall.body.data.callStatus, "not_connected");

  const pastReminder = await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: ctx.ajithShop.shopId,
      durationSeconds: 5,
      reminderDate: "2020-01-01",
    },
  });

  assert.equal(pastReminder.status, 400);

  let followups = await api("GET", "/followups", {
    token: ctx.ajith,
  });

  assert.equal(followups.body.data.today.length, 1);
  assert.equal(followups.body.data.missedYesterday.length, 1);

  assert.equal(
    followups.body.data.missedYesterday[0].shopName,
    "Lakshmi Traders",
  );

  const raviFollowups = await api("GET", "/followups", {
    token: ctx.ravi,
  });

  assert.equal(
    raviFollowups.body.data.today.length +
      raviFollowups.body.data.missedYesterday.length,
    0,
  );

  await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: ctx.ajithShop.shopId,
      durationSeconds: 0,
    },
  });

  await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: lakshmi.shopId,
      durationSeconds: 20,
    },
  });

  followups = await api("GET", "/followups", {
    token: ctx.ajith,
  });

  assert.equal(followups.body.data.today.length, 1);
  assert.equal(followups.body.data.missedYesterday.length, 1);

  const manualDone = await api(
    "POST",
    `/followups/${firstCall.body.data.callId}/done`,
    { token: ctx.ajith },
  );

  assert.equal(manualDone.status, 404);

  await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: ctx.ajithShop.shopId,
      durationSeconds: 30,
      notes: "Order confirmed",
    },
  });

  await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: {
      shopId: lakshmi.shopId,
      durationSeconds: 0,
      notes: "Try Monday",
    },
  });

  followups = await api("GET", "/followups", {
    token: ctx.ajith,
  });

  assert.equal(followups.body.data.today.length, 0);
  assert.equal(followups.body.data.missedYesterday.length, 0);

  await api("POST", "/call-logs", {
    token: ctx.ravi,
    body: {
      shopId: ctx.raviShop.shopId,
      durationSeconds: 60,
      reminderDate: today,
    },
  });

  const masterFollowups = await api("GET", "/followups", {
    token: ctx.master,
  });

  assert.equal(masterFollowups.body.data.today.length, 1);
});

// --------------------------------------------------
// Dashboard and call list
// --------------------------------------------------

test("dashboards and call lists support date filters", async () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(new Date());

  const masterDashboard = await api(
    "GET",
    `/dashboard?from=${today}&to=${today}`,
    { token: ctx.master },
  );

  assert.equal(masterDashboard.status, 200);

  const summary = masterDashboard.body.data.summary;

  assert.equal(summary.totalCalls, 6);
  assert.equal(summary.connectedCalls, 4);
  assert.equal(summary.notConnectedCalls, 2);
  assert.equal(summary.totalTalkSeconds, 205);
  assert.equal(summary.assignedShops, 3);
  assert.equal(summary.shopsNotCalled, 0);
  assert.equal(summary.followupsDueToday, 1);

  assert.equal(masterDashboard.body.data.salesmen.length, 2);
  assert.equal(masterDashboard.body.data.salesmen[0].name, "Ajith");
  assert.equal(masterDashboard.body.data.salesmen[0].totalCalls, 5);

  const raviDashboard = await api("GET", `/dashboard?salesmanUid=${ctx.ravi}`, {
    token: ctx.master,
  });

  assert.equal(raviDashboard.body.data.summary.totalCalls, 1);

  const ownDashboard = await api("GET", "/dashboard", {
    token: ctx.ravi,
  });

  assert.equal(ownDashboard.body.data.summary.totalCalls, 1);
  assert.equal(ownDashboard.body.data.salesmen, undefined);

  const sneakyDashboard = await api(
    "GET",
    `/dashboard?salesmanUid=${ctx.ajith}`,
    { token: ctx.ravi },
  );

  assert.equal(sneakyDashboard.body.data.summary.totalCalls, 1);

  const oldDashboard = await api(
    "GET",
    "/dashboard?from=2024-01-01&to=2024-01-31",
    { token: ctx.master },
  );

  assert.equal(oldDashboard.body.data.summary.totalCalls, 0);
  assert.equal(oldDashboard.body.data.daily.length, 31);

  const page1 = await api(
    "GET",
    `/call-logs?from=${today}&to=${today}&limit=2`,
    { token: ctx.master },
  );

  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body.nextCursor);

  const page2 = await api(
    "GET",
    `/call-logs?from=${today}&to=${today}&limit=2&cursor=${page1.body.nextCursor}`,
    { token: ctx.master },
  );

  assert.equal(page2.body.data.length, 2);
  assert.notEqual(page1.body.data[0].callId, page2.body.data[0].callId);

  const notConnected = await api("GET", "/call-logs?status=not_connected", {
    token: ctx.master,
  });

  assert.equal(notConnected.body.data.length, 2);

  const raviCalls = await api("GET", "/call-logs", {
    token: ctx.ravi,
  });

  assert.equal(raviCalls.body.data.length, 1);

  const invalidRange = await api(
    "GET",
    "/dashboard?from=2024-02-10&to=2024-02-01",
    { token: ctx.master },
  );

  assert.equal(invalidRange.status, 400);

  const history = await api("GET", `/shops/${ctx.ajithShop.shopId}/calls`, {
    token: ctx.ajith,
  });

  assert.equal(history.body.data.calls.length, 3);

  const forbiddenHistory = await api(
    "GET",
    `/shops/${ctx.ajithShop.shopId}/calls`,
    { token: ctx.ravi },
  );

  assert.equal(forbiddenHistory.status, 403);
});

// --------------------------------------------------
// Reassignment, deactivation and password reset
// --------------------------------------------------

test("reassign shop, deactivate salesman and reset password securely", async () => {
  const reassigned = await api("PATCH", `/shops/${ctx.raviShop.shopId}`, {
    token: ctx.master,
    body: { salesmanUid: ctx.ajith },
  });

  assert.equal(reassigned.body.data.salesmanName, "Ajith");

  const ajithShops = await api("GET", "/shops", {
    token: ctx.ajith,
  });

  assert.equal(ajithShops.body.data.length, 3);

  const deactivated = await api("PATCH", `/salesmen/${ctx.ravi}`, {
    token: ctx.master,
    body: { active: false },
  });

  assert.equal(deactivated.body.data.active, false);

  const blockedRavi = await api("GET", "/shops", {
    token: ctx.ravi,
  });

  assert.equal(blockedRavi.status, 403);

  const reset = await api("POST", `/salesmen/${ctx.ajith}/reset-password`, {
    token: ctx.master,
  });

  assert.equal(reset.status, 200, JSON.stringify(reset.body));

  const resetPassword = reset.body.data.password;

  assert.match(resetPassword, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(resetPassword, "AjithSecurePass123");

  const resetProfile = await api("GET", "/auth/me", {
    token: ctx.ajith,
  });

  assert.equal(resetProfile.status, 200);
  assert.equal(resetProfile.body.data.user.mustChangePassword, true);

  const resetBlocked = await api("GET", "/shops", {
    token: ctx.ajith,
  });

  assert.equal(resetBlocked.status, 403);
  assert.equal(resetBlocked.body.code, "PASSWORD_CHANGE_REQUIRED");

  const resetChange = await api("POST", "/auth/change-password", {
    token: ctx.ajith,
    body: {
      password: "AjithNewSecurePass456",
    },
  });

  assert.equal(resetChange.status, 200);

  assert.equal(
    login("9123456789@salesman.shopcaller.app", "AjithNewSecurePass456"),
    ctx.ajith,
  );

  const crossCompany = await api("PATCH", `/salesmen/${ctx.ajith}`, {
    token: ctx.otherMaster,
    body: { active: false },
  });

  assert.equal(crossCompany.status, 404);

  const salesmen = await api("GET", "/salesmen", {
    token: ctx.master,
  });

  assert.equal(
    salesmen.body.data.find((salesman) => salesman.name === "Ajith")
      .assignedShops,
    3,
  );
});
