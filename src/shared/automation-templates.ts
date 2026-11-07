/**
 * Ready-made Automations (docs/automations.md, "Ready-made Automations",
 * 2026-11-07): a small fixed set a person can turn on for one work-folder from
 * the file manager's Info panel. Each becomes an ordinary Automation with a
 * stable id per work-folder, so turning it off and on again is the same
 * Automation, and Settings → Automations lists it like any other.
 */
export const automationTemplateIds = ["organize-new-files", "name-new-files", "screenshots", "weekly-tidy"] as const;
export type AutomationTemplateId = typeof automationTemplateIds[number];

export interface AutomationTemplateSummary {
  id: AutomationTemplateId;
  title: string;
  /** One sentence for a tooltip: what turning it on does. */
  description: string;
}

export const automationTemplates: readonly AutomationTemplateSummary[] = [
  {
    id: "organize-new-files",
    title: "Organize New Files",
    description: "When files land at the top of this folder, the Worker moves each into the folder where it belongs.",
  },
  {
    id: "name-new-files",
    title: "Give New Files Clear Names",
    description: "When files with unclear names land here, such as IMG_1234 or document (3), the Worker renames them for what they are.",
  },
  {
    id: "screenshots",
    title: "Keep Screenshots Together",
    description: "When a screenshot lands at the top of this folder, the Worker moves it into a Screenshots folder.",
  },
  {
    id: "weekly-tidy",
    title: "Weekly Tidy-Up",
    description: "Once a week the Worker files loose files and gathers duplicates and empty folders, without deleting anything.",
  },
];

export function isAutomationTemplateId(value: unknown): value is AutomationTemplateId {
  return typeof value === "string" && (automationTemplateIds as readonly string[]).includes(value);
}

/**
 * The Automation id a ready-made Automation has in one work-folder. work-folder
 * ids are opaque lowercase `space-<16 hex>` values, so the id stays within the
 * Automation id pattern.
 */
export function automationTemplateAutomationId(templateId: AutomationTemplateId, workFolderId: string): string {
  const folder = workFolderId.toLocaleLowerCase("en-US").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return `automation-ready-${templateId}-${folder}`;
}
