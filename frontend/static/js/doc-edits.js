// Edit blocks: how a conversation writes to the document beside it. The
// backend tells the model about them (routers/conversations.py's
// _target_document_prompt); this finds them in its reply and applies them
// to the document's text. Pure string work, no DOM.
//
//   ````edit
//   <<<<<<< SEARCH
//   text to find
//   =======
//   text to put in its place
//   >>>>>>> REPLACE
//   ````
//
// An empty SEARCH appends to the end. A ````rewrite block holds the whole
// new document. Models don't always keep to four backticks, so any fence of
// three or more backticks or tildes is accepted, closed by the same fence.

const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*(edit|rewrite)[ \t]*$/;
const SEARCH_MARK = /^<{5,9} ?SEARCH[ \t]*$/;
const DIVIDER = /^={5,9}[ \t]*$/;
const REPLACE_MARK = /^>{5,9} ?REPLACE[ \t]*$/;

// Every edit block that is complete so far in `text` (a reply still
// streaming in), in order. A block whose closing fence hasn't arrived yet
// isn't returned - call again with more text and it will be, at the same
// index, so a caller can apply blocks as they finish; pass `final` once
// the reply has ended.
export function parseEditBlocks(text, { final = false } = {}) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const close = lines.indexOf(open[1], i + 1);
    // The last line may be a partial one while streaming - it only counts
    // as the closing fence once something follows it, or the reply is over
    // (`final`).
    if (close === -1 || (close === lines.length - 1 && !final)) break;
    const body = lines.slice(i + 1, close);
    if (open[2] === "rewrite") {
      blocks.push({ kind: "rewrite", replace: body.join("\n") });
    } else {
      // One fence may hold several SEARCH/REPLACE pairs.
      let search = null;
      let replace = null;
      for (const line of body) {
        if (SEARCH_MARK.test(line)) {
          search = [];
          replace = null;
        } else if (DIVIDER.test(line) && search && !replace) {
          replace = [];
        } else if (REPLACE_MARK.test(line) && search && replace) {
          blocks.push({ kind: "replace", search: search.join("\n"), replace: replace.join("\n") });
          search = replace = null;
        } else if (replace) {
          replace.push(line);
        } else if (search) {
          search.push(line);
        }
      }
    }
    i = close + 1;
  }
  return blocks;
}

const LIST_LINE = /^\s*([-*+]|\d+[.)])\s/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Where `search` is in `content`: exactly, or - models often drop trailing
// spaces or re-indent - line by line ignoring leading/trailing whitespace.
function locate(content, search) {
  const exact = content.indexOf(search);
  if (exact !== -1) return [exact, exact + search.length];
  const lines = search.split("\n").map((line) => line.trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return null;
  const pattern = new RegExp(lines.map((line) => `[ \\t]*${escapeRegExp(line)}[ \\t]*`).join("\\n"));
  const match = pattern.exec(content);
  return match ? [match.index, match.index + match[0].length] : null;
}

// Applies one block. Returns the new text as `content`, the same change as
// a splice of the old one (`from`, `to`, `text`), and where the new part
// sits afterwards (`start`, `end`) - or null when its SEARCH text isn't in
// the document (it changed, or the model misquoted it).
export function applyEditBlock(content, block) {
  if (block.kind === "rewrite") {
    const text = block.replace.endsWith("\n") || !block.replace ? block.replace : `${block.replace}\n`;
    return { content: text, from: 0, to: content.length, text, start: 0, end: text.length };
  }
  if (!block.search.trim()) {
    // Append. A list item continuing a list goes on the next line; anything
    // else gets a blank line before it so it's a paragraph of its own.
    const body = content.replace(/\s+$/, "");
    const lastLine = body.slice(body.lastIndexOf("\n") + 1);
    const continuesList = LIST_LINE.test(lastLine) && LIST_LINE.test(block.replace);
    const lead = !body ? "" : continuesList ? "\n" : "\n\n";
    const start = body.length + lead.length;
    const text = `${lead}${block.replace}\n`;
    return { content: body + text, from: body.length, to: content.length, text, start, end: start + block.replace.length };
  }
  const found = locate(content, block.search);
  if (!found) return null;
  const [from, to] = found;
  return {
    content: content.slice(0, from) + block.replace + content.slice(to),
    from,
    to,
    text: block.replace,
    start: from,
    end: from + block.replace.length,
  };
}

// For showing a reply rather than applying it: every edit block (a
// half-arrived one included) becomes the one line `note`, since the raw
// SEARCH/REPLACE text is the document's business, not the reader's.
export function collapseEditBlocks(text, note) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const close = lines.indexOf(open[1], i + 1);
    out.push(note);
    i = close === -1 ? lines.length : close + 1;
  }
  return out.join("\n");
}
