import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { workFoldToolFeedbackGuide } from "../src/local/agent/tool-feedback-guide.js";
import {
  workFolderOperationsGuideForScope,
  workFoldWorkFolderOperationsGuide,
  workFoldWorkFolderOperationsGuideHeading,
  workFoldWorkerWorkingFilesGuide,
  workFolderPagesGuide,
} from "../src/local/agent/work-folder-operations-guide.js";

/**
 * The operations guide reaches a work-folder Chat's real Pi session as a system
 * prompt appendix, after the person's work-folder instructions, the way those are
 * appended (docs/collaboration-contract.md, F26). No model is contacted:
 * building the session composes the prompt without a turn.
 */
test("a work-folder Chat's system prompt carries work-folder instructions and then the operations guide", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-guide-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workFolderRoot = join(root, "work-folder");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(workFolderRoot, { recursive: true });
  const provider = {
    async resolveRuntime() {
      return { agentDir, workerInstructions: "Prefer short answers." };
    },
  };

  const guided = new PiConversationClient("guide", workFolderRoot, provider, undefined, {
    operationsGuide: workFolderOperationsGuideForScope("work-folder-1")!,
  });
  t.after(() => guided.stop());
  await guided.getCatalog();
  const appended = sessionAppendix(guided);
  assert.equal(appended.length, 4, "work-folder instructions, operations, working files, and shared tool feedback guidance");
  assert.match(appended[0]!, /^## Worker instructions\n\nPrefer short answers\.$/);
  assert.ok(appended[1]!.startsWith(workFoldWorkFolderOperationsGuideHeading));
  assert.equal(appended[2], workFoldWorkerWorkingFilesGuide);
  assert.equal(appended[3], workFoldToolFeedbackGuide);

  const unguided = new PiConversationClient("plain", workFolderRoot, provider);
  t.after(() => unguided.stop());
  await unguided.getCatalog();
  const plain = sessionAppendix(unguided);
  assert.equal(plain.length, 2, "management also receives shared tool feedback guidance without work-folder operations");
  assert.match(plain[0]!, /^## Worker instructions/);
  assert.equal(plain[1], workFoldToolFeedbackGuide);
  assert.doesNotMatch(plain.join("\n"), /Worker working files/);

  // The guide is a session appendix; nothing new is written into the work-folder's folder.
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(workFolderRoot), []);
});

/**
 * What the guide teaches has to be what the host does. Two rules cost a work-folder
 * Agent a refused command or a false boundary if the text drifts:
 * `chat answer` names the ASKING work-folder, not this one (src/local/server.ts
 * refuses any other), and `chat wait` returns the destination turn's own
 * latest reply and the selected request result.
 */
test("the guide teaches the two rules the host actually enforces", () => {
  const guide = workFoldWorkFolderOperationsGuide();

  // `--work-folder` is this work-folder's id everywhere except `chat answer`.
  assert.match(guide, /child result\/wait and answer reads name the owning work-folder/);
  assert.match(guide, /chat answer --work-folder <the work-folder that asked>/);
  assert.match(guide, /Name the asking work-folder, never your own/);
  assert.doesNotMatch(guide, /chat answer --work-folder <id>/, "the answer verb never shows the caller's own id");

  // `chat wait` does not promise a filter the built path does not apply.
  assert.doesNotMatch(guide, /never its Chat/);
  assert.match(guide, /completion returns the latest reply and selected result/);

});

/**
 * Pages (docs/pages.md) are taught in the Worker's guide: what makes a page
 * rather than an app, the page folder and page.json, the calls and the form
 * helper, the no-network rule, the recipes, and the validate verb a Worker
 * finishes with. Publishing is a later stage, so the guide never offers it,
 * and the retired single-file sharing is gone.
 */
