"""The preview pane's two LLM readings of a document (routers/analysis.py):

- evaluate: how sound the document is, and where it goes wrong - a JSON
  report whose issues quote the text they're about, so the client can find
  each one in the editor. Three lenses, each its own kind and saved result:
  "evaluate" (the mathematics), "evaluate-logic" (facts and reasoning, any
  subject) and "evaluate-writing" (clarity, structure, grammar).
- evaluate-live: the same check, a passage at a time while a lecture is
  being written down (dictated, typed, or a script being edited) - only
  what changed since the last check is sent, with the text before it as
  context, and the issues found pile up in one saved record.
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

SEVERITIES = ("error", "warning", "suggestion", "answer")
VERDICTS = ("sound", "minor_issues", "flawed", "no_math", "no_claims")


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


_EVALUATE_INTROS = {
    "evaluate": """You are a careful mathematics reviewer. You will be given a Markdown document - notes, a solution, a proof, a lesson - and you judge how mathematically sound it is: whether its definitions are coherent, its statements true, its computations correct, and each step of its reasoning justified by what came before.

Check every computation yourself. Distinguish real errors (a false statement, a wrong result, a step that does not follow, a missing case that breaks the argument) from weaknesses (an unstated assumption, a gap a reader can fill, ambiguous notation) and from mere suggestions. Do not report style, wording or formatting unless it changes the mathematics. If the document is correct, say so and report no issues - do not invent problems.""",
    "evaluate-logic": """You are a careful fact-checker and reviewer of reasoning. You will be given a Markdown document on any subject - an essay, a report, notes, an explanation, a proposal - and you judge how sound it is: whether its factual claims (names, dates, figures, quotations, how things work) are accurate, whether it is consistent with itself, and whether its conclusions follow from what it offers in support of them.

