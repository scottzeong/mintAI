"""백엔드 테스트.

가장 중요한 것은 test_digest_* — 원칙 1(AI 산문 폐기)이 실제로 지켜지는지 검증한다.
이게 깨지면 이 도구의 정체성이 사라진다.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ["MINTAI_DB"] = ":memory:"

from backend import db as dbmod  # noqa: E402
from backend.main import app  # noqa: E402
from backend.search import fts_quote, search_cards  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def con():
    c = dbmod.connect(":memory:")
    dbmod.init_schema(c)
    yield c
    c.close()


# ─────────────────── 스키마 / 원칙 1 ───────────────────


def test_schema_creates_expected_tables(con):
    names = {
        r[0]
        for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'cards_fts%'"
        )
    }
    assert names == {"ideas", "research_runs", "cards", "sources", "drafts", "events"}


def test_schema_is_idempotent(con):
    dbmod.init_schema(con)
    dbmod.init_schema(con)
    assert con.execute("SELECT count(*) FROM cards").fetchone()[0] == 0


def test_digest_purges_ai_prose_but_keeps_sources(con):
    """★ 원칙 1: 소화 후 AI 산문은 사라지고 출처는 남는다."""
    con.execute("INSERT INTO ideas(raw_thought) VALUES ('신뢰는 왜 비용인가')")
    iid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    con.execute(
        "INSERT INTO research_runs(idea_id, output_md, sources_json) VALUES (?,?,?)",
        (iid, "AI가 생성한 긴 산문", '[{"url":"https://ex.com","title":"Zak 2017"}]'),
    )
    rid = con.execute("SELECT last_insert_rowid()").fetchone()[0]

    with con:  # 원자적 소화
        con.execute(
            "INSERT INTO cards(idea_id,title,summary,my_take,tags) VALUES (?,?,?,?,?)",
            (iid, "신뢰의 거래비용", "계약·감시 비용이 줄어든다", "회계 항목이다", "조직,신뢰"),
        )
        cid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.execute(
            "INSERT INTO sources(card_id,url,title) VALUES (?,?,?)",
            (cid, "https://ex.com", "Zak 2017"),
        )
        con.execute(
            "UPDATE research_runs SET output_md=NULL, purged_at=datetime('now') WHERE id=?",
            (rid,),
        )
        con.execute("UPDATE ideas SET status='digested' WHERE id=?", (iid,))

    run = con.execute("SELECT * FROM research_runs WHERE id=?", (rid,)).fetchone()
    assert run["output_md"] is None, "AI 산문이 폐기되지 않았다 — 원칙 1 위반"
    assert run["purged_at"] is not None
    assert "Zak 2017" in run["sources_json"], "출처는 승계되어야 한다 (원칙 2)"
    assert con.execute("SELECT count(*) FROM sources").fetchone()[0] == 1
    assert con.execute("SELECT count(*) FROM cards").fetchone()[0] == 1


def test_digest_rolls_back_on_failure(con):
    """트랜잭션이 깨지면 카드도 폐기도 일어나지 않아야 한다.

    주의: sqlite3 는 암묵적 트랜잭션을 쓰므로 셋업을 반드시 commit 해야 한다.
    안 그러면 `with con:` 롤백이 셋업 INSERT 까지 되돌린다.
    """
    con.execute("INSERT INTO ideas(raw_thought) VALUES ('x')")
    iid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    con.execute(
        "INSERT INTO research_runs(idea_id,output_md,sources_json) VALUES (?,?,'[]')",
        (iid, "AI 산문"),
    )
    rid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    con.commit()  # ← 셋업 확정. 이게 없으면 롤백이 셋업까지 지운다

    with pytest.raises(Exception):
        with con:
            con.execute(
                "INSERT INTO cards(idea_id,title,summary) VALUES (?,?,?)",
                (iid, "제목", "요약"),
            )
            con.execute(
                "UPDATE research_runs SET output_md=NULL WHERE id=?", (rid,)
            )
            con.execute("INSERT INTO sources(card_id,url) VALUES (99999,'x')")  # FK 위반

    assert con.execute("SELECT count(*) FROM cards").fetchone()[0] == 0
    run = con.execute("SELECT * FROM research_runs WHERE id=?", (rid,)).fetchone()
    assert run is not None, "롤백이 셋업 데이터까지 지웠다"
    assert run["output_md"] == "AI 산문", "롤백됐는데 산문이 사라졌다"


def test_sources_cascade_on_card_delete(con):
    con.execute("INSERT INTO cards(title,summary) VALUES ('t','s')")
    cid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    con.execute("INSERT INTO sources(card_id,url) VALUES (?,'u')", (cid,))
    con.execute("DELETE FROM cards WHERE id=?", (cid,))
    assert con.execute("SELECT count(*) FROM sources").fetchone()[0] == 0


# ─────────────────── 한국어 검색 ───────────────────


@pytest.fixture
def seeded(con):
    rows = [
        ("신뢰의 거래비용 절감", "조직 신뢰가 높으면 계약·감시 비용이 줄어든다", "감정이 아니라 회계 항목", "조직,신뢰"),
        ("리모트 근무와 응집력", "물리적 거리는 약한 연결을 먼저 끊는다", "사무실 무용론은 성급", "리모트,조직"),
        ("고신뢰 사회 논의", "후쿠야마는 신뢰를 사회적 자본으로 봤다", "한국 적용은 신중히", "신뢰,사회"),
    ]
    for t, s, m, g in rows:
        con.execute(
            "INSERT INTO cards(title,summary,my_take,tags) VALUES (?,?,?,?)", (t, s, m, g)
        )
    con.commit()
    return con


@pytest.mark.parametrize(
    "query,expected",
    [
        ("신뢰", 2),        # 2자 → LIKE 폴백
        ("조직", 2),        # 2자
        ("거래비용", 1),     # 어절 내부 부분어 → trigram
        ("회계 항목", 1),    # 공백 포함 구문
        ("후쿠야마", 1),
        ("없는말", 0),
    ],
)
def test_korean_search(seeded, query, expected):
    assert len(search_cards(seeded, query)) == expected


def test_search_handles_quotes_without_error(seeded):
    """따옴표 입력이 SQL 오류를 내면 안 된다."""
    assert search_cards(seeded, '따옴"표') == []
    assert search_cards(seeded, '"""') == []


