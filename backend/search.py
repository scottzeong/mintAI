"""카드 검색 — 한국어 대응 하이브리드.

SQLite FTS5 의 기본 unicode61 tokenizer 는 한국어를 공백 단위로만 분절해
'거래비용' 같은 어절 내부 검색이 전부 실패한다. trigram 으로 바꾸면
어절 내부는 잡히지만 2글자 검색어('신뢰','조직')를 전혀 처리하지 못한다.

두 방식 모두 단독으로는 쓸 수 없으므로 길이 기반으로 분기한다.
상세 및 실측 근거: docs/MVP.md §2.1
"""
from __future__ import annotations

import sqlite3

FTS_MIN_LEN = 3


def fts_quote(q: str) -> str:
    """FTS5 구문 안전 처리.

    큰따옴표로 감싸 phrase 취급 → 공백 포함 검색어('회계 항목')가 깨지지 않는다.
    내부 큰따옴표는 두 번 반복해 이스케이프 → 사용자가 " 를 입력해도 SQL 오류가 안 난다.
    """
    return '"' + q.replace('"', '""') + '"'


def search_cards(con: sqlite3.Connection, q: str | None = None, tag: str | None = None) -> list[dict]:
    """카드 검색. q 가 비면 최근순 전체."""
    q = (q or "").strip()

    if not q:
        if tag:
            rows = con.execute(
                "SELECT * FROM cards WHERE ifnull(tags,'') LIKE ? ORDER BY created_at DESC",
                (f"%{tag}%",),
            ).fetchall()
        else:
            rows = con.execute("SELECT * FROM cards ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]

    if len(q) >= FTS_MIN_LEN:
        # FTS5 trigram — 어절 내부 부분 일치 가능
        rows = con.execute(
            "SELECT c.* FROM cards_fts f JOIN cards c ON c.id = f.rowid "
            "WHERE cards_fts MATCH ? ORDER BY rank",
            (fts_quote(q),),
        ).fetchall()
    else:
        # 2자 이하 — LIKE 폴백. 풀스캔이지만 카드 수천 장까지 체감 지연 없음
        like = f"%{q}%"
        rows = con.execute(
            "SELECT * FROM cards WHERE title LIKE ? OR summary LIKE ? "
            "OR ifnull(my_take,'') LIKE ? OR ifnull(tags,'') LIKE ? "
            "ORDER BY created_at DESC",
            (like, like, like, like),
        ).fetchall()

    result = [dict(r) for r in rows]
    if tag:
        result = [r for r in result if tag in (r.get("tags") or "")]
    return result
