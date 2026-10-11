export interface ModelSelection {
  provider: string;
  id: string;
}

export function resolveModelSelection(
  models: ModelSelection[],
  provider: string,
  currentModel: string,
): string {
  const providerModels = models.filter((item) => item.provider === provider);
  return providerModels.some((item) => item.id === currentModel)
    ? currentModel
    : providerModels[0]?.id ?? "";
}
