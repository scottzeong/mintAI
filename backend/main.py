"""mintAI — Scriptorium 백엔드.

원칙 (docs/PRD.md §2):
  1. AI 가 쓴 문장은 DB 에 남지 않는다 — research_runs.output_md 는 소화 시 폐기
  2. 단, 사실 데이터(출처)는 승계한다
"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db as dbmod
from .research import ResearchError, run_research
from .models import (
    CardCreate,
    CardOut,
    DraftOut,
    DraftUpsert,
    EventIn,
    IdeaCreate,
    IdeaOut,
)
from .search import search_cards

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST = ROOT / "frontend" / "dist"

_con: sqlite3.Connection | None = None


def get_db() -> sqlite3.Connection:
    if _con is None:  # pragma: no cover - 기동 전 접근
        raise RuntimeError("DB가 초기화되지 않았습니다")
    return _con


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _con
    db_path = os.environ.get("MINTAI_DB")  # 테스트에서 주입
    _con = dbmod.connect(db_path)
    dbmod.init_schema(_con)
    _recover_orphaned_research(_con)
    yield
    if _con is not None:
        _con.close()
        _con = None


def _recover_orphaned_research(con: sqlite3.Connection) -> int:
    """기동 시 `researching` 고아 상태 복구 (docs/MVP.md §4.1).

    BackgroundTasks 는 프로세스 안에서만 산다. 리서치 도중 서버가 죽으면
    그 착상은 영원히 'researching' 에 갇혀 다시 시도할 수도, 소화할 수도 없다.
    큐를 두지 않기로 한 대가이므로, 그 대가는 기동 시 한 줄로 치른다.
    """
    with con:
        cur = con.execute("UPDATE ideas SET status='inbox' WHERE status='researching'")
    return cur.rowcount


app = FastAPI(title="mintAI", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────── Ideas ───────────────────────────


@app.post("/api/ideas", response_model=IdeaOut, status_code=201)
def create_idea(payload: IdeaCreate, con: sqlite3.Connection = Depends(get_db)):
    """착상 저장. 마찰 최소화가 최우선 — 분류/태그를 요구하지 않는다."""
    with con:
        cur = con.execute(
            "INSERT INTO ideas(raw_thought, question) VALUES (?, ?)",
            (payload.raw_thought, payload.question),
        )
    row = con.execute("SELECT * FROM ideas WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


@app.get("/api/ideas", response_model=list[IdeaOut])
def list_ideas(
    status: str | None = None,
    limit: int = 50,
    con: sqlite3.Connection = Depends(get_db),
):
    limit = max(1, min(limit, 200))
    if status:
        rows = con.execute(
            "SELECT * FROM ideas WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            (status, limit),
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM ideas ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


@app.delete("/api/ideas/{idea_id}", status_code=204)
def delete_idea(idea_id: int, con: sqlite3.Connection = Depends(get_db)):
    with con:
        cur = con.execute("DELETE FROM ideas WHERE id = ?", (idea_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "해당 착상이 없습니다")


# ─────────────────── 리서치 (§4.1) ───────────────────


def _do_research(con: sqlite3.Connection, idea_id: int, question: str) -> None:
    """BackgroundTasks 로 실행되는 본체.

    실패해도 예외를 밖으로 던지지 않는다 — 백그라운드에서 던져봐야 받을 사람이 없다.
    대신 사유를 DB 에 남기고 status 를 'inbox' 로 되돌린다. **재시도는 사용자가
    버튼을 다시 누르는 것**이다 (§4.1).
    """
    try:
        result = run_research(question)
    except Exception as exc:  # noqa: BLE001 — 공급자가 무엇을 던질지 알 수 없다
        with con:
            con.execute(
                "INSERT INTO research_runs(idea_id, output_md, sources_json, error) "
                "VALUES (?, NULL, '[]', ?)",
                (idea_id, str(exc)[:500]),
            )
            con.execute("UPDATE ideas SET status='inbox' WHERE id=?", (idea_id,))
        log_event(con, "research_failed", f"idea:{idea_id}")
        return

    with con:
        con.execute(
            "INSERT INTO research_runs(idea_id, output_md, sources_json, model) "
            "VALUES (?,?,?,?)",
            (idea_id, result.output_md, json.dumps(result.sources, ensure_ascii=False),
             result.model),
        )
        con.execute("UPDATE ideas SET status='awaiting_digest' WHERE id=?", (idea_id,))


@app.post("/api/ideas/{idea_id}/research", status_code=202)
def start_research(
    idea_id: int,
    background: BackgroundTasks,
    con: sqlite3.Connection = Depends(get_db),
):
    """리서치 실행 요청. 즉시 202 를 반환하고 백그라운드로 넘긴다.

    진행 상황은 `ideas.status` 하나로 표현한다 (§4.1). 별도 job 테이블을 두지 않는다.
    """
    idea = con.execute("SELECT * FROM ideas WHERE id=?", (idea_id,)).fetchone()
    if idea is None:
        raise HTTPException(404, "해당 착상이 없습니다")
    if idea["status"] == "researching":
        raise HTTPException(409, "이미 조사 중입니다")

    question = (idea["question"] or idea["raw_thought"]).strip()
    with con:
        con.execute("UPDATE ideas SET status='researching' WHERE id=?", (idea_id,))
    background.add_task(_do_research, con, idea_id, question)
    return {"status": "researching"}


@app.get("/api/ideas/{idea_id}/run")
def get_run(idea_id: int, con: sqlite3.Connection = Depends(get_db)):
    """휘발 자료 조회. 가장 최근 run 하나만 본다.

    `output_md` 가 NULL 이면 이미 소화됐거나(purged_at) 실패한 것이다(error).
    프론트는 이 셋을 구분해서 보여준다.
    """
    row = con.execute(
        "SELECT * FROM research_runs WHERE idea_id=? ORDER BY id DESC LIMIT 1",
        (idea_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "아직 조사 결과가 없습니다")
    return {**dict(row), "sources": json.loads(row["sources_json"])}


@app.post("/api/ideas/{idea_id}/digest", response_model=CardOut, status_code=201)
def digest(
    idea_id: int, payload: CardCreate, con: sqlite3.Connection = Depends(get_db)
):
    """★ 소화 — 이 함수가 이 도구의 정체성이다 (docs/MVP.md §3.2, 원칙 1·2).

    카드 생성 · 출처 승계 · **AI 산문 폐기** · 상태 전이가 **한 트랜잭션**이어야 한다.
    쪼개지면 다음 두 사고가 난다:
      · 카드는 생겼는데 산문이 남음 → 원칙 1 위반. 다음에 그 산문을 다시 읽게 된다
      · 산문은 지웠는데 카드가 없음 → 되돌릴 수 없는 데이터 손실

    `payload.source_ids` 는 run 의 `sources_json` 배열 **인덱스**다.
    별도 sources 테이블을 미리 만들지 않으므로 DB id 가 존재하지 않는다.
    """
    idea = con.execute("SELECT * FROM ideas WHERE id=?", (idea_id,)).fetchone()
    if idea is None:
        raise HTTPException(404, "해당 착상이 없습니다")

    run = con.execute(
        "SELECT * FROM research_runs WHERE idea_id=? AND output_md IS NOT NULL "
        "ORDER BY id DESC LIMIT 1",
        (idea_id,),
    ).fetchone()

    sources = json.loads(run["sources_json"]) if run else []
    chosen = [sources[i] for i in payload.source_ids if 0 <= i < len(sources)]

    with con:  # ★ 원자적
        cur = con.execute(
            "INSERT INTO cards(idea_id,title,summary,my_take,tags) VALUES (?,?,?,?,?)",
            (idea_id, payload.title, payload.summary, payload.my_take, payload.tags),
        )
        card_id = cur.lastrowid
        for s in chosen:
            con.execute(
                "INSERT INTO sources(card_id,url,title) VALUES (?,?,?)",
                (card_id, s.get("url"), s.get("title")),
            )
        if run is not None:
            # ★ 폐기. 여기가 원칙 1이 실제로 집행되는 유일한 지점이다.
            con.execute(
                "UPDATE research_runs SET output_md=NULL, purged_at=datetime('now') "
                "WHERE id=?",
                (run["id"],),
            )
        con.execute("UPDATE ideas SET status='digested' WHERE id=?", (idea_id,))

    log_event(con, "digest_done", f"idea:{idea_id}")
    return dict(con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone())


# ─────────────────────────── Cards ───────────────────────────


@app.get("/api/cards", response_model=list[CardOut])
def list_cards(
    q: str | None = None,
    tag: str | None = None,
    con: sqlite3.Connection = Depends(get_db),
):
    return search_cards(con, q, tag)


@app.get("/api/cards/{card_id}")
def get_card(card_id: int, con: sqlite3.Connection = Depends(get_db)):
    row = con.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "해당 카드가 없습니다")
    sources = con.execute(
        "SELECT id, url, title FROM sources WHERE card_id = ?", (card_id,)
    ).fetchall()
    return {**dict(row), "sources": [dict(s) for s in sources]}


@app.put("/api/cards/{card_id}", response_model=CardOut)
def update_card(
    card_id: int, payload: CardCreate, con: sqlite3.Connection = Depends(get_db)
):
    with con:
        cur = con.execute(
            "UPDATE cards SET title=?, summary=?, my_take=?, tags=? WHERE id=?",
            (payload.title, payload.summary, payload.my_take, payload.tags, card_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(404, "해당 카드가 없습니다")
    return dict(con.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone())


@app.delete("/api/cards/{card_id}", status_code=204)
def delete_card(card_id: int, con: sqlite3.Connection = Depends(get_db)):
    with con:
        cur = con.execute("DELETE FROM cards WHERE id = ?", (card_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "해당 카드가 없습니다")


# ─────────────────────────── Drafts ───────────────────────────


@app.get("/api/drafts", response_model=list[DraftOut])
def list_drafts(con: sqlite3.Connection = Depends(get_db)):
    rows = con.execute("SELECT * FROM drafts ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/drafts", response_model=DraftOut, status_code=201)
def create_draft(payload: DraftUpsert, con: sqlite3.Connection = Depends(get_db)):
    with con:
        cur = con.execute(
            "INSERT INTO drafts(title, body_md) VALUES (?, ?)",
            (payload.title, payload.body_md),
        )
    return dict(
        con.execute("SELECT * FROM drafts WHERE id = ?", (cur.lastrowid,)).fetchone()
    )


@app.put("/api/drafts/{draft_id}", response_model=DraftOut)
def update_draft(
    draft_id: int, payload: DraftUpsert, con: sqlite3.Connection = Depends(get_db)
):
    with con:
        cur = con.execute(
            "UPDATE drafts SET title=?, body_md=?, updated_at=datetime('now') WHERE id=?",
            (payload.title, payload.body_md, draft_id),
        )
    if cur.rowcount == 0:
        raise HTTPException(404, "해당 원고가 없습니다")
    return dict(
        con.execute("SELECT * FROM drafts WHERE id = ?", (draft_id,)).fetchone()
    )


# ─────────────────────────── 계측 (§2.2) ───────────────────────────


def log_event(con: sqlite3.Connection, kind: str, meta: str | None = None) -> None:
    """계측 기록. 실패해도 본 기능을 막지 않는다.

    계측 오류로 캡처가 실패하면 본말이 전도된다 — 측정하려던 행동 자체를
    측정 장치가 방해하게 된다.
    """
    try:
        with con:
            con.execute("INSERT INTO events(kind, meta) VALUES (?, ?)", (kind, meta))
    except sqlite3.Error:  # pragma: no cover
        pass


@app.post("/api/events", status_code=204)
def create_event(payload: EventIn, con: sqlite3.Connection = Depends(get_db)):
    """프론트에서 오는 계측 기록 (app_open, paste_blocked 등).

    app_open 은 meta 를 생략하면 서버가 현재 소화 대기 큐 길이를 채워 넣는다.
    이게 있어야 §8의 '대기 큐 평균'을 사후에 계산할 수 있다.
    """
    meta = payload.meta
    if payload.kind == "app_open" and meta is None:
        meta = str(
            con.execute(
                "SELECT count(*) FROM ideas WHERE status='awaiting_digest'"
            ).fetchone()[0]
        )
    log_event(con, payload.kind, meta)


# ─────────────────────────── Meta ───────────────────────────


@app.get("/api/stats")
def stats(con: sqlite3.Connection = Depends(get_db)):
    """MVP 판정 지표 (docs/MVP.md §8).

    4주 뒤에 별도 집계 작업이 필요 없도록, 판정에 쓰는 6개 지표를 전부 여기서 낸다.
    """
    one = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
    ideas = one("SELECT count(*) FROM ideas")
    digested = one("SELECT count(*) FROM ideas WHERE status='digested'")
    avg_queue = con.execute(
        "SELECT avg(CAST(meta AS REAL)) FROM events "
        "WHERE kind='app_open' AND meta IS NOT NULL"
    ).fetchone()[0]
    return {
        "ideas": ideas,
        "cards": one("SELECT count(*) FROM cards"),
        "drafts": one("SELECT count(*) FROM drafts"),
        "pending_digest": one("SELECT count(*) FROM ideas WHERE status='awaiting_digest'"),
        "digest_rate": round(digested / ideas, 3) if ideas else 0.0,
        # ── §2.2 계측 기반 ──
        "active_days": one(
            "SELECT count(DISTINCT date(at)) FROM events WHERE kind='app_open'"
        ),
        "avg_queue": round(avg_queue, 2) if avg_queue is not None else 0.0,
        "paste_blocked": one("SELECT count(*) FROM events WHERE kind='paste_blocked'"),
        "long_drafts": one("SELECT count(*) FROM drafts WHERE length(body_md) >= 800"),
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ─────────────────── 프론트엔드 정적 서빙 (빌드 후) ───────────────────

if FRONTEND_DIST.exists():
    app.mount(
        "/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets"
    )

    @app.get("/")
    def index():
        return FileResponse(FRONTEND_DIST / "index.html")
