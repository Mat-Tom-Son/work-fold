import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  WORKFOLD_PUBLICATION_HTML_MAX_SOURCE_BYTES,
  WorkFoldPublicationHtmlTooLargeError,
  isDangerousValue,
  renderInertHtmlDocument,
  stripPublicationHtml,
} from "../src/local/publication-html.js";

/**
 * The output invariant the strip promises: every `<` opens a tag the strip
 * wrote, no script-capable element or handler survives, and no attribute
 * carries a script URL. Checked on every case below.
 */
function assertInert(output: string): void {
  assert.doesNotMatch(output, /<\s*\/?\s*(script|iframe|object|embed|applet|base|link|form|noscript|frame|frameset|xmp|plaintext|noembed|noframes|animate|set)\b/i);
  assert.doesNotMatch(output, /<!--|<!\[CDATA\[|<\?/);
  assert.doesNotMatch(output, /<meta[^>]*http-equiv/i);
  // Values never hold a raw `>`, so each tag runs to its first `>`.
  for (const [tag] of output.matchAll(/<[a-z][^>]*>/g)) {
    for (const [, name, value] of tag.matchAll(/\s([a-z_:][a-z0-9_:.-]*)(?:="([^"]*)")?/g)) {
      assert.doesNotMatch(name!, /^(on|srcdoc$|formaction$|formtarget$|ping$)/, `attribute ${name} in ${tag}`);
      if (value !== undefined) assert.doesNotMatch(value, /^\s*(javascript|vbscript):|^data:text\/html/i, `value in ${tag}`);
    }
  }
  // Every `<` starts a well-formed tag the strip wrote.
  for (const match of output.matchAll(/</g)) {
    const rest = output.slice(match.index);
    assert.match(rest, /^<(\/?[a-z][a-z0-9-]*(\s[a-z_:][a-z0-9_:.-]*(="[^"<>]*")?)*\/?>|!DOCTYPE html>)/, `stray < at ${match.index}: ${rest.slice(0, 40)}`);
  }
}

function strip(source: string): string {
  const output = stripPublicationHtml(source);
  assertInert(output);
  return output;
}

test("script elements go with their content, whatever the casing or spacing", () => {
  assert.equal(strip("<p>a</p><script>alert(1)</script><p>b</p>"), "<p>a</p><p>b</p>");
  assert.equal(strip("<SCRIPT type=text/javascript>alert(1)</SCRIPT >x"), "x");
  assert.equal(strip("<ScRiPt\n src=//evil.example/x.js></sCrIpT\t>after"), "after");
  assert.equal(strip("<script>if (a < b) { '</scr' + 'ipt>' }</script>ok"), "ok");
  assert.equal(strip("<script>never closed <p>gone</p>"), "", "an unclosed script swallows the rest, as a browser does");
  assert.equal(strip("<script/>tail</script>after"), "after");
  assert.equal(strip("<scriptx>kept</scriptx>"), "<scriptx>kept</scriptx>", "a different element name is not a script");
});

test("nested and split script tags cannot reassemble", () => {
  const nested = strip("<scr<script>ipt>alert(1)</script>");
  assert.doesNotMatch(nested, /<script/i);
  assert.equal(nested, "ipt&gt;alert(1)");
  assert.doesNotMatch(strip("<<script>script>alert(1)<</script>/script>"), /<script/i);
  assert.doesNotMatch(strip("<scri<!-- -->pt>alert(1)</script>"), /<script/i);
  assert.equal(strip("<script><!--<script></script>alert(1)</script>tail"), "alert(1)tail", "leftover script text is only ever text");
});

test("event handlers go in every quote style and spelling", () => {
  assert.equal(strip("<img src=\"a.png\" onload=\"alert(1)\">"), "<img src=\"a.png\">");
  assert.equal(strip("<img src=a.png onload='alert(1)'>"), "<img src=\"a.png\">");
  assert.equal(strip("<img src=a.png onload=alert(1)>"), "<img src=\"a.png\">");
  assert.equal(strip("<img src=a.png ONERROR = \"alert(1)\">"), "<img src=\"a.png\">");
  assert.equal(strip("<img/src=a.png/onerror=alert(1)>"), "<img src=\"a.png/onerror=alert(1)\">", "an unquoted value runs to whitespace, as a browser reads it");
  assert.equal(strip("<body onload=alert(1) class=page>"), "<body class=\"page\">");
  assert.equal(strip("<div title=\"x\"onmouseover=\"alert(1)\">"), "<div title=\"x\">");
  assert.equal(strip("<details open ontoggle=alert(1)>"), "<details open>");
  assert.equal(strip("<img =onerror=alert(1) src=a.png>"), "<img src=\"a.png\">", "an odd attribute name is dropped, not repaired");
  assert.equal(strip("<p title='a \" onclick=\"alert(1)'>x</p>"), "<p title=\"a &quot; onclick=&quot;alert(1)\">x</p>", "a quote inside a value stays inside it");
});

test("script URLs go with whitespace, entities, and casing", () => {
  assert.equal(strip("<a href=\"javascript:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\" JaVaScRiPt:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"java\tscript:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"java&#x09;script:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"&#106;avascript:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"&#x6A&#x61vascript:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"&#0000106avascript:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"javascript&colon;alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"java&Tab;script:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"java&NewLine;script:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"&amp;#106;avascript:alert(1)\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"jav&unknown;ascript:alert(1)\">x</a>"), "<a>x</a>", "an unresolved reference inside a scheme is refused");
  assert.equal(strip("<a href='vbscript:msgbox(1)'>x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"data:text/html;base64,PHNjcmlwdD4=\">x</a>"), "<a>x</a>");
  assert.equal(strip("<a href=\"data: TEXT/HTML,<script>alert(1)</script>\">x</a>"), "<a>x</a>");
  assert.equal(strip("<img src=\"x\" data-x=\"javascript:1\">"), "<img src=\"x\">", "every attribute is checked, not just href");
  assert.equal(isDangerousValue("https://example.com/javascript:"), false);
  assert.equal(isDangerousValue("notes.html#part:two"), false);
});

test("svg and math keep their drawing but lose script vectors", () => {
  const svg = strip("<svg viewBox=\"0 0 10 10\"><script>alert(1)</script><circle cx=5 cy=5 r=4 onclick=alert(1) /><path d=\"M0 0L10 10\"/></svg>");
  assert.equal(svg, "<svg viewbox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"4\"/><path d=\"M0 0L10 10\"/></svg>");
  assert.equal(
    strip("<svg><a xlink:href=\"javascript:alert(1)\"><text>x</text></a></svg>"),
    "<svg><a><text>x</text></a></svg>",
  );
  assert.equal(
    strip("<svg><a href=\"#x\"><animate attributeName=href to=\"javascript:alert(1)\"/><set attributeName=href to=javascript:alert(1) /></a></svg>"),
    "<svg><a href=\"#x\" target=\"_blank\" rel=\"noopener noreferrer\"></a></svg>",
  );
  assert.doesNotMatch(strip("<svg><style><img src=x onerror=alert(1)></style></svg>"), /<img/, "style content never holds a tag");
  assert.doesNotMatch(strip("<svg><![CDATA[<img src=x onerror=alert(1)>]]></svg>"), /onerror/);
  const math = strip("<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext><mi href=\"javascript:alert(1)\">x</mi></math>");
  assert.doesNotMatch(math, /<img|javascript/);
  assert.match(math, /<math><mtext><table><mglyph><style>\\3c img/);
  assert.match(math, /<mi>x<\/mi><\/math>$/);
});

test("form, frame, object, base, meta refresh, and link tags go; their inner text stays", () => {
  assert.equal(
    strip("<form action=\"javascript:alert(1)\" method=post><label>Name <input name=n></label><button formaction=\"https://evil.example\">Go</button></form>"),
    "<label>Name <input name=\"n\"></label><button>Go</button>",
  );
  assert.equal(strip("<iframe src=\"https://evil.example\">fallback</iframe>after"), "after");
  assert.equal(strip("<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>ok"), "ok");
  assert.equal(strip("<div srcdoc=\"x\">y</div>"), "<div>y</div>");
  assert.equal(strip("<object data=\"x.swf\"><p>No plugin</p></object>"), "<p>No plugin</p>");
  assert.equal(strip("<embed src=\"x.swf\"><applet code=x>t</applet>"), "t");
  assert.equal(strip("<base href=\"https://evil.example/\" target=\"_top\">x"), "x");
  assert.equal(strip("<meta http-equiv=\"refresh\" content=\"0;url=javascript:alert(1)\"><meta charset=utf-8>"), "<meta charset=\"utf-8\">");
  assert.equal(strip("<META HTTP-EQUIV=Set-Cookie content=a=b>x"), "x");
  assert.equal(strip("<link rel=import href=x.html><link rel=stylesheet href=s.css>x"), "x");
  assert.equal(strip("<noscript><p>shown</p></noscript>"), "<p>shown</p>");
  assert.equal(strip("<xmp><b>shown as text</b></xmp>"), "&lt;b&gt;shown as text&lt;/b&gt;");
  assert.equal(strip("<a href=\"https://example.com\" ping=\"https://evil.example/track\">x</a>"), "<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">x</a>");
});

test("links open a new window and cannot navigate the viewer", () => {
  assert.equal(
    strip("<a href=\"https://example.com\" target=\"_top\" rel=\"opener\">x</a>"),
    "<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">x</a>",
  );
  assert.equal(strip("<a href=\"#section\">jump</a>"), "<a href=\"#section\" target=\"_blank\" rel=\"noopener noreferrer\">jump</a>");
  assert.equal(strip("<a name=\"anchor\">here</a>"), "<a name=\"anchor\">here</a>", "an anchor without a link is left alone");
  assert.equal(strip("<map><area href=\"https://example.com\" target=_self></map>"), "<map><area href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\"></map>");
});

test("design survives: styles, data images, tables, headings, and entities", () => {
  const source = [
    "<!DOCTYPE html>",
    "<html lang=\"en\"><head><title>Plan &amp; notes</title>",
    "<style>body { font: 16px/1.5 Georgia; } .a > .b { color: #333 } a[title=\"<x>\"] { color: red }</style>",
    "</head><body>",
    "<!-- a comment <script>alert(1)</script> -->",
    "<h1 style=\"color: teal\">Plan</h1>",
    "<img alt=\"dot\" src=\"data:image/png;base64,iVBORw0KGgo=\">",
    "<table><tr><th>A</th><td>1 &lt; 2</td></tr></table>",
    "<p>Tom &amp; Jerry &copy; 2026</p>",
    "</body></html>",
  ].join("\n");
  const output = strip(source);
  assert.match(output, /<html lang="en"><head><title>Plan &amp; notes<\/title>/);
  assert.match(output, /<style>body \{ font: 16px\/1\.5 Georgia; \} \.a &gt; \.b|<style>body \{ font: 16px\/1\.5 Georgia; \} \.a > \.b/);
  assert.match(output, /a\[title="\\3c x>"\]/, "a `<` inside CSS becomes a CSS escape");
  assert.match(output, /<h1 style="color: teal">Plan<\/h1>/);
  assert.match(output, /<img alt="dot" src="data:image\/png;base64,iVBORw0KGgo=">/);
  assert.match(output, /<table><tr><th>A<\/th><td>1 &lt; 2<\/td><\/tr><\/table>/);
  assert.match(output, /<p>Tom &amp; Jerry &copy; 2026<\/p>/);
  assert.doesNotMatch(output, /DOCTYPE|comment/, "the source doctype and comments are dropped");
});

test("text, stray brackets, and unclosed tags stay text or vanish, never markup", () => {
  assert.equal(strip("1 < 2 > 0"), "1 &lt; 2 &gt; 0");
  assert.equal(strip("a <3 b"), "a &lt;3 b");
  assert.equal(strip("tail <div class=\"never closed"), "tail ", "end of file inside a tag emits nothing more");
  assert.equal(strip("tail <img src=x"), "tail ");
  assert.equal(strip("x </"), "x &lt;/");
  assert.equal(strip("x </ bogus>y"), "x y");
  assert.equal(strip("x <?php echo 1 ?>y"), "x y");
  assert.equal(strip("<!-->x<!--->y<!-- z --!>w"), "xyw");
  assert.equal(strip("<p>unclosed paragraph"), "<p>unclosed paragraph");
  assert.equal(strip("<title><script>alert(1)</script></title>"), "<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>");
  assert.equal(
    strip("<textarea><img title=\"</textarea><img src=x onerror=alert(1)>\"></textarea>"),
    "<textarea>&lt;img title=\"</textarea><img src=\"x\">\"&gt;</textarea>",
  );
  assert.equal(strip("<plaintext><b>rest</b>"), "&lt;b&gt;rest&lt;/b&gt;");
});

test("the document shell and the 8 MiB bound", () => {
  const page = renderInertHtmlDocument("<h1>Hi</h1><script>x</script>");
  assert.equal(page, "<!DOCTYPE html>\n<meta charset=\"utf-8\">\n<meta name=\"referrer\" content=\"no-referrer\">\n<h1>Hi</h1>");
  assertInert(page);

  const atBound = "a".repeat(WORKFOLD_PUBLICATION_HTML_MAX_SOURCE_BYTES);
  assert.equal(stripPublicationHtml(atBound).length, WORKFOLD_PUBLICATION_HTML_MAX_SOURCE_BYTES);
  assert.throws(() => stripPublicationHtml(`${atBound}a`), WorkFoldPublicationHtmlTooLargeError);
  assert.throws(
    () => stripPublicationHtml("é".repeat(WORKFOLD_PUBLICATION_HTML_MAX_SOURCE_BYTES / 2 + 1)),
    WorkFoldPublicationHtmlTooLargeError,
    "the bound counts UTF-8 bytes, not characters",
  );

  const many = "<p onclick=x>".repeat(100_000);
  const started = Date.now();
  assert.equal(stripPublicationHtml(many), "<p>".repeat(100_000));
  assert.ok(Date.now() - started < 5_000, "the strip stays linear on many tags");
});

test("a shared HTML document cannot send content to the relay through CSS imports", { skip: process.platform !== "darwin", timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-viewer-html-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = renderInertHtmlDocument([
    '<style>@import url("__PROBE_ORIGIN__/private-content.css"); h1 { color: rgb(12, 34, 56); }</style>',
    '<h1>Styled page</h1>',
    '<img id="embedded" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=">',
    '<img src="__PROBE_ORIGIN__/private-content.png">',
    '<script>globalThis.pageScriptRan = true</script>',
  ].join(""));
  await writeFile(join(root, "source.html"), source);
  const electron = createRequire(import.meta.url)("electron") as string;
  const { stdout } = await promisify(execFile)(electron, [
    fileURLToPath(new URL("./fixtures/publication-html-electron.mjs", import.meta.url)), root,
  ], { timeout: 25_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result.requests, ["/", "/viewer.js"], "decrypted content makes no requests, even to the viewer origin");
  assert.equal(result.document.heading, "Styled page");
  assert.equal(result.document.color, "rgb(12, 34, 56)", "inline styles still render");
  assert.equal(result.document.imageWidth, 1, "embedded images still render");
  assert.equal(result.document.scriptRan, false);
  assert.equal(result.document.parentReadable, false, "the document retains an opaque sandbox origin");
});