def test_fts_quote_escapes():
    assert fts_quote('회계 항목') == '"회계 항목"'
    assert fts_quote('a"b') == '"a""b"'


def test_search_empty_returns_all(seeded):
    assert len(search_cards(seeded, "")) == 3
    assert len(search_cards(seeded, None)) == 3


def test_search_index_syncs_on_update(seeded):
    cid = seeded.execute("SELECT id FROM cards WHERE title LIKE '신뢰의%'").fetchone()[0]
    seeded.execute(
        "UPDATE cards SET title='협력의 구조', summary='협력비용 이야기' WHERE id=?", (cid,)
    )
    seeded.commit()
    assert len(search_cards(seeded, "거래비용")) == 0
    assert len(search_cards(seeded, "협력비용")) == 1


def test_search_index_syncs_on_delete(seeded):
    seeded.execute("DELETE FROM cards WHERE title='고신뢰 사회 논의'")
    seeded.commit()
    assert len(search_cards(seeded, "후쿠야마")) == 0


def test_search_by_tag(seeded):
    assert len(search_cards(seeded, None, tag="조직")) == 2


# ─────────────────── API ───────────────────


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_create_and_list_idea(client):
    r = client.post("/api/ideas", json={"raw_thought": "조직에서 신뢰는 왜 비용인가"})
    assert r.status_code == 201
    body = r.json()
    assert body["raw_thought"] == "조직에서 신뢰는 왜 비용인가"
    assert body["status"] == "inbox"
    assert body["question"] is None

    listed = client.get("/api/ideas").json()
    assert any(i["id"] == body["id"] for i in listed)


def test_create_idea_with_question(client):
    r = client.post(
        "/api/ideas",
        json={"raw_thought": "신뢰와 비용", "question": "거래비용 메커니즘은?"},
    )
    assert r.json()["question"] == "거래비용 메커니즘은?"


def test_create_idea_rejects_empty(client):
    assert client.post("/api/ideas", json={"raw_thought": "   "}).status_code == 422
    assert client.post("/api/ideas", json={"raw_thought": ""}).status_code == 422


def test_idea_strips_whitespace(client):
    r = client.post("/api/ideas", json={"raw_thought": "  공백 제거  ", "question": "   "})
    assert r.json()["raw_thought"] == "공백 제거"
    assert r.json()["question"] is None


def test_delete_idea(client):
    iid = client.post("/api/ideas", json={"raw_thought": "지울 것"}).json()["id"]
    assert client.delete(f"/api/ideas/{iid}").status_code == 204
    assert client.delete(f"/api/ideas/{iid}").status_code == 404


def test_list_ideas_filter_by_status(client):
    client.post("/api/ideas", json={"raw_thought": "inbox 항목"})
    assert len(client.get("/api/ideas?status=inbox").json()) >= 1
    assert client.get("/api/ideas?status=digested").json() == []


