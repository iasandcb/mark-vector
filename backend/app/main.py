import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from .version import APP_VERSION

from .auth import AuthMiddleware, is_authenticated
from .auth import router as auth_router
from .routers import (
    analysis,
    convert,
    conversations,
    document_sync,
    custom_symbols,
    hermes,
    ingest,
    live,
    projects,
    providers,
    public,
    recordings,
    spoken_math,
    stt,
    system_prompt,
    transcribe,
    volume,
    worker,
    x_articles,
)

BASE_DIR = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
GLASSES_DIR = BASE_DIR / "glasses"

app = FastAPI(title="mark-vector")

# No-op until GOOGLE_CLIENT_ID/SECRET are actually set (see
# auth.AuthMiddleware's docstring) - added first so it wraps every route
# below, including the ones mounted by the routers.
app.add_middleware(AuthMiddleware)
app.include_router(auth_router)

app.include_router(projects.router)
app.include_router(conversations.router)
app.include_router(document_sync.router)
app.include_router(analysis.router)
app.include_router(providers.router)
app.include_router(system_prompt.router)
app.include_router(custom_symbols.router)
app.include_router(spoken_math.router)
app.include_router(convert.router)
app.include_router(hermes.router)
app.include_router(public.router)
app.include_router(live.router)
app.include_router(transcribe.router)
app.include_router(stt.router)
app.include_router(recordings.router)
app.include_router(volume.router)
app.include_router(ingest.router)
app.include_router(worker.router)
app.include_router(x_articles.router)


class NoCacheStaticFiles(StaticFiles):
    """Scripts and styles are not stored at all. `no-cache` still lets iOS
    WebKit (Safari, Orion, an installed home-screen app) reuse a module it
    already parsed, so a deployed tab fix kept running the previous bundle.
    Other static files revalidate, and the ETag/Last-Modified Starlette
    sends still lets an unchanged file come back as a cheap 304."""

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        full_path = args[0] if args else kwargs.get("full_path", "")
        suffix = str(full_path).rsplit(".", 1)[-1].lower()
        if suffix in {"js", "mjs", "css"}:
            response.headers["Cache-Control"] = "no-store"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


def editor_index_html() -> str:
    """The shell the browser actually loads. The entry module and every
    module it imports carry the build version, so a new deploy cannot be
    served from a cached `/static/js/app.js` with no query string."""
    html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
    version = APP_VERSION
    html = html.replace('href="/static/css/style.css"', f'href="/static/css/style.css?v={version}"', 1)
    html = html.replace('href="/static/css/workspace.css"', f'href="/static/css/workspace.css?v={version}"', 1)
    imports = {}
    root = FRONTEND_DIR / "static" / "js"
    for path in sorted(item for item in root.rglob("*") if item.is_file() and item.suffix in {".js", ".mjs"}):
        url = "/" + path.relative_to(FRONTEND_DIR).as_posix()
        imports[url] = f"{url}?v={version}"
    import_map = json.dumps({"imports": imports}, separators=(",", ":"))
    html = html.replace(
        '<script type="module" src="/static/js/app.js"></script>',
        f'<script type="importmap">{import_map}</script>\n  <script type="module" src="/static/js/app.js?v={version}"></script>',
        1,
    )
    return html


app.mount("/static", NoCacheStaticFiles(directory=FRONTEND_DIR / "static"), name="static")

# The glasses live-preview screen (see routers/live.py and glasses/app.js) -
# served with html=True so /glasses/ resolves to glasses/index.html, the
# same way a plain static host would.
app.mount("/glasses", NoCacheStaticFiles(directory=GLASSES_DIR, html=True), name="glasses")


@app.get("/")
def index(request: Request):
    # Signed in (or auth off): the app. Signed out: the public landing page
    # instead of a bare bounce to /login - it's what the service looks like
    # to anyone who isn't its owner. Same URL either way, so existing
    # bookmarks keep opening the app.
    if not is_authenticated(request):
        return FileResponse(FRONTEND_DIR / "landing.html", headers={"Cache-Control": "no-store", "Vary": "Cookie"})
    return HTMLResponse(editor_index_html(), headers={"Cache-Control": "no-store", "Vary": "Cookie"})


@app.get("/about")
def about():
    return FileResponse(FRONTEND_DIR / "landing.html", headers={"Cache-Control": "no-cache"})


@app.get("/login")
def login_page():
    return FileResponse(FRONTEND_DIR / "login.html", headers={"Cache-Control": "no-cache"})


@app.get("/p/{token}")
def public_view(token: str):
    # The token itself is validated client-side against /api/public/{token}
    # (see static/js/public.js) - this just always serves the same shell page.
    return FileResponse(FRONTEND_DIR / "public.html", headers={"Cache-Control": "no-cache"})
