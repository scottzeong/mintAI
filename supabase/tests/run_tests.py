"""마이그레이션 실측 검증 — 실제 PostgreSQL 에 적용해 돌린다.

Supabase 대시보드에 붙이기 전에 여기서 먼저 깨뜨린다.
가장 중요한 것은 `digest()` — 원칙 1(AI 산문 폐기)이 실제로 원자적인지.

autocommit 으로 도는 이유: PostgREST 는 RPC 호출 하나를 트랜잭션 하나로 처리한다.
autocommit 이어야 그 조건이 그대로 재현된다.

로컬 실행:
    pip install pgserver "psycopg[binary]"
    python supabase/tests/run_tests.py
"""
from __future__ import annotations

import pathlib
import sys

import pgserver
import psycopg

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = ROOT / "supabase" / "migrations"

# Supabase 의 auth 스키마 대역. 로컬 Postgres 에는 없으므로 최소한만 흉내낸다.
AUTH_SHIM = """
drop schema if exists auth cascade;
create schema auth;
create table auth.users (id uuid primary key);
create table _test_ctx (uid uuid);
create function auth.uid() returns uuid
language sql stable as $$ select uid from _test_ctx limit 1 $$;
"""

# ⚠ 테이블 소유자는 RLS 를 우회한다. superuser 로 테스트하면 정책이 없어도 전부 통과한다.
# Supabase 에서 실제로 쿼리를 날리는 authenticated 롤은 소유자가 아니므로,
# 여기서도 비소유자 롤을 만들어 그 롤로 전체 테스트를 돌린다.
APP_ROLE = """
drop role if exists app_user;
create role app_user nologin;
grant usage on schema public, auth to app_user;
grant all on all tables in schema public to app_user;
grant select on auth.users to app_user;
grant usage, select on all sequences in schema public to app_user;
grant execute on all functions in schema public to app_user;
grant execute on all functions in schema auth to app_user;
"""

results: list[tuple[bool, str]] = []


def check(cond: bool, label: str) -> None:
    results.append((bool(cond), label))
    print(("  ✅ " if cond else "  ❌ ") + label)


