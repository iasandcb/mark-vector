from app.latex_to_asciimath import (
    HYBRID_MATH_DIRECTIVE,
    MATH_DIRECTIVE,
    convert_document_to_asciimath,
    convert_math_to_asciimath,
)


class TestConvertDocumentToAsciimath:
    """convert_document_to_asciimath is the on-demand, whole-document
    variant (the "AsciiMath" format radio in the editor toolbar) -
    different contract from convert_math_to_asciimath: always prepends the
    directive (an explicit, deliberate format choice, not conditional on
    whether anything actually converted), and takes/returns one complete
    document string instead of (text, needs_directive)."""

    def test_converts_math_and_prepends_directive(self):
        out = convert_document_to_asciimath(r"질문 $\frac{1}{2}$ 그리고 $$x^2$$")
        assert out == f"{MATH_DIRECTIVE}\n질문 $1/2$ 그리고 $$x^2$$"

    def test_prepends_directive_even_with_no_math_to_convert(self):
        # A deliberate "make this document AsciiMath" choice should stick
        # even if there's nothing to convert yet - otherwise it wouldn't
        # override a different inherited default from the session/project/
        # global system prompt once the user does start typing formulas.
        out = convert_document_to_asciimath("아직 수식이 없는 문서")
        assert out == f"{MATH_DIRECTIVE}\n아직 수식이 없는 문서"

    def test_replaces_a_stale_directive_rather_than_leaving_it_to_shadow_the_new_one(self):
        # markdown.js's directive scan takes the *last* occurrence in the
        # document - so appending the new directive without removing an
        # old one further down would leave the old one winning.
        out = convert_document_to_asciimath("<!-- math: latex -->\n$\\frac{1}{2}$")
        assert out == f"{MATH_DIRECTIVE}\n$1/2$"
        assert out.count("<!-- math:") == 1

    def test_hybrid_converts_dollar_spans_and_leaves_bracket_spans_alone(self):
        out = convert_document_to_asciimath(r"$\frac{1}{2}$ and \(\frac{1}{3}\) and \[x^2\]", hybrid=True)
        assert out == f"{HYBRID_MATH_DIRECTIVE}\n$1/2$ and \\(\\frac{{1}}{{3}}\\) and \\[x^2\\]"

    def test_hybrid_prepends_the_hybrid_directive_even_with_nothing_to_convert(self):
        out = convert_document_to_asciimath("no math yet", hybrid=True)
        assert out == f"{HYBRID_MATH_DIRECTIVE}\nno math yet"


def test_successful_conversion_reports_directive_needed():
    out, needs_directive = convert_math_to_asciimath(r"$\frac{1}{2}$")
    assert out == "$1/2$"
    assert needs_directive is True


def test_hybrid_leaves_bracket_block_and_inline_spans_untouched():
    out, needs_directive = convert_math_to_asciimath(
        r"$\frac{1}{2}$ \(\frac{1}{3}\)" + "\n" + r"\[x^2\]", hybrid=True
    )
    assert out == "$1/2$ \\(\\frac{1}{3}\\)\n\\[x^2\\]"
    assert needs_directive is True  # the $ span did convert


def test_hybrid_with_only_bracket_spans_needs_no_directive():
    out, needs_directive = convert_math_to_asciimath(r"\(\frac{1}{3}\)", hybrid=True)
    assert out == r"\(\frac{1}{3}\)"
    assert needs_directive is False


def test_all_spans_failing_does_not_need_directive():
    # \begin{tikzpicture} has no AsciiMath2 rendering (see asciimath2's
    # "Scope, honestly") - a document where every math span fails to
    # convert should stay pure LaTeX and report no directive needed, since
    # the directive only means something once at least one span actually
    # became AsciiMath2. This used to be wrong: `converted_any` tracked "a
    # math span was found", not "a math span actually converted", so a
    # document like this reported needing the directive despite nothing
    # having changed.
    out, needs_directive = convert_math_to_asciimath(
        r"\[ \begin{tikzpicture}\end{tikzpicture} \]"
    )
    assert needs_directive is False
    assert r"\begin{tikzpicture}" in out


