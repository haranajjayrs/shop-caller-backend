/**
 * Indian mobile number -> 10 digits. Accepts "+91 98765 43210",
 * "919876543210", "09876543210", "9876543210". Returns null if it isn't a
 * valid 10-digit mobile.
 */
function normalizeMobile(input) {
  if (input === undefined || input === null) return null;
  let digits = String(input).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * Shop phone numbers may be landlines (with STD code), so they're more
 * lenient than mobiles: keep digits only (and a leading +), 6–15 digits.
 * Mobiles are still normalised to 10 digits so duplicates are detected.
 */
function normalizeShopPhone(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  const mobile = normalizeMobile(raw);
  if (mobile) return mobile;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return null;
  return digits;
}

/** Default salesman password: last four digits of mobile + "@salesman". */
function defaultSalesmanPassword(mobile10) {
  return `${mobile10.slice(-4)}@salesman`;
}

function salesmanEmail(mobile10) {
  const domain = process.env.SALESMAN_EMAIL_DOMAIN || "salesman.shopcaller.app";
  return `${mobile10}@${domain}`;
}

module.exports = {
  normalizeMobile,
  normalizeShopPhone,
  defaultSalesmanPassword,
  salesmanEmail,
};
