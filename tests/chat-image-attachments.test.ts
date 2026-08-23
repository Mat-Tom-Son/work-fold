import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  estimateImageTokens,
  imageAttachmentMimeType,
  loadConversationContextAttachmentsForTurn,
  previewConversationContextAttachment,
} from "../src/local/conversation-context.js";
import { buildTurnContextMessage, turnImages } from "../src/local/agent/pi-client.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("image formats are recognized by extension and magic bytes together", () => {
  assert.equal(imageAttachmentMimeType("shot.png", onePixelPng), "image/png");
  assert.equal(imageAttachmentMimeType("shot.PNG", onePixelPng), "image/png");
  assert.equal(imageAttachmentMimeType("shot.jpg", onePixelPng), null, "a PNG renamed .jpg is not trusted");
  assert.equal(imageAttachmentMimeType("notes.txt", onePixelPng), null);
  assert.equal(imageAttachmentMimeType("shot.png", Buffer.from("not an image")), null);
  assert.equal(imageAttachmentMimeType("photo.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(imageAttachmentMimeType("anim.gif", Buffer.from("GIF89a......")), "image/gif");
  assert.equal(imageAttachmentMimeType("pic.webp", Buffer.from("RIFF....WEBPVP8 ")), "image/webp");
  assert.equal(estimateImageTokens(1, 1), 85);
  assert.equal(estimateImageTokens(1500, 1500), 3000);
});

test("an attached image reaches the model as image content and is described in the turn context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "space-image-attachment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Dropped"), { recursive: true });
  await writeFile(join(root, "Dropped", "screenshot.png"), onePixelPng);
  await writeFile(join(root, "Dropped", "fake.png"), "this is text pretending to be an image");
  await writeFile(join(root, "notes.md"), "# Notes\n");

  const loaded = await loadConversationContextAttachmentsForTurn(root, ["Dropped/screenshot.png", "Dropped/fake.png", "notes.md"]);
  const image = loaded[0]!;
  assert.equal(image.mode, "image");
  assert.equal(image.includedInPrompt, true);
  assert.equal(image.userLabel, "Image");
  assert.equal(image.text, null);
  assert.equal(image.image?.mimeType, "image/png");
  assert.equal(image.image?.width, 1);
  assert.equal(image.image?.height, 1);
  assert.ok(image.image?.data && Buffer.from(image.image.data, "base64").length > 0);
  assert.match(image.detail, /Image attached to this turn \(1×1/);

  const fake = loaded[1]!;
  assert.equal(fake.mode, "full_original_text", "a text file with an image extension is attached as text");

  const notes = loaded[2]!;
  assert.equal(notes.mode, "full_original_text");

  const images = turnImages({ contextAttachments: loaded });
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], { type: "image", data: image.image!.data, mimeType: "image/png" });

  const contextMessage = buildTurnContextMessage({ contextAttachments: loaded });
  assert.match(contextMessage, /Attached Space image: Dropped\/screenshot\.png \(1×1\)/);
  assert.match(contextMessage, /The image itself is included with the user's message/);
  assert.match(contextMessage, /=== Attached Space file: notes\.md ===/);
  assert.doesNotMatch(contextMessage, /iVBORw0KGgo/, "image bytes never ride the text context");

  const preview = await previewConversationContextAttachment(root, { path: "Dropped/screenshot.png" });
  assert.equal(preview.mode, "image");
  assert.equal("image" in preview, false, "previews carry metadata only");
  assert.equal("text" in preview, false);
});
