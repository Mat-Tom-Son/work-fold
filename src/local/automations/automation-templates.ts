import {
  automationTemplateAutomationId,
  automationTemplates,
  type AutomationTemplateId,
} from "../../shared/automation-templates.js";
import {
  normalizeWorkFoldAutomationDeclaration,
  workFoldAutomationDigest,
  type WorkFoldAutomationDeclaration,
} from "./automation-declarations.js";

/**
 * The declarations behind the ready-made Automations
 * (src/shared/automation-templates.ts). Each is one Chat step to the
 * work-folder's own Worker on a fixed trigger, written in plain words and
 * telling the Worker never to delete anything; every change it makes is under
 * the Chat's own History restore points.
 */
const documentAndMediaExtensions = [
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx", ".key", ".numbers", ".pages",
  ".txt", ".md", ".rtf", ".json", ".html", ".epub", ".ics", ".vcf", ".eml",
  ".png", ".jpg", ".jpeg", ".heic", ".gif", ".webp", ".tiff", ".svg",
  ".mp3", ".m4a", ".wav", ".mp4", ".mov",
  ".zip", ".dmg", ".pkg",
];
const pictureExtensions = [".png", ".jpg", ".jpeg", ".heic", ".gif", ".webp", ".tiff"];

const topLevelArrivals = (workFolder: string, extensions: readonly string[], debounceSeconds: number, cooldownMinutes: number) => ({
  kind: "files-changed",
  workFolder,
  watch: { kind: "tree", path: "", recursive: false, extensions: [...extensions] },
  debounceSeconds,
  cooldownMinutes,
  // Files that land while work-fold is closed are handled once it is back.
  ifMissed: "run",
});

const messages: Record<AutomationTemplateId, string> = {
  "organize-new-files": [
    "New files came into this folder:",
    "{{trigger.changedFiles}}",
    "",
    "Move each one into the subfolder where it belongs. Use the folders that are already here, and make a new folder only when several files clearly belong together. If you aren't sure where a file goes, leave it where it is. Don't rename, change, or delete any file. When you're done, report what you moved and where.",
  ].join("\n"),
  "name-new-files": [
    "New files came into this folder:",
    "{{trigger.changedFiles}}",
    "",
    "If any of them has a name that doesn't say what it is, such as IMG_1234.jpg or document (3).pdf, look at it and rename it to a short, clear name. Keep the extension, and keep names that are already clear. Don't move, change, or delete any file. When you're done, report what you renamed.",
  ].join("\n"),
  screenshots: [
    "New pictures came into this folder:",
    "{{trigger.changedFiles}}",
    "",
    "Move the ones that are screenshots into a folder named Screenshots at the top of this folder, making it if it isn't there. Leave other pictures where they are. Don't rename, change, or delete any file. When you're done, report what you moved.",
  ].join("\n"),
  "weekly-tidy": "Tidy up this folder. Move loose files at the top into the subfolders where they belong, using the folders that are already here. If two files are exact duplicates, move the extra copy into a folder named Duplicates. Tell me about empty folders but leave them. Don't rename, change, or delete any file. When you're done, report what you moved.",
};

function trigger(templateId: AutomationTemplateId, workFolderId: string): unknown {
  if (templateId === "organize-new-files" || templateId === "name-new-files") return topLevelArrivals(workFolderId, documentAndMediaExtensions, 30, 5);
  if (templateId === "screenshots") return topLevelArrivals(workFolderId, pictureExtensions, 10, 1);
  return { kind: "interval", intervalMinutes: 7 * 24 * 60 };
}

/** The declaration a ready-made Automation turns on as in one work-folder, and the digest enabling pins. */
export function automationTemplateDeclaration(
  templateId: AutomationTemplateId,
  workFolderId: string,
  now = new Date(),
): { declaration: WorkFoldAutomationDeclaration; digest: string } {
  const template = automationTemplates.find((item) => item.id === templateId);
  if (!template) throw new Error("That ready-made Automation doesn't exist.");
  const declaration = normalizeWorkFoldAutomationDeclaration({
    kind: "work-fold.automation",
    version: 6,
    id: automationTemplateAutomationId(templateId, workFolderId),
    title: template.title,
    trigger: trigger(templateId, workFolderId),
    steps: [{ id: "worker", kind: "chat", workFolder: workFolderId, message: messages[templateId] }],
    createdBy: "human",
    createdAt: now.toISOString(),
  });
  return { declaration, digest: workFoldAutomationDigest(declaration) };
}