def test_draft_crud(client):
    created = client.post("/api/drafts", json={"title": "신뢰라는 비용"}).json()
    assert created["body_md"] == ""

    updated = client.put(
        f"/api/drafts/{created['id']}",
        json={"title": "신뢰라는 비용", "body_md": "# 서론\n\n본문"},
    ).json()
    assert "서론" in updated["body_md"]

    assert client.put("/api/drafts/99999", json={"title": "x"}).status_code == 404


def test_card_404s(client):
    assert client.get("/api/cards/99999").status_code == 404
    assert client.delete("/api/cards/99999").status_code == 404


def test_stats(client):
    s = client.get("/api/stats").json()
    assert set(s) == {
        "ideas", "cards", "drafts", "pending_digest", "digest_rate",
        "active_days", "avg_queue", "paste_blocked", "long_drafts",
    }
    assert isinstance(s["digest_rate"], float)


# ─────────────────── 리서치 + 소화 API (§4.1, §3.2) ───────────────────


def _make_digestible(client) -> int:
    """착상 → 리서치 → 소화 대기 상태까지 만든 뒤 idea_id 반환."""
    iid = client.post(
        "/api/ideas", json={"raw_thought": "신뢰와 거래비용", "question": "메커니즘은?"}
    ).json()["id"]
    assert client.post(f"/api/ideas/{iid}/research").status_code == 202
    return iid


def test_research_moves_idea_to_awaiting_digest(client):
    iid = _make_digestible(client)
    idea = [i for i in client.get("/api/ideas").json() if i["id"] == iid][0]
    assert idea["status"] == "awaiting_digest"

    run = client.get(f"/api/ideas/{iid}/run").json()
    assert run["output_md"] is not None
    assert run["purged_at"] is None
    assert len(run["output_md"]) <= 1200, "§4 규격: 1,200자 이내"


def test_research_404_and_no_run(client):
    assert client.post("/api/ideas/99999/research").status_code == 404
    iid = client.post("/api/ideas", json={"raw_thought": "조사 안 함"}).json()["id"]
    assert client.get(f"/api/ideas/{iid}/run").status_code == 404


def test_research_failure_returns_idea_to_inbox(client, monkeypatch):
    """실패하면 inbox 로 되돌아가고 사유가 남는다 — 재시도는 버튼 재클릭 (§4.1)."""
    import backend.main as mainmod

    def boom(_q):
        raise RuntimeError("검색 API 응답 없음")

    monkeypatch.setattr(mainmod, "run_research", boom)

    iid = client.post("/api/ideas", json={"raw_thought": "실패할 조사"}).json()["id"]
    client.post(f"/api/ideas/{iid}/research")

    idea = [i for i in client.get("/api/ideas").json() if i["id"] == iid][0]
    assert idea["status"] == "inbox", "실패했는데 researching 에 갇혔다"

    run = client.get(f"/api/ideas/{iid}/run").json()
    assert "검색 API 응답 없음" in run["error"]
    assert run["output_md"] is None


def test_digest_purges_prose_through_api(client):
    """★ 원칙 1이 SQL 이 아니라 **API 경유로** 지켜지는지 — Week 2 검증 기준."""
    iid = _make_digestible(client)

    card = client.post(
        f"/api/ideas/{iid}/digest",
        json={
            "title": "신뢰의 거래비용 절감",
            "summary": "신뢰가 높으면 계약·감시 비용이 줄어든다",
            "my_take": "감정이 아니라 회계 항목",
            "tags": "조직,신뢰",
            "source_ids": [],
        },
    )
    assert card.status_code == 201
    assert card.json()["title"] == "신뢰의 거래비용 절감"

    run = client.get(f"/api/ideas/{iid}/run").json()
    assert run["output_md"] is None, "AI 산문이 폐기되지 않았다 — 원칙 1 위반"
    assert run["purged_at"] is not None

    idea = [i for i in client.get("/api/ideas").json() if i["id"] == iid][0]
    assert idea["status"] == "digested"


def test_digest_three_cards_all_purged(client):
    """MVP §7 Week 2 검증: 카드 3장 생성 후 output_md 가 전부 NULL."""
    for _ in range(3):
        iid = _make_digestible(client)
        client.post(
            f"/api/ideas/{iid}/digest",
            json={"title": "제목", "summary": "요약", "source_ids": []},
        )

    leftover = client.get("/api/stats").json()
    assert leftover["cards"] >= 3

    # API 로는 전수 조회가 없으므로 idea 별로 확인
    for i in client.get("/api/ideas?status=digested&limit=200").json():
        run = client.get(f"/api/ideas/{i['id']}/run")
        if run.status_code == 200:
            assert run.json()["output_md"] is None


