import re

from asciimath2 import Config, UnsupportedLatexError
from asciimath2 import convert as _to_asciimath2
from pylatexenc.latexwalker import LatexWalkerParseError

# The directive itself is only ever meaningful at the very top of a whole
# rendered document (see frontend/static/js/markdown.js's DIRECTIVE_RE scan)
# - but this module only ever sees one turn's *assistant* text, never the
# "## User ... ## Assistant"-equivalent structure storage.py wraps it in
# (see its EXCHANGE_HEADINGS - which of the three language variants applies
# is chosen per send, not fixed). So this module reports whether a directive
# is needed (see convert_math_to_asciimath's return value) instead of
# writing one itself; storage.complete_exchange is what actually has the
# whole document, and prepends it there.
MATH_DIRECTIVE = "<!-- math: asciimath -->"
# "Hybrid": \(...\)/\[...\] stay LaTeX and $...$/$$...$$ become AsciiMath2,
# deliberately, in the same document - unlike plain `MATH_DIRECTIVE` above,
# where \(...\)/\[...\] surviving as LaTeX is just the best-effort fallback
# for whatever asciimath2 couldn't convert, hybrid mode never even attempts
# to convert them (see convert_math_to_asciimath's `hybrid` param) - they're
# a deliberate authoring choice, not a failure.
HYBRID_MATH_DIRECTIVE = "<!-- math: hybrid -->"

_FENCE_RE = re.compile(r"^```")
# Opening markers tolerate leading indentation - LLMs commonly indent a
# block formula that continues a numbered/bulleted list item - but the
# indentation isn't captured, since block math always breaks out of the
# surrounding list/paragraph flow anyway (see closeList() call sites), so
# there's nothing meaningful to preserve it for.
# A whole line that is one display span. The interior must not itself
# contain "$$": a greedy ".+" would run from the first "$$" on the line to
# the last, swallowing every later formula AND the prose between them
# ("$$\frac{a}{b}$$ 그리고 $$\sqrt{x}$$") into a single math string.
_DOLLAR_BLOCK_ONE_LINE_RE = re.compile(r"^\s*\$\$((?:(?!\$\$).)+)\$\$\s*$")
# Multi-line open/close markers don't need to be alone on their line - LLMs
# often write "$$f(x)=\n...\n=g(x)$$" with content attached right after the
# opening marker or right before the closing one. Group 2 is whatever
# follows the closer on that same line (prose, not math).
_DOLLAR_BLOCK_CLOSE_RE = re.compile(r"^(.*?)\$\$(.*)$")
_BRACKET_BLOCK_ONE_LINE_RE = re.compile(r"^\s*\\\[((?:(?!\\\]).)+)\\\]\s*$")
_BRACKET_BLOCK_CLOSE_RE = re.compile(r"^(.*?)\\\](.*)$")
# "$[" is a real, recurring LLM typo for either "\[" or "$$" - not
# hypothetical, it's what triggered this whole block (see the "$[" opener
# in a countable-additivity axiom that reached us as a genuinely broken
# formula). Recognizing it, and accepting *either* "$$" or "\]" as its
# close (since the LLM's own choice of closer is exactly as unreliable as
# its choice of opener was), turns a formula that would otherwise stay
# broken forever into one that converts normally.
_DOLLAR_BRACKET_ONE_LINE_RE = re.compile(r"^\s*\$\[(.+?)(?:\$\$|\\\])\s*$")
_DOLLAR_BRACKET_OPEN_RE = re.compile(r"^\s*\$\[(.*)$")
_DOLLAR_BRACKET_CLOSE_RE = re.compile(r"^(.*?)(?:\$\$|\\\])(.*)$")
# Hangul syllables asciimath2 emits one-per-token, joined with spaces
# ("한글" -> "한 글"). Collapsed back after a successful conversion.
_HANGUL_GAP_RE = re.compile(r"(?<=[가-힣]) (?=[가-힣])")

# AsciiMath2 (asciimath2/SPEC.md) separates rows of a multi-line/aligned
# expression with a blank line. That's meaningful structure - collapsing it
# to spaces the way the rest of this module normalizes whitespace would
# destroy it - so row breaks are normalized separately from everything
# inside a row.
_ROW_BREAK_RE = re.compile(r"\n{2,}")


