import type { FolderAutomationView } from "../../../../src/shared/automation-presentation";
import { automationTemplateAutomationId, automationTemplates, type AutomationTemplateId } from "../../../../src/shared/automation-templates";

/** The rows of the Info panel's Automations card (docs/product-model.md, 2026-11-06). */
export interface AutomationCardRow {
  automationId: string;
  title: string;
  description?: string;
  on: boolean;
  templateId?: AutomationTemplateId;
  existing?: FolderAutomationView;
}

/** The folder's own Automations first, then each ready-made one as the Automation it is (or would be) here. */
export function automationCardRows(workFolderId: string, automations: readonly FolderAutomationView[]): AutomationCardRow[] {
  const isOn = (automation: FolderAutomationView | undefined) => automation?.state === "on" || automation?.state === "running";
  const ready = automationTemplates.map((template) => {
    const automationId = automationTemplateAutomationId(template.id, workFolderId);
    const existing = automations.find((automation) => automation.automationId === automationId);
    return { automationId, title: template.title, description: template.description, on: isOn(existing), templateId: template.id, ...(existing ? { existing } : {}) };
  });
  const readyIds = new Set(ready.map((row) => row.automationId));
  const own = automations.filter((automation) => !readyIds.has(automation.automationId))
    .map((automation) => ({ automationId: automation.automationId, title: automation.title, description: automation.triggerSummary, on: isOn(automation), existing: automation }));
  return [...own, ...ready];
}
