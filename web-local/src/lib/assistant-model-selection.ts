export interface AssistantModelSelection {
  provider: string;
  id: string;
}

export function resolveAssistantModelSelection(
  models: AssistantModelSelection[],
  provider: string,
  currentModel: string,
): string {
  const providerModels = models.filter((item) => item.provider === provider);
  return providerModels.some((item) => item.id === currentModel)
    ? currentModel
    : providerModels[0]?.id ?? "";
}
