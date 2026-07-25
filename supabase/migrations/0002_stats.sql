-- mintAI — §8 판정 지표 함수
-- 검증: PostgreSQL 16.2 / 2026-07-25
--
-- ⚠ 이 함수는 스택 이전 중에 사라졌던 것을 되살린 것이다.
--
-- 로컬판에는 `GET /api/stats` 가 있었는데, Supabase 로 옮기면서 PostgREST 가
-- 테이블을 직접 노출하니 엔드포인트가 필요 없다고 판단해 옮기지 않았다.
-- 그런데 §8의 판정은 **6개 지표를 한 번에** 봐야 하고, 그중 셋은 events 를
-- 집계해야 나온다. 클라이언트에서 쿼리 6개를 날려 조합하는 건
-- "4주 뒤에 따로 집계 작업이 필요 없어야 한다"(§8)는 요구에 어긋난다.

create or replace function stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    -- ── 저술 데이터 ──
    'ideas',         (select count(*) from ideas),
    'cards',         (select count(*) from cards),
    'drafts',        (select count(*) from drafts),
    'pending_digest',(select count(*) from ideas where status = 'awaiting_digest'),

    -- 캡처 → 소화 전환율 (목표 ≥ 0.40)
    'digest_rate',   coalesce(round(
                       (select count(*) from ideas where status = 'digested')::numeric
                       / nullif((select count(*) from ideas), 0), 3), 0),

    -- ── §2.2 계측 기반 ──
    -- 사용 일수 (목표 ≥ 12 / 28일)
    'active_days',   (select count(distinct date(at)) from events where kind = 'app_open'),
    -- 소화 대기 큐 평균 (목표 ≤ 5)
    'avg_queue',     coalesce((select round(avg(meta::numeric), 2) from events
                                where kind = 'app_open' and meta ~ '^[0-9]+$'), 0),
    -- 붙여넣기 시도 — H1이 무너지는 순간을 가장 먼저 보여주는 지표
    'paste_blocked', (select count(*) from events where kind = 'paste_blocked'),
    'research_failed',(select count(*) from events where kind = 'research_failed'),

    -- 완성한 글 (목표 ≥ 1편, 800자 이상)
    'long_drafts',   (select count(*) from drafts where char_length(body_md) >= 800)
  );
$$;

comment on function stats() is
  'docs/MVP.md §8 판정 지표. 4주 뒤 별도 집계 없이 이 함수 하나로 판정한다.';
