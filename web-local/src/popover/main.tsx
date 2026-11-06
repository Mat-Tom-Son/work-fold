import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "../brand.css";
import "./popover.css";
import "./popover-document.css";
import "../components/chat/work-steps.css";
import "../../../services/bridge/public/work-request.css";
import "../../../services/bridge/public/extension-questions.css";
import "../components/chat/model-context-inspector.css";
import "../application-appearance.css";
import { desktopPlatform, previewPlatform } from "../lib/platform";
import { PopoverApp } from "./PopoverApp";

const platform = desktopPlatform();
if (platform) document.documentElement.dataset.platform = platform;
if (window.workFoldDesktop) document.documentElement.dataset.desktop = "true";
// The inert preview imitates the Mac popover; popover-document.css draws its material.
const previewWindow = previewPlatform() === "darwin";
if (previewWindow) document.documentElement.dataset.previewWindow = "mac";
const windowMaterial = window.workFoldDesktop?.window.material ?? (previewWindow ? "vibrancy" : undefined);
if (windowMaterial === "vibrancy") document.documentElement.dataset.windowMaterial = windowMaterial;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PopoverApp />
  </React.StrictMode>,
);
