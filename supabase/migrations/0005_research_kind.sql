-- mintAI — 리서치 자료 유형·길이 (docs/RESEARCH.md)
-- 검증: PostgreSQL 16.2 / 2026-07-25

alter table research_runs add column if not exists kind  text;
alter table research_runs add column if not exists chars int;

comment on column research_runs.kind is
  'concept|causal|history|person|event|compare|data|debate — 파싱 실패 시 null (RESEARCH.md §4.1)';

-- ★ chars 를 따로 두는 이유 (RESEARCH.md §0.1)
--
--   소화·폐기 시 output_md 는 NULL 이 된다. 그러면 "3,000자로 늘린 것이
--   대기 큐를 나쁘게 했는가"를 **사후에 잴 방법이 사라진다.**
--   §2.2에서 배운 것과 같은 교훈이다 — 나중에 알고 싶어질 수는 지금 남겨야 한다.
comment on column research_runs.chars is
  '자료 길이. output_md 가 폐기돼도 남는다 — 분량이 소화 병목에 미친 영향 측정용';

create index if not exists idx_runs_kind on research_runs(kind);


-- ── 유형별 진단 ──────────────────────────────────────────────
-- 특정 유형에서만 자료가 버려진다면 그건 H1 문제가 아니라
-- **그 유형의 프롬프트 문제**다. 섞어서 보면 구분되지 않는다.
create or replace function research_by_kind()
returns table (
  kind       text,
  runs       bigint,
  avg_chars  numeric,
  digested   bigint,
  discarded  bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(r.kind, '(미분류)')                                   as kind,
    count(*)                                                        as runs,
    round(avg(r.chars), 0)                                          as avg_chars,
    count(*) filter (where i.status = 'digested')                    as digested,
    count(*) filter (where e.id is not null)                         as discarded
  from research_runs r
  join ideas i on i.id = r.idea_id
  left join lateral (
    select e.id from events e
     where e.kind = 'research_discarded'
       and e.meta = 'idea:' || r.idea_id
     limit 1
  ) e on true
  group by 1
  order by 2 desc;
$$;

comment on function research_by_kind() is
  '유형별 자료 길이와 소화/폐기 분포. RESEARCH.md §5 판정용.';


-- ── §8 지표에 평균 자료 길이 추가 ────────────────────────────
create or replace function stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'ideas',         (select count(*) from ideas),
    'cards',         (select count(*) from cards),
    'drafts',        (select count(*) from drafts),
    'pending_digest',(select count(*) from ideas where status = 'awaiting_digest'),

    'digest_rate',   coalesce(round(
                       (select count(*) from ideas where status = 'digested')::numeric
                       / nullif((select count(*) from ideas), 0), 3), 0),

    'active_days',   (select count(distinct date(at)) from events where kind = 'app_open'),
    'avg_queue',     coalesce((select round(avg(meta::numeric), 2) from events
                                where kind = 'app_open' and meta ~ '^[0-9]+$'), 0),
    'paste_blocked', (select count(*) from events where kind = 'paste_blocked'),
    'research_failed',(select count(*) from events where kind = 'research_failed'),

    'discarded',     (select count(*) from events where kind = 'research_discarded'),
    'discard_rate',  coalesce(round(
                       (select count(*) from events where kind = 'research_discarded')::numeric
                       / nullif((select count(*) from events
                                  where kind in ('research_discarded','digest_done')), 0), 3), 0),

    -- ★ 3,000자 전환이 옳았는지 읽는 축. avg_queue 와 함께 본다.
    'avg_chars',     coalesce((select round(avg(chars), 0) from research_runs
                                where chars is not null), 0),

    'long_drafts',   (select count(*) from drafts where char_length(body_md) >= 800)
  );
$$;
