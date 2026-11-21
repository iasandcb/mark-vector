"""Disk use of the data directory, and safe deletion of recording files.

Recordings live only under ``projects/<id>/conversations/<id>/.recordings/``
(see storage.RECORDINGS_DIRNAME). Derived mono copies live in a ``.play``
directory beside the original. Nothing else on the volume — documents,
``video-jobs.json``, a symlink that points out of that tree — is removed
from here.

YouTube state comes from the existing video-job registry. An original is
"uploaded" only when its job succeeded and carries a ``youtube_video_id``.
"""

import shutil
from pathlib import Path

from . import storage, video_jobs
from .config import settings

_ID_RE_MAX = 64


def _threshold() -> float:
    try:
        value = float(settings.storage_warn_percent)
    except (TypeError, ValueError):
        return 80.0
    if value != value or value in (float("inf"), float("-inf")) or not 0 <= value <= 100:
        return 80.0
    return value


def usage_report() -> dict:
    """total / used / free bytes and percent for the configured data root.

    ``shutil.disk_usage`` reports the filesystem that holds ``DATA_DIR``,
    which on Fly is the 1 GB volume mounted at ``/data``. ``warning`` is
    true once used/total reaches ``STORAGE_WARN_PERCENT`` (default 80).
    """
    root = Path(settings.data_dir)
    root.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(root)
    ratio = (usage.used / usage.total * 100) if usage.total else 0.0
    threshold = _threshold()
    return {
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "percent_used": round(ratio, 2),
        "threshold_percent": threshold,
        "warning": ratio >= threshold,
    }