def test_digest_inherits_only_checked_sources(client, monkeypatch):
    """원칙 2: 출처는 승계한다. 단 체크한 것만."""
    import backend.main as mainmod
    from backend.research import ResearchResult

    monkeypatch.setattr(
        mainmod,
        "run_research",
        lambda _q: ResearchResult(
            "자료 본문",
            [
                {"url": "https://a.example", "title": "Zak 2017"},
                {"url": "https://b.example", "title": "OECD"},
                {"url": "https://c.example", "title": "blog"},
            ],
        ),
    )

    iid = _make_digestible(client)
    card_id = client.post(
        f"/api/ideas/{iid}/digest",
        json={"title": "t", "summary": "s", "source_ids": [0, 2, 99]},  # 99 는 무시
    ).json()["id"]

    got = client.get(f"/api/cards/{card_id}").json()
    titles = {s["title"] for s in got["sources"]}
    assert titles == {"Zak 2017", "blog"}, "체크하지 않은 출처가 딸려 왔다"


def test_digest_requires_summary(client):
    iid = _make_digestible(client)
    r = client.post(
        f"/api/ideas/{iid}/digest", json={"title": "제목만", "summary": "   "}
    )
    assert r.status_code == 422, "요약이 비면 저장되면 안 된다 (§3.2)"

    run = client.get(f"/api/ideas/{iid}/run").json()
    assert run["output_md"] is not None, "저장 실패했는데 자료가 폐기됐다"


def test_digest_404(client):
    assert (
        client.post(
            "/api/ideas/99999/digest", json={"title": "t", "summary": "s"}
        ).status_code
        == 404
    )


def test_orphaned_research_recovered_on_boot(con):
    """서버가 리서치 도중 죽으면 researching 에 갇힌다 — 기동 시 복구 (§4.1)."""
    from backend.main import _recover_orphaned_research

    con.execute("INSERT INTO ideas(raw_thought, status) VALUES ('갇힌 착상','researching')")
    con.execute("INSERT INTO ideas(raw_thought, status) VALUES ('정상','inbox')")
    con.commit()

    assert _recover_orphaned_research(con) == 1
    assert con.execute(
        "SELECT count(*) FROM ideas WHERE status='researching'"
    ).fetchone()[0] == 0


# ─────────────────── 계측 (§2.2) ───────────────────


def test_event_logged_and_counted(client):
    """§8의 '사용 일수'와 '붙여넣기 시도'가 실제로 집계되는지."""
    before = client.get("/api/stats").json()

    assert client.post("/api/events", json={"kind": "app_open"}).status_code == 204
    client.post("/api/events", json={"kind": "paste_blocked", "meta": "idea:1"})
    client.post("/api/events", json={"kind": "paste_blocked", "meta": "idea:1"})

    after = client.get("/api/stats").json()
    assert after["active_days"] >= 1
    assert after["paste_blocked"] == before["paste_blocked"] + 2


def test_app_open_records_queue_length(client):
    """meta 를 생략하면 서버가 대기 큐 길이를 채운다 — 큐 평균 계산의 근거."""
    iid = client.post("/api/ideas", json={"raw_thought": "대기 큐 항목"}).json()["id"]
    client.post("/api/events", json={"kind": "app_open"})

    s = client.get("/api/stats").json()
    assert isinstance(s["avg_queue"], float)
    client.delete(f"/api/ideas/{iid}")


def test_event_failure_does_not_break_caller(con):
    """계측이 실패해도 예외가 새어 나가면 안 된다 (측정이 행동을 막으면 본말전도)."""
    from backend.main import log_event

    con.execute("DROP TABLE events")
    con.commit()
    log_event(con, "app_open", "0")  # 예외가 나면 테스트 실패


def test_active_days_counts_distinct_dates(con):
    con.execute(
        "INSERT INTO events(kind, meta, at) VALUES "
        "('app_open','0','2026-07-01 09:00:00'),"
        "('app_open','1','2026-07-01 18:00:00'),"
        "('app_open','2','2026-07-02 09:00:00')"
    )
    con.commit()
    days = con.execute(
        "SELECT count(DISTINCT date(at)) FROM events WHERE kind='app_open'"
    ).fetchone()[0]
    assert days == 2, "같은 날 여러 번 접속이 2일로 세어지면 안 된다"

    avg = con.execute(
        "SELECT avg(CAST(meta AS REAL)) FROM events WHERE kind='app_open'"
    ).fetchone()[0]
    assert avg == 1.0
