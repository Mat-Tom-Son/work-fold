import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "./brand.css";
import "./styles.css";
import "./components/chat/work-steps.css";
import "../../services/bridge/public/work-request.css";
import "../../services/bridge/public/extension-questions.css";
import "./components/chat/model-context-inspector.css";
import "./popover/popover.css";
import "./panels.css";
import "./application-appearance.css";
import "./motion.css";
import { App } from "./App";
import { ModelContextInspector } from "./components/chat/ModelContextInspector";
import { startExitMotion } from "./lib/motion";
import { desktopPlatform, previewPlatform } from "./lib/platform";
import { migrateRendererStorage } from "./lib/storage-migration";

// Before any component reads a saved tab, draft, or preference.
migrateRendererStorage();

const platform = desktopPlatform();
if (platform) document.documentElement.dataset.platform = platform;
else delete document.documentElement.dataset.platform;
if (window.workFoldDesktop) document.documentElement.dataset.desktop = "true";
else delete document.documentElement.dataset.desktop;
// The inert previews imitate the Mac window; panels.css draws its material and buttons.
const previewWindow = previewPlatform() === "darwin";
if (previewWindow) document.documentElement.dataset.previewWindow = "mac";
else delete document.documentElement.dataset.previewWindow;

const windowMaterial = window.workFoldDesktop?.window.material ?? (previewWindow ? "vibrancy" : undefined);
if (windowMaterial === "mica" || windowMaterial === "vibrancy") {
  document.documentElement.dataset.windowMaterial = windowMaterial;
} else {
  delete document.documentElement.dataset.windowMaterial;
}

startExitMotion();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has("dev-context")
      ? <ModelContextInspector onClose={() => { window.location.search = ""; }} />
      : <App />}
  </React.StrictMode>,
);
