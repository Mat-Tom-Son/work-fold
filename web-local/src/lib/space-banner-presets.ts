import type { SpaceAppearanceBannerPresetId } from "../../../src/shared/space-appearance";

export const spaceBannerPresets = [
  { id: "tide", label: "Tide", image: new URL("../assets/banners/tide.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/tide-thumb.webp", import.meta.url).href },
  { id: "ember", label: "Ember", image: new URL("../assets/banners/ember.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/ember-thumb.webp", import.meta.url).href },
  { id: "fold", label: "Fold", image: new URL("../assets/banners/fold.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/fold-thumb.webp", import.meta.url).href },
  { id: "dusk", label: "Dusk", image: new URL("../assets/banners/dusk.webp", import.meta.url).href, thumbnail: new URL("../assets/banners/dusk-thumb.webp", import.meta.url).href },
] as const satisfies ReadonlyArray<{ id: SpaceAppearanceBannerPresetId; label: string; image: string; thumbnail: string }>;

export function spaceBannerPresetFor(id: unknown) {
  return spaceBannerPresets.find((preset) => preset.id === id);
}
