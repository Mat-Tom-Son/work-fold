import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { IconCredits } from "../web-local/src/components/modals/IconCredits.js";

const require = createRequire(import.meta.url);

test("distributed icon artwork has accessible credits and matching packaged notices", async () => {
  const notices = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const builder = require("../electron-builder.desktop.cjs");
  assert.ok(builder.files.includes("THIRD_PARTY_NOTICES.md"), "installer must carry artwork notices");
  const document = new JSDOM(renderToStaticMarkup(createElement(IconCredits))).window.document;
  const disclosure = document.querySelector("details");
  assert.ok(disclosure);
  assert.equal(disclosure.open, false);
  assert.equal(disclosure.querySelector("summary")?.textContent, "Icon Credits");
  assert.match(disclosure.textContent ?? "", /Arcticons Team and contributors/);
  assert.match(disclosure.textContent ?? "", /Boxicons/);
  assert.match(disclosure.textContent ?? "", /adaptations remain under CC BY-SA 4\.0/);
  const links = [...disclosure.querySelectorAll("a")];
  for (const license of ["https://creativecommons.org/licenses/by-sa/4.0/", "https://creativecommons.org/licenses/by/4.0/"]) {
    assert.ok(links.some(link => link.href === license), `missing visible license link: ${license}`);
  }
  for (const link of links) {
    assert.ok(notices.includes(link.href), `packaged notices must preserve credit source ${link.href}`);
    assert.equal(link.target, "_blank");
    assert.ok(link.relList.contains("noreferrer"));
  }
});
