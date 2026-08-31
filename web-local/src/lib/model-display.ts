export function displayModelIdentifier(value: string): string {
  const leaf = value.split("/").filter(Boolean).at(-1) ?? value;
  return leaf
    .replace(/[-_]+/g, " ")
    .replace(/\b(?:glm|gpt|ai|api)\b/gi, (part) => part.toUpperCase())
    .replace(/\b\w/g, (part) => part.toUpperCase());
}

export function displayAssistantModelLabel(provider: string, model: string): string {
  const providerLabel = displayModelIdentifier(provider);
  const modelLabel = displayModelIdentifier(model);
  return providerLabel && modelLabel
    ? `${providerLabel} · ${modelLabel}`
    : modelLabel || providerLabel || "Choose model";
}
