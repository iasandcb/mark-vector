from fastapi import APIRouter, HTTPException

from .. import storage
from ..models import CreateProjectRequest, RenameProjectRequest, SaveDocumentRequest

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
def list_projects():
    return storage.list_projects()


@router.post("")
def create_project(req: CreateProjectRequest):
    return storage.create_project(req.title or "Untitled")


@router.get("/{project_id}")
def get_project(project_id: str):
    try:
        return storage.get_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")


@router.patch("/{project_id}")
def rename_project(project_id: str, req: RenameProjectRequest):
    try:
        return storage.rename_project(project_id, req.title)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")


@router.delete("/{project_id}")
def delete_project(project_id: str):
    try:
        storage.delete_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}


@router.get("/{project_id}/system-prompt")
def get_project_system_prompt(project_id: str):
    try:
        return {"content": storage.get_project_system_prompt(project_id)}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")


@router.put("/{project_id}/system-prompt")
def save_project_system_prompt(project_id: str, req: SaveDocumentRequest):
    try:
        return storage.save_project_system_prompt(project_id, req.content)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
