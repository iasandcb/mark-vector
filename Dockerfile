# Build context is the repo root (not backend/): the image needs frontend/
# and glasses/ next to backend/, at the same relative layout as the repo.
FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# ffmpeg: transcription.py re-encodes an audio upload over the API's 25 MB
# cap into low-bitrate speech-grade Opus instead of splitting it (splitting
# would reset the speaker labels per chunk).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend
COPY glasses ./glasses

WORKDIR /app/backend
# --frozen: fail rather than silently drift from uv.lock. --no-dev: pytest
# etc. have no reason to ship in the deployed image.
RUN uv sync --frozen --no-dev

# DATA_DIR is set at runtime (see fly.toml) to wherever the persistent
# volume is mounted - not baked in here, since the default "../data" only
# makes sense for a local checkout that already has that directory sitting
# next to backend/.
ENV PORT=8080
EXPOSE 8080

# --proxy-headers/--forwarded-allow-ips: Fly's edge terminates TLS and
# proxies to this container over plain HTTP - without trusting its
# X-Forwarded-Proto, request.url_for() in auth.py would build the Google
# OAuth redirect_uri as http://... instead of https://..., which Google
# rejects as a mismatch against the redirect URI registered in the OAuth
# client.
CMD ["sh", "-c", "uv run uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
