export interface WorkspaceLookOption {
  name: string;
  hint: string;
  primary: string;
  secondary: string;
  bannerName: string;
}

export const workspaceLookOptions = [
  { name: "Graphite", hint: "Quiet neutral", primary: "#4a5058", secondary: "#6b7280", bannerName: "none" },
  { name: "Harbor", hint: "Clear blue", primary: "#0d74ce", secondary: "#0e7490", bannerName: "horizon" },
  { name: "Meridian", hint: "Soft indigo", primary: "#5a4bc4", secondary: "#6550b9", bannerName: "mist" },
  { name: "Verdigris", hint: "Technical teal", primary: "#0f766e", secondary: "#0e7490", bannerName: "pinstripe" },
  { name: "Orchard", hint: "Organic green", primary: "#1a7f37", secondary: "#5c7c2e", bannerName: "halftone" },
  { name: "Kiln", hint: "Warm clay", primary: "#a85a1a", secondary: "#7a3f22", bannerName: "ribbon" },
  { name: "Ember", hint: "Expressive heat", primary: "#c62d38", secondary: "#cc4e00", bannerName: "aurora" },
  { name: "Foxglove", hint: "Soft plum", primary: "#b5348c", secondary: "#953ea3", bannerName: "mist" },
] as const satisfies readonly WorkspaceLookOption[];