Distinguish real errors (a claim you are confident is false, a contradiction, a conclusion that does not follow, a fallacy that carries the argument) from weaknesses (a claim stated without the support it needs, an unstated assumption, an overgeneralization, a claim you can't confirm and that looks doubtful) and from mere suggestions. Report a claim as false only when you are confident it is; when you can't tell - recent events, private or very specialised facts - say so in the problem rather than guessing. Check any calculations too. Do not report style, wording or formatting - only what is true and what follows. If the document holds up, say so and report no issues - do not invent problems.""",
    "evaluate-writing": """You are a careful editor. You will be given a Markdown document on any subject, and you judge how well it is written for its evident purpose and reader: whether it is clear, well organised, concise, and correct in grammar, spelling and punctuation, and whether its terms and tone are consistent.

Distinguish real errors (a grammar or spelling mistake, a sentence that says something other than what is meant, a passage a reader can't follow) from weaknesses (a confusing or overlong passage, a jump in the structure, repetition, inconsistent terms) and from mere suggestions (a better word, a tighter sentence). Judge the writing, not whether its claims are true. Respect the author's voice and the document's conventions - don't rewrite for taste. If the document reads well, say so and report few or no issues - do not invent problems.""",
}

_EVALUATE_SCORE = {
    "evaluate": "how mathematically sound the document is",
    "evaluate-logic": "how accurate and well-reasoned the document is",
    "evaluate-writing": "how well written the document is",
}

# The verdict for a document there's nothing to judge in, by kind - the
# writing lens always has something to read.
_EVALUATE_EMPTY = {
    "evaluate": ("no_math", "the document has no mathematical content to judge"),
    "evaluate-logic": ("no_claims", "the document makes no factual claims or arguments to judge"),
}

EVALUATE_KINDS = tuple(_EVALUATE_INTROS)


def _evaluate_system(kind: str) -> str:
    empty = _EVALUATE_EMPTY.get(kind)
    verdicts = '"sound" | "minor_issues" | "flawed"' + (f' | "{empty[0]}"' if empty else "")
    empty_line = f'Use "{empty[0]}" (with score 100 and no issues) when {empty[1]}. ' if empty else ""
    return f"""{_EVALUATE_INTROS[kind]}

Math in the document may be written in LaTeX or in AsciiMath (a `<!-- math: asciimath -->` line marks AsciiMath); read it in whichever it uses.

Reply with ONE JSON object and nothing else - no code fence, no text before or after it:

{{
  "verdict": {verdicts},
  "score": <integer 0-100: {_EVALUATE_SCORE[kind]}>,
  "summary": "<two or three sentences: what the document does and how it holds up>",
  "issues": [
    {{
      "severity": "error" | "warning" | "suggestion",
      "quote": "<the exact text the issue is about, copied character for character from the document - a short span, at most one line>",
      "problem": "<what is wrong and why>",
      "correction": "<what it should be, or how to fix it; empty if there's nothing to add>"
    }}
  ]
}}

{empty_line}List issues in document order. """


LIVE_CONTEXT_CHARS = 3_000
LIVE_PASSAGE_MAX_CHARS = 8_000
LIVE_MAX_ISSUES = 300
# How many earlier findings each step lists as already reported, and how
# much of each one's problem text goes with it.
LIVE_REPORTED_LISTED = 30
LIVE_REPORTED_PROBLEM_CHARS = 120
# A quote this short is never matched as part of a longer one (_same_quote).
LIVE_MIN_CONTAINED_CHARS = 6

LIVE_SYSTEM = """You check a lecture for mistakes while it is being given. The lecture is being written down as it goes - dictated by speech recognition, typed live, or a prepared script being edited - and you are shown one new passage at a time, with the text before it for context.

Report only real problems in the NEW passage: a factual claim you are confident is false, a wrong computation or formula, a mathematical statement that is false or a step that does not follow, a contradiction with the context. Check every computation yourself. Report a doubtful claim you can't confirm only if it matters, as a warning that says you couldn't confirm it.

The speaker may also ask you something in passing - a fact, a number, a definition, a quick check ("한국 인구가 얼마죠?", "what's the derivative of tan x again?"). Answer such a question as an "answer" item: the quote is the question, the problem field holds the answer - direct and short, a sentence or two with the key figure or fact first (say how current a changing figure is). Leave out rhetorical questions put to the audience that the lecture goes on to answer itself.

Stay quiet otherwise. The text may be a speech transcript: ignore filler words, repetition, recognition slips that don't change the meaning, loose grammar, and a sentence cut off at the end of the passage (the speaker is mid-sentence - it will come again, complete, in the next passage). Do not report style, wording or formatting, and do not repeat problems in the context or ones listed as already reported. Most passages have no problems; then return no issues.

Math may be written in LaTeX or in AsciiMath (a `<!-- math: asciimath -->` line marks AsciiMath), or spoken out in words.

Reply with ONE JSON object and nothing else - no code fence, no text before or after it:

{
  "issues": [
    {
      "severity": "error" | "warning" | "answer",
      "quote": "<the exact text the issue is about, copied character for character from the NEW passage - a short span, at most one line>",
      "problem": "<what is wrong and why, in a sentence or two - or, for an answer, the answer>",
      "correction": "<what it should be; empty if there's nothing to add>"
    }
  ]
}

"""


def live_system_prompt(language: str, dialect: str = "latex", custom_symbols=()) -> str:
    return LIVE_SYSTEM + _asciimath_guide(dialect, custom_symbols) + _math_line("evaluate", dialect) + _language_line(language)


def live_user_message(filename: str, content: str, start: int, end: int, reported: list[dict] | tuple = ()) -> str:
    """`reported` is what earlier steps already found (the saved record's
    issues): the newest of them are listed so the model doesn't raise them
    again - the passage reaches back over text already checked (see
    changedRegion in analysis.js), and a repeat rarely quotes exactly the
    same span, so merge_live alone can't catch every one."""
    start = max(0, min(start, len(content)))
    end = max(start, min(end, len(content), start + LIVE_PASSAGE_MAX_CHARS))
    context = content[max(0, start - LIVE_CONTEXT_CHARS) : start]
    message = (
        f'Lecture "{filename}". The text so far, for context:\n<context>\n{context}\n</context>\n\n'
        f"Check this new passage:\n<passage>\n{content[start:end]}\n</passage>"
    )
    recent = [issue for issue in reported if issue.get("quote")][-LIVE_REPORTED_LISTED:]
    if recent:
        lines = "\n".join(f'- "{issue["quote"]}": {issue.get("problem", "")[:LIVE_REPORTED_PROBLEM_CHARS]}' for issue in recent)
        message += (
            "\n\nAlready reported - don't report any of these again, even if the passage repeats the text or you'd quote it differently:\n"
            f"<reported>\n{lines}\n</reported>"
        )
    return message


def parse_live(text: str) -> list[dict]:
    """The model's reply as a list of issues; anything unreadable is none."""
    return parse_evaluation(text)["issues"] if _parse_json_object(text) is not None else []


_QUOTE_NOISE_RE = re.compile(r"[\s.,!?;:…\"'“”‘’`()\[\]{}·、。，！？「」]+")


def _quote_key(quote: str) -> str:
    return _QUOTE_NOISE_RE.sub("", quote).lower()


def _same_quote(a: str, b: str) -> bool:
    """The same spot, quoted again: equal once spacing, punctuation and case
    are set aside, or one quote a longer or shorter span of the other - as
    long as the shorter one is long enough to mean something (a bare "x" or
    "2" turns up all over a lecture)."""
    if a == b:
        return True
    short, long = sorted((a, b), key=len)
    return len(short) >= LIVE_MIN_CONTAINED_CHARS and short in long


def merge_live(record: dict | None, issues: list[dict], at: str) -> dict:
    """Adds a step's issues to the saved live record - skipping ones already
    there for the same quote (see _same_quote), which a passage re-sent with
    its sentence finished would otherwise report twice."""
    kept = list((record or {}).get("issues") or [])
    seen = [key for issue in kept if issue.get("quote") and (key := _quote_key(issue["quote"]))]
    added = []
    for issue in issues:
        key = _quote_key(issue["quote"] or "")
        if key and any(_same_quote(key, other) for other in seen):
            continue
        if key:
            seen.append(key)
        added.append({**issue, "at": at})
    return {"issues": (kept + added)[-LIVE_MAX_ISSUES:], "checks": (record or {}).get("checks", 0) + 1, "added": added}


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
    where = "the summary, problems and corrections" if kind in EVALUATE_KINDS else "the notes after the code"
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


# AsciiMath's multi-letter symbols, which read letter by letter look like
# products of variables - "v^TT" taken as v^T times a matrix T, when it is
# v transposed.
ASCIIMATH_TOKENS = (
    "TT = ⊤ (transpose: v^TT is v transposed), xx = ×, * = ⋅, ** = ∗, -: = ÷, o. = ⊙, ox = ⊗, o+ = ⊕, "
    "RR = ℝ, NN = ℕ, ZZ = ℤ, QQ = ℚ, CC = ℂ, AA = ∀, EE = ∃, del = ∂, grad = ∇, oo = ∞, O/ = ∅, "
    "^^ = ∧, vv = ∨, ~= = ≅, ~~ = ≈, -= = ≡, != = ≠, <= = ≤, >= = ≥, -> = →, => = ⇒, <=> = ⇔, |-> = ↦, "
    "in = ∈, !in = ∉, sub = ⊂, sube = ⊆, uu = ∪, nn = ∩, prop = ∝, (: :) = ⟨ ⟩, |__ __| = ⌊ ⌋, |~ ~| = ⌈ ⌉"
)
CUSTOM_SYMBOLS_MAX = 200


def _asciimath_guide(dialect: str, custom_symbols) -> str:
    """How to read an AsciiMath document's math: its multi-letter symbols,
    and the workspace's own (data/custom-symbols.csv, as (token, latex)
    rows). Nothing for a LaTeX document."""
    if dialect not in ("asciimath", "hybrid"):
        return ""
    guide = (
        "\n\nThis document's math is AsciiMath. Its symbols are tokens of one or more characters, matched longest first: "
        "read each as the single symbol it stands for, never as separate letters multiplied together - "
        f"{ASCIIMATH_TOKENS}. Parentheses right after /, ^ or _ only group, as in (a+b)/(c) or e^(i x)."
    )
    rows = list(custom_symbols)[:CUSTOM_SYMBOLS_MAX]
    if rows:
        listed = "; ".join(f"{token} = {latex}" for token, latex in rows)
        guide += f" This workspace also defines its own tokens (token = LaTeX it stands for), read the same way: {listed}."
    return guide + "\n\n"


def system_prompt(kind: str, language: str, dialect: str = "latex", custom_symbols=()) -> str:
    base = _evaluate_system(kind) if kind in EVALUATE_KINDS else FORMALIZE_SYSTEM
    return base + _asciimath_guide(dialect, custom_symbols) + _math_line(kind, dialect) + _language_line(language)


def user_message(kind: str, filename: str, content: str) -> str:
    task = "Evaluate" if kind in EVALUATE_KINDS else "Formalize"
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
