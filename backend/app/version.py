"""The running build's frontend version: a hash of every file the browser
loads from this server (frontend/ and glasses/), taken once at startup.

Open tabs keep running whatever JavaScript they loaded, so after a deploy
an editor tab opened earlier silently sends live updates in the old shape
(a glasses screen once stayed in document view for exactly that reason).
Pages compare this against the version they started with - see
GET /api/public/version - and the editor offers a reload while the glasses
screen, which has no way to be reloaded by hand, reloads itself.
"""

import hashlib
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
_WATCHED = ("frontend", "glasses")


def _compute() -> str:
    digest = hashlib.sha256()
    for top in _WATCHED:
        base = _ROOT / top
        if not base.exists():
            continue
        for path in sorted(p for p in base.rglob("*") if p.is_file()):
            digest.update(str(path.relative_to(_ROOT)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


APP_VERSION = _compute()
