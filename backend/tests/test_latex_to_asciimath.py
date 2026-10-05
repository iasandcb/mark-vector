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
