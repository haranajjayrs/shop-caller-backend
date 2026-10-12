/**
 * End-to-end API test against an in-process DynamoDB (dynalite) with fake
 * Firebase. Run: npm test
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

// ---- fake Firebase ----
const fbUsers = new Map(); // email -> { uid, password, disabled }
let uidSeq = 0;
const fakeProvider = {
  async createUser({ email, password }) {
    if (fbUsers.has(email)) {
      const e = new Error("exists");
      e.code = "auth/email-already-exists";
      throw e;
    }
    const uid = `uid${++uidSeq}`;
    fbUsers.set(email, { uid, password, disabled: false });
    return { uid };
  },
  async updateUser(uid, fields) {
    for (const u of fbUsers.values()) if (u.uid === uid) Object.assign(u, fields);
  },
  async deleteUser(uid) {
    for (const [k, u] of fbUsers) if (u.uid === uid) fbUsers.delete(k);
  },
  async revokeTokens() {},
};
const login = (email, password) => {
  const u = fbUsers.get(email);
  return u && u.password === password && !u.disabled ? u.uid : null;
};

async function api(method, path, { token, body, form } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  dyn = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise((r) => dyn.listen(0, r));
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${dyn.address().port}`;

  await require("../scripts/createTables").createAll({ log: () => {} });

  require("../src/services/authProvider").setProvider(fakeProvider);
  require("../src/middleware/auth").setTokenVerifier(async (t) => ({ uid: t }));

  const app = require("../src/app");
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  dyn?.close();
});

const ctx = {};

test("company registration creates a master", async () => {
  const r = await api("POST", "/auth/register-company", {
    body: { companyName: "Acme Foods", ownerName: "Gokila", email: "Owner@Acme.com", mobile: "+91 98400 11111", password: "secret123" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ctx.master = login("owner@acme.com", "secret123");
  assert.ok(ctx.master);

  const me = await api("GET", "/auth/me", { token: ctx.master });
  assert.equal(me.body.data.user.role, "master");
  assert.equal(me.body.data.company.name, "Acme Foods");

  const dup = await api("POST", "/auth/register-company", {
    body: { companyName: "X", ownerName: "Y", email: "owner@acme.com", mobile: "9840011111", password: "secret123" },
  });
  assert.equal(dup.status, 409);

  // a second, unrelated company to check isolation
  await api("POST", "/auth/register-company", {
    body: { companyName: "Other Co", ownerName: "Z", email: "z@other.com", mobile: "9840022222", password: "secret123" },
  });
  ctx.otherMaster = login("z@other.com", "secret123");
});

test("master adds salesmen with auto password last4@salesman", async () => {
  const r = await api("POST", "/salesmen", { token: ctx.master, body: { name: "Ajith", mobile: "9123456789" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.credentials.password, "6789@salesman");
  ctx.ajith = login("9123456789@salesman.shopcaller.app", "6789@salesman");
  assert.ok(ctx.ajith, "salesman can log in with mobile + last4@salesman");

  const r2 = await api("POST", "/salesmen", { token: ctx.master, body: { name: "Ravi", mobile: "09000012345" } });
  assert.equal(r2.body.data.credentials.password, "2345@salesman");
  ctx.ravi = login("9000012345@salesman.shopcaller.app", "2345@salesman");

  const dup = await api("POST", "/salesmen", { token: ctx.master, body: { name: "Dup", mobile: "9123456789" } });
  assert.equal(dup.status, 409);

  const sameName = await api("POST", "/salesmen", { token: ctx.master, body: { name: "ajith", mobile: "9888877777" } });
  assert.equal(sameName.status, 409, "duplicate salesman name blocked");

  const bad = await api("POST", "/salesmen", { token: ctx.master, body: { name: "Bad", mobile: "12345" } });
  assert.equal(bad.status, 400);

  const asSalesman = await api("POST", "/salesmen", { token: ctx.ajith, body: { name: "X", mobile: "9999999999" } });
  assert.equal(asSalesman.status, 403);
});

test("excel upload assigns shops to the right salesman", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Shops");
  ws.addRow(["Shop Name", "Address", "Phone Number", "Salesman Name"]);
  ws.addRow(["Murugan Stores", "Madurai", 9876500001, "Ajith"]);
  ws.addRow(["Lakshmi Traders", "Trichy", "+91 98765 00002", " ajith "]);
  ws.addRow(["Ravi Shop", "Chennai", "9876500003", "Ravi"]);
  ws.addRow(["Dup Phone", "Chennai", "9876500003", "Ravi"]); // duplicate
  ws.addRow(["Unknown Salesman", "Salem", "9876500004", "Kumar"]);
  ws.addRow(["Bad Phone", "Salem", "12", "Ajith"]);
  ws.addRow([]); // blank row ignored
  const buf = await wb.xlsx.writeBuffer();

  const form = new FormData();
  form.append("file", new Blob([buf]), "shops.xlsx");
  const r = await api("POST", "/shops/upload", { token: ctx.master, form });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.created, 3);
  assert.equal(r.body.data.skippedCount, 3);
  assert.deepEqual(r.body.data.perSalesman, { Ajith: 2, Ravi: 1 });

  const ajithShops = await api("GET", "/shops", { token: ctx.ajith });
  assert.deepEqual(ajithShops.body.data.map((s) => s.name).sort(), ["Lakshmi Traders", "Murugan Stores"]);
  const raviShops = await api("GET", "/shops", { token: ctx.ravi });
  assert.equal(raviShops.body.data.length, 1);
  ctx.raviShop = raviShops.body.data[0];
  ctx.ajithShop = ajithShops.body.data.find((s) => s.name === "Murugan Stores");
  assert.equal(ctx.ajithShop.phoneNumber, "9876500001");

  const all = await api("GET", "/shops", { token: ctx.master });
  assert.equal(all.body.data.length, 3);
  const other = await api("GET", "/shops", { token: ctx.otherMaster });
  assert.equal(other.body.data.length, 0, "other company sees nothing");
});

test("salesman logs outgoing calls only for own shops; followups", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const yesterdayTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const lakshmi = (await api("GET", "/shops", { token: ctx.ajith })).body.data.find((s) => s.name === "Lakshmi Traders");

  const forbidden = await api("POST", "/call-logs", { token: ctx.ajith, body: { shopId: ctx.raviShop.shopId, durationSeconds: 10 } });
  assert.equal(forbidden.status, 403);

  // today's reminder on Murugan
  const c1 = await api("POST", "/call-logs", {
    token: ctx.ajith,
    body: { shopId: ctx.ajithShop.shopId, durationSeconds: 95, notes: "Wants 10 boxes", reminderDate: today },
  });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c1.body.data.callStatus, "connected");
  assert.equal(c1.body.data.fromNumber, "9123456789");
  assert.equal(c1.body.data.callDirection, "outgoing");

  // yesterday: Lakshmi not answered
  const miss = await api("POST", "/call-logs", { token: ctx.ajith, body: { shopId: lakshmi.shopId, durationSeconds: 0, callTimestamp: yesterdayTs } });
  assert.equal(miss.body.data.callStatus, "not_connected");

  const past = await api("POST", "/call-logs", { token: ctx.ajith, body: { shopId: ctx.ajithShop.shopId, durationSeconds: 5, reminderDate: "2020-01-01" } });
  assert.equal(past.status, 400);

  let f = await api("GET", "/followups", { token: ctx.ajith });
  assert.equal(f.body.data.today.length, 1);
  assert.equal(f.body.data.missedYesterday.length, 1);
  assert.equal(f.body.data.missedYesterday[0].shopName, "Lakshmi Traders");
  const fr = await api("GET", "/followups", { token: ctx.ravi });
  assert.equal(fr.body.data.today.length + fr.body.data.missedYesterday.length, 0, "ravi sees none of ajith's");

  // new calls WITHOUT a note don't close anything (even connected)
  await api("POST", "/call-logs", { token: ctx.ajith, body: { shopId: ctx.ajithShop.shopId, durationSeconds: 0 } });
  await api("POST", "/call-logs", { token: ctx.ajith, body: { shopId: lakshmi.shopId, durationSeconds: 20 } });
  f = await api("GET", "/followups", { token: ctx.ajith });
  assert.equal(f.body.data.today.length, 1);
  assert.equal(f.body.data.missedYesterday.length, 1);

  // manual done no longer exists
  const manual = await api("POST", `/followups/${c1.body.data.callId}/done`, { token: ctx.ajith });
  assert.equal(manual.status, 404);

  // a new call WITH a note closes the shop's follow-up
  await api("POST", "/call-logs", { token: ctx.ajith, body: { shopId: ctx.ajithShop.shopId, durationSeconds: 30, notes: "Order confirmed" } });
  await api("POST", "/call-logs", { token: ctx.ajith, body: { shopId: lakshmi.shopId, durationSeconds: 0, notes: "Still not picking, try Monday" } });
  f = await api("GET", "/followups", { token: ctx.ajith });
  assert.equal(f.body.data.today.length, 0);
  assert.equal(f.body.data.missedYesterday.length, 0);

  // master sees company follow-ups
  await api("POST", "/call-logs", { token: ctx.ravi, body: { shopId: ctx.raviShop.shopId, durationSeconds: 60, reminderDate: today } });
  f = await api("GET", "/followups", { token: ctx.master });
  assert.equal(f.body.data.today.length, 1);
});

test("dashboards and call list with date filters", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

  const m = await api("GET", `/dashboard?from=${today}&to=${today}`, { token: ctx.master });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const s = m.body.data.summary;
  assert.equal(s.totalCalls, 6);
  assert.equal(s.connectedCalls, 4);
  assert.equal(s.notConnectedCalls, 2);
  assert.equal(s.totalTalkSeconds, 205);
  assert.equal(s.assignedShops, 3);
  assert.equal(s.shopsNotCalled, 0);
  assert.equal(s.followupsDueToday, 1);
  assert.equal(m.body.data.salesmen.length, 2);
  assert.equal(m.body.data.salesmen[0].name, "Ajith");
  assert.equal(m.body.data.salesmen[0].totalCalls, 5);

  const onlyRavi = await api("GET", `/dashboard?salesmanUid=${ctx.ravi}`, { token: ctx.master });
  assert.equal(onlyRavi.body.data.summary.totalCalls, 1);

  const sd = await api("GET", `/dashboard`, { token: ctx.ravi });
  assert.equal(sd.body.data.summary.totalCalls, 1);
  assert.equal(sd.body.data.salesmen, undefined);
  // salesman can't peek at someone else by passing salesmanUid
  const sneaky = await api("GET", `/dashboard?salesmanUid=${ctx.ajith}`, { token: ctx.ravi });
  assert.equal(sneaky.body.data.summary.totalCalls, 1);

  const old = await api("GET", `/dashboard?from=2024-01-01&to=2024-01-31`, { token: ctx.master });
  assert.equal(old.body.data.summary.totalCalls, 0);
  assert.equal(old.body.data.daily.length, 31);

  const page1 = await api("GET", `/call-logs?from=${today}&to=${today}&limit=2`, { token: ctx.master });
  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body.nextCursor);
  const page2 = await api("GET", `/call-logs?from=${today}&to=${today}&limit=2&cursor=${page1.body.nextCursor}`, { token: ctx.master });
  assert.equal(page2.body.data.length, 2);
  assert.notEqual(page1.body.data[0].callId, page2.body.data[0].callId);

  const nc = await api("GET", `/call-logs?status=not_connected`, { token: ctx.master });
  assert.equal(nc.body.data.length, 2);

  const own = await api("GET", `/call-logs`, { token: ctx.ravi });
  assert.equal(own.body.data.length, 1);

  const bad = await api("GET", `/dashboard?from=2024-02-10&to=2024-02-01`, { token: ctx.master });
  assert.equal(bad.status, 400);

  const hist = await api("GET", `/shops/${ctx.ajithShop.shopId}/calls`, { token: ctx.ajith });
  assert.equal(hist.body.data.calls.length, 3);
  const histForbidden = await api("GET", `/shops/${ctx.ajithShop.shopId}/calls`, { token: ctx.ravi });
  assert.equal(histForbidden.status, 403);
});

test("reassign shop, deactivate & reset salesman", async () => {
  const r = await api("PATCH", `/shops/${ctx.raviShop.shopId}`, { token: ctx.master, body: { salesmanUid: ctx.ajith } });
  assert.equal(r.body.data.salesmanName, "Ajith");
  const ajithShops = await api("GET", "/shops", { token: ctx.ajith });
  assert.equal(ajithShops.body.data.length, 3);

  const d = await api("PATCH", `/salesmen/${ctx.ravi}`, { token: ctx.master, body: { active: false } });
  assert.equal(d.body.data.active, false);
  const blocked = await api("GET", "/shops", { token: ctx.ravi });
  assert.equal(blocked.status, 403);

  const reset = await api("POST", `/salesmen/${ctx.ajith}/reset-password`, { token: ctx.master });
  assert.equal(reset.body.data.password, "6789@salesman");

  const cross = await api("PATCH", `/salesmen/${ctx.ajith}`, { token: ctx.otherMaster, body: { active: false } });
  assert.equal(cross.status, 404, "another company's master can't touch our salesmen");

  const list = await api("GET", "/salesmen", { token: ctx.master });
  assert.equal(list.body.data.find((s) => s.name === "Ajith").assignedShops, 3);
});
