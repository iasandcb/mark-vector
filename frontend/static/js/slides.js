// How a Markdown document divides into slides - shared by the public
// slideshow (public.js) and the presenter remote in the editor (remote.js
// / app.js), so both sides always agree on which slide is which.
//
// A slide boundary is a line that is just `---`. The split is done on the
// Markdown source rather than on rendered <hr>s so a slide is rendered on
// its own - but a `---` inside a fenced code block or a $$ display-math
// block is content, not a separator, so those are tracked and skipped.

const SLIDE_SEPARATOR_RE = /^\s*---\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

// Every separator line as [start, end) character offsets into `content`.
function separatorLines(content) {
  const found = [];
  let fence = null;
  let inMath = false;
  let offset = 0;
  for (const line of content.split("\n")) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    } else if (line.trim() === "$$") {
      inMath = !inMath;
    } else if (!inMath && SLIDE_SEPARATOR_RE.test(line)) {
      found.push([offset, offset + line.length]);
    }
    offset += line.length + 1;
  }
  return found;
}

export function splitSlides(content) {
  const slides = [];
  let cursor = 0;
  for (const [start, end] of separatorLines(content)) {
    slides.push(content.slice(cursor, start));
    cursor = end + 1;
  }
  slides.push(content.slice(cursor));
  // A leading/trailing/doubled separator shouldn't produce a blank slide.
  const nonEmpty = slides.filter((s) => s.trim() !== "");
  return nonEmpty.length ? nonEmpty : [""];
}

// Where the last slide's source begins: just past the final separator line,
// or 0 when there is none yet.
export function lastSlideStart(content) {
  const separators = separatorLines(content);
  if (!separators.length) return 0;
  return Math.min(content.length, separators[separators.length - 1][1] + 1);
}
