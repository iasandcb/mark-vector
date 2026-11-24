// Scroll sync between the markdown editor and the preview.
//
// The old sync scaled each pane by its scroll percentage. That drifts on a
// long document: a display-math block, an image, or a code fence is a few
// source lines and a large slice of the preview, so the same percentage
// points at different parts of the document, and the error grows as those
// uneven blocks accumulate.
//
// This maps by source line instead. Each rendered top-level block is tagged
// with the editor line it came from. The editor's top visible line (a
// fractional line, so a wrapped line can sit halfway) is placed between the
// neighbouring preview anchors, in proportion to the source lines between
// them. The bottom of the editor stays the bottom of the preview.

const DIRECTIVE_RE = /^<!--\s*math:\s*(latex|asciimath|hybrid)\s*-->\s*$/i;
const EDIT_FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*(edit|rewrite)[ \t]*$/;
const TABLE_DELIMITER_CELL_RE = /^:?-+:?$/;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function scanMultilineBlock(lines, start, closeRe, { allowBlankLines = false } = {}) {
  let j = start;
  while (j < lines.length) {
    if (!allowBlankLines && lines[j].text.trim() === "") return null;
    if (closeRe.test(lines[j].text)) return { nextIndex: j + 1 };
    j += 1;
  }
  return null;
}

