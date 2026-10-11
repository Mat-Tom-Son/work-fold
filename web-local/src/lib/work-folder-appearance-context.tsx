import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { applicationPalettes, type ApplicationAppearance } from "../../../src/shared/application-appearance";
import type { ResolverGround, WorkFolderAppearanceMode } from "../../../src/shared/work-folder-appearance";
import { workFolderIdentityFor } from "./work-folder-identity";
import type { WorkFolderCustomizationMap, WorkFolderSummary } from "../types";

type Grounds = Record<WorkFolderAppearanceMode, ResolverGround>;
const WorkFolderAppearanceGrounds = createContext<Grounds | undefined>(undefined);

export function applicationWorkFolderGrounds(palette: ApplicationAppearance["palette"]): Grounds {
  const chosen = applicationPalettes[palette];
  return {
    light: { mode: "light", surface: chosen.light.surface, canvas: chosen.light.canvas, softAlpha: 0.13 },
    dark: { mode: "dark", surface: chosen.dark.surface, canvas: chosen.dark.canvas, softAlpha: 0.13 },
  };
}

export function WorkFolderAppearanceProvider({ palette, children }: { palette: ApplicationAppearance["palette"]; children: ReactNode }) {
  const grounds = useMemo(() => applicationWorkFolderGrounds(palette), [palette]);
  return <WorkFolderAppearanceGrounds.Provider value={grounds}>{children}</WorkFolderAppearanceGrounds.Provider>;
}

/** Resolve the same saved identity against this renderer's current surfaces. */
export function useWorkFolderIdentityResolver() {
  const grounds = useContext(WorkFolderAppearanceGrounds);
  return useCallback((workFolder: WorkFolderSummary, customizations: WorkFolderCustomizationMap) => workFolderIdentityFor(workFolder, customizations, grounds), [grounds]);
}
