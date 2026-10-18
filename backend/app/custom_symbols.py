"""Parses mark-vector's global "공용 커스텀 심볼" CSV (data/custom-symbols.csv,
see storage.get_global_custom_symbols) into an asciimath2.Config.

Format is the same two-column `<asciimath token>, <latex>` CSV used by the
obsidian-publish-asciimath plugin's custom-symbols.csv - one row per custom
symbol, e.g. `pmf, \\text{pmf}` or `!<=, \\nleq`. That file is written for the
*forward* direction (AsciiMath -> LaTeX, via asciimath-parser's own `symbols`
config - see frontend/static/js/markdown.js's setCustomAsciiMathSymbols,
which applies every row verbatim with no classification needed). This module
does the harder *reverse* direction: recognizing which LaTeX macros in the
`latex` column asciimath2's converter can be taught to turn back into the
matching token.

Only two LaTeX shapes are recognized, matching asciimath2.Config's two
extension points:
- a bare, no-argument macro (`\\nleq`, `\\sqcup`, `\\hookrightarrow`, ...) ->
  Config.custom_macros
- `\\text{X}` / `\\operatorname{X}` / `\\operatorname*{X}` with fixed content
  `X` (`\\text{pmf}`, `\\operatorname*{LIM}`, ...) -> Config.custom_text

Any other shape (a `\\frac{...}{...}` pattern, a raw `\\mathrel{...}`
sequence, ...) is silently skipped for this direction - the row still works
for hand-typed AsciiMath2 via the frontend override, it just isn't
recognized when converting fresh LLM LaTeX output automatically. That's a
deliberate best-effort trade-off, not a bug: asciimath2's converter already
degrades unsupported LaTeX to `\\(...\\)`/`\\[...\\]` rather than failing
outright (see its README's "Scope, honestly"), so a skipped row just means
one fewer thing gets auto-converted, never a broken document.
"""

from __future__ import annotations

import csv
import io
import re

from asciimath2 import Config

_BARE_MACRO_RE = re.compile(r"^\\([A-Za-z]+)$")
_TEXT_OR_OPERATORNAME_RE = re.compile(r"^\\(?:text|operatorname\*?)\{(.*)\}$")


def parse_custom_symbols_rows(csv_content: str) -> list[tuple[str, str]]:
    """Every (token, latex) row in the CSV, trimmed, in file order - blank
    lines and rows missing either column are dropped. This is what the
    frontend needs (verbatim, no classification) - see
    routers/custom_symbols.py's GET response.
    """
    rows: list[tuple[str, str]] = []
    for fields in csv.reader(io.StringIO(csv_content)):
        if len(fields) < 2:
            continue
        token, latex = fields[0].strip(), fields[1].strip()
        if token and latex:
            rows.append((token, latex))
    return rows


def build_config(csv_content: str) -> Config:
    """The subset of `parse_custom_symbols_rows` this package's LaTeX ->
    AsciiMath2 converter can actually act on, as an asciimath2.Config ready
    to pass into `asciimath2.convert`, plus every row's token as
    `extra_tokens`."""
    custom_macros: dict[str, str] = {}
    custom_text: dict[str, str] = {}
    rows = parse_custom_symbols_rows(csv_content)
    for token, latex in rows:
        m = _BARE_MACRO_RE.match(latex)
        if m:
            custom_macros.setdefault(m.group(1), token)
            continue
        m = _TEXT_OR_OPERATORNAME_RE.match(latex)
        if m:
            custom_text.setdefault(m.group(1).strip(), token)
    # Every row's token is a symbol the frontend renderer knows, whether or
    # not the converter can produce it - output is never joined into one.
    tokens = frozenset(token for token, _ in rows)
    return Config(custom_macros=custom_macros, custom_text=custom_text, extra_tokens=tokens)