def test_mixed_success_and_failure_still_needs_directive():
    text = "a: $\\frac{1}{2}$\n\nb: \\(\\begin{tikzpicture}\\end{tikzpicture}\\)"
    out, needs_directive = convert_math_to_asciimath(text)
    assert needs_directive is True
    assert "1/2" in out  # converted
    assert r"\begin{tikzpicture}" in out  # left as LaTeX


def test_indented_bracket_block_is_recognized():
    # A block formula continuing a numbered-list item is commonly indented
    # by the LLM - the block-detection regex used to require the marker at
    # column 0, so an indented block was silently left as plain text
    # (not even wrapped in \[...\] for LaTeX fallback rendering).
    text = "1. foo\n   \\[\n   \\frac{1}{2}\n   \\]\n   bar"
    out, needs_directive = convert_math_to_asciimath(text)
    assert "$$" in out
    assert "1/2" in out  # actually converted, not left as LaTeX
    assert "\\[" not in out and "\\frac" not in out
    assert needs_directive is True


def test_indented_dollar_block_is_recognized():
    text = "1. foo\n   $$\n   \\frac{1}{2}\n   $$\n   bar"
    out, needs_directive = convert_math_to_asciimath(text)
    assert "1/2" in out
    assert needs_directive is True


def test_unconvertible_document_is_unchanged_apart_from_delimiter_form():
    # No directive needed, and the content is semantically untouched (still
    # LaTeX, just normalized to \[...\] block form).
    out, needs_directive = convert_math_to_asciimath(
        r"$$ \begin{tikzpicture}\end{tikzpicture} $$"
    )
    assert out == r"\[\begin{tikzpicture}\end{tikzpicture}\]"
    assert needs_directive is False


def test_dollar_bracket_typo_is_recovered():
    # A real LLM typo: "$[" where "\[" or "$$" was meant. Recognized as an
    # opener, closed by either "$$" or "\]" (whichever the model actually
    # typed - its choice of closer is as unreliable as its opener was).
    text = "$[\n\\frac{1}{2}\n$$"
    out, needs_directive = convert_math_to_asciimath(text)
    assert out == "$$\n1/2\n$$"
    assert needs_directive is True


def test_dollar_bracket_typo_closed_with_bracket():
    text = "$[\n\\frac{1}{2}\n\\]"
    out, needs_directive = convert_math_to_asciimath(text)
    assert out == "$$\n1/2\n$$"
    assert needs_directive is True


def test_unrecoverable_dollar_bracket_falls_through_as_text():
    text = "$[\nno closer here\n"
    out, needs_directive = convert_math_to_asciimath(text)
    assert "$[" in out
    assert needs_directive is False


def test_unclosed_block_does_not_swallow_the_rest_of_the_document():
    # An unclosed "\[" (no "\]" anywhere in its paragraph) with an unrelated
    # later line that happens to end in "\]" (not intended as its closer at
    # all - just prose that happens to end that way). The multi-line scan
    # used to search for the next "\]" *anywhere later in the document* to
    # close it, so that unrelated line got misread as this one's closer -
    # collapsing every paragraph, heading, and formula in between into one
    # broken, single-line \[...\] block. The unclosed opener should be the
    # only casualty: everything after its paragraph must come through
    # untouched, including the real formula and the coincidental "\]".
    text = (
        "intro\n"
        "\n"
        "broken:\n"
        "\\[\n"
        "x\n"
        "\n"
        "# Still A Real Heading\n"
        "\n"
        "prose that happens to end in a bracket \\]\n"
        "\n"
        "$\\frac{1}{2}$\n"
    )
    out, needs_directive = convert_math_to_asciimath(text)
    assert "# Still A Real Heading" in out
    assert "1/2" in out
    assert "\\[" in out  # the unclosed opener itself is left untouched
    assert needs_directive is True


