from fastapi import APIRouter, HTTPException

from .. import storage

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/custom-symbols")
def get_custom_symbols():
    """The same global AsciiMath2 custom-symbol table /api/custom-symbols
    serves the editor (see storage.get_global_custom_symbols - one shared
    CSV, no per-project override), duplicated here without the session-
    cookie auth that endpoint sits behind (see auth.py's _PUBLIC_PATH_PREFIXES),
    so static/js/public.js can apply it too - otherwise a published page
    using any custom symbol renders it as whatever bare AsciiMath2 fallback
    markdown.js's asciimath-parser would otherwise guess, same gap
    glasses/app.js's own comment about this endpoint describes for that
    screen. Registered before GET /{token} below so FastAPI/Starlette's
    first-match routing doesn't swallow "custom-symbols" as a token."""
    return {"content": storage.get_global_custom_symbols()}


@router.get("/{token}")
def get_published(token: str):
    """No auth - a published token is itself the access control (unguessable,
    minted by storage.publish_document). Always re-reads the document from
    disk, so an edit made after publishing shows up here without republishing."""
    try:
        return storage.resolve_published(token)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/{token}/resolve-link")
def resolve_link(token: str, target: str):
    """Called from public.js when a document-link inside a published page
    is clicked - see storage.resolve_published_link. `token` itself 404s if
    invalid; an unresolvable or unpublished `target` is a perfectly normal
    {"token": None} response, not an error."""
    try:
        return {"token": storage.resolve_published_link(token, target)}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Not found")