// Same cell split as asciimath-markdown, so a pipe table is recognised
// exactly when the renderer emits one <table>.
function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

  const cells = [];
  let current = "";
  let inCode = false;
  let mathDepth = 0;
  let inDollar = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    const two = trimmed.slice(i, i + 2);
    if (!inDollar && mathDepth === 0 && ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (!inCode && !inDollar && (two === "\\(" || two === "\\[")) {
      mathDepth += 1;
      current += two;
      i += 1;
      continue;
    }
    if (!inCode && mathDepth > 0 && (two === "\\)" || two === "\\]")) {
      mathDepth -= 1;
      current += two;
      i += 1;
      continue;
    }
    if (!inCode && mathDepth === 0 && ch === "$") {
      inDollar = !inDollar;
      current += ch;
      continue;
    }
    if (!inCode && !inDollar && mathDepth === 0 && ch === "|") {
      if (current.endsWith("\\")) {
        current = current.slice(0, -1) + "|";
        continue;
      }
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

// One entry per top-level element asciimath-markdown emits, in order.
// `line` is the 1-based line in `source` where that block starts. Math
// directives are removed by the renderer and do not produce an element;
// a directive between two prose lines does not split them.
export function sourceBlocks(source) {
  const raw = String(source ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (DIRECTIVE_RE.test(raw[i])) continue;
    lines.push({ text: raw[i], line: i + 1 });
  }

  const blocks = [];
  let i = 0;
  let paragraphStart = 0;
  let listStack = [];
  let inQuote = false;

  const flushParagraph = () => {
    if (!paragraphStart) return;
    blocks.push({ line: paragraphStart });
    paragraphStart = 0;
  };
  const closeList = () => {
    listStack = [];
  };
  const closeQuote = () => {
    inQuote = false;
  };
  const emitBlock = (line) => {
    flushParagraph();
    closeList();
    closeQuote();
    blocks.push({ line });
  };

  while (i < lines.length) {
    const line = lines[i].text;
    const lineNo = lines[i].line;

    if (/^```(\w*)\s*$/.test(line)) {
      emitBlock(lineNo);
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].text)) i += 1;
      if (i < lines.length) i += 1;
      continue;
    }

    if (/^\s*\$\$(.+)\$\$\s*$/.test(line)) {
      emitBlock(lineNo);
      i += 1;
      continue;
    }
    if (/^\s*\$\$(.*)$/.test(line)) {
      const scanned = scanMultilineBlock(lines, i + 1, /^(.*)\$\$\s*$/, { allowBlankLines: true });
      if (scanned) {
        emitBlock(lineNo);
        i = scanned.nextIndex;
        continue;
      }
    }

    if (/^\s*\$\[(.+?)(?:\$\$|\\\])\s*$/.test(line)) {
      emitBlock(lineNo);
      i += 1;
      continue;
    }
    if (/^\s*\$\[(.*)$/.test(line)) {
      const scanned = scanMultilineBlock(lines, i + 1, /^(.*)(?:\$\$|\\\])\s*$/);
      if (scanned) {
        emitBlock(lineNo);
        i = scanned.nextIndex;
        continue;
      }
    }

    if (/^\s*\\\[(.+)\\\]\s*$/.test(line)) {
      emitBlock(lineNo);
      i += 1;
      continue;
    }
    if (/^\s*\\\[(.*)$/.test(line)) {
      const scanned = scanMultilineBlock(lines, i + 1, /^(.*)\\\]\s*$/, { allowBlankLines: true });
      if (scanned) {
        emitBlock(lineNo);
        i = scanned.nextIndex;
        continue;
      }
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeQuote();
      i += 1;
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      emitBlock(lineNo);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      emitBlock(lineNo);
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length) {
      const headerCells = splitTableRow(line);
      const delimiterCells = splitTableRow(lines[i + 1].text);
      const isDelimiterRow =
        delimiterCells.length === headerCells.length &&
        delimiterCells.every((cell) => TABLE_DELIMITER_CELL_RE.test(cell));
      if (isDelimiterRow) {
        emitBlock(lineNo);
        let j = i + 2;
        while (j < lines.length && lines[j].text.trim() !== "" && lines[j].text.includes("|")) j += 1;
        i = j;
        continue;
      }
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      closeList();
      if (!inQuote) {
        blocks.push({ line: lineNo });
        inQuote = true;
      }
      i += 1;
      continue;
    }
    closeQuote();

    const ulMatch = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const olMatch = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (ulMatch || olMatch) {
      flushParagraph();
      const indent = (ulMatch || olMatch)[1].length;
      const wantType = ulMatch ? "ul" : "ol";
      while (
        listStack.length &&
        (listStack[listStack.length - 1].indent > indent ||
          (listStack[listStack.length - 1].indent === indent && listStack[listStack.length - 1].type !== wantType))
      ) {
        listStack.pop();
      }
      if (!(listStack.length && listStack[listStack.length - 1].indent === indent)) {
        if (listStack.length === 0) blocks.push({ line: lineNo });
        listStack.push({ indent, type: wantType });
      }
      i += 1;
      continue;
    }

    if (listStack.length && /^\s+\S/.test(line)) {
      i += 1;
      continue;
    }
    closeList();

    if (!paragraphStart) paragraphStart = lineNo;
    i += 1;
  }

  flushParagraph();
  return blocks;
}

function readTag(src, index) {
  if (src[index] !== "<" || src.startsWith("</", index) || src.startsWith("<!", index)) return null;
  const end = src.indexOf(">", index);
  if (end < 0) return null;
  const raw = src.slice(index, end + 1);
  const nameMatch = /^<([A-Za-z][\w:-]*)/.exec(raw);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  const selfClosing = /\/\s*>$/.test(raw) || VOID_TAGS.has(name);
  return { name, raw, end: end + 1, selfClosing };
}

function skipElement(src, index, name) {
  const openRe = new RegExp(`<${name}(?=[\\s>/])`, "gi");
  const closeRe = new RegExp(`</${name}\\s*>`, "gi");
  let depth = 1;
  let pos = index;
  while (pos < src.length && depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const open = openRe.exec(src);
    const close = closeRe.exec(src);
    if (!close) return src.length;
    if (open && open.index < close.index) {
      depth += 1;
      pos = open.index + open[0].length;
    } else {
      depth -= 1;
      pos = close.index + close[0].length;
    }
  }
  return pos;
}

function injectSourceLine(raw, line) {
  const value = String(Math.trunc(Number(line)));
  if (!/^\d+$/.test(value)) return raw;
  return raw.replace(/^<([A-Za-z][\w:-]*)/, `<$1 data-source-line="${value}"`);
}

// Stamp `lines[i]` onto the i-th top-level element. Nested tags (a list's
// items, the paragraphs inside a blockquote, KaTeX inside display math)
// stay inside that one anchor. Extra elements, when the renderer and the
// block scan disagree, are left unstamped rather than given the wrong line.
export function annotateTopLevel(html, lines) {
  const src = String(html ?? "");
  const stamps = Array.isArray(lines) ? lines : [];
  if (!src || !stamps.length) return src;
  let out = "";
  let index = 0;
  let stamp = 0;
  while (index < src.length) {
    if (src.startsWith("<!--", index)) {
      const end = src.indexOf("-->", index);
      const to = end < 0 ? src.length : end + 3;
      out += src.slice(index, to);
      index = to;
      continue;
    }
    const tag = readTag(src, index);
    if (!tag) {
      const next = src.indexOf("<", index + (src[index] === "<" ? 1 : 0));
      const to = next < 0 ? src.length : next;
      out += src.slice(index, to);
      index = to;
      continue;
    }
    if (stamp < stamps.length) {
      out += injectSourceLine(tag.raw, stamps[stamp]);
      stamp += 1;
    } else {
      out += tag.raw;
    }
    index = tag.end;
    if (!tag.selfClosing) {
      const closeAt = skipElement(src, index, tag.name);
      out += src.slice(index, closeAt);
      index = closeAt;
    }
  }
  return out;
}

// Edit fences collapse to a single preview note. The note keeps the fence's
// opening line; every other rendered line keeps the editor line it came from,
// so anchors below the fence still name editor lines.
export function collapseWithEditorLines(text, note) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  const editorLine = [];
  let i = 0;
  while (i < lines.length) {
    const open = EDIT_FENCE_OPEN.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      editorLine.push(i + 1);
      i += 1;
      continue;
    }
    const close = lines.indexOf(open[1], i + 1);
    out.push(note);
    editorLine.push(i + 1);
    i = close === -1 ? lines.length : close + 1;
  }
  return { text: out.join("\n"), editorLine };
}

export function lineIndexAt(text, offset) {
  let line = 0;
  const end = Math.max(0, Math.min(Number(offset) || 0, String(text ?? "").length));
  const src = String(text ?? "");
  for (let i = 0; i < end; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

export function editorLinesForBlocks(segment, collapsedLineIndex, editorLine) {
  const start = Math.max(0, collapsedLineIndex || 0);
  const map = Array.isArray(editorLine) ? editorLine : [];
  return sourceBlocks(segment).map((block) => {
    const mapped = map[start + block.line - 1];
    return Number.isFinite(mapped) ? mapped : block.line;
  });
}

export function annotateSegment(html, segment, collapsedLineIndex, editorLine) {
  return annotateTopLevel(html, editorLinesForBlocks(segment, collapsedLineIndex, editorLine));
}

export function dedupeAnchors(anchors) {
  const sorted = (Array.isArray(anchors) ? anchors : [])
    .filter((anchor) => Number.isFinite(anchor?.line) && Number.isFinite(anchor?.top))
    .map((anchor) => ({ line: anchor.line, top: anchor.top }))
    .sort((a, b) => a.line - b.line || a.top - b.top);
  const out = [];
  for (const anchor of sorted) {
    if (out.length && out[out.length - 1].line === anchor.line) continue;
    out.push(anchor);
  }
  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Content Y of a fractional 1-based source line. Anchors are the tops of
// rendered blocks. The run before the first anchor starts at y = 0 on line 1,
// and the run after the last anchor ends at `contentEnd` (the line just past
// the document, at the bottom of the preview content).
export function offsetForSourceLine(line, anchors, contentEnd) {
  const points = dedupeAnchors(anchors);
  const yEnd = Number.isFinite(contentEnd?.top) ? contentEnd.top : 0;
  if (!points.length) return 0;
  const sourceLine = Number.isFinite(line) ? line : 1;
  const first = points[0];
  if (sourceLine <= first.line) {
    if (first.line <= 1 || first.top <= 0) return clamp(first.top, 0, Math.max(first.top, yEnd));
    const t = clamp((sourceLine - 1) / (first.line - 1), 0, 1);
    return first.top * t;
  }
  let prev = first;
  for (let i = 1; i < points.length; i += 1) {
    const next = points[i];
    if (sourceLine < next.line) {
      const span = next.line - prev.line;
      const t = span > 0 ? (sourceLine - prev.line) / span : 0;
      return prev.top + t * (next.top - prev.top);
    }
    prev = next;
  }
  const endLine = Number.isFinite(contentEnd?.line) ? contentEnd.line : prev.line + 1;
  if (endLine <= prev.line) return prev.top;
  const t = clamp((sourceLine - prev.line) / (endLine - prev.line), 0, 1);
  return prev.top + t * (yEnd - prev.top);
}

// Inverse of offsetForSourceLine, for a preview → editor mapping.
export function sourceLineForOffset(offset, anchors, contentEnd) {
  const points = dedupeAnchors(anchors);
  const y = Number.isFinite(offset) ? offset : 0;
  const yEnd = Number.isFinite(contentEnd?.top) ? contentEnd.top : 0;
  if (!points.length) return 1;
  const first = points[0];
  if (y <= first.top) {
    if (first.line <= 1 || first.top <= 0) return first.line;
    const t = clamp(y / first.top, 0, 1);
    return 1 + t * (first.line - 1);
  }
  let prev = first;
  for (let i = 1; i < points.length; i += 1) {
    const next = points[i];
    // A Y that lands exactly on an anchor belongs to that anchor. The last
    // anchor also owns its own top; earlier anchors hand an exact hit to the
    // following span so the boundary is shared.
    if (y < next.top || (y === next.top && i === points.length - 1)) {
      const span = next.top - prev.top;
      const t = span !== 0 ? clamp((y - prev.top) / span, 0, 1) : 0;
      return prev.line + t * (next.line - prev.line);
    }
    prev = next;
  }
  const endLine = Number.isFinite(contentEnd?.line) ? contentEnd.line : prev.line + 1;
  const span = yEnd - prev.top;
  if (span === 0 || endLine <= prev.line) return prev.line;
  const t = clamp((y - prev.top) / span, 0, 1);
  return prev.line + t * (endLine - prev.line);
}

export function proportionalScroll(editorScrollTop, editorMax, previewMax) {
  if (editorMax <= 0 || previewMax <= 0) return 0;
  return (editorScrollTop / editorMax) * previewMax;
}

// Preview scrollTop that puts `sourceLine` (fractional, 1-based, the line at
// the top of the editor viewport) at the top of the preview. The first pixel
// of the editor stays the first pixel of the preview. The last stretch of
// editor scroll eases onto the preview's end, so the bottoms meet without a
// one-pixel jump, and without giving that ease-in the rest of the document.
export function previewScrollForEditor({
  sourceLine,
  anchors,
  editorScrollTop = 0,
  editorScrollHeight = 0,
  editorClientHeight = 0,
  previewScrollHeight = 0,
  previewClientHeight = 0,
  documentLines = 1,
} = {}) {
  const editorMax = Math.max(0, editorScrollHeight - editorClientHeight);
  const previewMax = Math.max(0, previewScrollHeight - previewClientHeight);
  if (editorScrollTop <= 0 || editorMax <= 0 || previewMax <= 0) return 0;
  if (editorScrollTop >= editorMax - 1) return previewMax;
  const points = dedupeAnchors(anchors);
  if (!points.length) return proportionalScroll(editorScrollTop, editorMax, previewMax);
  const endLine = Math.max((Number(documentLines) || 1) + 1, points[points.length - 1].line + 1);
  const mapped = offsetForSourceLine(sourceLine, points, { line: endLine, top: previewScrollHeight });
  const clamped = clamp(mapped, 0, previewMax);
  const zone = Math.min(editorMax, Math.max(48, editorClientHeight * 0.35));
  if (editorScrollTop > editorMax - zone) {
    const u = (editorScrollTop - (editorMax - zone)) / zone;
    return clamped + (previewMax - clamped) * clamp(u, 0, 1);
  }
  return clamped;
}

// Editor source line at the top of a preview scrolled to `previewScrollTop`.
// Inverse of the anchor map (not of the end ease-in, which only exists so
// the editor's last pixels land on the preview's last pixels).
export function sourceLineForPreviewScroll({
  previewScrollTop = 0,
  anchors,
  previewScrollHeight = 0,
  documentLines = 1,
} = {}) {
  const points = dedupeAnchors(anchors);
  if (!points.length) return 1;
  const endLine = Math.max((Number(documentLines) || 1) + 1, points[points.length - 1].line + 1);
  return sourceLineForOffset(previewScrollTop, points, { line: endLine, top: previewScrollHeight });
}
