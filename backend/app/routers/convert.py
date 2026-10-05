from fastapi import APIRouter

from .. import storage
from ..custom_symbols import build_config
from ..latex_to_asciimath import convert_document_to_asciimath
from ..models import ConvertToAsciiMathRequest

router = APIRouter(prefix="/api/convert-to-asciimath", tags=["convert"])


@router.post("")
def convert_to_asciimath(req: ConvertToAsciiMathRequest):
    """On-demand LaTeX -> AsciiMath2 (or, with `hybrid`, dollar-only) for a
    whole document's current text - not tied to sending a message. The
    reverse direction (AsciiMath2 -> LaTeX) doesn't need a backend endpoint:
    it's done client-side in markdown.js, reusing the asciimath-parser
    instance already loaded there for rendering."""
    config = build_config(storage.get_global_custom_symbols())
    return {"content": convert_document_to_asciimath(req.content, config, req.hybrid)}
