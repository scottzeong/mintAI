"""DB 커넥션 및 스키마 초기화.

MVP 단계에서는 마이그레이션 도구를 쓰지 않는다 (docs/MVP.md §6).
schema.sql 이 멱등(IF NOT EXISTS)이므로 매 기동 시 실행해도 안전하다.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schema.sql"
DEFAULT_DB = ROOT / "data" / "mintai.db"


def connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    """커넥션 생성. `:memory:` 를 주면 인메모리 DB (테스트용).

    isolation_level=None (autocommit) 을 쓰지 않는 이유:
    소화(digest)는 카드 생성 + AI 산문 폐기가 반드시 한 트랜잭션이어야 하므로
    (원칙 1), 명시적 트랜잭션 제어가 필요하다. 대신 각 쓰기 작업은 `with con:`
    으로 즉시 커밋해서, 커밋되지 않은 상태가 다음 트랜잭션의 롤백에 휩쓸리지
    않게 한다.
    """
    if db_path is None:
        db_path = DEFAULT_DB
    if db_path != ":memory:":
        db_path = Path(db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(str(db_path), check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_schema(con: sqlite3.Connection) -> None:
    """schema.sql 적용. 멱등하므로 반복 호출 안전."""
    con.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    con.commit()


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None
