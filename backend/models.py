"""요청/응답 스키마."""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class IdeaCreate(BaseModel):
    raw_thought: str = Field(min_length=1, max_length=5000)
    question: str | None = Field(default=None, max_length=2000)

    @field_validator("raw_thought")
    @classmethod
    def _strip_thought(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("착상 내용이 비어 있습니다")
        return v

    @field_validator("question")
    @classmethod
    def _strip_question(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class IdeaOut(BaseModel):
    id: int
    raw_thought: str
    question: str | None
    status: str
    created_at: str


class CardCreate(BaseModel):
    """소화 입력. AI 산문이 아니라 인간이 직접 쓴 것만 받는다 (원칙 1)."""

    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(min_length=1, max_length=20000)
    my_take: str | None = Field(default=None, max_length=20000)
    tags: str | None = Field(default=None, max_length=500)
    source_ids: list[int] = Field(default_factory=list)

    @field_validator("title", "summary")
    @classmethod
    def _required_text(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("필수 입력입니다")
        return v


class CardOut(BaseModel):
    id: int
    idea_id: int | None
    title: str
    summary: str
    my_take: str | None
    tags: str | None
    created_at: str


class EventIn(BaseModel):
    """계측 기록 (docs/MVP.md §2.2).

    kind 를 열거형으로 고정하지 않는 이유: 4주 실사용 중에 "이것도 세어볼걸"
    하는 순간이 반드시 온다. 그때 스키마 변경 없이 바로 기록할 수 있어야 한다.
    """

    kind: str = Field(min_length=1, max_length=50)
    meta: str | None = Field(default=None, max_length=500)


class DraftUpsert(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    body_md: str = ""


class DraftOut(BaseModel):
    id: int
    title: str
    body_md: str
    updated_at: str