def _scan_multiline_block(
    lines: list[str], start: int, close_re: re.Pattern[str]
) -> tuple[int, list[str], str] | None:
    """Scans forward from `lines[start]` for a line matching `close_re`,
    collecting the lines in between. Gives up (returns None) at the first
    blank line, without consuming it or anything past it.

    The third value is the text after the closer on the closing line
    (prose that must not be fed to the math converter).

    An opening marker with no matching close before its paragraph ends is
    almost always a malformed/typo'd delimiter in the LLM's own output (e.g.
    a stray "$[" that was probably meant to be "\\[" or "$$", several lines
    above a stray "$$" left over from what it actually meant to close) - not
    a genuine block that happens to be very long. Scanning all the way to
    end-of-document looking for that unrelated later "$$"/"\\]" swallows
    everything in between into one broken block instead of leaving the
    single malformed line as the only casualty.
    """
    block: list[str] = []
    j = start
    while j < len(lines):
        if lines[j].strip() == "":
            return None
        close = close_re.match(lines[j])
        if close:
            block.append(close.group(1))
            trailing = close.group(2) if close.lastindex and close.lastindex >= 2 else ""
            return j + 1, block, trailing
        block.append(lines[j])
        j += 1
    return None


def _collapse_hangul_spaces(text: str) -> str:
    """Joins Hangul syllables asciimath2 split apart ("한 글" -> "한글").

    The converter tokenizes every non-ASCII letter as its own atom and
    refuses to write them together, so a word that entered as math comes
    back with a space between every syllable. Spaces that are not between
    two Hangul syllables (around operators, Latin letters, ...) stay.
    """
    return _HANGUL_GAP_RE.sub("", text)


def _looks_like_spaced_source(source: str, output: str) -> bool:
    """True when `output` is `source` with spaces inserted between characters.

    ``\\frac{a}{b}`` coming back as ``\\ f r a c { a } { b }`` (or the same
    shape with only some of those spaces) is not AsciiMath - it is the
    LaTeX source echoed token-by-token. A real conversion drops the
    backslash commands (``a/b``, ``sqrt(x)``, ``alpha``).
    """
    if "\\" not in output or " " not in output:
        return False
    return "".join(output.split()) == "".join(source.split())


def _try_convert(latex: str, config: Config | None) -> str | None:
    """Converts one LaTeX expression to AsciiMath2, or None if it can't be
    (a construct `asciimath2` doesn't support - see its README's "Scope,
    honestly" section)."""
    latex = latex.strip()
    if not latex:
        return None
    try:
        converted = _to_asciimath2(latex, config)
    except (UnsupportedLatexError, AttributeError, LatexWalkerParseError):
        # asciimath2 raises AttributeError (not UnsupportedLatexError) for a
        # macro whose arguments never arrived, e.g. a bare ``\frac``. One
        # bad span must not fail the whole document.
        return None
    converted = _collapse_hangul_spaces(converted)
    if _looks_like_spaced_source(latex, converted):
        return None
    return converted


def _normalize_block_whitespace(ascii_math: str) -> str:
    rows = _ROW_BREAK_RE.split(ascii_math.strip())
    return "\n\n".join(" ".join(row.split()) for row in rows)


def _convert_block(latex: str, config: Config | None) -> tuple[str, bool]:
    """Returns (replacement text, whether an actual AsciiMath2 conversion
    happened). The caller needs that distinction, not just "was this span a
    math span" - see `convert_math_to_asciimath`'s `converted_any`."""
    ascii_math = _try_convert(latex, config)
    if ascii_math is not None:
        return f"$$\n{_normalize_block_whitespace(ascii_math)}\n$$", True
    # LaTeX math mode ignores source line breaks entirely - any row structure
    # (e.g. a matrix) comes from \\ inside the LaTeX itself, never from
    # physical newlines - so it's always safe to flatten to one line here.
    # That also keeps this a single-line "\[ ... \]" the frontend recognizes,
    # instead of a "\[" on the first line and "\]" on the last that it can't
    # parse as a block, and it avoids the frontend's multi-line handling
    # (each line becomes its own centered row) misreading unrelated line
    # wraps as separate stacked equations.
    return f"\\[{' '.join(latex.split())}\\]", False


def _convert_inline_text(latex: str, config: Config | None) -> tuple[str, bool]:
    ascii_math = _try_convert(latex, config)
    if ascii_math is not None:
        return f"${' '.join(ascii_math.split())}$", True
    return f"\\({' '.join(latex.split())}\\)", False


