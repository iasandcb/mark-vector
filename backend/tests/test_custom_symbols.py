from app.custom_symbols import build_config, parse_custom_symbols_rows
from app.latex_to_asciimath import convert_document_to_asciimath, convert_math_to_asciimath


class TestParseCustomSymbolsRows:
    def test_empty_content_is_no_rows(self):
        assert parse_custom_symbols_rows("") == []

    def test_parses_token_and_latex_columns(self):
        rows = parse_custom_symbols_rows("pmf, \\text{pmf}\nsuu, \\sqcup\n")
        assert rows == [("pmf", "\\text{pmf}"), ("suu", "\\sqcup")]

    def test_skips_blank_lines_and_incomplete_rows(self):
        rows = parse_custom_symbols_rows("\npmf, \\text{pmf}\n\nno_comma_here\n")
        assert rows == [("pmf", "\\text{pmf}")]


class TestBuildConfig:
    def test_empty_csv_is_a_strict_no_op(self):
        config = build_config("")
        assert config.custom_macros == {}
        assert config.custom_text == {}

    def test_bare_macro_row_becomes_custom_macro(self):
        config = build_config("suu, \\sqcup")
        assert config.custom_macros == {"sqcup": "suu"}

    def test_text_row_becomes_custom_text(self):
        config = build_config("pmf, \\text{pmf}")
        assert config.custom_text == {"pmf": "pmf"}

    def test_unrecognized_shape_is_skipped(self):
        # \frac{...}{...} isn't a shape build_config knows how to reverse.
        config = build_config("d/dt, \\frac{\\text{d}}{\\text{d}t}")
        assert config.custom_macros == {}
        assert config.custom_text == {}


class TestWiredIntoConversion:
    def test_convert_document_applies_custom_symbols(self):
        config = build_config("suu, \\sqcup")
        out = convert_document_to_asciimath(r"$a \sqcup b$", config)
        assert "a suu b" in out

    def test_convert_math_applies_custom_symbols(self):
        config = build_config("pmf, \\text{pmf}")
        out, needs_directive = convert_math_to_asciimath(r"$\text{pmf}(x)$", config)
        assert out == "$pmf ( x )$"
        assert needs_directive is True

    def test_no_config_behaves_like_before(self):
        out, needs_directive = convert_math_to_asciimath(r"$\frac{1}{2}$")
        assert out == "$1/2$"
        assert needs_directive is True
