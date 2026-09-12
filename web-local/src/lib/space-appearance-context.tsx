import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { applicationPalettes, type ApplicationAppearance } from "../../../src/shared/application-appearance";
import type { ResolverGround, SpaceAppearanceMode } from "../../../src/shared/space-appearance";
import { spaceIdentityFor } from "./space-identity";
import type { SpaceCustomizationMap, SpaceSummary } from "../types";

type Grounds = Record<SpaceAppearanceMode, ResolverGround>;
const SpaceAppearanceGrounds = createContext<Grounds | undefined>(undefined);

export function applicationSpaceGrounds(palette: ApplicationAppearance["palette"]): Grounds {
  const chosen = applicationPalettes[palette];
  return {
    light: { mode: "light", surface: chosen.light.surface, canvas: chosen.light.canvas, softAlpha: 0.13 },
    dark: { mode: "dark", surface: chosen.dark.surface, canvas: chosen.dark.canvas, softAlpha: 0.13 },
  };
}

export function SpaceAppearanceProvider({ palette, children }: { palette: ApplicationAppearance["palette"]; children: ReactNode }) {
  const grounds = useMemo(() => applicationSpaceGrounds(palette), [palette]);
  return <SpaceAppearanceGrounds.Provider value={grounds}>{children}</SpaceAppearanceGrounds.Provider>;
}

/** Resolve the same saved identity against this renderer's current surfaces. */
export function useSpaceIdentityResolver() {
  const grounds = useContext(SpaceAppearanceGrounds);
  return useCallback((space: SpaceSummary, customizations: SpaceCustomizationMap) => spaceIdentityFor(space, customizations, grounds), [grounds]);
}