def test_unclosed_display_dollar_does_not_swallow_the_next_paragraph():
    text = "intro $$\n\n# Heading\n\n$\\frac{1}{2}$\n"
    out, needs_directive = convert_math_to_asciimath(text)
    assert out == "intro $$\n\n# Heading\n\n$1/2$\n"
    assert needs_directive is True


def test_two_display_formulas_do_not_swallow_the_prose_between_them():
    # A greedy "$$...$$" match used to run from the first "$$" on the line
    # to the last, so the Korean between two formulas was converted as math
    # and came back with a space between every syllable ("그 리 고").
    out = convert_document_to_asciimath(r"$$\frac{a}{b}$$ 그리고 $$\sqrt{x}$$ 와 $x^2$")
    assert out == f"{MATH_DIRECTIVE}\n$$a/b$$ 그리고 $$sqrt(x)$$ 와 $x^2$"
    assert "그 리" not in out


def test_display_opener_with_text_before_it_still_converts():
    text = "질문 $$\n\\frac{a}{b}\n$$ 끝"
    out = convert_document_to_asciimath(text)
    assert "질문" in out
    assert "끝" in out
    assert "a/b" in out
    assert r"\frac" not in out


def test_frac_is_not_emitted_character_by_character():
    out = convert_document_to_asciimath(r"인라인 $\frac{a}{b}$ 와 $$\frac{1}{2}$$")
    assert r"\ f" not in out
    assert "f r a c" not in out
    assert "$a/b$" in out
    assert "1/2" in out


def test_realistic_latex_document_with_korean_around_the_math():
    text = (
        "한글 설명입니다. 인라인 $\\frac{a}{b}$ 와 $\\sqrt{x}$, $x^2$, $\\alpha$.\n"
        "\n"
        "$$\n"
        "\\sum_{i=1}^{n} i^2\n"
        "$$\n"
        "\n"
        "적분 $\\int_{0}^{1} x^{2}\\,dx$ 그리고 $\\mathbb{R}$.\n"
    )
    out = convert_document_to_asciimath(text)
    assert out.startswith(MATH_DIRECTIVE)
    assert "한글 설명입니다." in out
    assert "그리고" in out
    assert "한 글" not in out
    assert "$a/b$" in out
    assert "$sqrt(x)$" in out
    assert "$x^2$" in out
    assert "$alpha$" in out
    assert "sum_(i = 1)^n i^2" in out
    assert "int_0^1" in out
    assert "$RR$" in out
    assert r"\frac" not in out
    assert r"\sqrt" not in out
    assert r"\alpha" not in out
    assert r"\sum" not in out
    assert r"\int" not in out
    assert r"\mathbb" not in out


def test_hangul_inside_a_formula_is_not_split_into_syllables():
    # asciimath2 itself separates every Hangul syllable. The prose around
    # the formula must stay untouched, and a Korean word inside the formula
    # should not come back syllable-spaced either.
    out, needs_directive = convert_math_to_asciimath(r"앞 $\frac{한글}{b}$ 뒤")
    assert needs_directive is True
    assert out == "앞 $(한글)/b$ 뒤"


def test_character_spaced_library_output_is_rejected(monkeypatch):
    # The reported failure mode: the converter echoes the LaTeX source with
    # a space between every character. That is not AsciiMath, so the span
    # stays LaTeX (still renderable) instead of being written back broken.
    def spaced(latex, config=None):
        return " ".join(latex)

    monkeypatch.setattr("app.latex_to_asciimath._to_asciimath2", spaced)
    out, needs_directive = convert_math_to_asciimath(r"$\frac{a}{b}$")
    assert needs_directive is False
    assert r"\frac{a}{b}" in out
    assert r"\ f r a c" not in out


def test_bare_frac_does_not_fail_the_whole_document():
    # asciimath2 raises AttributeError (not UnsupportedLatexError) when
    # \frac has no arguments. One bad span must not abort the conversion.
    out, needs_directive = convert_math_to_asciimath(r"앞 $\frac$ 와 $\frac{a}{b}$ 뒤")
    assert needs_directive is True
    assert "a/b" in out
    assert r"\frac" in out  # the bare one is kept as LaTeX
