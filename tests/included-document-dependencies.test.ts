import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";

test("reviewed ExcelJS UUID dependency writes and reopens extended conditional formatting", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Budget");
  sheet.addRows([[10], [50], [100]]);
  sheet.addConditionalFormatting({ ref: "A1:A3", rules: [{
    type: "iconSet", iconSet: "5Boxes", priority: 1,
    cfvo: [0, 20, 40, 60, 80].map(value => ({ type: "percent", value })),
  }] });
  const bytes = await workbook.xlsx.writeBuffer();
  const archive = await JSZip.loadAsync(bytes);
  const xml = await archive.file("xl/worksheets/sheet1.xml")!.async("string");
  // ExcelJS uses uuid.v4() in this extended-format writer. Exercise that real
  // consumer across the reviewed 8.x -> 11.1.1 override, including readback.
  assert.match(xml, /<x14:cfRule[^>]*id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/);
  assert.match(xml, /iconSet="5Boxes"/);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(bytes);
  const loaded = reopened.getWorksheet("Budget")!;
  assert.equal(loaded.getCell("A3").value, 100);
  assert.equal(loaded.conditionalFormattings[0]!.rules[0]!.type, "iconSet");
  assert.equal(loaded.conditionalFormattings[0]!.rules[0]!.iconSet, "5Boxes");
});
