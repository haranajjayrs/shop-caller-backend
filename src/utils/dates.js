/**
 * All business dates are Indian dates (Asia/Kolkata) in "yyyy-mm-dd" form.
 * Timestamps are stored as UTC ISO strings (Date#toISOString), which sort
 * correctly as strings — that's what the DynamoDB range queries rely on.
 */
const IST_OFFSET = "+05:30";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function istDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
}

function isValidDateKey(value) {
  if (!DATE_RE.test(String(value))) return false;
  const d = new Date(`${value}T00:00:00${IST_OFFSET}`);
  return !Number.isNaN(d.getTime()) && istDateKey(d) === value;
}

/** Start of an IST day as a UTC ISO string. */
function istDayStartIso(dateKey) {
  return new Date(`${dateKey}T00:00:00.000${IST_OFFSET}`).toISOString();
}

/** End of an IST day (inclusive) as a UTC ISO string. */
function istDayEndIso(dateKey) {
  return new Date(`${dateKey}T23:59:59.999${IST_OFFSET}`).toISOString();
}

/** Every IST date key between from and to (inclusive). */
function eachDateKey(from, to) {
  const out = [];
  let cursor = new Date(`${from}T12:00:00${IST_OFFSET}`);
  const end = new Date(`${to}T12:00:00${IST_OFFSET}`);
  while (cursor <= end && out.length < 400) {
    out.push(istDateKey(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

/**
 * Accepts "yyyy-mm-dd" (preferred) or legacy "dd/mm/yyyy"; returns
 * "yyyy-mm-dd" or null.
 */
function parseDateKey(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (isValidDateKey(s)) return s;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) {
    const key = `${m[3]}-${m[2]}-${m[1]}`;
    return isValidDateKey(key) ? key : null;
  }
  return null;
}

/**
 * Resolves ?from=&to= query params into a validated IST range. Defaults to
 * today. Caps the range at 366 days.
 */
function resolveRange(query = {}) {
  const today = istDateKey();
  const from = query.from ? parseDateKey(query.from) : today;
  const to = query.to ? parseDateKey(query.to) : from > today ? from : today;
  if (!from || !to) {
    const err = new Error("from/to must be yyyy-mm-dd");
    err.statusCode = 400;
    throw err;
  }
  if (from > to) {
    const err = new Error("from must be on or before to");
    err.statusCode = 400;
    throw err;
  }
  if (eachDateKey(from, to).length > 366) {
    const err = new Error("Date range cannot be more than 366 days");
    err.statusCode = 400;
    throw err;
  }
  return { from, to, startIso: istDayStartIso(from), endIso: istDayEndIso(to) };
}

module.exports = {
  istDateKey,
  isValidDateKey,
  istDayStartIso,
  istDayEndIso,
  eachDateKey,
  parseDateKey,
  resolveRange,
};
