/** Generates templates/shops_upload_template.xlsx  (npm run make-template) */
const path = require("path");
const ExcelJS = require("exceljs");

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Shops");
  ws.columns = [
    { header: "Shop Name", key: "name", width: 30 },
    { header: "Address", key: "address", width: 40 },
    { header: "Phone Number", key: "phone", width: 18 },
    { header: "Salesman Name", key: "salesman", width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getColumn(3).numFmt = "@";
  ws.addRow({ name: "Sri Murugan Stores", address: "12, Gandhi Road, Madurai", phone: "9876543210", salesman: "Ajith" });
  ws.addRow({ name: "Lakshmi Traders", address: "45, Main Bazaar, Trichy", phone: "04312345678", salesman: "Ravi" });

  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "1. Keep the header row exactly as in the Shops sheet (first sheet is the one imported).",
    "2. Phone Number: shop's number. Mobile (10 digits) or landline with STD code.",
    "3. Salesman Name: exactly as the salesman was added in the app (not case-sensitive).",
    "   The shop will be visible ONLY to that salesman.",
    "4. Shops whose phone number already exists are skipped (no duplicates).",
    "5. Delete the two sample rows before uploading.",
  ].forEach((line) => help.addRow([line]));

  const out = path.join(__dirname, "..", "templates", "shops_upload_template.xlsx");
  await wb.xlsx.writeFile(out);
  console.log("wrote", out);
}

main();