test("the guide teaches pages: page.json, workFoldPage, the form helper, no network, and pages validate", () => {
  const guide = workFoldWorkFolderOperationsGuide();
  const section = workFolderPagesGuide().join("\n");
  assert.ok(guide.includes(section), "the operations guide carries the pages section");
  assert.ok(section.startsWith("### Pages\n"));

  // When to make a page, and when an app.
  assert.match(section, /A page is something other people will open on the web: a form, sign-up sheet, RSVP, poll, or announcement\./);
  assert.match(section, /Sharing a document means making a page from it\./);
  assert.match(section, /An app is a tool for the person inside work-fold that uses their files, a Worker, notifications, or connections\./);

  // The folder, page.json, and its compact example.
  assert.match(section, /`format` is exactly `work-fold\.page\/1`/);
  const example = section.match(/`page\.json`, for example: `(\{.*?\})`\./)?.[1];
  assert.ok(example, "the guide carries one compact page.json example");
  const parsed = JSON.parse(example) as { format: string; title: string; tables: Record<string, { columns: object; visitors: string[]; limit: number }> };
  assert.equal(parsed.format, "work-fold.page/1");
  assert.deepEqual(Object.keys(parsed.tables), ["signups"]);
  assert.deepEqual(parsed.tables.signups!.visitors, ["add", "see-own"]);
  for (const type of ["text", "long-text", "number", "boolean", "date", "email", "url", "choice"]) {
    assert.ok(section.includes(`\`${type}\``), `the guide names the ${type} column type`);
  }
  for (const permission of ["add", "see-own", "see-all", "edit-own", "delete-own"]) {
    assert.ok(section.includes(`\`${permission}\``), `the guide names the ${permission} visitor permission`);
  }
  assert.match(section, /never put private files, notes, or source documents there/);
  assert.match(section, /never one inside another/);

  // The calls, the refusal codes, and the form helper.
  assert.match(section, /Page scripts use `window\.workFoldPage`; every call returns a promise/);
  for (const call of ["add(table, values)", "mine(table)", "list(table, {limit, newestFirst})", "count(table, where?)", "update(table, id, values)", "remove(table, id)", "isOwner()", "onChange(callback)"]) {
    assert.ok(section.includes(`\`${call}\``), `the guide names ${call}`);
  }
  for (const code of ["NOT_ALLOWED", "INVALID", "DUPLICATE", "LIMIT_REACHED", "NOT_FOUND", "TOO_LARGE", "UNAVAILABLE"]) {
    assert.ok(section.includes(`\`${code}\``), `the guide names the ${code} refusal`);
  }
  assert.match(section, /`<form data-page-table="signups">` saves itself on submit/);
  assert.match(section, /`data-page-state` becomes `sending`, then `sent` or `error`/);
  assert.match(section, /`data-page-message` shows the error/);
  assert.match(section, /`page:sent` \(detail: the new row\) or `page:error`/);

  // What a page cannot do.
  assert.match(section, /No network: never load a script, style, font, or image from an `http:`, `https:`, or `\/\/` address\./);
  assert.match(section, /Save any library, font, or image into the page folder/);
  assert.match(section, /`fetch` reaches nothing, the page's own files included/);
  assert.match(section, /Only the entry HTML is a page/);
  assert.match(section, /Save data only through declared tables/);

  // The recipes.
  assert.match(section, /RSVP with a guest cap: set the table's `limit`, show `count\(table\)`/);
  assert.match(section, /Sign-up sheet, one slot per person/);
  assert.match(section, /Poll with live counts: a `choice` column, `count\(table, \{answer: option\}\)`/);
  assert.match(section, /Announcement: a `page\.json` with just `format` and `title`, no tables/);

  // Finish with validate, then point the person at the page tab.
  assert.match(section, /Finish by running `work-fold pages validate --work-folder <id> --page <path> --json`/);
  assert.match(section, /fixing every problem it reports/);
  assert.match(section, /open the page from Files to try it: Preview runs it, Viewing as switches between Visitor, Owner, and New visitor, and the Data view shows the test entries/);
  assert.ok(workFoldWorkFolderOperationsGuide("wf").includes("`wf pages validate --work-folder <id>"), "the executable name substitutes");

  // Publishing is not offered, and the retired single-file sharing is gone.
  assert.match(section, /Pages can't be published yet/);
  assert.doesNotMatch(guide, /Pages the person may share|shareable HTML|sharing pages|shares it from the file's tab/);
  assert.doesNotMatch(section, /\bpublish (it|the page|a page)\b|Publish →|Copy link/i);
});

function sessionAppendix(client: PiConversationClient): string[] {
  const session = (client as unknown as { session: { resourceLoader: { getAppendSystemPrompt(): string[] } } }).session;
  return session.resourceLoader.getAppendSystemPrompt();
}
