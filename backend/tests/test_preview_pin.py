"""The split-view preview pin is a frontend choice. These tests lock the
page control and run the same resolution the editor uses."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_editor_page_offers_a_preview_pin_without_removing_split_share_actions():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert 'id="preview-pin"' in html
    assert "hidden" in html.split('id="preview-pin"', 1)[1].split(">", 1)[0]
    assert 'data-pin="auto"' in html
    assert 'data-pin="left"' in html
    assert 'data-pin="right"' in html
    assert 'id="publish-btn-b"' in html
    assert 'id="export-x-article-btn-b"' in html


def test_preview_pin_labels_include_korean():
    text = (ROOT / "frontend" / "static" / "js" / "i18n.js").read_text(encoding="utf-8")
    assert '"preview.pinAuto": "자동"' in text
    assert '"preview.pinLeft": "왼쪽"' in text
    assert '"preview.pinRight": "오른쪽"' in text


def test_preview_pin_resolution_suite():
    result = subprocess.run(
        ["node", "--test", "frontend/static/js/preview-pin.test.mjs"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + "\n" + result.stderr