def _data_root() -> Path:
    root = Path(settings.data_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _check_id(value: str, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > _ID_RE_MAX:
        raise ValueError(f"Invalid {label}")
    if value in {".", ".."} or any(c in value for c in "/\\\x00"):
        raise ValueError(f"Invalid {label}")
    if not value[0].isalnum() or not all(c.isalnum() or c in "-_" for c in value):
        raise ValueError(f"Invalid {label}")
    return value


def _lexical_inside(path: Path, root: Path) -> bool:
    """True when ``path`` is strictly inside ``root``, without resolving links.

    ``Path.relative_to`` accepts a ``..`` segment (it returns ``../…``), so
    those parts are rejected on their own.
    """
    try:
        relative = path.absolute().relative_to(root.absolute())
    except ValueError:
        return False
    return bool(relative.parts) and ".." not in relative.parts


def _reject_escaped(path: Path, container: Path) -> None:
    """Refuse a path that is not lexically inside ``container``, or whose
    real parent (after resolving directory symlinks) leaves the data root
    or ``container``. The file itself may be a symlink: unlinking that
    entry removes the link, not whatever it points at."""
    data_root = _data_root()
    if not _lexical_inside(path, container):
        raise ValueError("Invalid recording path")
    parent = path.parent
    cur = parent
    root_abs = data_root.absolute()
    while True:
        cur_abs = cur.absolute()
        if cur_abs == root_abs:
            break
        if cur.is_symlink():
            raise ValueError("Invalid recording path")
        if cur.parent == cur:
            raise ValueError("Invalid recording path")
        cur = cur.parent
    if not parent.is_dir():
        raise FileNotFoundError(path.name)
    resolved_parent = parent.resolve()
    if not resolved_parent.is_relative_to(data_root.resolve()):
        raise ValueError("Invalid recording path")
    if not resolved_parent.is_relative_to(container.resolve()):
        raise ValueError("Invalid recording path")


def _entry_size(path: Path) -> int:
    try:
        return path.lstat().st_size
    except OSError:
        return 0


def _unlink_entry(path: Path, container: Path) -> int:
    _reject_escaped(path, container)
    if path.is_symlink() or path.is_file():
        size = _entry_size(path)
        path.unlink()
        return size
    raise FileNotFoundError(path.name)


def _titles(project_id: str, conv_id: str, cache: dict) -> tuple[str | None, str | None]:
    key = (project_id, conv_id)
    if key in cache:
        return cache[key]
    project_title = folder_title = None
    try:
        project_title = storage.get_project(project_id).get("title")
    except FileNotFoundError:
        pass
    try:
        folder_title = storage._read_meta(project_id, conv_id).get("title")
    except FileNotFoundError:
        pass
    cache[key] = (project_title, folder_title)
    return project_title, folder_title


def _uploaded(state: dict | None) -> bool:
    if not state:
        return False
    video_id = state.get("youtube_video_id")
    return state.get("status") == "succeeded" and isinstance(video_id, str) and bool(video_id.strip())


def _iter_recording_trees():
    """``(project_id, conv_id, recordings_dir)`` for real directories only.

    A symlinked project, conversation, or ``.recordings`` directory is
    skipped so a link that points outside the data root is never walked.
    """
    data = _data_root().resolve()
    projects = Path(settings.data_dir) / "projects"
    if not projects.is_dir() or projects.is_symlink():
        return
    if not projects.resolve().is_relative_to(data):
        return
    for project_dir in sorted(projects.iterdir(), key=lambda p: p.name):
        if not project_dir.is_dir() or project_dir.is_symlink():
            continue
        if not project_dir.resolve().is_relative_to(data):
            continue
        convs = project_dir / "conversations"
        if not convs.is_dir() or convs.is_symlink():
            continue
        for conv_dir in sorted(convs.iterdir(), key=lambda p: p.name):
            if not conv_dir.is_dir() or conv_dir.is_symlink():
                continue
            if not conv_dir.resolve().is_relative_to(data):
                continue
            recordings = conv_dir / storage.RECORDINGS_DIRNAME
            if not recordings.is_dir() or recordings.is_symlink():
                continue
            if not recordings.resolve().is_relative_to(data):
                continue
            yield project_dir.name, conv_dir.name, recordings


def _scan() -> tuple[list[dict], list[dict], list[dict]]:
    """Recordings, loose ``.play`` files, and every ``.play`` file.

    Each dict is JSON-safe (no ``Path``). ``_path`` / ``_container`` are
    internal and stripped before a response is returned.
    """
    states = video_jobs.recording_states()
    titles: dict = {}
    recordings: list[dict] = []
    loose: list[dict] = []
    plays: list[dict] = []
    for project_id, conv_id, recordings_dir in _iter_recording_trees():
        project_title, folder_title = _titles(project_id, conv_id, titles)
        for folder in sorted(recordings_dir.iterdir(), key=lambda p: p.name):
            if not folder.is_dir() or folder.is_symlink():
                continue
            if not folder.resolve().is_relative_to(recordings_dir.resolve()):
                continue
            try:
                storage._validate_filename(folder.name)
            except ValueError:
                continue
            originals: dict[str, Path] = {}
            for entry in sorted(folder.iterdir(), key=lambda p: p.name):
                if entry.name == storage.PLAYABLE_DIRNAME:
                    continue
                if not storage._RECORDING_ID_RE.match(entry.name):
                    continue
                if not (entry.is_file() or entry.is_symlink()):
                    continue
                if not _lexical_inside(entry, recordings_dir):
                    continue
                originals[entry.name] = entry
            play_dir = folder / storage.PLAYABLE_DIRNAME
            play_by_recording: dict[str, list[dict]] = {name: [] for name in originals}
            loose_here: list[dict] = []
            if play_dir.is_dir() and not play_dir.is_symlink() and play_dir.resolve().is_relative_to(recordings_dir.resolve()):
                ids_longest = sorted(originals, key=len, reverse=True)
                for entry in sorted(play_dir.iterdir(), key=lambda p: p.name):
                    if not (entry.is_file() or entry.is_symlink()):
                        continue
                    if entry.name in {".", ".."} or "/" in entry.name or "\\" in entry.name:
                        continue
                    if not _lexical_inside(entry, play_dir):
                        continue
                    owner = next((rid for rid in ids_longest if entry.name.startswith(rid + ".")), None)
                    info = {
                        "project_id": project_id,
                        "project_title": project_title,
                        "conv_id": conv_id,
                        "folder_title": folder_title,
                        "filename": folder.name,
                        "name": entry.name,
                        "size": _entry_size(entry),
                        "recording_id": owner,
                        "_path": entry,
                        "_container": play_dir,
                    }
                    plays.append(info)
                    if owner is None:
                        loose_here.append(info)
                    else:
                        play_by_recording[owner].append(info)
            for recording_id, path in originals.items():
                state = states.get((project_id, conv_id, folder.name, recording_id))
                uploaded = _uploaded(state)
                recordings.append(
                    {
                        "project_id": project_id,
                        "project_title": project_title,
                        "conv_id": conv_id,
                        "folder_title": folder_title,
                        "filename": folder.name,
                        "recording_id": recording_id,
                        "size": _entry_size(path),
                        "date": video_jobs.recording_created_at(recording_id),
                        "youtube_uploaded": uploaded,
                        "youtube_video_id": (state or {}).get("youtube_video_id"),
                        "video_status": (state or {}).get("status"),
                        "play_copies": [_public_play(item) for item in play_by_recording[recording_id]],
                        "_path": path,
                        "_container": folder,
                    }
                )
            for item in loose_here:
                loose.append(item)
    recordings.sort(key=lambda row: (row["date"], row["recording_id"]), reverse=True)
    return recordings, loose, plays


def _public_play(item: dict) -> dict:
    return {
        "project_id": item["project_id"],
        "project_title": item["project_title"],
        "conv_id": item["conv_id"],
        "folder_title": item["folder_title"],
        "filename": item["filename"],
        "name": item["name"],
        "size": item["size"],
        "recording_id": item["recording_id"],
    }


def _public_recording(item: dict) -> dict:
    return {key: value for key, value in item.items() if not key.startswith("_")}


def list_volume_recordings() -> dict:
    recordings, loose, _plays = _scan()
    return {
        "recordings": [_public_recording(item) for item in recordings],
        "loose_play_copies": [_public_play(item) for item in loose],
    }


def _parse_ref(item: dict) -> tuple[str, str, str, str]:
    if not isinstance(item, dict):
        raise ValueError("Invalid recording")
    project_id = _check_id(item.get("project_id"), "project id")
    conv_id = _check_id(item.get("conv_id"), "folder id")
    filename = item.get("filename")
    recording_id = item.get("recording_id")
    if not isinstance(filename, str) or not isinstance(recording_id, str):
        raise ValueError("Invalid recording")
    storage._validate_filename(filename)
    if not storage._RECORDING_ID_RE.match(recording_id):
        raise ValueError("Invalid recording id")
    return project_id, conv_id, filename, recording_id


def _locate(project_id: str, conv_id: str, filename: str, recording_id: str) -> tuple[Path, Path, Path]:
    """``(recording file, its directory, its .play directory)``."""
    recordings_root = (
        Path(settings.data_dir) / "projects" / project_id / "conversations" / conv_id / storage.RECORDINGS_DIRNAME
    )
    folder = recordings_root / filename
    path = folder / recording_id
    _reject_escaped(path, recordings_root)
    return path, folder, folder / storage.PLAYABLE_DIRNAME


def _plan_delete(ref: tuple[str, str, str, str]) -> dict:
    project_id, conv_id, filename, recording_id = ref
    path, folder, play_dir = _locate(project_id, conv_id, filename, recording_id)
    if not (path.is_file() or path.is_symlink()):
        raise FileNotFoundError(recording_id)
    copies = []
    if play_dir.is_dir() and not play_dir.is_symlink():
        for entry in play_dir.iterdir():
            if not (entry.is_file() or entry.is_symlink()):
                continue
            if entry.name.startswith(recording_id + ".") and _lexical_inside(entry, play_dir):
                copies.append(entry)
    return {
        "ref": ref,
        "path": path,
        "container": folder,
        "copies": copies,
        "play_dir": play_dir,
        "size": _entry_size(path) + sum(_entry_size(copy) for copy in copies),
    }


def _apply_plan(plan: dict) -> int:
    freed = 0
    freed += _unlink_entry(plan["path"], plan["container"])
    for copy in plan["copies"]:
        if copy.is_symlink() or copy.is_file():
            try:
                freed += _unlink_entry(copy, plan["play_dir"])
            except FileNotFoundError:
                continue
    project_id, conv_id, filename, recording_id = plan["ref"]
    video_jobs.forget(project_id=project_id, conv_id=conv_id, filename=filename, recording_id=recording_id)
    return freed


def delete_recordings(items: list) -> dict:
    """Delete the given originals and their ``.play`` copies.

    Every ref is checked before anything is removed. One path that leaves
    the recordings tree rejects the whole request. A recording that is
    already gone is reported as missing; when every one is missing, this
    raises ``FileNotFoundError``. Jobs for a removed recording are dropped
    so the queue does not keep pointing at a file that is gone.
    """
    if not isinstance(items, list) or not items:
        raise ValueError("Select at least one recording")
    if len(items) > 1000:
        raise ValueError("Too many recordings")
    refs = []
    seen = set()
    for item in items:
        ref = _parse_ref(item)
        if ref in seen:
            continue
        seen.add(ref)
        refs.append(ref)
    plans = []
    missing = 0
    for ref in refs:
        try:
            plans.append(_plan_delete(ref))
        except FileNotFoundError:
            missing += 1
    if not plans:
        raise FileNotFoundError("Recording not found")
    freed = 0
    deleted = []
    for plan in plans:
        freed += _apply_plan(plan)
        project_id, conv_id, filename, recording_id = plan["ref"]
        deleted.append(
            {
                "project_id": project_id,
                "conv_id": conv_id,
                "filename": filename,
                "recording_id": recording_id,
            }
        )
    return {
        "deleted": len(deleted),
        "missing": missing,
        "freed_bytes": freed,
        "recordings": deleted,
        "usage": usage_report(),
    }


def _cleanup_sets() -> tuple[list[dict], list[dict], int]:
    recordings, _loose, plays = _scan()
    originals = [_public_recording(item) for item in recordings if item["youtube_uploaded"]]
    play_public = [_public_play(item) for item in plays]
    freed = sum(item["size"] for item in originals) + sum(item["size"] for item in play_public)
    return originals, play_public, freed


def cleanup_preview() -> dict:
    """What a cleanup would remove, without deleting anything.

    Originals whose YouTube upload has finished, plus every ``.play`` copy
    (including copies of recordings that are kept).
    """
    originals, plays, freed = _cleanup_sets()
    return {"originals": originals, "play_copies": plays, "freed_bytes": freed}


def cleanup_apply() -> dict:
    originals, plays, freed = _cleanup_sets()
    refs = [
        (item["project_id"], item["conv_id"], item["filename"], item["recording_id"]) for item in originals
    ]
    for ref in refs:
        try:
            _apply_plan(_plan_delete(ref))
        except FileNotFoundError:
            continue
    # Originals take their own copies with them. What remains is every
    # other .play file, including copies of recordings we kept.
    seen = set()
    for project_id, conv_id, recordings_dir in _iter_recording_trees():
        for folder in recordings_dir.iterdir():
            if not folder.is_dir() or folder.is_symlink():
                continue
            play_dir = folder / storage.PLAYABLE_DIRNAME
            if not play_dir.is_dir() or play_dir.is_symlink():
                continue
            for entry in list(play_dir.iterdir()):
                if not (entry.is_file() or entry.is_symlink()):
                    continue
                key = (project_id, conv_id, folder.name, entry.name)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    _unlink_entry(entry, play_dir)
                except (ValueError, FileNotFoundError):
                    continue
    return {
        "originals": originals,
        "play_copies": plays,
        "freed_bytes": freed,
        "usage": usage_report(),
    }
