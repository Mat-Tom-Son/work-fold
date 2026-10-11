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
import { App } from "./App";
import { ModelContextInspector } from "./components/chat/ModelContextInspector";
import { migrateRendererStorage } from "./lib/storage-migration";

// Before any component reads a saved tab, draft, or preference.
migrateRendererStorage();

const platform = window.workFoldDesktop?.app.platform;
if (platform) document.documentElement.dataset.platform = platform;
else delete document.documentElement.dataset.platform;
if (window.workFoldDesktop) document.documentElement.dataset.desktop = "true";
else delete document.documentElement.dataset.desktop;

const windowMaterial = window.workFoldDesktop?.window.material;
if (windowMaterial === "mica" || windowMaterial === "vibrancy") {
  document.documentElement.dataset.windowMaterial = windowMaterial;
} else {
  delete document.documentElement.dataset.windowMaterial;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has("dev-context")
      ? <ModelContextInspector onClose={() => { window.location.search = ""; }} />
      : <App />}
  </React.StrictMode>,
);
