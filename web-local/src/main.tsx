import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "./brand.css";
import "./styles.css";
import "./professional-foundation.css";
import "./professional-shell.css";
import "./professional-surfaces.css";
import "./professional-customization.css";
import { App } from "./App";

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
    <App />
  </React.StrictMode>,
);
