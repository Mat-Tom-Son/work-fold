import { writeFile } from "node:fs/promises";

export default async ({ libraries, resolve, readPdf, renderPdf, emitImage }) => {
  const { Document, Packer, Paragraph } = libraries.docx;
  await writeFile(resolve("launch-plan.docx"), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Launch plan")] }] })));
  const workbook = new libraries.ExcelJS.Workbook();
  workbook.addWorksheet("Budget").getCell("A1").value = 84;
  await workbook.xlsx.writeFile(resolve("budget.xlsx"));
  const deck = new libraries.PptxGenJS();
  deck.addSlide().addText("Launch plan", { x: 1, y: 1, w: 8, h: 1 });
  await deck.writeFile({ fileName: resolve("launch-plan.pptx") });
  const pdf = await libraries.pdfLib.PDFDocument.create();
  const { rgb, StandardFonts } = libraries.pdfLib;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.98, 0.98, 0.96) });
  page.drawText("WORK-FOLD / DOCUMENT RUNTIME", { x: 48, y: 736, size: 10, font: bold, color: rgb(0.1, 0.4, 0.4) });
  page.drawText("Launch plan", { x: 48, y: 676, size: 36, font: bold, color: rgb(0.1, 0.15, 0.2) });
  page.drawText("A portable document, created and checked locally.", { x: 48, y: 643, size: 14, font });
  page.drawLine({ start: { x: 48, y: 615 }, end: { x: 564, y: 615 }, thickness: 1, color: rgb(0.75, 0.8, 0.8) });
  for (const [index, [heading, text]] of [
    ["1. Prepare", "Write the brief, budget and presentation as ordinary files."],
    ["2. Verify", "Read the resulting PDF and render selected pages."],
    ["3. Deliver", "Inspect the images and open the files in existing apps."],
  ].entries()) {
    const y = 565 - index * 92;
    page.drawText(heading, { x: 48, y, size: 19, font: bold });
    page.drawText(text, { x: 48, y: y - 27, size: 12, font });
  }
  page.drawText("Budget: $84", { x: 48, y: 200, size: 24, font: bold, color: rgb(0.1, 0.4, 0.4) });
  page.drawText("Verification fixture / no model call / one page", { x: 48, y: 48, size: 10, font });
  await writeFile(resolve("launch-plan.pdf"), await pdf.save());
  const text = await readPdf("launch-plan.pdf", { pages: [1] });
  const render = await renderPdf("launch-plan.pdf", { pages: [1], outputDir: "rendered" });
  await emitImage(render.pages[0].path);
  return { text, render, files: ["launch-plan.docx", "budget.xlsx", "launch-plan.pptx", "launch-plan.pdf"].map(resolve) };
};
