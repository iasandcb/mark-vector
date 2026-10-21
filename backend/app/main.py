from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .auth import AuthMiddleware, is_authenticated
from .auth import router as auth_router
from .routers import (
    analysis,
    convert,
    conversations,
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
    worker,
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
app.include_router(ingest.router)
app.include_router(worker.router)


class NoCacheStaticFiles(StaticFiles):
    """This app is under active local development - without an explicit
    Cache-Control, browsers may serve a stale JS/CSS file from their own
    heuristic cache on a plain reload (not just skip revalidation), so a
    just-deployed fix can look like it never took effect. Force revalidation
    on every load instead; the ETag/Last-Modified Starlette already sends
    still let an unchanged file come back as a cheap 304."""

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


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
    page = "index.html" if is_authenticated(request) else "landing.html"
    return FileResponse(FRONTEND_DIR / page, headers={"Cache-Control": "no-cache, private", "Vary": "Cookie"})


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
