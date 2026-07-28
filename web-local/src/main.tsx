import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";
import "./professional-foundation.css";
import "./professional-shell.css";
import "./professional-surfaces.css";
import "./professional-customization.css";
import { App } from "./App";

const platform = window.workspaceDesktop?.app.platform;
if (platform) document.documentElement.dataset.platform = platform;
else delete document.documentElement.dataset.platform;
if (window.workspaceDesktop) document.documentElement.dataset.desktop = "true";
else delete document.documentElement.dataset.desktop;

const windowMaterial = window.workspaceDesktop?.window.material;
if (windowMaterial === "mica" || windowMaterial === "vibrancy") {
  document.documentElement.dataset.windowMaterial = windowMaterial;
} else {
  delete document.documentElement.dataset.windowMaterial;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