def convert_math_to_asciimath(text: str, config: Config | None = None, hybrid: bool = False) -> tuple[str, bool]:
    """Best-effort rewrite of every $...$ / $$...$$ / \\(...\\) / \\[...\\]
    LaTeX math span in `text` to AsciiMath2 - or, when `hybrid` is true,
    only the $...$ / $$...$$ ones: \\(...\\)/\\[...\\] spans are left
    completely untouched, verbatim, never even attempted (see
    HYBRID_MATH_DIRECTIVE) - a deliberate "keep these as LaTeX" choice by
    whoever wrote them, not a fallback to leave alone only on failure.

    `config` carries mark-vector's global custom-symbols CSV, if any (see
    app/custom_symbols.py) - passed through unchanged to every span's
    conversion, not looked up here, since this module has no access to
    storage.

    Returns `(converted_text, needs_directive)`. `needs_directive` is true
    only when at least one span *actually* converted - not merely when a
    math span was found. A document whose every span fails to convert has
    no AsciiMath2 content for the directive to apply to, so it should stay
    pure LaTeX with no directive at all (this used to be wrong: a document
    with only failed conversions still reported "needs a directive," from
    every span having been "found" even though none converted). The caller
    (storage.complete_exchange) is responsible for actually writing
    `MATH_DIRECTIVE`/`HYBRID_MATH_DIRECTIVE` at the true top of the
    assembled document when this is true - this function only ever sees one
    turn's assistant text, not the full document structure the directive
    needs to sit above.

    A span that fails to convert (a construct `asciimath2` doesn't support)
    is left as LaTeX using the \\(...\\) / \\[...\\] delimiters, which always
    render as LaTeX regardless of the document's math directive - so a
    failed conversion degrades to "still LaTeX", never to broken output.
    Fenced code blocks (of any language) are passed through untouched.
    """
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    converted_any = False

    def convert_block_and_track(latex: str) -> str:
        nonlocal converted_any
        replacement, ok = _convert_block(latex, config)
        converted_any = converted_any or ok
        return replacement

    def convert_inline_and_track(latex: str) -> str:
        nonlocal converted_any
        replacement, ok = _convert_inline_text(latex, config)
        converted_any = converted_any or ok
        return replacement

    def convert_same_line_display(latex: str) -> str:
        """A ``$$...$$`` pair that shares its line with other text.

        Kept on that line (``$$a/b$$``) rather than expanded into a block,
        matching a single display span that was never the whole line.
        ``$$`` is one delimiter here - it must not be re-read as two
        inline ``$`` markers, which pairs the closing ``$$`` of one formula
        with the opening ``$$`` of the next and feeds the prose between
        them (``그리고``) to the converter. That prose comes back with a
        space between every character.
        """
        nonlocal converted_any
        ascii_math = _try_convert(latex, config)
        if ascii_math is None:
            return f"\\[{' '.join(latex.split())}\\]"
        converted_any = True
        return f"$${' '.join(ascii_math.split())}$$"

    def convert_closed_spans(line: str) -> tuple[list[str], tuple[str, str] | None]:
        """Closed spans on `line`, plus an unclosed ``$$`` / ``\\[`` at its end.

        The unclosed value is ``(opener, math text after the opener)``.
        Indentation that is the whole prefix of a block opener is dropped
        (block math breaks out of the list item that indented it).
        """
        produced: list[str] = []
        buf: list[str] = []
        i = 0
        n = len(line)

        def flush() -> None:
            if buf:
                produced.append("".join(buf))
                buf.clear()

        while i < n:
            if line.startswith(r"\[", i):
                if hybrid:
                    buf.append(r"\[")
                    i += 2
                    continue
                close = line.find(r"\]", i + 2)
                if close == -1:
                    if not "".join(buf).strip():
                        buf.clear()
                    else:
                        produced.append("".join(buf).rstrip())
                        buf.clear()
                    return produced, (r"\[", line[i + 2 :])
                flush()
                produced.extend(convert_block_and_track(line[i + 2 : close]).split("\n"))
                i = close + 2
                continue
            if line.startswith(r"\(", i):
                close = line.find(r"\)", i + 2)
                if close == -1:
                    buf.append(line[i:])
                    flush()
                    return produced, None
                if hybrid:
                    buf.append(line[i : close + 2])
                else:
                    buf.append(convert_inline_and_track(line[i + 2 : close]))
                i = close + 2
                continue
            if line.startswith("$$", i):
                close = line.find("$$", i + 2)
                if close == -1:
                    if not "".join(buf).strip():
                        buf.clear()
                    else:
                        produced.append("".join(buf).rstrip())
                        buf.clear()
                    return produced, ("$$", line[i + 2 :])
                buf.append(convert_same_line_display(line[i + 2 : close]))
                i = close + 2
                continue
            if line.startswith("$", i):
                close = line.find("$", i + 1)
                if close == -1:
                    buf.append(line[i:])
                    flush()
                    return produced, None
                buf.append(convert_inline_and_track(line[i + 1 : close]))
                i = close + 1
                continue
            nxt = n
            for token in (r"\[", r"\(", "$$", "$"):
                found = line.find(token, i)
                if found != -1:
                    nxt = min(nxt, found)
            if nxt == i:
                buf.append(line[i])
                i += 1
            else:
                buf.append(line[i:nxt])
                i = nxt
        flush()
        return produced, None

    while i < len(lines):
        line = lines[i]

        if _FENCE_RE.match(line):
            out.append(line)
            i += 1
            while i < len(lines) and not _FENCE_RE.match(lines[i]):
                out.append(lines[i])
                i += 1
            if i < len(lines):
                out.append(lines[i])
                i += 1
            continue

        one_line_dollar = _DOLLAR_BLOCK_ONE_LINE_RE.match(line)
        if one_line_dollar:
            out.append(convert_block_and_track(one_line_dollar.group(1)))
            i += 1
            continue

        one_line_dollar_bracket = _DOLLAR_BRACKET_ONE_LINE_RE.match(line)
        if one_line_dollar_bracket:
            out.append(convert_block_and_track(one_line_dollar_bracket.group(1)))
            i += 1
            continue

        dollar_bracket_open = _DOLLAR_BRACKET_OPEN_RE.match(line)
        if dollar_bracket_open:
            scanned = _scan_multiline_block(lines, i + 1, _DOLLAR_BRACKET_CLOSE_RE)
            if scanned is not None:
                next_i, rest, trailing = scanned
                block = [dollar_bracket_open.group(1), *rest]
                out.append(convert_block_and_track("\n".join(block)))
                i = next_i
                if trailing.strip():
                    lines.insert(i, trailing.strip())
                continue
            # No closing "$$"/"\]" before the paragraph ends either - genuinely
            # not recoverable; fall through and process as ordinary text.

        # \[...\] blocks are skipped entirely in hybrid mode (see the
        # `hybrid` param's docstring) - a whole-line "\[ ... \]" stays
        # falsy, so the line falls through to the span scan below
        # untouched, same as any other text.
        one_line_bracket = None if hybrid else _BRACKET_BLOCK_ONE_LINE_RE.match(line)
        if one_line_bracket:
            out.append(convert_block_and_track(one_line_bracket.group(1)))
            i += 1
            continue

        produced, unclosed = convert_closed_spans(line)
        if unclosed is None:
            # A line with no delimiters yields one piece; a blank line yields
            # none. Keep the blank line - dropping it would join the
            # paragraphs on either side.
            out.extend(produced if produced else [line])
            i += 1
            continue

        kind, rest = unclosed
        close_re = _DOLLAR_BLOCK_CLOSE_RE if kind == "$$" else _BRACKET_BLOCK_CLOSE_RE
        scanned = _scan_multiline_block(lines, i + 1, close_re)
        if scanned is None:
            # The opener never closed before the paragraph ended. If nothing
            # before it on this line was math, leave the line exactly as
            # typed ("intro $$"). Otherwise keep the converted prefix.
            prefix = line[: len(line) - len(kind + rest)] if line.endswith(kind + rest) else None
            if prefix is not None and "$" not in prefix and r"\(" not in prefix:
                out.append(line)
            else:
                out.extend(produced)
                out.append(kind + rest)
            i += 1
            continue
        next_i, rest_lines, trailing = scanned
        block = [rest, *rest_lines]
        out.extend(produced)
        out.append(convert_block_and_track("\n".join(block)))
        i = next_i
        if trailing.strip():
            lines.insert(i, trailing.strip())

    return "\n".join(out), converted_any


