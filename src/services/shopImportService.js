const ExcelJS = require("exceljs");
const { Readable } = require("stream");
const { normalizeMobile, normalizeShopPhone } = require("../utils/phone");

const MAX_ROWS = 5000;

// Header text (lower-cased, letters/digits only) -> field
const HEADER_ALIASES = {
  shopname: "name",
  name: "name",
  shop: "name",
  storename: "name",
  address: "address",
  shopaddress: "address",
  area: "address",
  location: "address",
  phonenumber: "phone",
  phone: "phone",
  phoneno: "phone",
  shopphone: "phone",
  shopmobile: "phone",
  shopnumber: "phone",
  mobile: "phone",
  mobilenumber: "phone",
  contact: "phone",
  contactnumber: "phone",
  salesmanmobile: "salesmanMobile",
  salesmanmobilenumber: "salesmanMobile",
  salesmannumber: "salesmanMobile",
  salesmanphone: "salesmanMobile",
  salespersonmobile: "salesmanMobile",
  salespersonnumber: "salesmanMobile",
  salesmanname: "salesmanName",
  salesman: "salesmanName",
  salesperson: "salesmanName",
  salespersonname: "salesmanName",
};

const normHeader = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** exceljs cell values can be strings, numbers, rich text, formulas, links... */
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("").trim();
  if (value.text !== undefined) return cellText(value.text);
  if (value.result !== undefined) return cellText(value.result);
  return String(value).trim();
}

/**
 * Reads the first worksheet of an .xlsx (or a .csv) buffer. The first row
 * containing a recognised "shop name" column is treated as the header row.
 * Returns { rows: [{ rowNumber, name, address, phone, salesmanMobile, salesmanName }] }.
 */
async function parseShopsFile(buffer, filename = "") {
  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) {
    await workbook.csv.read(Readable.from(buffer.toString("utf-8")));
  } else {
    try {
      await workbook.xlsx.load(buffer);
    } catch {
      const err = new Error("Could not read the file. Upload an .xlsx Excel file (or .csv).");
      err.statusCode = 400;
      throw err;
    }
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const err = new Error("The Excel file has no sheets");
    err.statusCode = 400;
    throw err;
  }

  let headerRowNumber = null;
  let columns = {};
  for (let r = 1; r <= Math.min(sheet.rowCount, 10) && !headerRowNumber; r += 1) {
    const found = {};
    sheet.getRow(r).eachCell((cell, col) => {
      const field = HEADER_ALIASES[normHeader(cellText(cell.value))];
      if (field && !found[field]) found[field] = col;
    });
    if (found.name && found.phone) {
      headerRowNumber = r;
      columns = found;
    }
  }

  if (!headerRowNumber) {
    const err = new Error(
      'Header row not found. The first row must have columns: "Shop Name", "Address", "Phone Number", "Salesman Name"',
    );
    err.statusCode = 400;
    throw err;
  }
  if (!columns.salesmanMobile && !columns.salesmanName) {
    const err = new Error('Add a "Salesman Name" column so each shop can be assigned');
    err.statusCode = 400;
    throw err;
  }

  const rows = [];
  for (let r = headerRowNumber + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const get = (field) => (columns[field] ? cellText(row.getCell(columns[field]).value) : "");
    const record = {
      rowNumber: r,
      name: get("name"),
      address: get("address"),
      phone: get("phone"),
      salesmanMobile: get("salesmanMobile"),
      salesmanName: get("salesmanName"),
    };
    const isBlank = !record.name && !record.phone && !record.address;
    if (!isBlank) rows.push(record);
  }

  if (rows.length > MAX_ROWS) {
    const err = new Error(`Too many rows (${rows.length}). Upload at most ${MAX_ROWS} shops per file.`);
    err.statusCode = 400;
    throw err;
  }
  return { rows };
}

/**
 * Validates parsed rows against the company's salesmen and existing shops.
 * Pure function (no I/O) so it's easy to test.
 *
 * Returns { toCreate: [{ name, address, phoneNumber, salesman }], skipped: [{ row, reason }] }
 */
function planImport(rows, { salesmen, existingShops }) {
  const byMobile = new Map();
  const byName = new Map();
  for (const s of salesmen) {
    if (s.active === false) continue;
    byMobile.set(s.mobile, s);
    const key = String(s.name).trim().toLowerCase();
    byName.set(key, byName.has(key) ? null : s); // null marks an ambiguous name
  }

  const seenPhones = new Set(existingShops.map((s) => s.phoneNumber));
  const toCreate = [];
  const skipped = [];

  for (const row of rows) {
    const skip = (reason) => skipped.push({ row: row.rowNumber, name: row.name, reason });

    if (!row.name) {
      skip("Shop name is empty");
      continue;
    }
    const phoneNumber = normalizeShopPhone(row.phone);
    if (!phoneNumber) {
      skip(`Invalid phone number "${row.phone}"`);
      continue;
    }

    let salesman = null;
    if (row.salesmanName) {
      salesman = byName.get(row.salesmanName.trim().toLowerCase());
      if (!salesman) {
        skip(
          salesman === null
            ? `More than one salesman named "${row.salesmanName}"`
            : `No active salesman named "${row.salesmanName}" — add them in Salesmen first`,
        );
        continue;
      }
    } else if (row.salesmanMobile) {
      // optional fallback column
      const mobile = normalizeMobile(row.salesmanMobile);
      salesman = mobile ? byMobile.get(mobile) : null;
      if (!salesman) {
        skip(`No active salesman with mobile "${row.salesmanMobile}"`);
        continue;
      }
    } else {
      skip("Salesman name is empty");
      continue;
    }

    if (seenPhones.has(phoneNumber)) {
      skip(`Shop with phone ${phoneNumber} already exists`);
      continue;
    }
    seenPhones.add(phoneNumber);
    toCreate.push({ name: row.name, address: row.address, phoneNumber, salesman });
  }

  return { toCreate, skipped };
}

module.exports = { parseShopsFile, planImport, MAX_ROWS };
