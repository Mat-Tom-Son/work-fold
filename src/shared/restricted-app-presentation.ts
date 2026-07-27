export const restrictedAppDefaultCornerRadius = 12;
export const restrictedAppMaximumCornerRadius = 24;

export function resolveRestrictedAppCornerRadius(cornerRadius: number | undefined): number {
  return cornerRadius ?? restrictedAppDefaultCornerRadius;
}
