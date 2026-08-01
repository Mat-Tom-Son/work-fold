import React from "react";
import ReactDOM from "react-dom/client";

import "../brand.css";
import "./popover.css";
import { PopoverApp } from "./PopoverApp";

const platform = window.workFoldDesktop?.app.platform;
if (platform) document.documentElement.dataset.platform = platform;
if (window.workFoldDesktop) document.documentElement.dataset.desktop = "true";
const windowMaterial = window.workFoldDesktop?.window.material;
if (windowMaterial === "vibrancy") document.documentElement.dataset.windowMaterial = windowMaterial;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PopoverApp />
  </React.StrictMode>,
);
