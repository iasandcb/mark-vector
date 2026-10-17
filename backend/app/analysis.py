"""The preview pane's two LLM readings of a document (routers/analysis.py):

- evaluate: how mathematically sound the document is, and where it goes
  wrong - a JSON report whose issues quote the text they're about, so the
  client can find each one in the editor.
- formalize: the document's mathematical argument as Lean 4 (with Mathlib),
  which the client offers to open in the Lean 4 web editor to check.

Prompts and the parsing of their replies live here; nothing in this module
touches storage or a provider."""

import hashlib
import json
import re

# A bound on what one request carries - well past any document written by
# hand, and the part kept is the beginning, which is where an argument's
# definitions and assumptions are.
ANALYSIS_MAX_CHARS = 200_000

LANGUAGE_NAMES = {"ko": "Korean", "en": "English", "ja": "Japanese"}

SEVERITIES = ("error", "warning", "suggestion")
VERDICTS = ("sound", "minor_issues", "flawed", "no_math")


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _language_line(language: str) -> str:
    fallback = LANGUAGE_NAMES.get(language, "English")
    return (
        "Write every explanation in the language the document itself is written in "
        f"(if that's unclear, {fallback})."
    )


def _document_block(content: str) -> str:
    shown = content[:ANALYSIS_MAX_CHARS]
    note = "\n(The document continues past this point; only the part shown was given.)" if len(content) > len(shown) else ""
    return f"<document>\n{shown}\n</document>{note}"


EVALUATE_SYSTEM = """You are a careful mathematics reviewer. You will be given a Markdown document - notes, a solution, a proof, a lesson - and you judge how mathematically sound it is: whether its definitions are coherent, its statements true, its computations correct, and each step of its reasoning justified by what came before.

Check every computation yourself. Distinguish real errors (a false statement, a wrong result, a step that does not follow, a missing case that breaks the argument) from weaknesses (an unstated assumption, a gap a reader can fill, ambiguous notation) and from mere suggestions. Do not report style, wording or formatting unless it changes the mathematics. If the document is correct, say so and report no issues - do not invent problems.

Math in the document may be written in LaTeX or in AsciiMath (a `<!-- math: asciimath -->` line marks AsciiMath); read it in whichever it uses.

Reply with ONE JSON object and nothing else - no code fence, no text before or after it:

{
  "verdict": "sound" | "minor_issues" | "flawed" | "no_math",
  "score": <integer 0-100: how mathematically sound the document is>,
  "summary": "<two or three sentences: what the document does and how sound it is>",
  "issues": [
    {
      "severity": "error" | "warning" | "suggestion",
      "quote": "<the exact text the issue is about, copied character for character from the document - a short span, at most one line>",
      "problem": "<what is wrong and why>",
      "correction": "<what it should be, or how to fix the argument; empty if there's nothing to add>"
    }
  ]
}

Use "no_math" (with score 100 and no issues) when the document has no mathematical content to judge. List issues in document order. """


FORMALIZE_SYSTEM = """You formalize mathematics in Lean 4. You will be given a Markdown document - notes, a solution, a proof, a lesson - and you translate its mathematical content and the logical development of its argument into Lean 4 using Mathlib.

Write ONE complete Lean file in a single code block fenced with ```lean:
- Begin with `import Mathlib`, then any `open` lines needed.
- Follow the document's own order. Turn each definition into a `def` or `structure`, each claim into a `theorem` or `lemma`, and each worked computation into an `example` - with a short comment above it (`-- ...` or `/-- ... -/`) saying which part of the document it formalizes.
- Make every hidden assumption explicit as a hypothesis (domains, nonzero denominators, ranges of variables).
- Prove what you can, with tactics such as `norm_num`, `ring`, `linarith`, `nlinarith`, `positivity`, `simp`, `field_simp`, `omega`, `decide`, or explicit steps. Where a step can't be proved, write `sorry` and a comment saying why.
- If a statement in the document is false, formalize the corrected statement, and say in a comment what was changed.
- Use current Mathlib names; don't invent lemmas. Prefer a statement you can state correctly over a proof you can't finish.

After the code block, add a short Markdown section that lists what was formalized, which assumptions you made explicit, and which steps are left as `sorry` and why. """


def _math_line(kind: str, dialect: str) -> str:
    """How to write math in the reply's prose - in the notation the client
    renders this document with (`dialect`), or it shows up as raw text. A
    hybrid document's $...$ is AsciiMath, so it gets AsciiMath too."""
    where = "the summary, problems and corrections" if kind == "evaluate" else "the notes after the code"
    if dialect in ("asciimath", "hybrid"):
        return (
            f"In {where}, write every formula as AsciiMath between single dollar signs - for example "
            "$x^2 - 5x + 6 = (x-2)(x-3)$, $(a+b)/(c)$, $sqrt(x)$, $int_0^1 f(x) dx$, $lim_(x->0) f(x)$ - "
            "never LaTeX commands such as \\frac, \\sqrt or \\int. "
        )
    return (
        f"In {where}, write every formula as LaTeX between single dollar signs - for example "
        "$\\frac{a+b}{c}$, $\\sqrt{x}$, $\\int_0^1 f(x)\\,dx$. "
    )


def system_prompt(kind: str, language: str, dialect: str = "latex") -> str:
    base = EVALUATE_SYSTEM if kind == "evaluate" else FORMALIZE_SYSTEM
    return base + _math_line(kind, dialect) + _language_line(language)


def user_message(kind: str, filename: str, content: str) -> str:
    task = "Evaluate" if kind == "evaluate" else "Formalize"
    return f'{task} this document, "{filename}".\n\n{_document_block(content)}'


_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*\n(.*?)\n```", re.DOTALL)


def _parse_json_object(text: str) -> dict | None:
    candidates = [text.strip()]
    candidates += _FENCED_JSON_RE.findall(text)
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def parse_evaluation(text: str) -> dict:
    """The model's reply as {verdict, score, summary, issues}, each field
    coerced to what the client expects. A reply that isn't JSON at all is
    kept whole as `raw`, so the client can still show what came back."""
    data = _parse_json_object(text)
    if data is None:
        return {"verdict": None, "score": None, "summary": "", "issues": [], "raw": text}
    verdict = data.get("verdict") if data.get("verdict") in VERDICTS else None
    try:
        score = max(0, min(100, int(data.get("score"))))
    except (TypeError, ValueError):
        score = None
    issues = []
    for item in data.get("issues") or []:
        if not isinstance(item, dict):
            continue
        severity = item.get("severity") if item.get("severity") in SEVERITIES else "warning"
        issues.append(
            {
                "severity": severity,
                "quote": str(item.get("quote") or ""),
                "problem": str(item.get("problem") or ""),
                "correction": str(item.get("correction") or ""),
            }
        )
    return {"verdict": verdict, "score": score, "summary": str(data.get("summary") or ""), "issues": issues}


_LEAN_BLOCK_RE = re.compile(r"^(`{3,}|~{3,})[ \t]*lean4?[ \t]*\n(.*?)\n\1[ \t]*$", re.DOTALL | re.MULTILINE)


def parse_formalization(text: str) -> dict:
    """The model's reply as {code, notes}: the first ```lean block, and
    everything else as Markdown. No block means no code."""
    match = _LEAN_BLOCK_RE.search(text)
    if not match:
        return {"code": "", "notes": text.strip()}
    notes = (text[: match.start()] + text[match.end() :]).strip()
    return {"code": match.group(2), "notes": notes}
