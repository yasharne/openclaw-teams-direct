/** Render a small, safe Markdown subset using Teams-compatible HTML. */
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
function inline(text: string): string {
  const pattern =
    /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let result = "",
    from = 0;
  for (const match of text.matchAll(pattern)) {
    result += escape(text.slice(from, match.index));
    if (match[1]) result += `<code>${escape(match[1])}</code>`;
    else if (match[2] || match[3])
      result += `<strong>${escape((match[2] ?? match[3])!)}</strong>`;
    else result += `<a href="${escape(match[5]!)}">${escape(match[4]!)}</a>`;
    from = match.index! + match[0].length;
  }
  return result + escape(text.slice(from));
}
export function formatReply(markdown: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [],
    list: string[] = [],
    listType = "",
    code: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length)
      blocks.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length)
      blocks.push(
        `<${listType}>${list.map((s) => `<li>${inline(s)}</li>`).join("")}</${listType}>`,
      );
    list = [];
    listType = "";
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      if (code) {
        blocks.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      const type = item[1] ? "ul" : "ol";
      if (listType && listType !== type) flushList();
      listType = type;
      list.push(item[2]!);
      continue;
    }
    flushList();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push(`<p><strong>${inline(heading[1]!)}</strong></p>`);
    } else paragraph.push(line);
  }
  flushParagraph();
  flushList();
  if (code) blocks.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  // Teams suppresses paragraph margins; explicit breaks keep sections apart.
  return blocks.join("<br>");
}