def main() -> int:
    data = pathlib.Path("/tmp/mintai_pgtest")
    data.mkdir(exist_ok=True)
    server = pgserver.get_server(str(data))

    con = psycopg.connect(server.get_uri(), autocommit=True)
    val = lambda sql, *a: con.execute(sql, a or None).fetchone()[0]  # noqa: E731

    print("PostgreSQL:", val("select version();").split(",")[0])

    con.execute("drop schema if exists public cascade;")
    con.execute("create schema public;")
    con.execute(AUTH_SHIM)

    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    has_trgm = val(
        "select count(*) from pg_available_extensions where name='pg_trgm';"
    )
    if not has_trgm:
        print("  ⚠ pg_trgm 없음 — GIN 인덱스 생략")
        print("    (인덱스는 속도 전용이라 정확성 검증에는 영향 없음. §2.1)")

    for f in files:
        sql = f.read_text(encoding="utf-8")
        if not has_trgm:
            sql = sql.replace("create extension if not exists pg_trgm;", "")
            sql = sql.replace(
                "create index if not exists idx_cards_trgm "
                "on cards using gin (search_blob gin_trgm_ops);",
                "",
            )
        con.execute(sql)
        print(f"  적용: {f.name}")
    print("\n마이그레이션 적용 완료\n")

    uid = "11111111-1111-1111-1111-111111111111"
    other = "22222222-2222-2222-2222-222222222222"
    con.execute("insert into auth.users(id) values (%s), (%s)", (uid, other))
    con.execute("insert into _test_ctx(uid) values (%s)", (uid,))

    # ★ 여기부터는 소유자가 아닌 롤로 실행한다 — 그래야 RLS 가 실제로 작동한다
    con.execute(APP_ROLE)
    con.execute("set role app_user;")
    check(val("select current_user;") == "app_user", "비소유자 롤로 실행 중 (RLS 적용됨)")

    def fails(sql: str, *args) -> str | None:
        """예외가 나면 메시지, 안 나면 None."""
        try:
            con.execute(sql, args or None)
            return None
        except psycopg.Error as e:
            return str(e).splitlines()[0]

    # ══════════════ 1. 스키마 ══════════════
    print("1. 스키마")
    tables = set(
        r[0]
        for r in con.execute(
            "select tablename from pg_tables "
            "where schemaname='public' and tablename <> '_test_ctx'"
        ).fetchall()
    )
    check(
        tables == {"ideas", "research_runs", "cards", "sources", "drafts", "events",
                   "collections", "card_collections"},
        f"8개 테이블 생성됨 ({len(tables)}개)",
    )
    check(
        val("select count(*) from pg_policies where schemaname='public';") == 8,
        "RLS 정책 8개 — 새 테이블도 빠짐없이",
    )

    # ══════════════ 2. ★ digest() — 원칙 1·2 ══════════════
    print("\n2. ★ digest() — 원칙 1·2")
    iid = val(
        "insert into ideas(raw_thought, question) values "
        "('조직에서 신뢰는 왜 비용인가','거래비용 메커니즘은?') returning id;"
    )
    con.execute(
        """insert into research_runs(idea_id, output_md, sources_json, model)
           values (%s, 'AI가 생성한 긴 산문...',
                   '[{"url":"https://a.example","title":"Zak 2017"},
                     {"url":"https://b.example","title":"OECD"},
                     {"url":"https://c.example","title":"blog"}]'::jsonb, 'mock');""",
        (iid,),
    )

    err = fails(
        "select digest(%s,'신뢰의 거래비용 절감','신뢰가 높으면 계약·감시 비용이 줄어든다',"
        "'감정이 아니라 회계 항목','조직,신뢰', array[0,2]);",
        iid,
    )
    check(err is None, f"digest() 실행 성공{'' if err is None else ' — ' + err}")

    check(
        val("select count(*) from research_runs where output_md is not null;") == 0,
        "AI 산문 폐기됨 (output_md IS NULL) — 원칙 1",
    )
    check(
        val("select count(*) from research_runs where purged_at is not null;") == 1,
        "purged_at 기록됨",
    )
    check(
        val("select sources_json::text <> '[]' from research_runs limit 1;"),
        "sources_json 은 폐기되지 않음 — 원칙 2",
    )
    titles = val("select string_agg(title,',' order by title) from sources;")
    check(titles == "Zak 2017,blog", f"체크한 출처만 승계됨 ({titles})")
    check(val("select status from ideas where id=%s;", iid) == "digested", "상태가 digested")
    check(val("select count(*) from events where kind='digest_done';") == 1, "digest_done 계측")

    # ══════════════ 3. ★ 원자성 ══════════════
    print("\n3. ★ 원자성 — 실패하면 폐기도 일어나지 않아야 한다")
    iid2 = val("insert into ideas(raw_thought) values ('두 번째 착상') returning id;")
    con.execute(
        "insert into research_runs(idea_id, output_md, sources_json) "
        "values (%s,'지워지면 안 되는 산문','[]'::jsonb);",
        (iid2,),
    )
    before = val("select count(*) from cards;")

    check(fails("select digest(%s,'제목만 있음','   ');", iid2) is not None,
          "요약이 비면 예외 (§3.2)")
    check(val("select count(*) from cards;") == before, "카드가 생성되지 않음")
    check(
        val("select output_md from research_runs where idea_id=%s;", iid2)
        == "지워지면 안 되는 산문",
        "★ 실패했는데 산문이 폐기되지 않음 — 원자성 확인",
    )
    check(val("select status from ideas where id=%s;", iid2) == "inbox", "상태도 그대로")
    check(fails("select digest(999999,'제목','요약');") is not None, "없는 착상은 예외")

    # ══════════════ 4. 한국어 검색 ══════════════
    print("\n4. 한국어 검색 (§2.1)")
    con.execute(
        """insert into cards(title, summary, my_take, tags) values
           ('리모트 근무와 응집력','물리적 거리는 약한 연결을 먼저 끊는다',
            '사무실 무용론은 성급','리모트,조직'),
           ('고신뢰 사회 논의','후쿠야마는 신뢰를 사회적 자본으로 봤다',
            '한국 적용은 신중히','신뢰,사회');"""
    )
    cases = [
        ("신뢰", 2, "2자 — SQLite trigram 이 0건 내던 케이스"),
        ("조직", 2, "2자"),
        ("거래비용", 1, "어절 내부 부분어 — SQLite unicode61 이 0건 내던 케이스"),
        ("회계 항목", 1, "공백 포함 구문"),
        ("후쿠야마", 1, "고유명사"),
        ('따옴"표', 0, "따옴표 — SQLite 는 이스케이프 없으면 SQL 오류였다"),
        ("없는말", 0, "미존재"),
    ]
    for term, expected, note in cases:
        n = val("select count(*) from search_cards(%s);", term)
        check(n == expected, f"'{term}' → {n}건 (기대 {expected}) — {note}")

    check(val("select count(*) from search_cards(null,'조직');") == 2, "태그 필터")
    check(val("select count(*) from search_cards('');") == 3, "빈 검색어는 전체")

    print("\n   생성 컬럼 동기화 (SQLite 는 트리거 3종이 필요했던 부분)")
    con.execute(
        "update cards set title='협력의 구조', summary='협력비용 이야기' "
        "where title like '신뢰의%';"
    )
    check(val("select count(*) from search_cards('거래비용');") == 0, "UPDATE 후 옛 값 검색 안 됨")
    check(val("select count(*) from search_cards('협력비용');") == 1, "UPDATE 후 새 값 검색됨")
    con.execute("delete from cards where title='고신뢰 사회 논의';")
    check(val("select count(*) from search_cards('후쿠야마');") == 0, "DELETE 후 검색 안 됨")

    # ══════════════ 5. app_open() ══════════════
    print("\n5. app_open() — 고아 복구 + 계측 (§4.1, §2.2)")
    con.execute(
        "insert into ideas(raw_thought, status, researching_since) values "
        "('갇힌 착상','researching', now() - interval '30 minutes'),"
        "('방금 시작한 조사','researching', now());"
    )
    con.execute("insert into ideas(raw_thought, status) values ('대기중','awaiting_digest');")

    pending = val("select app_open();")
    check(pending == 1, f"대기 큐 길이 반환 ({pending})")
    check(
        val("select count(*) from ideas where status='researching';") == 1,
        "★ 오래된 researching 만 복구, 진행 중인 것은 유지",
    )
    check(
        val("select meta from events where kind='app_open' order by id desc limit 1;") == "1",
        "app_open 계측에 큐 길이 기록",
    )
    check(
        val("select count(distinct date(at)) from events where kind='app_open';") == 1,
        "사용 일수 집계 가능 (§8)",
    )

    # ══════════════ 6. Write / drafts (§3.4) ══════════════
    print("\n6. drafts — Write 화면 (§3.4)")
    did = val("insert into drafts(title) values ('신뢰라는 비용') returning id;")
    check(val("select body_md from drafts where id=%s;", did) == "", "새 원고는 빈 본문")

    long_body = "우리는 신뢰를 감정이라 부르지만, 조직에서 그것은 회계 항목에 가깝다. " * 20
    con.execute(
        "update drafts set body_md=%s, updated_at=now() where id=%s", (long_body, did)
    )
    check(
        val("select char_length(body_md) from drafts where id=%s;", did) >= 800,
        "800자 이상 저장됨 (§8 '완성한 글' 판정 기준)",
    )

    # ══════════════ 7. ★ stats() — §8 판정 지표 ══════════════
    print("\n7. ★ stats() — 4주 뒤 판정을 이 함수 하나로 (§8)")
    s = val("select stats();")
    expected_keys = {
        "ideas", "cards", "drafts", "pending_digest", "digest_rate",
        "active_days", "avg_queue", "paste_blocked", "research_failed",
        "discarded", "discard_rate", "long_drafts",
    }
    check(set(s) == expected_keys, f"지표 12종 반환 ({len(s)}개)")
    check(s["long_drafts"] == 1, f"800자 이상 글 집계 ({s['long_drafts']})")
    check(s["active_days"] == 1, f"사용 일수 ({s['active_days']})")
    check(s["paste_blocked"] == 0, "붙여넣기 시도 집계")
    check(isinstance(s["digest_rate"], (int, float)), "전환율이 수치")

    con.execute("insert into events(kind, meta) values ('paste_blocked','idea:1')")
    s2 = val("select stats();")
    check(s2["paste_blocked"] == 1, "붙여넣기 기록이 즉시 반영됨 — H1의 직접 증거")

    # meta 가 숫자가 아닌 app_open 이 섞여도 평균 계산이 깨지면 안 된다
    con.execute("insert into events(kind, meta) values ('app_open','알수없음')")
    err = fails("select stats();")
    check(err is None, f"비정상 meta 가 섞여도 stats() 가 죽지 않음{'' if err is None else ' — ' + err}")

    # ══════════════ 8. 자료 폐기 (§3.5) ══════════════
    print("\n8. discard_research() — 카드 없이 버리기 (§3.5)")
    iid3 = val("insert into ideas(raw_thought, status) values ('쓸모없는 조사','awaiting_digest') returning id;")
    con.execute(
        "insert into research_runs(idea_id, output_md, sources_json) "
        "values (%s,'쓸모없는 AI 산문','[{\"url\":\"https://x.example\"}]'::jsonb);",
        (iid3,),
    )
    cards_before = val("select count(*) from cards;")

    con.execute("select discard_research(%s);", (iid3,))
    check(val("select count(*) from cards;") == cards_before, "카드가 생기지 않음")
    check(
        val("select output_md from research_runs where idea_id=%s;", iid3) is None,
        "★ 폐기 경로에서도 AI 산문은 사라진다 — 원칙 1",
    )
    check(
        val("select sources_json::text <> '[]' from research_runs where idea_id=%s;", iid3),
        "sources_json 은 남는다 (무엇을 찾아봤는지는 사실 기록)",
    )
    check(val("select status from ideas where id=%s;", iid3) == "inbox",
          "기본은 inbox 복귀 — 질문을 고쳐 다시 조사할 수 있다")
    check(val("select count(*) from events where kind='research_discarded';") == 1,
          "★ 폐기가 계측된다 — H1과 리서치 품질을 구분하는 신호")

    iid4 = val("insert into ideas(raw_thought) values ('접을 착상') returning id;")
    con.execute("select discard_research(%s, true);", (iid4,))
    check(val("select status from ideas where id=%s;", iid4) == "archived",
          "archive 옵션은 착상을 보관 처리")
    check(fails("select discard_research(999999);") is not None, "없는 착상은 예외")

    s3 = val("select stats();")
    check("discard_rate" in s3 and "discarded" in s3, "stats() 에 폐기 지표 포함")
    check(s3["discarded"] == 2, f"폐기 건수 집계 ({s3['discarded']})")

    # ══════════════ 9. 분류 — 컬렉션·태그 (§3.6) ══════════════
    print("\n9. 분류 모듈 (§3.6)")
    c1 = val("insert into collections(name) values ('조직론') returning id;")
    c2 = val("insert into collections(name) values ('집필중') returning id;")
    check(fails("insert into collections(name) values ('조직론');") is not None,
          "같은 이름 컬렉션은 중복 불가")

    ids = [r[0] for r in con.execute("select id from cards order by id").fetchall()]
    # ★ 다차원 — 카드 하나가 여러 컬렉션에 동시에 속한다
    con.execute("insert into card_collections(card_id, collection_id) values (%s,%s),(%s,%s)",
                (ids[0], c1, ids[0], c2))
    con.execute("insert into card_collections(card_id, collection_id) values (%s,%s)",
                (ids[1], c1))

    counts = {r[1]: r[2] for r in con.execute("select * from collection_counts()").fetchall()}
    check(counts.get("조직론") == 2 and counts.get("집필중") == 1,
          f"컬렉션별 카드 수 ({counts})")
    check(
        val("select count(*) from card_collections where card_id=%s;", ids[0]) == 2,
        "★ 카드 하나가 두 컬렉션에 동시 소속 (다차원)",
    )
    check(val("select count(*) from search_cards(null,null,null,%s);", c1) == 2,
          "컬렉션으로 필터링")

    tc = {r[0]: r[1] for r in con.execute("select * from tag_counts()").fetchall()}
    check(len(tc) > 0 and all(t == t.strip() for t in tc), f"태그 집계 ({len(tc)}종)")

    check(val("select count(*) from search_cards(null,null,array['조직'],null);") >= 1,
          "태그 배열로 필터링")
    check(
        val("select count(*) from search_cards(null,null,array['조직','없는태그'],null);") == 0,
        "★ 태그 여러 개는 AND — 전부 만족해야 남는다",
    )
    check(val("select count(*) from search_cards('협력비용');") >= 0,
          "기존 호출부(p_q 만)가 그대로 동작")

    con.execute("delete from collections where id=%s", (c2,))
    check(val("select count(*) from cards where id=%s;", ids[0]) == 1,
          "컬렉션을 지워도 카드는 남는다")

    # ══════════════ 10. RLS ══════════════
    print("\n10. RLS — 남의 데이터가 보이면 안 된다")
    con.execute("update _test_ctx set uid=%s", (other,))
    check(val("select count(*) from cards;") == 0, "다른 사용자에게는 카드 0건")
    check(val("select count(*) from search_cards('협력비용');") == 0, "검색도 격리됨")
    con.execute("update _test_ctx set uid=null")
    check(val("select count(*) from ideas;") == 0, "★ 미인증(uid=null)은 아무것도 못 봄")

    failed = [label for ok, label in results if not ok]
    print("\n" + "═" * 62)
    print(f"{len(results) - len(failed)}/{len(results)} 통과")
    for f in failed:
        print("  ❌", f)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
