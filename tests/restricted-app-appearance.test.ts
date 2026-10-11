import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseRestrictedAppAppearance, restrictedAppAppearanceCss, restrictedAppAppearanceTokens } from "../desktop/src/restricted-app-appearance.js";
import { resolveLightDark } from "../web-local/src/lib/restricted-app-appearance.js";

const root = resolve(import.meta.dirname, "..");

test("app views get only known tokens with plain values; anything else is dropped, not fatal", () => {
  const parsed = parseRestrictedAppAppearance({
    "--wf-accent": "#0d74ce",
    "--wf-accent-soft": "color-mix(in srgb, #0d74ce 18%, #fafbf8)",
    "--wf-font": "\"work-fold Inter\", Inter, system-ui, sans-serif",
    "--wf-shadow": "0 8px 16px rgba(23, 29, 39, 0.14)",
    "--wf-text": "url(https://example.invalid/x)",
    "--wf-surface": "red;}body{display:none",
    "--wf-border": "#000\n}",
    "--wf-danger": "\"unbalanced",
    "--wf-success": "image-set(\"a.png\" 1x)",
    "--not-a-token": "#fff",
  });
  assert.deepEqual(parsed, {
    "--wf-accent": "#0d74ce",
    "--wf-accent-soft": "color-mix(in srgb, #0d74ce 18%, #fafbf8)",
    "--wf-font": "\"work-fold Inter\", Inter, system-ui, sans-serif",
    "--wf-shadow": "0 8px 16px rgba(23, 29, 39, 0.14)",
  });
  assert.throws(() => parseRestrictedAppAppearance("tokens"), /must be an object/);
});

test("the injected CSS is variables and the font only, so it restyles nothing by itself", () => {
  const css = restrictedAppAppearanceCss("dark", { "--wf-accent": "#b1d5ff" });
  assert.match(css, /@font-face\{font-family:"work-fold Inter";[^}]*src:url\("\/__work-fold\/fonts\/inter-latin-wght-normal\.woff2"\)/);
  assert.match(css, /:root\{--wf-theme:dark;--wf-color-scheme:dark;--wf-accent:#b1d5ff;\}$/);
  assert.doesNotMatch(css.replace(/@font-face\{[^}]*\}/g, ""), /(^|[;{])color-scheme:|body|\.wf-/, "no element rules and no color-scheme change");
  assert.ok(restrictedAppAppearanceTokens.every((name) => name.startsWith("--wf-")));
});

test("light-dark pairs are settled for the shell's theme before they reach an app", () => {
  assert.equal(resolveLightDark("light-dark(#0d74ce, #b1d5ff)", "light"), "#0d74ce");
  assert.equal(resolveLightDark("light-dark(#0d74ce, #b1d5ff)", "dark"), "#b1d5ff");
  assert.equal(resolveLightDark("light-dark(rgb(1, 2, 3), rgba(4, 5, 6, 0.5))", "dark"), "rgba(4, 5, 6, 0.5)");
  assert.equal(resolveLightDark("0 0 0 2px light-dark(#fff, #000)", "light"), "0 0 0 2px #fff");
  assert.equal(resolveLightDark("#123456", "dark"), "#123456");
});

test("every kit rule has zero specificity, so an app's own styles always win", async () => {
  const kit = await readFile(resolve(root, "desktop/assets/restricted-app-kit/kit.css"), "utf8");
  const withoutComments = kit.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...withoutComments.matchAll(/(^|})\s*([^@{}][^{}]*)\{/g)].map((match) => match[2]!.trim())
    .filter((selector) => !/^(to|from|\d+%)$/.test(selector) && !selector.startsWith("@"));
  assert.ok(selectors.length > 20);
  for (const selector of selectors) {
    for (const part of selector.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^:where\(/, `kit selector "${part.trim()}" must start with :where()`);
    }
  }
  assert.match(kit, /<link rel="stylesheet" href="\/__work-fold\/kit\.css">/);
});