# Matches frontend/static/js/markdown.js's DIRECTIVE_RE.
_DIRECTIVE_LINE_RE = re.compile(r"^<!--\s*math:\s*(latex|asciimath|hybrid)\s*-->\s*$", re.IGNORECASE)


def _strip_directive_lines(text: str) -> str:
    return "\n".join(line for line in text.split("\n") if not _DIRECTIVE_LINE_RE.match(line.strip()))


def convert_document_to_asciimath(text: str, config: Config | None = None, hybrid: bool = False) -> str:
    """On-demand conversion of a whole, already-saved document - not a
    fresh LLM response (see convert_math_to_asciimath, called from
    routers/conversations.py's send_message for that case). Used by the
    "AsciiMath"/"Hybrid" format radio in the editor toolbar: pick a
    document, ask for it in AsciiMath2 (or Hybrid) right now, get it back,
    independent of sending anything.

    Unlike convert_math_to_asciimath, this always prepends the directive,
    not only when a span actually converted. A document with no math in it
    yet still needs the directive changed - the user just chose AsciiMath/
    Hybrid as *this document's* format going forward, which should hold
    even while it inherits a different default from its session/project/
    global system prompt (see app.js's sessionMathDialect) - an absent
    directive wouldn't override that inherited default the way an explicit
    one does. Any pre-existing directive is stripped first so the new one -
    always the last line matched, and thus authoritative per markdown.js's
    DIRECTIVE_RE scan - doesn't end up shadowed by a stale one further down
    the document.
    """
    text = _strip_directive_lines(text)
    converted, _ = convert_math_to_asciimath(text, config, hybrid)
    directive = HYBRID_MATH_DIRECTIVE if hybrid else MATH_DIRECTIVE
    return f"{directive}\n{converted}"
