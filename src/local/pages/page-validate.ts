/**
 * `work-fold pages validate` (docs/pages.md, "For the Worker"): the same
 * checks the page tab shows, as the act lane's stable JSON shape. A page with
 * problems is still a successful check; `valid` says whether it has errors.
 */
import type { WorkFoldActPageValidation, WorkFoldActWorkFolderRef } from "../cli/act-facade.js";
import { analyzePageFolder } from "./page-inspection.js";

export async function validatePageForAct(workFolder: WorkFoldActWorkFolderRef, page: string): Promise<WorkFoldActPageValidation> {
  const analysis = await analyzePageFolder(workFolder.workFolderRoot, page, "check");
  return {
    workFolder,
    page: analysis.page.path,
    valid: !analysis.problems.some((problem) => problem.severity === "error"),
    summary: {
      title: analysis.page.title,
      entry: analysis.page.entry,
      tables: analysis.page.tables.map((table) => ({
        name: table.name,
        columns: table.columns.map((column) => column.name),
        visitors: [...table.visitors],
        limit: table.limit,
      })),
      files: analysis.summary.files,
      bytes: analysis.summary.bytes,
    },
    problems: analysis.problems.map((problem) => ({ file: problem.file, message: problem.message, severity: problem.severity })),
  };
}
