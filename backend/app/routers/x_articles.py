"""Authenticated draft export to X. Users publish in the X web composer."""

import fcntl
import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .. import x_articles
from ..config import settings

router = APIRouter(prefix="/api/x-articles", tags=["x-articles"])


class StyleRange(BaseModel):
    offset: int = Field(ge=0)
    length: int = Field(ge=1)
    style: Literal["bold", "italic", "strikethrough"]


class EntityRange(BaseModel):
    offset: int = Field(ge=0)
    length: int = Field(ge=1)
    key: int = Field(ge=0)


class Block(BaseModel):
    text: str = Field(max_length=200_000)
    type: Literal["unstyled", "header-one", "header-two", "header-three", "unordered-list-item", "ordered-list-item", "blockquote", "atomic"]
    key: str = Field(max_length=64)
    inline_style_ranges: list[StyleRange] = Field(default_factory=list, max_length=10_000)
    entity_ranges: list[EntityRange] = Field(default_factory=list, max_length=10_000)


class EntityValue(BaseModel):
    type: Literal["link", "markdown", "divider", "latex"]
    mutability: Literal["mutable", "immutable"]
    data: dict[str, str] = Field(default_factory=dict, max_length=4)


class Entity(BaseModel):
    key: str = Field(pattern=r"^\d{1,6}$")
    value: EntityValue


class ContentState(BaseModel):
    blocks: list[Block] = Field(min_length=1, max_length=10_000)
    entities: list[Entity] = Field(default_factory=list, max_length=10_000)

    @model_validator(mode="after")
    def valid_ranges(self):
        entities = {int(entity.key): entity for entity in self.entities}
        if len(entities) != len(self.entities):
            raise ValueError("Duplicate entity keys")
        for block in self.blocks:
            # DraftJS offsets count UTF-16 code units, including surrogate pairs.
            length = len(block.text.encode("utf-16-le")) // 2
            for span in [*block.inline_style_ranges, *block.entity_ranges]:
                if span.offset + span.length > length:
                    raise ValueError("Range exceeds block text")
            if any(span.key not in entities for span in block.entity_ranges):
                raise ValueError("Unknown entity")
        for entity in self.entities:
            if entity.value.type == "link":
                url = entity.value.data.get("url", "")
                if not url.lower().startswith(("https://", "http://", "mailto:")):
                    raise ValueError("Unsupported link")
        if len(self.model_dump_json()) > 2_000_000:
            raise ValueError("Article is too large")
        return self


class DraftRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=False)
    request_id: UUID
    title: str = Field(min_length=1, max_length=1_000)
    content_state: ContentState

    @model_validator(mode="after")
    def not_empty(self):
        if not self.title.strip() or not any(block.text.strip() or block.entity_ranges for block in self.content_state.blocks):
            raise ValueError("Title and body are required")
        return self


def _same_origin(request: Request):
    origin = request.headers.get("origin")
    if (origin and origin.rstrip("/") != str(request.base_url).rstrip("/")) or request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Invalid origin")


@contextmanager
def _registry():
    root = Path(settings.data_dir)
    root.mkdir(parents=True, exist_ok=True)
    path = root / "x-articles.json"
    with (root / "x-articles.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        records = json.loads(path.read_text()) if path.exists() else {}
        before = json.dumps(records, sort_keys=True)
        yield records
        if json.dumps(records, sort_keys=True) != before:
            temporary = root / f".x-articles-{uuid4().hex}.tmp"
            try:
                with temporary.open("x", encoding="utf-8") as output:
                    os.chmod(temporary, 0o600)
                    json.dump(records, output, ensure_ascii=False)
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)


def _result(record):
    return {"article_id": record["article_id"], "url": "https://x.com/i/articles"}


@router.get("/config")
def config():
    return {"configured": x_articles.auth_mode() is not None}


@router.post("/drafts")
def create_draft(req: DraftRequest, request: Request):
    _same_origin(request)
    if x_articles.auth_mode() is None:
        raise HTTPException(503, "notConfigured")
    payload = {"title": req.title.strip(), "content_state": req.content_state.model_dump()}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    key = str(req.request_id)
    with _registry() as records:
        if key in records:
            if records[key]["digest"] != digest or records[key]["account"] != x_articles.account_key():
                raise HTTPException(409, "exportChanged")
            return _result(records[key])
        data = x_articles.create_draft(payload)
        records[key] = {"article_id": data["id"], "digest": digest, "account": x_articles.account_key()}
        return _result(records[key])
