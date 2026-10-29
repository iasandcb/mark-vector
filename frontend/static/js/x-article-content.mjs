// X's Articles API uses snake_case DraftJS fields and lowercase style/entity
// names, unlike the usual DraftJS raw JSON. Offsets are UTF-16 (JS length).
export function articleFromHtml(html, filename, { imageLabel = "Image" } = {}) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  root.querySelectorAll("script, style, iframe, object, svg, .inline-thread").forEach((node) => node.remove());
  const first = root.firstElementChild;
  const title = first?.tagName === "H1" ? first.textContent.trim() : filename.replace(/\.md$/i, "");
  if (first?.tagName === "H1") first.remove();
  const blocks = [], entities = [], warnings = new Set();
  const entity = (type, data, mutability = "immutable") => {
    const key = entities.length;
    entities.push({ key: String(key), value: { type, mutability, data } });
    return key;
  };
  const append = (type, text, inline_style_ranges = [], entity_ranges = []) => {
    blocks.push({ key: `mv${blocks.length}`, type, text, inline_style_ranges, entity_ranges });
  };
  const atomic = (type, data, text = " ") => {
    append("atomic", text, [], [{ key: entity(type, data, type === "markdown" ? "mutable" : "immutable"), offset: 0, length: text.length }]);
  };
  const latex = (node) => node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.textContent;
  function inline(nodes) {
    let text = "";
    const styles = [], ranges = [], maths = [];
    function visit(node) {
      if (node.nodeType === 3) { text += node.textContent.replace(/\s+/g, " "); return; }
      if (node.nodeType !== 1 || ["UL", "OL"].includes(node.tagName)) return;
      if (node.matches(".katex, .katex-display")) {
        const source = latex(node);
        if (node.matches(".katex-display")) {
          maths.push({ offset: text.length, length: source.length, source });
        } else warnings.add("inlineMath");
        text += source;
        return;
      }
      if (node.tagName === "IMG") {
        text += `[${imageLabel}${node.getAttribute("alt") ? `: ${node.getAttribute("alt")}` : ""}]`;
        warnings.add("images");
        return;
      }
      if (node.tagName === "BR") { text += "\n"; return; }
      if (node.tagName === "INPUT") {
        if (node.getAttribute("type") === "checkbox") text += node.hasAttribute("checked") ? "[x] " : "[ ] ";
        return;
      }
      const offset = text.length;
      for (const child of node.childNodes) visit(child);
      const length = text.length - offset;
      if (!length) return;
      const style = { STRONG: "bold", B: "bold", EM: "italic", I: "italic", DEL: "strikethrough", S: "strikethrough" }[node.tagName];
      if (style) styles.push({ offset, length, style });
      if (node.tagName === "A") {
        const url = node.getAttribute("href") || "";
        if (/^(https?:\/\/|mailto:)/i.test(url)) {
          ranges.push({ offset, length, key: entity("link", { url }, "mutable") });
        } else warnings.add("localLinks");
      }
    }
    for (const node of nodes) visit(node);
    return { text, styles, ranges, maths };
  }
  function addInline(node, type) {
    const { text, styles, ranges, maths } = inline(node.childNodes);
    // Keep inline TeX as text within its sentence. Split only display math
    // nested in a paragraph into native latex blocks, preserving surrounding
    // text, formatting, and UTF-16 ranges.
    const clip = (spans, start, end) => spans.flatMap((span) => {
      const from = Math.max(span.offset, start);
      const to = Math.min(span.offset + span.length, end);
      return to > from ? [{ ...span, offset: from - start, length: to - from }] : [];
    });
    const segment = (start, end) => {
      const value = text.slice(start, end);
      if (value.trim()) append(type, value, clip(styles, start, end), clip(ranges, start, end));
    };
    let start = 0;
    for (const math of maths) {
      segment(start, math.offset);
      atomic("latex", {}, math.source);
      start = math.offset + math.length;
    }
    segment(start, text.length);
  }
  function visit(node, quote = false) {
    if (node.nodeType === 3) {
      if (node.textContent.trim()) append(quote ? "blockquote" : "unstyled", node.textContent.trim());
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.matches(".katex-display")) { atomic("latex", {}, latex(node)); return; }
    if (node.tagName === "HR") { atomic("divider", {}); return; }
    if (node.tagName === "PRE") {
      const code = node.textContent;
      const fence = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      const language = node.querySelector("code")?.className.match(/language-([\w+-]+)/)?.[1] || "";
      atomic("markdown", { markdown: `${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}` });
      return;
    }
    if (node.tagName === "TABLE") {
      const rows = [...node.querySelectorAll("tr")].map((row) => [...row.cells].map((cell) => {
        const content = inline(cell.childNodes);
        // Tables travel as GFM Markdown, not editable DraftJS link ranges.
        return content.text.trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>");
      }));
      if (rows.length) {
        const width = Math.max(...rows.map((row) => row.length));
        const format = (row) => `| ${Array.from({ length: width }, (_, i) => row[i] || "").join(" | ")} |`;
        atomic("markdown", { markdown: [format(rows[0]), format(Array(width).fill("---")), ...rows.slice(1).map(format)].join("\n") });
      }
      return;
    }
    if (["UL", "OL"].includes(node.tagName)) {
      if (node.parentElement?.closest("ul, ol")) warnings.add("nestedLists");
      for (const li of node.children) {
        if (li.tagName !== "LI") continue;
        addInline(li, node.tagName === "UL" ? "unordered-list-item" : "ordered-list-item");
        for (const nested of li.children) if (["UL", "OL"].includes(nested.tagName)) visit(nested, quote);
      }
      return;
    }
    if (node.tagName === "BLOCKQUOTE") {
      for (const child of node.childNodes) visit(child, true);
      return;
    }
    const type = { H1: "header-one", H2: "header-two", H3: "header-three", H4: "header-three", H5: "header-three", H6: "header-three", P: "unstyled" }[node.tagName];
    if (type) { addInline(node, quote ? "blockquote" : type); return; }
    if (node.tagName === "IMG") {
      const result = inline([node]);
      append("unstyled", result.text);
      return;
    }
    for (const child of node.childNodes) visit(child, quote);
  }
  for (const child of root.childNodes) visit(child);
  return { title: title || filename, content_state: { blocks, entities }, warnings: [...warnings] };
}
