-- mintAI — 자료 폐기 (docs/MVP.md §3.5)
-- 검증: PostgreSQL 16.2 / 2026-07-25
--
-- 지금까지 Digest 에서 나가는 길은 "소화 완료" 하나뿐이었다. 자료가 쓸모없어도
-- 카드를 만들어야 큐에서 빠졌다. 그건 두 가지를 망친다:
--
--   1. 쓸모없는 자료로 억지 카드를 만들게 된다 → Library 가 오염된다
--   2. 큐에 그대로 두면 대기 큐 평균(§8)이 리서치 품질 문제 때문에 나빠지는데,
--      그게 소화 병목(H3)처럼 보인다
--
-- ★ 그래서 폐기에도 계측을 남긴다.
--
--   캡처→소화 전환율이 낮게 나왔을 때, 그게 "요약이 귀찮아서"(H1 거짓)인지
--   "자료가 쓸모없어서"(리서치 품질 문제)인지 **구분할 수 있는 유일한 신호**다.
--   이 둘을 혼동하면 멀쩡한 전제를 폐기하거나, 고칠 수 있는 문제를 방치한다.

create or replace function discard_research(
  p_idea_id      bigint,
  p_archive_idea boolean default false
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run research_runs;
begin
  if not exists (select 1 from ideas where id = p_idea_id) then
    raise exception '해당 착상이 없습니다' using errcode = 'no_data_found';
  end if;

  select * into v_run
    from research_runs
   where idea_id = p_idea_id and output_md is not null
   order by id desc
   limit 1;

  -- 폐기 경로가 달라도 원칙 1은 같다 — AI 산문은 남지 않는다.
  -- sources_json 은 지우지 않는다. 카드로 승계되진 않지만 "무엇을 찾아봤는지"는
  -- 사실 기록이고, 같은 질문을 다시 조사할 때 중복을 알아볼 근거가 된다.
  if v_run.id is not null then
    update research_runs
       set output_md = null, purged_at = now()
     where id = v_run.id;
  end if;

  -- 기본은 inbox 복귀 — 질문을 고쳐서 다시 조사할 수 있어야 한다.
  -- 착상 자체가 틀렸다면 archived 로 보낸다.
  update ideas
     set status = case when p_archive_idea then 'archived' else 'inbox' end,
         researching_since = null
   where id = p_idea_id;

  insert into events (kind, meta)
  values ('research_discarded', 'idea:' || p_idea_id);
end;
$$;

comment on function discard_research(bigint, boolean) is
  '자료를 카드로 만들지 않고 폐기한다. 폐기 비율은 H1과 리서치 품질을 구분하는 신호다.';


-- ── §8 지표에 폐기 추가 ──────────────────────────────────────
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

    -- ★ 폐기 건수와 비율. 비율이 높으면 H1이 아니라 리서치 품질을 의심해야 한다.
    'discarded',     (select count(*) from events where kind = 'research_discarded'),
    'discard_rate',  coalesce(round(
                       (select count(*) from events where kind = 'research_discarded')::numeric
                       / nullif((select count(*) from events
                                  where kind in ('research_discarded','digest_done')), 0), 3), 0),

    'long_drafts',   (select count(*) from drafts where char_length(body_md) >= 800)
  );
$$;
