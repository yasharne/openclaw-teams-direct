import test from "node:test";
import assert from "node:assert/strict";
import { formatReply } from "../src/format.js";
test("Teams rich text preserves the incident summary's paragraphs, bold, bullets and inline code", () => {
  const text =
    "**No ongoing incidents.** ✅\n\nBoth checks are green:\n- **Incident wrapper:** No incident detected — Kalantar `false`, ingress `HEALTHY`\n- **Live metrics:** All healthy\n\nBaly is running normally.";
  const html = formatReply(text);
  assert.ok(
    html.startsWith("<p><strong>No ongoing incidents.</strong> ✅</p>"),
  );
  assert.ok(html.includes("<ul><li><strong>Incident wrapper:</strong>"));
  assert.ok(html.includes("<code>false</code>"));
  assert.ok(html.endsWith("</ul><p>Baly is running normally.</p>"));
});
test("Model HTML is escaped and links cannot introduce scripts or attributes", () => {
  const html = formatReply(
    '<script>alert(1)</script> **<img src=x>**\n[x](javascript:alert) [safe](https://example.com/?q="x")',
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes("q=&quot;x&quot;"));
});
test("Code blocks, ordered lists and single line breaks remain readable", () => {
  const html = formatReply(
    "# Heading\nfirst\nsecond\n\n1. one\n2. two\n\n```sh\n<raw> **literal**\n```",
  );
  assert.ok(html.includes("<p>first<br>second</p>"));
  assert.ok(html.includes("<ol><li>one</li><li>two</li></ol>"));
  assert.ok(html.includes("<pre><code>&lt;raw&gt; **literal**</code></pre>"));
});
